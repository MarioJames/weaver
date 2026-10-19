import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export type RunnerResult = { code: number; stdout: string; stderr: string };
export type RunnerInput = { file: string; args: string[]; timeout: number };
export type Runner = (input: RunnerInput) => RunnerResult;

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
  engineKind: string; model: string; effort: string; prompt: string;
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

export function launchOwner(input: OwnerLaunchInput): OwnerLaunchResult {
  const kind = input.engineKind;
  if (!OWNER_HOST_KINDS.includes(kind as OwnerHostEngineKind)) {
    throw new OwnerLaunchError('OWNER_LAUNCH_UNSUPPORTED', `Engine kind ${bounded(kind, 80) || 'unknown'} cannot be launched as an owner host; only claude and codex are supported`);
  }
  required('workspace', input.workspace); required('model', input.model); required('effort', input.effort); required('prompt', input.prompt);
  const session = bounded(input.session ?? 'default', 120) || 'default';
  const herdrPath = input.herdrPath ?? findExecutable('herdr', input.pathEnv ?? process.env.PATH ?? '');
  if (!herdrPath) throw new OwnerLaunchError('OWNER_LAUNCH_UNAVAILABLE', 'herdr was not found on PATH; install Herdr before launching a visible owner host');
  const runner = input.runner ?? defaultRunner;
  const agentName = ownerAgentName(input.taskId, input.epoch);
  const label = truncateChars(input.title, 40);
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
  const run = (step: string, args: string[], timeout: number): RunnerResult => {
    let result: RunnerResult;
    try { result = runner({ file: herdrPath, args, timeout }); }
    catch (error) { throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `herdr ${step} failed: ${bounded(messageOf(error))}`); }
    const failure = envelopeFailure(result.stdout);
    if (result.code !== 0 || failure) {
      const detail = detailOf(result);
      throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `herdr ${step} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
    }
    return result;
  };
  const readJson = (step: string, result: RunnerResult): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `herdr ${step} returned unparseable JSON${result.stderr ? `: ${bounded(result.stderr)}` : ''}`);
    }
  };
  const create = readJson('workspace create', run('workspace create', ['--session', session, 'workspace', 'create', '--cwd', input.workspace, '--label', label, '--no-focus'], 30000));
  // Herdr 0.9.3 names what it created as result.workspace.workspace_id and result.root_pane.pane_id;
  // an opaque pane id is not a workspace id, so nothing else in this response can authorize a resource.
  const created = dig(create, ['result']);
  const workspaceId = asId(dig(created, ['workspace', 'workspace_id']));
  const paneId = asId(dig(created, ['root_pane', 'pane_id']));
  const closeWorkspace = (ownedWorkspaceId: string): string | null => {
    let closeResult: RunnerResult;
    try {
      closeResult = runner({ file: herdrPath, args: ['--session', session, 'workspace', 'close', ownedWorkspaceId], timeout: 15000 });
    } catch (error) {
      // A cleanup that blows up is reported inside the original failure, never instead of it.
      return `herdr workspace close cleanup also failed: ${bounded(messageOf(error), 300)}`;
    }
    if (closeResult.code === 0 && !envelopeFailure(closeResult.stdout)) return null;
    const detail = detailOf(closeResult, 300);
    return `herdr workspace close cleanup also failed (exit ${closeResult.code})${detail ? `: ${detail}` : ''}`;
  };
  if (!workspaceId) {
    // The created workspace is unnamed here, so this launch cannot claim or close any workspace.
    throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', 'herdr workspace create returned no workspace id');
  }
  if (!paneId) {
    // The workspace is known to exist, so it must not be left behind.
    const cleanup = closeWorkspace(workspaceId);
    const message = 'herdr workspace create returned no root pane id';
    throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', cleanup ? `${message}; ${cleanup}` : message);
  }
  const agentArgs = (): string[] => {
    if (kind === 'codex') return ['-m', input.model, '-c', `model_reasoning_effort="${input.effort}"`];
    const args = ['--model', input.model];
    const claudePath = input.claudePath ?? findExecutable('claude', input.pathEnv ?? process.env.PATH ?? '');
    if (claudePath) {
      try {
        const help = runner({ file: claudePath, args: ['--help'], timeout: 15000 });
        if (help.code === 0 && /--effort\b/.test(help.stdout)) args.push('--effort', input.effort);
      } catch { /* claude --help is best effort only */ }
    }
    return args;
  };
  try {
    run('agent start', ['--session', session, 'agent', 'start', agentName, '--kind', kind, '--pane', paneId, '--timeout', String(OWNER_AGENT_START_TIMEOUT_MS), '--', ...agentArgs()], 70000);
    run('agent prompt', ['--session', session, 'agent', 'prompt', agentName, input.prompt], 60000);
  } catch (error) {
    const failure = error instanceof OwnerLaunchError
      ? error
      : new OwnerLaunchError('OWNER_LAUNCH_FAILED', `herdr owner launch failed after workspace create: ${bounded(messageOf(error))}`);
    const cleanup = closeWorkspace(workspaceId);
    throw cleanup ? new OwnerLaunchError(failure.code, `${failure.message}; ${cleanup}`) : failure;
  }
  return { session, workspaceId, paneId, agentName };
}
