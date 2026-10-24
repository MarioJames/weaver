import { ChannelStore } from './channels/store';
import { ChannelService } from './channels/service';
import { NativeChannelImporter } from './channels/import';
import type { ChannelBinding } from './channels/runtime';
import type { ChannelsSnapshot } from '../shared/contracts/channels';
import { createBackgroundParentAgent } from './im/parent-background';
import { EngineCleanupJobs } from './engines/cleanup';
import { ImService, ImServiceError, type ImServiceOptions } from './im/service';
import { spawn } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION } from '../shared/contracts/commands';
import { startCliAgent } from './adapters/cli/index';
import { startCliRun } from './adapters/cli/run';
import { createParentAgent } from './im/parent-agent';
import { HelloJobs, sayHi } from './engines/hello';
import { EngineModelLister } from './engines/models';
import { createPiModelCheck } from './engines/pi-model-check';
import { guardPiLaunch, guardPiRun } from './adapters/cli/pi-guard';
import { FreeChannelProbeMonitor } from './free-channel';
import { embeddedApp } from './embedded';
import { RoutingWorkerAdapter } from './adapters/routing';
import { MockWorkerAdapter } from './adapters/worker';
import type { AsyncOwnerHost } from './application/commands/types';
import { unblockEngine } from './application/engines/unblock';
import { unblockWorker } from './application/workers/unblock';
import type { TaskDiagnostics } from './application/tasks/queries';
import { CommandHandler } from './commands';
import { SECURITY_HEADERS, startHttpServer, type HttpRuntime } from './http';
import { failure, startLocalIPC } from './local-ipc';
import { TaskManager } from './manager';
import { PolicyBlockService } from './policy/blocks';
import { PolicyStore } from './policy/store';
import { applyQuotaSnapshot, QuotaPolicyConflict } from './policy/quota';
import type { QuotaRefreshInput } from '../shared/contracts/quota';
import { QuotaProber } from './quota';
import { StallMonitor } from './stall';
import { RpcError, parseRpcBody } from './rpc';
import { createRpcHandlers } from './transport/handlers';
import type { RpcMethod } from '../shared/contracts/rpc';
import { TaskStore } from './store';
import { dbFreeProbeStore } from './storage/free-probe-state';
import { dbQuotaStore } from './storage/quota-snapshot';
import { dbStallStore } from './storage/stall-state';
import { dbVendorLadder } from './storage/vendor-limits';
import { reattach } from './application/tasks/reattach';
import { acquireInstanceLock, type InstanceLock } from './instance-lock';
import { createViteOptimizerTracker, settleViteCache, TempJanitor } from './janitor';
import { formatStoreStatus } from './im/task-status';
import { dbJanitorStore } from './storage/janitor-runs';
import { janitorSettings } from '../shared/policy/settings';

export interface RuntimeOptions {
  dataDir: string;
  channels?: {env?:NodeJS.ProcessEnv;autoImport?:boolean};
  port?: number;
  open?: boolean;
  dev?: boolean;
  rendererRoot?: string;
  repoRoot?: string;
  workerScript?: string;
  /** Internal dependency injection for isolated runtime tests; never supplied over RPC. */
  quotaProber?: QuotaProber;
  /** Main-process-only dependency injection; never accepted from RPC. */

  ownerHost?: AsyncOwnerHost;
  im?: Pick<ImServiceOptions, 'parentFactory' | 'channelFactory' | 'now'>;
  /** Internal dependency injection for isolated janitor tests; never supplied over RPC. */
  janitor?: {
    tmpRoot?: string;
    uid?: number | null;
    platform?: NodeJS.Platform;
    now?: () => number;
    ttlMs?: number;
    intervalMs?: number;
    watchIntervalMs?: number;
  };
}

export interface WeaverRuntime {
  url: string;
  port: number;
  done: Promise<void>;
  close(): Promise<void>;
}

export function modulePaths(moduleUrl = import.meta.url) {
  const here = dirname(fileURLToPath(moduleUrl));
  if (here.endsWith(`${sep}src${sep}main`)) {
    const repo = resolve(here, '../..');
    return { repo, workerScript: join(repo, 'scripts/mock-worker.mjs'), rendererRoot: join(repo, 'dist/renderer') };
  }
  const dist = resolve(here, '..');
  return { repo: resolve(dist, '..'), workerScript: join(dist, 'workers/mock-worker.mjs'), rendererRoot: join(dist, 'renderer') };
}

function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof ImServiceError) return { code: error.code, message: error.message };
  if (error instanceof RpcError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'INVALID_REQUEST', message: error.message };
  return { code: 'INTERNAL_ERROR', message: 'Request failed' };
}

/** Which service manager, if any, started this process. Set only by `weaver server install`. */
export function managedBy(env: Record<string, string | undefined> = process.env): 'systemd' | 'launchd' | null {
  return env.WEAVER_SERVICE === 'systemd' || env.WEAVER_SERVICE === 'launchd' ? env.WEAVER_SERVICE : null;
}

export function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => {});
  child.unref();
}

export async function startRuntime(options: RuntimeOptions): Promise<WeaverRuntime> {
  const paths = modulePaths();
  const dataDir = resolve(options.dataDir);
  const startedAt = new Date().toISOString();
  const repo = options.repoRoot ?? paths.repo;
  const rendererRoot = options.rendererRoot ?? paths.rendererRoot;
  const embedded = embeddedApp();
  if (embedded && options.dev) throw new Error('--dev needs a source checkout; this is a standalone executable');
  // A standalone executable runs the mock worker as itself with a hidden argument.
  const workerScript = options.workerScript ?? embedded?.mockWorkerArg ?? paths.workerScript;
  let im: ImService | undefined;
  let ready = false;
  let draining = false;
  let commands: CommandHandler | undefined;
  let manager: TaskManager | undefined;
  let store: TaskStore | undefined;
  let policy: PolicyStore | undefined;
  let channelStore:ChannelStore;let channelService:ChannelService;let importer:NativeChannelImporter;
  let quotaProber: QuotaProber | undefined;
  let stall: StallMonitor | undefined;
  let freeProbe: FreeChannelProbeMonitor | undefined;
  let http: HttpRuntime | undefined;
  let vite: { middlewares: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: (error?: unknown) => void) => void; close(): Promise<void> } | undefined;
  const optimizerTracker = createViteOptimizerTracker();
  let janitor: TempJanitor | undefined;
  /** Tests started by node --test must opt in with an isolated root; an unguarded sweep could delete the real /tmp. */
  const testContext = Boolean(process.env.NODE_TEST_CONTEXT);
  const binding=(id:string):ChannelBinding=>{
    const config=policy!.snapshot().config;const channel=Object.hasOwn(config.channels,id)?config.channels[id]:undefined;
    if(!channel)throw new RpcError('INVALID_REQUEST','Unknown channel');
    if(!channel.enabled)throw new RpcError('CHANNEL_DISABLED','Channel is disabled');
    const engine=config.engines[channel.engine];if(!engine?.enabled)throw new RpcError('ENGINE_DISABLED','Channel engine is disabled');
    return {channel,secret:channelStore.getSecret(id)??{},engineKind:engine.kind};
  };
  const bindings=():Record<string,ChannelBinding>=>{const config=policy!.snapshot().config;return Object.fromEntries(Object.entries(config.channels).map(([id,channel])=>[id,{channel,secret:channelStore.getSecret(id)??{},engineKind:config.engines[channel.engine]?.kind}]));};
  const channelSnapshot=():ChannelsSnapshot=>{
    const result=channelService.get();const records=quotaProber?.get().records??[];
    for(const [id,configuration] of Object.entries(result.configurations)){
      const record=records.find(r=>r.channel===id);if(record)configuration.quota=record;
    }
    return result;
  };
  const deleteChannel=(input:import('../shared/contracts/channels').DeleteChannelInput)=>{
    if(store!.listHeads().some(task=>(task.dispatch?.channel===input.id||task.run?.channel===input.id)&&(task.status==='queued'||task.status==='running'||task.status==='cancelling'||(task.run?.execution==='real'&&!task.run.finalizedAt))))throw new RpcError('CHANNEL_IN_USE','Channel is still referenced by an active run');
    if(im?.snapshot().config.channel===input.id)throw new RpcError('CHANNEL_IN_USE','Channel is configured for IM');
    if(commands?.schedules.referencesChannel(input.id))throw new RpcError('CHANNEL_IN_USE','Channel is still referenced by an active schedule');
    channelService.delete(input);return channelSnapshot();
  };
  const inflight = new Set<Promise<unknown>>();
  const greetings = new AbortController();
  // One `pi --list-models` cache for the models page, the pre-launch check of tasks, hello and free-channel probes.
  const modelLister = new EngineModelLister({channel:binding,root:join(dataDir,'agent-state','models')});
  const checkPiModel = createPiModelCheck(modelLister);
  const hellos = new HelloJobs(route => {
    const engine = policy?.snapshot().config.engines[route.engine];
    return track(sayHi({ ...route, channelConfig:binding(route.channel!), kind: engine?.kind ?? route.engine }, { root: join(dataDir, 'agent-state'), signal: greetings.signal, checkPiModel }));
  });
  const track = <T>(job: Promise<T>): Promise<T> => {
    inflight.add(job);
    job.then(() => { inflight.delete(job); }, () => { inflight.delete(job); });
    return job;
  };
  const cleanups = new EngineCleanupJobs(track);
  const requireReady = () => {
    if (draining) throw new RpcError('APP_DRAINING', 'Weaver is shutting down');
    if (!ready || !commands || !manager || !store || !policy || !quotaProber) throw new RpcError('APP_STARTING', 'Weaver is still starting');
    return { commands, manager, store, policy, prober: quotaProber };
  };
  /** Manual and scheduled refresh share one probe-then-merge path. */
  function refreshQuota(input: QuotaRefreshInput) {
    const active = requireReady();
    return track((async () => {
      if (testContext && !options.quotaProber && !options.channels?.env && !input.channel && (input.engine === 'opencode' || input.engine === undefined)) throw new RpcError('OPENCODE_TEST_ISOLATION', '测试必须提供隔离的额度环境或引擎额度替身。');
      const quota = await active.prober.refresh(input);

      if (draining) throw new RpcError('APP_DRAINING', 'Weaver is shutting down');
      let result;
      try { result = input.channel ? applyQuotaSnapshot(active.policy,quota,input) : {...quota,snapshot:active.policy.snapshot(),policyChanged:false}; }
      catch (error) {
        if (error instanceof QuotaPolicyConflict) throw new RpcError(error.code, error.message);
        throw new RpcError('PERSISTENCE_ERROR', 'Quota was checked but automatic policy blocks could not be saved');
      }
      if (result.policyChanged) active.commands.pump();
      return result;
    })());
  }
  const handlers = createRpcHandlers({
    channels: {
      get:channelSnapshot,
      save:input=>{channelService.save(input);commands?.pump();return channelSnapshot();},
      delete:deleteChannel,
      import:async input=>{if(testContext&&!options.channels?.env&&!input.sourceDir)throw new RpcError('CHANNEL_TEST_ISOLATION','Tests require an isolated channel source');await importer.import(input);return channelSnapshot();},
      refresh:async input=>{
        const selected=binding(input.channel);if(selected.channel.kind!=='subscription')throw new RpcError('CAPABILITY_UNAVAILABLE','API channels have no official subscription quota');
        await refreshQuota({channel:input.channel});return channelSnapshot();
      },
    },
    track,
    refreshQuota,
    quotaSchedule: () => commands!.schedules.quotaStatus(),
    stall: () => stall!,
    freeProbe: () => freeProbe!,
    hellos,
    cleanups,
    modelLister,
    im: () => im!,
    server: () => ({ url: runtime.url, port: runtime.port, dataDir, startedAt, managedBy: managedBy() }),
    janitor: () => janitor!,
  });
  async function dispatch(method: string, args: unknown[]): Promise<unknown> {
    const active = requireReady();
    if (!Object.hasOwn(handlers, method)) throw new RpcError('INVALID_REQUEST', 'Unknown method');
    const result = await handlers[method as RpcMethod](active, args);
    if (!['getImSettings', 'saveImSettings', 'reconnectIm'].includes(method)) await im?.reconcile();
    return result;
  }
  async function call(method: string, args: unknown[]): Promise<unknown> {
    try { return await dispatch(method, args); }
    catch (error) { const mapped = publicError(error); throw new RpcError(mapped.code, mapped.message); }
  }
  async function handleIpc(request: unknown): Promise<unknown> {
    if (draining) return failure('APP_DRAINING', 'Weaver is shutting down');
    if (!ready) return failure('APP_STARTING', 'Weaver is still starting');
    if (!request || typeof request !== 'object' || Array.isArray(request)) return failure('INVALID_REQUEST', 'Invalid request');
    const record = request as Record<string, unknown>;
    if (Object.hasOwn(record, 'apiVersion') || Object.hasOwn(record, 'command')) return commands!.handleAsync(request);
    try {
      const parsed = parseRpcBody(request);
      return { apiVersion: API_VERSION, commandId: null, ok: true, data: await dispatch(parsed.method, parsed.args) };
    } catch (error) {
      const mapped = publicError(error);
      return failure(mapped.code, mapped.message);
    }
  }

  let ipc: { close(): Promise<void> } | undefined;
  let lock: InstanceLock | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  let closed = false;
  const runtime: WeaverRuntime = { url: '', port: 0, done, close };
  try {
    // The lock is the singleton authority: take it before opening the database or publishing discovery.
    lock = await acquireInstanceLock(dataDir);
    ipc = await startLocalIPC(dataDir, request => handleIpc(request), { lockHeld: true });
    http = await startHttpServer({
      port: options.port ?? 0,
      staticRoot: options.dev || (embedded && !options.rendererRoot) ? undefined : rendererRoot,
      staticFiles: embedded && !options.rendererRoot ? embedded.renderer : undefined,
      allowUpgrade: options.dev === true,
      prepare: options.dev ? async (server, port) => {
        const { createServer } = await import('vite');
        vite = await createServer({
          configFile: join(repo, 'vite.config.ts'),
          appType: 'spa',
          // Per data dir, so a test or another instance cannot rebuild the dependency cache under a running dev server.
          cacheDir: join(dataDir, 'vite'),
          // The tracker makes close wait for an optimizer write that Vite's own close does not await.
          optimizeDeps: { rolldownOptions: { plugins: [optimizerTracker.plugin] } },
          server: { middlewareMode: true, cors: false, port, headers: SECURITY_HEADERS, ws: { server } },
        });
      } : undefined,
      delegate: options.dev ? (req, res, next) => { vite!.middlewares(req, res, next); } : undefined,
      call,
    });
    store = new TaskStore(join(dataDir, 'weaver.db'));
    policy = new PolicyStore(store.db);
    channelStore=new ChannelStore(store.db);channelService=new ChannelService(policy,channelStore);
    importer=new NativeChannelImporter(policy,channelStore,{root:join(dataDir,'channels'),env:options.channels?.env});
    // One read-only source import per managed data directory; tests require an explicit isolated source.
    if(options.channels?.autoImport!==false&&(!testContext||options.channels?.env?.HOME)&&!store.getValue('channels.native-import.v1')){
      try{await importer.import({revision:policy.snapshot().revision});store.putValue('channels.native-import.v1',true);}catch{console.error('Native channel import requires attention; source configuration was preserved');}
    }

    janitor = new TempJanitor({
      tmpRoot: options.janitor?.tmpRoot,
      uid: options.janitor?.uid,
      platform: options.janitor?.platform,
      now: options.janitor?.now,
      ttlMs: options.janitor?.ttlMs,
      intervalMs: options.janitor?.intervalMs,
      watchIntervalMs: options.janitor?.watchIntervalMs,
      activeDataDirs: () => [dataDir],
      settings: () => janitorSettings(policy!.snapshot().config),
      store: dbJanitorStore(store!.db),
      log: message => console.error(`Temp janitor: ${message}`),
    });
    im = new ImService({ dataDir,channelConfig:binding, policy: () => policy!.snapshot(), ...options.im,
      parentFactory: async (input, lifecycle?: { signal?: AbortSignal }) => {
        const factory=options.im?.parentFactory as (import('./im/parent-agent').ParentAgentFactory & ((input:import('./im/parent-agent').ParentAgentInput,lifecycle?:{signal?:AbortSignal})=>Promise<import('./im/parent-agent').ParentAgentSession>))|undefined;
        return factory ? factory(input,lifecycle) : createBackgroundParentAgent(input,{dataDir,signal:lifecycle?.signal});
      },
      taskStatus: () => formatStoreStatus(store!),
    });
    quotaProber = options.quotaProber ?? new QuotaProber({ channels:bindings,root:join(dataDir,'agent-state','quota'),env: options.channels?.env,snapshotStore: dbQuotaStore(store.db) });
    // Ladders and probe answers live in the same weaver.db, so a restart keeps its penalties and history.
    stall = new StallMonitor({
      tasks: () => store!.list(),
      policy: () => policy!,
      stateStore: dbStallStore(store.db),
      ready: () => ready && !draining,
      // Recovery is verified with the same light greeting the engines page runs, in this data dir's own scratch.
      probe: (route, signal) => track(sayHi({ channel:route.channel,channelConfig:binding(route.channel),engine: route.engine, model: route.model, effort: route.effort, kind: route.kind }, { root: join(dataDir, 'agent-state'), signal, checkPiModel })
        .then(result => ({ ok: result.ok, ms: result.durationMs, error: result.error }))),
      onBlocksChanged: () => commands?.pump(),
      log: message => console.error(`Stall monitor: ${message}`),
    });
    freeProbe = new FreeChannelProbeMonitor({
      policy: () => policy!,
      stateStore: dbFreeProbeStore(store.db),
      vendorLadder: dbVendorLadder(store.db),
      ready: () => ready && !draining,
      // The same light greeting the penalty recovery uses.
      probe: (route, signal) => track(sayHi({ ...route, channelConfig:binding(route.channel),kind: route.kind }, { root: join(dataDir, 'agent-state'), signal, checkPiModel })
        .then(result => ({ ok: result.ok, ms: result.durationMs, error: result.error }))),
      onBlocksChanged: () => commands?.pump(),
      log: message => console.error(`Free channel probe: ${message}`),
    });
    const workers = new RoutingWorkerAdapter(
      new MockWorkerAdapter(process.execPath, workerScript),
      guardPiLaunch(startCliAgent, checkPiModel),
      join(dataDir, 'agent-state'),
      id => store!.getPackage(id),
      guardPiRun(startCliRun, checkPiModel, () => manager?.launchGateOpen === true),
      binding,
    );
    manager = new TaskManager(store, workers, () => {}, undefined, error => {
      console.error(error instanceof Error ? error.message : 'Task history could not be saved');
    }, () => {
      // Commit-time invalidation: readers see the durable row, and any delivery a pump starts happens after COMMIT.
      commands?.pump();
    });
    // Reattach runs before the command pump or schedules exist, so no new attempt can overlap a recovered run.
    await reattach(manager);

    // Health and penalties are this monitor's own answers, so the command face reads them from it rather than inventing them.
    // The user's engine or worker unblock clears the blocks through the policy service and then resets both monitors' state.
    const unblockBlocks = new PolicyBlockService(() => policy!, { log: message => console.error(`Stall monitor: ${message}`), onChanged: () => commands?.pump() });
    const diagnostics: TaskDiagnostics = {
      taskHealth: task => stall!.taskHealth(task),
      status: () => stall!.status(),
      unblock: engine => unblockEngine({ blocks: unblockBlocks, stall: stall!, freeProbe: freeProbe! }, engine),
      unblockWorker: worker => unblockWorker({ blocks: unblockBlocks, stall: stall!, freeProbe: freeProbe! }, worker),
    };
    commands = new CommandHandler(manager, policy, undefined, undefined, diagnostics, options.ownerHost, {refreshQuota:(channel:string)=>refreshQuota({channel}),channelConfig:binding,dataDir,startCli:startCliAgent,parentFactory:createParentAgent,checkPiModel}, {channelConfig:binding,channelStateDir:join(dataDir,'agent-state','owners')});
    commands.transportStatus = 'ready';
    await commands.schedules.start();
    ready = true;
    stall.start();
    freeProbe.start();
    runtime.port = http.port;
    runtime.url = `http://127.0.0.1:${http.port}`;
    im.start();
    if (!testContext || options.janitor?.tmpRoot !== undefined) janitor.start();
    if (options.open) openBrowser(runtime.url);
    return runtime;
  } catch (error) {
    ready = false;
    draining = true;
    janitor?.stop();
    await im?.close().catch(() => {});
    await commands?.drain().catch(() => {});
    await stall?.stop().catch(() => {});
    await freeProbe?.stop().catch(() => {});
    await quotaProber?.close().catch(() => {});
    greetings.abort();
    await Promise.allSettled([...inflight]);
    try { await manager?.shutdown(); } catch (cleanupError) { console.error(cleanupError instanceof Error ? cleanupError.message : 'shutdown failed'); }
    try { store?.close(); } catch { /* Preserve the initialization error. */ }
    await vite?.close().catch(() => {});
    await settleViteCache(options.dev ? join(dataDir, 'vite') : undefined, { tracker: optimizerTracker, log: message => console.error(`Dev cache: ${message}`) }).catch(error => console.error(`Dev cache: ${error instanceof Error ? error.message : String(error)}`));
    await http?.close().catch(() => {});
    await ipc?.close().catch(() => {});
    await lock?.release().catch(() => {});
    resolveDone();
    throw error;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    draining = true;
    ready = false;
    janitor?.stop();
    let imCloseFailure: unknown;
    try { await im?.close(); } catch (error) { imCloseFailure = error; }
    const ownerDrain = commands?.drain();
    await commands?.schedules.stop().catch(() => {});
    await stall?.stop().catch(() => {});
    await freeProbe?.stop().catch(() => {});
    await quotaProber?.close().catch(() => {});
    greetings.abort();
    await ownerDrain;
    await Promise.allSettled([...inflight]);
    try { await manager?.shutdown(); } catch (error) { console.error(error instanceof Error ? error.message : 'shutdown failed'); }
    try { store?.close(); } catch (error) { console.error(error instanceof Error ? error.message : 'Task history could not be flushed'); }
    await vite?.close().catch(() => {});
    await settleViteCache(options.dev ? join(dataDir, 'vite') : undefined, { tracker: optimizerTracker, log: message => console.error(`Dev cache: ${message}`) }).catch(error => console.error(`Dev cache: ${error instanceof Error ? error.message : String(error)}`));
    await http?.close().catch(() => {});
    await ipc?.close().catch(() => {});
    // The lock is released last: it covers every pending write, the database close and endpoint cleanup.
    await lock?.release().catch(error => console.error(error instanceof Error ? error.message : 'instance lock release failed'));
    resolveDone();
    if (imCloseFailure) throw imCloseFailure;
  }
}
