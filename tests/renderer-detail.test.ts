import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../src/shared/contracts/tasks';
import { PENDING_TASK_TITLE } from '../src/shared/validation';
import { TaskDetail } from '../src/renderer/features/tasks/TaskDetail';

function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 'unverified', pane: 'unverified' };
const dispatch = { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'sonnet', effort: 'high', execution: 'real' as const, maxParallel: 2, workspace: '/home/mocha/opensource/weaver' };
const task: Task = { id: 't1', title: '收尾任务', instruction: 'do it', owner, status: 'running', progress: 20, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T01:00:00Z', events: [], artifacts: [], dispatch };
const props = { busy: false, onStart: () => {}, onCancel: () => {}, action: async () => true };
const render = (value: Task) => markup(React.createElement(TaskDetail, { task: value, ...props }));
/** The header: everything before the tab group. */
const header = (html: string) => html.slice(0, html.indexOf('aria-label="任务记录"'));

test('the header status tag is solid, colored by status and spins only while running', () => {
  const running = header(render(task));
  assert.match(running, /<span[^>]*background:var\(--ant-color-info\)[^>]*>[\s\S]*?lucide-loader[\s\S]*?执行中<\/span>/);
  const done = header(render({ ...task, status: 'completed', reviewState: 'accepted' }));
  assert.match(done, /background:var\(--ant-color-success\)[^>]*>已通过<\/span>/);
  assert.doesNotMatch(done, /lucide-loader/);
});

test('a finished task shows one status tag, the review outcome folded into it', () => {
  const html = header(render({ ...task, status: 'completed' }));
  assert.match(html, /待验收/);
  assert.equal((html.match(/待验收/g) ?? []).length, 1);
  assert.equal((header(render({ ...task, status: 'failed' })).match(/失败/g) ?? []).length, 1);
});

test('queued tasks and cancelled tasks never spin', () => {
  assert.doesNotMatch(header(render({ ...task, status: 'queued' })), /lucide-loader/);
  assert.doesNotMatch(header(render({ ...task, status: 'cancelled' })), /lucide-loader/);
});

test('overview puts sub agent, model and update time in one three-column row', () => {
  const html = render(task);
  const dts = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map(match => match[1]);
  assert.deepEqual(dts, ['子 Agent', '模型', '更新时间', '父 Agent', '工作目录']);
  assert.match(html, /grid-template-columns:repeat\(3, auto minmax\(0, 1fr\)\)/);
  assert.match(html, /<dt[^>]*>模型<\/dt><dd[^>]*>[\s\S]*?claude \/ sonnet · high/);
  assert.match(html, /aria-label="复制工作目录"/);
});

test('the free-text meta line is gone', () => {
  const html = render(task);
  assert.doesNotMatch(html, /更新于/);
  assert.doesNotMatch(html, /claude \/ sonnet · high · /);
});

test('the notice and the result block stay in the overview', () => {
  const html = render({ ...task, status: 'completed', summary: 'all green' });
  assert.match(html, /执行结果/);
  assert.match(html, /all green/);
  assert.doesNotMatch(render({ ...task, status: 'failed', failure: { kind: 'other', message: 'boom' } }), /boom/);
});

test('queued tasks without a dispatch only show the rows they have', () => {
  const html = render({ ...task, status: 'queued', dispatch: undefined });
  const dts = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map(match => match[1]);
  assert.deepEqual(dts, ['更新时间', '父 Agent']);
});


test('summary renders markdown and running dispatch metadata stays in the facts', () => {
  const html = render({ ...task, status: 'completed', summary: '# 检查结果\n\n**通过**' });
  assert.match(html, /<h1[^>]*>检查结果<\/h1>/);
  assert.match(html, /<strong>通过<\/strong>/);
  const running = render({ ...task, events: [{ id: 'dispatch', kind: 'lifecycle', at: task.updatedAt, message: 'Owner runs claude_worker natively; waiting for its report' }] });
  assert.doesNotMatch(running, /父 Agent 派发给子 Agent/);
});


test('pending root can start before the parent agent names it', () => {
  const html = render({ ...task, title: PENDING_TASK_TITLE, status: 'queued', dispatch: undefined });
  assert.match(html, /开始执行/);
});

test('failed parent launch retries the same root and children never start as roots', () => {
  const root = { ...task, executionRole: 'owner' as const, status: 'failed' as const, dispatch: undefined };
  const renderWithRetry = (value: Task) => markup(React.createElement(TaskDetail, { task: value, ...props, onRetry() {} }));
  assert.match(renderWithRetry(root), /重试启动父 Agent/);
  assert.doesNotMatch(renderWithRetry(root), /新建重试任务/);
  assert.doesNotMatch(renderWithRetry({ ...root, ownerHost: { kind: 'herdr', session: 's', workspaceId: 'w', paneId: 'p', agentName: 'parent', launchedAt: task.createdAt } }), /重试启动父 Agent/);
  assert.doesNotMatch(render({ ...task, parentTaskId: 'root', status: 'queued' }), /开始执行/);
});

test('root overview shows its Herdr host and only its own child agents', () => {
  const root: Task = { ...task, executionRole: 'owner', dispatch: undefined, ownerHost: { kind: 'herdr', session: 'session-p3', workspaceId: 'workspace-p3', paneId: 'pane-p3', agentName: 'parent-p3', launchedAt: task.createdAt } };
  const children: Task[] = [{ ...task, id: 'child', title: '实现子任务', parentTaskId: root.id }, { ...task, id: 'other', title: '不相关任务', parentTaskId: 'other-root' }];
  const html = markup(React.createElement(TaskDetail, { ...props, task: root, tasks: children, onSelect() {} }));
  for (const text of ['在 Herdr 中运行', 'session-p3', 'workspace-p3', 'pane-p3', 'parent-p3', '子任务 · 1', '实现子任务', 'claude_worker']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /不相关任务/);
  assert.match(render({ ...root, ownerHost: undefined }), /正在 Herdr 中启动/);
  assert.match(render({ ...root, status: 'completed' }), /Herdr 启动记录/);
});


test('only completed pending tasks offer the direct manual review action in the header', () => {
  for (const reviewState of [undefined, 'pending'] as const) {
    assert.match(header(render({ ...task, status: 'completed', reviewState })), /<button[^>]*>[\s\S]*?手动验收<\/button>/);
  }
  for (const status of ['queued', 'running', 'cancelling', 'failed', 'cancelled'] as const) {
    assert.doesNotMatch(header(render({ ...task, status, reviewState: 'pending' })), /手动验收/);
  }
  for (const reviewState of ['accepted', 'rejected'] as const) {
    assert.doesNotMatch(header(render({ ...task, status: 'completed', reviewState })), /手动验收/);
  }
  const html = markup(React.createElement(TaskDetail, { ...props, busy: true, task: { ...task, status: 'completed' } }));
  assert.match(header(html), /<button[^>]*disabled=""[^>]*>[\s\S]*?手动验收<\/button>/);
});
