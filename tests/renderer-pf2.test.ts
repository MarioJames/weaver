import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { EventsPanel } from '../src/renderer/components/EventsPanel';

const markup = (node: React.ReactNode) => renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { enableCustomFonts: false, children: node }) }));

test('a result node puts its time in the labeled card and renders report markdown', () => {
  const html = markup(React.createElement(EventsPanel, { taskId: 'fixture', events: [{ id: 'result', kind: 'result', at: '2026-10-19T12:00:00Z', message: '# 验证报告\n\n**通过**' }] }));
  const node = html.slice(html.indexOf('<ol'));
  assert.match(node, /执行完成<\/div><time[^>]*dateTime="2026-10-19T12:00:00Z"/);
  assert.match(node, /<h1[^>]*>验证报告<\/h1>/);
  assert.match(node, /<strong>通过<\/strong>/);
  assert.match(node, /aria-label="复制执行结果"/);
  assert.equal((node.match(/<li[ >]/g) ?? []).length, 1);
});
