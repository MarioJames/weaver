import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfirmedParentCancellation, createParentAgent as baseCreateParentAgent, type ParentAgentSession } from '../../src/main/im/parent-agent';

const sessions = new Set<ParentAgentSession>();
const createParentAgent: typeof baseCreateParentAgent = async (...args) => {
  const session = await baseCreateParentAgent(...args);
  sessions.add(session);
  return session;
};

const FIXTURE = new URL('../fixtures/parent/claude-fixture.mjs', import.meta.url).pathname;

interface Harness {
  dir: string;
  workspace: string;
  marker: string;
  snapshot: string;
  previousPath: string;
}

function setup(name: string, scenario: string, envLeaks = false): Harness {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), `weaver-im-claude-${name}-`));
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  copyFileSync(FIXTURE, join(dir, 'claude'));
  chmodSync(join(dir, 'claude'), 0o755);
  writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(join(dir, 'systemctl'), '#!/bin/sh\necho ActiveState=inactive\n', { mode: 0o700 });
  const harness: Harness = { dir, workspace, marker: join(dir, 'marker.ndjson'), snapshot: join(dir, 'snapshot.json'), previousPath: process.env.PATH ?? '' };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.CLAUDE_FIXTURE_SCENARIO = scenario;
  process.env.CLAUDE_FIXTURE_MARKER = harness.marker;
  if (envLeaks) {
    process.env.CLAUDE_FIXTURE_SNAPSHOT = harness.snapshot;
    process.env.CODEX_SESSION_ID = 'leak-thread';
    process.env.CODEX_THREAD_ID = 'leak-thread';
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'leak';
    process.env.HERDR_TOKEN = 'leak';
    process.env.WEAVER_TASK_ID = 'leak-task';
    process.env.WEAVER_WORKER_ID = 'leak-worker';
  }
  return harness;
}

async function teardown(harness: Harness): Promise<void> {
  for (const session of sessions) await session.close();
  sessions.clear();
  process.env.PATH = harness.previousPath;
  for (const key of ['CLAUDE_FIXTURE_SCENARIO', 'CLAUDE_FIXTURE_MARKER', 'CLAUDE_FIXTURE_SNAPSHOT', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'HERDR_TOKEN', 'WEAVER_TASK_ID', 'WEAVER_WORKER_ID']) delete process.env[key];
  for (const entry of markerEntries(harness)) {
    if (typeof entry.spawnPid === 'number') assert.throws(() => process.kill(entry.spawnPid as number, 0), { code: 'ESRCH' }, 'fixture survived close');
  }
  rmSync(harness.dir, { recursive: true, force: true });
}

function markerEntries(harness: Harness): Array<Record<string, unknown>> {
  if (!existsSync(harness.marker)) return [];
  return readFileSync(harness.marker, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

async function until(predicate: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not reached: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function input(harness: Harness) {
  return { engineKind: 'claude' as const, model: 'fixture-model', effort: 'high', workspace: harness.workspace, instructions: '你是飞书IM父Agent，只做对话' };
}

test('claude parent session keeps one process across turns and streams only public text deltas', async () => {
  const harness = setup('multi', 'default');
  try {
    const session = await createParentAgent(input(harness));
    const deltas: string[] = [];
    let resolved = false;
    const pending = session.send('第一轮', undefined, chunk => deltas.push(chunk)).then(value => { resolved = true; return value; });
    await until(() => deltas.length >= 2, 'deltas before result');
    assert.equal(resolved, false);
    assert.equal(await pending, '最终回答1');
    // Reasoning, tool JSON and subagent text must never reach the streaming callback.
    assert.ok(!deltas.join('').includes('SECRET'));
    assert.deepEqual(deltas, ['你好，', '世界']);
    assert.equal(await session.send('第二轮'), '最终回答2');
    const messages = markerEntries(harness).filter(entry => typeof entry.message === 'number');
    assert.equal(messages.length, 2);
    assert.equal(new Set(messages.map(entry => entry.pid)).size, 1, 'each send must reuse the same resident process');
    await session.close();
  } finally { await teardown(harness); }
});

test('claude result frames from background work do not release the current send', async () => {
  const harness = setup('background', 'background');
  try {
    const session = await createParentAgent(input(harness));
    let resolved = false;
    const pending = session.send('问题').then(value => { resolved = true; return value; });
    // The background result is emitted ~40ms in; the real result ~190ms in.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(resolved, false, 'a result that does not match the input uuid released the send');
    assert.equal(await pending, '最终回答');
    await session.close();
  } finally { await teardown(harness); }
});

test('claude error results fail the send with a bounded message', async () => {
  const harness = setup('error', 'error');
  try {
    const session = await createParentAgent(input(harness));
    await assert.rejects(session.send('问题'), /error_during_execution.*boom failed badly/s);
    await session.close();
  } finally { await teardown(harness); }
});

test('claude results without uuid attribution fail closed', async () => {
  const harness = setup('unattributed', 'unattributed');
  try {
    const session = await createParentAgent(input(harness));
    await assert.rejects(session.send('问题'), /attributed/i);
    await session.close();
  } finally { await teardown(harness); }
});

test('claude events for another session fail closed instead of mixing context', async () => {
  const harness = setup('wrong-session', 'wrong-session');
  try {
    const session = await createParentAgent(input(harness));
    await assert.rejects(session.send('问题'), /different session/i);
    await session.close();
  } finally { await teardown(harness); }
});

test('claude permission control requests are denied explicitly and the turn still ends', async () => {
  const harness = setup('control', 'control');
  try {
    const session = await createParentAgent(input(harness));
    assert.equal(await session.send('运行命令'), '工具使用被拒绝，需要用户在本地设置中授权');
    const entry = markerEntries(harness).find(item => item.controlResponse) as { controlResponse: { response: { behavior: string; message: string } } } | undefined;
    assert.ok(entry, 'fixture never received the control response');
    assert.equal(entry.controlResponse.response.behavior, 'deny');
    assert.ok(entry.controlResponse.response.message.length > 0);
    assert.ok(!/api[_-]?key|token/i.test(entry.controlResponse.response.message));
    await session.close();
  } finally { await teardown(harness); }
});

test('claude abort waits for terminal and immediately reuses the resident session', async () => {
  const harness = setup('abort', 'abort');
  try {
    const session = await createParentAgent(input(harness));
    try {
      const controller = new AbortController();
      let settled = false;
      const deltas: string[] = [];
      const pending = session.send('会被取消', controller.signal, chunk => { deltas.push(chunk); controller.abort(); });
      const checked = assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError').then(() => { settled = true; });
      await until(() => markerEntries(harness).some(entry => entry.interruptRequested), 'interrupt requested');
      assert.equal(settled, false, 'cancel settled before matching terminal');
      await assert.rejects(session.send('过早'), /in progress/);
      await checked;
      const nextDeltas: string[] = [];
      assert.equal(await session.send('第二轮', undefined, chunk => nextDeltas.push(chunk)), '最终回答2');
      assert.ok(!nextDeltas.join('').includes('OLD'));
      assert.ok(!nextDeltas.join('').includes('MISSING-ID'));
      assert.equal(deltas.length, 1);
      const turns = markerEntries(harness).filter(entry => entry.pid);
      assert.equal(new Set(turns.map(entry => entry.pid)).size, 1);
    } finally { await session.close(); }
  } finally { await teardown(harness); }
});

for (const scenario of ['interrupt-failed', 'missing-terminal']) {
  test(`claude ${scenario} closes instead of retaining an unreliable session`, async () => {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness), { turnMs: 2000, closeMs: 300 });
      try {
        const controller = new AbortController();
        await assert.rejects(session.send('取消', controller.signal, () => controller.abort()), /interrupt|timed out|control request was rejected/);
        await session.close();
        await assert.rejects(session.send('下一轮'), /closed/);
        const alreadyAborted = new AbortController();
        alreadyAborted.abort(new ConfirmedParentCancellation());
        await assert.rejects(session.send('提前取消且已关闭', alreadyAborted.signal), error => !(error instanceof ConfirmedParentCancellation));
      } finally { await session.close(); }
    } finally { await teardown(harness); }
  });
}

test('claude turn wait is bounded and releases the send on timeout', async () => {
  const harness = setup('slow', 'slow');
  try {
    const session = await createParentAgent(input(harness), { turnMs: 300, startupMs: 5000, closeMs: 5000 });
    await assert.rejects(session.send('慢问题'), /timed out/i);
    await session.close();
    await session.close();
  } finally { await teardown(harness); }
});

test('claude parent agent launches with sanitized environment and fixed argv', async () => {
  const harness = setup('env', 'default', true);
  try {
    const session = await createParentAgent(input(harness));
    assert.equal(await session.send('问题'), '最终回答1');
    await session.close();
    assert.equal(statSync(harness.snapshot).mode & 0o777, 0o600);
      const snapshot = JSON.parse(readFileSync(harness.snapshot, 'utf8')) as { argv: string[]; env: Record<string, string>; hasHome: boolean };
    assert.ok(snapshot.argv[1].endsWith('/claude'));
    for (const flag of ['-p', '--input-format', '--output-format', '--verbose', '--model', '--effort', '--no-session-persistence', '--include-partial-messages', '--append-system-prompt']) {
      assert.ok(snapshot.argv.includes(flag), `missing ${flag}`);
    }
    assert.deepEqual(snapshot.argv.filter(value => value === 'stream-json').length >= 2, true);
    assert.equal(snapshot.argv[snapshot.argv.indexOf('--model') + 1], 'fixture-model');
    assert.equal(snapshot.argv[snapshot.argv.indexOf('--effort') + 1], 'high');
    assert.equal(snapshot.argv[snapshot.argv.indexOf('--append-system-prompt') + 1], '你是飞书IM父Agent，只做对话');
    assert.ok(!snapshot.argv.includes('--dangerously-skip-permissions'));
    assert.ok(!snapshot.argv.includes('bypassPermissions'));
    assert.equal(snapshot.hasHome, true);
    for (const key of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'HERDR_TOKEN', 'WEAVER_TASK_ID', 'WEAVER_WORKER_ID']) {
      assert.equal(key in snapshot.env, false, `${key} leaked into the parent agent environment`);
    }
  } finally { await teardown(harness); }
});

test('claude factory fails fast when the CLI is missing', async () => {
  const harness = setup('missing', 'default');
  try {
    process.env.PATH = harness.dir.replace(/\/[^/]+$/, '');
    await assert.rejects(createParentAgent(input(harness)), /claude CLI was not found/i);
  } finally { await teardown(harness); }
});

test('claude startup rejection closes its resident process', async () => {
  const harness = setup('startup-failed', 'startup-failed');
  try { await assert.rejects(createParentAgent(input(harness)), /rejected|initialize failed/); }
  finally { await teardown(harness); }
});

test('claude terminal waits for a late interrupt acknowledgement before next send', async () => {
  const harness = setup('late-ack', 'late-ack');
  try {
    const session = await createParentAgent(input(harness));
    const controller = new AbortController();
    let settled = false;
    const checked = assert.rejects(session.send('取消', controller.signal, () => controller.abort()), error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError').then(() => { settled = true; });
    await until(() => markerEntries(harness).some(entry => entry.interrupted), 'terminal before ack');
    assert.equal(settled, false);
    await checked;
    assert.equal(await session.send('继续'), '最终回答2');
  } finally { await teardown(harness); }
});

for (const scenario of ['callback-failed', 'exit-mid-turn']) {
  test(`claude ${scenario} closes and rejects reuse`, async () => {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness));
      await assert.rejects(session.send('问题', undefined, scenario === 'callback-failed' ? () => { throw new Error('callback failed'); } : undefined), /callback failed|exited/);
      await session.close();
      await assert.rejects(session.send('继续'), /closed/);
    } finally { await teardown(harness); }
  });
}
