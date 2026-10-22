import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfirmedParentCancellation, createParentAgent, type ParentAgentInternals, type ParentAgentSession } from '../../src/main/im/parent-agent';

const FIXTURE = new URL('../fixtures/parent/codex-fixture.mjs', import.meta.url).pathname;

interface Harness {
  dir: string;
  workspace: string;
  marker: string;
  snapshot: string;
  previousPath: string;
}

function setup(name: string, scenario: string, envLeaks = false): Harness {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), `weaver-im-codex-${name}-`));
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  copyFileSync(FIXTURE, join(dir, 'codex'));
  chmodSync(join(dir, 'codex'), 0o755);
  writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(join(dir, 'systemctl'), '#!/bin/sh\necho ActiveState=inactive\n', { mode: 0o700 });
  const harness: Harness = { dir, workspace, marker: join(dir, 'marker.ndjson'), snapshot: join(dir, 'snapshot.json'), previousPath: process.env.PATH ?? '' };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.CODEX_FIXTURE_SCENARIO = scenario;
  process.env.CODEX_FIXTURE_MARKER = harness.marker;
  if (envLeaks) {
    process.env.CODEX_FIXTURE_SNAPSHOT = harness.snapshot;
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

function teardown(harness: Harness): void {
  process.env.PATH = harness.previousPath;
  for (const key of ['CODEX_FIXTURE_SCENARIO', 'CODEX_FIXTURE_MARKER', 'CODEX_FIXTURE_SNAPSHOT', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'HERDR_TOKEN', 'WEAVER_TASK_ID', 'WEAVER_WORKER_ID']) delete process.env[key];
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
  return { engineKind: 'codex' as const, model: 'fixture-model', effort: 'high', workspace: harness.workspace, instructions: '你是飞书IM父Agent，只做对话' };
}

/** Always closes the session, even when assertions fail, so fixture processes never leak. */
async function withSession<T>(harness: Harness, run: (session: ParentAgentSession) => Promise<T>, internals?: ParentAgentInternals): Promise<T> {
  const session = await createParentAgent(input(harness), internals);
  try {
    return await run(session);
  } finally {
    await session.close().catch(() => { /* close failures are asserted explicitly where relevant */ });
  }
}

test('codex parent session keeps one process across turns and streams only the final answer', async () => {
  const harness = setup('multi', 'default');
  try {
    await withSession(harness, async session => {
      const deltas: string[] = [];
      let resolved = false;
      const pending = session.send('第一轮', undefined, chunk => deltas.push(chunk)).then(value => { resolved = true; return value; });
      await until(() => deltas.length >= 2, 'deltas before result');
      assert.equal(resolved, false);
      assert.equal(await pending, '回答1');
      assert.ok(deltas.join('').includes('进度: '));
      // 同一 turn 内不同 agentMessage item 之间补段落分隔，同一 item 内分片连续。
      assert.deepEqual(deltas, ['进度: ', '\n\n回答1']);
      // The second turn runs in the same process and sees the same thread context.
      const secondDeltas: string[] = [];
      assert.equal(await session.send('第二轮', undefined, chunk => secondDeltas.push(chunk)), '回答2');
      const turns = markerEntries(harness).filter(entry => typeof entry.turn === 'number');
      assert.equal(turns.length, 2);
      assert.equal(new Set(turns.map(entry => entry.pid)).size, 1, 'each send must reuse the same resident process');
    });
  } finally { teardown(harness); }
});

test('codex tolerates notifications racing ahead of the turn/start response', async () => {
  const harness = setup('race', 'race');
  try {
    await withSession(harness, async session => {
      assert.equal(await session.send('问题'), '竞态回答');
      assert.equal(await session.send('再问'), '竞态回答');
    });
  } finally { teardown(harness); }
});

test('codex ignores other-thread and wrong-turn events and returns the matched answer', async () => {
  const harness = setup('wrong-turn', 'wrong-turn');
  try {
    await withSession(harness, async session => {
      const deltas: string[] = [];
      const answer = await session.send('问题', undefined, chunk => deltas.push(chunk));
      assert.equal(answer, '正确回答');
      assert.ok(!deltas.join('').includes('WRONG'));
    });
  } finally { teardown(harness); }
});

test('codex declines approval requests explicitly and reports the interrupted turn', async () => {
  const harness = setup('approval', 'approval');
  try {
    await withSession(harness, async session => {
      await assert.rejects(session.send('删除文件'), /approval|denied|grant/i);
      const decision = markerEntries(harness).find(entry => entry.approvalDecision) as { approvalDecision: { decision: string } } | undefined;
      assert.ok(decision, 'fixture never received the approval answer');
      assert.equal(decision.approvalDecision.decision, 'cancel');
      // The session stays usable after a declined approval.
      assert.equal(await session.send('继续'), '回答2');
    });
  } finally { teardown(harness); }
});

test('codex answers unknown server tool requests with an explicit refusal and completes the turn', async () => {
  const harness = setup('unknown-request', 'unknown-request');
  try {
    await withSession(harness, async session => {
      assert.equal(await session.send('用客户端工具'), '工具调用被拒绝后的回答');
      const response = markerEntries(harness).find(entry => entry.toolCallResponse) as { toolCallResponse: { code: number } } | undefined;
      assert.ok(response, 'fixture never received the tool call answer');
      assert.equal(response.toolCallResponse.code, -32601);
    });
  } finally { teardown(harness); }
});

test('codex send fails when the app-server exits mid-turn; close is idempotent and real', async () => {
  const harness = setup('exit', 'exit-mid-turn');
  try {
    await withSession(harness, async session => {
      await assert.rejects(session.send('跑一半'), /exited/i);
      await session.close();
      await session.close();
      await assert.rejects(session.send('再发'), /closed/i);
      const pid = markerEntries(harness)[0].pid as number;
      await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'fixture process exited');
    });
  } finally { teardown(harness); }
});

test('codex fails clearly on non-JSON protocol lines', async () => {
  const harness = setup('garbage', 'garbage');
  try {
    await withSession(harness, async session => {
      await assert.rejects(session.send('问题'), /non-JSON protocol line/i);
    });
  } finally { teardown(harness); }
});

test('codex turn failure and terminal error notification produce a clear error', async () => {
  const harness = setup('failed', 'failed');
  try {
    await withSession(harness, async session => {
      await assert.rejects(session.send('问题'), /model backend exploded/i);
    });
  } finally { teardown(harness); }
});

test('codex turn wait is bounded and releases the send on timeout', async () => {
  const harness = setup('slow', 'slow');
  try {
    await withSession(harness, async session => {
      await assert.rejects(session.send('慢问题'), /timed out/i);
      await session.close();
      await session.close();
    }, { turnMs: 300, startupMs: 5000, closeMs: 5000 });
  } finally { teardown(harness); }
});

test('codex abort waits for terminal and immediately reuses the resident session', async () => {
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
      assert.equal(await session.send('第二轮', undefined, chunk => nextDeltas.push(chunk)), '回答2');
      assert.ok(!nextDeltas.join('').includes('OLD'));
      assert.ok(!nextDeltas.join('').includes('MISSING-ID'));
      assert.equal(deltas.length, 1);
      const turns = markerEntries(harness).filter(entry => entry.pid);
      assert.equal(new Set(turns.map(entry => entry.pid)).size, 1);
    } finally { await session.close(); }
  } finally { teardown(harness); }
});

for (const scenario of ['interrupt-failed', 'missing-terminal']) {
  test(`codex ${scenario} closes instead of retaining an unreliable session`, async () => {
    const harness = setup(scenario, scenario);
    try {
      const session = await createParentAgent(input(harness), { turnMs: 2000, closeMs: 300 });
      try {
        const controller = new AbortController();
        await assert.rejects(session.send('取消', controller.signal, () => controller.abort()), /interrupt|timed out/);
        await session.close();
        await assert.rejects(session.send('下一轮'), /closed/);
        const alreadyAborted = new AbortController();
        alreadyAborted.abort(new ConfirmedParentCancellation());
        await assert.rejects(session.send('提前取消且已关闭', alreadyAborted.signal), error => !(error instanceof ConfirmedParentCancellation));
      } finally { await session.close(); }
    } finally { teardown(harness); }
  });
}

test('codex streaming callback failure ends the send and cleans up', async () => {
  const harness = setup('delta-error', 'default');
  try {
    await withSession(harness, async session => {
      const pending = session.send('回调会炸', undefined, () => {
        throw new Error('consumer rejected the delta');
      });
      await assert.rejects(pending, /consumer rejected the delta/);
      await session.close();
      await assert.rejects(session.send('第二轮'), /closed/);
    });
  } finally { teardown(harness); }
});

test('codex parent agent launches with sanitized environment and fixed argv', async () => {
  const harness = setup('env', 'default', true);
  try {
    await withSession(harness, async session => {
      assert.equal(await session.send('问题'), '回答1');
      assert.equal(statSync(harness.snapshot).mode & 0o777, 0o600);
      const snapshot = JSON.parse(readFileSync(harness.snapshot, 'utf8')) as { argv: string[]; env: Record<string, string>; hasHome: boolean };
      assert.ok(snapshot.argv[1].endsWith('/codex'));
      assert.ok(snapshot.argv.includes('app-server'));
      assert.ok(snapshot.argv.includes('--listen'));
      assert.ok(snapshot.argv.includes('stdio://'));
      assert.ok(snapshot.argv.includes('model_reasoning_effort="high"'));
      assert.equal(snapshot.hasHome, true);
      for (const key of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'HERDR_TOKEN', 'WEAVER_TASK_ID', 'WEAVER_WORKER_ID']) {
        assert.equal(key in snapshot.env, false, `${key} leaked into the parent agent environment`);
      }
    });
  } finally { teardown(harness); }
});

test('codex factory fails fast when the CLI is missing', async () => {
  const harness = setup('missing', 'default');
  try {
    process.env.PATH = harness.dir.replace(/\/[^/]+$/, '');
    await assert.rejects(createParentAgent(input(harness)), /codex CLI was not found/i);
  } finally { teardown(harness); }
});

for (const scenario of ['abort-start', 'late-ack']) {
  test(`codex ${scenario} retains the slot through startup and interrupt acknowledgement`, async () => {
    const harness = setup(scenario, scenario);
    try {
      await withSession(harness, async session => {
        const controller = new AbortController();
        let settled = false;
        const pending = session.send('取消', controller.signal, () => controller.abort());
        const checked = assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError').then(() => { settled = true; });
        if (scenario === 'abort-start') {
          await until(() => markerEntries(harness).some(entry => entry.turn === 1), 'turn input accepted before start response');
          controller.abort();
          assert.equal(settled, false);
        }
        await until(() => markerEntries(harness).some(entry => entry.interruptRequested), 'interrupt request');
        assert.equal(settled, false);
        if (scenario === 'late-ack') {
          await until(() => markerEntries(harness).some(entry => entry.interrupted), 'terminal before ack');
          assert.equal(settled, false, 'terminal alone released the turn before interrupt ack');
        }
        await checked;
        assert.equal(await session.send('继续'), '回答2');
        const interrupt = markerEntries(harness).find(entry => entry.interruptRequested)?.interruptRequested;
        assert.deepEqual(interrupt, { threadId: 'thr-fixture', turnId: 'turn-1' });
      }, { closeMs: 1000 });
    } finally { teardown(harness); }
  });
}

test('codex startup rejection closes its resident process', async () => {
  const harness = setup('startup-failed', 'startup-failed');
  try { await assert.rejects(createParentAgent(input(harness)), /rejected|initialize failed/); }
  finally { teardown(harness); }
});
