import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../../src/main/policy/routing';
import type { PolicyDraft } from '../../src/renderer/policy/usePolicyDraft';
import { ChannelsPage } from '../../src/renderer/features/channels/ChannelsPage';
import { channelStyles } from '../../src/renderer/features/channels/channels-style';
import { styleCss } from './style-helpers';

const config = defaultConfig();
const policy = {
  snapshot: { revision: 1, config, blocks: [], activeBlocks: [], owners: {}, workers: {}, execution: 'disabled' },
  config,
  loading: false,
  busy: false,
  load: async () => true,
  rebase: () => {},
} as unknown as PolicyDraft;

const markup = (node: React.ReactNode) => renderToStaticMarkup(React.createElement(ConfigProvider, {
  motion, enableCustomFonts: false,
  children: React.createElement(ThemeScope, { appearance: 'light', children: node }),
}));

test('the channels page is a master-detail with metrics, filters, grouped rows and four detail sections', () => {
  const html = markup(React.createElement(ChannelsPage, { policy }));
  for (const text of ['账号与渠道', '账号与渠道指标', '额度可用', '全部引擎', '官方订阅', 'API', '登录官方账号', '删除', '凭据', '额度', '配置', '关系']) {
    assert.match(html, new RegExp(text), text);
  }
  assert.match(html, /aria-label="账号与渠道列表"/);
  assert.match(html, /aria-label="账号或渠道详情"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /aria-label="账号与渠道"/);
  assert.match(html, /claude_owner/);
  assert.match(html, /href="#\/owners\/claude_owner"/);
  assert.match(html, /claude_worker/);
  assert.match(html, /href="#\/workers\/claude_worker"/);
  assert.doesNotMatch(html, /未保存的修改/);
  assert.doesNotMatch(html, /暂存并关闭|继续未保存的账号/);
});

test('the page keeps route selection, draft guards, toast receipts and immediate toggles in one place', () => {
  const page = readFileSync(new URL('../../src/renderer/features/channels/ChannelsPage.tsx', import.meta.url), 'utf8');
  for (const marker of ['MasterDetail', 'SelectableList', 'GroupHeading', 'useDraftGuard', 'useRoute', 'navigate(', 'channelMetrics', 'SaveBar', 'EntityLink', 'toast.success', 'toast.warning']) {
    assert.match(page, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), marker);
  }
  assert.doesNotMatch(page, /暂存并关闭|继续未保存的账号|重新读取/);
  assert.doesNotMatch(page, /<Alert/);
  assert.match(page, /window\.weaver\.getImSettings\(\)/);
});

test('the channels page fills the viewport without a scrolling page, shadows or horizontal overflow', () => {
  const url = new URL('../../src/renderer/features/channels/channels-style.ts', import.meta.url);
  const page = styleCss(url, channelStyles.page);
  const master = styleCss(url, channelStyles.master);
  const metrics = styleCss(url, channelStyles.metrics);
  assert.match(page, /height:100%/);
  assert.match(page, /overflow:hidden/);
  assert.match(page, /flex:1 1 0/);
  assert.match(master, /flex:1 1 0/);
  assert.match(master, /min-height:0/);
  assert.match(metrics, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(metrics, /@media \(max-width: 767\.98px\)\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(`${page}${master}${metrics}`, /box-shadow|linear-gradient|backdrop-filter/);
});

function withMedia<T>(hash: string, compact: boolean, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  class FakeElement {}
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeElement });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { hash, pathname: '/' },
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: (query: string) => ({ matches: compact && query.includes('1279.98'), addEventListener: () => {}, removeEventListener: () => {} }),
    },
  });
  try { return run(); } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousElement) Object.defineProperty(globalThis, 'HTMLElement', previousElement);
    else Reflect.deleteProperty(globalThis, 'HTMLElement');
  }
}

test('narrow detail headers keep the title and move login and delete into a more menu', () => {
  const id = Object.keys(config.channels)[0]!;
  const compact = withMedia(`#/channels/${id}`, true, () => markup(React.createElement(ChannelsPage, { policy })));
  assert.match(compact, /aria-label="更多操作"/);
  assert.doesNotMatch(compact, />登录官方账号</);
  assert.doesNotMatch(compact, />删除</);
  const wide = withMedia(`#/channels/${id}`, false, () => markup(React.createElement(ChannelsPage, { policy })));
  assert.doesNotMatch(wide, /aria-label="更多操作"/);
  assert.match(wide, />登录官方账号</);
  assert.match(wide, />删除</);
});

test('the detail surface extends into the reserved scrollbar gutter and stays flush', () => {
  const url = new URL('../../src/renderer/features/channels/channels-style.ts', import.meta.url);
  const css = styleCss(url, channelStyles.detailFrame);
  assert.match(css, /margin-inline-end:-10px/);
  assert.match(css, /@media \(max-width: 1023\.98px\)\{[^}]*margin-inline-end:0/);
});

test('login feedback uses a fixed status row for job errors and toasts for refresh failures', () => {
  const source = readFileSync(new URL('../../src/renderer/features/channels/ChannelLoginDialog.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<Alert/);
  assert.match(source, /role="status"[^>]*\{\.\.\.stylex\.props\(channelStyles\.loginState\)\}/);
  assert.match(source, /notifyError\(error, '无法刷新登录状态'\)/);
  assert.match(source, /notifyError\(error, '账号列表刷新失败'\)/);
});
