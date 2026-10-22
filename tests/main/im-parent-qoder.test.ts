import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfirmedParentCancellation, ParentAgentError, createParentAgent, type ParentAgentSession, type ParentProcessLauncher, type ParentProgressEvent } from '../../src/main/im/parent-agent';

const FIXTURE = new URL('../fixtures/parent/qoder-fixture.mjs', import.meta.url).pathname;
const sessions = new Set<ParentAgentSession>();

interface Harness { dir: string; workspace: string; extra: string; marker: string; snapshot: string; previousPath: string }

function setup(name: string, scenario: string): Harness {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), `weaver-im-qoder-${name}-`));
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  const extra = join(dir, 'extra'); mkdirSync(extra);
  copyFileSync(FIXTURE, join(dir, 'qodercli')); chmodSync(join(dir, 'qodercli'), 0o755);
  const harness = { dir, workspace, extra, marker: join(dir, 'marker.ndjson'), snapshot: join(dir, 'snapshot.json'), previousPath: process.env.PATH ?? '' };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.QODER_FIXTURE_SCENARIO = scenario;
  process.env.QODER_FIXTURE_MARKER = harness.marker;
  process.env.QODER_FIXTURE_SNAPSHOT = harness.snapshot;
  return harness;
}

const launch: ParentProcessLauncher = (command, cwd, extraEnv) => spawn(command[0], command.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });

function input(harness: Harness, over: Record<string, unknown> = {}) {
  return { engineKind: 'qodercli' as const, model: 'fixture-model', effort: 'high', workspace: harness.workspace, additionalWorkspaces: [harness.extra], instructions: '你是飞书 IM 父 Agent，只做对话', ...over };
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
  for (const key of ['QODER_FIXTURE_SCENARIO', 'QODER_FIXTURE_MARKER', 'QODER_FIXTURE_SNAPSHOT']) delete process.env[key];
  for (const entry of markers(harness)) if (typeof entry.spawnPid === 'number') await until(() => { try { process.kill(entry.spawnPid as number, 0); return false; } catch { return true; } }, 'qoder fixture exit', 3000);
  rmSync(harness.dir, { recursive: true, force: true });
}

test('qoder initializes without a user prompt and keeps one process/context across turns', async () => {
  const harness = setup('multi', 'default');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 700 });
    sessions.add(session);
    assert.equal(markers(harness).filter(entry => typeof entry.turn === 'number').length, 0, 'startup must not send a user turn');
    const deltas: string[] = [];
    let firstDeltaAt = 0, resolvedAt = 0;
    const pending = session.send('第一轮', undefined, chunk => { firstDeltaAt ||= performance.now(); deltas.push(chunk); }).then(value => { resolvedAt = performance.now(); return value; });
    assert.equal(await pending, '最终回答1');
    assert.ok(firstDeltaAt > 0 && resolvedAt > firstDeltaAt);
    assert.deepEqual(deltas, ['回答1']);
    assert.ok(!deltas.join('').includes('SECRET'));
    assert.equal(await session.send('第二轮'), '最终回答2');
    const turns = markers(harness).filter(entry => typeof entry.turn === 'number');
    assert.equal(turns.length, 2);
    assert.equal(new Set(turns.map(entry => entry.pid)).size, 1, 'turns must reuse the resident process');
    await session.close();
  } finally { await teardown(harness); }
});

test('qoder interrupt requires both the control ACK and the matching result, then reuses the context', async () => {
  const harness = setup('abort', 'abort');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 900 });
    sessions.add(session);
    const controller = new AbortController();
    let settled = false;
    const pending = session.send('取消', controller.signal, () => controller.abort()).finally(() => { settled = true; });
    const checked = assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    await until(() => markers(harness).some(entry => entry.interruptRequest), 'interrupt requested');
    assert.equal(settled, false, 'cancel settled before the control ACK and result');
    await checked;
    assert.equal(await session.send('第二轮'), '最终回答2');
    assert.equal(new Set(markers(harness).filter(entry => typeof entry.turn === 'number' && typeof entry.pid === 'number').map(entry => entry.pid)).size, 1);
    await session.close();
  } finally { await teardown(harness); }
});

for (const [name, scenario, pattern] of [
  ['missing result', 'missing-terminal', /interrupt|timed out/i],
  ['missing ACK', 'missing-ack', /interrupt|timed out|rejected/i],
] as const) test(`qoder ${name} closes instead of claiming a stop or replaying`, async () => {
  const harness = setup(name.replaceAll(' ', '-'), scenario);
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 250 });
    sessions.add(session);
    const controller = new AbortController();
    await assert.rejects(session.send('取消', controller.signal, () => controller.abort()), pattern);
    await session.close();
    await assert.rejects(session.send('下一轮'), /closed|exited/i);
  } finally { await teardown(harness); }
});

test('qoder authentication failures expose only the auth reason', async () => {
  const harness = setup('auth', 'auth');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 500 });
    sessions.add(session);
    await assert.rejects(session.send('问题'), error => error instanceof ParentAgentError && error.reason === 'auth' && !error.message.includes('timed out'));
    await session.close();
  } finally { await teardown(harness); }
});

test('qoder zero-delta auth result shapes settle as auth instead of timing out', async () => {
  for (const scenario of ['auth-code', 'auth-success-error']) {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1500, closeMs: 500 });
      sessions.add(session);
      await assert.rejects(session.send('问题'), error => error instanceof ParentAgentError && error.reason === 'auth' && !error.message.includes('timed out'));
      await session.close();
    } finally { await teardown(harness); }
  }
});

test('qoder settles a zero-delta provider error before the turn timeout', async () => {
  const harness = setup('result-error', 'result-error');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1500, closeMs: 500 });
    sessions.add(session);
    await assert.rejects(session.send('问题'), error => error instanceof ParentAgentError && error.reason === 'engine' && !error.message.includes('timed out'));
    await session.close();
  } finally { await teardown(harness); }
});

test('qoder treats an attributable top-level error as fatal instead of ignoring it', async () => {
  for (const [scenario, reason] of [['top-error', 'engine'], ['top-error-auth', 'auth']] as const) {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1500, closeMs: 500 });
      sessions.add(session);
      await assert.rejects(session.send('问题'), error => error instanceof ParentAgentError && error.reason === reason && !error.message.includes('timed out'));
      await assert.rejects(session.send('下一轮'), /closed|exited/i);
      await session.close();
    } finally { await teardown(harness); }
  }
});

test('qoder ignores foreign, duplicate, stale and subagent errors without releasing the next turn', async () => {
  const harness = setup('stale-foreign-error', 'stale-foreign-error');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 500 });
    sessions.add(session);
    await assert.rejects(session.send('第一轮'), error => error instanceof ParentAgentError && error.reason === 'engine' && !error.message.includes('timed out'));
    assert.equal(await session.send('第二轮'), '最终回答2');
    await session.close();
  } finally { await teardown(harness); }
});

test('qoder keeps a foreign error from confirming cancellation and still accepts the matching terminal', async () => {
  const harness = setup('abort-foreign-error', 'abort-foreign-error');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 900 });
    sessions.add(session);
    const controller = new AbortController();
    let settled = false;
    const pending = session.send('取消', controller.signal, () => controller.abort()).finally(() => { settled = true; });
    const checked = assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    await until(() => markers(harness).some(entry => entry.interruptRequest), 'interrupt requested');
    assert.equal(settled, false, 'a foreign error must not confirm cancellation');
    await checked;
    assert.equal(await session.send('第二轮'), '最终回答2');
    await session.close();
  } finally { await teardown(harness); }
});

test('qoder keeps nonfatal mirror_error notifications from failing the turn', async () => {
  const harness = setup('mirror-notice', 'mirror-notice');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('问题'), '最终回答1');
    await session.close();
  } finally { await teardown(harness); }
});

test('qoder rejects a different resolved model', async () => {
  const harness = setup('model', 'model-mismatch');
  try {
    await assert.rejects(createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1000, closeMs: 400 }), error => error instanceof ParentAgentError && error.reason === 'protocol');
  } finally { await teardown(harness); }
});

test('qoder denies can_use_tool requests without a phone approval channel', async () => {
  const harness = setup('permission', 'permission');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('运行命令'), '工具使用被拒绝');
    const response = markers(harness).find(entry => entry.controlResponse) as { controlResponse: { response: { response: { behavior: string; message: string } } } } | undefined;
    assert.equal(response?.controlResponse.response.response.behavior, 'deny');
    assert.ok((response?.controlResponse.response.response.message ?? '').length > 0);
    await session.close();
  } finally { await teardown(harness); }
});

test('qoder ignores a stale result before the current turn stream and uses the current result', async () => {
  const harness = setup('old', 'old-terminal');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('第一轮'), '最终回答1');
    assert.equal(await session.send('第二轮'), '最终回答2');
    await session.close();
  } finally { await teardown(harness); }
});

test('qoder gives each chat/user its own resident process and context', async () => {
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

test('qoder argv uses the public stream-json protocol, native permissions and --add-dir', async () => {
  const harness = setup('args', 'default');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 500 });
    sessions.add(session);
    await session.send('问题');
    await session.close();
    assert.equal(statSync(harness.snapshot).mode & 0o777, 0o600);
    const snapshot = JSON.parse(readFileSync(harness.snapshot, 'utf8')) as { argv: string[] };
    for (const flag of ['-p', '--input-format', '--output-format', '--include-partial-messages', '--no-session-persistence']) assert.ok(snapshot.argv.includes(flag), `missing ${flag}`);
    assert.ok(snapshot.argv.includes('stream-json'));
    assert.equal(snapshot.argv[snapshot.argv.indexOf('--add-dir') + 1], harness.extra);
    assert.ok(!snapshot.argv.includes('bypass_permissions'));
    assert.ok(!snapshot.argv.includes('--permission-mode'));
  } finally { await teardown(harness); }
});

test('qoder emits one start per turn and one progress line per top-level tool only', async () => {
  const harness = setup('progress', 'progress');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 3000, closeMs: 700 });
    sessions.add(session);
    const first: ParentProgressEvent[] = [];
    assert.equal(await session.send('第一轮', undefined, undefined, { onProgress: event => first.push(event) }), '最终回答1');
    assert.deepEqual(first, [
      { kind: 'stage', name: '开始' },
      { kind: 'tool', name: 'Bash' },
      { kind: 'tool', name: 'Grep' },
    ]);
    const serialized = JSON.stringify(first);
    for (const secret of ['SECRET', '/home', 'command', 'pattern']) assert.ok(!serialized.includes(secret), serialized);

    const second: ParentProgressEvent[] = [];
    assert.equal(await session.send('第二轮', undefined, undefined, { onProgress: event => second.push(event) }), '最终回答2');
    assert.deepEqual(second, [
      { kind: 'stage', name: '开始' },
      { kind: 'tool', name: 'Write' },
      { kind: 'tool', name: 'Edit' },
    ]);
    await session.close();
  } finally { await teardown(harness); }
});

test('qoder emits no progress without onProgress or on hidden identity turns', async () => {
  const harness = setup('progress-opt', 'progress');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 3000, closeMs: 700 });
    sessions.add(session);
    const deltas: string[] = [];
    assert.equal(await session.send('第一轮', undefined, chunk => deltas.push(chunk)), '最终回答1');
    assert.deepEqual(deltas, ['回答1']);

    const hidden: ParentProgressEvent[] = [];
    const hiddenDeltas: string[] = [];
    assert.equal(await session.send('身份确认', undefined, chunk => hiddenDeltas.push(chunk), {
      finalAssistantOnly: true,
      onProgress: event => hidden.push(event),
    }), '最终回答2');
    assert.deepEqual(hidden, []);
    assert.deepEqual(hiddenDeltas, ['回答2']);
    await session.close();
  } finally { await teardown(harness); }
});

test('qoder progress callback failures never affect the text turn', async () => {
  const harness = setup('progress-throw', 'progress');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 3000, closeMs: 700 });
    sessions.add(session);
    const deltas: string[] = [];
    let calls = 0;
    const final = await session.send('第一轮', undefined, chunk => deltas.push(chunk), {
      onProgress: () => { calls++; throw new Error('progress callback failed'); },
    });
    assert.equal(final, '最终回答1');
    assert.deepEqual(deltas, ['回答1']);
    assert.equal(calls, 3);
    await session.close();
  } finally { await teardown(harness); }
});

test('qoder stops emitting progress after abort and never reports late tool frames', async () => {
  const harness = setup('abort-progress', 'abort');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 3000, closeMs: 900 });
    sessions.add(session);
    const progress: ParentProgressEvent[] = [];
    const controller = new AbortController();
    const pending = session.send('取消', controller.signal, () => controller.abort(), {
      onProgress: event => {
        progress.push(event);
        if (event.kind === 'tool') controller.abort();
      },
    });
    await assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    const settled = [...progress];
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(progress, settled);
    assert.ok(progress.some(event => event.name === 'EarlyTool'));
    assert.ok(!progress.some(event => event.name === 'LateTool'));
    assert.equal(progress.filter(event => event.kind === 'stage').length, 1);
    await session.close();
  } finally { await teardown(harness); }
});
