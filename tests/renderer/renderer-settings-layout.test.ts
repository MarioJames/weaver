import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../../src/main/policy/routing';
import { SettingsPage } from '../../src/renderer/features/settings/SettingsPage';
import type { PolicyDraft } from '../../src/renderer/policy/usePolicyDraft';

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'light', children: node }) }));
}

function policyOf(over: Partial<PolicyDraft> = {}): PolicyDraft {
  const config = defaultConfig();
  return {
    snapshot: { revision: 1, config, blocks: [], owners: {}, workers: {} },
    loadError: '', commit: async () => {}, load: async () => true,
    ...over,
  } as unknown as PolicyDraft;
}

test('the settings page heads with 设置 and the instant-effect tip', () => {
  const html = markup(React.createElement(SettingsPage, { policy: policyOf() }));
  assert.match(html, /<h1[^>]*>[\s\S]*?设置/, 'the page heads with 设置');
  assert.doesNotMatch(html, /保存修改/, '逐项即时保存的页面没有保存按钮文案');
  const source = readFileSync(join(import.meta.dirname, '../../src/renderer/features/settings/SettingsPage.tsx'), 'utf8');
  assert.match(source, /tips="每项修改立即生效/, 'the tip lives in TitleWithTips');
});

test('setting groups sit above their rows in the agreed order', () => {
  const html = markup(React.createElement(SettingsPage, { policy: policyOf() }));
  const groups = ['显示', '额度', '免费渠道探测', '审查', '父 Agent', '数据维护'];
  const at = groups.map(group => html.indexOf(`>${group}<`));
  for (let i = 0; i < groups.length; i++) assert.ok(at[i]! > 0, `the ${groups[i]} group title is rendered`);
  for (let i = 1; i < groups.length; i++) assert.ok(at[i]! > at[i - 1]!, `${groups[i]} sits after ${groups[i - 1]}`);
  for (const label of ['项目时区', '定时刷新额度', '刷新间隔（分钟）', '定时探测', '探测间隔（分钟）', 'ChatGPT Pro 自动审查', '查看间隔上限（分钟）', '单条命令最长运行时间（分钟）']) {
    assert.match(html, new RegExp(label), `the ${label} row is rendered`);
  }
  const firstRow = html.indexOf('项目时区');
  assert.ok(at[0]! < firstRow, 'the group title sits above its rows, not in a left table column');
  assert.match(html, /OpenCode 数据库/);
  assert.match(html, />清理数据库<\/button>/);
  assert.doesNotMatch(html, /调度主引擎|思考力度|工作空间|工作区/, 'no retired vocabulary remains in the settings copy');
});

test('a failed policy read shows a fixed failure row with retry, not only a toast', () => {
  const html = markup(React.createElement(SettingsPage, { policy: policyOf({ snapshot: undefined, loadError: '连接已断开' }) }));
  assert.match(html, /读取失败/);
  assert.match(html, />重试<\/button>/);
  assert.match(html, /role="status"/, 'the row is a live status, not an alert dumped into the page flow');
});

test('schedule timestamps render through the shared time element', () => {
  const source = readFileSync(join(import.meta.dirname, '../../src/renderer/features/settings/SettingsPage.tsx'), 'utf8');
  assert.match(source, /<TimeText value=\{schedule\./, 'quota schedule times go through TimeText');
  assert.match(source, /<TimeText value=\{freeProbe\.status\.schedule\./, 'probe schedule times go through TimeText');
  assert.match(source, /from '..\/..\/ui\/SettingGroup'/, 'groups come from the shared SettingGroup');
  assert.match(source, /from '..\/..\/ui\/SettingRow'/, 'rows come from the shared SettingRow');
});
