import { LocalIPCError, readDiscovery } from '../main/local-ipc';
import { sendRequest } from './client';

/** The four unavailability answers that let a read-only command wait for the service to come back. */
export const RECONNECT_CODES = ['APP_NOT_RUNNING', 'TRANSPORT_ERROR', 'APP_DRAINING', 'APP_STARTING'] as const;
const reconnectable = new Set<string>(RECONNECT_CODES);
export function isReconnectCode(code: string): boolean { return reconnectable.has(code); }

/** Commands whose only effect is reading, so replaying one after a transport failure is safe. */
export const RECONNECT_CLI_COMMANDS = ['tasks.get', 'tasks.wait', 'tasks.watch', 'tasks.events', 'tasks.health'] as const;
export function isReconnectCommand(command: string): boolean {
  return (RECONNECT_CLI_COMMANDS as readonly string[]).includes(command);
}

export const DEFAULT_RECONNECT_GRACE_S = 60;
export const DEFAULT_RECONNECT_MAX_INTERVAL_S = 5;
export const INITIAL_RECONNECT_DELAY_MS = 250;

export interface ReconnectPolicy { graceMs: number; maxIntervalMs: number }
export interface ReconnectRuntime {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  /** Progress goes to stderr: stdout must keep carrying nothing but the response envelope. */
  report?: (text: string) => void;
  /** The original wait deadline, if the caller has one. */
  deadline?: number;
  /** The caller's own per-request timeout (transport allowance), if it has one. */
  attemptTimeoutMs?: number;
}
export interface ReconnectAttempt { response: unknown; instanceId?: string }
export interface ReconnectSource {
  attempt: (timeoutMs: number) => Promise<ReconnectAttempt>;
  /** The discovery instance id now on disk, used only to recognize an explicit IPC instance rotation. */
  currentInstance?: () => Promise<string | undefined>;
}

/** Explicit flags win over the environment, which wins over the documented default. */
export function reconnectPolicy(options: { reconnectGraceSeconds?: number; reconnectMaxIntervalSeconds?: number }): ReconnectPolicy {
  const fromEnvironment = Number(process.env.WEAVER_CLI_RECONNECT_GRACE_S);
  const environmentGrace = process.env.WEAVER_CLI_RECONNECT_GRACE_S !== undefined && /^\d+$/.test(process.env.WEAVER_CLI_RECONNECT_GRACE_S) && Number.isSafeInteger(fromEnvironment)
    ? fromEnvironment
    : undefined;
  return {
    graceMs: (options.reconnectGraceSeconds ?? environmentGrace ?? DEFAULT_RECONNECT_GRACE_S) * 1000,
    maxIntervalMs: (options.reconnectMaxIntervalSeconds ?? DEFAULT_RECONNECT_MAX_INTERVAL_S) * 1000,
  };
}

function envelopeFailure(response: unknown): { code: string; message: string } | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const value = response as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
  if (value.ok !== false || typeof value.error?.code !== 'string') return undefined;
  return { code: value.error.code, message: typeof value.error.message === 'string' ? value.error.message : 'Command failed' };
}

function attemptTimeout(runtime: ReconnectRuntime, at: number, unavailableSince: number | undefined, policy: ReconnectPolicy): number {
  let timeout = runtime.attemptTimeoutMs ?? Number.POSITIVE_INFINITY;
  if (runtime.deadline !== undefined) timeout = Math.min(timeout, runtime.deadline - at);
  if (unavailableSince !== undefined) timeout = Math.min(timeout, policy.graceMs - (at - unavailableSince));
  return Math.max(1, timeout);
}

/**
 * Replays a read-only request while the service answers with an unavailability error or the
 * transport breaks. The grace budget starts at the first consecutive failure and is never
 * reset by an instance rotation; only a completed exchange resets it. An explicit discovery
 * instance change earns one fresh authentication attempt, while a repeated UNAUTHORIZED fails.
 */
export async function withReconnect(source: ReconnectSource, policy: ReconnectPolicy, runtime: ReconnectRuntime): Promise<unknown> {
  const now = runtime.now;
  const report = runtime.report ?? (() => {});
  let unavailableSince: number | undefined;
  let last = { code: 'APP_NOT_RUNNING', message: 'Weaver is not running; run weaver server start' };
  let delay = INITIAL_RECONNECT_DELAY_MS;
  let authRetried = false;

  const backoff = async (code: string, message: string): Promise<void> => {
    last = { code, message };
    const at = now();
    if (unavailableSince === undefined) unavailableSince = at;
    const elapsed = at - unavailableSince;
    if (policy.graceMs <= 0 || elapsed >= policy.graceMs) throw new LocalIPCError(code, message);
    if (runtime.deadline !== undefined && at >= runtime.deadline) throw new LocalIPCError('TIMEOUT', 'Bounded wait deadline reached');
    const graceLeft = policy.graceMs - elapsed;
    const deadlineLeft = runtime.deadline === undefined ? Number.POSITIVE_INFINITY : runtime.deadline - at;
    const waitFor = Math.max(0, Math.min(delay, graceLeft, deadlineLeft));
    report(`[weaver] 服务重启中，等待重连…(${Math.floor(elapsed / 1000)}s/${Math.floor(policy.graceMs / 1000)}s)`);
    delay = Math.min(policy.maxIntervalMs, delay * 2);
    if (waitFor > 0) await runtime.sleep(waitFor);
  };

  for (;;) {
    const at = now();
    if (unavailableSince !== undefined) {
      if (runtime.deadline !== undefined && at >= runtime.deadline) throw new LocalIPCError('TIMEOUT', 'Bounded wait deadline reached');
      if (at - unavailableSince >= policy.graceMs) throw new LocalIPCError(last.code, last.message);
    }
    let attempt: ReconnectAttempt;
    try {
      attempt = await source.attempt(attemptTimeout(runtime, at, unavailableSince, policy));
    } catch (error) {
      if (!(error instanceof LocalIPCError) || !reconnectable.has(error.code)) throw error;
      authRetried = false;
      await backoff(error.code, error.message);
      continue;
    }
    const failure = envelopeFailure(attempt.response);
    if (failure && reconnectable.has(failure.code)) {
      authRetried = false;
      await backoff(failure.code, failure.message);
      continue;
    }
    if (failure?.code === 'UNAUTHORIZED') {
      // Only a changed discovery instance explains a stale token. One retry, then fail.
      if (!authRetried && attempt.instanceId !== undefined && source.currentInstance) {
        const current = await source.currentInstance().catch(() => undefined);
        if (current !== undefined && current !== attempt.instanceId) {
          authRetried = true;
          continue;
        }
      }
      throw new LocalIPCError(failure.code, failure.message);
    }
    return attempt.response;
  }
}

export interface ReadRequestOptions {
  policy: ReconnectPolicy;
  runtime: ReconnectRuntime;
  timeoutMs?: number;
  /** Tests may replace the transport; the default is the real authenticated Unix socket. */
  request?: typeof sendRequest;
}

/** One read-only request with restart tolerance, preserving the exact request and ownerAuth. */
export async function sendReadRequest(dataDir: string, request: unknown, options: ReadRequestOptions): Promise<unknown> {
  const send = options.request ?? sendRequest;
  let usedInstance: string | undefined;
  return await withReconnect({
    attempt: async timeoutMs => {
      usedInstance = undefined;
      const response = await send(dataDir, request, timeoutMs, { onEndpoint: instanceId => { usedInstance = instanceId; } });
      return { response, instanceId: usedInstance };
    },
    currentInstance: async () => {
      try { return (await readDiscovery(dataDir)).discovery.instanceId; }
      catch { return undefined; }
    },
  }, options.policy, { ...options.runtime, attemptTimeoutMs: options.timeoutMs });
}
