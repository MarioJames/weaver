import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandHandler } from '../../src/main/commands';
import { TaskManager } from '../../src/main/manager';
import { TaskStore } from '../../src/main/store';
import { PolicyStore } from '../../src/main/policy/store';
import type { OwnerLaunchInput, OwnerLaunchResult } from '../../src/main/owner-host';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-supersede-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  const manager = new TaskManager(store, { id: 'forbidden', start() { throw new Error('No worker process allowed'); } });
  const launches: { input: OwnerLaunchInput & { signal?: AbortSignal }; resolve: (host: OwnerLaunchResult) => void; reject: (error: Error) => void }[] = [];
  const handler = new CommandHandler(manager, policy, () => { throw new Error('No sync host allowed'); }, () => true, undefined, { launcher: input => new Promise((resolve, reject) => { launches.push({ input, resolve, reject }); }) });
  const raw = (command: string, args: Record<string, unknown> = {}, commandId: string = randomUUID()) => handler.handle({ apiVersion: 'weaver.v1', command, args, commandId });
  const call = (command: string, args: Record<string, unknown> = {}, commandId?: string): any => { const response = raw(command, args, commandId); assert.equal(response.ok, true, JSON.stringify(response)); return response.data; };
  const task = call('tasks.create', { goal: 'root goal', workspace: dir, ownerProfileId: 'codex_owner' });
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
  const launch = async () => { await settle(); launches.at(-1)!.resolve({ session: 'fake', workspaceId: 'fake-workspace', paneId: 'fake-pane', agentName: `owner-${task.id.slice(0, 8)}-0` }); await settle(); };
  return { dir, store, manager, handler, raw, call, task, settle, launch, async close() { await handler.drain(); await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

async function rooted() {
  const f = fixture();
  f.call('tasks.start', { taskId: f.task.id });
  await f.launch();
  f.call('tasks.describe', { taskId: f.task.id, expectedRevision: f.store.get(f.task.id).revision, title: 'Root', acceptanceCriteria: ['reviewed'] });
  return f;
}

function child(f: ReturnType<typeof fixture>, title: string) {
  return f.call('tasks.create', { parentTaskId: f.task.id, title, goal: 'bounded work' });
}

function completeChild(f: ReturnType<typeof fixture>, id: string) {
  f.call('packages.create', { taskId: id, scope: ['read: fixture'], acceptanceCriteria: ['verified'] });
  const dispatch = f.call('workers.spawn', { taskId: id });
  assert.equal(dispatch.next.action, 'run_subagent');
  f.call('workers.complete', { taskId: id, outcome: 'completed', summary: 'verified child' });
  const manifest = f.call('tasks.results', { taskId: id });
  f.call('reviews.submit', { taskId: id, expectedRevision: f.store.get(id).revision, manifestDigest: manifest.manifestDigest, decision: 'accepted' });
}

test('cancel with supersededBy records the replacement on an in-flight task', async () => {
  const f = await rooted();
  try {
    const old = child(f, 'old direction');
    const next = child(f, 'new direction');
    const revisionBefore = f.store.get(old.id).revision ?? 0;
    const result: any = f.call('tasks.cancel', { taskId: old.id, supersededBy: next.id, reason: 'design changed; new child covers it' });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.supersededBy, next.id);
    assert.equal(result.supersededReason, 'design changed; new child covers it');
    assert.ok(f.store.get(old.id).revision! > revisionBefore);
    assert.ok(f.store.get(old.id).events.some(e => e.kind === 'lifecycle' && e.message === `Superseded by ${next.id.slice(0, 8)}: design changed; new child covers it`));
  } finally { await f.close(); }
});

test('already-cancelled child accepts a late supersede marker without changing state', async () => {
  const f = await rooted();
  try {
    const old = child(f, 'old direction');
    const next = child(f, 'new direction');
    f.call('tasks.cancel', { taskId: old.id });
    assert.equal(f.store.get(old.id).status, 'cancelled');
    const revisionBefore = f.store.get(old.id).revision ?? 0;
    const result: any = f.call('tasks.cancel', { taskId: old.id, supersededBy: next.id, reason: 'backfill the replacement link' });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.supersededBy, next.id);
    assert.equal(result.supersededReason, 'backfill the replacement link');
    assert.ok(result.revision > revisionBefore);
    assert.ok(f.store.get(old.id).events.some(e => e.kind === 'lifecycle' && e.message.startsWith(`Superseded by ${next.id.slice(0, 8)}:`)));
    assert.equal((result as any).alreadyTerminal, undefined);
  } finally { await f.close(); }
});

test('cancel without the new fields keeps the old terminal behavior byte-for-byte', async () => {
  const f = await rooted();
  try {
    const old = child(f, 'old direction');
    f.call('tasks.cancel', { taskId: old.id });
    const again: any = f.call('tasks.cancel', { taskId: old.id });
    assert.equal(again.alreadyTerminal, true);
    assert.equal(again.task.status, 'cancelled');
    assert.equal('supersededBy' in again.task, false);
  } finally { await f.close(); }
});

for (const status of ['completed', 'failed'] as const) {
  test(`cancel with supersededBy is refused on a ${status} task and changes nothing`, async () => {
    const f = await rooted();
    try {
      const done = child(f, 'done work');
      if (status === 'completed') completeChild(f, done.id);
      else {
        f.call('packages.create', { taskId: done.id, scope: ['read: fixture'], acceptanceCriteria: ['verified'] });
        f.call('workers.spawn', { taskId: done.id });
        f.call('workers.complete', { taskId: done.id, outcome: 'failed', summary: 'broken' });
      }
      const next = child(f, 'replacement');
      const before = f.store.get(done.id);
      const rejection = f.raw('tasks.cancel', { taskId: done.id, supersededBy: next.id, reason: 'too late' });
      assert.equal(rejection.ok, false);
      assert.equal(rejection.error?.code, 'INVALID_STATE');
      assert.deepEqual(f.store.get(done.id), before);
    } finally { await f.close(); }
  });
}

test('supersede validation rejects missing parent, unknown/sibling/self targets and bad reasons', async () => {
  const f = await rooted();
  try {
    const old = child(f, 'old direction');
    const next = child(f, 'new direction');
    const other = f.call('tasks.create', { goal: 'unrelated root child', workspace: f.dir, ownerId: f.task.ownerId });
    const before = f.store.get(old.id);
    // Task without a parent (the root itself) cannot record a replacement.
    assert.equal(f.raw('tasks.cancel', { taskId: f.task.id, supersededBy: next.id, reason: 'x' }).error?.code, 'INVALID_STATE');
    // Unknown target.
    assert.equal(f.raw('tasks.cancel', { taskId: old.id, supersededBy: randomUUID(), reason: 'x' }).error?.code, 'INVALID_REQUEST');
    // Malformed target.
    assert.equal(f.raw('tasks.cancel', { taskId: old.id, supersededBy: 'nope', reason: 'x' }).error?.code, 'INVALID_REQUEST');
    // Target under a different parent.
    assert.equal(f.raw('tasks.cancel', { taskId: old.id, supersededBy: other.id, reason: 'x' }).error?.code, 'INVALID_REQUEST');
    // Self target.
    assert.equal(f.raw('tasks.cancel', { taskId: old.id, supersededBy: old.id, reason: 'x' }).error?.code, 'INVALID_REQUEST');
    // Missing reason.
    assert.equal(f.raw('tasks.cancel', { taskId: old.id, supersededBy: next.id }).error?.code, 'INVALID_REQUEST');
    // Empty and overlong reasons.
    assert.equal(f.raw('tasks.cancel', { taskId: old.id, supersededBy: next.id, reason: '   ' }).error?.code, 'INVALID_REQUEST');
    assert.equal(f.raw('tasks.cancel', { taskId: old.id, supersededBy: next.id, reason: 'r'.repeat(501) }).error?.code, 'INVALID_REQUEST');
    assert.deepEqual(f.store.get(old.id), before);
    assert.equal(f.store.get(old.id).status, 'queued');
  } finally { await f.close(); }
});

test('a task cannot be superseded by its own retry descendant', async () => {
  const f = await rooted();
  try {
    const old = child(f, 'old direction');
    completeChild(f, old.id);
    const retry = f.call('tasks.retry', { taskId: old.id });
    const before = f.store.get(old.id);
    const rejection = f.raw('tasks.cancel', { taskId: old.id, supersededBy: retry.id, reason: 'retry replaces it' });
    assert.equal(rejection.ok, false);
    assert.equal(rejection.error?.code, 'INVALID_STATE');
    assert.deepEqual(f.store.get(old.id), before);
  } finally { await f.close(); }
});

test('root completion still rejects an unmarked cancelled leaf and names it', async () => {
  const f = await rooted();
  try {
    const old = child(f, 'old direction');
    const next = child(f, 'new direction');
    completeChild(f, next.id);
    f.call('tasks.cancel', { taskId: old.id });
    const complete = { taskId: f.task.id, outcome: 'completed', summary: 'done' };
    const rejection = f.raw('tasks.complete', complete);
    assert.equal(rejection.ok, false);
    assert.equal(rejection.error?.code, 'INVALID_STATE');
    assert.match(rejection.error?.message ?? '', new RegExp(old.id.slice(0, 8)));
    // Mark the obsolete leaf: the remaining final leaf is complete and accepted.
    f.call('tasks.cancel', { taskId: old.id, supersededBy: next.id, reason: 'design changed' });
    assert.equal(f.call('tasks.complete', complete).status, 'completed');
  } finally { await f.close(); }
});

test('root completion requires at least one non-superseded final leaf', async () => {
  const f = await rooted();
  try {
    const old = child(f, 'old direction');
    const next = child(f, 'new direction');
    f.call('tasks.cancel', { taskId: old.id, supersededBy: next.id, reason: 'design changed' });
    f.call('tasks.cancel', { taskId: next.id, supersededBy: old.id, reason: 'mutual backfill' });
    const rejection = f.raw('tasks.complete', { taskId: f.task.id, outcome: 'completed', summary: 'done' });
    assert.equal(rejection.ok, false);
    assert.equal(rejection.error?.code, 'INVALID_STATE');
    assert.match(rejection.error?.message ?? '', /at least one/i);
  } finally { await f.close(); }
});

test('supersede markers survive a store reload and old records load without them', async () => {
  const f = await rooted();
  try {
    const old = child(f, 'old direction');
    const next = child(f, 'new direction');
    const plain = child(f, 'plain history');
    f.call('tasks.cancel', { taskId: old.id, supersededBy: next.id, reason: 'design changed' });
    f.store.close();
    const reloaded = new TaskStore(join(f.dir, 'weaver.db'));
    try {
      const restored = reloaded.get(old.id);
      assert.equal(restored.status, 'cancelled');
      assert.equal(restored.supersededBy, next.id);
      assert.equal(restored.supersededReason, 'design changed');
      assert.ok(restored.events.some(e => e.message.startsWith(`Superseded by ${next.id.slice(0, 8)}:`)));
      const untouched = reloaded.get(plain.id);
      assert.equal('supersededBy' in untouched, false);
      assert.equal('supersededReason' in untouched, false);
    } finally { reloaded.close(); }
  } finally { await f.close(); }
});
