import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { EnginesPage, engineVersionText } from '../src/renderer/features/engines/EnginesPage';
import { quotaVisibleWindows } from '../src/renderer/features/quota/quota-view';
import { defaultConfig } from '../src/main/policy/routing';
import type { EngineQuotaRecord, QuotaWindow } from '../src/shared/contracts/quota';
import type { PolicyDraft } from '../src/renderer/policy/usePolicyDraft';

test('version label drops only a trailing commit hash, leaving the full probe available to the tooltip', () => {
  assert.equal(engineVersionText('grok 1.0.62 (1474f9cbdd91)'), 'grok 1.0.62');
  assert.equal(engineVersionText('grok 1.0.62 (1474f9cbdd91)\n'), 'grok 1.0.62');
  assert.equal(engineVersionText('codex 0.100.0'), 'codex 0.100.0');
  assert.equal(engineVersionText('tool 1.0 (preview)'), 'tool 1.0 (preview)');
});

test('unknown quota hides contradictory measured windows; known and failed queries keep observations', () => {
  const windows = [{ id: 'session', usedPercent: 56 }, { id: 'week', usedPercent: 26 }] as QuotaWindow[];
  const record = { status: 'unknown', windows } as EngineQuotaRecord;
  assert.deepEqual(quotaVisibleWindows(record), []);
  for (const status of ['available', 'exhausted', 'error'] as const) {
    assert.deepEqual(quotaVisibleWindows({ ...record, status }), windows);
  }
});

for (const [parent, child, label] of [[true, false, '父 Agent'], [false, true, '子 Agent'], [true, true, '父 Agent / 子 Agent']] as const) {
  test(`an enabled engine switch stays usable while enabled ${label} still use it`, () => {
    const config = defaultConfig();
    for (const owner of Object.values(config.owners)) owner.enabled = false;
    for (const worker of Object.values(config.workers)) worker.enabled = false;
    config.engines.claude!.enabled = true;
    config.owners.claude_owner!.enabled = parent;
    config.workers.claude_worker!.enabled = child;
    const policy = { snapshot: { revision: 1, config, blocks: [] }, config, loading: false, loadError: '' } as unknown as PolicyDraft;
    const html = renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children:
      React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: React.createElement(EnginesPage, { policy }) }) }));
    assert.ok(!html.includes('请先停用'), 'no disable-conflict text is rendered');
    const switchId = html.match(/<label\b[^>]*for="([^"]+)"[^>]*>启用 claude<\/label>/)?.[1];
    const claudeSwitch = switchId ? html.match(new RegExp(`<button\\b[^>]*id="${switchId}"[^>]*>`))?.[0] : undefined;
    assert.ok(claudeSwitch?.includes('role="switch"') && claudeSwitch.includes('aria-checked="true"'), 'the enabled claude switch is rendered on');
    assert.ok(!/\bdisabled\b/.test(claudeSwitch ?? ''), 'the enabled engine switch is not disabled');
    assert.ok(!/负责人|工作代理/.test(html), 'rendered text uses parent and child terminology');
  });
}
