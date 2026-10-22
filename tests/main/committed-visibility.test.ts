import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { MockWorkerAdapter } from '../../src/main/adapters/worker';
import { CommandHandler } from '../../src/main/commands';
import { PolicyStore } from '../../src/main/policy/store';
import { event } from '../../src/main/domain/tasks';
import { publicTask } from '../../src/main/application/tasks/records';
import type { Task } from '../../src/shared/contracts/tasks';

const pkgTmp = mkdtempSync(join(tmpdir(), 'wv-committed-'));
after(() => rmSync(pkgTmp, { recursive: true, force: true }));
function setup() {
  mkdirSync(pkgTmp, { recursive: true });
  const dir = mkdtempSync(join(pkgTmp, 'weaver-committed-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const manager = new TaskManager(store, new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs')));
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  const handler = new CommandHandler(manager, policy);
  const raw = (command: string, args: Record<string, unknown> = {}, commandId: string = randomUUID()) => handler.handle({ apiVersion: 'weaver.v1', commandId, command, args });
  const call = (command: string, args: Record<string, unknown> = {}) => { const r = raw(command, args); assert.equal(r.ok, true, JSON.stringify(r)); return (r as { data: unknown }).data as any; };
  return { dir, store, manager, policy, handler, raw, call, close: async () => { handler.draining = true; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}
function terminalFixture(status: 'completed' | 'failed', run?: Task['run']): Task {
  const at = new Date().toISOString();
  return {
    id: randomUUID(), title: 'fixture', instruction: 'fixture',
    owner: { name: 'owner', transport: 'herdr-visible', session: 'main', pane: '1' },
    createdAt: at, updatedAt: at, status, progress: status === 'completed' ? 100 : 0,
    events: [{ id: randomUUID(), at, kind: 'result', message: 'done' }], artifacts: [],
    summary: status === 'completed' ? 'done' : undefined, run,
  };
}
function newLifecycleRun(): NonNullable<Task['run']> {
  const at = new Date().toISOString();
  return {
    id: randomUUID(), adapter: 'pi', execution: 'real', status: 'stopped', engine: 'pi',
    launchPermittedAt: at, finalizedAt: undefined, stateDir: '/state/secret', scopeInvocation: 'ab'.repeat(16),
    nonce: 'cd'.repeat(16), logs: { stdout: '/state/secret/stdout.log', stderr: '/state/secret/stderr.log', exit: '/state/secret/exit.json', exitTmp: '/state/secret/.exit.tmp' },
    logIdentity: { stdout: { dev: 1, ino: 2 }, stderr: { dev: 1, ino: 3 } },
    replay: { stdoutOffset: 10, stderrOffset: 4, appliedRecords: 2 },
    killAfter: at, terminationPhase: 'term', cancelRequestedAt: at, cancelSignal: 'SIGTERM',
  };
}

test('tasks.get/list/events read committed state and hide uncommitted stream events', async () => {
  const f = setup(); try {
    const created = f.call('tasks.create', { title: 'Bound', instruction: 'fixture', owner: { name: 'demo', transport: 'herdr-visible', session: 'reference', pane: 'reference' } });
    const pending = f.store.get(created.id);
    event(pending, 'log', 'uncommitted-stream-line');
    f.store.put(pending, 'stream');
    const got = f.call('tasks.get', { taskId: created.id });
    assert.ok(!got.events.some((e: any) => e.message === 'uncommitted-stream-line'));
    const listed = f.call('tasks.list', {});
    assert.ok(!listed.tasks.flatMap((t: any) => t.events ?? []).some((e: any) => e.message === 'uncommitted-stream-line'));
    const events = f.call('tasks.events', { taskId: created.id, limit: 50 });
    assert.ok(!events.events.some((e: any) => e.message === 'uncommitted-stream-line'));
    f.store.flush();
    assert.ok(f.call('tasks.events', { taskId: created.id, limit: 50 }).events.some((e: any) => e.message === 'uncommitted-stream-line'));
  } finally { await f.close(); }
});

test('results stay RESULT_NOT_READY until a new-lifecycle run finalizes, then freeze with a stable digest', async () => {
  const f = setup(); try {
    const task = terminalFixture('failed', { ...newLifecycleRun(), status: 'stopped' });
    task.failure = { kind: 'unknown_outcome', message: 'execution result unknown: no exit record' };
    f.store.put(task);
    assert.equal(f.raw('tasks.results', { taskId: task.id }).error?.code, 'RESULT_NOT_READY');
    const run = f.store.get(task.id).run!;
    run.finalizedAt = new Date().toISOString();
    const committed = f.store.getCommitted(task.id);
    committed.run = run;
    f.store.put(committed);
    const first = f.call('tasks.results', { taskId: task.id }) as any;
    const second = f.call('tasks.results', { taskId: task.id }) as any;
    assert.equal(first.manifestDigest, second.manifestDigest);
    assert.equal(first.failure.kind, 'unknown_outcome');
    const changed = f.store.get(task.id);
    changed.summary = 'tampered-after-finalize';
    f.store.put(changed, 'stream');
    assert.equal((f.call('tasks.results', { taskId: task.id }) as any).manifestDigest, first.manifestDigest);
    f.store.flush();
  } finally { await f.close(); }
});

test('history records without launchPermittedAt keep their old result behavior', async () => {
  const f = setup(); try {
    const completed = terminalFixture('completed', { id: randomUUID(), adapter: 'mock-jsonl', execution: 'mock', status: 'stopped' });
    f.store.put(completed);
    const manifest = f.call('tasks.results', { taskId: completed.id }) as any;
    assert.equal(manifest.execution, 'completed');
    assert.ok(typeof manifest.manifestDigest === 'string');
  } finally { await f.close(); }
});

test('public task views hide internal paths and identity but keep lifecycle visibility fields', async () => {
  const f = setup(); try {
    const task = terminalFixture('completed', { ...newLifecycleRun(), finalizedAt: new Date().toISOString(), recovery: { state: 'pending', reason: 'scope unverified', since: new Date().toISOString() } });
    f.store.put(task);
    const got = f.call('tasks.get', { taskId: task.id }) as any;
    assert.equal(got.run.stateDir, undefined);
    assert.equal(got.run.logs, undefined);
    assert.equal(got.run.nonce, undefined);
    assert.equal(got.run.logIdentity, undefined);
    assert.equal(got.run.pid, undefined);
    assert.ok(typeof got.run.launchPermittedAt === 'string');
    assert.ok(typeof got.run.finalizedAt === 'string');
    assert.equal(got.run.recovery.state, 'pending');
    assert.equal(got.run.terminationPhase, 'term');
    assert.ok(typeof got.run.killAfter === 'string');
    assert.ok(typeof got.run.cancelRequestedAt === 'string');
    const direct = publicTask(task);
    assert.equal((direct as any).run.stateDir, undefined);
    assert.equal((direct as any).run.logs, undefined);
    assert.equal((direct as any).run.nonce, undefined);
    assert.equal((direct as any).run.logIdentity, undefined);
  } finally { await f.close(); }
});

test('unknown_outcome failures do not trigger vendor blocks', async () => {
  const f = setup(); try {
    const task = terminalFixture('failed', { ...newLifecycleRun(), finalizedAt: new Date().toISOString() });
    task.failure = { kind: 'unknown_outcome', message: 'execution result unknown: no exit record' };
    task.dispatch = { owner: 'o', worker: 'w', engine: 'codex', model: 'm', effort: 'high', maxParallel: 2, execution: 'real' };
    f.store.put(task);
    f.handler.pump();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.policy.snapshot().blocks.length, 0);
  } finally { await f.close(); }
});
