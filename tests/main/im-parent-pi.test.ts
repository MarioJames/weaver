import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfirmedParentCancellation, ParentAgentError, createParentAgent, type ParentAgentSession, type ParentProcessLauncher } from '../../src/main/im/parent-agent';

const FIXTURE = new URL('../fixtures/parent/pi-fixture.mjs', import.meta.url).pathname;
const sessions = new Set<ParentAgentSession>();

interface Harness { dir: string; workspace: string; marker: string; snapshot: string; previousPath: string }

function setup(name: string, scenario: string): Harness {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), `weaver-im-pi-${name}-`));
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  copyFileSync(FIXTURE, join(dir, 'pi')); chmodSync(join(dir, 'pi'), 0o755);
  const harness = { dir, workspace, marker: join(dir, 'marker.ndjson'), snapshot: join(dir, 'snapshot.json'), previousPath: process.env.PATH ?? '' };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.PI_FIXTURE_SCENARIO = scenario;
  process.env.PI_FIXTURE_MARKER = harness.marker;
  process.env.PI_FIXTURE_SNAPSHOT = harness.snapshot;
  return harness;
}

const launch: ParentProcessLauncher = (command, cwd, extra) => spawn(command[0], command.slice(1), {
  cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extra },
});

function input(harness: Harness, over: Record<string, unknown> = {}) {
  return { engineKind: 'pi' as const, model: 'fixture-model', effort: 'medium', workspace: harness.workspace, instructions: '你是飞书 IM 父 Agent，只做对话', ...over };
}

function markers(harness: Harness): Array<Record<string, unknown>> {
  if (!existsSync(harness.marker)) return [];
  return readFileSync(harness.marker, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

async function until(predicate: () => boolean, label: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error(`condition not reached: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}

async function teardown(harness: Harness): Promise<void> {
  for (const session of sessions) await session.close().catch(() => {});
  sessions.clear();
  process.env.PATH = harness.previousPath;
  for (const key of ['PI_FIXTURE_SCENARIO', 'PI_FIXTURE_MARKER', 'PI_FIXTURE_SNAPSHOT']) delete process.env[key];
  for (const entry of markers(harness)) if (typeof entry.spawnPid === 'number') await until(() => { try { process.kill(entry.spawnPid as number, 0); return false; } catch { return true; } }, 'pi fixture exit', 2000);
  rmSync(harness.dir, { recursive: true, force: true });
}

test('pi keeps one RPC process across turns, streams only public text, and starts without a user prompt', async () => {
  const harness = setup('multi', 'default');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 800 });
    sessions.add(session);
    assert.equal(markers(harness).filter(entry => entry.event === 'spawn').length, 1);
    assert.equal(markers(harness).filter(entry => entry.prompt !== undefined).length, 0, 'startup must not send a user prompt');
    const deltas: string[] = [];
    let firstDeltaAt = 0, resolvedAt = 0;
    const pending = session.send('第一轮', undefined, chunk => { firstDeltaAt ||= performance.now(); deltas.push(chunk); }).then(value => { resolvedAt = performance.now(); return value; });
    await until(() => deltas.length >= 2, 'two deltas before terminal');
    assert.equal(await pending, '最终回答1');
    assert.ok(firstDeltaAt > 0 && resolvedAt > firstDeltaAt, 'public deltas must arrive before the terminal');
    assert.deepEqual(deltas, ['你好，', '世界']);
    assert.ok(!deltas.join('').includes('SECRET'));
    assert.equal(await session.send('第二轮'), '最终回答2');
    const turns = markers(harness).filter(entry => typeof entry.turn === 'number');
    assert.equal(turns.length, 2);
    assert.equal(new Set(turns.map(entry => entry.pid)).size, 1, 'each turn must reuse the resident process');
    await session.close();
  } finally { await teardown(harness); }
});

const ABORT_ORDERS = [
  { name: 'ack-first', scenario: 'abort', observed: (entry: Record<string, unknown>) => entry.abort !== undefined },
  { name: 'settled-first', scenario: 'abort-early-settled', observed: (entry: Record<string, unknown>) => entry.settledBeforeAck === true },
] as const;

for (const order of ABORT_ORDERS) {
  test(`pi abort requires the abort ACK and agent_settled (${order.name}), then reuses the same process`, async () => {
    const harness = setup(`abort-${order.name}`, order.scenario);
    try {
      const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 800 });
      sessions.add(session);
      const controller = new AbortController();
      let settled = false;
      const pending = session.send('取消', controller.signal, () => controller.abort()).finally(() => { settled = true; });
      const checked = assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
      await until(() => markers(harness).some(order.observed), `${order.name} abort half observed`);
      assert.equal(settled, false, 'one abort half alone released the send');
      await checked;
      const next: string[] = [];
      assert.equal(await session.send('第二轮', undefined, chunk => next.push(chunk)), '最终回答2');
      assert.ok(!next.join('').includes('部分'));
      assert.equal(new Set(markers(harness).filter(entry => typeof entry.turn === 'number' && typeof entry.pid === 'number').map(entry => entry.pid)).size, 1);
      await session.close();
    } finally { await teardown(harness); }
  });
}

test('pi native retry success clears the recovered attempt error and reuses the same process', async () => {
  const harness = setup('retry-success', 'retry-success');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 800 });
    sessions.add(session);
    const deltas: string[] = [];
    assert.equal(await session.send('第一轮', undefined, chunk => deltas.push(chunk)), '最终回答1');
    assert.deepEqual(deltas, ['你好，', '世界']);
    assert.equal(await session.send('第二轮'), '最终回答2');
    assert.equal(new Set(markers(harness).filter(entry => typeof entry.turn === 'number').map(entry => entry.pid)).size, 1);
    await session.close();
  } finally { await teardown(harness); }
});

test('pi exhausted native retry still fails with the terminal error classification', async () => {
  const harness = setup('retry-exhausted', 'retry-exhausted');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 800 });
    sessions.add(session);
    await assert.rejects(session.send('问题'), error => error instanceof ParentAgentError && error.reason === 'engine' && /transient stream drop/.test(error.message));
    await session.close();
  } finally { await teardown(harness); }
});

test('pi retry-shaped frames during cancellation do not fake completion', async () => {
  const harness = setup('abort-retry', 'abort-retry');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 800 });
    sessions.add(session);
    const controller = new AbortController();
    let settled = false;
    const pending = session.send('取消', controller.signal, () => controller.abort()).finally(() => { settled = true; });
    const checked = assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    await until(() => markers(harness).some(entry => entry.abort !== undefined), 'abort observed');
    assert.equal(settled, false, 'retry frames during cancellation released the send');
    await checked;
    assert.equal(await session.send('第二轮'), '最终回答2');
    await session.close();
  } finally { await teardown(harness); }
});

test('pi abort without a terminal closes instead of pretending to stop', async () => {
  const harness = setup('missing', 'missing-terminal');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1500, closeMs: 250 });
    sessions.add(session);
    const controller = new AbortController();
    await assert.rejects(session.send('取消', controller.signal, () => controller.abort()), /abort|timed out/i);
    await assert.rejects(session.send('下一轮'), /closed|exited/i);
    await session.close();
  } finally { await teardown(harness); }
});

test('pi authentication failures keep the auth reason without vendor text in the public error', async () => {
  const harness = setup('auth', 'auth');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 500 });
    sessions.add(session);
    await assert.rejects(session.send('问题'), error => error instanceof ParentAgentError && error.reason === 'auth');
    await session.close();
  } finally { await teardown(harness); }
});

test('pi rejects a resolved model or effort that does not match the configured route', async () => {
  for (const scenario of ['model-mismatch', 'effort-mismatch']) {
    const harness = setup(scenario, scenario);
    try {
      await assert.rejects(createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1000, closeMs: 400 }), error => error instanceof ParentAgentError && error.reason === 'protocol');
    } finally { await teardown(harness); }
  }
});

test('pi cancels extension dialogs instead of hanging or granting approval', async () => {
  const harness = setup('extension', 'extension');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('运行'), '工具使用被拒绝');
    const response = markers(harness).find(entry => entry.extensionUiResponse) as { extensionUiResponse: { cancelled?: boolean } } | undefined;
    assert.equal(response?.extensionUiResponse.cancelled, true);
    await session.close();
  } finally { await teardown(harness); }
});

test('pi gives each chat/user its own resident process and context', async () => {
  const harness = setup('isolation', 'default');
  try {
    const first = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1500, closeMs: 400 });
    assert.equal(await first.send('会话一'), '最终回答1');
    await first.close();
    const second = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1500, closeMs: 400 });
    assert.equal(await second.send('会话二'), '最终回答1');
    await second.close();
    const pids = markers(harness).filter(entry => entry.event === 'spawn').map(entry => entry.spawnPid);
    assert.equal(new Set(pids).size, 2, 'separate parent sessions must not share a process');
    for (const pid of pids) assert.equal(markers(harness).filter(entry => entry.pid === pid && typeof entry.turn === 'number').length, 1);
  } finally { await teardown(harness); }
});

test('pi reports unified progress: stage once plus one event per top-level tool', async () => {
  const harness = setup('progress', 'progress');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 800 });
    sessions.add(session);
    const deltas: string[] = [];
    const progress: Array<{ kind: string; name: string }> = [];
    assert.equal(await session.send('第一轮', undefined, chunk => deltas.push(chunk), { onProgress: event => progress.push(event) }), '最终回答1');
    assert.deepEqual(deltas, ['你好，', '世界']);
    assert.deepEqual(progress, [
      { kind: 'stage', name: '开始' },
      { kind: 'tool', name: 'bash' },
      { kind: 'tool', name: 'edit' },
    ]);
    const leaked = JSON.stringify(progress);
    for (const secret of ['SECRET_CMD', 'SECRET_TOKEN', 'SECRET_PARTIAL', 'SECRET_RESULT', 'SECRET_NESTED', 'SECRET_SUBAGENT', 'SECRET_INPUT', 'SECRET_PATH']) {
      assert.ok(!leaked.includes(secret), `progress leaked ${secret}: ${leaked}`);
    }
    await session.close();
  } finally { await teardown(harness); }
});

test('pi progress stays silent without onProgress, with finalAssistantOnly, or after abort; throwing onProgress keeps the text turn', async () => {
  const harness = setup('progress-silent', 'progress');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 800 });
    sessions.add(session);
    const silent: string[] = [];
    assert.equal(await session.send('无回调', undefined, chunk => silent.push(chunk)), '最终回答1');
    assert.deepEqual(silent, ['你好，', '世界']);
    const hidden: Array<{ kind: string; name: string }> = [];
    const hiddenDeltas: string[] = [];
    assert.equal(await session.send('隐藏轮', undefined, chunk => hiddenDeltas.push(chunk), { finalAssistantOnly: true, onProgress: event => hidden.push(event) }), '最终回答2');
    assert.deepEqual(hidden, [], 'finalAssistantOnly must not emit progress');
    const throwing: string[] = [];
    assert.equal(await session.send('抛错回调', undefined, chunk => throwing.push(chunk), { onProgress: () => { throw new Error('progress boom'); } }), '最终回答3');
    assert.deepEqual(throwing, ['你好，', '世界']);
    await session.close();
  } finally { await teardown(harness); }
});

test('pi never reports progress for tool frames arriving after abort', async () => {
  const harness = setup('progress-abort', 'abort');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 800 });
    sessions.add(session);
    const controller = new AbortController();
    const progress: Array<{ kind: string; name: string }> = [];
    const pending = session.send('取消', controller.signal, () => controller.abort(), { onProgress: event => progress.push(event) });
    await assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    assert.deepEqual(progress, [{ kind: 'stage', name: '开始' }], `late tool frame must not emit: ${JSON.stringify(progress)}`);
    await session.close();
  } finally { await teardown(harness); }
});

test('pi argv keeps native permissions and never adds approve, bypass or extension removal', async () => {
  const harness = setup('args', 'default');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 500 });
    sessions.add(session);
    await session.send('问题');
    await session.close();
    assert.equal(statSync(harness.snapshot).mode & 0o777, 0o600);
    const snapshot = JSON.parse(readFileSync(harness.snapshot, 'utf8')) as { argv: string[] };
    for (const flag of ['--mode', 'rpc', '--no-session', '--model', '--thinking', '--append-system-prompt']) assert.ok(snapshot.argv.includes(flag), `missing ${flag}`);
    for (const flag of ['--approve', '-a', '--no-extensions', '-ne', '--no-tools', '-nt', '--no-approve']) assert.ok(!snapshot.argv.includes(flag), `unexpected ${flag}`);
  } finally { await teardown(harness); }
});
