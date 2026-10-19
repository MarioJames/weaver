import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../src/main/policy/routing';
import { OwnerScheduleFields } from '../src/renderer/components/OwnerSchedule';
import { withWorkerWeight, workerWeight } from '../src/renderer/policy-edit';

function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

test('weight 5 is the omitted default and 0/10 are stored', () => {
  const owner = defaultConfig().owners.claude_owner;
  assert.equal(workerWeight(owner, 'x_worker'), 5);
  assert.equal(withWorkerWeight(owner, 'claude_worker', 5).worker_weights, undefined);
  assert.equal(withWorkerWeight(owner, 'claude_worker', 0).worker_weights?.claude_worker, 0);
  assert.equal(withWorkerWeight(owner, 'claude_worker', 10).worker_weights?.claude_worker, 10);
});

test('each worker row offers the three weight presets and caps the input at 10', () => {
  const config = defaultConfig();
  const record = withWorkerWeight(config.owners.claude_owner, 'claude_worker', 10);
  const html = markup(React.createElement(OwnerScheduleFields, { config, blocks: [], record, update: () => {} }));
  for (const label of ['不派发', '默认', '最高']) assert.match(html, new RegExp(label));
  const body = html.replace(/<style[\s\S]*?<\/style>/g, '');
  assert.match(body, /min="0" max="10" step="1"/);
  assert.doesNotMatch(body, /max="1000"/);
  // Only the preset equal to the current value (10) is highlighted.
  assert.match(body, /aria-pressed="true"[^>]*aria-label="claude_worker 最高"|aria-label="claude_worker 最高"[^>]*aria-pressed="true"/);
  assert.match(body, /aria-pressed="false"[^>]*aria-label="claude_worker 默认"|aria-label="claude_worker 默认"[^>]*aria-pressed="false"/);
});

test('the content area keeps a stable scrollbar gutter', () => {
  const css = readFileSync(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  assert.match(css, /overflow-y:\s*scroll/);
  assert.match(css, /scrollbar-gutter:\s*stable/);
});
