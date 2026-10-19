import { API_VERSION, type CommandResponse } from '../shared/commands';
import type { Task, TaskInput, WeaverAPI } from '../shared/types';

const RPC_PATH = '/api/rpc';
const POLL_GAP_MS = 1000;
const MAX_HANDOFF_BYTES = 65536;
/** Same bound as the local IPC transport deadline. It covers the fetch and the response body. */
export const RPC_DEADLINE_MS = 15_000;

type Rpc = (method: string, args: unknown[], signal?: AbortSignal) => Promise<unknown>;

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function controlError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
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
      throw controlError(code, message);
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

function importHandoff(create: (input: TaskInput) => Promise<Task>): Promise<Task | null> {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'application/json,.json';
  picker.multiple = false;
  picker.style.display = 'none';
  let settled = false;
  const promise = new Promise<Task | null>((resolve, reject) => {
    const finish = (value: Task | null) => {
      if (settled) return;
      settled = true;
      picker.remove();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      picker.remove();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    picker.addEventListener('cancel', () => finish(null));
    picker.addEventListener('change', () => {
      if (settled) return;
      const file = picker.files?.item(0);
      if (!file) { finish(null); return; }
      if (file.size > MAX_HANDOFF_BYTES) { fail(new Error('任务交接必须是不超过 64 KiB 的 JSON 文件')); return; }
      void file.text().then(raw => {
        if (settled) return;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { fail(new Error('任务交接不是有效 JSON')); return; }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { fail(new Error('任务交接必须是 JSON 对象')); return; }
        void create(parsed as TaskInput).then(task => finish(task), fail);
      }, fail);
    });
  });
  document.body.append(picker);
  picker.click();
  return promise;
}

export function createBrowserClient(): WeaverAPI {
  const call = rpc;
  return {
    command: request => call('command', [request]) as ReturnType<WeaverAPI['command']>,
    getPolicy: () => call('getPolicy', []) as ReturnType<WeaverAPI['getPolicy']>,
    getQuota: () => call('getQuota', []) as ReturnType<WeaverAPI['getQuota']>,
    refreshQuota: input => call('refreshQuota', [input]) as ReturnType<WeaverAPI['refreshQuota']>,
    validatePolicy: config => call('validatePolicy', [config]) as ReturnType<WeaverAPI['validatePolicy']>,
    savePolicy: input => call('savePolicy', [input]) as ReturnType<WeaverAPI['savePolicy']>,
    previewRoute: input => call('previewRoute', [input]) as ReturnType<WeaverAPI['previewRoute']>,
    scanEngines: () => call('scanEngines', []) as ReturnType<WeaverAPI['scanEngines']>,
    setEngineEnabled: input => call('setEngineEnabled', [input]) as ReturnType<WeaverAPI['setEngineEnabled']>,
    listTasks: () => call('listTasks', []) as ReturnType<WeaverAPI['listTasks']>,
    createTask: input => call('createTask', [input]) as ReturnType<WeaverAPI['createTask']>,
    startTask: id => call('startTask', [id]) as ReturnType<WeaverAPI['startTask']>,
    cancelTask: id => call('cancelTask', [id]) as ReturnType<WeaverAPI['cancelTask']>,
    capabilities: () => call('capabilities', []) as ReturnType<WeaverAPI['capabilities']>,
    importTask: () => importHandoff(input => call('createTask', [input]) as Promise<Task>),
    onTasksChanged: watchTasks(call),
  };
}

export function installBrowserClient(): WeaverAPI {
  const client = createBrowserClient();
  window.weaver = client;
  return client;
}
