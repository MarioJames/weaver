import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfirmedParentCancellation, ParentAgentError, createParentAgent, type ParentAgentSession, type ParentProcessLauncher } from '../../src/main/im/parent-agent';
import { imInstructions } from '../../src/main/im/bootstrap';

const FIXTURE = new URL('../fixtures/parent/opencode-fixture.mjs', import.meta.url).pathname;
const sessions = new Set<ParentAgentSession>();

interface Harness { dir: string; workspace: string; extra: string; marker: string; snapshot: string; previousPath: string }

function setup(name: string, scenario: string): Harness {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), `weaver-im-oc-${name}-`));
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  const extra = join(dir, 'extra'); mkdirSync(extra);
  copyFileSync(FIXTURE, join(dir, 'opencode')); chmodSync(join(dir, 'opencode'), 0o755);
  const harness = { dir, workspace, extra, marker: join(dir, 'marker.ndjson'), snapshot: join(dir, 'snapshot.json'), previousPath: process.env.PATH ?? '' };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.OPENCODE_FIXTURE_SCENARIO = scenario;
  process.env.OPENCODE_FIXTURE_MARKER = harness.marker;
  process.env.OPENCODE_FIXTURE_SNAPSHOT = harness.snapshot;
  return harness;
}

const launch: ParentProcessLauncher = (command, cwd, extraEnv) => spawn(command[0], command.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });

function input(harness: Harness, over: Record<string, unknown> = {}) {
  return { engineKind: 'opencode' as const, model: 'fixture-provider/fixture-model', effort: 'high', workspace: harness.workspace, additionalWorkspaces: [harness.extra], instructions: '你是飞书 IM 父 Agent，只做对话', ...over };
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
  for (const key of ['OPENCODE_FIXTURE_SCENARIO', 'OPENCODE_FIXTURE_MARKER', 'OPENCODE_FIXTURE_SNAPSHOT']) delete process.env[key];
  for (const entry of markers(harness)) if (typeof entry.spawnPid === 'number') await until(() => { try { process.kill(entry.spawnPid as number, 0); return false; } catch { return true; } }, 'opencode fixture exit', 3000);
  rmSync(harness.dir, { recursive: true, force: true });
}

test('opencode serves one resident session across turns, starts without a prompt and streams attributed public text', async () => {
  const harness = setup('multi', 'default');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 900 });
    sessions.add(session);
    assert.equal(markers(harness).filter(entry => typeof entry.turn === 'number').length, 0, 'startup must not send a prompt');
    const deltas: string[] = [];
    let firstDeltaAt = 0, resolvedAt = 0;
    const pending = session.send('第一轮', undefined, chunk => { firstDeltaAt ||= performance.now(); deltas.push(chunk); }).then(value => { resolvedAt = performance.now(); return value; });
    assert.equal(await pending, '你好，世界1');
    assert.ok(firstDeltaAt > 0 && resolvedAt > firstDeltaAt);
    assert.deepEqual(deltas, ['你好，', '世界1']);
    assert.equal(await session.send('第二轮'), '你好，世界2');
    const turns = markers(harness).filter(entry => typeof entry.turn === 'number');
    assert.equal(turns.length, 2);
    assert.equal(new Set(turns.map(entry => entry.pid)).size, 1, 'turns must reuse the resident server');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode buffers a part delta that arrives before the assistant message binding', async () => {
  const harness = setup('delta-first', 'delta-first');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 900 });
    sessions.add(session);
    const deltas: string[] = [];
    assert.equal(await session.send('问题', undefined, chunk => deltas.push(chunk)), '你好，世界1');
    assert.deepEqual(deltas, ['你好，', '世界1']);
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode abort needs the boolean ACK plus session.idle and then reuses the session', async () => {
  const harness = setup('abort', 'abort');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 800 });
    sessions.add(session);
    const controller = new AbortController();
    let settled = false;
    const pending = session.send('取消', controller.signal, () => controller.abort()).finally(() => { settled = true; });
    const checked = assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    await until(() => markers(harness).some(entry => entry.abort), 'abort request');
    assert.equal(settled, false, 'abort ACK alone released the send');
    await checked;
    assert.equal(await session.send('第二轮'), '你好，世界2');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode abort without idle or without ACK closes instead of claiming a stop', async () => {
  for (const [scenario, pattern] of [['abort-missing-idle', /abort|timed out/i], ['abort-false', /abort|did not accept/i]] as const) {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 2500, closeMs: 250 });
      sessions.add(session);
      const controller = new AbortController();
      await assert.rejects(session.send('取消', controller.signal, () => controller.abort()), pattern);
      await session.close();
    } finally { await teardown(harness); }
  }
});

test('opencode auth and protocol startup failures stay bounded', async () => {
  for (const [scenario, reason] of [['health-auth', 'auth'], ['health-garbage', 'protocol'], ['bad-url', 'protocol']] as const) {
    const harness = setup(scenario, scenario);
    try {
      await assert.rejects(createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 1000, closeMs: 400 }), error => error instanceof ParentAgentError && error.reason === reason);
    } finally { await teardown(harness); }
  }
});

test('opencode provider authentication and divergent snapshots fail closed', async () => {
  for (const [scenario, reason] of [['auth', 'auth'], ['divergent', 'protocol']] as const) {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 2500, closeMs: 400 });
      sessions.add(session);
      await assert.rejects(session.send('问题'), error => error instanceof ParentAgentError && error.reason === reason);
      await session.close();
    } finally { await teardown(harness); }
  }
});

test('opencode rejects missing final text and missing terminal instead of resolving empty', async () => {
  for (const [scenario, pattern] of [['missing-final', /public text|protocol/i], ['missing-idle', /timed out/i]] as const) {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 1200, closeMs: 300 });
      sessions.add(session);
      await assert.rejects(session.send('问题'), pattern);
      await session.close();
    } finally { await teardown(harness); }
  }
});

test('opencode approves only external paths inside configured roots and rejects other permissions/questions', async () => {
  const allowed = setup('perm-allowed', 'permission');
  try {
    const session = await createParentAgent(input(allowed), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('读取额外目录'), '工具请求已处理');
    const reply = markers(allowed).find(entry => entry.permissionReply) as { permissionReply: { kind: string; reply: string } } | undefined;
    assert.deepEqual(reply?.permissionReply, { kind: 'legacy', reply: 'once' });
    await session.close();
  } finally { await teardown(allowed); }
  const denied = setup('perm-denied', 'permission-denied');
  try {
    const session = await createParentAgent(input(denied), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('读取系统目录'), '工具请求已处理');
    const reply = markers(denied).find(entry => entry.permissionReply) as { permissionReply: { kind: string; reply: string } } | undefined;
    assert.deepEqual(reply?.permissionReply, { kind: 'legacy', reply: 'reject' });
    await session.close();
  } finally { await teardown(denied); }
  const v2 = setup('perm-v2', 'permission-v2');
  try {
    const session = await createParentAgent(input(v2), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('读取'), '工具请求已处理');
    const reply = markers(v2).find(entry => entry.permissionReply) as { permissionReply: { kind: string; reply: string } } | undefined;
    assert.deepEqual(reply?.permissionReply, { kind: 'v2', reply: 'reject' });
    await session.close();
  } finally { await teardown(v2); }
  const question = setup('question', 'question');
  try {
    const session = await createParentAgent(input(question), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('询问'), '问题已拒绝');
    assert.ok(markers(question).some(entry => entry.questionRejected));
    await session.close();
  } finally { await teardown(question); }
});

test('opencode gives each chat/user its own server process and session', async () => {
  const harness = setup('isolation', 'default');
  try {
    const first = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 2000, closeMs: 300 });
    assert.equal(await first.send('会话一'), '你好，世界1');
    await first.close();
    const second = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 2000, closeMs: 300 });
    assert.equal(await second.send('会话二'), '你好，世界1');
    await second.close();
    const pids = markers(harness).filter(entry => entry.event === 'spawn').map(entry => entry.spawnPid);
    assert.equal(new Set(pids).size, 2, 'separate parent sessions must not share a server');
    for (const pid of pids) assert.equal(markers(harness).filter(entry => entry.pid === pid && typeof entry.turn === 'number').length, 1);
  } finally { await teardown(harness); }
});

test('opencode argv binds loopback with a private password and never trusts another address', async () => {
  const harness = setup('args', 'default');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    await session.send('问题');
    await session.close();
    assert.equal(statSync(harness.snapshot).mode & 0o777, 0o600);
    const snapshot = JSON.parse(readFileSync(harness.snapshot, 'utf8')) as { argv: string[]; hasPassword: boolean };
    assert.equal(snapshot.hasPassword, true);
    assert.equal(snapshot.argv[snapshot.argv.indexOf('--hostname') + 1], '127.0.0.1');
    assert.ok(Number(snapshot.argv[snapshot.argv.indexOf('--port') + 1]) > 0);
    assert.ok(snapshot.argv.includes('--pure'));
    assert.deepEqual(markers(harness).filter(entry => entry.turn).map(entry => (entry as { model: { providerID: string; modelID: string } }).model), [
      { providerID: 'fixture-provider', modelID: 'fixture-model' },
    ]);
  } finally { await teardown(harness); }
});

test('opencode stale same-session idle never settles the current turn early', async () => {
  const harness = setup('stale-success', 'stale-success');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 800 });
    sessions.add(session);
    const t0 = Date.now();
    const pending = session.send('hello');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(markers(harness).filter(entry => entry.abort).length, 0);
    // The stale idle arrives ~40ms in while the message still has no time.completed:
    // the send must still be pending here, not resolved with the partial text.
    assert.ok(Date.now() - t0 >= 200, 'the stale-idle window must have passed');
    assert.equal(await pending, 'PARTIAL-FULL');
    assert.ok(Date.now() - t0 >= 400, 'the true terminal arrives only after the stale idle');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode abort ACK plus stale idle while still busy never reports a confirmed stop', async () => {
  const harness = setup('stale-cancel', 'stale-cancel');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 600 });
    sessions.add(session);
    const controller = new AbortController();
    const pending = session.send('cancel me', controller.signal);
    const checked = assert.rejects(pending, error => !(error instanceof ConfirmedParentCancellation));
    await until(() => markers(harness).filter(entry => typeof entry.turn === 'number').length >= 1, 'turn bound');
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort();
    await until(() => markers(harness).some(entry => entry.abort), 'abort request');
    // The stale idle arrives ~20ms after the ACK while the message still has no terminal
    // and the turn is still busy: no ConfirmedParentCancellation may surface here.
    await new Promise(resolve => setTimeout(resolve, 350));
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false, 'stale idle plus ACK must not settle the turn or release the next send');
    await assert.rejects(session.send('blocked B'), /another send is still in progress/i);
    await checked;
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode native MessageAbortedError terminal confirms the cancellation and reuses the session', async () => {
  const harness = setup('abort-error', 'abort-error');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 900 });
    sessions.add(session);
    const controller = new AbortController();
    const pending = session.send('取消', controller.signal);
    await until(() => markers(harness).filter(entry => typeof entry.turn === 'number').length >= 1, 'turn bound');
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort();
    await assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode abort before the first assistant binds still confirms on the late native terminal', async () => {
  const harness = setup('abort-early', 'abort-early');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 1200 });
    sessions.add(session);
    const controller = new AbortController();
    const pending = session.send('early abort', controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode intermediate tool-calls completion never settles success early; true stop tail wins', async () => {
  const harness = setup('intermediate-success', 'intermediate-success');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 800 });
    sessions.add(session);
    const t0 = Date.now();
    const pending = session.send('hello');
    await new Promise(resolve => setTimeout(resolve, 250));
    // A completed finish:"tool-calls" step plus stale idle and busy status arrive ~40ms in:
    // the send must still be pending here, not resolved with the partial text.
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false, 'completed tool-calls plus stale idle must not resolve the turn');
    assert.equal(await pending, 'PARTIAL-FULL');
    assert.ok(Date.now() - t0 >= 400, 'the true finish:stop terminal arrives only after the stale idle');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode intermediate tool-calls plus ACK and stale busy idle never confirms cancellation', async () => {
  const harness = setup('intermediate-cancel', 'intermediate-cancel');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 500 });
    sessions.add(session);
    const controller = new AbortController();
    const pending = session.send('cancel me', controller.signal);
    const checked = assert.rejects(pending, error => !(error instanceof ConfirmedParentCancellation));
    await until(() => markers(harness).filter(entry => typeof entry.turn === 'number').length >= 1, 'turn bound');
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort();
    await until(() => markers(harness).some(entry => entry.abort), 'abort request');
    // The stale idle arrives ~20ms after the ACK while the message only shows an intermediate
    // finish:"tool-calls" step and the session stays busy: no ConfirmedParentCancellation here.
    await new Promise(resolve => setTimeout(resolve, 350));
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false, 'tool-calls plus ACK plus stale idle must not settle the turn or release the next send');
    await assert.rejects(session.send('blocked B'), /another send is still in progress/i);
    await checked;
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode completed without finish never settles early; true stop tail wins', async () => {
  const harness = setup('missing-finish', 'missing-finish');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 800 });
    sessions.add(session);
    const t0 = Date.now();
    const pending = session.send('hello');
    await new Promise(resolve => setTimeout(resolve, 250));
    // A completed observation without finish plus stale idle and busy status arrives ~40ms in:
    // the send must still be pending here, not resolved with the partial text.
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false, 'completed without finish plus stale idle must not resolve the turn');
    assert.equal(await pending, 'PARTIAL-FULL');
    assert.ok(Date.now() - t0 >= 400, 'the true finish:stop terminal arrives only after the insufficient observation');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode terminal events arriving during the message fetch are re-checked, not swallowed', async () => {
  const harness = setup('finalize-race', 'finalize-race');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 800 });
    sessions.add(session);
    // The first GET /message hangs 300ms, the true finish:"stop" terminal plus idle land
    // mid-fetch, and the held read answers with the stale open snapshot. Dropping that wake
    // would stall to the turn timeout; the bounded re-check must still resolve the full text.
    assert.equal(await session.send('hello'), 'PARTIAL-FULL');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode later tool assistants under the same prompt never truncate or leak the public text', async () => {
  const harness = setup('multi', 'multi-assistant');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 800 });
    sessions.add(session);
    const deltas: string[] = [];
    const text = await session.send('工具步骤', undefined, chunk => deltas.push(chunk));
    assert.ok(text.includes('最终'), `final text must include the newest assistant tail, got ${JSON.stringify(text)}`);
    assert.ok(!text.includes('SECRET'), 'reasoning/tool parts must never leak into the public text');
    assert.ok(!deltas.join('').includes('SECRET'), 'streamed deltas must never leak reasoning/tool parts');
    // 同一 prompt 下新 assistant 消息的公开文本与之前段落之间补段落分隔。
    assert.deepEqual(deltas, ['中间-', '\n\n最终']);
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode sends the complete prepared bootstrap as the native system field while startup stays prompt-free', async () => {
  const harness = setup('bootstrap', 'default');
  try {
    const dataDir = join(harness.dir, "实例 data '特殊' 目录");
    mkdirSync(dataDir);
    const instructions = imInstructions(dataDir, 'opencode', '00000000-0000-4000-8000-000000000001', [harness.workspace, harness.extra]);
    const session = await createParentAgent(input(harness, { instructions }), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    assert.equal(markers(harness).filter(entry => typeof entry.turn === 'number').length, 0, 'startup must not send a prompt');
    assert.equal(await session.send('第一条用户消息'), '你好，世界1');
    assert.equal(await session.send('第二条用户消息'), '你好，世界2');
    const turns = markers(harness).filter(entry => typeof entry.turn === 'number') as Array<Record<string, unknown>>;
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map(entry => entry.text), ['第一条用户消息', '第二条用户消息']);
    for (const turn of turns) {
      assert.equal(turn.system, instructions, 'every user prompt must carry the exact factory instructions as system');
      assert.deepEqual(turn.model, { providerID: 'fixture-provider', modelID: 'fixture-model' });
      assert.equal(turn.variant, 'high');
      assert.match(String(turn.messageID), /^msg/);
    }
    assert.ok(instructions.includes('weaver --data-dir'));
    assert.ok(instructions.includes(harness.workspace));
    assert.ok(instructions.includes(harness.extra));
    assert.ok(instructions.includes('<weaver-actions>'));
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode streams only confirmed public text and drops reasoning deltas before and after metadata', async () => {
  const harness = setup('reasoning-stream', 'reasoning-stream');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    const deltas: string[] = [];
    const text = await session.send('解释一下', undefined, chunk => deltas.push(chunk));
    assert.deepEqual(deltas, ['公开', '-正文'], 'public text must still stream exactly once and in order');
    assert.equal(text, '公开-正文');
    assert.ok(!deltas.join('').includes('SECRET'), 'reasoning deltas must never reach the public stream');
    assert.ok(!text.includes('SECRET'), 'reasoning parts must never reach the final text');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode buffered private parts replay with their original type and flags', async () => {
  const harness = setup('buffered-private', 'buffered-private');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    const deltas: string[] = [];
    const text = await session.send('缓冲', undefined, chunk => deltas.push(chunk));
    assert.deepEqual(deltas, ['BUFFERED-PUBLIC']);
    assert.equal(text, 'BUFFERED-PUBLIC');
    assert.ok(!deltas.join('').includes('SECRET'), 'buffered reasoning/synthetic deltas must never replay publicly');
    assert.ok(!text.includes('SECRET'), 'buffered private parts must never reach the final text');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode synthetic and ignored text parts cannot stream or reach the final text', async () => {
  const harness = setup('synthetic-text', 'synthetic-text');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    const deltas: string[] = [];
    const text = await session.send('合成文本', undefined, chunk => deltas.push(chunk));
    assert.deepEqual(deltas, ['PUBLIC']);
    assert.equal(text, 'PUBLIC');
    assert.ok(!deltas.join('').includes('SECRET'), 'synthetic/ignored deltas must never reach the public stream');
    assert.ok(!text.includes('SECRET'), 'synthetic/ignored text must never reach the final text');
    await session.close();
  } finally { await teardown(harness); }
});
