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
import type { Task, WorkPackage } from '../../src/shared/contracts/tasks';

const at = '2026-10-22T00:00:00.000Z';
const blockedLaunch = (input: OwnerLaunchInput): OwnerLaunchResult => { throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `Test did not inject an owner launcher for ${input.taskId}`); };

function fixture(): { task: Task; pkg: WorkPackage } {
  const id = randomUUID();
  const ownerId = randomUUID();
  const packageId = randomUUID();
  const task: Task = {
    id, ownerId, packageId,
    title: 'Projection fixture',
    instruction: 'INSTRUCTION-BODY '.repeat(500),
    workspace: '/work/project',
    acceptanceCriteria: ['ACCEPTANCE-CRITERIA'],
    constraints: ['CONSTRAINT-BODY'],
    owner: { name: 'fixture', transport: 'herdr-visible', session: 'test', pane: '1' },
    createdAt: at, updatedAt: at, status: 'running', progress: 42, revision: 4,
    reviewState: 'pending',
    summary: 'SUMMARY-BODY '.repeat(500),
    dispatch: { owner: 'codex_owner', worker: 'codex-1', engine: 'codex', model: 'gpt-6-astra', effort: 'high', execution: 'native', maxParallel: 2, maxWaitMinutes: 30, adapter: 'native', workspace: '/work/project', engineKind: 'codex', workspaceIdentity: 'identity' },
    run: { id: randomUUID(), adapter: 'codex', execution: 'native', status: 'running', engine: 'codex', model: 'gpt-6-astra', effort: 'high', replay: { stdoutOffset: 10, stderrOffset: 5, appliedRecords: 3 }, stderrTail: 'STDERR-TAIL', resultSummary: 'RESULT-SUMMARY' },
    events: [
      { id: randomUUID(), at, kind: 'log', message: 'EVENT-ONE' },
      { id: randomUUID(), at, kind: 'log', message: 'EVENT-TWO' },
    ],
    artifacts: [{ id: randomUUID(), name: 'result.md', mediaType: 'text/markdown', content: 'ARTIFACT-BODY', createdAt: at }],
  };
  const pkg: WorkPackage = { id: packageId, taskId: id, revision: 1, instruction: task.instruction, scope: ['projection fixture'], acceptanceCriteria: ['acceptance'], createdAt: at };
  return { task, pkg };
}

function setup() {
  const { task, pkg } = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'weaver-projection-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const manager = new TaskManager(store, new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs')));
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  store.transaction(() => { store.put(task); store.putPackage(pkg); });
  const handler = new CommandHandler(manager, policy, blockedLaunch, () => false);
  const raw = (command: string, args: Record<string, unknown> = {}) => handler.handle({ apiVersion: 'weaver.v1', command, args });
  const call = (command: string, args: Record<string, unknown> = {}) => { const response = raw(command, args); assert.equal(response.ok, true, JSON.stringify(response)); return response.data as any; };
  return { dir, store, task, handler, raw, call, close: async () => { handler.draining = true; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('tasks get and list default to the unchanged full response', async () => {
  const f = setup();
  try {
    const detail = f.call('tasks.get', { taskId: f.task.id });
    for (const key of ['instruction', 'summary', 'acceptanceCriteria', 'constraints', 'events', 'artifacts', 'run', 'next']) assert.ok(key in detail, key);
    assert.equal(detail.instruction, f.task.instruction);
    assert.equal(detail.run.replay.appliedRecords, 3);
    assert.equal(detail.run.stderrTail, 'STDERR-TAIL');
    assert.equal(detail.next.action, 'run_subagent');
    assert.equal(detail.events.length, 2);
    assert.equal(detail.artifacts[0].content, 'ARTIFACT-BODY');

    const list = f.call('tasks.list', {});
    const item = list.tasks[0];
    for (const key of ['instruction', 'summary', 'acceptanceCriteria', 'constraints', 'run', 'eventCount', 'artifactCount']) assert.ok(key in item, key);
    assert.equal(item.instruction, f.task.instruction);
    assert.equal(item.run.replay.appliedRecords, 3);
    assert.equal(item.run.stderrTail, 'STDERR-TAIL');
    assert.equal(item.artifactCount, 1);
    assert.equal('events' in item, false);
    assert.equal('artifacts' in item, false);
  } finally { await f.close(); }
});

test('brief keeps the required short fields and drops long bodies, history and next', async () => {
  const f = setup();
  try {
    const item = f.call('tasks.list', { view: 'brief' }).tasks[0];
    assert.deepEqual(Object.keys(item).sort(), ['dispatch', 'id', 'ownerId', 'parentTaskId', 'progress', 'reviewState', 'status', 'title', 'updatedAt', 'workspace'].sort());
    assert.equal(item.id, f.task.id);
    assert.equal(item.status, 'running');
    assert.equal(item.reviewState, 'pending');
    assert.equal(item.progress, 42);
    assert.equal(item.workspace, '/work/project');
    assert.equal(item.title, 'Projection fixture');
    assert.equal(item.ownerId, f.task.ownerId);
    assert.equal(item.parentTaskId, null);
    assert.equal(item.updatedAt, at);
    assert.deepEqual(item.dispatch, { owner: 'codex_owner', worker: 'codex-1', engine: 'codex', model: 'gpt-6-astra', effort: 'high', execution: 'native', maxParallel: 2, maxWaitMinutes: 30, engineKind: 'codex' });
    for (const key of ['instruction', 'summary', 'acceptanceCriteria', 'constraints', 'run', 'events', 'artifacts', 'contextPack', 'continuationHistory']) assert.equal(key in item, false, key);
    assert.doesNotMatch(JSON.stringify(item), /INSTRUCTION-BODY|SUMMARY-BODY|STDERR-TAIL|ARTIFACT-BODY/);

    const detail = f.call('tasks.get', { taskId: f.task.id, view: 'brief' });
    assert.equal('next' in detail, false);
    assert.equal('run' in detail, false);
    assert.equal('events' in detail, false);
    assert.equal('artifacts' in detail, false);
    assert.doesNotMatch(JSON.stringify(detail), /INSTRUCTION-BODY|SUMMARY-BODY|STDERR-TAIL|ARTIFACT-BODY/);
  } finally { await f.close(); }
});

test('fields projects top-level fields on the chosen view and may select full-only fields explicitly', async () => {
  const f = setup();
  try {
    const listed = f.call('tasks.list', { view: 'brief', fields: ['id', 'status', 'title', 'dispatch'] });
    assert.deepEqual(Object.keys(listed.tasks[0]), ['id', 'status', 'title', 'dispatch']);
    assert.equal(listed.tasks[0].dispatch.worker, 'codex-1');

    const fullFields = f.call('tasks.get', { taskId: f.task.id, fields: ['id', 'run'] });
    assert.deepEqual(Object.keys(fullFields), ['id', 'run']);
    assert.equal(fullFields.run.replay.appliedRecords, 3);

    const explicitLong = f.call('tasks.get', { taskId: f.task.id, view: 'brief', fields: ['id', 'instruction'] });
    assert.deepEqual(Object.keys(explicitLong), ['id', 'instruction']);
    assert.equal(explicitLong.instruction, f.task.instruction);

    const deduped = f.call('tasks.list', { fields: ['id', 'id', 'status'] });
    assert.deepEqual(deduped.tasks[0], { id: f.task.id, status: 'running' });

    const absent = f.call('tasks.get', { taskId: f.task.id, view: 'brief', fields: ['id', 'summary'] });
    assert.deepEqual(absent, { id: f.task.id, summary: f.task.summary });
  } finally { await f.close(); }
});

test('invalid view and fields fail with INVALID_ARGUMENT and the allowed field list', async () => {
  const f = setup();
  try {
    const invalidView = f.raw('tasks.list', { view: 'compact' });
    assert.equal(invalidView.ok, false); assert.equal(invalidView.error?.code, 'INVALID_ARGUMENT'); assert.match(invalidView.error!.message, /full.*brief/);

    for (const fields of [[], [''], 'id', [12]]) {
      const response = f.raw('tasks.list', { fields });
      assert.equal(response.ok, false, JSON.stringify(fields)); assert.equal(response.error?.code, 'INVALID_ARGUMENT');
      assert.match(response.error!.message, /fields/);
    }

    const unknown = f.raw('tasks.get', { taskId: f.task.id, fields: ['id', 'nope'] });
    assert.equal(unknown.ok, false); assert.equal(unknown.error?.code, 'INVALID_ARGUMENT');
    assert.match(unknown.error!.message, /Unknown field "nope"/);
    assert.match(unknown.error!.message, /Allowed fields: .*instruction/);
    assert.match(unknown.error!.message, /events/);
  } finally { await f.close(); }
});

test('empty filtered lists keep the normal pagination envelope in brief and fields views', async () => {
  const f = setup();
  try {
    const emptyOwner = randomUUID();
    for (const args of [{ view: 'brief', ownerId: emptyOwner }, { fields: ['id', 'status'], ownerId: emptyOwner }]) {
      const response = f.raw('tasks.list', args);
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.deepEqual((response.data as any).tasks, []);
      assert.equal((response.data as any).nextOffset, null);
    }
  } finally { await f.close(); }
});
