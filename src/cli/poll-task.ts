import { failure, LocalIPCError } from '../main/local-ipc';
import { sendRequest } from './client';
import { makeRequest } from './input';
import { writeEnvelope } from './output';
import type { OwnerAuth } from './owner-identity';
import type { CLIOptions } from './parse';
import { isReconnectCode, reconnectPolicy, sendReadRequest } from './reconnect';

/** The omitted --for deadline: herdr.max_wait_minutes×60 from the policy, or 30 when it cannot be read. */
export async function defaultForSeconds(dataDir: string): Promise<number> {
  try {
    const policy = await sendRequest(dataDir, { method: 'getPolicy', args: [] }, 2000) as { ok?: boolean; data?: { config?: { herdr?: { max_wait_minutes?: unknown } } } };
    const minutes = policy.data?.config?.herdr?.max_wait_minutes;
    if (policy.ok === true && typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) return minutes * 60;
  } catch { /* keep the fallback below */ }
  return 30;
}
export interface PollRuntime {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  request: typeof sendRequest;
  stderr: (text: string) => void;
}
interface TaskSnapshot { status?: string; [key: string]: unknown }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const businessTerminal = (status: unknown): status is 'completed' | 'failed' | 'cancelled' => ['completed', 'failed', 'cancelled'].includes(status as string);

/**
 * New file-lifecycle runs commit the business result before the run is finalized. Until
 * `run.finalizedAt` is also committed the task is still stopping, so wait/watch keep polling.
 * Historical, native and mock runs do not carry `run.launchPermittedAt` and keep their old meaning.
 */
export function terminalSnapshot(data: TaskSnapshot | undefined): boolean {
  if (!data || !businessTerminal(data.status)) return false;
  const run = record(data.run) ? data.run : undefined;
  if (!run || run.launchPermittedAt === undefined || run.launchPermittedAt === null) return true;
  return run.finalizedAt !== undefined && run.finalizedAt !== null;
}

/** A running native task is the owner's own subagent call: tasks.get returns that exact instruction. */
function handoffSnapshot(data: TaskSnapshot | undefined): Record<string, unknown> | undefined {
  if (data?.status !== 'running' || !record(data.dispatch) || data.dispatch.execution !== 'native') return undefined;
  return record(data.next) && data.next.action === 'run_subagent' ? data.next : undefined;
}

/** One progress line per state change; it explains why a business-terminal task still waits. */
function finalizationNotice(taskId: string | undefined, data: TaskSnapshot): string {
  const run = record(data.run) ? data.run : {};
  if (run.recovery !== undefined && run.recovery !== null) {
    const recovery = typeof run.recovery === 'string' ? run.recovery : JSON.stringify(run.recovery);
    return `[weaver] task ${taskId ?? 'unknown'}: recovery pending (${recovery})`;
  }
  const action = data.status === 'failed' || data.status === 'cancelled' ? 'stopping' : 'finalizing';
  return `[weaver] task ${taskId ?? 'unknown'}: ${data.status} decision committed, ${action} until run.finalizedAt is committed`;
}

export async function pollTask(options: CLIOptions, mode: 'wait' | 'watch', runtime: Partial<PollRuntime> = {}, ownerAuth?: OwnerAuth): Promise<number> {
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const send = runtime.request ?? sendRequest;
  const stderr = runtime.stderr ?? ((text: string) => { process.stderr.write(text + '\n'); });
  const policy = reconnectPolicy(options);
  const deadline = now() + (options.forSeconds ?? await defaultForSeconds(options.dataDir)) * 1000;
  const request = async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    const payload = makeRequest({ ...options, command }, args, ownerAuth);
    return await sendReadRequest(options.dataDir, payload, {
      policy,
      timeoutMs: Math.max(1, deadline - now()),
      runtime: { now, sleep, report: text => stderr(text), deadline },
      request: send,
    });
  };
  let after: string | undefined;
  let snapshot: { ok: boolean; data?: TaskSnapshot; error?: { code?: string; message?: string }; [key: string]: unknown } | undefined;
  let health: Record<string, unknown> | undefined;
  let healthSupported = true;
  let nextHealthAt = 0;
  let wasStalled = false;
  let lastNotice: string | undefined;
  const hint = `weaver tasks retry --task-id ${options.taskId} --cancel or weaver tasks cancel --task-id ${options.taskId}`;
  const finish = (reason: 'terminal' | 'timeout' | 'stalled' | 'handoff') => {
    const data: Record<string, unknown> = { ...snapshot?.data, reason };
    if (reason === 'stalled') Object.assign(data, { health, hint });
    if (reason === 'handoff') {
      const run = record(snapshot?.data?.run) ? snapshot!.data!.run as Record<string, unknown> : undefined;
      Object.assign(data, { taskId: options.taskId, attemptId: run?.id ?? null });
    }
    writeEnvelope(options.output, reason === 'timeout'
      ? { ...failure('TIMEOUT', 'Stopped polling before the task reached a terminal state'), data }
      : { ...snapshot, data });
    return reason === 'timeout' ? 1 : 0;
  };
  try {
    for (;;) {
      snapshot = await request('tasks.get', {}) as NonNullable<typeof snapshot>;
      if (!snapshot.ok) { writeEnvelope(options.output, snapshot); return 1; }
      const current = snapshot.data ?? {};
      if (mode === 'wait' && handoffSnapshot(current)) return finish('handoff');
      if (mode === 'watch') {
        let more: boolean;
        do {
          const events = await request('tasks.events', {limit:100,...(after?{after}:{})}) as {ok:boolean;data?:{events?:{id?:string;kind?:string;message?:string}[];nextCursor?:string|null;hasMore?:boolean}};
          if (!events.ok) { writeEnvelope(options.output, events); return 1; }
          for (const item of events.data?.events ?? []) {
            if (options.output === 'jsonl') writeEnvelope('jsonl', {apiVersion:'weaver.v1',commandId:null,ok:true,data:item});
            else if (options.output === 'text') process.stdout.write(`${item.kind ?? 'event'}: ${item.message ?? ''}\n`);
          }
          more = events.data?.hasMore === true;
          const next = events.data?.nextCursor ?? events.data?.events?.at(-1)?.id;
          if(more && (!next || next===after)) throw new LocalIPCError('INVALID_RESPONSE','Event pagination did not advance');
          if(next) after=next;
        } while(more);
      }
      if (terminalSnapshot(current)) return finish('terminal');
      const awaitingFinalization = businessTerminal(current.status);
      if (awaitingFinalization) {
        const notice = finalizationNotice(options.taskId, current);
        if (notice !== lastNotice) { stderr(notice); lastNotice = notice; }
      } else lastNotice = undefined;
      // Reserve the last polling interval for a final health read inside the same deadline.
      const finalInterval = deadline - now() <= 250;
      if (healthSupported && (now() >= nextHealthAt || finalInterval)) {
        nextHealthAt = now() + 30_000;
        const response = await request('tasks.health', {}) as { ok: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } };
        if (!response.ok) {
          const code = response.error?.code;
          if (code === 'COMMAND_UNKNOWN' ||
            (code === 'INVALID_REQUEST' && /^unknown method\b/i.test(response.error?.message ?? ''))) healthSupported = false;
          else { writeEnvelope(options.output, response); return 1; }
        } else {
          health = response.data;
          const stalled = health?.state === 'stalled';
          if (stalled && mode === 'wait' && !awaitingFinalization) return finish('stalled');
          if (stalled && !wasStalled && options.output !== 'json' && !awaitingFinalization) {
            writeEnvelope(options.output, { apiVersion: 'weaver.v1', ok: true, data: { ...snapshot.data, reason: 'stalled', health, hint } });
          }
          wasStalled = stalled;
        }
      }
      const remaining=deadline-now();
      if(remaining<=0)return finish('timeout');
      await sleep(Math.min(250,remaining));
      if(finalInterval || now() >= deadline)return finish('timeout');
    }
  } catch (error) {
    if (error instanceof LocalIPCError && snapshot?.ok) {
      if (error.code === 'TIMEOUT') return finish('timeout');
      if (isReconnectCode(error.code)) {
        writeEnvelope(options.output, { ...failure(error.code, error.message), data: snapshot.data });
        return 1;
      }
    }
    throw error;
  }
}
