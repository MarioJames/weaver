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
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { styles as detailStyles } from '../../src/renderer/features/tasks/task-detail-style';
import { styleCss } from './style-helpers';
const app = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8');
const routeSource = app.slice(app.indexOf('function pageFromHash'), app.indexOf('/** The hash'));
const pagesSource = app.slice(app.indexOf('const PAGES ='), app.indexOf('type Page ='));
const pageFromHash = new Function(transformSync(pagesSource + routeSource.replace('export ', ''), { loader: 'ts' }).code + '; return pageFromHash;')() as () => string;
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
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    for (const [pathname, hash, expected] of [['/owners', '', 'owners'], ['/owners', '#/workers', 'workers'], ['/', '#/settings', 'settings'], ['/', '#/bots', 'bots'], ['/bots', '', 'bots'], ['/', '#/schedules', 'schedules'], ['/unknown', '', 'tasks']]) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { pathname, hash } } });
      assert.equal(pageFromHash(), expected);
    }
  } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); }
});

test('the detail header stacks the action row below the title when narrow, wide layout unchanged', () => {
  const url = new URL('../../src/renderer/features/tasks/task-detail-style.ts', import.meta.url);
  const header = styleCss(url, detailStyles.header);
  // The header is its own inline-size container; wide keeps the actions beside the heading (wrap only as a fallback).
  assert.match(header, /container-type:inline-size/);
  assert.match(header, /flex-wrap:wrap/);
  assert.doesNotMatch(header, /@container/);
  assert.match(styleCss(url, detailStyles.heading), /@container \(max-width: 480px\)\{[^}]*flex-basis:100%/);
  const actions = styleCss(url, detailStyles.actions);
  assert.match(actions, /@container \(max-width: 480px\)\{[^}]*flex-direction:row/);
  assert.match(actions, /flex-wrap:wrap/);
});

test('accepted detail omits retry and counts constraints with acceptance criteria', async () => {
  const { TaskDetail } = await import('../../src/renderer/features/tasks/TaskDetail');
  const task = { id: 'accepted', title: '已验收任务', instruction: '检查', owner: { name: 'parent', transport: 'herdr-visible', session: 's', pane: 'p' }, status: 'completed', reviewState: 'accepted', constraints: ['约束一', '约束二'], acceptanceCriteria: ['标准'], events: [], artifacts: [], progress: 100, createdAt: '2026-10-19T12:00:00Z', updatedAt: '2026-10-19T12:00:00Z' } as const;
  const html = markup(React.createElement(TaskDetail, { task: { ...task, constraints: [...task.constraints], acceptanceCriteria: [...task.acceptanceCriteria], events: [], artifacts: [] }, busy: false, action: async () => true, onStart() {}, onCancel() {}, onRetry() {} }));
  assert.doesNotMatch(html, /新建重试任务/);
  assert.match(html, /要求 3/);
});
