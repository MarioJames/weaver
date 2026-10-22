import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { MockWorkerAdapter } from '../../src/main/adapters/worker';
import { CommandHandler } from '../../src/main/commands';
import { PolicyStore } from '../../src/main/policy/store';
import { OwnerLaunchError, type OwnerLaunchInput, type OwnerLaunchResult } from '../../src/main/owner-host';
import type { Task, TaskStatus } from '../../src/shared/contracts/tasks';

const at = '2026-10-22T00:00:00.000Z';
const blockedLaunch = (input: OwnerLaunchInput): OwnerLaunchResult => { throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `Test did not inject an owner launcher for ${input.taskId}`); };
const ALL_STATUSES = ['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'];

function setup() {
  const ownerId = randomUUID();
  const rootId = randomUUID();
  const task = (id: string, status: TaskStatus, parentTaskId?: string): Task => ({
    id,
    ownerId,
    title: `Task ${status} ${id.slice(0, 8)}`,
    instruction: `INSTRUCTION ${status}`,
    workspace: '/work/project',
    acceptanceCriteria: ['accepted'],
    constraints: ['constraint'],
    owner: { name: 'fixture', transport: 'herdr-visible', session: 'test', pane: '1' },
    createdAt: at,
    updatedAt: at,
    status,
    progress: 0,
    revision: 1,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    summary: `SUMMARY ${status}`,
    events: [{ id: randomUUID(), at, kind: 'log', message: 'event' }],
    artifacts: [{ id: randomUUID(), name: 'result.md', mediaType: 'text/markdown', content: 'body', createdAt: at }],
  });
  const tasks: Task[] = [
    task(rootId, 'running'),
    task(randomUUID(), 'queued'),
    task(randomUUID(), 'completed'),
    task(randomUUID(), 'running', rootId),
    task(randomUUID(), 'failed', rootId),
    task(randomUUID(), 'running', rootId),
    task(randomUUID(), 'cancelled'),
  ];
  const dir = mkdtempSync(join(tmpdir(), 'weaver-list-status-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const manager = new TaskManager(store, new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs')));
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  store.transaction(() => { for (const item of tasks) store.put(item); });
  const handler = new CommandHandler(manager, policy, blockedLaunch, () => false);
  const raw = (command: string, args: Record<string, unknown> = {}) => handler.handle({ apiVersion: 'weaver.v1', command, args });
  const call = (command: string, args: Record<string, unknown> = {}) => { const response = raw(command, args); assert.equal(response.ok, true, JSON.stringify(response)); return response.data as any; };
  return { dir, tasks, rootId, ownerId, raw, call, close: async () => { handler.draining = true; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('status filters one or many statuses on the server without changing the default list', async () => {
  const f = setup();
  try {
    const running = f.call('tasks.list', { status: 'running' });
    assert.equal(running.tasks.length, 3);
    assert.ok(running.tasks.every((item: { status: string }) => item.status === 'running'));
    assert.equal(running.nextOffset, null);

    const active = f.call('tasks.list', { status: ['running', 'queued', 'running'] });
    assert.equal(active.tasks.length, 4);
    assert.deepEqual([...new Set(active.tasks.map((item: { status: string }) => item.status))].sort(), ['queued', 'running']);

    const all = f.call('tasks.list', {});
    assert.equal(all.tasks.length, f.tasks.length);
    assert.equal(all.nextOffset, null);
    assert.ok('instruction' in all.tasks[0]);
  } finally { await f.close(); }
});

test('status intersects with parentTaskId and paginates the filtered set', async () => {
  const f = setup();
  try {
    const children = f.call('tasks.list', { status: 'running', parentTaskId: f.rootId });
    assert.equal(children.tasks.length, 2);
    assert.ok(children.tasks.every((item: { status: string; parentTaskId: string }) => item.status === 'running' && item.parentTaskId === f.rootId));

    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = f.call('tasks.list', { status: 'running', limit: 1, offset });
      assert.equal(page.tasks.length, 1);
      seen.push(page.tasks[0].id);
      offset = page.nextOffset;
    }
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen).size, 3);
    assert.deepEqual(new Set(seen), new Set(f.tasks.filter(item => item.status === 'running').map(item => item.id)));

    const none = f.call('tasks.list', { status: 'cancelled', parentTaskId: f.rootId });
    assert.deepEqual(none.tasks, []);
    assert.equal(none.nextOffset, null);
  } finally { await f.close(); }
});

test('status composes with view brief and fields', async () => {
  const f = setup();
  try {
    const brief = f.call('tasks.list', { status: 'running', view: 'brief' });
    assert.equal(brief.tasks.length, 3);
    assert.deepEqual(Object.keys(brief.tasks[0]).sort(), ['dispatch', 'id', 'ownerId', 'parentTaskId', 'progress', 'reviewState', 'status', 'title', 'updatedAt', 'workspace'].sort());
    assert.ok(brief.tasks.every((item: { status: string }) => item.status === 'running'));

    const projected = f.call('tasks.list', { status: ['queued', 'failed'], fields: ['id', 'status'] });
    assert.equal(projected.tasks.length, 2);
    assert.deepEqual(projected.tasks.map((item: Record<string, unknown>) => Object.keys(item).sort()), [['id', 'status'], ['id', 'status']]);
  } finally { await f.close(); }
});

test('invalid status values fail with INVALID_ARGUMENT and list every allowed status', async () => {
  const f = setup();
  try {
    const invalid: unknown[] = ['unknown', 'RUNNING', [], '', ['running', ''], ['running', 3], 42, null, {}, true];
    for (const status of invalid) {
      const response = f.raw('tasks.list', { status });
      assert.equal(response.ok, false, JSON.stringify(status));
      assert.equal(response.error?.code, 'INVALID_ARGUMENT', JSON.stringify(status));
      for (const allowed of ALL_STATUSES) assert.match(response.error!.message, new RegExp(`\\b${allowed}\\b`), JSON.stringify(status));
    }
  } finally { await f.close(); }
});
