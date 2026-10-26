import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import { toast, type ToastOptions } from '@lobehub/ui';
import { ArtifactsPanel } from '../../src/renderer/features/tasks/ArtifactsPanel';
import { displayLog } from '../../src/renderer/features/tasks/log-view';
import { compactTime, fullTime } from '../../src/renderer/format/timezone';
import { notifyError } from '../../src/renderer/api/notify';
import { inspectorStyles } from '../../src/renderer/features/tasks/inspector-style';
import { styleCss } from './style-helpers';
import { parseRoute, type Route } from '../../src/renderer/app/router';
const markup = (node: React.ReactNode) => renderToStaticMarkup(React.createElement(ConfigProvider, { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { children: node }) }));
test('completed and interrupted artifact empty states explain the actual status', () => {
  const completed = markup(React.createElement(ArtifactsPanel, { artifacts: [], status: 'completed' }));
  assert.match(completed, /没有产物/);
  assert.doesNotMatch(completed, /失败或取消/);
  assert.match(markup(React.createElement(ArtifactsPanel, { artifacts: [], status: 'failed' })), /部分输出/);
});
test('markdown artifacts render headings and emphasis for both MIME and filename detection', () => {
  for (const [name, mediaType] of [['result.txt', 'text/markdown'], ['result.md', 'text/plain']] as const) {
    const html = markup(React.createElement(ArtifactsPanel, { artifacts: [{ id: 'a', name, mediaType, content: '# 报告\n\n**通过**', createdAt: '' }], status: 'completed' }));
    assert.match(html, /<h1[^>]*>报告<\/h1>/);
    assert.match(html, /<strong>通过<\/strong>/);
  }
});
test('known lifecycle labels translate without modifying unknown content or exposing secrets', () => {
  assert.equal(displayLog('Owner review: accepted'), '父 Agent 验收：已通过');
  assert.equal(displayLog('Task queued. Owner reference is metadata only'), '任务待执行。父 Agent 引用仅用于记录');
  assert.match(displayLog('Owner runs claude_worker natively; waiting for its report'), /父 Agent.*子 Agent.*claude_worker/);
  assert.equal(displayLog('custom message'), 'custom message');
  assert.equal(displayLog('token=abcdef'), 'token=[REDACTED]');
});
test('times use one compact format independent of machine locale', () => {
  const now = Date.parse('2026-10-19T14:00:00Z');
  assert.equal(compactTime('2026-10-19T12:05:00Z', now, 'UTC'), '12:05');
  assert.equal(compactTime('2026-10-18T12:05:00Z', now, 'UTC'), '10-18 12:05');
  assert.equal(compactTime('invalid', now, 'UTC'), '时间未知');
  assert.equal(fullTime('invalid', 'UTC'), '时间未知');
});
test('not found error displays one Chinese message without raw duplicated codes', t => {
  const calls: ToastOptions[] = [];
  t.mock.method(toast, 'error', (options: ToastOptions) => { calls.push(options); return { id: 'polish', update() {}, close() {} }; });
  notifyError(Object.assign(new Error('NOT_FOUND: Task not found'), { code: 'NOT_FOUND' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].description, '任务不存在');
});
test('direct and copied legacy URLs resolve to the same page', () => {
  for (const [pathname, hash, expected] of [['/owners', '', 'owners'], ['/owners', '#/workers', 'workers'], ['/', '#/settings', 'settings'], ['/', '#/bots', 'bots'], ['/bots', '', 'bots'], ['/', '#/schedules', 'schedules'], ['/unknown', '', 'tasks']]) {
    assert.equal(parseRoute(hash, pathname).page, expected);
  }
});

test('the inspector header stacks the action row below the title when narrow, wide layout unchanged', () => {
  const url = new URL('../../src/renderer/features/tasks/inspector-style.ts', import.meta.url);
  const header = styleCss(url, inspectorStyles.header);
  // The header is its own inline-size container; wide keeps the actions beside the heading (wrap only as a fallback).
  assert.match(header, /container-type:inline-size/);
  assert.match(header, /flex-wrap:wrap/);
  assert.doesNotMatch(header, /@container/);
  assert.match(styleCss(url, inspectorStyles.heading), /@container \(max-width: 480px\)\{[^}]*flex-basis:100%/);
  assert.match(styleCss(url, inspectorStyles.actions), /justify-content:flex-end/);
  assert.match(styleCss(url, inspectorStyles.tabList), /overflow-x:auto/);
  assert.match(styleCss(url, inspectorStyles.tabList), /flex-wrap:nowrap/);
  assert.doesNotMatch(styleCss(url, inspectorStyles.tabList), /mask-image|linear-gradient/);
});

test('accepted inspector omits retry and folds the prompt into the plain 要求 tab', async () => {
  const { TaskInspectorView } = await import('../../src/renderer/features/tasks/TaskInspector');
  const task = { id: 'accepted', title: '已验收任务', instruction: '检查', owner: { name: 'parent', transport: 'herdr-visible', session: 's', pane: 'p' }, status: 'completed', reviewState: 'accepted', constraints: ['约束一', '约束二'], acceptanceCriteria: ['标准'], events: [], artifacts: [], progress: 100, createdAt: '2026-10-19T12:00:00Z', updatedAt: '2026-10-19T12:00:00Z' } as const;
  const render = (tab?: 'requirements') => markup(React.createElement(TaskInspectorView, { task: { ...task, constraints: [...task.constraints], acceptanceCriteria: [...task.acceptanceCriteria], events: [], artifacts: [] }, tasks: [], busy: false, action: async () => true, taskRoute: (taskId: string): Route => ({ page: 'tasks', view: 'all' as const, taskId }), ...(tab ? { initialTab: tab } : {}), onClose() {}, onEdit() {} }));
  assert.doesNotMatch(render(), /新建重试任务/);
  const labels = [...render().matchAll(/role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));
  assert.deepEqual(labels, ['概况', '时间线0', '结果与验收', '要求']);
  const requirements = render('requirements');
  assert.match(requirements, /约束一/);
  assert.match(requirements, /复制Prompt/);
});
