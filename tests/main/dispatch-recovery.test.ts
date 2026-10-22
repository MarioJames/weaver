import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { CommandHandler } from '../../src/main/commands';
import { PolicyStore } from '../../src/main/policy/store';
import { slotGroupCount, slotGroupFor, occupiesSlot } from '../../src/main/domain/tasks';
import { workerLoad } from '../../src/main/application/scheduling/dispatch';
import type { Task } from '../../src/shared/contracts/tasks';
import { metadataOf, setMetadataOf } from '../helpers/store-metadata';

const TMP = mkdtempSync(join(tmpdir(), 'wv-dispatch-recovery-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

class HeldWorker extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM') { this.signals.push(signal); return true; }
  close() { this.stdout.end(); this.stderr.end(); this.emit('close', null, 'SIGTERM'); }
}

const owner = { name: 'fixture', transport: 'herdr-visible' as const, session: 'fixture', pane: 'fixture' };
const waitFor = async (condition: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

function open(dir: string, starts: string[], children: HeldWorker[], real = true) {
  const store = new TaskStore(join(dir, 'weaver.db'));
  const manager = new TaskManager(store, {
    id: 'routing',
    canLaunchReal: () => real,
    start(task: Task) {
      starts.push(task.id);
      const child = new HeldWorker();
      children.push(child);
      return child;
    },
  } as never, () => {}, undefined, error => { throw error; });
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  const handler = new CommandHandler(manager, policy, () => { throw new Error('no owner host in this fixture'); }, () => false);
  const raw = (command: string, args: Record<string, unknown>, commandId = randomUUID()) => handler.handle({ apiVersion: 'weaver.v1', commandId, command, args });
  const call = (command: string, args: Record<string, unknown> = {}): any => {
    const response = raw(command, args);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  return { dir, store, manager, policy, handler, raw, call, starts, children };
}

function harness(options: { real?: boolean } = {}) {
  const dir = mkdtempSync(join(TMP, 'case-'));
  const starts: string[] = [];
  const children: HeldWorker[] = [];
  const f = open(dir, starts, children, options.real !== false);
  let crashed = false;
  return {
    ...f, starts, children,
    task: (extra: Record<string, unknown> = {}) => f.call('tasks.create', { title: 'Recoverable dispatch', instruction: 'fixture work', owner, workspace: dir, ...extra }),
    async crash() {
      // Simulate the process dying: stop new commands, drop the in-memory runs, and close the DB
      // without letting shutdown finalize anything the durable state should still show.
      crashed = true;
      f.handler.draining = true;
      for (const child of children) child.removeAllListeners();
      f.store.close();
    },
    async close() {
      f.handler.draining = true;
      if (!crashed) {
        for (const child of children) { child.removeAllListeners(); child.close(); }
        await f.manager.shutdown();
      }
      try { f.store.close(); } catch { /* already closed by crash() */ }
      rmSync(dir, { recursive: true, force: true });
    },
    reopen: (real = options.real !== false) => open(dir, starts, children, real),
  };
}

function failedAttempt(f: ReturnType<typeof harness>, execution: 'real' | 'mock' = 'mock'): Task {
  const task = f.store.get(f.task().id);
  task.status = 'failed';
  task.dispatch = {
    owner: 'claude_owner', worker: execution === 'mock' ? 'codex_worker' : 'codex_worker', engine: execution === 'mock' ? 'codex' : 'codex',
    model: execution === 'mock' ? 'gpt-6.1-sol' : 'gpt-6.1-sol', effort: 'high', execution,
    maxParallel: 8, adapter: execution === 'mock' ? 'mock-jsonl' : 'codex', workspace: f.dir,
  };
  f.store.put(task);
  return f.store.get(task.id);
}

function replacementOf(store: TaskStore, originalId: string): Task[] {
  return store.listHeads().filter(task => task.retryOf === originalId);
}

test('a committed dispatch survives a restart and the pump starts that task once', async () => {
  const f = harness();
  try {
    const task = f.task();
    const accepted = f.raw('workers.spawn', { taskId: task.id, owner: 'claude_owner', worker: 'codex_worker' });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const data: any = accepted.data;
    assert.equal(data.status, 'queued');
    assert.equal(data.scheduled, true);
    assert.equal(data.started, false);
    assert.deepEqual(data.next, { action: 'wait', command: `weaver tasks wait --task-id ${task.id}` });
    assert.equal(f.starts.length, 0, 'dispatch itself starts nothing');
    assert.equal(f.store.get(task.id).dispatch?.execution, 'real');
    assert.ok(f.store.get(task.id).packageId, 'the package is frozen with the admission');
    assert.equal(f.store.get(task.id).queueReason?.code, 'waiting_for_capacity');

    // Crash after the admission COMMIT and before the pump's start.
    await f.crash();
    const g = f.reopen();
    try {
      await waitFor(() => g.store.get(task.id).status === 'running');
      assert.equal(g.starts.length, 1, 'the restart starts exactly one attempt');
      assert.equal(g.starts[0], task.id);
      assert.equal(replacementOf(g.store, task.id).length, 0, 'recovery never invents a replacement');
      assert.ok(g.store.get(task.id).run?.id, 'the attempt has a durable run id');
      assert.equal(g.store.get(task.id).scheduled, false);
    } finally {
      g.handler.draining = true;
      for (const child of f.children) child.close();
      await g.manager.shutdown();
      g.store.close();
    }
  } finally { await f.close(); }
});

test('replaying the same dispatch command after the admission commit returns the same task and settles the receipt', async () => {
  const f = harness();
  try {
    const task = f.task();
    const commandId = randomUUID();
    const args = { taskId: task.id, owner: 'claude_owner', worker: 'codex_worker' };
    const first = f.raw('workers.spawn', args, commandId);
    assert.equal(first.ok, true, JSON.stringify(first));
    const key = `local-demo:${commandId}`;
    assert.ok((f.store.getReceipt(key) as any)?.accepted, 'the accepted result commits with the admission');
    const metadata = metadataOf(f.store);
    delete metadata.receipts[key]!.response;
    setMetadataOf(f.store, metadata);

    await f.crash();
    const g = f.reopen();
    try {
      const replay = g.raw('workers.spawn', args, commandId);
      assert.equal(replay.ok, true, JSON.stringify(replay));
      assert.equal((replay.data as any).id, task.id);
      assert.equal(g.store.listHeads().filter(candidate => candidate.title === 'Recoverable dispatch').length, 1, 'the replay creates no duplicate task');
    } finally {
      g.handler.draining = true;
      for (const child of f.children) child.close();
      await g.manager.shutdown();
      g.store.close();
    }
  } finally { await f.close(); }
});

test('a receipt without a committed acceptance stays indeterminate and never re-executes the dispatch', async () => {
  const f = harness();
  try {
    const task = f.task();
    const commandId = randomUUID();
    const args = { taskId: task.id, owner: 'claude_owner', worker: 'codex_worker' };
    assert.equal(f.raw('workers.spawn', args, commandId).ok, true);
    const metadata = metadataOf(f.store);
    const receipt = metadata.receipts[`local-demo:${commandId}`] as any;
    delete receipt.response;
    delete receipt.accepted;
    setMetadataOf(f.store, metadata);
    const replay = f.raw('workers.spawn', args, commandId);
    assert.equal(replay.error?.code, 'COMMAND_INDETERMINATE');
    assert.equal(f.starts.length, 0, 'an indeterminate replay starts nothing');
    assert.equal(f.store.listHeads().filter(candidate => candidate.title === 'Recoverable dispatch').length, 1);
  } finally { await f.close(); }
});

test('a native dispatch with capacity registers the run inside admission and still returns run_subagent', async () => {
  const f = harness({ real: false });
  try {
    const task = f.call('tasks.create', { title: 'Native recovery', instruction: 'fixture work', workspace: f.dir, ownerProfileId: 'claude_owner' });
    const accepted = f.raw('workers.spawn', { taskId: task.id });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const data: any = accepted.data;
    assert.equal(data.status, 'running');
    assert.equal(data.started, true);
    assert.equal(data.dispatch.execution, 'native');
    assert.equal(data.next.action, 'run_subagent');
    assert.equal(f.store.get(task.id).run?.execution, 'native');
    assert.equal(f.starts.length, 0, 'native work never creates a process');
    assert.equal(f.store.get(task.id).scheduled, false);
  } finally { await f.close(); }
});

test('a native dispatch replay returns the same registered attempt', async () => {
  const f = harness({ real: false });
  try {
    const task = f.call('tasks.create', { title: 'Native replay', instruction: 'fixture work', workspace: f.dir, ownerProfileId: 'claude_owner' });
    const commandId = randomUUID();
    const args = { taskId: task.id };
    const first = f.raw('workers.spawn', args, commandId);
    assert.equal(first.ok, true, JSON.stringify(first));
    const attemptId = (first.data as any).run.id;
    const metadata = metadataOf(f.store);
    delete metadata.receipts[`local-demo:${commandId}`]!.response;
    setMetadataOf(f.store, metadata);
    const g = f.reopen(false);
    try {
      const replay = g.raw('workers.spawn', args, commandId);
      assert.equal(replay.ok, true, JSON.stringify(replay));
      assert.equal((replay.data as any).run.id, attemptId);
      assert.equal((replay.data as any).next.action, 'run_subagent');
      assert.equal(g.starts.length, 0, 'native replay never creates a process');
    } finally {
      g.handler.draining = true;
      g.store.close();
    }
  } finally { await f.close(); }
});

test('a real dispatch is accepted as queued and becomes running through the pump', async () => {
  const f = harness();
  try {
    const task = f.task();
    const accepted: any = f.call('workers.spawn', { taskId: task.id, owner: 'claude_owner', worker: 'codex_worker' });
    assert.equal(accepted.status, 'queued');
    assert.equal(accepted.started, false);
    assert.equal(accepted.next.action, 'wait');
    assert.equal(f.starts.length, 0);
    await waitFor(() => f.store.get(task.id).status === 'running');
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0], task.id);
  } finally { await f.close(); }
});

test('handleAsync settles at acceptance instead of waiting for the first output', async () => {
  const f = harness();
  try {
    const task = f.task();
    const response = await f.handler.handleAsync({
      apiVersion: 'weaver.v1', commandId: randomUUID(), command: 'workers.spawn',
      args: { taskId: task.id, owner: 'claude_owner', worker: 'codex_worker' },
    });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal((response.data as any).status, 'queued');
    assert.equal((response.data as any).started, false);
    assert.equal(f.starts.length, 0, 'no output or process is awaited before the response');
  } finally { await f.close(); }
});

test('retry commits cancellation intent, stable replacement, package, retryOf and admission together', async () => {
  const f = harness();
  try {
    const original = failedAttempt(f, 'mock');
    const commandId = randomUUID();
    const args = { taskId: original.id };
    const response = f.raw('tasks.retry', args, commandId);
    assert.equal(response.ok, true, JSON.stringify(response));
    const replacement = response.data as any;
    assert.equal(replacement.retryOf, original.id);
    assert.equal(replacement.status, 'queued');
    assert.equal(replacement.scheduled, true);
    assert.equal(replacement.dispatch.execution, 'mock');
    assert.deepEqual(replacement.next, { action: 'wait', command: `weaver tasks wait --task-id ${replacement.id}` });
    assert.equal(f.starts.length, 0, 'the retry command starts nothing itself');
    const stored = f.store.get(replacement.id);
    assert.equal(stored.retryOf, original.id);
    assert.ok(stored.packageId);
    assert.equal(f.store.getPackage(stored.packageId!)!.taskId, replacement.id);
    assert.equal(replacementOf(f.store, original.id).length, 1);
    assert.ok((f.store.getReceipt(`local-demo:${commandId}`) as any)?.accepted);

    await f.crash();
    const g = f.reopen();
    try {
      await waitFor(() => g.store.get(replacement.id).status === 'running');
      assert.deepEqual(replacementOf(g.store, original.id).map(task => task.id), [replacement.id], 'the restart advances the original replacement id');
      assert.equal(g.starts.filter(id => id === replacement.id).length, 1);
      assert.equal(replacementOf(g.store, original.id).filter(task => task.id !== replacement.id).length, 0);
    } finally {
      g.handler.draining = true;
      for (const child of f.children) child.close();
      await g.manager.shutdown();
      g.store.close();
    }
  } finally { await f.close(); }
});

test('a failed retry acceptance rolls back the cancellation intent, replacement, package and receipt result', async () => {
  const f = harness();
  try {
    const original = failedAttempt(f, 'mock');
    const before = f.store.list();
    const packages = metadataOf(f.store).packages;
    const commandId = randomUUID();
    const put = f.store.put.bind(f.store);
    let failed = false;
    f.store.put = ((task: Task, ...rest: unknown[]) => {
      if (task.retryOf === original.id && task.dispatch && !failed) {
        failed = true;
        throw new Error('acceptance persistence failed');
      }
      return (put as any)(task, ...rest);
    }) as typeof f.store.put;
    const response = f.raw('tasks.retry', { taskId: original.id }, commandId);
    assert.equal(response.ok, false);
    f.store.put = put;
    assert.deepEqual(f.store.list(), before, 'no task write survives a failed acceptance');
    assert.deepEqual(metadataOf(f.store).packages, packages, 'no package survives a failed acceptance');
    assert.equal(replacementOf(f.store, original.id).length, 0);
    const receipt = f.store.getReceipt(`local-demo:${commandId}`) as any;
    assert.equal(receipt?.accepted, undefined);
    assert.equal((receipt?.response as any)?.ok, false);
  } finally { await f.close(); }
});

test('a retry --cancel crash keeps the termination intent and still starts the committed replacement', async () => {
  const f = harness();
  try {
    const original = f.store.get(f.task().id);
    original.dispatch = { owner: 'claude_owner', worker: 'codex_worker', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', execution: 'mock', maxParallel: 8, adapter: 'mock-jsonl', workspace: f.dir };
    f.store.put(original);
    f.manager.start(original.id);
    assert.equal(f.store.get(original.id).status, 'running');
    const response = f.raw('tasks.retry', { taskId: original.id, cancel: true });
    assert.equal(response.ok, true, JSON.stringify(response));
    const replacement = response.data as any;
    assert.equal(f.store.get(original.id).status, 'cancelling');
    assert.equal(f.store.get(original.id).run?.cancelRequestedAt !== undefined, true);
    assert.equal(f.store.get(replacement.id).scheduled, true);

    await f.crash();
    const g = f.reopen();
    try {
      const cancelling = g.store.get(original.id);
      assert.equal(cancelling.status, 'cancelling');
      assert.ok(cancelling.run?.cancelRequestedAt, 'the cancellation intent survives the crash');
      await waitFor(() => g.store.get(replacement.id).status === 'running');
      assert.equal(g.store.get(replacement.id).status, 'running');
      assert.equal(g.starts.filter(id => id === replacement.id).length, 1);
    } finally {
      g.handler.draining = true;
      for (const child of f.children) child.close();
      await g.manager.shutdown();
      g.store.close();
    }
  } finally { await f.close(); }
});

test('replaying the same retry command after the admission commit returns the same replacement', async () => {
  const f = harness();
  try {
    const original = failedAttempt(f, 'mock');
    const commandId = randomUUID();
    const args = { taskId: original.id };
    const first = f.raw('tasks.retry', args, commandId);
    assert.equal(first.ok, true, JSON.stringify(first));
    const replacementId = (first.data as any).id;
    const key = `local-demo:${commandId}`;
    const metadata = metadataOf(f.store);
    delete metadata.receipts[key]!.response;
    setMetadataOf(f.store, metadata);
    await f.crash();
    const g = f.reopen();
    try {
      const replay = g.raw('tasks.retry', args, commandId);
      assert.equal(replay.ok, true, JSON.stringify(replay));
      assert.equal((replay.data as any).id, replacementId);
      assert.deepEqual(replacementOf(g.store, original.id).map(task => task.id), [replacementId]);
      assert.ok(g.store.getReceipt(key)?.response, 'the replay settles the receipt');
    } finally {
      g.handler.draining = true;
      for (const child of f.children) child.close();
      await g.manager.shutdown();
      g.store.close();
    }
  } finally { await f.close(); }
});

test('slot and worker load count a permitted run that has not finalized', () => {
  const base = {
    id: randomUUID(), title: 'slot fixture', instruction: 'fixture', owner,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    progress: 0, events: [], artifacts: [], ownerId: 'owner-1',
    dispatch: { owner: 'claude_owner', worker: 'codex_worker', engine: 'codex', model: 'm', effort: 'high', execution: 'real' as const, maxParallel: 2 },
  };
  const unfinalized: Task = { ...base, status: 'failed', run: { id: randomUUID(), adapter: 'codex', execution: 'real', status: 'stopping', launchPermittedAt: new Date().toISOString(), startedAt: new Date().toISOString() } };
  assert.equal(occupiesSlot(unfinalized), true);
  assert.equal(slotGroupCount([unfinalized], slotGroupFor('owner-1', 'claude_owner')), 1);
  assert.deepEqual(workerLoad([unfinalized]), { codex_worker: 1 });
  const finalized: Task = { ...unfinalized, run: { ...unfinalized.run!, finalizedAt: new Date().toISOString() } };
  assert.equal(occupiesSlot(finalized), false);
  assert.equal(slotGroupCount([finalized], slotGroupFor('owner-1', 'claude_owner')), 0);
  assert.deepEqual(workerLoad([finalized]), {});
  const preparing: Task = { ...unfinalized, status: 'queued', run: { id: randomUUID(), adapter: 'codex', execution: 'real', status: 'running', startedAt: new Date().toISOString() } };
  assert.equal(occupiesSlot(preparing), false);
});
