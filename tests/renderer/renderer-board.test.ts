import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { cardFooterText } from '../../src/renderer/features/tasks/task-footer';
import { cardOwner } from '../../src/renderer/features/tasks/task-view';
import {
  BOARD_CLOSED_WINDOW_MS, applyBoardFilters, boardColumnCounts, boardColumnOf, boardVisible,
  boardWorkspaceOptions, groupBoardColumn, isBoardHealthAlert, isGroupCollapsed,
} from '../../src/renderer/features/tasks/task-board';
import {
  WORKBENCH_BOARD_KEY, defaultWorkbenchBoard, readWorkbenchBoard, writeWorkbenchBoard,
} from '../../src/renderer/features/tasks/task-persistence';
import { TaskBoardView, BoardHealthBadge } from '../../src/renderer/features/tasks/TaskBoard';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const owner = { name: 'MockClaude · alpha · 09:41', transport: 'herdr-visible' as const, session: 's', pane: 'p' };

const make = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `任务 ${id}`, instruction: 'goal', owner, status: 'queued', progress: 0,
  createdAt: iso(120), updatedAt: iso(60), events: [], artifacts: [], ...extra,
});

const draftOf = (id: string, extra: Partial<Task> = {}): Task => make(id, extra);

test('board columns cover every display state: draft/scheduled, running, review, closed', () => {
  assert.equal(boardColumnOf(draftOf('d')), 'queued');
  assert.equal(boardColumnOf(make('s', { scheduled: true })), 'queued');
  assert.equal(boardColumnOf(make('q')), 'queued');
  assert.equal(boardColumnOf(make('r', { status: 'running' })), 'running');
  assert.equal(boardColumnOf(make('c', { status: 'cancelling' })), 'running');
  assert.equal(boardColumnOf(make('v', { status: 'completed' })), 'review');
  assert.equal(boardColumnOf(make('v2', { status: 'completed', reviewState: 'pending' })), 'review');
  for (const [status, reviewState] of [
    ['completed', 'accepted'], ['completed', 'rejected'], ['failed', undefined], ['cancelled', undefined],
  ] as const) {
    assert.equal(boardColumnOf(make(`${status}-${reviewState}`, { status, reviewState })), 'closed', `${status}/${reviewState}`);
  }
});

test('the board drops owner roots and closed work past the 24 hour window', () => {
  const root = make('root', { executionRole: 'owner' });
  const fresh = make('fresh', { status: 'completed', reviewState: 'accepted', updatedAt: iso(23 * 60) });
  const edge = make('edge', { status: 'failed', updatedAt: new Date(NOW - BOARD_CLOSED_WINDOW_MS + 60_000).toISOString() });
  const old = make('old', { status: 'failed', updatedAt: new Date(NOW - BOARD_CLOSED_WINDOW_MS - 60_000).toISOString() });
  const open = make('open', { status: 'running', updatedAt: iso(3000) });
  const visible = boardVisible([root, fresh, edge, old, open], NOW).map(task => task.id).sort();
  assert.deepEqual(visible, ['edge', 'fresh', 'open']);
});

test('columns group by workspace with a heading even for a single group, newest group first', () => {
  const first = make('a1', { workspace: '/repo/alpha', updatedAt: iso(50) });
  const second = make('a2', { workspace: '/repo/alpha', updatedAt: iso(10) });
  const other = make('b1', { workspace: '/repo/beta', updatedAt: iso(30) });
  const groups = groupBoardColumn([first, second, other]);
  assert.deepEqual(groups.map(group => group.workspace), ['/repo/alpha', '/repo/beta']);
  assert.equal(groups[0]!.label, 'alpha');
  assert.deepEqual(groups[0]!.tasks.map(task => task.id), ['a2', 'a1']);
  const single = groupBoardColumn([first]);
  assert.equal(single.length, 1);
  assert.equal(single[0]!.label, 'alpha');
  assert.deepEqual(boardWorkspaceOptions([first, other]).map(option => option.label).sort(), ['alpha', 'beta']);
});

test('closed groups start folded, live columns start open, stored choices win', () => {
  assert.equal(isGroupCollapsed({}, 'closed', '/repo/alpha'), true);
  for (const column of ['queued', 'running', 'review'] as const) {
    assert.equal(isGroupCollapsed({}, column, '/repo/alpha'), false);
  }
  assert.equal(isGroupCollapsed({ 'closed:/repo/alpha': false }, 'closed', '/repo/alpha'), false);
  assert.equal(isGroupCollapsed({ 'queued:/repo/alpha': true }, 'queued', '/repo/alpha'), true);
});

test('the card footer names only the host segment and never the full instance name', () => {
  const task = make('w1', {
    status: 'running',
    ownerId: 'inst-1',
    dispatch: { owner: 'p', worker: 'coder', engine: 'claude', model: 'm', effort: '', execution: 'real', maxParallel: 1, workspace: '/repo/alpha' },
    run: { id: 'run-1', adapter: 'mock', status: 'running', startedAt: iso(90) },
    events: [{ id: 'e1', at: iso(5), kind: 'log', message: 'progress' }],
  });
  const byId = new Map([[task.id, task]]);
  const named = cardOwner(task, id => byId.get(id));
  assert.equal(named.name, 'MockClaude');
  assert.match(named.title, /09:41/);
  const text = cardFooterText({ owner: named.name, ownerTitle: named.title, verb: '派发', at: iso(90), tail: { label: '最新上报', at: iso(5) } }, NOW);
  assert.match(text, /由 MockClaude 于/);
  assert.doesNotMatch(text, /weaver/);
  assert.match(text, /最新上报/);
});

test('filters narrow by search, workspace and owner, with per-column counts', () => {
  const tasks = [
    make('a', { title: '修登录', dispatch: { owner: 'p1', worker: 'coder', engine: 'claude', model: '', effort: '', execution: 'real', maxParallel: 1, workspace: '/repo/alpha' } }),
    make('b', { title: '修支付', status: 'running', dispatch: { owner: 'p2', worker: 'builder', engine: 'codex', model: '', effort: '', execution: 'real', maxParallel: 1, workspace: '/repo/beta' } }),
  ];
  const narrowed = applyBoardFilters(tasks, { ...defaultWorkbenchBoard(), query: '登录' });
  assert.deepEqual(narrowed.map(task => task.id), ['a']);
  const scoped = applyBoardFilters(tasks, { ...defaultWorkbenchBoard(), workspaces: ['/repo/beta'] });
  assert.deepEqual(scoped.map(task => task.id), ['b']);
  assert.deepEqual(boardColumnCounts(tasks), { queued: 1, running: 1, review: 0, closed: 0 });
});

test('board preferences round-trip with defaults and malformed storage', () => {
  const seed: Record<string, string> = {};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => seed[key] ?? null, setItem: (key: string, value: string) => { seed[key] = value; } },
  });
  try {
    assert.deepEqual(readWorkbenchBoard(), defaultWorkbenchBoard());
    writeWorkbenchBoard({ query: 'alpha', workspaces: ['/repo/alpha'], owners: ['o-1'], collapsed: { 'closed:/x': true } });
    assert.deepEqual(readWorkbenchBoard(), { query: 'alpha', workspaces: ['/repo/alpha'], owners: ['o-1'], collapsed: { 'closed:/x': true } });
    seed[WORKBENCH_BOARD_KEY] = '{"query":42,"collapsed":{"k":"yes"}}';
    assert.deepEqual(readWorkbenchBoard(), defaultWorkbenchBoard());
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

function stubEnv() {
  const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  // No window: virtua takes its server path and mounts ssrCount rows statically.
  // The installed Select reads the portal container through `instanceof HTMLElement` during render.
  if (!previousElement) Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class {} });
  const restoreStorage = stubStorage();
  return () => {
    if (!previousElement) Reflect.deleteProperty(globalThis, 'HTMLElement');
    restoreStorage();
  };
}

function stubStorage(values: Record<string, string> = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  };
}

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'light', children: node }) }));
}

const boardOf = (tasks: Task[], narrow = false, collapsed: Record<string, boolean> = {}) => {
  const restore = stubEnv();
  try {
    return markup(React.createElement(TaskBoardView, {
      tasks, now: NOW, narrow,
      prefs: { ...defaultWorkbenchBoard(), collapsed }, onPrefsChange: () => {},
      pins: {}, onTogglePin: () => {},
      onSelect: () => {},
    }));
  } finally { restore(); }
};

test('the board renders four columns with workspace groups, footers, attention and pins', () => {
  const tasks = [
    make('q1', { title: '实现登录页', workspace: '/repo/alpha' }),
    make('r1', { title: '跑迁移脚本', status: 'running', workspace: '/repo/alpha', run: { id: 'run-1', adapter: 'mock', status: 'running', startedAt: iso(80) }, events: [{ id: 'e1', at: iso(9), kind: 'log', message: 'half' }] }),
    make('f1', { title: '失败的构建', status: 'failed', workspace: '/repo/beta', updatedAt: iso(20) }),
  ];
  const folded = boardOf(tasks);
  for (const label of ['待执行', '执行中', '待验收', '已结束']) assert.match(folded, new RegExp(label));
  assert.match(folded, /alpha/);
  assert.match(folded, /beta/);
  assert.match(folded, /实现登录页/);
  // 已结束默认折叠：组头可见，卡片隐藏。
  assert.doesNotMatch(folded, /失败的构建/);
  const html = boardOf(tasks, false, { 'closed:/repo/beta': false });
  assert.match(html, /失败的构建/);
  assert.match(html, /由 <span[^>]*>MockClaude<\/span> 于/);
  assert.doesNotMatch(html, /MockClaude · alpha · 09:41<\/span>/);
  assert.match(html, /最新上报/);
  assert.match(html, /需关注/);
  assert.match(html, /置顶/);
  assert.match(html, /查看更早的任务/);
  assert.doesNotMatch(html, /更早的任务在全部任务中查看/);
});

test('the card footer keeps each segment on one line with the separator trailing the first', () => {
  const task = make('w1', {
    status: 'running',
    ownerId: 'inst-1',
    dispatch: { owner: 'p', worker: 'coder', engine: 'claude', model: 'm', effort: '', execution: 'real', maxParallel: 1, workspace: '/repo/alpha' },
    run: { id: 'run-1', adapter: 'mock', status: 'running', startedAt: iso(90) },
    events: [{ id: 'e1', at: iso(5), kind: 'log', message: 'progress' }],
  });
  const html = boardOf([task]);
  // 分隔符跟随前一段：换行时第二行以文案开头，不以「·」开头。
  assert.match(html, /派发 ·<\/span>/);
  assert.match(html, /<span[^>]*>最新上报/);
  assert.doesNotMatch(html, /<span[^>]*>· /);
});

test('the board health badge only alerts on abnormal states, never on healthy running', () => {
  assert.equal(isBoardHealthAlert('stalled'), true);
  assert.equal(isBoardHealthAlert('waiting_model'), true);
  for (const state of ['ended', 'starting', 'working', 'running_command', 'owner_starting', 'owner_running'] as const) {
    assert.equal(isBoardHealthAlert(state), false, state);
  }
  // 非执行中卡片不轮询健康：无 health 时徽标无输出。
  const idle = markup(React.createElement(BoardHealthBadge, { taskId: 'w1', active: false }));
  assert.doesNotMatch(idle, /已卡住|等待模型|工作中/);
});

test('pinned cards lead their group and the narrow switch shows per-column counts', () => {
  const tasks = [
    make('q1', { title: '第一项', workspace: '/repo/alpha', updatedAt: iso(50) }),
    make('q2', { title: '第二项', workspace: '/repo/alpha', updatedAt: iso(10) }),
  ];
  const restore = stubEnv();
  try {
    const pinned = markup(React.createElement(TaskBoardView, {
      tasks, now: NOW, narrow: false,
      prefs: defaultWorkbenchBoard(), onPrefsChange: () => {},
      pins: { q2: NOW }, onTogglePin: () => {},
      onSelect: () => {},
    }));
    assert.ok(pinned.indexOf('第二项') < pinned.indexOf('第一项'), 'the pinned card leads its group');
    const narrowHtml = markup(React.createElement(TaskBoardView, {
      tasks, now: NOW, narrow: true,
      prefs: defaultWorkbenchBoard(), onPrefsChange: () => {},
      pins: {}, onTogglePin: () => {},
      onSelect: () => {},
    }));
    assert.match(narrowHtml, /待执行 2/);
    assert.match(narrowHtml, /执行中 0/);
    assert.match(narrowHtml, /待验收 0/);
    assert.match(narrowHtml, /已结束 0/);
  } finally { restore(); }
});
