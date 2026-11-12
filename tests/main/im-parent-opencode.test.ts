import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfirmedParentCancellation, ParentAgentError, createParentAgent, type ParentAgentSession, type ParentProcessLauncher, type ParentProgressEvent } from '../../src/main/im/parent-agent';
import { imInstructions, imMasterIdentityPrompt } from '../../src/main/im/bootstrap';
import { isMasterReadyText } from '../../src/main/im/parent-identity';

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

test('opencode 2.2 serves one resident session across turns, starts without a prompt and streams attributed public text', async () => {
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

test('opencode abort needs the interrupt ACK plus execution.interrupted and then reuses the session', async () => {
  const harness = setup('abort', 'abort');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 800 });
    sessions.add(session);
    const controller = new AbortController();
    let settled = false;
    const pending = session.send('取消', controller.signal, () => controller.abort()).finally(() => { settled = true; });
    const checked = assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    await until(() => markers(harness).some(entry => entry.abort), 'interrupt request');
    assert.equal(settled, false, 'interrupt ACK alone released the send');
    await checked;
    assert.equal(await session.send('第二轮'), '你好，世界2');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode abort without a native terminal or without ACK closes instead of claiming a stop', async () => {
  for (const [scenario, pattern] of [['abort-missing-idle', /abort|timed out/i], ['abort-false', /did not accept|abort/i]] as const) {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 2500, closeMs: 250 });
      sessions.add(session);
      const controller = new AbortController();
      const pending = session.send('取消', controller.signal, () => controller.abort());
      await assert.rejects(pending, pattern);
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

test('opencode provider authentication and execution failures fail closed', async () => {
  for (const [scenario, reason, pattern] of [['auth', 'auth', /authentication/i], ['execution-failed', 'engine', /Model unavailable/i]] as const) {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 2500, closeMs: 400 });
      sessions.add(session);
      await assert.rejects(session.send('问题'), error => error instanceof ParentAgentError && error.reason === reason && pattern.test(error.message));
      await session.close();
    } finally { await teardown(harness); }
  }
});

test('opencode rejects missing final text and missing execution terminal instead of resolving empty', async () => {
  for (const [scenario, pattern] of [['missing-final', /public text|protocol/i], ['missing-terminal', /timed out/i]] as const) {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 1200, closeMs: 300 });
      sessions.add(session);
      await assert.rejects(session.send('问题'), pattern);
      await session.close();
    } finally { await teardown(harness); }
  }
});

test('opencode approves only external paths inside configured roots and rejects other permissions/forms', async () => {
  const allowed = setup('perm-allowed', 'permission');
  try {
    const session = await createParentAgent(input(allowed), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('读取额外目录'), '工具请求已处理');
    const reply = markers(allowed).find(entry => entry.permissionReply) as { permissionReply: { decision: string } } | undefined;
    assert.deepEqual(reply?.permissionReply.decision, 'once');
    await session.close();
  } finally { await teardown(allowed); }
  const denied = setup('perm-denied', 'permission-denied');
  try {
    const session = await createParentAgent(input(denied), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('读取系统目录'), '工具请求已处理');
    const reply = markers(denied).find(entry => entry.permissionReply) as { permissionReply: { decision: string } } | undefined;
    assert.deepEqual(reply?.permissionReply.decision, 'reject');
    await session.close();
  } finally { await teardown(denied); }
  const form = setup('form', 'question');
  try {
    const session = await createParentAgent(input(form), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('询问'), '问题已拒绝');
    assert.ok(markers(form).some(entry => entry.formCancelled));
    await session.close();
  } finally { await teardown(form); }
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

test('opencode 2.2 argv binds loopback with a private password and never trusts another address', async () => {
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
    assert.ok(!snapshot.argv.includes('--pure'), '2.2 serve has no --pure');
    assert.deepEqual(markers(harness).filter(entry => entry.turn).map(entry => (entry as { model: { providerID: string; id: string; variant: string } }).model), [
      { providerID: 'fixture-provider', id: 'fixture-model', variant: 'high' },
    ]);
  } finally { await teardown(harness); }
});

test('opencode sends the complete prepared bootstrap as a session instruction entry while startup stays prompt-free', async () => {
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
      assert.equal(turn.instructions, instructions, 'the exact factory instructions must be attached to the session');
      assert.deepEqual(turn.model, { providerID: 'fixture-provider', id: 'fixture-model', variant: 'high' });
      assert.match(String(turn.messageID), /^msg/);
    }
    assert.ok(instructions.includes('weaver --data-dir'));
    assert.ok(instructions.includes(harness.workspace));
    assert.ok(instructions.includes(harness.extra));
    assert.ok(instructions.includes('<weaver-actions>'));
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode streams only public text and drops reasoning, tool and synthetic events', async () => {
  const harness = setup('reasoning-stream', 'reasoning-stream');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 500 });
    sessions.add(session);
    const deltas: string[] = [];
    const text = await session.send('解释一下', undefined, chunk => deltas.push(chunk));
    assert.deepEqual(deltas, ['公开', '-正文'], 'public text must still stream exactly once and in order');
    assert.equal(text, '公开-正文');
    assert.ok(!deltas.join('').includes('SECRET'), 'reasoning/synthetic events must never reach the public stream');
    assert.ok(!text.includes('SECRET'), 'reasoning/synthetic events must never reach the final text');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode default aggregates assistant boundaries with a blank line; final-only resolves the terminal alone', async () => {
  const harness = setup('multi-final', 'multi-assistant');
  try {
    const first = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 800 });
    sessions.add(first);
    const deltas: string[] = [];
    const text = await first.send('工具步骤', undefined, chunk => deltas.push(chunk));
    assert.equal(text, '中间-\n\n最终');
    assert.deepEqual(deltas, ['中间-', '\n\n最终']);
    await first.close();
  } finally { await teardown(harness); }
  const split = setup('split-final', 'multi-assistant');
  try {
    const session = await createParentAgent(input(split), { launch, startupMs: 4000, turnMs: 3000, closeMs: 800 });
    sessions.add(session);
    const hidden: string[] = [];
    const terminal = await session.send('工具步骤', undefined, chunk => hidden.push(chunk), { finalAssistantOnly: true });
    assert.equal(terminal, '最终');
    assert.deepEqual(hidden, [], 'final-only identity check streams no public delta');
    await session.close();
  } finally { await teardown(split); }
});

test('opencode split progress plus terminal marker: default aggregate fails strict, final-only passes it', async () => {
  const harness = setup('identity-split-default', 'identity-split');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 3000, closeMs: 800 });
    sessions.add(session);
    const raw = await session.send(imMasterIdentityPrompt());
    assert.ok(raw.includes('WEAVER_MASTER_READY'));
    assert.ok(raw.includes('身份初始化中，接线完成。'));
    assert.ok(raw.includes('\n\n'), 'default keeps real assistant boundaries apart');
    assert.equal(isMasterReadyText(raw), false, 'aggregated progress plus marker must still fail the strict gate');
    await session.close();
  } finally { await teardown(harness); }
  const only = setup('identity-split-only', 'identity-split');
  try {
    const session = await createParentAgent(input(only), { launch, startupMs: 4000, turnMs: 3000, closeMs: 800 });
    sessions.add(session);
    const deltas: string[] = [];
    const terminal = await session.send(imMasterIdentityPrompt(), undefined, chunk => deltas.push(chunk), { finalAssistantOnly: true });
    assert.equal(terminal, 'WEAVER_MASTER_READY');
    assert.equal(isMasterReadyText(terminal), true);
    assert.deepEqual(deltas, [], 'hidden final-only check emits no public delta');
    assert.ok(!terminal.includes('接线完成'));
    await session.close();
  } finally { await teardown(only); }
});

test('opencode emits one start and one progress per top-level tool with native names only', async () => {
  const harness = setup('progress', 'progress');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 800 });
    sessions.add(session);
    const deltas: string[] = [];
    const progress: ParentProgressEvent[] = [];
    const text = await session.send('进度', undefined, chunk => deltas.push(chunk), { onProgress: event => progress.push(event) });
    assert.equal(text, '进度完成');
    assert.deepEqual(deltas, ['进度', '完成']);
    assert.deepEqual(progress, [
      { kind: 'stage', name: '开始' },
      { kind: 'tool', name: 'bash' },
      { kind: 'tool', name: 'read' },
    ]);
    assert.equal(progress.filter(event => event.kind === 'stage').length, 1, 'start must fire exactly once');
    const serialized = JSON.stringify(progress);
    for (const secret of ['SECRET_TOOL_TOKEN', 'SECRET_PATH', 'SECRET_TOOL_TITLE', 'SECRET_TOOL_OUTPUT']) {
      assert.ok(!serialized.includes(secret), `${secret} leaked into progress: ${serialized}`);
    }
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode without onProgress keeps the previous text-only behavior', async () => {
  const harness = setup('progress-plain', 'progress');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 800 });
    sessions.add(session);
    const deltas: string[] = [];
    assert.equal(await session.send('进度', undefined, chunk => deltas.push(chunk)), '进度完成');
    assert.deepEqual(deltas, ['进度', '完成']);
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode finalAssistantOnly turns emit no progress', async () => {
  const harness = setup('progress-final-only', 'progress');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 800 });
    sessions.add(session);
    const deltas: string[] = [];
    const progress: ParentProgressEvent[] = [];
    const text = await session.send('进度', undefined, chunk => deltas.push(chunk), { finalAssistantOnly: true, onProgress: event => progress.push(event) });
    assert.equal(text, '进度完成');
    assert.deepEqual(deltas, []);
    assert.deepEqual(progress, []);
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode swallows onProgress errors and still resolves the text turn', async () => {
  const harness = setup('progress-throw', 'progress');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 800 });
    sessions.add(session);
    const deltas: string[] = [];
    let calls = 0;
    const text = await session.send('进度', undefined, chunk => deltas.push(chunk), { onProgress: () => { calls += 1; throw new Error('progress callback boom'); } });
    assert.ok(calls >= 3, 'every native progress event was still delivered to the callback');
    assert.equal(text, '进度完成');
    assert.deepEqual(deltas, ['进度', '完成']);
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode stops calling onProgress after abort and ignores late native tool frames', async () => {
  const harness = setup('progress-abort', 'progress-abort');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 900 });
    sessions.add(session);
    const progress: ParentProgressEvent[] = [];
    const controller = new AbortController();
    const pending = session.send('取消进度', controller.signal, undefined, {
      onProgress: event => { progress.push(event); if (event.kind === 'tool') controller.abort(); },
    });
    await assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    assert.deepEqual(progress, [
      { kind: 'stage', name: '开始' },
      { kind: 'tool', name: 'bash' },
    ]);
    const seen = progress.length;
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(progress.length, seen, 'no progress may be emitted after the cancellation settles');
    assert.ok(!progress.some(event => event.name === 'grep'), 'the post-abort tool frame must not surface');
    await session.close();
  } finally { await teardown(harness); }
});

test('opencode stale idle and stale execution terminal never settle the current turn early', async () => {
  for (const scenario of ['stale-idle', 'stale-execution'] as const) {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness), { launch, startupMs: 4000, turnMs: 4000, closeMs: 800 });
      sessions.add(session);
      const t0 = Date.now();
      const pending = session.send('hello');
      await new Promise(resolve => setTimeout(resolve, 150));
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(settled, false, `${scenario}: stale signal must not release the turn`);
      assert.equal(await pending, '你好，世界1');
      assert.ok(Date.now() - t0 >= 250, `${scenario}: the true terminal arrives only after the stale signal`);
      await session.close();
    } finally { await teardown(harness); }
  }
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
