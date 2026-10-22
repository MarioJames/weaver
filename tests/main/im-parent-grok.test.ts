import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfirmedParentCancellation, ParentAgentError, createParentAgent, type ParentAgentSession, type ParentProcessLauncher } from '../../src/main/im/parent-agent';

const FIXTURE = new URL('../fixtures/parent/grok-fixture.mjs', import.meta.url).pathname;
const sessions = new Set<ParentAgentSession>();

interface Harness { dir: string; workspace: string; extra: string; marker: string; snapshot: string; previousPath: string }

function setup(name: string, scenario: string): Harness {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), `weaver-im-grok-${name}-`));
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  const extra = join(dir, 'extra'); mkdirSync(extra);
  copyFileSync(FIXTURE, join(dir, 'grok')); chmodSync(join(dir, 'grok'), 0o755);
  const harness = { dir, workspace, extra, marker: join(dir, 'marker.ndjson'), snapshot: join(dir, 'snapshot.json'), previousPath: process.env.PATH ?? '' };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.GROK_FIXTURE_SCENARIO = scenario;
  process.env.GROK_FIXTURE_MARKER = harness.marker;
  process.env.GROK_FIXTURE_SNAPSHOT = harness.snapshot;
  return harness;
}

const launch: ParentProcessLauncher = (command, cwd, extraEnv) => spawn(command[0], command.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });

function input(harness: Harness, over: Record<string, unknown> = {}) {
  return { engineKind: 'grok' as const, model: 'fixture-model', effort: 'high', workspace: harness.workspace, additionalWorkspaces: [harness.extra], instructions: '你是飞书 IM 父 Agent，只做对话', ...over };
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
  for (const key of ['GROK_FIXTURE_SCENARIO', 'GROK_FIXTURE_MARKER', 'GROK_FIXTURE_SNAPSHOT']) delete process.env[key];
  for (const entry of markers(harness)) if (typeof entry.spawnPid === 'number') await until(() => { try { process.kill(entry.spawnPid as number, 0); return false; } catch { return true; } }, 'grok fixture exit', 3000);
  rmSync(harness.dir, { recursive: true, force: true });
}

test('grok handshakes ACP without a prompt and reuses one process for later turns', async () => {
  const harness = setup('multi', 'default');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 700 });
    sessions.add(session);
    assert.equal(markers(harness).filter(entry => typeof entry.turn === 'number').length, 0, 'startup must not send a prompt');
    const deltas: string[] = [];
    let firstDeltaAt = 0, resolvedAt = 0;
    const pending = session.send('第一轮', undefined, chunk => { firstDeltaAt ||= performance.now(); deltas.push(chunk); }).then(value => { resolvedAt = performance.now(); return value; });
    assert.equal(await pending, '回答1');
    assert.ok(firstDeltaAt > 0 && resolvedAt > firstDeltaAt);
    assert.deepEqual(deltas, ['回答1']);
    assert.ok(!deltas.join('').includes('SECRET'));
    assert.equal(await session.send('第二轮'), '回答2');
    const turns = markers(harness).filter(entry => typeof entry.turn === 'number');
    assert.equal(turns.length, 2);
    assert.equal(new Set(turns.map(entry => entry.pid)).size, 1, 'turns must reuse the resident ACP process');
    await session.close();
  } finally { await teardown(harness); }
});

test('grok confirms cancellation only from the matching prompt response stopReason=cancelled', async () => {
  const harness = setup('abort', 'abort');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 700 });
    sessions.add(session);
    const controller = new AbortController();
    let settled = false;
    const pending = session.send('取消', controller.signal, () => controller.abort()).finally(() => { settled = true; });
    const checked = assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    await until(() => markers(harness).some(entry => entry.cancel), 'cancel notification');
    assert.equal(settled, false, 'the cancel notification alone released the send');
    await checked;
    assert.equal(await session.send('第二轮'), '回答2');
    await session.close();
  } finally { await teardown(harness); }
});

for (const [name, scenario, pattern] of [
  ['missing cancel response', 'missing-cancel-response', /cancel|timed out/i],
  ['cancel/success race', 'cancel-race', /completed before cancellation/i],
] as const) test(`grok ${name} closes without claiming a confirmed stop`, async () => {
  const harness = setup(name.replaceAll(/[^a-z0-9]+/gi, '-'), scenario);
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 250 });
    sessions.add(session);
    const controller = new AbortController();
    await assert.rejects(session.send('取消', controller.signal, () => controller.abort()), pattern);
    await session.close();
    await assert.rejects(session.send('下一轮'), /closed|exited/i);
  } finally { await teardown(harness); }
});

test('grok authentication and protocol failures stay bounded', async () => {
  for (const [scenario, reason] of [['auth-failed', 'auth'], ['initialize-failed', 'protocol']] as const) {
    const harness = setup(scenario, scenario);
    try {
      await assert.rejects(createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1000, closeMs: 400 }), error => error instanceof ParentAgentError && error.reason === reason);
    } finally { await teardown(harness); }
  }
});

test('grok rejects a resolved model or effort that does not match the configured route', async () => {
  for (const scenario of ['model-mismatch', 'effort-mismatch']) {
    const harness = setup(scenario, scenario);
    try {
      await assert.rejects(createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1000, closeMs: 400 }), error => error instanceof ParentAgentError && error.reason === 'protocol');
    } finally { await teardown(harness); }
  }
});

test('grok rejects a tool permission request instead of auto-approving', async () => {
  const harness = setup('permission', 'permission');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 500 });
    sessions.add(session);
    assert.equal(await session.send('运行'), '回答1，工具被拒绝');
    const response = markers(harness).find(entry => entry.permissionResponse) as { permissionResponse: { outcome: { outcome: string; optionId?: string } } } | undefined;
    assert.equal(response?.permissionResponse.outcome.outcome, 'selected');
    assert.equal(response?.permissionResponse.outcome.optionId, 'reject-once');
    await session.close();
  } finally { await teardown(harness); }
});

test('grok gives each chat/user its own resident process and context', async () => {
  const harness = setup('isolation', 'default');
  try {
    const first = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1500, closeMs: 400 });
    assert.equal(await first.send('会话一'), '回答1');
    await first.close();
    const second = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 1500, closeMs: 400 });
    assert.equal(await second.send('会话二'), '回答1');
    await second.close();
    const pids = markers(harness).filter(entry => entry.event === 'spawn').map(entry => entry.spawnPid);
    assert.equal(new Set(pids).size, 2, 'separate parent sessions must not share a process');
    for (const pid of pids) assert.equal(markers(harness).filter(entry => entry.pid === pid && typeof entry.turn === 'number').length, 1);
  } finally { await teardown(harness); }
});

test('grok reports unified progress: stage once plus one event per top-level tool kind', async () => {
  const harness = setup('progress', 'progress');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 700 });
    sessions.add(session);
    const deltas: string[] = [];
    const progress: Array<{ kind: string; name: string }> = [];
    assert.equal(await session.send('第一轮', undefined, chunk => deltas.push(chunk), { onProgress: event => progress.push(event) }), '回答1');
    assert.deepEqual(deltas, ['回答', '1']);
    assert.deepEqual(progress, [
      { kind: 'stage', name: '开始' },
      { kind: 'tool', name: 'execute' },
      { kind: 'tool', name: 'read' },
    ]);
    const leaked = JSON.stringify(progress);
    for (const secret of ['SECRET_CMD', 'SECRET_TOKEN', 'SECRET_THOUGHT', 'SECRET_PLAN', 'SECRET_FOREIGN_TOOL', 'SECRET_PATH', 'SECRET_PW', '/etc/']) {
      assert.ok(!leaked.includes(secret), `progress leaked ${secret}: ${leaked}`);
    }
    await session.close();
  } finally { await teardown(harness); }
});

test('grok progress stays silent without onProgress or with finalAssistantOnly; throwing onProgress keeps the text turn', async () => {
  const harness = setup('progress-silent', 'progress');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 700 });
    sessions.add(session);
    const silent: string[] = [];
    assert.equal(await session.send('无回调', undefined, chunk => silent.push(chunk)), '回答1');
    assert.deepEqual(silent, ['回答', '1']);
    const hidden: Array<{ kind: string; name: string }> = [];
    assert.equal(await session.send('隐藏轮', undefined, undefined, { finalAssistantOnly: true, onProgress: event => hidden.push(event) }), '回答2');
    assert.deepEqual(hidden, [], 'finalAssistantOnly must not emit progress');
    const throwing: string[] = [];
    assert.equal(await session.send('抛错回调', undefined, chunk => throwing.push(chunk), { onProgress: () => { throw new Error('progress boom'); } }), '回答3');
    assert.deepEqual(throwing, ['回答3']);
    await session.close();
  } finally { await teardown(harness); }
});

test('grok never reports progress for tool frames arriving after abort', async () => {
  const harness = setup('progress-abort', 'abort');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 700 });
    sessions.add(session);
    const controller = new AbortController();
    const progress: Array<{ kind: string; name: string }> = [];
    const pending = session.send('取消', controller.signal, () => controller.abort(), { onProgress: event => progress.push(event) });
    await assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    // The first session/update legitimately proves the turn started; the tool frame that
    // arrives after cancellation must not emit.
    assert.deepEqual(progress, [{ kind: 'stage', name: '开始' }], `late tool frame must not emit: ${JSON.stringify(progress)}`);
    await session.close();
  } finally { await teardown(harness); }
});

test('grok argv uses ACP stdio and never adds multi-root or always-approve', async () => {
  const harness = setup('args', 'default');
  try {
    const session = await createParentAgent(input(harness), { launch, startupMs: 3000, turnMs: 2000, closeMs: 500 });
    sessions.add(session);
    await session.send('问题');
    await session.close();
    assert.equal(statSync(harness.snapshot).mode & 0o777, 0o600);
    const snapshot = JSON.parse(readFileSync(harness.snapshot, 'utf8')) as { argv: string[] };
    for (const value of ['agent', 'stdio', '--no-leader', '--model', '--reasoning-effort']) assert.ok(snapshot.argv.includes(value), `missing ${value}`);
    for (const value of ['--add-dir', 'additionalDirectories', '--always-approve']) assert.ok(!snapshot.argv.includes(value), `unexpected ${value}`);
  } finally { await teardown(harness); }
});
