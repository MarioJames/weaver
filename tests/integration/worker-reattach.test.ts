import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRuntime } from '../../src/main/runtime';
import { sendRequest } from '../../src/cli/client';
import { TaskStore } from '../../src/main/store';
import { __setRunUnitPrefixForTests } from '../../src/main/adapters/cli/run';
import { confirmScopeAbsent, inspectScope, recoverOwnedScope } from '../../src/main/adapters/cli/scope';

const enabled = process.env.WEAVER_WORKER_SCOPE_TEST === '1';
const TMP = mkdtempSync(join(tmpdir(), 'wv-reattach-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(message);
    await pause(100);
  }
};

async function requireRealSystemd(): Promise<void> {
  assert.equal(process.platform, 'linux', 'file scope tests require Linux');
  const state = await new Promise<string>(resolve => execFile('systemctl', ['--user', 'is-system-running'], (error, stdout) => resolve(String(stdout || error?.message || '').trim())));
  assert.ok(['running', 'degraded'].includes(state), `systemd user session unavailable: ${state}`);
}

function writeFixture(dir: string, body: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'codex');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return bin;
}

async function command(dataDir: string, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await sendRequest(dataDir, { apiVersion: 'weaver.v1', command: name, commandId: randomUUID(), args }) as { ok: boolean; data: any };
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
}

async function dispatch(dataDir: string, workspace: string): Promise<string> {
  const task = await command(dataDir, 'tasks.create', {
    title: 'reattach fixture',
    instruction: 'Write a bounded fixture stream only.',
    workspace,
    owner: { name: 'owner', transport: 'herdr-visible', session: 'main', pane: '1' },
  });
  await command(dataDir, 'packages.create', { taskId: task.id, scope: ['fixture only'], acceptanceCriteria: ['fixture output'] });
  await command(dataDir, 'workers.spawn', { taskId: task.id, owner: 'claude_owner', worker: 'codex_worker' });
  return task.id;
}

async function taskView(dataDir: string, id: string): Promise<any> {
  return command(dataDir, 'tasks.get', { taskId: id });
}

async function cleanup(unit: string, invocation?: string): Promise<void> {
  if (!unit) return;
  try { await recoverOwnedScope(unit, invocation); }
  catch {
    try { await new Promise<void>(resolve => execFile('systemctl', ['--user', 'stop', `${unit}.scope`], () => resolve())); } catch { /* exact unit already gone */ }
  }
}

const SLOW_BODY = [
  `printf '%s\\n' '{"type":"thread.started","thread_id":"sess-live"}'`,
  'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do printf \'%s\\n\' "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"PONG-$i\\"}}"; sleep 0.5; done',
  `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}'`,
  'exit 0',
].join('\n');

const END_AFTER_DOWNTIME_BODY = [
  `printf '%s\\n' '{"type":"thread.started","thread_id":"sess-downtime"}'`,
  `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"STARTED"}}'`,
  'sleep 3',
  `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}'`,
  'exit 0',
].join('\n');

test('a live worker survives close and is reattached by a second startRuntime with exactly one result', { skip: !enabled, timeout: 180000 }, async () => {
  await requireRealSystemd();
  mkdirSync(TMP, { recursive: true });
  const workspace = mkdtempSync(join(TMP, 'live-ws-'));
  const bin = writeFixture(workspace, SLOW_BODY);
  const savedPath = process.env.PATH;
  const dataDir = mkdtempSync(join(TMP, 'live-data-'));
  __setRunUnitPrefixForTests('weaver-p1test-');
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let unit = '';
  let invocation = '';
  try {
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    runtime = await startRuntime({ dataDir, port: 0, open: false });
    const id = await dispatch(dataDir, workspace);
    await waitFor(async () => {
      const view = await taskView(dataDir, id);
      return view.status === 'running' && typeof view.run?.scopeInvocation === 'string';
    }, 30000, 'worker never recorded its invocation');
    const view = await taskView(dataDir, id);
    unit = view.run.scopeUnit;
    invocation = view.run.scopeInvocation;
    assert.ok(unit.startsWith('weaver-p1test-'), `test unit prefix: ${unit}`);
    assert.equal((await inspectScope(unit)).state, 'present');

    await runtime.close();
    runtime = undefined;
    assert.equal((await inspectScope(unit)).state, 'present', 'close must not cancel the real worker');

    runtime = await startRuntime({ dataDir, port: 0, open: false });
    await waitFor(async () => {
      const current = await taskView(dataDir, id);
      return current.status === 'completed' && typeof current.run?.finalizedAt === 'string';
    }, 60000, 'reattached worker never completed');
    const done = await taskView(dataDir, id);
    assert.equal(done.status, 'completed');
    const stored = new TaskStore(join(dataDir, 'weaver.db'));
    try {
      const task = stored.get(id);
      assert.equal(task.events.filter(value => value.kind === 'result').length, 1, 'result exactly once');
      assert.equal(task.run?.finalizedAt !== undefined, true);
      assert.equal(task.run?.logTruncated, undefined);
      const log = task.run?.logs?.stdout;
      if (log) assert.equal(existsSync(log), false, 'raw logs are removed after the final commit');
    } finally { stored.close(); }
    await waitFor(async () => (await confirmScopeAbsent(unit)) === true, 30000, `scope leaked: ${unit}`);
  } finally {
    process.env.PATH = savedPath;
    __setRunUnitPrefixForTests(undefined);
    await cleanup(unit, invocation || undefined);
    await runtime?.close().catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a worker that ends during service downtime is finalized as completed on restart without an interrupted event', { skip: !enabled, timeout: 180000 }, async () => {
  await requireRealSystemd();
  mkdirSync(TMP, { recursive: true });
  const workspace = mkdtempSync(join(TMP, 'down-ws-'));
  const bin = writeFixture(workspace, END_AFTER_DOWNTIME_BODY);
  const savedPath = process.env.PATH;
  const dataDir = mkdtempSync(join(TMP, 'down-data-'));
  __setRunUnitPrefixForTests('weaver-p1test-');
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let unit = '';
  let invocation = '';
  try {
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    runtime = await startRuntime({ dataDir, port: 0, open: false });
    const id = await dispatch(dataDir, workspace);
    await waitFor(async () => {
      const view = await taskView(dataDir, id);
      return view.status === 'running' && typeof view.run?.scopeInvocation === 'string';
    }, 30000, 'worker never recorded its invocation');
    const view = await taskView(dataDir, id);
    unit = view.run.scopeUnit;
    invocation = view.run.scopeInvocation;
    await runtime.close();
    runtime = undefined;
    await waitFor(async () => (await confirmScopeAbsent(unit)) === true, 30000, 'worker did not finish during downtime');

    runtime = await startRuntime({ dataDir, port: 0, open: false });
    await waitFor(async () => {
      const current = await taskView(dataDir, id);
      return current.status === 'completed' && typeof current.run?.finalizedAt === 'string';
    }, 30000, 'finished worker was not finalized');
    const stored = new TaskStore(join(dataDir, 'weaver.db'));
    try {
      const task = stored.get(id);
      assert.equal(task.status, 'completed');
      assert.equal(task.events.filter(value => value.kind === 'result').length, 1);
      assert.equal(task.events.some(value => /Interrupted by app exit/.test(value.message)), false);
      assert.equal(task.failure, undefined);
    } finally { stored.close(); }
  } finally {
    process.env.PATH = savedPath;
    __setRunUnitPrefixForTests(undefined);
    await cleanup(unit, invocation || undefined);
    await runtime?.close().catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
