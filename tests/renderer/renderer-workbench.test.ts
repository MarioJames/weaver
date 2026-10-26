import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { TasksPage } from '../../src/renderer/features/tasks/TasksPage';
import {
  WORKBENCH_ENDED_KEY, defaultWorkbenchSessions, readWorkbenchEnded, readWorkbenchSessions,
  writeWorkbenchEnded, writeWorkbenchSessions,
} from '../../src/renderer/features/tasks/task-persistence';

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const owner = { name: 'parent', transport: 'herdr-visible' as const, session: 's', pane: 'p' };

const make = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `任务 ${id}`, instruction: 'goal', owner, status: 'queued', progress: 0,
  createdAt: iso(120), updatedAt: iso(60), events: [], artifacts: [], ...extra,
});

const workOf = (tasks: Task[]) => ({
  tasks, caps: { worker: 'w', owner: 'o', maxParallel: 1, storePath: '/tmp' },
  error: '', loading: false, busy: false,
  refresh: async () => {}, action: async (fn: () => Promise<unknown>) => { await fn(); return true; },
  dismissError: () => {},
});

function stubWindow(hash: string) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { hash, pathname: '/', search: '' },
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      addEventListener: () => {}, removeEventListener: () => {},
    },
  });
  // The installed Select reads the portal container through `instanceof HTMLElement` during render.
  if (!previousElement) Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class {} });
  return () => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (!previousElement) Reflect.deleteProperty(globalThis, 'HTMLElement');
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

const page = (tasks: Task[], hash = '#/tasks') => {
  const restoreWindow = stubWindow(hash);
  const restoreStorage = stubStorage();
  try {
    return markup(React.createElement(TasksPage, { work: workOf(tasks) }));
  } finally { restoreStorage(); restoreWindow(); }
};

test('the workbench header offers 新建任务 and the 会话/全部任务 switch, with no board or archive', () => {
  const html = page([]);
  assert.match(html, /工作台/);
  assert.match(html, /新建任务/);
  assert.match(html, /会话/);
  assert.match(html, /全部任务/);
  assert.match(html, /还没有任务/);
  assert.doesNotMatch(html, /任务看板/);
  assert.doesNotMatch(html, /归档/);
  assert.doesNotMatch(html, /任务筛选/);
});

test('sessions group by workspace with headings, counts and attention flags', () => {
  const root = make('root', { executionRole: 'owner', title: '网页目标', status: 'running', workspace: '/repo/alpha' });
  const running = make('c1', { parentTaskId: 'root', status: 'running', title: '执行子任务', workspace: '/repo/alpha' });
  const failed = make('c2', { parentTaskId: 'root', status: 'failed', title: '失败子任务', workspace: '/repo/alpha' });
  const html = page([root, running, failed]);
  assert.match(html, /网页目标/);
  assert.match(html, /alpha/);
  assert.match(html, /1 执行中/);
  assert.match(html, /需关注 1 个任务/);
  assert.match(html, /#\/tasks\/s\/r-root"/);
});

test('an unknown session explains itself with a way back', () => {
  const html = page([make('a')], '#/tasks/s/r-missing');
  assert.match(html, /未找到/);
  assert.match(html, /返回列表/);
});

test('the all-tasks view lists the table filters and rows, with a clear action when empty', () => {
  const html = page([make('a', { status: 'running', dispatch: { owner: 'p', worker: 'w1', engine: 'claude', model: '', effort: '', execution: 'real', maxParallel: 1, workspace: '/repo/alpha' } })], '#/tasks/all');
  assert.match(html, /全部任务/);
  assert.match(html, /子 Agent/);
  assert.match(html, /工作目录/);
  assert.match(html, /结束或最近上报/);
});

test('the all-tasks empty state offers 清除筛选 after narrowing', () => {
  const html = page([], '#/tasks/all');
  assert.match(html, /没有匹配的任务/);
});

test('a retry chain stays together in the attention group instead of orphaned', () => {
  const original = make('original', { ownerId: 'inst-1', title: '原始尝试', status: 'failed', createdAt: iso(90), updatedAt: iso(50) });
  const retry = make('retry', { ownerId: 'inst-1', title: '重试尝试', status: 'failed', retryOf: 'original', createdAt: iso(40), updatedAt: iso(10) });
  const html = page([original, retry], '#/tasks/s/o-inst-1');
  assert.match(html, /需关注/);
  const group = html.slice(html.indexOf('aria-label="需关注任务"'), html.indexOf('aria-label="已结束任务"') >= 0 ? html.indexOf('aria-label="已结束任务"') : undefined);
  assert.ok(group.indexOf('原始尝试') >= 0, 'the original attempt is shown in the chain');
  assert.ok(group.indexOf('原始尝试') < group.indexOf('重试尝试'), 'the retry follows its original');
  assert.match(group, /第 2 次尝试/);
});

test('a web root session shows its type, parent Agent, report, goal and header actions', () => {
  const root = make('root', {
    executionRole: 'owner', title: '交付工作台', status: 'failed', ownerId: 'inst-1',
    ownerReport: { summary: '等待人工确认', percent: 60, phase: '验收', blockers: ['缺少截图'], nextSteps: ['补图'], reportedAt: iso(20) },
    instruction: '把工作台重做完', acceptanceCriteria: ['能开机'], createdAt: iso(180), updatedAt: iso(5),
  });
  const child = make('child', { parentTaskId: 'root', title: '实现列表', status: 'running', updatedAt: iso(30) });
  const html = page([root, child], '#/tasks/s/r-root');
  assert.match(html, /网页发起/);
  assert.match(html, /父 Agent/);
  assert.match(html, /进度汇报/);
  assert.match(html, /等待人工确认/);
  assert.match(html, /缺少截图/);
  assert.match(html, /已过期/);
  assert.match(html, /会话目标/);
  assert.match(html, /重试启动父 Agent/);
  assert.match(html, /接续/);
  assert.match(html, /href="#\/tasks\/s\/r-root\/t\/child"/);
});

test('session preferences round-trip with new keys and defaults', () => {
  const seed: Record<string, string> = {};
  const restore = stubStorage(seed);
  try {
    assert.deepEqual(readWorkbenchSessions(), defaultWorkbenchSessions());
    assert.equal(readWorkbenchEnded(), false);
    writeWorkbenchSessions({ query: 'alpha', time: '7d', scope: 'attention' });
    assert.deepEqual(readWorkbenchSessions(), { query: 'alpha', time: '7d', scope: 'attention' });
    writeWorkbenchSessions({ query: 'x', time: 'bogus' as never, scope: 'nope' as never });
    assert.deepEqual(readWorkbenchSessions(), { query: 'x', time: '24h', scope: 'active' });
    writeWorkbenchEnded(true);
    assert.equal(readWorkbenchEnded(), true);
    assert.equal(seed[WORKBENCH_ENDED_KEY], 'true');
  } finally { restore(); }
});
