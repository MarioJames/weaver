import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { BlockList, EnginesPage, StallNotice } from '../src/renderer/pages/EnginesPage';
import { defaultConfig } from '../src/main/policy/routing';
import { type Block } from '../src/shared/contracts/policy';
import type { StallEngineState, StallHistoryEntry } from '../src/renderer/client';
import type { PolicyDraft } from '../src/renderer/usePolicyDraft';

function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const NOW = Date.parse('2026-10-19T06:00:00.000Z');
const at = (offset: number) => new Date(NOW + offset).toISOString();
function penalty(overrides: Partial<Block> = {}): Block {
  return { engine: 'codex', reason: '2 个子 Agent 超过 5 分钟无响应，第 1 次惩罚性暂停 5 分钟', since: at(-60_000), release_at: at(240_000), by: 'weaver-stall', ...overrides };
}
function entry(overrides: Partial<StallHistoryEntry> = {}): StallHistoryEntry {
  return { at: at(-60_000), level: 1, tasks: ['1ebbfc8f-afc6-4b93-8916-06ec488fbd8a'], stalledMinutes: 7, ...overrides };
}
function state(overrides: Partial<StallEngineState> = {}): StallEngineState {
  return { level: 1, lastTriggerAt: at(-60_000), needsAttention: false, history: [entry()], ...overrides };
}

test('the block row names the penalty level and recovery deadline once', () => {
  const html = markup(React.createElement(BlockList, { blocks: [penalty()], state: state({ level: 2 }), now: NOW, disabled: false, onRemove: () => {} }));
  assert.match(html, /卡住惩罚 第 2 级/);
  assert.match(html, /自动解除/);
  assert.equal((html.match(/aria-label="恢复派发"/g) ?? []).length, 1);
});

test('overdue early penalties wait for a probe, level three requires manual recovery', () => {
  for (const release_at of [at(-1), undefined, 'not a date']) {
    const html = markup(React.createElement(BlockList, { blocks: [penalty({ release_at })], state: state({ level: 3 }), now: NOW, disabled: false, onRemove: () => {} }));
    assert.match(html, /需手动恢复/);
  }
});

test('an engine without a penalty block in force shows no level line', () => {
  const html = markup(React.createElement(StallNotice, { state: state({ level: 2 }), now: NOW }));
  assert.doesNotMatch(html, /惩罚暂停 · 第 2 级/);
  assert.match(html, /记录/, 'the history stays readable while the monitor catches up');
});

test('the attention history reports the last trigger and how to lift it', () => {
  const html = markup(React.createElement(StallNotice, {
    state: state({ level: 3, needsAttention: true, history: [entry(), entry({ level: 5, tasks: ['9f2c0a11-dead-beef-0000-000000000001'], stalledMinutes: 41, at: at(-1) })] }),
    block: penalty({ release_at: undefined }), now: NOW,
  }));
  assert.match(html, /第 5 级/);
  assert.match(html, /9f2c0a11/);
  assert.match(html, /已卡住 41 分钟/);
  assert.match(html, /查看后点「恢复派发」解除/);
  assert.doesNotMatch(html, /dead-beef|afc6-4b93/, 'task ids stay shortened');
});

test('the alert still reads with no surviving trigger, and hostile task ids stay text', () => {
  const empty = markup(React.createElement(StallNotice, { state: state({ needsAttention: true, history: [], lastTriggerAt: at(-120_000) }), now: NOW }));
  assert.match(empty, /最近触发/);
  assert.match(empty, /查看后点「恢复派发」解除/);
  const hostile = markup(React.createElement(StallNotice, { state: state({ needsAttention: true, history: [entry({ tasks: ['<img src=x onerror=alert(1)>', '<script>bad()</script>'] })] }), now: NOW }));
  assert.doesNotMatch(hostile, /<script>|<img/);
  assert.match(hostile, /&lt;script&gt;/);
});

test('the record disclosure lists the five most recent penalties with their probe outcome', () => {
  const history = [0, 1, 2, 3, 4, 5, 6].map(index => entry({ level: index + 1, probe: { ok: true, ms: 1000 + index } }));
  const html = markup(React.createElement(StallNotice, { state: state({ level: 3, history }), block: penalty(), now: NOW }));
  assert.equal((html.match(/记录/g) ?? []).length, 1);
  assert.doesNotMatch(html, /探测正常 1000ms|探测正常 1001ms/);
  for (const ms of [1002, 1003, 1004, 1005, 1006]) assert.match(html, new RegExp(`探测正常 ${ms}ms`));
  assert.match(html, /第 7 级/);
  const failed = markup(React.createElement(StallNotice, { state: state({ history: [entry({ probe: { ok: false, ms: 30_000, error: 'scope 不可读' } })] }), block: penalty(), now: NOW }));
  assert.match(failed, /探测失败：scope 不可读/);
});

test('an engine with nothing to look up gets no disclosure and no notice at all', () => {
  assert.doesNotMatch(markup(React.createElement(StallNotice, { state: state({ history: [] }), block: penalty(), now: NOW })), /记录/);
  for (const props of [{}, { state: state({ level: 0, needsAttention: false, history: [] }) }]) {
    assert.doesNotMatch(markup(React.createElement(StallNotice, { ...props, now: NOW })), /惩罚暂停|多个子 Agent 卡住|记录|<details/);
  }
});

test('the engine page stays silent while the stall RPC is pending, missing or failing', () => {
  const config = defaultConfig();
  const live = { ...penalty(), since: new Date().toISOString(), release_at: new Date(Date.now() + 240_000).toISOString() };
  const blocks = [live];
  const policy = {
    snapshot: { revision: 1, config, blocks, activeBlocks: blocks, owners: {}, workers: {}, execution: 'disabled' },
    config, blocks, loading: false, busy: false, dirty: false, loadError: '', saveError: '', issues: [], conflict: false,
    setConfig: () => {}, setBlocks: () => {}, load: async () => true, save: async () => true, commit: async () => {}, rebase: () => {}, applyServerSnapshot: () => true,
  } as unknown as PolicyDraft;
  const html = markup(React.createElement(EnginesPage, { policy }));
  assert.doesNotMatch(html, /惩罚暂停|多个子 Agent 卡住|stall/i);
  assert.equal((html.match(/aria-label="恢复派发"/g) ?? []).length, 1, 'the penalty block stays liftable from the block list');
});
