import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import type { Route } from '../../src/renderer/app/router';
import { PENDING_TASK_TITLE } from '../../src/shared/validation';
import { TaskInspectorView, type TaskInspectorViewProps } from '../../src/renderer/features/tasks/TaskInspector';

function markup(node: React.ReactNode) {
  const props = { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'dark', children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 'unverified', pane: 'unverified' };
const dispatch = { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'sonnet', effort: 'high', execution: 'real' as const, maxParallel: 2, workspace: '/home/mocha/opensource/weaver' };
const task: Task = { id: 't1', title: '收尾任务', instruction: 'do it', owner, status: 'running', progress: 20, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T01:00:00Z', events: [], artifacts: [], dispatch };
const taskRoute = (taskId: string): Route => ({ page: 'tasks', view: 'all', taskId });
const view = (value: Task, extra: Partial<TaskInspectorViewProps> = {}) =>
  markup(React.createElement(TaskInspectorView, { task: value, tasks: [value], busy: false, action: async () => true, taskRoute, onClose: () => {}, onEdit: () => {}, ...extra }));
/** The header: title, badges and actions, before banners and the tab group. */
const header = (html: string) => {
  const marks = ['role="alert"', 'aria-label="任务详情页"'].map(mark => html.indexOf(mark)).filter(index => index > 0);
  return html.slice(0, Math.min(...marks));
};

test('the header status tag is solid, colored by status and spins only while running', () => {
  const running = header(view(task));
  assert.match(running, /<span[^>]*background:var\(--lobe-color-info\)[^>]*>[\s\S]*?lucide-loader[\s\S]*?执行中<\/span>/);
  const done = header(view({ ...task, status: 'completed', reviewState: 'accepted' }));
  assert.match(done, /background:var\(--lobe-color-success\)[^>]*>已通过<\/span>/);
  assert.doesNotMatch(done, /lucide-loader/);
});

test('a finished task shows one status tag, the review outcome folded into it', () => {
  const html = header(view({ ...task, status: 'completed' }));
  assert.match(html, /待验收/);
  assert.equal((html.match(/待验收/g) ?? []).length, 1);
  assert.equal((header(view({ ...task, status: 'failed' })).match(/失败/g) ?? []).length, 1);
});

test('queued tasks and cancelled tasks never spin', () => {
  assert.doesNotMatch(header(view({ ...task, status: 'queued' })), /lucide-loader/);
  assert.doesNotMatch(header(view({ ...task, status: 'cancelled' })), /lucide-loader/);
});

test('overview puts sub agent, model, session, directory and both clocks in one fact block', () => {
  const html = view(task);
  const dts = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map(match => match[1]);
  assert.deepEqual(dts, ['子 Agent', '模型', '会话', '工作目录', '派发时间', '最近更新']);
  assert.match(html, /grid-template-columns:repeat\(2, auto minmax\(0, 1fr\)\)/);
  assert.match(html, /<dt[^>]*>模型<\/dt><dd[^>]*>[\s\S]*?claude \/ sonnet · high/);
  assert.match(html, /aria-label="复制工作目录"/);
});

test('the free-text meta line is gone', () => {
  const html = view(task);
  assert.doesNotMatch(html, /更新于/);
  assert.doesNotMatch(html, /claude \/ sonnet · high · /);
});

test('the activity line and the result block stay in the overview', () => {
  const html = view({ ...task, status: 'completed', summary: 'all green' }, { initialTab: 'overview' });
  assert.match(html, /执行结果/);
  assert.match(html, /all green/);
  const failed = view({ ...task, status: 'failed', failure: { kind: 'other', message: 'boom' } });
  assert.match(failed, /boom/);
  assert.equal((failed.match(/boom/g) ?? []).length, 1);
  assert.doesNotMatch(header(failed), /boom/);
});

test('queued tasks without a dispatch only show the rows they have', () => {
  const html = view({ ...task, status: 'queued', dispatch: undefined });
  const dts = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map(match => match[1]);
  assert.deepEqual(dts, ['子 Agent', '模型', '会话', '工作目录', '派发时间', '最近更新']);
  assert.match(html, /未派发给子 Agent/);
  assert.match(html, /未记录/);
});


test('summary renders markdown and running dispatch metadata stays in the facts', () => {
  const html = view({ ...task, status: 'completed', summary: '# 检查结果\n\n**通过**' }, { initialTab: 'overview' });
  assert.match(html, /<h1[^>]*>检查结果<\/h1>/);
  assert.match(html, /<strong>通过<\/strong>/);
  const running = view({ ...task, events: [{ id: 'dispatch', kind: 'lifecycle', at: task.updatedAt, message: 'Owner runs claude_worker natively; waiting for its report' }] });
  assert.doesNotMatch(running, /父 Agent 派发给子 Agent/);
});


test('pending root can start before the parent agent names it', () => {
  const html = view({ ...task, title: PENDING_TASK_TITLE, status: 'queued', dispatch: undefined, workspace: '/tmp/proj' });
  assert.match(html, /开始执行/);
});

test('failed parent launch retries the same root and children never start as roots', () => {
  const root = { ...task, executionRole: 'owner' as const, status: 'failed' as const, dispatch: undefined };
  assert.match(view(root), /重试启动父 Agent/);
  assert.doesNotMatch(view(root), /新建重试任务/);
  assert.doesNotMatch(view({ ...root, ownerHost: { kind: 'herdr', session: 's', workspaceId: 'w', paneId: 'p', agentName: 'parent', launchedAt: task.createdAt } }), /重试启动父 Agent/);
  assert.doesNotMatch(view({ ...task, parentTaskId: 'root', status: 'queued' }), /开始执行/);
});

test('root overview shows its Herdr host and links only its own child agents', () => {
  const root: Task = { ...task, executionRole: 'owner', dispatch: undefined, ownerHost: { kind: 'herdr', session: 'session-p3', workspaceId: 'workspace-p3', paneId: 'pane-p3', agentName: 'parent-p3', launchedAt: task.createdAt } };
  const children: Task[] = [{ ...task, id: 'child', title: '实现子任务', parentTaskId: root.id }, { ...task, id: 'other', title: '不相关任务', parentTaskId: 'other-root' }];
  const html = markup(React.createElement(TaskInspectorView, { task: root, tasks: [root, ...children], busy: false, action: async () => true, taskRoute, onClose: () => {}, onEdit: () => {} }));
  for (const text of ['在 Herdr 中运行', 'session-p3', 'workspace-p3', 'pane-p3', 'parent-p3', '子任务 · 1', '实现子任务', 'claude_worker']) assert.ok(html.includes(text), text);
  assert.match(html, /href="#\/tasks\/all\/t\/child"/);
  assert.doesNotMatch(html, /不相关任务/);
  assert.match(view({ ...root, ownerHost: undefined }), /正在 Herdr 中启动/);
  assert.match(view({ ...root, status: 'completed' }), /Herdr 启动记录/);
});


test('only completed pending tasks offer the review action in the header', () => {
  for (const reviewState of [undefined, 'pending'] as const) {
    assert.match(header(view({ ...task, status: 'completed', reviewState })), /<button[^>]*>[\s\S]*?验收<\/button>/);
  }
  for (const status of ['queued', 'running', 'cancelling', 'failed', 'cancelled'] as const) {
    assert.doesNotMatch(header(view({ ...task, status, reviewState: 'pending' })), /验收/);
  }
  for (const reviewState of ['accepted', 'rejected'] as const) {
    assert.doesNotMatch(header(view({ ...task, status: 'completed', reviewState })), /验收/);
  }
  const html = markup(React.createElement(TaskInspectorView, { task: { ...task, status: 'completed' }, tasks: [task], busy: true, action: async () => true, taskRoute, onClose: () => {}, onEdit: () => {} }));
  assert.match(header(html), /<button[^>]*disabled=""[^>]*>[\s\S]*?验收<\/button>/);
});
