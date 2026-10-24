import type { OpenCodeQuotaPool } from '../quota/opencode-pool';
import type { OpenCodeAccounts } from '../engines/opencode-accounts';
import { EngineCleanupJobs, parseEngineCleanup } from '../engines/cleanup';
import type { ImService } from '../im/service';
import type { SaveImSettingsInput } from '../../shared/contracts/im';
import { randomUUID } from 'node:crypto';
import { API_VERSION } from '../../shared/contracts/commands';
import type { RpcMethod } from '../../shared/contracts/rpc';
import type { QuotaRefreshInput, QuotaRefreshResult, QuotaSchedule } from '../../shared/contracts/quota';
import { EXECUTION_BOUNDARY, ENGINE_CATALOG, readinessFor, type EngineProbeRecord } from '../../shared/engines';
import { parseId, parseTaskInput } from '../../shared/validation';
import { VERSION } from '../../shared/version';
import { configuredParallel } from '../application/tasks/queries';
import { workerLoad } from '../application/scheduling/dispatch';
import type { CommandHandler } from '../commands';
import { HelloJobs, parseHelloInput } from '../engines/hello';
import { applyEngineEnabled, parseEngineToggle } from '../engines/control';
import { EngineModelLister, parseModelListInput } from '../engines/models';
import { EngineProber } from '../engines/probe';
import { FreeChannelProbeMonitor, parseFreeProbeInput } from '../free-channel';
import type { TaskManager } from '../manager';
import { QUOTA_CAPABILITIES, parseQuotaRefresh } from '../policy/quota';
import { previewRoute } from '../policy/preview';
import { validateConfig } from '../policy/routing';
import type { PolicyStore } from '../policy/store';
import type { QuotaProber } from '../quota';
import { RpcError } from '../rpc';
import type { StallMonitor } from '../stall';
import type { TaskStore } from '../store';
import type { TempJanitor } from '../janitor';
import { object } from '../../shared/validation';

/** The started services every RPC method works against. */
export interface ActiveServices {
  commands: CommandHandler;
  manager: TaskManager;
  store: TaskStore;
  policy: PolicyStore;
  prober: QuotaProber;
}

/** What the runtime lends to the handlers: its in-flight tracking, shared quota refresh, monitors and identity. */
export interface RpcHost {
  openCodeAccounts?: OpenCodeAccounts;
  openCodeQuotaPool?: OpenCodeQuotaPool;
  assertOpenCodeAccess?: () => void;
  onOpenCodeQuotaChanged?: () => void;
  im(): ImService;
  track<T>(job: Promise<T>): Promise<T>;
  /** Manual and scheduled refresh share one probe-then-merge path. */
  refreshQuota(input: QuotaRefreshInput): Promise<QuotaRefreshResult>;
  quotaSchedule(): QuotaSchedule;
  stall(): StallMonitor;
  freeProbe(): FreeChannelProbeMonitor;
  hellos: HelloJobs;
  cleanups?: EngineCleanupJobs;
  /** The runtime's model-list cache, shared with the pi pre-launch check; a host without one gets its own. */
  modelLister?: EngineModelLister;
  server(): { url: string; port: number; dataDir: string; startedAt: string; managedBy: 'systemd' | 'launchd' | null };
  janitor(): TempJanitor;
}

export type RpcHandler = (active: ActiveServices, args: unknown[]) => unknown;
type Handlers<K extends RpcMethod> = { readonly [M in K]: RpcHandler };
/** Every method in the RPC contract has a handler; a missing or extra one fails type-checking. */
export type RpcHandlers = Handlers<RpcMethod>;

function policyHandlers(): Handlers<'getPolicy' | 'policyHistory' | 'policyRollback' | 'validatePolicy' | 'savePolicy' | 'previewRoute'> {
  return {
    getPolicy: active => active.policy.snapshot(),
    policyHistory: active => ({ revisions: active.policy.history() }),
    policyRollback: (active, args) => {
      if (!args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) throw new RpcError('INVALID_REQUEST', 'Rollback input must be an object');
      const revision = (args[0] as Record<string, unknown>).revision;
      if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new RpcError('INVALID_REQUEST', 'revision must be a positive integer');
      return active.policy.rollback(Number(revision));
    },
    validatePolicy: (_active, args) => {
      let encoded = '';
      try { encoded = JSON.stringify(args[0]); } catch { throw new RpcError('INVALID_REQUEST', 'Policy must be JSON'); }
      if (Buffer.byteLength(encoded) > 256 * 1024) throw new RpcError('INVALID_REQUEST', 'Policy exceeds 256 KiB');
      return validateConfig(args[0]);
    },
    savePolicy: (active, args) => {
      let snapshot;
      try { snapshot = active.policy.save(args[0]); }
      catch (error) {
        // A stale revision is a conflict the caller resolves by reloading, not a malformed request.
        if (error instanceof Error && error.message.startsWith('Settings changed')) throw new RpcError('REVISION_CONFLICT', error.message);
        throw error;
      }
      active.commands.pump();
      return snapshot;
    },
    previewRoute: (active, args) => {
      // The route shown is the route a dispatch would take now, so the server supplies the live load.
      const input = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] as Record<string, unknown> : {};
      const live = active.policy.snapshot();
      return previewRoute(live.config, live.blocks, Date.now(), { ...input, workerLoad: workerLoad(active.store.listHeads()) });
    },
  };
}

function quotaHandlers(host: RpcHost): Handlers<'getQuota' | 'refreshQuota'> {
  return {
    getQuota: active => ({ ...active.prober.get(), schedule: host.quotaSchedule() }),
    refreshQuota: (_active, args) => host.refreshQuota(parseQuotaRefresh(args[0])),
  };
}

function engineHandlers(host: RpcHost): Handlers<'scanEngines' | 'listEngineModels' | 'setEngineEnabled'> {
  const prober = new EngineProber();
  const modelLister = host.modelLister ?? new EngineModelLister();
  let probes: EngineProbeRecord[] | null = null;
  const remember = (probe: EngineProbeRecord | null) => {
    if (!probe) return probes;
    const next = [...(probes ?? []).filter(item => item.id !== probe.id), probe];
    probes = ENGINE_CATALOG.map(entry => next.find(item => item.id === entry.id)).filter((item): item is EngineProbeRecord => Boolean(item));
    return probes;
  };
  return {
    scanEngines: async active => {
      const found = await host.track(prober.scan());
      probes = found;
      const snapshot = active.policy.snapshot();
      return { probedAt: new Date().toISOString(), probes: found, readiness: readinessFor(found, snapshot.config), boundary: EXECUTION_BOUNDARY };
    },
    listEngineModels: (_active, args) => {
      let input;
      try { input = parseModelListInput(args[0]); } catch (error) { throw new RpcError('INVALID_REQUEST', error instanceof Error ? error.message : String(error)); }
      return host.track(modelLister.list(input));
    },
    setEngineEnabled: async (active, args) => {
      const result = await host.track(applyEngineEnabled(active.policy, prober, parseEngineToggle(args[0])));
      active.commands.pump();
      const known = remember(result.probe) ?? [];
      return { snapshot: result.snapshot, probe: result.probe, readiness: readinessFor(known, result.snapshot.config) };
    },
  };
}

function probeHandlers(host: RpcHost): Handlers<'getStall' | 'workerProbe' | 'workerProbeStatus' | 'sayHi' | 'sayHiResult' | 'startEngineCleanup' | 'getEngineCleanup'> {
  return {
    getStall: () => host.stall().status(),
    workerProbeStatus: () => host.freeProbe().status(),
    workerProbe: (_active, args) => host.freeProbe().probeNow(parseFreeProbeInput(args[0]).worker),
    startEngineCleanup: (_active, args) => {
      let input;
      try { input = parseEngineCleanup(args[0]); } catch (error) { throw new RpcError('INVALID_REQUEST', String(error)); }
      if (!host.cleanups) throw new RpcError('INVALID_REQUEST', '清理服务不可用');
      try { return host.cleanups.start(input); } catch (error) { throw new RpcError('CONFLICT', String(error)); }
    },
    getEngineCleanup: (_active, args) => {
      try { return host.cleanups?.get(args[0]) ?? null; } catch (error) { throw new RpcError('INVALID_REQUEST', String(error)); }
    },
    sayHi: (active, args) => {
      const input = parseHelloInput(args[0]);
      if (!active.policy.snapshot().config.engines[input.engine]) throw new RpcError('INVALID_REQUEST', `Engine ${input.engine} is not configured`);
      try { return host.hellos.start(input); } catch (error) { throw new RpcError('CAPACITY_EXCEEDED', error instanceof Error ? error.message : String(error)); }
    },
    sayHiResult: (_active, args) => {
      const id = args[0];
      if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new RpcError('INVALID_REQUEST', 'Invalid probe id');
      const job = host.hellos.get(id);
      if (!job) throw new RpcError('NOT_FOUND', 'Probe not found or expired');
      return job;
    },
  };
}

function taskHandlers(): Handlers<'command' | 'listTasks' | 'getTask' | 'createTask' | 'startTask' | 'cancelTask'> {
  return {
    command: (active, args) => active.commands.handleAsync(args[0]),
    listTasks: active => active.store.listSummaries(),
    getTask: (active, args) => active.store.get(parseId(args[0],'task ID')),
    createTask: (active, args) => {
      const input = parseTaskInput(args[0]);
      const response = active.commands.handle({ apiVersion: API_VERSION, commandId: randomUUID(), command: 'tasks.create', args: input as unknown as Record<string, unknown> });
      if (!response.ok) throw new RpcError(response.error?.code ?? 'COMMAND_FAILED', response.error?.message ?? 'Command failed');
      return active.store.get((response.data as { id: string }).id);
    },
    startTask: async (active, args) => {
      const id = parseId(args[0],'task ID');
      const response = await active.commands.handleAsync({ apiVersion: API_VERSION, commandId: randomUUID(), command: 'tasks.start', args: { taskId: id } });
      if (!response.ok) throw new RpcError(response.error?.code ?? 'COMMAND_FAILED', response.error?.message ?? 'Command failed');
      return active.store.get(id);
    },
    cancelTask: (active, args) => {
      const id = parseId(args[0],'task ID');
      const response = active.commands.handle({ apiVersion: API_VERSION, commandId: randomUUID(), command: 'tasks.cancel', args: { taskId: id } });
      if (!response.ok) throw new RpcError(response.error?.code ?? 'COMMAND_FAILED', response.error?.message ?? 'Command failed');
      return active.store.get(id);
    },
  };
}

function serverHandlers(host: RpcHost): Handlers<'capabilities' | 'serverInfo'> {
  return {
    capabilities: active => ({
      worker: active.manager.canLaunchReal
        ? 'Saved opencode, pi, grok, codex, qodercli, and dsh routes launch that engine. mock-jsonl runs only when requested. Failures do not fall back.'
        : 'mock-jsonl is the explicit test provider. A real route fails until the engine launcher is loaded and does not fall back to mock.',
      owner: 'Attachment is metadata only. owners.switch with launch and owners.launch start a visible Herdr owner on a claude or codex profile; a Herdr executable on PATH is neither a model run nor a login proof.',
      maxParallel: configuredParallel(active.policy),
      storePath: active.store.path,
      quota: QUOTA_CAPABILITIES,
    }),
    serverInfo: active => {
      const server = host.server();
      return {
        pid: process.pid,
        url: server.url,
        port: server.port,
        dataDir: server.dataDir,
        version: VERSION,
        startedAt: server.startedAt,
        runningWorkers: active.manager.runningCount,
        managedBy: server.managedBy,
      };
    },
  };
}

function janitorHandlers(host: RpcHost): Handlers<'janitorSweep' | 'janitorStatus'> {
  return {
    janitorSweep: (_active, args) => {
      const input = object(args[0]);
      if (Object.keys(input).some(key => key !== 'dryRun')) throw new RpcError('INVALID_REQUEST', 'Janitor sweep input only accepts dryRun');
      if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new RpcError('INVALID_REQUEST', 'dryRun must be a boolean');
      return host.track(host.janitor().sweep({ dryRun: input.dryRun === true }));
    },
    janitorStatus: () => host.janitor().status(),
  };
}

/** The business implementation behind every RPC method; HTTP /api/rpc and the Unix socket both reach it through the runtime. */
export function createRpcHandlers(host: RpcHost): RpcHandlers {
  return {
    getImSettings: () => host.im().snapshot(),
    saveImSettings: (_active, args) => host.im().save(args[0] as SaveImSettingsInput),
    reconnectIm: () => host.im().reconnect(),
    ...policyHandlers(),
    ...quotaHandlers(host),
    ...engineHandlers(host),
    getOpenCodeAccountQuotas: () => host.openCodeQuotaPool?.get() ?? { accounts: [], active: null, switching: false },
    refreshOpenCodeAccountQuotas: (_active, args) => {
      const input = object(args[0]);
      if (Object.keys(input).some(k => !['accountID', 'orgID'].includes(k)) || (input.accountID === undefined) !== (input.orgID === undefined) || (input.accountID !== undefined && (typeof input.accountID !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(input.accountID) || typeof input.orgID !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(input.orgID)))) throw new RpcError('INVALID_REQUEST', '账号额度参数无效');
      host.assertOpenCodeAccess?.();
      if (!host.openCodeQuotaPool) throw new RpcError('OPENCODE_UNAVAILABLE', '账号额度服务尚未就绪');
      return host.track(host.openCodeQuotaPool.refresh(input as { accountID?: string; orgID?: string }).then(snapshot => { host.onOpenCodeQuotaChanged?.(); return snapshot; }));
    },
    listOpenCodeAccounts: () => { if (!host.openCodeAccounts) throw new RpcError('OPENCODE_UNAVAILABLE', '账号服务不可用'); return host.track(host.openCodeAccounts.list()); },
    startOpenCodeLogin: () => { if (!host.openCodeAccounts) throw new RpcError('OPENCODE_UNAVAILABLE', '账号服务不可用'); return host.openCodeAccounts.startLogin(); },
    getOpenCodeLogin: (_active, args) => { if (!host.openCodeAccounts) throw new RpcError('OPENCODE_UNAVAILABLE', '账号服务不可用'); return host.openCodeAccounts.getLogin(args[0]); },
    cancelOpenCodeLogin: (_active, args) => { if (!host.openCodeAccounts) throw new RpcError('OPENCODE_UNAVAILABLE', '账号服务不可用'); return host.track(host.openCodeAccounts.cancelLogin(args[0])); },
    switchOpenCodeAccount: (_active, args) => { if (!host.openCodeAccounts) throw new RpcError('OPENCODE_UNAVAILABLE', '账号服务不可用'); return host.track(host.openCodeAccounts.switchAccount(args[0])); },
    ...probeHandlers(host),
    ...taskHandlers(),
    ...serverHandlers(host),
    ...janitorHandlers(host),
  };
}
