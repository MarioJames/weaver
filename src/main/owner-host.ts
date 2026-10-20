import { proxyEnvironment } from '../shared/proxy';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export type RunnerResult = { code: number; stdout: string; stderr: string };
export type RunnerInput = { file: string; args: string[]; timeout: number };
export type Runner = (input: RunnerInput) => RunnerResult;
export type AsyncRunner = (input: RunnerInput & { signal?: AbortSignal }) => Promise<RunnerResult>;

export const OWNER_HOST_KINDS = ['claude', 'codex'] as const;
export type OwnerHostEngineKind = (typeof OWNER_HOST_KINDS)[number];
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const OWNER_AGENT_START_TIMEOUT_MS = 60000;

export class OwnerLaunchError extends Error {
  constructor(readonly code: 'OWNER_LAUNCH_FAILED' | 'OWNER_LAUNCH_UNAVAILABLE' | 'OWNER_LAUNCH_UNSUPPORTED', message: string) { super(message); }
}

export function findExecutable(name: string, pathEnv: string = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    try { accessSync(join(dir, name), constants.X_OK); return join(dir, name); } catch { continue; }
  }
  return null;
}
export function herdrOnPath(pathEnv: string = process.env.PATH ?? ''): boolean { return findExecutable('herdr', pathEnv) !== null; }

export function ownerAgentName(taskId: string, epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', 'Owner epoch must be a non-negative integer');
  const hex = taskId.slice(0, 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(hex)) throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', 'Task ID must start with 8 hex characters');
  const name = `owner-${hex}-${epoch}`;
  if (!AGENT_NAME_PATTERN.test(name)) throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `Owner agent name ${name} is invalid`);
  return name;
}

export const defaultRunner: Runner = ({ file, args, timeout }) => {
  const result = spawnSync(file, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGTERM' });
  let stderr = (result.stderr?.toString('utf8') ?? '').trim();
  if (result.error) stderr = stderr ? `${stderr}\n${result.error.message}` : result.error.message;
  return { code: result.status ?? (result.signal ? 143 : 127), stdout: result.stdout?.toString('utf8') ?? '', stderr: stderr.trim() };
};

export interface OwnerLaunchInput {
  taskId: string; epoch: number; title: string; workspace: string;
  proxy?: string; engineKind: string; model: string; effort: string; prompt: string;
  session?: string; runner?: Runner; pathEnv?: string; herdrPath?: string; claudePath?: string;
}
export interface OwnerLaunchResult { session: string; workspaceId: string; paneId: string; agentName: string }

const bounded = (value: string, max = 500): string => Array.from(value.trim()).slice(0, max).join('');
const messageOf = (value: unknown): string => value instanceof Error ? value.message : String(value);
const truncateChars = (value: string, max: number): string => { const chars = Array.from(value); return chars.length > max ? chars.slice(0, max).join('') : value; };
const asId = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const dig = (root: unknown, path: string[]): unknown => {
  let current: unknown = root;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};
const required = (field: string, value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `${field} is required to launch the owner`);
  return value;
};

type LaunchStep = RunnerInput & { cleanup?: boolean };
type Protocol<T> = Generator<LaunchStep, T, RunnerResult>;

// Herdr reports a rejected command as {"error":{"code","message"}}; a client can print it while still exiting 0.
const envelopeFailure = (stdout: string): string | null => {
  const text = stdout.trim();
  if (!text) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const error = (parsed as Record<string, unknown>).error;
  if (error === undefined || error === null) return null;
  if (typeof error === 'string') return bounded(error) || 'herdr reported a failure';
  if (typeof error !== 'object' || Array.isArray(error)) return 'herdr reported a failure';
  const { code, message } = error as Record<string, unknown>;
  const detail = [asId(code), typeof message === 'string' ? message.trim() : ''].filter(Boolean).join(': ');
  return bounded(detail) || 'herdr reported a failure';
};
const detailOf = (result: RunnerResult, max = 500): string =>
  bounded([result.stderr.trim(), envelopeFailure(result.stdout)].filter(Boolean).join('; '), max);
const readJson = (step: string, result: RunnerResult): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `herdr ${step} returned unparseable JSON${result.stderr ? `: ${bounded(result.stderr)}` : ''}`);
  }
};

function* runStep(step: string, request: LaunchStep, observe?: (result: RunnerResult) => void): Protocol<RunnerResult> {
  let result: RunnerResult;
  try { result = yield request; }
  catch (error) { throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `herdr ${step} failed: ${bounded(messageOf(error))}`); }
  observe?.(result);
  if (result.code !== 0 || envelopeFailure(result.stdout)) {
    const detail = detailOf(result);
    throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `herdr ${step} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  if (result.stdout.trim()) readJson(step, result);
  return result;
}
function* closeWorkspace(file: string, session: string, workspaceId: string): Protocol<string | null> {
  let result: RunnerResult;
  try { result = yield { file, args: ['--session', session, 'workspace', 'close', workspaceId], timeout: 15000, cleanup: true }; }
  catch (error) { return `herdr workspace close cleanup also failed: ${bounded(messageOf(error), 300)}`; }
  if (result.code === 0 && !envelopeFailure(result.stdout)) {
    try { if (result.stdout.trim()) readJson('workspace close', result); }
    catch (error) { return `herdr workspace close cleanup also failed: ${bounded(messageOf(error), 300)}`; }
    return null;
  }
  const detail = detailOf(result, 300);
  return `herdr workspace close cleanup also failed (exit ${result.code})${detail ? `: ${detail}` : ''}`;
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', 'Owner launch aborted');
}
function* launchProtocol(input: OwnerLaunchInput, signal?: AbortSignal): Protocol<OwnerLaunchResult> {
  checkAbort(signal);
  const kind = input.engineKind;
  if (!OWNER_HOST_KINDS.includes(kind as OwnerHostEngineKind)) {
    throw new OwnerLaunchError('OWNER_LAUNCH_UNSUPPORTED', `Engine kind ${bounded(kind, 80) || 'unknown'} cannot be launched as an owner host; only claude and codex are supported`);
  }
  required('workspace', input.workspace); required('model', input.model); required('effort', input.effort); required('prompt', input.prompt);
  const session = bounded(input.session ?? 'default', 120) || 'default';
  const herdrPath = input.herdrPath ?? findExecutable('herdr', input.pathEnv ?? process.env.PATH ?? '');
  if (!herdrPath) throw new OwnerLaunchError('OWNER_LAUNCH_UNAVAILABLE', 'herdr was not found on PATH; install Herdr before launching a visible owner host');
  const agentName = ownerAgentName(input.taskId, input.epoch);
  const label = truncateChars(input.title, 40);

  const run = (step: string, args: string[], timeout: number) => runStep(step, { file: herdrPath, args, timeout });
  let workspaceId: string | undefined;
  try {
    const proxyEnv = proxyEnvironment({}, input.proxy);
    const proxyArgs = Object.entries(proxyEnv).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    if (input.proxy === 'direct') for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']) proxyArgs.push('--env', `${key}=`);
    const createRequest = { file: herdrPath, args: ['--session', session, 'workspace', 'create', '--cwd', input.workspace, '--label', label, '--no-focus', ...proxyArgs], timeout: 30000 };
    const create = readJson('workspace create', yield* runStep('workspace create', createRequest, result => {
      // A terminated create can already have emitted its exact resource receipt. Preserve that cleanup authority.
      try { workspaceId = asId(dig(JSON.parse(result.stdout), ['result', 'workspace', 'workspace_id'])); } catch { /* No exact receipt, no guessed cleanup. */ }
    }));
    const paneId = asId(dig(create, ['result', 'root_pane', 'pane_id']));
    if (!workspaceId) throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', 'herdr workspace create returned no workspace id');
    if (!paneId) throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', 'herdr workspace create returned no root pane id');
    checkAbort(signal);
    const args = kind === 'codex' ? ['-m', input.model, '-c', `model_reasoning_effort="${input.effort}"`] : ['--model', input.model];
    const claudePath = kind === 'claude' ? input.claudePath ?? findExecutable('claude', input.pathEnv ?? process.env.PATH ?? '') : null;
    if (claudePath) {
      try {
        const help = yield { file: claudePath, args: ['--help'], timeout: 15000 };
        if (help.code === 0 && /--effort\b/.test(help.stdout)) args.push('--effort', input.effort);
      } catch { /* claude --help is best effort only */ }
    }
    checkAbort(signal);
    yield* run('agent start', ['--session', session, 'agent', 'start', agentName, '--kind', kind, '--pane', paneId, '--timeout', String(OWNER_AGENT_START_TIMEOUT_MS), '--', ...args], 70000);
    checkAbort(signal);
    yield* run('agent prompt', ['--session', session, 'agent', 'prompt', agentName, input.prompt], 60000);
    checkAbort(signal);
    return { session, workspaceId, paneId, agentName };
  } catch (error) {
    const failure = error instanceof OwnerLaunchError ? error : new OwnerLaunchError('OWNER_LAUNCH_FAILED', `herdr owner launch failed after workspace create: ${bounded(messageOf(error))}`);
    const cleanup = workspaceId ? yield* closeWorkspace(herdrPath, session, workspaceId) : null;
    throw cleanup ? new OwnerLaunchError(failure.code, `${failure.message}; ${cleanup}`) : failure;
  }
}

function drive<T>(protocol: Protocol<T>, runner: Runner): T {
  let step = protocol.next();
  while (!step.done) {
    const { cleanup: _cleanup, ...request } = step.value;
    let result: RunnerResult;
    try { result = runner(request); }
    catch (error) { step = protocol.throw(error); continue; }
    step = protocol.next(result);
  }
  return step.value;
}
export function launchOwner(input: OwnerLaunchInput): OwnerLaunchResult {
  return drive(launchProtocol(input), input.runner ?? defaultRunner);
}
async function driveAsync<T>(protocol: Protocol<T>, runner: AsyncRunner, signal?: AbortSignal): Promise<T> {
  let step = protocol.next();
  while (!step.done) {
    const { cleanup, ...request } = step.value;
    let result: RunnerResult;
    try {
      if (!cleanup) checkAbort(signal);
      result = await runner({ ...request, signal: cleanup ? undefined : signal });
    } catch (error) { step = protocol.throw(error); continue; }
    step = protocol.next(result);
  }
  return step.value;
}
export function launchOwnerAsync(input: OwnerLaunchInput & { signal?: AbortSignal; asyncRunner?: AsyncRunner }): Promise<OwnerLaunchResult> {
  return driveAsync(launchProtocol(input, input.signal), input.asyncRunner ?? defaultAsyncRunner, input.signal);
}
type CloseHostOptions = { herdrPath?: string; pathEnv?: string };
function* closeHostProtocol(host: OwnerLaunchResult, options: CloseHostOptions): Protocol<void> {
  if (!asId(host.session) || host.session !== host.session.trim() || !asId(host.workspaceId) || host.workspaceId !== host.workspaceId.trim()) {
    throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', 'Exact owner session and workspace id are required for cleanup');
  }
  const file = options.herdrPath ?? findExecutable('herdr', options.pathEnv ?? process.env.PATH ?? '');
  if (!file) throw new OwnerLaunchError('OWNER_LAUNCH_UNAVAILABLE', 'herdr was not found on PATH');
  const failure = yield* closeWorkspace(file, host.session, host.workspaceId);
  if (failure) throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', failure);
}
/** Synchronous callers retain the same exact cleanup protocol when an injected launcher supersedes its binding. */
export function closeOwnerHost(host: OwnerLaunchResult, options: CloseHostOptions & { runner?: Runner } = {}): void {
  drive(closeHostProtocol(host, options), options.runner ?? defaultRunner);
}
export async function closeOwnerHostAsync(host: OwnerLaunchResult, options: CloseHostOptions & { asyncRunner?: AsyncRunner } = {}): Promise<void> {
  await driveAsync(closeHostProtocol(host, options), options.asyncRunner ?? defaultAsyncRunner);
}

// Each child has a bounded evidence buffer and an owned terminate/kill lifecycle.
export const defaultAsyncRunner: AsyncRunner = ({ file, args, timeout, signal }) => new Promise(resolve => {
  if (signal?.aborted) { resolve({ code: 143, stdout: '', stderr: 'Owner launch aborted' }); return; }
  const limit = 64 * 1024;
  let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0);
  let reason = '', settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const child = spawn(file, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (current: Buffer, chunk: Buffer) => current.length >= limit ? current : Buffer.concat([current, chunk.subarray(0, limit - current.length)]);
  child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
  const stop = (message: string) => {
    if (reason || settled) return;
    reason = message;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 250);
  };
  const abort = () => stop('Owner launch aborted');
  const timer = setTimeout(() => stop('Owner launch step timed out'), timeout);
  const finish = (code: number, error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    const detail = [stderr.toString('utf8').trim(), reason, error?.message].filter(Boolean).join('; ');
    resolve({ code: reason ? 143 : code, stdout: stdout.toString('utf8'), stderr: detail });
  };
  child.once('error', error => finish(127, error));
  child.once('close', (code, termination) => finish(code ?? (termination ? 143 : 127)));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
});
