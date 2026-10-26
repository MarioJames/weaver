import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task } from '../../src/shared/contracts/tasks';
import { ATTENTION_WINDOW_MS, REVIEW_WAIT_ATTENTION_MS, attentionCount, attentionTasks, needsAttention } from '../../src/renderer/features/tasks/task-attention';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const owner = { name: 'parent', transport: 'herdr-visible' as const, session: 's', pane: 'p' };
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const make = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `任务 ${id}`,
  instruction: 'x',
  owner,
  status: 'queued',
  progress: 0,
  createdAt: minutesAgo(120),
  updatedAt: minutesAgo(60),
  events: [],
  artifacts: [],
  ...extra,
});

const failed = (id: string, extra: Partial<Task> = {}) => make(id, { status: 'failed', ...extra });
const completed = (id: string, reviewState: Task['reviewState'], extra: Partial<Task> = {}) => make(id, { status: 'completed', reviewState, ...extra });

test('a failed task needs attention until it is retried or superseded', () => {
  const unattended = failed('failed');
  assert.equal(needsAttention(unattended, [unattended], NOW), true);
  const retry = make('retry', { status: 'running', retryOf: 'failed' });
  assert.equal(needsAttention(unattended, [unattended, retry], NOW), false);
  assert.equal(needsAttention(failed('replaced', { supersededBy: 'other' }), [], NOW), false);
  assert.equal(needsAttention(make('running', { status: 'running' }), [], NOW), false);
});

test('a rejected task needs attention until a retry exists', () => {
  const rejected = completed('rejected', 'rejected');
  assert.equal(needsAttention(rejected, [rejected], NOW), true);
  assert.equal(needsAttention(rejected, [rejected, make('retry', { status: 'queued', retryOf: 'rejected' })], NOW), false);
  assert.equal(needsAttention(completed('accepted', 'accepted'), [], NOW), false);
});

test('pending reviews cross the attention line after 30 minutes, measured by task-wait', () => {
  assert.equal(REVIEW_WAIT_ATTENTION_MS, 30 * 60 * 1000);
  const at29 = completed('pending-29', undefined, { updatedAt: minutesAgo(29) });
  const at30 = completed('pending-30', 'pending', { updatedAt: minutesAgo(30) });
  const at31 = completed('pending-31', undefined, { updatedAt: minutesAgo(31) });
  assert.equal(needsAttention(at29, [at29], NOW), false);
  assert.equal(needsAttention(at30, [at30], NOW), false, 'exactly 30 minutes is not "over 30"');
  assert.equal(needsAttention(at31, [at31], NOW), true);
  const task = completed('run-end', 'pending', {
    updatedAt: minutesAgo(1),
    run: { id: 'run', adapter: 'x', status: 'stopped', endedAt: minutesAgo(31) },
  });
  assert.equal(needsAttention(task, [task], NOW), true, 'the run end is the wait anchor when present');
});

test('parent Agent roots never count, even when failed', () => {
  const root = failed('root', { executionRole: 'owner' });
  assert.equal(needsAttention(root, [root], NOW), false);
  const child = failed('child', { parentTaskId: 'root' });
  assert.equal(needsAttention(child, [root, child], NOW), true);
});

test('the attention window is seven days', () => {
  assert.equal(ATTENTION_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
});

test('failures older than the window leave the attention set', () => {
  const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
  const fresh = failed('fresh', { updatedAt: daysAgo(6) });
  const stale = failed('stale', { updatedAt: daysAgo(8) });
  assert.equal(needsAttention(fresh, [fresh], NOW), true);
  assert.equal(needsAttention(stale, [stale], NOW), false);
  assert.equal(attentionCount([fresh, stale], NOW), 1);
});

test('attentionCount counts the union once', () => {
  const tasks = [
    failed('f'),
    make('retried', { status: 'running', retryOf: 'f' }),
    completed('rejected', 'rejected'),
    completed('pending', undefined, { updatedAt: minutesAgo(31) }),
    completed('fresh', 'pending', { updatedAt: minutesAgo(5) }),
    make('running', { status: 'running' }),
    failed('root', { executionRole: 'owner' }),
  ];
  assert.equal(attentionCount(tasks, NOW), 2);
});

test('drafts never count, even when fresh', () => {
  const draft = make('draft', { updatedAt: minutesAgo(1) });
  assert.equal(needsAttention(draft, [draft], NOW), false);
  const rootDraft = make('root-draft', { ownerId: 'owner-1', updatedAt: minutesAgo(1) });
  assert.equal(needsAttention(rootDraft, [rootDraft], NOW), false);
  assert.equal(attentionCount([draft, rootDraft], NOW), 0);
});

test('attentionTasks lists exactly what attentionCount counts, newest first', () => {
  const tasks = [
    failed('old-failure', { updatedAt: minutesAgo(120) }),
    completed('fresh-rejected', 'rejected', { updatedAt: minutesAgo(10) }),
    completed('old-rejected', 'rejected', { updatedAt: minutesAgo(200) }),
    make('draft', { updatedAt: minutesAgo(1) }),
  ];
  const listed = attentionTasks(tasks, NOW);
  assert.deepEqual(listed.map(task => task.id), ['fresh-rejected', 'old-failure', 'old-rejected']);
  assert.equal(listed.length, attentionCount(tasks, NOW));
});
