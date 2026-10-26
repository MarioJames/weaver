import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { toast, type ToastOptions } from '@lobehub/ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../../src/main/policy/routing';
import type { Block, PolicySnapshot } from '../../src/shared/contracts/policy';
import type { CommandRequest } from '../../src/shared/contracts/commands';
import { manualPauseOf } from '../../src/shared/policy/availability';
import { FREE_PROBE_BLOCK_BY, STALL_BLOCK_BY, VENDOR_BLOCK_BY, isQuotaBlock, manualResumeKind } from '../../src/shared/policy/blocks';
import { OwnerScheduleFields, workerStatusTag, workerWeightLock } from '../../src/renderer/features/roles/OwnerSchedule';
import { engineBlockText } from '../../src/renderer/policy/worker-resume';
import { resumeAction, resumeWorker } from '../../src/renderer/policy/worker-resume';

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
const NOW = Date.now();
const SINCE = '2026-10-19T00:00:00Z';
const block = (patch: Partial<Block>): Block => ({ engine: 'grok', reason: '原因', since: SINCE, ...patch });
const body = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '');
const markup = (node: React.ReactNode) => body(renderToStaticMarkup(React.createElement(ConfigProvider, { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'light', children: node }) } as React.ComponentProps<typeof ConfigProvider>)));

function grokConfig() {
  const config = defaultConfig();
  config.engines.grok!.enabled = true;
  config.workers.grok_worker!.enabled = true;
  return config;
}
const GROK_402 = block({ by: 'codex_owner', reason: 'Grok 最终 high 调用返回 402 余额耗尽，未提供恢复时间' });

test('quota is recognised from the marker or the wording, one rule for role recovery and the schedule list', () => {
  for (const [by, reason] of [['weaver-quota:grok', 'x'], [VENDOR_BLOCK_BY, '额度耗尽：FreeUsageLimitError'], [VENDOR_BLOCK_BY, 'GoUsageLimitError: out'], ['codex_owner', 'Grok 返回 402 余额耗尽'], ['manual', 'quota exceeded for this key']] as const) {
    assert.equal(isQuotaBlock({ by, reason }), true, `${by} ${reason}`);
    assert.equal(engineBlockText(block({ by, reason }), NOW).category, '额度耗尽', `${by} ${reason}`);
  }
  for (const [by, reason] of [[VENDOR_BLOCK_BY, '限流：Rate limit exceeded'], ['manual', '人工暂停'], [STALL_BLOCK_BY, '2 个子 Agent 超过 5 分钟无响应']] as const) assert.equal(isQuotaBlock({ by, reason }), false, `${by} ${reason}`);
  assert.equal(engineBlockText(block({ by: STALL_BLOCK_BY, reason: '返回 402' }), NOW).category.startsWith('卡住惩罚'), true, 'a stall penalty is never a quota');
});

test('only quota and release-less blocks need a person; blocks that lift themselves do not', () => {
  assert.equal(manualResumeKind(GROK_402), 'quota');
  assert.equal(manualResumeKind(block({ by: 'weaver-quota:grok', release_at: FUTURE })), 'quota', 'a quota block is manual even with a refresh time');
  assert.equal(manualResumeKind(block({ by: 'manual' })), 'manual');
  assert.equal(manualResumeKind(block({ by: VENDOR_BLOCK_BY, reason: '限流：429', release_at: FUTURE })), undefined);
  assert.equal(manualResumeKind(block({ by: STALL_BLOCK_BY })), undefined, 'the probe lifts a stall penalty');
  assert.equal(manualResumeKind(block({ by: FREE_PROBE_BLOCK_BY })), undefined);
});

test('an exhausted quota or a release-less block locks the worker\'s weight; a timed rate limit, a stall penalty or an expired block does not', () => {
  const config = grokConfig();
  const lock = workerWeightLock(config, 'grok_worker', [GROK_402], NOW)!;
  assert.equal(lock.label, '额度耗尽');
  assert.match(lock.hint, /402 余额耗尽/);
  assert.match(lock.hint, /恢复派发/);
  assert.match(lock.hint, /在子 Agent 页/);
  assert.equal(workerWeightLock(config, 'grok_worker', [block({ by: 'manual', reason: '人工暂停' })], NOW)!.label, '已暂停 · 需手动恢复');
  assert.equal(workerWeightLock(config, 'grok_worker', [block({ worker: 'grok_worker', by: 'manual', reason: '人工暂停' })], NOW)!.label, '已暂停 · 需手动恢复', 'a worker-level ban locks it too');
  assert.equal(workerWeightLock(config, 'grok_worker', [block({ by: VENDOR_BLOCK_BY, reason: '限流：429', release_at: FUTURE })], NOW), undefined);
  assert.equal(workerWeightLock(config, 'grok_worker', [block({ by: STALL_BLOCK_BY })], NOW), undefined);
  assert.equal(workerWeightLock(config, 'grok_worker', [{ ...GROK_402, release_at: PAST }], NOW), undefined, 'a block past its release time is not in force');
  assert.equal(workerWeightLock(config, 'grok_worker', [block({ engine: 'codex', by: 'manual' }), block({ model: 'other-model', by: 'manual' }), block({ worker: 'other_worker', by: 'manual' })], NOW), undefined, 'blocks that do not reach this worker do not lock it');
  assert.equal(workerWeightLock(config, 'grok_worker', [], NOW), undefined);
  // The engine and worker switches still win, and the quota wins over a plain manual block.
  config.workers.grok_worker!.enabled = false;
  assert.equal(workerWeightLock(config, 'grok_worker', [GROK_402], NOW)!.label, '子 Agent 已停用');
  config.workers.grok_worker!.enabled = true;
  assert.equal(manualPauseOf(config, [block({ by: 'manual' }), block({ model: config.workers.grok_worker!.model, by: 'weaver-quota:grok' })], 'grok_worker', NOW)?.kind, 'quota');
});

test('a free-channel worker ignores the native quota marker, as routing does', () => {
  const config = grokConfig();
  config.workers.grok_worker!.free_channel = true;
  assert.equal(workerWeightLock(config, 'grok_worker', [block({ by: 'weaver-quota:grok', reason: '额度耗尽' })], NOW), undefined);
  assert.equal(workerWeightLock(config, 'grok_worker', [GROK_402], NOW)!.label, '额度耗尽', 'other sources still pause it');
});

test('the schedule row of a paused worker shows its tag, greys out and disables the weight, and keeps the saved weight', () => {
  const config = grokConfig();
  const record = { ...config.owners.claude_owner!, workers: ['claude_worker', 'grok_worker'], worker_weights: { grok_worker: 8 } };
  const tag = workerStatusTag(config, [GROK_402], 'grok_worker', 8)!;
  assert.equal(tag.label, '额度耗尽');
  assert.ok(tag.color, 'a pause is a warning-colored tag');
  const html = markup(React.createElement(OwnerScheduleFields, { config, blocks: [GROK_402], record, update: () => {} }));
  const row = (id: string) => html.match(new RegExp(`<div[^>]*>(?:(?!<div)[\\s\\S])*?${id} 的权重[\\s\\S]*?移除 ${id}`))?.[0] ?? '';
  const grok = row('grok_worker');
  assert.match(grok, /额度耗尽/);
  assert.match(grok, /data-locked/);
  assert.match(grok, /value="8"/);
  assert.equal((grok.match(/ disabled=""/g) ?? []).length >= 4, true, 'the number input and the three presets are disabled');
  assert.doesNotMatch(row('claude_worker'), /data-locked|额度耗尽/);
  // A rate limit with a release time is a tag only: the weight stays editable.
  const timed = markup(React.createElement(OwnerScheduleFields, { config, blocks: [block({ by: VENDOR_BLOCK_BY, reason: '限流：429', release_at: FUTURE })], record, update: () => {} }));
  assert.doesNotMatch(timed.match(new RegExp(`<div[^>]*>(?:(?!<div)[\\s\\S])*?grok_worker 的权重[\\s\\S]*?移除 grok_worker`))?.[0] ?? '', /data-locked| disabled=""/);
});

function bridge(command: (request: CommandRequest) => Promise<{ apiVersion: 'weaver.v1'; ok: boolean; data?: unknown; error?: { code: string; message: string; retryable: boolean } }>, getPolicy: () => Promise<PolicySnapshot>) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { weaver: { command, getPolicy } } });
}
const snapshot = (blocks: Block[]) => ({ revision: 3, config: defaultConfig(), blocks, activeBlocks: blocks, owners: {}, workers: {}, execution: 'disabled' }) as unknown as PolicySnapshot;

test('resuming a worker sends workers.unblock as a mutation, then follows the saved policy', async () => {
  const sent: CommandRequest[] = [];
  const rebased: Array<{ next: PolicySnapshot; draft: unknown }> = [];
  const saved = snapshot([block({ by: 'manual' })]);
  bridge(async request => { sent.push(request); return { apiVersion: 'weaver.v1', ok: true, data: { worker: 'grok_worker', engine: 'grok', removed: 1, wasBlocked: true } }; }, async () => saved);
  const draft = { config: defaultConfig(), blocks: [block({ worker: 'grok_worker', by: 'manual' })] };
  const done = await resumeWorker('grok_worker', { rebase: (next, update) => { rebased.push({ next, draft: update?.(structuredClone(draft)) }); } });
  assert.equal(done, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.command, 'workers.unblock');
  assert.deepEqual(sent[0]!.args, { worker: 'grok_worker' });
  assert.equal(typeof sent[0]!.commandId, 'string');
  assert.equal(rebased.length, 1);
  assert.equal(rebased[0]!.next, saved);
  assert.deepEqual((rebased[0]!.draft as typeof draft).blocks, saved.blocks, 'a page draft keeps its edits but takes the server blocks');
});

test('a failed resume is a floating notice, never a refresh, and a failed refresh is reported as such', async t => {
  const notices: ToastOptions[] = [];
  t.mock.method(toast, 'error', (options: ToastOptions) => { notices.push(options); return { id: 'x', close: () => {}, update: () => {} }; });
  let rebases = 0;
  let reads = 0;
  const policy = { rebase: () => { rebases += 1; } };
  bridge(async () => ({ apiVersion: 'weaver.v1', ok: false, error: { code: 'NOT_FOUND', message: 'Worker ghost is not configured', retryable: false } }), async () => { reads += 1; return snapshot([]); });
  assert.equal(await resumeWorker('ghost', policy), false);
  assert.deepEqual([rebases, reads], [0, 0]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.title, '恢复派发失败');
  assert.equal(notices[0]!.placement, 'bottom-right');
  bridge(async () => ({ apiVersion: 'weaver.v1', ok: true, data: {} }), async () => { throw Object.assign(new Error('HTTP_500: 读取失败'), { code: 'HTTP_500' }); });
  assert.equal(await resumeWorker('grok_worker', policy), false);
  assert.equal(rebases, 0);
  assert.equal(notices.at(-1)!.title, '已恢复派发，但刷新配置失败');
});

test('the shown ban decides the resume call: a worker\'s own ban (or the engine-wide vendor ban over it) goes through the server, an engine or model ban is removed from the policy', () => {
  const own = block({ engine: 'codex', worker: 'codex_worker', by: 'manual' });
  const derived = block({ engine: 'codex', by: VENDOR_BLOCK_BY, reason: '该引擎全部子 Agent 均被限流/额度耗尽' });
  const manualEngine = block({ engine: 'codex', by: 'manual' });
  const modelBan = block({ engine: 'codex', model: 'gpt-6.1-sol', by: 'manual' });
  assert.equal(resumeAction([own, manualEngine], 'codex_worker', own), 'unblock');
  assert.equal(resumeAction([derived, own], 'codex_worker', derived), 'unblock');
  assert.equal(resumeAction([derived], 'codex_worker', derived), 'remove', 'with no worker ban under it the engine ban is simply removed');
  assert.equal(resumeAction([manualEngine, own], 'codex_worker', manualEngine), 'remove', 'a manual engine ban is not the server\'s to lift here');
  assert.equal(resumeAction([modelBan, own], 'codex_worker', modelBan), 'remove');
  assert.equal(resumeAction([own], 'claude_worker', block({ engine: 'claude', worker: 'other_worker', by: 'manual' })), 'remove', 'another worker\'s ban is not this worker\'s call');
});

test('account and role switches control weight availability while legacy engine flags never hide pause recovery', () => {
  const config = grokConfig();
  config.engines.grok.enabled = false;
  assert.equal(workerWeightLock(config, 'grok_worker', [], NOW), undefined);
  assert.equal(workerWeightLock(config, 'grok_worker', [GROK_402], NOW)?.paused, true);
  const channel = config.workers.grok_worker.channels[0]!;
  config.channels[channel].enabled = false;
  assert.equal(workerWeightLock(config, 'grok_worker', [GROK_402], NOW)?.label, '渠道已停用');
  config.channels[channel].enabled = true;
  config.workers.grok_worker.enabled = false;
  assert.equal(workerWeightLock(config, 'grok_worker', [GROK_402], NOW)?.label, '子 Agent 已停用');
});

test('one restricted or disabled pool member does not pause the worker or lock its weight', () => {
  const config = defaultConfig();
  config.channels.second_grok = { ...config.channels.default_grok, enabled: true };
  config.workers.grok_worker = { ...config.workers.grok_worker, enabled: true, channels: ['default_grok', 'second_grok'] };
  const blocks: Block[] = [{ engine: 'grok', channel: 'default_grok', by: 'manual', reason: 'only first account', since: '2026-10-25T00:00:00Z' }];
  assert.equal(workerWeightLock(config, 'grok_worker', blocks), undefined);
  config.channels.default_grok.enabled = false;
  assert.equal(workerWeightLock(config, 'grok_worker', blocks), undefined);
  config.channels.second_grok.enabled = false;
  assert.equal(workerWeightLock(config, 'grok_worker', blocks)?.label, '渠道已停用');
});
