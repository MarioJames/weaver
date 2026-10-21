import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, validateConfig } from '../../src/main/policy/routing';
import { quotaRefreshEnabled, quotaSettings } from '../../src/shared/policy/settings';
import { PolicyStore } from '../../src/main/policy/store';
import { applyQuotaSnapshot, quotaRefreshTargets } from '../../src/main/policy/quota';
import type { EngineQuotaRecord, QuotaEngine } from '../../src/shared/contracts/quota';

const ROOT=process.env.ACCEPTANCE_TMPDIR??tmpdir();
const now = Date.parse('2030-01-01T00:00:00Z');

test('only paid quota engines refresh by default, and settings default to a 15 minute schedule', () => {
  const config = defaultConfig();
  const on = Object.entries(config.engines).filter(([, engine]) => quotaRefreshEnabled(engine)).map(([id]) => id).sort();
  assert.deepEqual(on, ['claude', 'codex', 'grok']);
  assert.deepEqual(quotaSettings(config), { auto_refresh: true, interval_minutes: 15 });
  // Older saved policies have neither field and keep the same meaning.
  delete config.quota;
  for (const engine of Object.values(config.engines)) delete engine.quota_refresh;
  assert.deepEqual(Object.entries(config.engines).filter(([, engine]) => quotaRefreshEnabled(engine)).map(([id]) => id).sort(), ['claude', 'codex', 'grok']);
  assert.deepEqual(quotaSettings(config), { auto_refresh: true, interval_minutes: 15 });
  assert.deepEqual(validateConfig(config), []);
});

test('quota settings reject intervals out of range and refresh on engines without a quota probe', () => {
  const config = defaultConfig();
  config.quota = { auto_refresh: true, interval_minutes: 4 };
  assert.ok(validateConfig(config).some(issue => issue.path === '$.quota.interval_minutes'));
  config.quota = { auto_refresh: true, interval_minutes: 1441 };
  assert.ok(validateConfig(config).some(issue => issue.path === '$.quota.interval_minutes'));
  config.quota = { auto_refresh: false, interval_minutes: 60 };
  config.engines.opencode.quota_refresh = true;
  assert.deepEqual(validateConfig(config).map(issue => issue.path), ['$.engines.opencode.quota_refresh']);
});

test('scheduled targets are the distinct kinds of enabled engines that refresh quota', () => {
  const config = defaultConfig();
  assert.deepEqual(quotaRefreshTargets(config), ['codex', 'claude']);
  config.engines.grok.enabled = true;
  config.engines.codex_alias = { enabled: true, kind: 'codex', quota_refresh: true };
  config.engines.codex.quota_refresh = false;
  assert.deepEqual(quotaRefreshTargets(config), ['codex', 'claude', 'grok']);
  config.engines.codex_alias.quota_refresh = false;
  assert.deepEqual(quotaRefreshTargets(config), ['claude', 'grok']);
});

function exhausted(engine: QuotaEngine): EngineQuotaRecord {
  return { engine, status: 'exhausted', source: 'fixture', checkedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), stale: false, windows: [], detail: 'fixture', retryAt: null };
}

test('an engine that does not refresh quota is never auto-blocked', async () => {
  const dir = await mkdtemp(join(ROOT, 'wv-qs-'));
  try {
    const policy = new PolicyStore(join(dir,'weaver.db'), () => now);
    const current = policy.snapshot();
    current.config.engines.codex.quota_refresh = false;
    current.config.engines.codex_alias = { enabled: false, kind: 'codex' };
    policy.save({ revision: current.revision, config: current.config, blocks: [] });
    const result = applyQuotaSnapshot(policy, { records: [exhausted('codex')] }, {}, now);
    assert.deepEqual(result.snapshot.blocks.map(block => block.engine), ['codex_alias']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
