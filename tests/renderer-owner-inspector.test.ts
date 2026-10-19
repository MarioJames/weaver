import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../src/shared/types';
import { ContinuationDialog, ownerOptions, OwnerInspector } from '../src/renderer/components/OwnerInspector';

function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

/** Fixed clock: the idle figures below are read against it. */
const now = Date.parse('2026-10-18T02:00:00Z');
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const owners = [{ id: 'claude_owner', kind: 'claude' }, { id: 'codex_owner', kind: 'codex' }, { id: 'pi_owner' }];
const base: Task = {
  id: 't1', title: '重排任务面板', instruction: 'Rework the board', workspace: '/home/mocha/opensource/weaver',
  owner: { name: 'Task owner', transport: 'herdr-visible', session: 'unverified', pane: 'unverified' },
  ownerId: 'owner-1', ownerEpoch: 2, ownerLastActivityAt: minutesAgo(5), continuationPolicy: { idleRotationMinutes: 60 },
  dispatch: { owner: 'codex_owner', worker: 'codex_worker', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', execution: 'real', maxParallel: 4 },
  status: 'completed', progress: 100, createdAt: minutesAgo(200), updatedAt: minutesAgo(5), events: [], artifacts: [], revision: 7,
};
const row = (task: Task, extra: Record<string, unknown> = {}) => markup(React.createElement(OwnerInspector, { task, busy: false, action: async () => true, owners, now, ...extra }));

test('a quiescent owner reads as continuable and offers the action', () => {
  const html = row(base);
  assert.match(html, /可接续/);
  assert.doesNotMatch(html, /已空闲|暂不可接续/);
  assert.match(html, /codex_owner/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""/);
});

test('a due owner says how long it has been idle', () => {
  const html = row({ ...base, ownerLastActivityAt: minutesAgo(95) });
  assert.match(html, /已空闲 95 分钟，建议接续/);
  assert.doesNotMatch(html, /可接续/);
});

test('an idle reminder switched off never reports a due owner', () => {
  const html = row({ ...base, ownerLastActivityAt: minutesAgo(95), continuationPolicy: { idleRotationMinutes: null } });
  assert.match(html, /可接续/);
  assert.doesNotMatch(html, /已空闲/);
});

test('worker activity blocks the action', () => {
  for (const task of [{ ...base, status: 'running' as const }, { ...base, status: 'cancelling' as const }, { ...base, scheduled: true }]) {
    const html = row(task);
    assert.match(html, /子 Agent执行中，暂不可接续/);
    assert.match(html, /<button[^>]*disabled=""/);
    assert.doesNotMatch(html, /已空闲/);
  }
});

test('a task without a registered owner cannot be handed over', () => {
  const html = row({ ...base, ownerId: undefined });
  assert.match(html, /<button[^>]*disabled=""/);
});

test('the owner mark and the Herdr host line come from the task record', () => {
  const html = row({ ...base, ownerHost: { kind: 'herdr', session: 'main', workspaceId: 'w1', paneId: '2', agentName: 'owner-8f3c2a1b-3', launchedAt: minutesAgo(5) } });
  assert.match(html, /<svg/);
  assert.match(html, /已在 Herdr 启动 owner-8f3c2a1b-3/);
  const plain = row(base);
  assert.doesNotMatch(plain, /已在 Herdr 启动/);
});

test('the tab holds nothing but the row and its action', () => {
  const html = row({ ...base, contextPack: { version: 1, id: 'p1', createdAt: minutesAgo(5), taskId: 't1', ownerEpoch: 2, goal: 'Rework', workspace: null, profile: 'codex_owner', constraints: [], plan: [], decisions: [], taskProgress: { status: 'completed', percent: 100, summary: null }, acceptedArtifacts: [], pendingApprovals: [], recentMessages: [], baseReferences: { taskId: 't1', packageId: null, previousPackId: null }, limitations: [] }, continuationHistory: [], packageId: 'pkg-1' });
  assert.doesNotMatch(html, /空闲阈值|登记接续|历史交接|接续包|执行记录|Token|Epoch|Revision|Package|Task t1|owner-1|pkg-1|验收标准/);
  assert.doesNotMatch(html, /逻辑登记|外部 CLI|宿主|费用未知/);
  assert.match(html, /接续给…/);
});

test('the dialog picks among enabled owner profiles with the handover sentence', () => {
  assert.deepEqual(ownerOptions(owners).map(option => option.value), ['claude_owner', 'codex_owner', 'pi_owner']);
  const labels = markup(React.createElement('div', null, ownerOptions(owners).map(option => React.createElement('div', { key: option.value }, option.label))));
  for (const id of ['claude_owner', 'codex_owner', 'pi_owner']) assert.match(labels, new RegExp(id));
  assert.equal((labels.match(/<svg/g) ?? []).length, 3);
  const html = markup(React.createElement(ContinuationDialog, { profiles: owners, value: 'codex_owner', sending: false, failure: '', onChange: () => {}, onRetry: () => {} }));
  assert.match(html, /接手父 Agent/);
  assert.match(html, /Weaver 会生成接续说明，并在 Herdr 中启动新的父 Agent接手这个任务。/);
  assert.match(html, /codex_owner/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /重试启动/);
  const unselected = markup(React.createElement(ContinuationDialog, { profiles: owners, sending: false, failure: '', onChange: () => {}, onRetry: () => {} }));
  assert.match(unselected, /选择接手父 Agent/);
});

test('a failed launch keeps the dialog open without inline error feedback', () => {
  const html = markup(React.createElement(ContinuationDialog, { profiles: owners, value: 'codex_owner', sending: false, failure: 'Herdr 启动失败：herdr is not installed', onChange: () => {}, onRetry: () => {} }));
  assert.doesNotMatch(html, /role="alert"|herdr is not installed|重试启动/);
  assert.match(html, /codex_owner/);
});
