import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { toast, type ToastOptions } from '@lobehub/ui/base-ui';
import { ArtifactsPanel } from '../src/renderer/components/ArtifactsPanel';
import { displayLog, formatDate } from '../src/renderer/log-view';
import { notifyError } from '../src/renderer/notify';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
const routeSource = app.slice(app.indexOf('function pageFromHash'), app.indexOf('/** The hash'));
const pageFromHash = new Function('PAGES', transformSync(routeSource.replace('export ', ''), { loader: 'ts' }).code + '; return pageFromHash;' )(['tasks', 'engines', 'owners', 'workers', 'settings']) as () => string;
const markup = (node: React.ReactNode) => renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { enableCustomFonts: false, children: node }) }));
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
test('dates use one Chinese absolute format independent of machine locale', () => {
  assert.match(formatDate('2026-10-19T12:05:00Z'), /^2026-10-19 \d{2}:05$/);
  assert.equal(formatDate('invalid'), '时间未知');
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
    for (const [pathname, hash, expected] of [['/owners', '', 'owners'], ['/owners', '#/workers', 'workers'], ['/', '#/settings', 'settings'], ['/unknown', '', 'tasks']]) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { pathname, hash } } });
      assert.equal(pageFromHash(), expected);
    }
  } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); }
});

test('accepted detail omits retry and counts constraints with acceptance criteria', async () => {
  const { TaskDetail } = await import('../src/renderer/components/TaskDetail');
  const task = { id: 'accepted', title: '已验收任务', instruction: '检查', owner: { name: 'parent', transport: 'herdr-visible', session: 's', pane: 'p' }, status: 'completed', reviewState: 'accepted', constraints: ['约束一', '约束二'], acceptanceCriteria: ['标准'], events: [], artifacts: [], progress: 100, createdAt: '2026-10-19T12:00:00Z', updatedAt: '2026-10-19T12:00:00Z' } as const;
  const html = markup(React.createElement(TaskDetail, { task: { ...task, constraints: [...task.constraints], acceptanceCriteria: [...task.acceptanceCriteria], events: [], artifacts: [] }, busy: false, action: async () => true, onStart() {}, onCancel() {}, onRetry() {} }));
  assert.doesNotMatch(html, /新建重试任务/);
  assert.match(html, /要求 3/);
});
