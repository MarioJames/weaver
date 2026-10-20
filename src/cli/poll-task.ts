import { failure, LocalIPCError } from '../main/local-ipc';
import { sendRequest } from './client';
import { makeRequest } from './input';
import { writeEnvelope } from './output';
import type { CLIOptions } from './parse';

/** The omitted --for deadline: min(600, herdr.max_wait_minutes×60) from the policy, or 30 when it cannot be read. */
export async function defaultForSeconds(dataDir: string): Promise<number> {
  try {
    const policy = await sendRequest(dataDir, { method: 'getPolicy', args: [] }, 2000) as { ok?: boolean; data?: { config?: { herdr?: { max_wait_minutes?: unknown } } } };
    const minutes = policy.data?.config?.herdr?.max_wait_minutes;
    if (policy.ok === true && typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) return Math.min(600, minutes * 60);
  } catch { /* keep the fallback below */ }
  return 30;
}
export interface PollRuntime {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  request: typeof sendRequest;
}

export async function pollTask(options: CLIOptions, mode: 'wait' | 'watch', runtime: Partial<PollRuntime> = {}): Promise<number> {
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const send = runtime.request ?? sendRequest;
  const deadline = now() + (options.forSeconds ?? await defaultForSeconds(options.dataDir)) * 1000;
  const request = (command:string,args:Record<string,unknown>) => send(options.dataDir, makeRequest({...options,command},args), deadline-now());
  let after: string | undefined;
  let snapshot: { ok: boolean; data?: { status?: string; [key: string]: unknown } } | undefined;
  let health: Record<string, unknown> | undefined;
  let healthSupported = true;
  let nextHealthAt = 0;
  let wasStalled = false;
  const hint = `weaver tasks retry --task-id ${options.taskId} --cancel or weaver tasks cancel --task-id ${options.taskId}`;
  const finish = (reason: 'terminal' | 'timeout' | 'stalled') => {
    const data = { ...snapshot?.data, reason, ...(reason === 'stalled' ? { health, hint } : {}) };
    writeEnvelope(options.output, reason === 'timeout'
      ? { ...failure('TIMEOUT', 'Stopped polling before the task reached a terminal state'), data }
      : { ...snapshot, data });
    return reason === 'timeout' ? 1 : 0;
  };
  try {
    for (;;) {
      snapshot = await request('tasks.get', {}) as NonNullable<typeof snapshot>;
      if (!snapshot.ok) { writeEnvelope(options.output, snapshot); return 1; }
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
      if (['completed','failed','cancelled'].includes(snapshot.data?.status ?? '')) {
        return finish('terminal');
      }
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
          if (stalled && mode === 'wait') return finish('stalled');
          if (stalled && !wasStalled && options.output !== 'json') {
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
    if (snapshot?.ok && error instanceof LocalIPCError && error.code === 'TIMEOUT') return finish('timeout');
    throw error;
  }
}
