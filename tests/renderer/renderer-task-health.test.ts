import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../../src/main/policy/routing';
import { SettingsPage } from '../../src/renderer/features/settings/SettingsPage';
import { TaskHealthView, commandElapsedText } from '../../src/renderer/features/tasks/TaskHealthBadge';
import type { PolicyDraft } from '../../src/renderer/policy/usePolicyDraft';
import type { TaskHealth } from '../../src/shared/contracts/monitoring';

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) }));
}
function settings(patch: (config: ReturnType<typeof defaultConfig>) => void = () => {}) {
  const config = defaultConfig();
  patch(config);
  const policy = { snapshot: { revision: 1, config, blocks: [] }, loadError: '', commit: async () => {} } as unknown as PolicyDraft;
  return markup(React.createElement(SettingsPage, { policy }));
}
function health(overrides: Partial<TaskHealth> = {}): TaskHealth {
  return { taskId: 't', state: 'running_command', taskStatus: 'running', engine: 'codex', lastEventAt: null, silenceMs: 20 * 60_000, cpuActive: true, cpuIdleMs: 0, scopeUnit: 's', ...overrides };
}

test('the parent-agent group carries the command bound, defaulting an older policy to 30', () => {
  const html = settings(config => { delete config.herdr.max_command_minutes; });
  const group = html.slice(html.indexOf('aria-label="父 Agent"'));
  assert.match(group, /单条命令最长运行时间（分钟）/);
  assert.match(group, /id="[^"]*-command"[^>]*value="30"/);
  assert.match(group, /1 到 1440 分钟/);
  assert.match(group, /不会自动停止命令/);
  assert.match(settings(config => { config.herdr.max_command_minutes = 1440; }), /id="[^"]*-command"[^>]*value="1440"/);
});

test('running_command renders in Chinese with its redacted summary and age', () => {
  const html = markup(React.createElement(TaskHealthView, { health: health({ runningCommand: { pid: 42, summary: 'pnpm test', startedAt: new Date(0).toISOString(), elapsedMs: 125_000 } }) }));
  assert.match(html, /命令运行中/);
  assert.match(html, /pnpm test/);
  assert.match(html, /已运行 2 分钟/);
  assert.doesNotMatch(html, /已卡住|command_timeout/);
});

test('a command timeout renders as a stall with the owner decision, not an automatic kill', () => {
  const html = markup(React.createElement(TaskHealthView, { health: health({ state: 'stalled', reason: 'command_timeout', runningCommand: { pid: 43, summary: 'docker build .', startedAt: new Date(0).toISOString(), elapsedMs: 31 * 60_000 } }) }));
  assert.match(html, /已卡住/);
  assert.match(html, /docker build \./);
  assert.match(html, /不会自动停止命令/);
});

test('command ages use seconds, minutes and hours at the same boundaries as the board', () => {
  assert.equal(commandElapsedText(9_000), '9 秒');
  assert.equal(commandElapsedText(60_000), '1 分钟');
  assert.equal(commandElapsedText(3_600_000), '1 小时 0 分钟');
});
