import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHello } from '../../src/renderer/features/engines/hello-runs';

test('a say hi run is kept per worker, polls until done, and ignores a second start while running', async () => {
  const calls: string[] = [];
  let polls = 0;
  (globalThis as any).window = { weaver: {
    sayHi: async (input: { engine: string }) => { calls.push(`start:${input.engine}`); return { id: 'a'.repeat(16), status: 'running', startedAt: 'x' }; },
    sayHiResult: async () => { polls += 1; return polls < 2 ? { id: 'a'.repeat(16), status: 'running', startedAt: 'x' } : { id: 'a'.repeat(16), status: 'done', startedAt: 'x', result: { ok: true, reply: 'hi', durationMs: 5, checkedAt: 'y' } }; },
  } };
  const first = startHello('codex_worker', { channel: 'default_codex', engine: 'codex', model: 'm', effort: 'low' }, 'codex · m · low', 1);
  await startHello('codex_worker', { channel: 'default_codex', engine: 'codex', model: 'm', effort: 'low' }, 'codex · m · low', 1);
  await first;
  assert.deepEqual(calls, ['start:codex']);
  assert.equal(polls, 2);
  // The store outlives any component; read it the way the hook does.
  const store = await import('../../src/renderer/features/engines/hello-runs');
  let seen: unknown;
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  function Probe() { seen = store.useHelloRun('codex_worker'); return null; }
  renderToStaticMarkup(React.createElement(Probe));
  assert.deepEqual((seen as any).result.reply, 'hi');
  assert.equal((seen as any).running, false);
  assert.equal((seen as any).route, 'codex · m · low');
  delete (globalThis as any).window;
});

test('diagnostic results stay with role, account, model and effort when an old account finishes last', async () => {
  const store = await import('../../src/renderer/features/engines/hello-runs');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const route = { channel: 'a', engine: 'codex', model: 'm', effort: 'high' };
  const a = store.helloRouteKey('workers:pool', route);
  const bRoute = { ...route, channel: 'b' };
  const b = store.helloRouteKey('workers:pool', bRoute);
  let finishA!: (job: unknown) => void;
  const previous = (globalThis as any).window;
  (globalThis as any).window = { weaver: { sayHi: async (input: typeof route) => input.channel === 'a' ? new Promise(resolve => { finishA = resolve; }) : { status: 'done', result: { ok: true, reply: 'B' } } } };
  const read = (key: string) => {
    let seen: ReturnType<typeof store.useHelloRun>;
    function Probe() { seen = store.useHelloRun(key); return null; }
    renderToStaticMarkup(React.createElement(Probe));
    return seen!;
  };
  try {
    const pending = store.startHello(a, route, '账号 A');
    await store.startHello(b, bRoute, '账号 B');
    assert.equal(read(b)?.result?.reply, 'B');
    assert.equal(read(a)?.running, true);
    for (const [role, change] of [['workers:other', {}], ['owners:pool', {}], ['workers:pool', { model: 'other' }], ['workers:pool', { effort: 'low' }]] as const) {
      assert.equal(read(store.helloRouteKey(role, { ...route, ...change })), undefined);
    }
    finishA({ status: 'done', result: { ok: true, reply: 'A' } });
    await pending;
    assert.equal(read(a)?.result?.reply, 'A');
    assert.equal(read(b)?.result?.reply, 'B');
  } finally { (globalThis as any).window = previous; }
});
