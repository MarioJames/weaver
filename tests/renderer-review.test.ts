import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../src/shared/types';
import { ReviewPanel, ReviewView, decisionEvent } from '../src/renderer/components/ReviewPanel';

function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 'unverified', pane: 'unverified' };
const task: Task = {
  id: 't1', title: 'x', instruction: 'x', owner, status: 'completed', progress: 100, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T02:00:00Z', artifacts: [],
  events: [{ id: 'e1', at: '2026-10-18T01:30:00Z', kind: 'lifecycle', message: 'Owner review: accepted' }],
  dispatch: { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'sonnet', effort: 'high', execution: 'real', maxParallel: 1 },
  reviewState: 'accepted', reviewComment: '看起来没问题',
};
const noop = () => {};
const base = { task, busy: false, open: false, comment: '', onOpen: noop, onClose: noop, onComment: noop, onSubmit: noop };
const pending = { taskId: 't1', execution: 'completed', manifestDigest: 'sha256:abcdef', delivery: 'pending' as const, acceptance: 'pending' as const };
const accepted = { ...pending, delivery: 'acknowledged' as const, acceptance: 'accepted' as const };

test('review is read-only by default: delivery, decision, who decided, when and the comment', () => {
  const html = markup(React.createElement(ReviewView, { ...base, manifest: accepted }));
  assert.match(html, /<dt[^>]*>交付<\/dt><dd[^>]*>[\s\S]*?已确认收到/);
  assert.match(html, /<dt[^>]*>验收结论<\/dt><dd[^>]*>[\s\S]*?已通过/);
  assert.match(html, /<dt[^>]*>决定者<\/dt><dd[^>]*>[\s\S]*?claude_owner/);
  assert.match(html, /<dt[^>]*>决定时间<\/dt><dd[^>]*><time[^>]*dateTime="2026-10-18T01:30:00Z"/);
  assert.match(html, /<dt[^>]*>验收说明<\/dt><dd[^>]*>[\s\S]*?看起来没问题/);
  assert.match(html, />手动验收</);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /结果清单指纹|sha256:abcdef|分别记录/);
});

test('the decision tag follows the shared status scheme', () => {
  assert.match(markup(React.createElement(ReviewView, { ...base, task: { ...task, reviewState: 'pending', reviewComment: undefined }, manifest: pending })), />待验收</);
  assert.match(markup(React.createElement(ReviewView, { ...base, manifest: { ...accepted, acceptance: 'rejected' } })), />需修改</);
});

test('an undecided result shows no decider', () => {
  const html = markup(React.createElement(ReviewView, { ...base, task: { ...task, reviewState: 'pending', reviewComment: undefined, events: [] }, manifest: pending }));
  assert.doesNotMatch(html, /决定者|决定时间/);
});

test('the decision time comes from the last owner review event', () => {
  const events = [...task.events, { id: 'e2', at: '2026-10-18T01:45:00Z', kind: 'lifecycle' as const, message: 'Owner review: rejected' }];
  assert.equal(decisionEvent({ ...task, events })?.id, 'e2');
  assert.equal(decisionEvent({ ...task, events: [] }), undefined);
});

/** The modal portals out of server rendering, so read its props off the element tree. */
function findModal(node: React.ReactNode): React.ReactElement<{ open: boolean; title: string; footer: React.ReactNode; children: React.ReactNode }> | undefined {
  if (!React.isValidElement(node)) return undefined;
  const props = node.props as { open?: boolean; footer?: unknown; children?: React.ReactNode };
  if ('footer' in props && 'open' in props) return node as React.ReactElement<{ open: boolean; title: string; footer: React.ReactNode; children: React.ReactNode }>;
  for (const child of React.Children.toArray(props.children)) { const found = findModal(child); if (found) return found; }
  return undefined;
}

test('manual review opens a modal with an optional comment and the decisions', () => {
  const closed = findModal(ReviewView({ ...base, manifest: pending }));
  assert.equal(closed?.props.open, false);
  const modal = findModal(ReviewView({ ...base, open: true, manifest: pending }));
  assert.equal(modal?.props.open, true);
  assert.equal(modal?.props.title, '手动验收');
  const footer = markup(modal?.props.footer);
  assert.match(footer, />确认收到</);
  assert.match(footer, />验收通过</);
  assert.match(footer, />要求修改</);
  assert.match(markup(modal?.props.children), /<textarea[^>]*aria-label="验收说明（可选）"/);
});

test('acknowledged results do not offer 确认收到 again', () => {
  const modal = findModal(ReviewView({ ...base, open: true, manifest: { ...pending, delivery: 'acknowledged' } }));
  assert.doesNotMatch(markup(modal?.props.footer), />确认收到</);
});

test('the panel itself reads the manifest after mount and shows a status line first', () => {
  const html = markup(React.createElement(ReviewPanel, { task, busy: false, action: async () => true }));
  assert.match(html, /正在读取结果清单/);
});
