import assert from 'node:assert/strict';
import { dateText } from '../../src/renderer/features/quota/quota-view';
import test from 'node:test';
import { defaultConfig } from '../../src/main/policy/routing';
import type { PolicySnapshot } from '../../src/shared/contracts/policy';
import type { EngineQuotaRecord, QuotaRefreshResult, QuotaWindow } from '../../src/shared/contracts/quota';
import {
  acceptQuotaPolicy, quotaCountText, quotaNextUpdateMs, quotaPercentText, quotaProgressPercent, quotaRecordStale,
  quotaRecoveryText, quotaRetryMs, quotaScopeText, quotaStatusText, quotaWindowStale,
} from '../../src/renderer/features/quota/quota-view';

const NOW = Date.parse('2026-10-19T02:00:00Z');
const time = (offset: number) => new Date(NOW + offset).toISOString();
function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return { id: 'account', label: '主额度', scope: 'account', model: null, usedPercent: null, remainingPercent: null,
    resetsAt: null, durationMinutes: null, used: null, total: null, remaining: null, unit: 'percent', ...overrides };
}
function record(overrides: Partial<EngineQuotaRecord> = {}): EngineQuotaRecord {
  return { engine: 'codex', status: 'available', source: 'codex_usage', checkedAt: time(0), observedAt: time(0),
    stale: false, windows: [window()], detail: 'fixture', retryAt: null, ...overrides };
}
function snapshot(revision: number): PolicySnapshot {
  return { revision, config: defaultConfig(), blocks: [], activeBlocks: [], owners: {}, workers: {}, execution: 'disabled' };
}

test('quota display preserves unknowns, explicit zero, over-limit percentages and native units', () => {
  for (const value of [null, NaN, Infinity, -1]) {
    assert.equal(quotaPercentText(value), '未知');
    assert.equal(quotaProgressPercent(window({ usedPercent: value })), null);
    assert.equal(quotaCountText(value, 'usd'), '未知');
  }
  assert.equal(quotaPercentText(0), '0%');
  assert.equal(quotaProgressPercent(window({ usedPercent: 0 })), 0);
  assert.equal(quotaPercentText(137.25), '137.25%');
  assert.equal(quotaProgressPercent(window({ usedPercent: 137.25 })), 100);
  assert.equal(quotaCountText(2.5, 'usd'), '2.5 USD');
  assert.equal(quotaCountText(2.5, 'credits'), '2.5 credits');
  assert.equal(quotaCountText(0, 'requests'), '0 次请求');
});

test('model and unconfirmed windows retain their scope instead of implying account quota', () => {
  assert.equal(quotaScopeText(window()), '账户范围');
  assert.equal(quotaScopeText(window({ scope: 'model', model: 'grok-code' })), '模型范围：grok-code');
  assert.equal(quotaScopeText(window({ scope: 'model' })), '模型范围：未返回模型名');
  assert.equal(quotaScopeText(window({ scope: 'unknown', model: 'opus' })), '范围未确认 · 模型 opus');
  assert.equal(quotaScopeText(window({ scope: 'unknown' })), '范围未确认');
});

test('local aging expires at five minutes without treating a single expired window as the entire record', () => {
  const live = record({ windows: [window({ usedPercent: 100, resetsAt: time(600_000) })] });
  assert.equal(quotaRecordStale(live, NOW + 299_999), false);
  assert.equal(quotaRecordStale(live, NOW + 300_000), true);
  assert.equal(quotaRecordStale(record({ stale: true }), NOW), true);
  assert.equal(quotaRecordStale(record({ observedAt: null }), NOW), true);
  assert.equal(quotaRecordStale(record({ observedAt: 'invalid' }), NOW), true);
  const old = window({ id: 'hourly', usedPercent: 100, resetsAt: time(0) });
  const weekly = window({ id: 'weekly', usedPercent: 100, resetsAt: time(604_800_000) });
  const mixed = record({ windows: [old, weekly] });
  assert.equal(quotaRecordStale(mixed, NOW), false);
  assert.equal(quotaWindowStale(old, false, NOW), true);
  assert.equal(quotaWindowStale(weekly, false, NOW), false);
  assert.equal(quotaWindowStale(weekly, true, NOW), true);
  assert.equal(quotaRecordStale(record({ windows: [old] }), NOW), true);
});

test('expired successful observations and failed refreshes never present as current success', () => {
  assert.equal(quotaStatusText(record({ stale: true })), '上次观测：观测到可用额度');
  assert.equal(quotaStatusText(record({ stale: true, status: 'exhausted' })), '上次观测：账户额度耗尽');
  assert.equal(quotaStatusText(record({ stale: true, status: 'error' })), '额度查询失败');
});

test('independent account restriction remains current after a window reset but still ages and reports failed refreshes', () => {
  const restriction = record({ status: 'exhausted', statusBasis: 'account_restriction', windows: [window({ usedPercent: 100, resetsAt: time(-1) })] });
  assert.equal(quotaRecordStale(restriction, NOW), false);
  assert.equal(quotaWindowStale(restriction.windows[0], false, NOW), true);
  assert.equal(quotaStatusText(restriction, quotaRecordStale(restriction, NOW)), '账户额度耗尽');
  assert.equal(quotaRecordStale(restriction, NOW + 300000), true);
  assert.equal(quotaRecordStale({ ...restriction, stale: true, status: 'error' }, NOW), true);
  assert.equal(quotaNextUpdateMs([restriction], NOW), 300000);
});

test('retry cooldown uses the server deadline and releases exactly at the boundary', () => {
  const limited = record({ retryAt: time(60_000) });
  assert.equal(quotaRetryMs(limited, NOW), 60_000);
  assert.equal(quotaRetryMs(limited, NOW + 59_999), 1);
  assert.equal(quotaRetryMs(limited, NOW + 60_000), 0);
  assert.equal(quotaRetryMs(limited, NOW + 100_000), 0);
  assert.equal(quotaRetryMs(record({ retryAt: 'invalid' }), NOW), 0);
  assert.equal(quotaRetryMs(undefined, NOW), 0);
});

test('local deadlines wake at reset or freshness expiry and stop after expiry without a poll', () => {
  assert.equal(quotaNextUpdateMs([], NOW), null);
  assert.equal(quotaNextUpdateMs([record()], NOW), 300_000);
  assert.equal(quotaNextUpdateMs([record()], NOW + 299_999), 1);
  assert.equal(quotaNextUpdateMs([record()], NOW + 300_000), null);
  const short = record({ windows: [window({ usedPercent: 100, resetsAt: time(2_000) })] });
  assert.equal(quotaNextUpdateMs([short], NOW), 2_000);
  assert.equal(quotaNextUpdateMs([short], NOW + 2_000), null);
  const mixed = record({ windows: [window({ usedPercent: 100, resetsAt: time(-1) }), window({ id: 'weekly', usedPercent: 100, resetsAt: time(604_800_000) })] });
  assert.equal(quotaNextUpdateMs([mixed], NOW), 300_000);
  assert.equal(quotaNextUpdateMs([record({ retryAt: time(60_000) })], NOW), 1_000);
  assert.equal(quotaNextUpdateMs([record({ stale: true, retryAt: time(1) })], NOW), 1);
  assert.equal(quotaNextUpdateMs([record({ stale: true })], NOW), null);
});

test('quota refresh preserves dirty or newer policy and exposes reload/conflict recovery', () => {
  const previous = snapshot(5);
  const result: QuotaRefreshResult = { records: [], snapshot: snapshot(6), policyChanged: true };
  const accepted: PolicySnapshot[] = [];
  const applyServerSnapshot = (value: PolicySnapshot) => { accepted.push(value); return true; };
  assert.match(acceptQuotaPolicy({ dirty: true, snapshot: previous, applyServerSnapshot }, result), /未保存的修改已保留.*重新加载.*冲突/);
  assert.equal(accepted.length, 0);
  assert.match(acceptQuotaPolicy({ dirty: false, snapshot: snapshot(7), applyServerSnapshot }, result), /已有更新的策略版本/);
  assert.equal(accepted.length, 0);
  assert.match(acceptQuotaPolicy({ dirty: false, snapshot: previous, applyServerSnapshot: () => false }, result), /未保存的修改已保留.*重新加载.*冲突/);
  assert.equal(accepted.length, 0);
  assert.match(acceptQuotaPolicy({ dirty: false, snapshot: previous, applyServerSnapshot }, result), /已按额度更新自动限制/);
  assert.deepEqual(accepted, [result.snapshot]);
  assert.match(acceptQuotaPolicy({ dirty: false, snapshot: result.snapshot, applyServerSnapshot }, { ...result, policyChanged: false }), /^额度已刷新。$/);
});

test('an expired token waiting for native renewal shows kept windows or the no-data state without login wording', () => {
  const wait = '原生访问令牌已到期，等待原生 CLI 续期后再读取';
  // Mirrors what the engines page renders: the status tag, the detail line only when no window survived, and recovery advice only for non-unknown states.
  const pageText = (value: EngineQuotaRecord) => [
    quotaStatusText(value, quotaRecordStale(value, NOW)),
    value.windows.length ? '' : value.detail,
    value.status === 'unknown' ? '' : quotaRecoveryText(value),
  ].filter(Boolean).join(' ');
  const kept = record({ status: 'exhausted', stale: true, observedAt: time(-600_000), windows: [window({ usedPercent: 100, resetsAt: time(3_600_000) })], detail: wait });
  assert.equal(quotaRecordStale(kept, NOW), true);
  assert.match(pageText(kept), /上次观测：账户额度耗尽/);
  assert.doesNotMatch(pageText(kept), /登录/);
  const none = record({ status: 'unknown', stale: true, checkedAt: null, observedAt: null, windows: [], detail: wait });
  assert.equal(pageText(none), `额度未知 ${wait}`);
  assert.doesNotMatch(pageText(none), /登录/);
  const noData = record({ status: 'unknown', observedAt: null, windows: [], detail: '供应商未返回可用额度数据' });
  assert.equal(pageText(noData), '额度未知 供应商未返回可用额度数据');
  assert.doesNotMatch(pageText(none), /0%|耗尽/);
  const logout = record({ status: 'unauthenticated', stale: true, windows: [], detail: '原生登录已过期，请在对应工具中重新登录' });
  assert.match(pageText(logout), /登录状态不可用.*请在原生 CLI 中确认登录/);
});
test('quota dates follow the compact rule: HH:mm today, MM-DD HH:mm on another day', () => {
  const now = new Date(2026, 9, 19, 15, 0).getTime();
  assert.equal(dateText(new Date(2026, 9, 19, 11, 48, 34).toISOString(), now), '11:48');
  assert.equal(dateText(new Date(2026, 9, 20, 11, 48, 34).toISOString(), now), '10-20 11:48');
  assert.equal(dateText(null), '未知');
  assert.equal(dateText('invalid'), '未知');
});
