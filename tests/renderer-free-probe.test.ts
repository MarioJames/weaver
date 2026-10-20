import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { FreeChannelStatus, FreeWorkerStatus } from '../src/shared/contracts/monitoring';
import { defaultConfig, validateConfig } from '../src/main/policy/routing';
import { type Block } from '../src/shared/contracts/policy';
import { FreeProbePanel } from '../src/renderer/components/FreeProbePanel';
import { workerStatusTag } from '../src/renderer/components/OwnerSchedule';
import type { FreeProbe } from '../src/renderer/hooks/useFreeProbe';
import { RolesPage, roleNote } from '../src/renderer/pages/RolesPage';
import { SettingsPage } from '../src/renderer/pages/SettingsPage';
import { minutesError } from '../src/renderer/policy-edit';
import { FREE_PROBE_BLOCK_BY, STALL_BLOCK_BY, VENDOR_BLOCK_BY, blockOf, blockText, lastProbeOf, nextProbeText, pauseOfBlock, probeDurationText, probeNoteText, probeScheduleText, probeStateView, recentProbes } from '../src/renderer/probe-view';
import { createBrowserClient } from '../src/renderer/client';
import type { PolicyDraft } from '../src/renderer/usePolicyDraft';

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) })).replace(/<style[\s\S]*?<\/style>/g, '');
}

const FUTURE = '2999-01-01T00:00:00.000Z';
/** Compact rule: another day than today reads MM-DD HH:mm. */
const DATE = /\d{2}-\d{2} \d{2}:\d{2}/;
type History = FreeWorkerStatus['history'][number];
const record = (n: number, ok: boolean, extra: Partial<History> = {}): History => ({ worker: 'qoder_worker', engine: 'qoder', level: 0, at: new Date(Date.UTC(2026, 9, 19, 12, n)).toISOString(), probe: ok ? { ok, ms: 1200 } : { ok, ms: 3400, error: `失败 ${n}` }, ...extra });
const status = (extra: Partial<FreeWorkerStatus> = {}): FreeWorkerStatus => ({
  worker: 'qoder_worker', engine: 'qoder', model: 'Qwen3.8-Flash', probed: true, level: 0, mode: null, needsAttention: false,
  lastTriggerAt: null, blockedUntil: null, nextProbeAt: null, probeSuccesses: 0, availability: { status: 'available' }, history: [record(1, true)], ...extra,
});

test('probe state: healthy, never probed and not taking part', () => {
  assert.deepEqual(probeStateView(status()), { key: 'healthy', label: '正常', tone: 'success' });
  const never = probeStateView(status({ history: [] }));
  assert.equal(never.key, 'never');
  assert.equal(never.label, '从未探测');
  for (const view of [probeStateView(undefined), probeStateView(status({ probed: false }))]) {
    assert.equal(view.key, 'idle');
    assert.equal(view.label, '未参与探测');
  }
  // A probe that cannot run says why instead of showing an old healthy tag.
  assert.match(probeStateView(undefined).detail!, /保存后/);
});

test('probe state: a stall penalty names its level and when it probes again; the ladder top needs a person', () => {
  for (const level of [1, 2]) {
    const view = probeStateView(status({ mode: 'stall', level, blockedUntil: FUTURE, nextProbeAt: FUTURE, availability: { status: 'blocked', reason: '无响应' } }));
    assert.equal(view.label, `暂时不可用 · 惩罚第 ${level} 级`);
    assert.equal(view.tone, 'warning');
    assert.match(view.detail!, new RegExp(`将于 ${DATE.source} 再次探测`));
  }
  const top = probeStateView(status({ mode: 'stall', level: 3, needsAttention: true, probeSuccesses: 0 }));
  assert.equal(top.label, '需要人工处理');
  assert.equal(top.tone, 'error');
  assert.match(top.detail!, /连续成功 3 次后自动恢复/);
  assert.doesNotMatch(top.detail!, /已连续成功/);
  assert.match(probeStateView(status({ mode: 'stall', level: 3, needsAttention: true, probeSuccesses: 2 })).detail!, /已连续成功 2\/3 次/);
  // Waiting on a pass alone: a level without any deadline.
  assert.equal(probeStateView(status({ mode: 'stall', level: 2 })).detail, '等待探测成功后恢复');
});

test('probe state: a rate limit is a vendor ladder level, distinct from the stall penalty', () => {
  const view = probeStateView(status({ mode: 'rate_limit', level: 2, blockedUntil: FUTURE, availability: { status: 'blocked', reason: '限流', release_at: FUTURE } }));
  assert.equal(view.label, '暂时不可用 · 限流第 2 级');
  assert.equal(view.key, 'temporary');
});

test('probe state: free quota exhaustion shows the vendor release time, or waits on a passing probe', () => {
  const withRelease = probeStateView(status({ mode: 'quota', level: 1, blockedUntil: FUTURE, availability: { status: 'blocked', reason: '额度耗尽', release_at: FUTURE } }));
  assert.equal(withRelease.label, '免费额度用完');
  assert.equal(withRelease.tone, 'orange');
  assert.match(withRelease.detail!, new RegExp(`^预计 ${DATE.source} 恢复$`));
  // The policy's own release time wins; the monitor's nominal deadline is the fallback.
  assert.match(probeStateView(status({ mode: 'quota', blockedUntil: FUTURE })).detail!, /^预计 .* 恢复$/);
  assert.equal(probeStateView(status({ mode: 'quota', availability: { status: 'blocked', reason: '额度耗尽' } })).detail, '等待探测成功后恢复');
  assert.notEqual(withRelease.label, probeStateView(status({ mode: 'stall', level: 1 })).label);
});

test('probe state: a block somebody else holds is a plain restriction, not a probe penalty', () => {
  const view = probeStateView(status({ availability: { status: 'blocked', reason: '手动暂停' } }));
  assert.equal(view.key, 'restricted');
  assert.equal(view.label, '已限制');
});

test('history is newest first, capped at five, with duration and notes', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map(n => record(n, n % 2 === 1, n === 7 ? { message: '惩罚升级到第 1 级' } : {}));
  const entry = status({ history: rows });
  assert.deepEqual(recentProbes(entry).map(item => item.at), rows.slice(-5).reverse().map(item => item.at));
  assert.equal(recentProbes(entry, 2).length, 2);
  assert.equal(lastProbeOf(entry), rows.at(-1));
  assert.deepEqual(recentProbes(undefined), []);
  assert.equal(lastProbeOf(status({ history: [] })), undefined);
  assert.equal(probeDurationText(850), '850 毫秒');
  assert.equal(probeDurationText(3400), '3.4 秒');
  assert.equal(probeDurationText(-1), '耗时未知');
  assert.equal(probeNoteText(rows[6]!), '惩罚升级到第 1 级');
  assert.equal(probeNoteText(record(1, false, { message: '惩罚升级到第 2 级' })), '失败 1 · 惩罚升级到第 2 级');
  assert.equal(probeNoteText(record(1, true)), '');
});

test('next probe: the worker deadline, else the next scheduled round, else why there is none', () => {
  const schedule: FreeChannelStatus['schedule'] = { enabled: true, interval_minutes: 10, lastRunAt: null, nextRunAt: FUTURE };
  assert.match(nextProbeText(status({ nextProbeAt: '2999-02-02T00:00:00.000Z' }), schedule), DATE);
  assert.equal(nextProbeText(status(), { ...schedule, nextRunAt: null }), '待定');
  assert.equal(nextProbeText(status(), { ...schedule, enabled: false }), '定时探测已关闭');
  assert.equal(nextProbeText(status({ probed: false }), schedule), '不参与探测');
  assert.equal(nextProbeText(undefined, schedule), '不参与探测');
});

test('settings schedule text: off, not started yet, last and next run', () => {
  const schedule: FreeChannelStatus['schedule'] = { enabled: true, interval_minutes: 10, lastRunAt: null, nextRunAt: FUTURE };
  assert.match(probeScheduleText(schedule, false), /已关闭/);
  assert.match(probeScheduleText(undefined, true), /按下方间隔/);
  assert.match(probeScheduleText(schedule, true), new RegExp(`^下次 ${DATE.source} · 尚未运行$`));
  assert.match(probeScheduleText({ ...schedule, lastRunAt: '2999-01-01T00:00:00.000Z' }, true), new RegExp(`上次 ${DATE.source}`));
});

test('a block says what kind of pause it is: temporary, free quota, or plain restriction', () => {
  assert.deepEqual(pauseOfBlock({ by: STALL_BLOCK_BY }), { label: '暂时不可用', tone: 'warning' });
  assert.deepEqual(pauseOfBlock({ by: VENDOR_BLOCK_BY }), { label: '暂时不可用', tone: 'warning' });
  assert.deepEqual(pauseOfBlock({ by: FREE_PROBE_BLOCK_BY }), { label: '免费额度用完', tone: 'orange' });
  assert.equal(pauseOfBlock({ by: 'manual' }), undefined);
  assert.equal(pauseOfBlock({}), undefined);
  assert.equal(pauseOfBlock(undefined), undefined);
  assert.equal(blockText({ reason: '额度耗尽', release_at: undefined }), '额度耗尽');
  assert.match(blockText({ reason: '额度耗尽', release_at: FUTURE }), new RegExp(`^额度耗尽，${DATE.source} 恢复$`));
});

function schedule() {
  const config = defaultConfig();
  config.engines.qoder.enabled = true;
  config.engines.opencode.enabled = true;
  config.workers.qoder_worker.enabled = true;
  config.workers.opencode_worker.enabled = true;
  return config;
}
const blockFor = (worker: 'qoder_worker' | 'opencode_worker', by: string, release_at?: string): Block => {
  const profile = schedule().workers[worker];
  return { engine: profile.engine, model: profile.model, reason: by === FREE_PROBE_BLOCK_BY ? '额度耗尽：免费额度已用完' : '探测失败：超时', since: '2026-10-19T00:00:00Z', by, ...(release_at ? { release_at } : {}) };
};

test('parent schedule rows tell a temporary pause from exhausted free quota, with the reason', () => {
  const config = schedule();
  const quota = workerStatusTag(config, [blockFor('qoder_worker', FREE_PROBE_BLOCK_BY, FUTURE)], 'qoder_worker', 5)!;
  assert.equal(quota.label, '免费额度用完');
  assert.equal(quota.color, 'orange');
  assert.match(quota.reason!, /额度耗尽：免费额度已用完，.* 恢复/);
  const temporary = workerStatusTag(config, [blockFor('opencode_worker', STALL_BLOCK_BY)], 'opencode_worker', 5)!;
  assert.equal(temporary.label, '暂时不可用');
  assert.equal(temporary.color, 'warning');
  const vendor = workerStatusTag(config, [blockFor('opencode_worker', VENDOR_BLOCK_BY, FUTURE)], 'opencode_worker', 5)!;
  assert.equal(vendor.label, '暂时不可用');
  // Other sources keep the plain label; a worker the block does not name is untouched.
  assert.equal(workerStatusTag(config, [blockFor('qoder_worker', 'manual')], 'qoder_worker', 5)!.label, '已限制');
  assert.equal(workerStatusTag(config, [blockFor('qoder_worker', FREE_PROBE_BLOCK_BY)], 'opencode_worker', 5), undefined);
  assert.equal(blockOf([blockFor('qoder_worker', STALL_BLOCK_BY)], config.workers.opencode_worker), undefined);
});

test('list notes carry the pause kind as a tag only for probe and penalty blocks', () => {
  const block = blockFor('qoder_worker', FREE_PROBE_BLOCK_BY, FUTURE);
  const note = roleNote({ status: 'blocked', reason: block.reason }, false, block);
  assert.equal(note?.tag?.label, '免费额度用完');
  assert.match(note!.text, /额度耗尽：免费额度已用完，.* 恢复/);
  assert.equal(roleNote({ status: 'blocked', reason: '额度耗尽' }, false)?.tag, undefined);
  assert.equal(roleNote({ status: 'blocked', reason: '手动' }, false, blockFor('qoder_worker', 'manual'))?.tag, undefined);
  assert.equal(roleNote({ status: 'blocked', reason: '超时' }, false, blockFor('opencode_worker', STALL_BLOCK_BY))?.tag?.label, '暂时不可用');
});

function probe(extra: Partial<FreeProbe> = {}, entries: FreeWorkerStatus[] = [status()]): FreeProbe {
  return { status: { schedule: { enabled: true, interval_minutes: 10, lastRunAt: null, nextRunAt: FUTURE }, workers: entries }, unavailable: false, probing: new Set(), probeNow: async () => {}, ...extra };
}

test('the probe panel shows state, latest result with its error, next probe and five history rows', () => {
  const rows = [1, 2, 3, 4, 5, 6].map(n => record(n, n !== 6));
  const html = markup(React.createElement(FreeProbePanel, { worker: 'qoder_worker', probe: probe({}, [status({ mode: 'quota', level: 1, blockedUntil: FUTURE, nextProbeAt: FUTURE, availability: { status: 'blocked', reason: '额度耗尽：免费额度已用完', release_at: FUTURE }, history: rows })]) }));
  assert.match(html, /<dt[^>]*>当前状态<\/dt>/);
  assert.match(html, /免费额度用完/);
  assert.match(html, /预计 \d{2}-\d{2} \d{2}:\d{2} 恢复/);
  assert.match(html, /<dt[^>]*>暂停原因<\/dt><dd[^>]*>.*额度耗尽：免费额度已用完/);
  assert.match(html, /<dt[^>]*>最近探测<\/dt>[\s\S]*失败[\s\S]*3\.4 秒[\s\S]*失败 6/);
  assert.match(html, /<dt[^>]*>下次探测<\/dt>/);
  assert.equal((html.match(/<li\b/g) ?? []).length, 5);
  assert.match(html, /aria-label="立即探测 qoder_worker"/);
  assert.doesNotMatch(html.match(/<button[^>]*aria-label="立即探测 qoder_worker"[^>]*>/)![0], /disabled/);
});

test('the probe panel keeps an empty history out of the way and refuses a probe the worker cannot take', () => {
  const never = markup(React.createElement(FreeProbePanel, { worker: 'qoder_worker', probe: probe({}, [status({ history: [] })]) }));
  assert.match(never, /从未探测/);
  assert.match(never, /暂无记录/);
  assert.doesNotMatch(never, /<ol|最近 5 次探测/);
  const idle = markup(React.createElement(FreeProbePanel, { worker: 'qoder_worker', probe: probe({}, []) }));
  assert.match(idle, /未参与探测/);
  assert.match(idle.match(/<button[^>]*aria-label="立即探测 qoder_worker"[^>]*>/)![0], /disabled/);
});

test('the probe panel waits, shows a probe in flight, and survives an unreadable status', () => {
  const waiting = markup(React.createElement(FreeProbePanel, { worker: 'qoder_worker', probe: { ...probe(), status: undefined } }));
  assert.match(waiting, /aria-label="正在读取探测状态"/);
  const running = markup(React.createElement(FreeProbePanel, { worker: 'qoder_worker', probe: probe({ probing: new Set(['qoder_worker']) }) }));
  assert.match(running, /正在向 qoder_worker 发送问候/);
  assert.doesNotMatch(running, /按设置的间隔/);
  const other = markup(React.createElement(FreeProbePanel, { worker: 'qoder_worker', probe: probe({ probing: new Set(['other_worker']) }) }));
  assert.doesNotMatch(other, /正在向/);
  const unreadable = markup(React.createElement(FreeProbePanel, { worker: 'qoder_worker', probe: { ...probe(), status: undefined, unavailable: true } }));
  assert.match(unreadable, /探测状态暂时读取不到/);
  assert.match(unreadable.match(/<button[^>]*aria-label="立即探测 qoder_worker"[^>]*>/)![0], /disabled/);
});

function roles(free: boolean) {
  const config = defaultConfig();
  config.workers = { opencode_worker: { ...config.workers.opencode_worker!, free_channel: free } };
  return React.createElement(RolesPage, { section: 'workers', policy: { config } as PolicyDraft });
}

test('only a sub agent marked as free channel shows the probe block', () => {
  assert.match(markup(roles(true)), /aria-label="探测状态"/);
  assert.doesNotMatch(markup(roles(false)), /探测状态|立即探测/);
});

function settings(patch: (config: ReturnType<typeof defaultConfig>) => void = () => {}) {
  const config = defaultConfig();
  patch(config);
  const policy = { snapshot: { revision: 1, config, blocks: [] }, loadError: '', commit: async () => {} } as unknown as PolicyDraft;
  return markup(React.createElement(SettingsPage, { policy }));
}

test('settings carry a free channel probe group, defaulting to enabled every 10 minutes', () => {
  const html = settings(config => { delete config.free_channel_probe; });
  assert.match(html, /aria-label="免费渠道探测"/);
  assert.match(html, />定时探测</);
  assert.match(html, /5 到 1440 分钟/);
  const group = html.slice(html.indexOf('aria-label="免费渠道探测"'), html.indexOf('aria-label="审查"'));
  assert.match(group, /role="switch"[^>]*aria-checked="true"/);
  assert.match(group, /id="[^"]*-probe-interval"[^>]*value="10"/);
  assert.doesNotMatch(group, /id="[^"]*-probe-interval"[^>]*disabled/);
});

test('a switched off probe disables its interval and says so', () => {
  const html = settings(config => { config.free_channel_probe = { enabled: false, interval_minutes: 1440 }; });
  const group = html.slice(html.indexOf('aria-label="免费渠道探测"'), html.indexOf('aria-label="审查"'));
  assert.match(group, /已关闭/);
  assert.match(group, /role="switch"[^>]*aria-checked="false"/);
  assert.match(group, /id="[^"]*-probe-interval"[^>]*value="1440"/);
  assert.match(group, /id="[^"]*-probe-interval"[^>]*disabled/);
});

test('interval input is refused outside 5-1440 and for non-integers; the saved policy rules agree', () => {
  for (const value of [null, 0, 4, 4.9, 5.5, 1441, 99999, Number.NaN]) assert.match(minutesError(value, 5, 1440), /^请输入 5 到 1440 之间的整数。$/, String(value));
  for (const value of [5, 10, 1440]) assert.equal(minutesError(value, 5, 1440), '');
  const config = defaultConfig();
  for (const interval of [4, 1441, 7.5]) {
    config.free_channel_probe = { enabled: true, interval_minutes: interval };
    assert.ok(validateConfig(config).some(issue => issue.path === '$.free_channel_probe.interval_minutes'), String(interval));
  }
  config.free_channel_probe = { enabled: true, interval_minutes: 5 };
  assert.deepEqual(validateConfig(config).filter(issue => issue.path.includes('free_channel_probe')), []);
});

test('the client reads probe status with no arguments and probes one named worker', async () => {
  const calls: { method: string; args: unknown[]; signal: boolean }[] = [];
  const original = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'http://127.0.0.1:4173' } } });
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; args: unknown[] };
    calls.push({ ...body, signal: !!init?.signal });
    return new Response(JSON.stringify({ result: { schedule: { enabled: true }, workers: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = createBrowserClient();
    await client.workerProbeStatus();
    await client.workerProbe({ worker: 'qoder_worker' });
    assert.deepEqual(calls.map(({ method, args }) => ({ method, args })), [
      { method: 'workerProbeStatus', args: [] },
      { method: 'workerProbe', args: [{ worker: 'qoder_worker' }] },
    ]);
  } finally {
    globalThis.fetch = original;
    Reflect.deleteProperty(globalThis, 'window');
  }
});
