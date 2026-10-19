import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../src/shared/types';
import { TaskDetail } from '../src/renderer/components/TaskDetail';

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
  assert.match(render({ ...task, status: 'failed', failure: { kind: 'other', message: 'boom' } }), /执行失败/);
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
