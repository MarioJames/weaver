import { reconnect, notifyError, notifyInfo, isTransientError } from './notify';
import { isFieldError } from '../policy/policy-edit';
import { API_VERSION, type CommandResponse } from '../../shared/contracts/commands';
import type { WeaverAPI } from '../../shared/contracts/api';
import type { EngineModelList, EngineModelListInput } from '../../shared/engines';
import type { EngineStallStatus, FreeChannelStatus, StallHistoryRecord, StallStatus } from '../../shared/contracts/monitoring';

/** The renderer reads a subset of the control plane's stall status; the wire shape is defined once in shared/contracts/monitoring. */
export type StallHistoryEntry = Pick<StallHistoryRecord, 'at' | 'level' | 'tasks' | 'stalledMinutes' | 'probe'>;
export type StallEngineState = Pick<EngineStallStatus, 'level' | 'lastTriggerAt' | 'needsAttention'> & { history: StallHistoryEntry[] };
export type StallSnapshot = Pick<StallStatus, 'config'> & { engines: Record<string, StallEngineState> };
/** What `window.weaver` exposes: the shared task/policy API plus the stall, free-probe and model-list reads the web control plane serves. */
export type RendererAPI = Omit<WeaverAPI, 'getStall'> & FreeProbeAPI & { getStall: () => Promise<StallSnapshot>; listEngineModels: (input: EngineModelListInput) => Promise<EngineModelList> };
/** Free-channel probing: `workerProbeStatus` reads, `workerProbe` runs one real greeting per named worker. */
export interface FreeProbeAPI {
  workerProbeStatus: () => Promise<FreeChannelStatus>;
  workerProbe: (input: { worker?: string }) => Promise<FreeChannelStatus>;
}

const RPC_PATH = '/api/rpc';
const POLL_GAP_MS = 1000;
/** Same bound as the local IPC transport deadline. It covers the fetch and the response body. */
export const RPC_DEADLINE_MS = 15_000;
/** A probe waits on a real model reply (up to 120 s per worker), so its call outlives the default deadline. */
const METHOD_DEADLINE_MS: Record<string, number> = { workerProbe: 130_000, listEngineModels: 40_000 };

type Rpc = (method: string, args: unknown[], signal?: AbortSignal) => Promise<unknown>;

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function controlError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

function timeoutError(): Error {
  return controlError('TIMEOUT', '控制面在 15 秒内没有响应');
}

interface Deadline {
  signal: AbortSignal;
  timedOut: () => boolean;
  cancel: () => void;
}

function linkDeadline(external: AbortSignal | undefined, ms: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError());
  }, ms);
  const onExternal = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternal, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancel() {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternal);
    },
  };
}

/** A stalled body does not observe the fetch signal, so the deadline has to race it. */
async function readPayload(response: Response, signal: AbortSignal): Promise<unknown> {
  let finished = false;
  return await new Promise((resolve, reject) => {
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : abortError());
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    response.json().then(value => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) fail(signal.reason instanceof Error ? signal.reason : abortError());
      else resolve(value);
    }, fail);
  });
}

/** One same-origin POST. A failed call is not retried here. */
async function rpc(method: string, args: unknown[], external?: AbortSignal, deadlineMs = RPC_DEADLINE_MS): Promise<unknown> {
  const deadline = linkDeadline(external, deadlineMs);
  try {
    let response: Response;
    try {
      response = await fetch(new URL(RPC_PATH, window.location.origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args }),
        signal: deadline.signal,
      });
    } catch (error) {
      if (external?.aborted) throw isAbort(error) ? error : abortError();
      if (deadline.timedOut()) throw timeoutError();
      if (isAbort(error)) throw error;
      const message = error instanceof Error && error.message ? error.message : '网络请求失败';
      throw controlError('NETWORK', message);
    }
    if (external?.aborted) throw abortError();
    if (deadline.timedOut()) throw timeoutError();
    let payload: unknown;
    try {
      payload = await readPayload(response, deadline.signal);
    } catch (error) {
      if (external?.aborted) throw isAbort(error) ? error : abortError();
      if (deadline.timedOut()) throw timeoutError();
      if (isAbort(error)) throw error;
      payload = undefined;
    }
    if (external?.aborted) throw abortError();
    if (deadline.timedOut()) throw timeoutError();
    if (!response.ok) {
      const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
      const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
      const code = typeof record.code === 'string' && record.code ? record.code : `HTTP_${response.status}`;
      const message = typeof record.message === 'string' && record.message ? record.message : `请求失败（${response.status}）`;
      throw Object.assign(controlError(code, message), { status: response.status });
    }
    if (!payload || typeof payload !== 'object' || !('result' in payload)) throw controlError('BAD_RESPONSE', '控制面响应缺少 result');
    return payload.result;
  } finally {
    deadline.cancel();
  }
}

function readRevision(result: unknown): { revision: number; changed: boolean } {
  if (!result || typeof result !== 'object') throw controlError('BAD_RESPONSE', 'sync.status 响应无效');
  const response = result as CommandResponse;
  if (!response.ok) throw controlError(response.error?.code ?? 'COMMAND_FAILED', response.error?.message ?? 'sync.status 失败');
  const data = response.data;
  const revision = data && typeof data === 'object' && 'revision' in data ? data.revision : undefined;
  if (typeof revision !== 'number' || !Number.isFinite(revision)) throw controlError('BAD_RESPONSE', 'sync.status 缺少 revision');
  const changed = data && typeof data === 'object' && 'changed' in data ? data.changed === true : false;
  return { revision, changed };
}

function watchTasks(call: Rpc): WeaverAPI['onTasksChanged'] {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision: number | undefined;
  let seq = 0;
  let active: AbortController | undefined;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const arm = (token: number) => {
    if (token !== seq || listeners.size === 0) return;
    timer = setTimeout(() => { timer = undefined; void poll(); }, POLL_GAP_MS);
  };
  const poll = async () => {
    if (listeners.size === 0) return;
    const token = ++seq;
    const controller = new AbortController();
    active = controller;
    const known = revision;
    try {
      const result = await call('command', [{ apiVersion: API_VERSION, command: 'sync.status', args: known === undefined ? {} : { after: known } }], controller.signal);
      if (token !== seq || controller.signal.aborted || listeners.size === 0) return;
      const next = readRevision(result);
      revision = next.revision;
      // The first revision is itself news: listTasks may already hold an older snapshot.
      if (next.revision !== known || next.changed) notify();
    } catch (error) {
      if (token !== seq || controller.signal.aborted || isAbort(error) || listeners.size === 0) return;
      notifyError(error, '状态读取失败');
      notify();
    } finally {
      if (active === controller) active = undefined;
      if (token === seq && !controller.signal.aborted) arm(token);
    }
  };

  return callback => {
    listeners.add(callback);
    if (listeners.size === 1 && !active && timer === undefined) void poll();
    return () => {
      listeners.delete(callback);
      if (listeners.size > 0) return;
      seq += 1;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      active?.abort();
      active = undefined;
    };
  };
}

export function createBrowserClient(): RendererAPI {
  const reads = new Set(['getPolicy','getQuota','getStall','listTasks','getTask','capabilities','validatePolicy','previewRoute','sayHiResult','workerProbeStatus','listEngineModels']);
  const commandReads = new Set(['sync.status','tasks.list','tasks.get','tasks.events','tasks.results','owners.list','owners.continuation.get']);
  const checked = async (method: string, args: unknown[], signal?: AbortSignal) => {
    const result = await rpc(method,args,signal,METHOD_DEADLINE_MS[method]);
    if (method === 'command' && result && typeof result === 'object' && 'ok' in result && !result.ok) {
      const failure = (result as CommandResponse).error;
      if (isTransientError(failure)) throw controlError(failure?.code ?? 'NETWORK',failure?.message ?? '控制面不可用');
    }
    return result;
  };
  const inflight = new Map<string,Promise<unknown>>();
  const invoke: Rpc = async (method,args,signal) => {
    const request = args[0] as { command?: string; commandId?: string } | undefined;
    const read = reads.has(method) || (method === 'command' && !request?.commandId && commandReads.has(request?.command ?? ''));
    try { return await checked(method,args,signal); }
    catch(error) {
      if (signal?.aborted) throw error;
      // A refused setting names its own field: the page says it under that field, so a floating notice would only repeat it.
      if (!isTransientError(error)) { if (!(method === 'savePolicy' && isFieldError(error))) notifyError(error); throw error; }
      if(read) return reconnect.recover(()=>checked(method,args,signal),signal).catch(cause=>{notifyError(cause);throw cause;});
      notifyInfo('操作结果未确认，正在核对…', 'operation-reconcile', 0);
      // A fresh authoritative read reconciles the UI, but cannot prove which writer changed it.
      void call('getPolicy',[]).then(()=>{
        for(const listener of invalidations) listener();
        notifyInfo('连接已恢复，正在刷新状态，请核对操作是否生效。未自动重复操作。', 'operation-reconcile');
      }).catch(cause=>{notifyInfo('无法核对操作结果，请检查当前状态。', 'operation-reconcile');notifyError(cause,'状态核对失败');});
      throw error;
    }
  };
  const call: Rpc = (method,args,signal) => {
    const request=args[0] as {command?:string;commandId?:string}|undefined;
    const read=reads.has(method)||(method==='command'&&!request?.commandId&&commandReads.has(request?.command??''));
    if(!read||signal)return invoke(method,args,signal);
    const key=JSON.stringify([method,args]);
    const pending=inflight.get(key);if(pending)return pending;
    const next=invoke(method,args).finally(()=>{inflight.delete(key);});inflight.set(key,next);return next;
  };
  const invalidations = new Set<() => void>();
  const watch = watchTasks(call);
  return {
    command: request => call('command', [request]) as ReturnType<WeaverAPI['command']>,
    getPolicy: () => call('getPolicy', []) as ReturnType<WeaverAPI['getPolicy']>,
    getQuota: () => call('getQuota', []) as ReturnType<WeaverAPI['getQuota']>,
    refreshQuota: input => call('refreshQuota', [input]) as ReturnType<WeaverAPI['refreshQuota']>,
    getStall: () => call('getStall', []) as ReturnType<RendererAPI['getStall']>,
    workerProbeStatus: () => call('workerProbeStatus', []) as ReturnType<RendererAPI['workerProbeStatus']>,
    workerProbe: input => call('workerProbe', [input]) as ReturnType<RendererAPI['workerProbe']>,
    validatePolicy: config => call('validatePolicy', [config]) as ReturnType<WeaverAPI['validatePolicy']>,
    savePolicy: input => call('savePolicy', [input]) as ReturnType<WeaverAPI['savePolicy']>,
    previewRoute: input => call('previewRoute', [input]) as ReturnType<WeaverAPI['previewRoute']>,
    scanEngines: () => call('scanEngines', []) as ReturnType<WeaverAPI['scanEngines']>,
    listEngineModels: input => call('listEngineModels', [input]) as ReturnType<RendererAPI['listEngineModels']>,
    sayHi: input => call('sayHi', [input]) as ReturnType<WeaverAPI['sayHi']>,
    sayHiResult: id => call('sayHiResult', [id]) as ReturnType<WeaverAPI['sayHiResult']>,
    setEngineEnabled: input => call('setEngineEnabled', [input]) as ReturnType<WeaverAPI['setEngineEnabled']>,
    listTasks: () => call('listTasks', []) as ReturnType<WeaverAPI['listTasks']>,
    getTask: id => call('getTask', [id]) as ReturnType<WeaverAPI['getTask']>,
    createTask: input => call('createTask', [input]) as ReturnType<WeaverAPI['createTask']>,
    startTask: id => call('startTask', [id]) as ReturnType<WeaverAPI['startTask']>,
    cancelTask: id => call('cancelTask', [id]) as ReturnType<WeaverAPI['cancelTask']>,
    capabilities: () => call('capabilities', []) as ReturnType<WeaverAPI['capabilities']>,
    onTasksChanged: callback => { invalidations.add(callback); const unsubscribe=watch(callback); return ()=>{invalidations.delete(callback);unsubscribe();}; },
  };
}

export function installBrowserClient(): RendererAPI {
  const client = createBrowserClient();
  window.weaver = client;
  return client;
}
