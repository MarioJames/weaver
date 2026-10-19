import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandRequest } from '../src/shared/commands';
import { command } from '../src/renderer/commands';
import { RPC_DEADLINE_MS, createBrowserClient, installBrowserClient } from '../src/renderer/client';

const ORIGIN = 'http://127.0.0.1:4173';

interface Call {
  url: string;
  init: RequestInit;
  body: { method: string; args: unknown[] };
  resolve: (value: Response) => void;
  reject: (error: unknown) => void;
}

function installOrigin() {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: ORIGIN } } });
}

function installFetch() {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; args: unknown[] };
    return await new Promise<Response>((resolve, reject) => {
      const call: Call = { url: String(input), init: init ?? {}, body, resolve, reject };
      calls.push(call);
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      }, { once: true });
    });
  }) as typeof fetch;
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function cleanup() {
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
}

test('rpc posts the exact method and arity and returns result once', async () => {
  installOrigin();
  const gate = installFetch();
  try {
    const client = createBrowserClient();
    const pending = Promise.all([
      client.getPolicy(),
      client.scanEngines(),
      client.listTasks(),
      client.capabilities(),
      client.validatePolicy({ version: 1 }),
      client.savePolicy({ revision: 2, config: { version: 1 }, blocks: [] } as never),
      client.previewRoute({ owner: 'claude_owner', runningCount: 0 }),
      client.setEngineEnabled({ id: 'claude', enabled: true, revision: 2 }),
      client.createTask({ title: '交接', instruction: '做', owner: { name: 'o', transport: 'herdr-visible', session: 's', pane: 'p' } }),
      client.startTask('task-1'),
      client.cancelTask('task-1'),
      client.command({ apiVersion: 'weaver.v1', command: 'tasks.results', args: { taskId: 'task-1' } }),
    ]);
    assert.deepEqual(gate.calls.map(call => call.body), [
      { method: 'getPolicy', args: [] },
      { method: 'scanEngines', args: [] },
      { method: 'listTasks', args: [] },
      { method: 'capabilities', args: [] },
      { method: 'validatePolicy', args: [{ version: 1 }] },
      { method: 'savePolicy', args: [{ revision: 2, config: { version: 1 }, blocks: [] }] },
      { method: 'previewRoute', args: [{ owner: 'claude_owner', runningCount: 0 }] },
      { method: 'setEngineEnabled', args: [{ id: 'claude', enabled: true, revision: 2 }] },
      { method: 'createTask', args: [{ title: '交接', instruction: '做', owner: { name: 'o', transport: 'herdr-visible', session: 's', pane: 'p' } }] },
      { method: 'startTask', args: ['task-1'] },
      { method: 'cancelTask', args: ['task-1'] },
      { method: 'command', args: [{ apiVersion: 'weaver.v1', command: 'tasks.results', args: { taskId: 'task-1' } }] },
    ]);
    for (const call of gate.calls) {
      assert.equal(call.url, `${ORIGIN}/api/rpc`);
      assert.equal(call.init.method, 'POST');
      const headers = new Headers(call.init.headers);
      assert.equal(headers.get('content-type'), 'application/json');
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('cookie'), null);
      call.resolve(jsonResponse({ result: { echoed: call.body.method } }));
    }
    const results = await pending;
    assert.equal(gate.calls.length, 12);
    assert.deepEqual(results[3], { echoed: 'capabilities' });
    assert.deepEqual(results[11], { echoed: 'command' });
  } finally {
    gate.restore();
    cleanup();
  }
});

test('non-transient HTTP and malformed responses fail once; network reads reconnect', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  installOrigin();
  const gate = installFetch();
  try {
    const client = createBrowserClient();
    const conflict = client.savePolicy({ revision: 1, config: {}, blocks: [] } as never);
    gate.calls[0].resolve(jsonResponse({ error: { code: 'REVISION_CONFLICT', message: 'Settings changed; reload before saving' } }, 409));
    await assert.rejects(conflict, /REVISION_CONFLICT: Settings changed; reload before saving/);

    const missing = client.listTasks();
    gate.calls[1].resolve(jsonResponse({ error: { code: 'NOPE', message: 'no' } }, 200));
    await assert.rejects(missing, /BAD_RESPONSE: 控制面响应缺少 result/);

    const bare = client.capabilities();
    gate.calls[2].resolve(jsonResponse('nope', 500));
    await assert.rejects(bare, /HTTP_500: 请求失败（500）/);

    const pending = client.getPolicy();
    gate.calls[3].reject(new TypeError('Failed to fetch')); await flush();
    t.mock.timers.tick(999); assert.equal(gate.calls.length,4);
    t.mock.timers.tick(1); await flush();
    gate.calls[4].resolve(jsonResponse({result:{revision:7}}));
    assert.deepEqual(await pending,{revision:7});
    t.mock.timers.tick(2000);
  } finally {
    gate.restore();
    cleanup();
  }
});

test('quota cache reads and explicit refreshes keep distinct RPC methods without implicit retries', async () => {
  installOrigin();
  const gate = installFetch();
  try {
    const client = createBrowserClient();
    assert.equal(gate.calls.length, 0);
    const cached = client.getQuota();
    assert.deepEqual(gate.calls[0].body, { method: 'getQuota', args: [] });
    gate.calls[0].resolve(jsonResponse({ result: { records: [] } }));
    assert.deepEqual(await cached, { records: [] });
    await flush();
    assert.equal(gate.calls.length, 1);

    const all = client.refreshQuota({});
    assert.deepEqual(gate.calls[1].body, { method: 'refreshQuota', args: [{}] });
    gate.calls[1].resolve(jsonResponse({ result: { records: [], policyChanged: false, snapshot: { revision: 4 } } }));
    assert.deepEqual(await all, { records: [], policyChanged: false, snapshot: { revision: 4 } });

    const one = client.refreshQuota({ engine: 'grok' });
    assert.deepEqual(gate.calls[2].body, { method: 'refreshQuota', args: [{ engine: 'grok' }] });
    gate.calls[2].resolve(jsonResponse({ error: { code: 'RATE_LIMITED', message: '冷却中' } }, 429));
    await assert.rejects(one, /RATE_LIMITED: 冷却中/);
    await flush();
    assert.equal(gate.calls.length, 3);
  } finally {
    gate.restore();
    cleanup();
  }
});

test('command helper keeps ok:false and commandId on the real client', async () => {
  installOrigin();
  const gate = installFetch();
  try {
    installBrowserClient();
    const ok = command('tasks.results', { taskId: 't' });
    const seen = gate.calls[0].body.args[0] as CommandRequest;
    assert.equal(seen.commandId, undefined);
    gate.calls[0].resolve(jsonResponse({ result: { apiVersion: 'weaver.v1', ok: true, data: { saved: true } } }));
    assert.deepEqual(await ok, { saved: true });

    const rejected = command('reviews.submit', { taskId: 't' }, true);
    const mutate = gate.calls[1].body.args[0] as CommandRequest;
    assert.equal(mutate.command, 'reviews.submit');
    assert.match(mutate.commandId ?? '', /^[0-9a-f-]{36}$/);
    gate.calls[1].resolve(jsonResponse({ result: { apiVersion: 'weaver.v1', ok: false, error: { code: 'REVISION_CONFLICT', message: 'Settings changed; reload before saving', retryable: true } } }));
    await assert.rejects(rejected, /REVISION_CONFLICT: Settings changed; reload before saving/);
    assert.equal(gate.calls.length, 2);
  } finally {
    gate.restore();
    cleanup();
  }
});

interface Picker {
  accept: string;
  clicked: boolean;
  parent: boolean;
  file?: { size: number; text: () => Promise<string> };
  fire: (type: string) => void;
}

function installPicker(): { current: () => Picker } {
  let picker: Picker | undefined;
  const document = {
    body: { append(node: Picker) { node.parent = true; } },
    createElement() {
      const listeners = new Map<string, Array<() => void>>();
      const input = {
        type: '',
        accept: '',
        multiple: false,
        style: { display: '' },
        file: undefined as Picker['file'],
        clicked: false,
        parent: false,
        files: { item: (index: number) => index === 0 ? input.file ?? null : null },
        addEventListener(type: string, fn: () => void) {
          listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        },
        remove() { input.parent = false; },
        click() { input.clicked = true; },
        fire(type: string) { for (const fn of listeners.get(type) ?? []) fn(); },
      };
      picker = input;
      return input;
    },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  return { current: () => { if (!picker) throw new Error('picker was not created'); return picker; } };
}

test('file import sends one createTask and cancel or invalid files do not', async () => {
  installOrigin();
  const gate = installFetch();
  const picker = installPicker();
  try {
    const client = createBrowserClient();
    const cancelled = client.importTask();
    const input = picker.current();
    assert.equal(input.accept, 'application/json,.json');
    assert.equal(input.clicked, true);
    input.fire('cancel');
    assert.equal(await cancelled, null);
    input.file = { size: 2, text: async () => '{"title":"late"}' };
    input.fire('change');
    await flush();
    assert.equal(gate.calls.length, 0);
    assert.equal(input.parent, false);

    const empty = client.importTask();
    picker.current().fire('change');
    assert.equal(await empty, null);

    const huge = client.importTask();
    picker.current().file = { size: 65537, text: async () => { throw new Error('should not read'); } };
    picker.current().fire('change');
    await assert.rejects(huge, /64 KiB/);

    const broken = client.importTask();
    picker.current().file = { size: 1, text: async () => '{' };
    picker.current().fire('change');
    await assert.rejects(broken, /有效 JSON/);

    const array = client.importTask();
    picker.current().file = { size: 3, text: async () => '[1]' };
    picker.current().fire('change');
    await assert.rejects(array, /JSON 对象/);
    assert.equal(gate.calls.length, 0);

    const handoff = { title: '交接', instruction: '做' };
    const imported = client.importTask();
    const selected = picker.current();
    selected.file = { size: 65536, text: async () => JSON.stringify(handoff) };
    selected.fire('change');
    await flush();
    assert.deepEqual(gate.calls[0].body, { method: 'createTask', args: [handoff] });
    gate.calls[0].resolve(jsonResponse({ result: { id: 'imported' } }));
    assert.deepEqual(await imported, { id: 'imported' });
    assert.equal(gate.calls.length, 1);
  } finally {
    gate.restore();
    cleanup();
  }
});

test('task watch polls sync.status once, notifies on change or error, and stops on unsubscribe', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installOrigin();
  const gate = installFetch();
  try {
    const client = createBrowserClient();
    let notified = 0;
    const stop = client.onTasksChanged(() => { notified += 1; });
    t.mock.timers.tick(5000);
    assert.equal(gate.calls.length, 1);
    assert.deepEqual(gate.calls[0].body, { method: 'command', args: [{ apiVersion: 'weaver.v1', command: 'sync.status', args: {} }] });
    assert.equal((gate.calls[0].body.args[0] as CommandRequest).commandId, undefined);
    gate.calls[0].resolve(jsonResponse({ result: { ok: true, data: { revision: 4, changed: false } } }));
    await flush();
    assert.equal(notified, 1);

    t.mock.timers.tick(999);
    assert.equal(gate.calls.length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual((gate.calls[1].body.args[0] as CommandRequest).args, { after: 4 });
    gate.calls[1].resolve(jsonResponse({ result: { ok: true, data: { revision: 4, changed: false } } }));
    await flush();
    assert.equal(notified, 1);

    t.mock.timers.tick(1000);
    gate.calls[2].resolve(jsonResponse({ result: { ok: true, data: { revision: 5, changed: true } } }));
    await flush();
    assert.equal(notified, 2);

    t.mock.timers.tick(1000);
    gate.calls[3].resolve(jsonResponse({ error: { code: 'UNAVAILABLE', message: 'down' } }, 503));
    await flush();
    assert.equal(notified, 2);
    t.mock.timers.tick(1000); await flush();
    gate.calls[4].resolve(jsonResponse({result:{ok:true,data:{revision:6,changed:true}}})); await flush();
    assert.equal(notified,3);

    const before = gate.calls.length;
    stop();
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(gate.calls.length, before);
    assert.equal(notified, 3);
  } finally {
    gate.restore();
    cleanup();
  }
});

test('an in-flight status poll is aborted and ignored after the last unsubscribe', async () => {
  installOrigin();
  const gate = installFetch();
  try {
    const client = createBrowserClient();
    let notified = 0;
    const stop = client.onTasksChanged(() => { notified += 1; });
    assert.equal(gate.calls.length, 1);
    stop();
    assert.equal(gate.calls[0].init.signal?.aborted, true);
    await flush();
    assert.equal(notified, 0);
    assert.equal(gate.calls.length, 1);
  } finally {
    gate.restore();
    cleanup();
  }
});

test('status listeners share one poll and a listener can unsubscribe itself', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installOrigin();
  const gate = installFetch();
  try {
    const client = createBrowserClient();
    let first = 0;
    let second = 0;
    let stopFirst: () => void = () => {};
    stopFirst = client.onTasksChanged(() => { first += 1; stopFirst(); });
    const stopSecond = client.onTasksChanged(() => { second += 1; });
    assert.equal(gate.calls.length, 1);
    gate.calls[0].resolve(jsonResponse({ result: { ok: true, data: { revision: 1, changed: false } } }));
    await flush();
    t.mock.timers.tick(1000);
    assert.equal(gate.calls.length, 2);
    await flush();
    assert.equal(first, 1);
    assert.equal(second, 1);
    gate.calls[1].resolve(jsonResponse({ result: { ok: true, data: { revision: 2, changed: true } } }));
    await flush();
    assert.equal(first, 1);
    assert.equal(second, 2);
    t.mock.timers.tick(1000);
    gate.calls[2].resolve(jsonResponse({ result: { ok: true, data: { revision: 3, changed: true } } }));
    await flush();
    assert.equal(first, 1);
    assert.equal(second, 3);
    stopSecond();
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(gate.calls.length, 3);
  } finally {
    gate.restore();
    cleanup();
  }
});

test('read deadlines reconnect while write deadlines reconcile without replay', async t => {
  t.mock.timers.enable({apis:['setTimeout']}); installOrigin(); const gate=installFetch();
  try {
    const client=createBrowserClient(); let settled=false;
    const pending=client.listTasks().then(value=>{settled=true;return value;});
    t.mock.timers.tick(RPC_DEADLINE_MS); await flush(); assert.equal(settled,false);
    t.mock.timers.tick(1000); await flush(); assert.equal(gate.calls.length,2);
    gate.calls[1].resolve(jsonResponse({result:[]})); assert.deepEqual(await pending,[]);
    t.mock.timers.tick(2000);
    const write=client.savePolicy({revision:1,config:{},blocks:[]} as never);
    // Response headers arrive, but its body stalls until the deadline.
    gate.calls[2].resolve({ok:true,status:200,json:()=>new Promise(()=>{})} as Response); await flush();
    const rejected=assert.rejects(write,/TIMEOUT/);
    t.mock.timers.tick(RPC_DEADLINE_MS); await rejected; await flush();
    assert.equal(gate.calls.filter(call=>call.body.method==='savePolicy').length,1);
    assert.deepEqual(gate.calls.slice(3).map(call=>call.body.method).sort(),['getPolicy','listTasks']);
    gate.calls[3].resolve(jsonResponse({result:[]})); gate.calls[4].resolve(jsonResponse({result:{revision:2}})); await flush();
    t.mock.timers.tick(15000); await flush();
    assert.equal(gate.calls.filter(call=>call.body.method==='savePolicy').length,1);
  } finally { gate.restore(); cleanup(); }
});

test('late status after unsubscribe is ignored and the next subscription still reports its first revision', async () => {
  installOrigin();
  const original = globalThis.fetch;
  const calls: Array<{ body: { method: string; args: unknown[] }; resolve: (value: Response) => void }> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; args: unknown[] };
    return await new Promise<Response>(resolve => { calls.push({ body, resolve }); });
  }) as typeof fetch;
  try {
    const client = createBrowserClient();
    let notified = 0;
    const stop = client.onTasksChanged(() => { notified += 1; });
    assert.equal(calls.length, 1);
    stop();
    calls[0].resolve(jsonResponse({ result: { ok: true, data: { revision: 9, changed: true } } }));
    await flush();
    assert.equal(notified, 0);
    const stopNext = client.onTasksChanged(() => { notified += 1; });
    assert.equal(calls.length, 2);
    assert.deepEqual((calls[1].body.args[0] as CommandRequest).args, {});
    calls[1].resolve(jsonResponse({ result: { ok: true, data: { revision: 9, changed: false } } }));
    await flush();
    assert.equal(notified, 1);
    stopNext();
  } finally {
    globalThis.fetch = original;
    cleanup();
  }
});

test('uncertain command envelopes trigger read reconciliation without replaying the command', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installOrigin(); const gate=installFetch();
  try {
    const client=installBrowserClient();
    const pending=command('tasks.create',{title:'test'},true);
    const failed=assert.rejects(pending,/APP_NOT_RUNNING/);
    gate.calls[0].resolve(jsonResponse({result:{ok:false,error:{code:'APP_NOT_RUNNING',message:'temporarily unavailable'}}}));
    await failed; await flush();
    assert.deepEqual(gate.calls.map(call=>call.body.method),['command','listTasks','getPolicy']);
    gate.calls[1].resolve(jsonResponse({result:[]}));gate.calls[2].resolve(jsonResponse({result:{revision:3}}));await flush();
    t.mock.timers.tick(15000);await flush();
    assert.equal(gate.calls.filter(call=>call.body.method==='command').length,1);
    assert.ok(client);
  } finally { gate.restore(); cleanup(); }
});
