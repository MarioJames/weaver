import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION } from '../shared/commands';
import { EXECUTION_BOUNDARY, ENGINE_CATALOG, readinessFor, type EngineProbeRecord } from '../shared/engines';
import { parseId, parseTaskInput } from '../shared/validation';
import { startCliAgent } from './adapters/cli/index';
import { HelloJobs, parseHelloInput, sayHi } from './engines/hello';
import { embeddedApp } from './embedded';
import { RoutingWorkerAdapter } from './adapters/routing';
import { MockWorkerAdapter } from './adapters/worker';
import { CommandHandler, configuredParallel, workerLoad } from './commands';
import { applyEngineEnabled, parseEngineToggle } from './engines/control';
import { EngineProber } from './engines/probe';
import { SECURITY_HEADERS, startHttpServer, type HttpRuntime } from './http';
import { failure, startLocalIPC } from './local-ipc';
import { TaskManager } from './manager';
import { validateConfig } from './policy/routing';
import { PolicyStore } from './policy/store';
import { applyQuotaSnapshot, parseQuotaRefresh, QuotaPolicyConflict, QUOTA_CAPABILITIES } from './policy/quota';
import type { QuotaRefreshInput } from '../shared/quota';
import { QuotaProber } from './quota';
import { QuotaScheduler } from './quota/scheduler';
import { STALL_FILE, StallMonitor } from './stall';
import { RpcError, parseRpcBody } from './rpc';
import { TaskStore } from './store';
import { VERSION } from '../shared/version';

export interface RuntimeOptions {
  dataDir: string;
  port?: number;
  open?: boolean;
  dev?: boolean;
  rendererRoot?: string;
  repoRoot?: string;
  workerScript?: string;
  /** Internal dependency injection for isolated runtime tests; never supplied over RPC. */
  quotaProber?: QuotaProber;
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
  let ready = false;
  let draining = false;
  let commands: CommandHandler | undefined;
  let manager: TaskManager | undefined;
  let store: TaskStore | undefined;
  let policy: PolicyStore | undefined;
  let http: HttpRuntime | undefined;
  let vite: { middlewares: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: (error?: unknown) => void) => void; close(): Promise<void> } | undefined;
  const inflight = new Set<Promise<unknown>>();
  const greetings = new AbortController();
  const hellos = new HelloJobs(route => {
    const engine = policy?.snapshot().config.engines[route.engine];
    return track(sayHi({ ...route, kind: engine?.kind ?? route.engine }, { root: join(dataDir, 'agent-state'), signal: greetings.signal }));
  });
  const prober = new EngineProber();
  const quotaProber = options.quotaProber ?? new QuotaProber();
  let probes: EngineProbeRecord[] | null = null;
  const remember = (probe: EngineProbeRecord | null) => {
    if (!probe) return probes;
    const next = [...(probes ?? []).filter(item => item.id !== probe.id), probe];
    probes = ENGINE_CATALOG.map(entry => next.find(item => item.id === entry.id)).filter((item): item is EngineProbeRecord => Boolean(item));
    return probes;
  };
  const track = <T>(job: Promise<T>): Promise<T> => {
    inflight.add(job);
    job.then(() => { inflight.delete(job); }, () => { inflight.delete(job); });
    return job;
  };
  const requireReady = () => {
    if (draining) throw new RpcError('APP_DRAINING', 'Weaver is shutting down');
    if (!ready || !commands || !manager || !store || !policy) throw new RpcError('APP_STARTING', 'Weaver is still starting');
    return { commands, manager, store, policy };
  };
  /** Manual and scheduled refresh share one probe-then-merge path. */
  function refreshQuota(input: QuotaRefreshInput) {
    const active = requireReady();
    return track((async () => {
      const quota = await quotaProber.refresh(input);
      if (draining) throw new RpcError('APP_DRAINING', 'Weaver is shutting down');
      let result;
      try { result = applyQuotaSnapshot(active.policy, quota, input); }
      catch (error) {
        if (error instanceof QuotaPolicyConflict) throw new RpcError(error.code, error.message);
        throw new RpcError('PERSISTENCE_ERROR', 'Quota was checked but automatic policy blocks could not be saved');
      }
      if (result.policyChanged) active.commands.pump();
      return result;
    })());
  }
  const scheduler = new QuotaScheduler({
    config: () => policy!.snapshot().config,
    refresh: async engine => { if (ready && !draining) await refreshQuota({ engine }); },
    log: error => console.error(`Scheduled quota refresh failed: ${error instanceof Error ? error.message : 'unknown error'}`),
  });
  const stall = new StallMonitor({
    tasks: () => store?.list() ?? [],
    policy: () => policy!,
    statePath: join(dataDir, STALL_FILE),
    ready: () => ready && !draining,
    // Recovery is verified with the same light greeting the engines page runs, in this data dir's own scratch.
    probe: (route, signal) => track(sayHi({ engine: route.engine, model: route.model, effort: route.effort, kind: route.kind }, { root: join(dataDir, 'agent-state'), signal })
      .then(result => ({ ok: result.ok, ms: result.durationMs, error: result.error }))),
    onBlocksChanged: () => commands?.pump(),
    log: message => console.error(`Stall monitor: ${message}`),
  });
  async function dispatch(method: string, args: unknown[]): Promise<unknown> {
    const active = requireReady();
    switch (method) {
      case 'command': return active.commands.handle(args[0]);
      case 'getPolicy': return active.policy.snapshot();
      case 'getQuota': return { ...quotaProber.get(), schedule: scheduler.status() };
      case 'getStall': return stall.status();
      case 'refreshQuota': return refreshQuota(parseQuotaRefresh(args[0]));
      case 'validatePolicy': {
        let encoded = '';
        try { encoded = JSON.stringify(args[0]); } catch { throw new RpcError('INVALID_REQUEST', 'Policy must be JSON'); }
        if (Buffer.byteLength(encoded) > 256 * 1024) throw new RpcError('INVALID_REQUEST', 'Policy exceeds 256 KiB');
        return validateConfig(args[0]);
      }
      case 'savePolicy': {
        const snapshot = active.policy.save(args[0]);
        active.commands.pump();
        return snapshot;
      }
      case 'sayHi': {
        const input = parseHelloInput(args[0]);
        if (!active.policy.snapshot().config.engines[input.engine]) throw new RpcError('INVALID_REQUEST', `Engine ${input.engine} is not configured`);
        try { return hellos.start(input); } catch (error) { throw new RpcError('CAPACITY_EXCEEDED', error instanceof Error ? error.message : String(error)); }
      }
      case 'sayHiResult': {
        const id = args[0];
        if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new RpcError('INVALID_REQUEST', 'Invalid probe id');
        const job = hellos.get(id);
        if (!job) throw new RpcError('NOT_FOUND', 'Probe not found or expired');
        return job;
      }
      case 'previewRoute': {
        // The route shown is the route a dispatch would take now, so the server supplies the live load.
        const input = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] as Record<string, unknown> : {};
        return active.policy.preview({ ...input, workerLoad: workerLoad(active.store.list()) });
      }
      case 'scanEngines': {
        const found = await track(prober.scan());
        probes = found;
        const snapshot = active.policy.snapshot();
        return { probedAt: new Date().toISOString(), probes: found, readiness: readinessFor(found, snapshot.config), boundary: EXECUTION_BOUNDARY };
      }
      case 'setEngineEnabled': {
        const result = await track(applyEngineEnabled(active.policy, prober, parseEngineToggle(args[0])));
        active.commands.pump();
        const known = remember(result.probe) ?? [];
        return { snapshot: result.snapshot, probe: result.probe, readiness: readinessFor(known, result.snapshot.config) };
      }
      case 'listTasks': return active.store.list();
      case 'createTask': {
        const input = parseTaskInput(args[0]);
        const response = active.commands.handle({ apiVersion: API_VERSION, commandId: randomUUID(), command: 'tasks.create', args: input as unknown as Record<string, unknown> });
        if (!response.ok) throw new RpcError(response.error?.code ?? 'COMMAND_FAILED', response.error?.message ?? 'Command failed');
        return active.store.get((response.data as { id: string }).id);
      }
      case 'startTask': {
        const id = parseId(args[0]);
        const response = active.commands.handle({ apiVersion: API_VERSION, commandId: randomUUID(), command: 'workers.spawn', args: { taskId: id } });
        if (!response.ok) throw new RpcError(response.error?.code ?? 'COMMAND_FAILED', response.error?.message ?? 'Command failed');
        return active.store.get(id);
      }
      case 'cancelTask': {
        const id = parseId(args[0]);
        const response = active.commands.handle({ apiVersion: API_VERSION, commandId: randomUUID(), command: 'tasks.cancel', args: { taskId: id } });
        if (!response.ok) throw new RpcError(response.error?.code ?? 'COMMAND_FAILED', response.error?.message ?? 'Command failed');
        return active.store.get(id);
      }
      case 'capabilities': return {
        worker: active.manager.canLaunchReal
          ? 'Saved opencode, pi, grok, codex, and qodercli routes launch that engine. mock-jsonl runs only when requested. Failures do not fall back.'
          : 'mock-jsonl is the explicit test provider. A real route fails until the engine launcher is loaded and does not fall back to mock.',
        owner: 'Logical registration only. The owner is the agent in the skill host and calls this CLI. This process does not spawn an owner model.',
        maxParallel: configuredParallel(active.policy),
        storePath: active.store.path,
        quota: QUOTA_CAPABILITIES,
      };
      case 'serverInfo': return {
        pid: process.pid,
        url: runtime.url,
        port: runtime.port,
        dataDir,
        version: VERSION,
        startedAt,
        runningWorkers: active.manager.runningCount,
        managedBy: managedBy(),
      };
      default: throw new RpcError('INVALID_REQUEST', 'Unknown method');
    }
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
    if (Object.hasOwn(record, 'apiVersion') || Object.hasOwn(record, 'command')) return commands!.handle(request);
    try {
      const parsed = parseRpcBody(request);
      return { apiVersion: API_VERSION, commandId: null, ok: true, data: await dispatch(parsed.method, parsed.args) };
    } catch (error) {
      const mapped = publicError(error);
      return failure(mapped.code, mapped.message);
    }
  }

  const ipc = await startLocalIPC(dataDir, request => handleIpc(request));
  let resolveDone: () => void = () => {};
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  let closed = false;
  const runtime: WeaverRuntime = { url: '', port: 0, done, close };
  try {
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
          server: { middlewareMode: true, cors: false, port, headers: SECURITY_HEADERS, ws: { server } },
        });
      } : undefined,
      delegate: options.dev ? (req, res, next) => { vite!.middlewares(req, res, next); } : undefined,
      call,
    });
    store = new TaskStore(join(dataDir, 'tasks.v1.json'));
    store.recover();
    policy = new PolicyStore(join(dataDir, 'policy.v1.json'));
    const workers = new RoutingWorkerAdapter(new MockWorkerAdapter(process.execPath, workerScript), startCliAgent, join(dataDir, 'agent-state'), id => store!.getMetadata().packages.find(pkg => pkg.id === id));
    manager = new TaskManager(store, workers, () => {}, undefined, error => {
      console.error(error instanceof Error ? error.message : 'Task history could not be saved');
    });
    commands = new CommandHandler(manager, policy);
    commands.transportStatus = 'ready';
    ready = true;
    scheduler.start();
    stall.start();
    runtime.port = http.port;
    runtime.url = `http://127.0.0.1:${http.port}`;
    if (options.open) openBrowser(runtime.url);
    return runtime;
  } catch (error) {
    ready = false;
    await quotaProber.close().catch(() => {});
    await vite?.close().catch(() => {});
    await http?.close().catch(() => {});
    await ipc.close().catch(() => {});
    resolveDone();
    throw error;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    draining = true;
    ready = false;
    if (commands) commands.draining = true;
    await scheduler.stop().catch(() => {});
    await stall.stop().catch(() => {});
    await quotaProber.close().catch(() => {});
    greetings.abort();
    await Promise.allSettled([...inflight]);
    try { await manager?.shutdown(); } catch (error) { console.error(error instanceof Error ? error.message : 'shutdown failed'); }
    await vite?.close().catch(() => {});
    await http?.close().catch(() => {});
    await ipc.close().catch(() => {});
    resolveDone();
  }
}
