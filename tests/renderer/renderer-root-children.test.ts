import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../../src/main/policy/routing';
import { type Block } from '../../src/shared/contracts/policy';
import type { Task } from '../../src/shared/contracts/tasks';
import { OwnerScheduleFields, workerStatusTag, workerWeightLock } from '../../src/renderer/features/roles/OwnerSchedule';
import { TaskAgents } from '../../src/renderer/features/tasks/TaskAgents';
import { TaskBoard } from '../../src/renderer/features/tasks/TaskBoard';
import { TaskComposer, criteriaError, criteriaLines } from '../../src/renderer/features/tasks/TaskComposer';
import { createTask } from '../../src/renderer/features/tasks/task-create';
import { childSummary, childSummaryLabel, recentWorkspaces, rootCancelNotice } from '../../src/renderer/features/tasks/task-view';
import { columnize } from '../../src/renderer/features/tasks/task-columns';
import { archivedTasks, nonArchived } from '../../src/renderer/features/tasks/task-archive';
import { emptySelection } from '../../src/renderer/features/tasks/task-filters';
import { ENDED_EXPANDED_KEY } from '../../src/renderer/features/tasks/task-persistence';

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) }));
}
function withStorage<T>(run: () => T): T {
  const values: Record<string, string> = { [ENDED_EXPANDED_KEY]: 'true' };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } } });
  try { return run(); } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
}

const now = Date.parse('2026-10-19T12:00:00Z');
const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 's', pane: 'p' };
const make = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: `任务 ${id}`, instruction: 'x', owner, status: 'running', progress: 0, createdAt: '2026-10-19T11:00:00Z', updatedAt: '2026-10-19T11:30:00Z', events: [], artifacts: [], ...extra });
const root = make('root', { executionRole: 'owner', title: '根任务' });
const child = (id: string, status: Task['status'], extra: Partial<Task> = {}) => make(id, { parentTaskId: 'root', status, title: `子任务 ${id}`, ...extra });
const DAY = 24 * 3600e3;

test('children whose root is listed are not board cards; an orphan child still is', () => {
  const orphan = make('orphan', { parentTaskId: 'missing', title: '孤立子任务' });
  const tasks = [root, child('c1', 'running'), child('c2', 'completed'), orphan];
  assert.deepEqual(nonArchived(tasks, now).map(task => task.id), ['root', 'orphan']);
  const html = withStorage(() => markup(React.createElement(TaskBoard, { tasks, filters: { ...emptySelection(), time: 'all' }, now, loading: false, onSelect: () => {} })));
  assert.match(html, /根任务/);
  assert.match(html, /孤立子任务/);
  assert.doesNotMatch(html, /子任务 c1|子任务 c2/);
});

test('board lanes, filter counts and the archive count all leave nested children out', () => {
  const old = new Date(now - 2 * DAY).toISOString();
  const tasks = [
    root, child('c1', 'running'), child('c2', 'completed', { reviewState: 'accepted' }),
    make('oldroot', { executionRole: 'owner', status: 'completed', reviewState: 'accepted', updatedAt: old }),
    make('oldchild', { parentTaskId: 'oldroot', status: 'completed', reviewState: 'accepted', updatedAt: old }),
  ];
  const lanes = columnize(nonArchived(tasks, now));
  assert.deepEqual(lanes.map(lane => lane.map(task => task.id)), [[], ['root'], [], []]);
  assert.deepEqual(archivedTasks(tasks, now).map(task => task.id), ['oldroot']);
});

test('a root card summarises its final children; none means no summary', () => {
  const tasks = [root, child('c1', 'running'), child('c2', 'completed'), child('c3', 'completed'), child('c4', 'queued')];
  assert.deepEqual(childSummary(root, tasks), { total: 4, completed: 2, running: 1 });
  assert.equal(childSummaryLabel({ total: 3, completed: 2, running: 1 }), '子任务 2/3 完成 · 1 运行中');
  assert.equal(childSummaryLabel({ total: 3, completed: 3, running: 0 }), '子任务 3/3 完成');
  assert.equal(childSummary(root, [root]), undefined);
  assert.equal(childSummary(make('plain'), [make('plain'), child('c1', 'running')]), undefined);
  // A failed child that was retried is replaced by its retry and counts once.
  const retried = [root, child('a', 'failed'), child('b', 'running', { retryOf: 'a' })];
  assert.deepEqual(childSummary(root, retried), { total: 1, completed: 0, running: 1 });
  const html = withStorage(() => markup(React.createElement(TaskBoard, { tasks: [root, child('c1', 'running'), child('c2', 'completed'), child('c3', 'completed')], filters: { ...emptySelection(), time: 'all' }, now, loading: false, onSelect: () => {} })));
  assert.match(html, /子任务 2\/3 完成 · 1 运行中/);
  const bare = withStorage(() => markup(React.createElement(TaskBoard, { tasks: [root], filters: { ...emptySelection(), time: 'all' }, now, loading: false, onSelect: () => {} })));
  assert.doesNotMatch(bare, /子任务 \d+\/\d+/);
});

test('cancelling a running root explains the cascade; other tasks get no prompt', () => {
  const tasks = [root, child('c1', 'running'), child('c2', 'queued'), child('c3', 'completed')];
  const notice = rootCancelNotice(root, tasks);
  assert.ok(notice);
  assert.match(notice.description, /同时取消全部未结束的子任务（当前 2 个）/);
  assert.match(notice.description, /关闭 Herdr 中的父 Agent/);
  assert.equal(rootCancelNotice(make('plain'), tasks), undefined);
  assert.equal(rootCancelNotice({ ...root, status: 'completed' }, tasks), undefined);
  assert.equal(rootCancelNotice(child('c1', 'running'), tasks), undefined);
});

test('the composer offers 存为草稿 beside the primary 创建并开始', () => {
  const html = markup(React.createElement(TaskComposer, { disabled: false, draft: { goal: '', workspace: '', profile: '' }, onDraft: () => {}, onCreate: async () => true }));
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
  const create = buttons.find(button => button.includes('存为草稿'));
  const start = buttons.find(button => button.includes('创建并开始'));
  assert.ok(create && start);
  assert.match(create, /type="button"/);
  assert.match(start, /type="submit"/);
  assert.ok(buttons.indexOf(create) < buttons.indexOf(start));
  const busy = markup(React.createElement(TaskComposer, { disabled: true, draft: { goal: 'g', workspace: '/w', profile: 'p' }, onDraft: () => {}, onCreate: async () => true }));
  for (const label of ['存为草稿', '创建并开始']) assert.match([...busy.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes(label)) ?? '', /disabled/);
});

test('存为草稿 only creates and selects; 创建并开始 also starts, and a failed start never creates twice', async () => {
  const calls: string[] = [];
  const api = (failStart = false) => ({
    create: async () => { calls.push('create'); return { id: 'new1' }; },
    start: async (id: string) => { calls.push(`start:${id}`); if (failStart) throw new Error('boom'); },
    select: (id: string) => { calls.push(`select:${id}`); },
    startFailed: (id: string) => { calls.push(`failed:${id}`); },
  });
  await createTask({}, false, api());
  assert.deepEqual(calls.splice(0), ['create', 'select:new1']);
  await createTask({}, true, api());
  assert.deepEqual(calls.splice(0), ['create', 'select:new1', 'start:new1']);
  await createTask({}, true, api(true));
  assert.deepEqual(calls.splice(0), ['create', 'select:new1', 'start:new1', 'failed:new1']);
});

function scheduleConfig() {
  const config = defaultConfig();
  config.engines.pi.enabled = true;
  config.workers.pi_worker.enabled = false;
  const record = { ...config.owners.claude_owner, workers: ['claude_worker', 'pi_worker', 'qoder_worker'], worker_weights: { pi_worker: 8, qoder_worker: 3 } };
  config.workers.qoder_worker.enabled = true;
  config.engines.qoder.enabled = true;
  return { config, record };
}
const rowOf = (html: string, id: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').match(new RegExp(`<div[^>]*>(?:(?!<div)[\\s\\S])*?${id} 的权重[\\s\\S]*?移除 ${id}`))?.[0] ?? '';

test('a disabled worker or disabled engine locks its weight; a temporary block does not', () => {
  const { config, record } = scheduleConfig();
  const blocks: Block[] = [{ engine: 'qoder', reason: 'rate limit', since: '2026-10-19T00:00:00Z', release_at: '2999-01-01T00:00:00Z' }];
  assert.deepEqual(workerWeightLock(config, 'pi_worker')?.label, '子 Agent 已停用');
  assert.equal(workerWeightLock(config, 'qoder_worker'), undefined);
  assert.equal(workerWeightLock(config, 'claude_worker'), undefined);
  // The engine is off while the worker itself is still on (a draft toggled on the engines page).
  const draft = structuredClone(config);
  draft.engines.claude.enabled = false;
  assert.equal(workerWeightLock(draft, 'claude_worker')?.label, '引擎已停用');
  assert.equal(workerStatusTag(draft, [], 'claude_worker', 5)?.label, '引擎已停用');
  assert.equal(workerStatusTag(config, blocks, 'qoder_worker', 3)?.label, '已限制');

  const html = markup(React.createElement(OwnerScheduleFields, { config, blocks, record, update: () => {} }));
  const pi = rowOf(html, 'pi_worker');
  assert.match(pi, /子 Agent 已停用/);
  assert.match(pi, /<input[^>]*id=[^>]*disabled=""/);
  assert.match(pi, /value="8"/);
  const button = (label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';
  for (const label of ['不派发', '默认', '最高']) { assert.match(button(`pi_worker ${label}`), /disabled=""/); assert.doesNotMatch(button(`qoder_worker ${label}`), /disabled/); }
  assert.ok(button('移除 pi_worker'));
  assert.doesNotMatch(button('移除 pi_worker'), /disabled/);
  const blocked = rowOf(html, 'qoder_worker');
  assert.match(blocked, /已限制/);
  assert.doesNotMatch(blocked, /data-disabled|\sdisabled=""/);
  assert.doesNotMatch(rowOf(html, 'claude_worker'), /data-disabled|\sdisabled=""/);
});

test('the composer has no title field, an optional acceptance-criteria field, and a directory picker rather than a path input', () => {
  const html = markup(React.createElement(TaskComposer, { disabled: false, draft: { goal: '', workspace: '', profile: '' }, onDraft: () => {}, onCreate: async () => true }));
  assert.doesNotMatch(html, /aria-label="(?:任务)?标题"|>标题</);
  assert.match(html, /aria-label="验收标准"/);
  assert.match(html, /父 Agent 接手后会根据目标生成/);
  assert.match(html, /aria-label="选择目标项目目录"/);
  assert.doesNotMatch(html, /<input[^>]*placeholder="[^"]*\/home/);
});

test('acceptance criteria are one per non-empty line, within the server bounds', () => {
  assert.deepEqual(criteriaLines(undefined), []);
  assert.deepEqual(criteriaLines(' 第一条 \n\n  \n第二条\n'), ['第一条', '第二条']);
  assert.equal(criteriaError('a\nb'), '');
  assert.match(criteriaError(Array.from({ length: 31 }, (_, index) => `c${index}`).join('\n')), /最多 30 条/);
  assert.match(criteriaError('x'.repeat(1001)), /1000/);
});

test('the directory picker offers the workspaces earlier tasks used: newest first, each once, absolute paths only', () => {
  const tasks = [
    make('a', { workspace: '/p/alpha', updatedAt: '2026-10-19T10:00:00Z' }),
    make('b', { workspace: '/p/beta/', updatedAt: '2026-10-19T11:30:00Z' }),
    make('c', { workspace: '/p/alpha', updatedAt: '2026-10-19T11:00:00Z' }),
    make('d', { workspace: 'relative/dir', updatedAt: '2026-10-19T11:45:00Z' }),
    make('e', { workspace: undefined, updatedAt: '2026-10-19T11:50:00Z' }),
  ];
  assert.deepEqual(recentWorkspaces(tasks), ['/p/beta', '/p/alpha']);
  assert.deepEqual(recentWorkspaces(tasks, 1), ['/p/beta']);
  assert.deepEqual(recentWorkspaces([]), []);
});

test('a child that will never be dispatched is not said to be waiting for a sub agent', () => {
  const tasks = [root, child('c1', 'queued'), child('c2', 'cancelled')];
  const html = markup(React.createElement(TaskAgents, { task: root, tasks }));
  assert.equal((html.match(/等待派发子 Agent/g) ?? []).length, 1);
  assert.match(html, /未派发给子 Agent/);
});
