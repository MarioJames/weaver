import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { cardOwner, emptyRootNotice, withOwnerProfiles } from '../../src/renderer/features/tasks/task-view';
import { cardFooter, cardFooterText } from '../../src/renderer/features/tasks/task-footer';
import { buildSessions, sessionKeyOf } from '../../src/renderer/features/tasks/task-session';

const now = Date.parse('2026-10-19T12:00:00Z');
const hoursAgo = (hours: number) => new Date(now - hours * 3600000).toISOString();
const placeholder = { name: 'Task owner', transport: 'herdr-visible' as const, session: '', pane: '' };
const make = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `任务 ${id}`, instruction: '', owner: placeholder, status: 'running', progress: 0,
  createdAt: hoursAgo(1), updatedAt: hoursAgo(1), events: [], artifacts: [], ...extra,
});
const dispatch = (owner: string, worker: string): Task['dispatch'] => ({ owner, worker, engine: 'claude', engineKind: 'claude', model: '', effort: 'high', execution: 'real', maxParallel: 1 });

/** A-type: a page-created root with its children; the children answer for the root by parentTaskId. */
const root1 = make('root1', { executionRole: 'owner', title: '重构登录页', ownerId: 'inst-root1' });
const childA1 = make('c1', { parentTaskId: 'root1', ownerId: 'inst-root1', status: 'running', dispatch: dispatch('claude_owner', 'w1') });
const childA2 = make('c2', { parentTaskId: 'root1', ownerId: 'inst-root1', status: 'queued', dispatch: dispatch('claude_owner', 'w2') });
/** B-type: a manually attached parent Agent instance; its tasks carry the instance id and no root. */
const taskB = make('b1', { ownerId: 'inst-b', owner: { ...placeholder, name: 'Claude · weaver · 22:37' }, dispatch: dispatch('claude_owner', 'w3') });
/** Legacy fallback: no registration name, no root; the frozen policy profile answers. */
const legacy = make('l1', { status: 'failed', dispatch: dispatch('legacy_owner', 'w4') });
/** A-type roots with no children at all: one splitting, one failed. */
const root2 = make('root2', { executionRole: 'owner', title: '迁移数据库' });
const root3 = make('root3', { executionRole: 'owner', title: '部署预览环境', status: 'failed', failure: { kind: 'other', message: 'herdr 未安装' } });
const tasks = [root1, childA1, childA2, taskB, legacy, root2, root3];
const rootById = (id: string) => (id === 'root1' ? root1 : undefined);

test('sessions hold exactly the sub agent tasks; owner roots stay out of the task lists', () => {
  const sessions = buildSessions(tasks, [], now);
  const web = sessions.find(session => session.key === 'r-root1')!;
  assert.deepEqual(web.tasks.map(task => task.id).sort(), ['c1', 'c2']);
  assert.equal(web.root?.id, 'root1');
  assert.ok(!web.tasks.some(task => task.executionRole === 'owner' && !task.parentTaskId));
  assert.equal(sessionKeyOf(childA1, new Map(tasks.map(task => [task.id, task]))), 'r-root1');
  assert.equal(sessionKeyOf(taskB, new Map(tasks.map(task => [task.id, task]))), 'o-inst-b');
  // A retried child is a finished task like any other, shown once in 已结束.
  const retried = [root1, make('c0', { parentTaskId: 'root1', ownerId: 'inst-root1', status: 'failed', updatedAt: hoursAgo(2), dispatch: dispatch('claude_owner', 'w1') }), make('c1r', { parentTaskId: 'root1', ownerId: 'inst-root1', status: 'running', retryOf: 'c0', dispatch: dispatch('claude_owner', 'w1') })];
  const retrySession = buildSessions(retried, [], now).find(session => session.key === 'r-root1')!;
  assert.deepEqual(retrySession.tasks.map((task: Task) => task.id).sort(), ['c0', 'c1r']);
});

test('a childless web session keeps its root with an empty task list and explains what happens', () => {
  const sessions = buildSessions([root2, root3], [], now);
  assert.deepEqual(sessions.map(session => session.key).sort(), ['r-root2', 'r-root3']);
  assert.ok(sessions.every(session => session.tasks.length === 0));
  assert.equal(sessions.find(session => session.key === 'r-root2')?.root?.title, '迁移数据库');
  // The notice speaks for the root task only; a selected parent with children behaves as before.
  assert.equal(emptyRootNotice(root2), '父 Agent「迁移数据库」正在拆分任务，子任务会自动出现在这里。');
  assert.equal(emptyRootNotice({ ...root2, status: 'cancelled' as const }), '父 Agent「迁移数据库」已取消，没有子任务。');
});

test('footers name the parent Agent: root title for A-type children, instance abbreviations for B-type', () => {
  // The pure sentence keeps the same names for text renderings.
  const footer = cardFooter(childA1, cardOwner(childA1, rootById));
  assert.equal(footer.owner, '重构登录页');
  assert.match(cardFooterText(footer, now), /^由 重构登录页 于/);
  const bFooter = cardFooter(taskB, cardOwner(taskB));
  assert.equal(bFooter.owner, 'Claude');
  assert.equal(bFooter.ownerTitle, 'Claude · weaver · 22:37');
});

/** A manually described instance: the backend carries a short title for the instance's current main task. */
const described = { id: 'inst-t', name: 'Claude · weaver · 22:37', profileId: 'claude_owner', title: '修复登录崩溃' };
const taskT = make('t1', { ownerId: 'inst-t', owner: { ...placeholder, name: 'Claude · weaver · 22:37' }, dispatch: dispatch('claude_owner', 'w5') });
const enriched = withOwnerProfiles([root1, childA1, taskB, legacy, taskT], [described, { id: 'inst-b', name: 'Claude · weaver · 22:37', profileId: 'claude_owner' }]);

test('described titles name the session and the footer; A-type children are untouched', () => {
  const enrichedT = enriched.find(task => task.id === 't1')!;
  const owner = cardOwner(enrichedT);
  assert.deepEqual(owner, { name: '修复登录崩溃', title: '修复登录崩溃 · Claude · weaver · 22:37' });
  // Without a description the abbreviation stays.
  const bare = cardOwner(taskB);
  assert.deepEqual(bare, { name: 'Claude', title: 'Claude · weaver · 22:37' });
  // A-type children still answer by their root task even when instance titles are present.
  assert.deepEqual(cardOwner(childA1, rootById), { name: '重构登录页', title: '重构登录页' });
  const footer = cardFooter(taskT, owner);
  assert.equal(footer.owner, '修复登录崩溃');
});
