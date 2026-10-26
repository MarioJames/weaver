import assert from 'node:assert/strict';
import test from 'node:test';
import type { OwnerInstance } from '../../src/shared/contracts/owners';
import type { Task } from '../../src/shared/contracts/tasks';
import {
  buildSessions, retryAttemptOf, retryChains, sessionKeyOf, sessionTitle, sessionWorkspaceLabel,
} from '../../src/renderer/features/tasks/task-session';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const owner = { name: 'parent', transport: 'herdr-visible' as const, session: 's', pane: 'p' };

const make = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `任务 ${id}`, instruction: 'goal', owner, status: 'queued', progress: 0,
  createdAt: iso(120), updatedAt: iso(60), events: [], artifacts: [], ...extra,
});

const instance = (id: string, extra: Partial<OwnerInstance> = {}): OwnerInstance => ({
  id, name: `Claude · weaver · 21:30`, profileId: 'claude_owner', mode: 'manual',
  state: 'ready', createdAt: iso(180), runningTaskCount: 0, ...extra,
});

test('a web root and its children share r-<rootId>, even with a different ownerId', () => {
  const root = make('root', { executionRole: 'owner', ownerId: 'inst-1' });
  const child = make('c1', { parentTaskId: 'root', ownerId: 'other-instance' });
  const byId = new Map([[root.id, root], [child.id, child]]);
  assert.equal(sessionKeyOf(root, byId), 'r-root');
  assert.equal(sessionKeyOf(child, byId), 'r-root');
});

test('a page-created root draft already belongs to r-<id> before it starts', () => {
  const draft = make('draft', { ownerId: 'inst-1', owner: { ...owner, name: 'Task owner' } });
  const byId = new Map([[draft.id, draft]]);
  assert.equal(sessionKeyOf(draft, byId), 'r-draft');
  const started = buildSessions([draft], [instance('inst-1')], NOW).find(item => item.key === 'r-draft');
  assert.ok(started);
  assert.equal(started.root?.id, 'draft');
  assert.equal(started.tasks.length, 0);
});

test('host tasks group by ownerId, legacy tasks fall into unowned', () => {
  const host = make('h', { ownerId: 'inst-9' });
  const legacy = make('old');
  const byId = new Map([[host.id, host], [legacy.id, legacy]]);
  assert.equal(sessionKeyOf(host, byId), 'o-inst-9');
  assert.equal(sessionKeyOf(legacy, byId), 'unowned');
});

test('a non-root child points at its web root, not at its owner', () => {
  const root = make('root', { executionRole: 'owner' });
  const child = make('c', { parentTaskId: 'root', ownerId: 'inst-1' });
  const lone = make('lone', { parentTaskId: 'missing', ownerId: 'inst-1' });
  const byId = new Map([[root.id, root], [child.id, child], [lone.id, lone]]);
  assert.equal(sessionKeyOf(child, byId), 'r-root');
  assert.equal(sessionKeyOf(lone, byId), 'o-inst-1');
});

test('session titles never show the full instance name', () => {
  const named = make('root', { executionRole: 'owner', title: '迁移构建脚本' });
  assert.equal(sessionTitle(named, instance('i')), '迁移构建脚本');
  assert.equal(sessionTitle(undefined, instance('i', { title: '夜间值守' })), '夜间值守');
  const fallback = sessionTitle(undefined, instance('i', { name: 'Claude · weaver · 21:30' }));
  assert.match(fallback, /^Claude · \d\d:\d\d$/);
  assert.doesNotMatch(fallback, /weaver/);
  assert.equal(sessionTitle(undefined, undefined), '未归属的任务');
});

test('buildSessions splits roots, hosts and legacy work with counts and attention', () => {
  const root = make('root', { executionRole: 'owner', title: '网页目标', status: 'running', dispatch: undefined, workspace: '/repo/a' });
  const running = make('c1', { parentTaskId: 'root', status: 'running', dispatch: { owner: 'p', worker: 'w1', engine: 'claude', model: '', effort: '', execution: 'real', maxParallel: 1, workspace: '/repo/a' }, updatedAt: iso(5) });
  const failed = make('c2', { parentTaskId: 'root', status: 'failed', updatedAt: iso(10) });
  const hostTask = make('h1', { ownerId: 'inst-1', status: 'completed', reviewState: 'accepted', updatedAt: iso(20) });
  const legacy = make('old', { status: 'cancelled', updatedAt: iso(30) });
  const sessions = buildSessions([root, running, failed, hostTask, legacy], [instance('inst-1', { title: '值守' })], NOW);
  assert.deepEqual(sessions.map(session => session.key).sort(), ['o-inst-1', 'r-root', 'unowned']);
  const web = sessions.find(session => session.key === 'r-root')!;
  assert.equal(web.kind, 'root');
  assert.equal(web.title, '网页目标');
  assert.equal(web.root?.id, 'root');
  assert.deepEqual(web.tasks.map(task => task.id).sort(), ['c1', 'c2']);
  assert.ok(!web.tasks.some(task => task.id === 'root'), 'the root itself is not a list task');
  assert.equal(web.counts.running, 1);
  assert.equal(web.attention, 1);
  assert.equal(web.workspace, '/repo/a');
  const host = sessions.find(session => session.key === 'o-inst-1')!;
  assert.equal(host.kind, 'host');
  assert.equal(host.title, '值守');
  assert.equal(host.tasks.length, 1);
  const unowned = sessions.find(session => session.key === 'unowned')!;
  assert.equal(unowned.kind, 'unowned');
  assert.equal(unowned.title, '未归属的任务');
});

test('retry chains file every attempt under the original, oldest first', () => {
  const first = make('t1', { status: 'failed', createdAt: iso(300) });
  const second = make('t2', { status: 'failed', retryOf: 't1', createdAt: iso(200) });
  const third = make('t3', { status: 'running', retryOf: 't2', createdAt: iso(100) });
  const chains = retryChains([third, first, second]);
  assert.deepEqual(chains.get('t1')?.map(task => task.id), ['t1', 't2', 't3']);
  assert.equal(retryAttemptOf(first, chains), 1);
  assert.equal(retryAttemptOf(second, chains), 2);
  assert.equal(retryAttemptOf(third, chains), 3);
});

test('workspace labels keep only the directory name', () => {
  assert.equal(sessionWorkspaceLabel('/repo/frontend'), 'frontend');
  assert.equal(sessionWorkspaceLabel('/repo/frontend/'), 'frontend');
  assert.equal(sessionWorkspaceLabel(''), '未指定工作目录');
});
