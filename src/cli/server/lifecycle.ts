import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { failure, LocalIPCError } from '../../main/local-ipc';
import type { Envelope, RunResult, ServerArgs, ServerEnv, ServerInfo, ServiceState } from './env';
import { UNIT_MARKER } from './env';
import { LAUNCHD_LABEL, launchdPlist, plistProgramArguments } from './launchd';
import { SERVICE_NAME, systemdTokens, systemdUnit } from './systemd';

const POLL_MS = 200;
const PROBE_MS = 2_000;
const LOG_TAIL_LINES = 20;
const LOG_TAIL_CHARS = 2_000;

function readFileOrNull(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return; }
}
function marked(content: string | undefined): boolean {
  return content !== undefined && content.includes(UNIT_MARKER);
}

const succeed = (data: unknown): Envelope => ({ apiVersion: 'weaver.v1', commandId: null, ok: true, data });
const text = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function runText(result: RunResult): string {
  const detail = (result.stderr || result.stdout).trim().replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return detail ? detail.slice(0, 400) : `exit ${result.code ?? 'signal'}`;
}

/** A standalone executable runs itself; a checkout reruns this CLI entry with the same loader flags. */
export function selfCommand(args: readonly string[], env: ServerEnv): string[] {
  return env.standalone ? [env.execPath, ...args] : [env.execPath, ...env.execArgv, env.entryPath, ...args];
}
export function webArgs(port: number, dataDir: string): string[] {
  return ['web', '--no-open', '--port', String(port), '--data-dir', dataDir];
}
export function serverLogPath(dataDir: string): string {
  return join(dataDir, 'server.log');
}

export function servicePath(env: ServerEnv): { manager: 'systemd' | 'launchd'; path: string } | undefined {
  if (env.platform === 'linux') return { manager: 'systemd', path: join(env.env.XDG_CONFIG_HOME || join(env.home, '.config'), 'systemd', 'user', SERVICE_NAME) };
  if (env.platform === 'darwin') return { manager: 'launchd', path: join(env.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`) };
  return;
}
function serviceState(env: ServerEnv): ServiceState {
  const layout = servicePath(env);
  if (!layout) return { installed: false, manager: null, path: '' };
  return { installed: marked(readFileOrNull(layout.path)), manager: layout.manager, path: layout.path };
}
/** The port and data directory an installed unit starts, so `start` can reuse the service. */
function unitValues(state: ServiceState): { port: number; dataDir: string } | undefined {
  const content = readFileOrNull(state.path);
  if (!marked(content)) return;
  let args: string[];
  if (state.manager === 'systemd') {
    const line = content!.split('\n').find(entry => entry.startsWith('ExecStart='));
    if (!line) return;
    args = systemdTokens(line.slice('ExecStart='.length));
  } else {
    args = plistProgramArguments(content!);
  }
  const flag = (name: string) => { const at = args.lastIndexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const port = flag('--port');
  const dataDir = flag('--data-dir');
  if (!port || !dataDir || !/^\d+$/.test(port)) return;
  return { port: Number(port), dataDir: resolve(dataDir) };
}

function isServerInfo(value: unknown): value is ServerInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isInteger(record.pid) && typeof record.url === 'string' && Number.isInteger(record.port) && typeof record.dataDir === 'string' &&
    typeof record.version === 'string' && typeof record.startedAt === 'string' && Number.isInteger(record.runningWorkers) &&
    (record.managedBy === null || record.managedBy === 'systemd' || record.managedBy === 'launchd');
}

type Probe = { state: 'running'; info: ServerInfo } | { state: 'stopped' } | { state: 'error'; code: string; message: string };

async function probeServer(env: ServerEnv, dataDir: string, timeoutMs = PROBE_MS): Promise<Probe> {
  let envelope: Envelope;
  try { envelope = await env.request(dataDir, { method: 'serverInfo', args: [] }, timeoutMs); }
  catch (error) {
    const code = error instanceof LocalIPCError ? error.code : 'TRANSPORT_ERROR';
    if (code === 'APP_NOT_RUNNING') return { state: 'stopped' };
    return { state: 'error', code, message: text(error) };
  }
  if (envelope.ok !== true) {
    return { state: 'error', code: envelope.error?.code ?? 'INTERNAL_ERROR', message: envelope.error?.message ?? 'Weaver returned an error' };
  }
  if (!isServerInfo(envelope.data)) return { state: 'error', code: 'INVALID_RESPONSE', message: 'Weaver returned an unexpected serverInfo record' };
  return { state: 'running', info: envelope.data };
}

function logTail(path: string): string {
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { return ''; }
  const tail = raw.split('\n').filter(Boolean).slice(-LOG_TAIL_LINES).join('\n');
  const clean = tail.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > LOG_TAIL_CHARS ? clean.slice(-LOG_TAIL_CHARS) : clean;
}

/** Waits for serverInfo, giving up early when the detached child exits or the deadline passes. */
async function waitForServer(env: ServerEnv, args: ServerArgs, exit?: { exited: boolean; code: number | null }): Promise<Envelope> {
  const logPath = serverLogPath(args.dataDir);
  const deadline = env.now() + args.timeoutMs;
  for (;;) {
    const probe = await probeServer(env, args.dataDir);
    if (probe.state === 'running') return succeed({ status: 'running', ...probe.info });
    if (exit?.exited) {
      const tail = logTail(logPath);
      return failure('SERVER_START_FAILED', `The server process exited (code ${exit.code ?? 'signal'}) before Weaver was ready.${tail ? ` Last output: ${tail}` : ''}`);
    }
    if (env.now() + POLL_MS >= deadline) return failure('SERVER_START_TIMEOUT', `Weaver did not report ready within ${Math.round(args.timeoutMs / 1000)}s.`);
    await env.sleep(POLL_MS);
  }
}

export async function serverStatus(env: ServerEnv, args: ServerArgs): Promise<Envelope> {
  const service = serviceState(env);
  const probe = await probeServer(env, args.dataDir);
  if (probe.state === 'running') return succeed({ status: 'running', ...probe.info, service });
  if (probe.state === 'stopped') return succeed({ status: 'stopped', service });
  return failure(probe.code, probe.message);
}

export async function serverStart(env: ServerEnv, args: ServerArgs): Promise<Envelope> {
  const current = await probeServer(env, args.dataDir);
  if (current.state === 'running') return succeed({ status: 'running', alreadyRunning: true, ...current.info });
  if (current.state === 'error') return failure(current.code, current.message);
  const service = serviceState(env);
  const managed = service.installed ? unitValues(service) : undefined;
  if (managed && managed.port === args.port && managed.dataDir === args.dataDir) {
    const launch = service.manager === 'systemd'
      ? await env.run('systemctl', ['--user', 'start', SERVICE_NAME])
      : await env.run('launchctl', ['kickstart', `gui/${env.uid}/${LAUNCHD_LABEL}`]);
    if (launch.code !== 0) return failure('SERVER_START_FAILED', `${service.manager === 'systemd' ? `systemctl --user start ${SERVICE_NAME}` : `launchctl kickstart gui/${env.uid}/${LAUNCHD_LABEL}`} failed: ${runText(launch)}`);
    return waitForServer(env, args);
  }
  const logPath = serverLogPath(args.dataDir);
  const watch = { exited: false, code: null as number | null };
  void env.spawnServer(selfCommand(webArgs(args.port, args.dataDir), env), args.dataDir, logPath).then(result => { watch.exited = true; watch.code = result.code; });
  return waitForServer(env, args, watch);
}

export async function serverStop(env: ServerEnv, args: ServerArgs): Promise<Envelope> {
  const current = await probeServer(env, args.dataDir);
  if (current.state === 'stopped') return succeed({ status: 'stopped', alreadyStopped: true });
  if (current.state === 'error') return failure(current.code, current.message);
  const { pid, runningWorkers } = current.info;
  let cancelledWorkers: number | undefined;
  let deadline = env.now() + args.timeoutMs;
  if (args.cancelWorkers) {
    const drained = await cancelWorkersAndDrain(env, args, deadline);
    if (!drained.ok) return drained;
    cancelledWorkers = (drained.data as { cancelledWorkers: number }).cancelledWorkers;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === env.pid) return failure('SERVER_STOP_FAILED', `Refusing to signal server pid ${pid}.`);
  try { env.kill(pid); } catch (error) { return failure('SERVER_STOP_FAILED', `Could not signal pid ${pid}: ${text(error)}`); }
  for (;;) {
    const probe = await probeServer(env, args.dataDir);
    if (probe.state === 'stopped') {
      if (cancelledWorkers !== undefined) return succeed({ status: 'stopped', pid, cancelledWorkers });
      if (runningWorkers > 0) return succeed({ status: 'stopped', pid, workers: runningWorkers, note: `${runningWorkers} ${runningWorkers === 1 ? 'worker keeps' : 'workers keep'} running and reattach automatically after restart.` });
      return succeed({ status: 'stopped', pid });
    }
    if (env.now() + POLL_MS >= deadline) return failure('SERVER_STOP_TIMEOUT', `Weaver was still running ${Math.round(args.timeoutMs / 1000)}s after SIGTERM to pid ${pid}.`);
    await env.sleep(POLL_MS);
  }
}

/**
 * `--cancel-workers`: list running/cancelling tasks over local IPC, cancel each one with a
 * stable command-id (`server-stop-cancel-<taskId>`, so a retry replays the same receipt via
 * `operations get` instead of cancelling twice), then poll until no real (non-native) worker
 * remains. Never signals the server; a timeout or IPC error returns before any SIGTERM.
 */
async function cancelWorkersAndDrain(env: ServerEnv, args: ServerArgs, deadline: number): Promise<Envelope> {
  const requested = new Set<string>();
  for (;;) {
    if (deadline - env.now() <= 0) return drainTimeout(args, -1);
    const budget = Math.max(1, Math.min(deadline - env.now(), 5_000));
    let listed: Envelope;
    try { listed = await env.request(args.dataDir, { method: 'listTasks', args: [] }, budget); }
    catch (error) { return failure(error instanceof LocalIPCError ? error.code : 'TRANSPORT_ERROR', `Could not list running workers before stopping: ${text(error)}`); }
    if (listed.ok !== true) return failure(listed.error?.code ?? 'INTERNAL_ERROR', listed.error?.message ?? 'Could not list running workers before stopping');
    const active = realActiveWorkers(listed.data);
    if (active.length === 0) return succeed({ cancelledWorkers: requested.size });
    for (const taskId of active) {
      if (requested.has(taskId)) continue;
      requested.add(taskId);
      try {
        await env.request(args.dataDir, {
          method: 'command',
          args: [{ apiVersion: 'weaver.v1', commandId: `server-stop-cancel-${taskId}`, command: 'tasks.cancel', args: { taskId } }],
        }, budget);
      } catch { /* A task that ends mid-drain needs no cancel; the poll below decides. */ }
    }
    if (deadline - env.now() <= 0) return drainTimeout(args, active.length);
    await env.sleep(POLL_MS);
  }
}

/** Running/cancelling tasks that own a real worker process; native runs belong to the owner, not the server. */
function realActiveWorkers(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const task = item as { id?: unknown; status?: unknown; run?: { execution?: unknown }; dispatch?: { execution?: unknown } };
    if (typeof task.id !== 'string' || (task.status !== 'running' && task.status !== 'cancelling')) continue;
    const execution = typeof task.run?.execution === 'string' ? task.run.execution : typeof task.dispatch?.execution === 'string' ? task.dispatch.execution : 'mock';
    if (execution === 'native') continue;
    ids.push(task.id);
  }
  return ids;
}

function drainTimeout(args: ServerArgs, workers: number): Envelope {
  const detail = workers >= 0 ? `${workers} ${workers === 1 ? 'worker is' : 'workers are'} still running` : 'workers did not drain in time';
  return failure('SERVER_CANCEL_TIMEOUT', `${detail} after ${Math.round(args.timeoutMs / 1000)}s; SIGTERM was not sent. Retry with a longer --timeout once the workers finish.`);
}

function writeUnit(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temp = `${path}.weaver-${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* A file that was never written needs no cleanup. */ }
    throw error;
  }
}

export async function serverInstall(env: ServerEnv, args: ServerArgs): Promise<Envelope> {
  if (!env.standalone) return failure('SERVER_INSTALL_UNSUPPORTED', 'weaver server install needs the installed standalone weaver; use weaver server start from a checkout.');
  const layout = servicePath(env);
  if (!layout) return failure('SERVER_INSTALL_UNSUPPORTED', `weaver server install does not support the ${env.platform} platform.`);
  const command = selfCommand(webArgs(args.port, args.dataDir), env);
  const content = layout.manager === 'systemd' ? systemdUnit(command, env) : launchdPlist(command, env, serverLogPath(args.dataDir));
  const existing = readFileOrNull(layout.path);
  if (existing !== undefined && !marked(existing) && !args.force)
    return failure('SERVER_UNIT_EXISTS', `A service file weaver did not install already exists at ${layout.path}. Pass --force to replace it.`);
  try { writeUnit(layout.path, content); }
  catch (error) { return failure('SERVER_INSTALL_FAILED', `Could not write ${layout.path}: ${text(error)}`); }
  const service: ServiceState = { installed: true, manager: layout.manager, path: layout.path };
  if (layout.manager === 'systemd') {
    for (const step of [['--user', 'daemon-reload'], ['--user', 'enable', SERVICE_NAME]]) {
      const result = await env.run('systemctl', step);
      if (result.code !== 0) return failure('SERVER_INSTALL_FAILED', `systemctl ${step.join(' ')} failed: ${runText(result)}`);
    }
  }
  const current = await probeServer(env, args.dataDir);
  if (current.state === 'running') {
    if (current.info.managedBy === layout.manager) return succeed({ ...service, running: 'managed', ...current.info });
    return succeed({ ...service, running: 'unmanaged', hint: 'weaver server stop && weaver server start' });
  }
  if (current.state === 'error') return succeed({ ...service, running: 'unknown', error: { code: current.code, message: current.message } });
  const launch = layout.manager === 'systemd'
    ? await env.run('systemctl', ['--user', 'start', SERVICE_NAME])
    : await env.run('launchctl', ['bootstrap', `gui/${env.uid}`, layout.path]);
  if (launch.code !== 0) {
    const label = layout.manager === 'systemd' ? `systemctl --user start ${SERVICE_NAME}` : `launchctl bootstrap gui/${env.uid}`;
    return failure('SERVER_INSTALL_FAILED', `${label} failed: ${runText(launch)}`);
  }
  const waited = await waitForServer(env, args);
  if (!waited.ok) return waited;
  return succeed({ ...service, running: 'started', ...(waited.data as object) });
}

export async function serverUninstall(env: ServerEnv, args: ServerArgs): Promise<Envelope> {
  const layout = servicePath(env);
  if (!layout) return failure('SERVER_INSTALL_UNSUPPORTED', `weaver server uninstall does not support the ${env.platform} platform.`);
  const existing = readFileOrNull(layout.path);
  if (existing === undefined) return succeed({ installed: false, manager: layout.manager, path: layout.path });
  if (!marked(existing)) return succeed({ installed: false, manager: layout.manager, path: layout.path, note: 'That file was not installed by weaver and was left in place.' });
  let leftoverWorkers = 0;
  if (layout.manager === 'launchd') {
    const current = await probeServer(env, args.dataDir);
    leftoverWorkers = current.state === 'running' ? current.info.runningWorkers : 0;
    if (args.cancelWorkers && leftoverWorkers > 0) {
      const drained = await cancelWorkersAndDrain(env, args, env.now() + args.timeoutMs);
      if (!drained.ok) return drained;
      leftoverWorkers = 0;
    }
    const result = await env.run('launchctl', ['bootout', `gui/${env.uid}/${LAUNCHD_LABEL}`]);
    if (result.code !== 0) return failure('SERVER_UNINSTALL_FAILED', `launchctl bootout gui/${env.uid}/${LAUNCHD_LABEL} failed: ${runText(result)}`);
  } else {
    const result = await env.run('systemctl', ['--user', 'disable', SERVICE_NAME]);
    if (result.code !== 0) return failure('SERVER_UNINSTALL_FAILED', `systemctl --user disable ${SERVICE_NAME} failed: ${runText(result)}`);
  }
  try { unlinkSync(layout.path); }
  catch (error) { return failure('SERVER_UNINSTALL_FAILED', `Could not remove ${layout.path}: ${text(error)}`); }
  if (layout.manager === 'systemd') {
    const reload = await env.run('systemctl', ['--user', 'daemon-reload']);
    if (reload.code !== 0) return failure('SERVER_UNINSTALL_FAILED', `systemctl --user daemon-reload failed: ${runText(reload)}`);
  }
  const running = await probeServer(env, args.dataDir);
  if (leftoverWorkers > 0) return succeed({ installed: false, manager: layout.manager, path: layout.path, running: running.state === 'running', workers: leftoverWorkers, note: `${leftoverWorkers} ${leftoverWorkers === 1 ? 'worker keeps' : 'workers keep'} running and reattach automatically after restart.` });
  return succeed({ installed: false, manager: layout.manager, path: layout.path, running: running.state === 'running' });
}
