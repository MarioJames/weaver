import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineQuotaRecord } from '../../src/shared/contracts/quota';
import { quotaRecoveryText, quotaStatusText } from '../../src/renderer/features/quota/quota-view';

function record(overrides: Partial<EngineQuotaRecord> = {}): EngineQuotaRecord {
  return { engine: 'opencode', status: 'unknown', source: 'opencode_go_usage', checkedAt: null, observedAt: null,
    stale: true, windows: [], detail: 'fixture', retryAt: null, ...overrides };
}

test('OpenCode recovery text never promises a whole-engine pause or a dollar balance', () => {
  assert.match(quotaRecoveryText(record({ status: 'unsupported' })), /免费模型与按量余额没有官方只读额度接口/);
  assert.match(quotaRecoveryText(record({ status: 'unauthenticated' })), /重新导入该账号的原生 OpenCode Go 登录/);
  assert.match(quotaRecoveryText(record({ status: 'unauthenticated' })), /账号与渠道/);
  for (const status of ['unauthenticated', 'unsupported'] as const) assert.match(quotaRecoveryText(record({ status })), /额度读取本身不切换账号/);
  const exhausted = quotaRecoveryText(record({ status: 'exhausted' }));
  assert.match(exhausted, /不代表余额、免费模型或其他路线不可用/);
  assert.match(exhausted, /按对应模型反馈处理/);
  assert.doesNotMatch(exhausted, /暂停派发|自动解除/);
  assert.equal(quotaStatusText(record({ status: 'exhausted', stale: false })), '账户额度耗尽');
});

test('other engines keep their existing recovery wording', () => {
  const codex = { ...record(), engine: 'codex' as const };
  assert.match(quotaRecoveryText({ ...codex, status: 'unsupported' }), /核对原生 CLI 的订阅登录方式/);
  assert.match(quotaRecoveryText({ ...codex, status: 'unauthenticated' }), /原生 CLI 中确认登录/);
  assert.equal(quotaRecoveryText({ ...codex, status: 'exhausted' }), '');
});
