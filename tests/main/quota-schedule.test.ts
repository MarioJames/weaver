import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, validateConfig } from '../../src/main/policy/routing';
import { quotaRefreshEnabled, quotaSettings } from '../../src/shared/policy/settings';
import { PolicyStore } from '../../src/main/policy/store';
import { applyQuotaSnapshot, quotaRefreshTargets } from '../../src/main/policy/quota';
import { QuotaScheduler } from '../../src/main/quota/scheduler';
import type { EngineQuotaRecord, QuotaEngine } from '../../src/shared/contracts/quota';

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
  const dir = await mkdtemp(join(tmpdir(), 'wv-qs-'));
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

test('the scheduler refreshes due targets once per interval and follows the saved switch', async () => {
  const config = defaultConfig();
  let clock = now;
  const calls: string[] = [];
  let release: () => void = () => {};
  let hold: Promise<void> | undefined;
  const scheduler = new QuotaScheduler({ config: () => config, now: () => clock, refresh: async engine => { calls.push(engine); if (hold) await hold; } });
  assert.deepEqual(scheduler.status(), { enabled: true, intervalMinutes: 15, lastRunAt: null, nextRunAt: new Date(now).toISOString() });
  await scheduler.tick();
  assert.deepEqual(calls, ['codex', 'claude']);
  assert.equal(scheduler.status().nextRunAt, new Date(now + 15 * 60_000).toISOString());
  clock += 14 * 60_000;
  await scheduler.tick();
  assert.equal(calls.length, 2);
  clock += 60_000;
  hold = new Promise(resolve => { release = resolve; });
  const first = scheduler.tick();
  const overlapping = scheduler.tick();
  release();
  await Promise.all([first, overlapping]);
  assert.deepEqual(calls, ['codex', 'claude', 'codex', 'claude']);
  hold = undefined;
  config.quota = { auto_refresh: false, interval_minutes: 15 };
  clock += 60 * 60_000;
  await scheduler.tick();
  assert.equal(calls.length, 4);
  assert.equal(scheduler.status().nextRunAt, null);
});

test('a failed engine refresh does not stop the remaining targets', async () => {
  const config = defaultConfig();
  const calls: string[] = [];
  const errors: unknown[] = [];
  const scheduler = new QuotaScheduler({ config: () => config, now: () => now, log: error => errors.push(error), refresh: async engine => { calls.push(engine); if (engine === 'claude') throw new Error('offline'); } });
  await scheduler.tick();
  assert.deepEqual(calls, ['codex', 'claude']);
  assert.equal(errors.length, 1);
});

test('after stop() the scheduler refreshes nothing: a manual tick is a no-op and a run in flight skips its remaining targets', async () => {
  const config = defaultConfig();
  let clock = now;
  const calls: string[] = [];
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  let started: () => void = () => {};
  const refreshing = new Promise<void>(resolve => { started = resolve; });
  const scheduler = new QuotaScheduler({ config: () => config, now: () => clock, refresh: async engine => { calls.push(engine); started(); await hold; } });
  // Stopped while the first target is still refreshing: stop() waits for it, the second target is never started.
  const running = scheduler.tick();
  await refreshing;
  const stopping = scheduler.stop();
  release();
  await Promise.all([running, stopping]);
  assert.deepEqual(calls, ['codex'], 'the remaining targets are skipped once the scheduler is stopped');
  // A manual tick after the stop, with the interval long over, still refreshes nothing.
  clock += 60 * 60_000;
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(calls, ['codex']);
  // start() is what brings it back.
  scheduler.start(60_000);
  await scheduler.tick();
  assert.deepEqual(calls, ['codex', 'codex', 'claude']);
  await scheduler.stop();
});
