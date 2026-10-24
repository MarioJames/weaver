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
