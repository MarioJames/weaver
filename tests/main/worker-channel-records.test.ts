import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from '../../src/shared/contracts/policy';
import type { EngineQuotaRecord, QuotaEngine } from '../../src/shared/contracts/quota';
import { migrate } from '../../src/main/migrate';
import { dbQuotaStore } from '../../src/main/storage/quota-snapshot';
import { selectWorkerChannel, workerChannelCandidates } from '../../src/main/policy/worker-channel-routing';

test('persisted multi-engine channel snapshots select only the resolved engine and channel', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    const store = dbQuotaStore(db);
    const now = Date.parse('2026-10-25T12:00:00Z');
    const sources = { codex: 'codex_usage', claude: 'claude_oauth_usage', grok: 'grok_cli_billing', opencode: 'opencode_go_usage' };
    const placeholder = (engine: QuotaEngine): EngineQuotaRecord => ({
      engine, source: sources[engine], status: 'unknown', checkedAt: null, observedAt: null,
      stale: true, windows: [], detail: '', retryAt: null,
    });
    const available: EngineQuotaRecord = {
      ...placeholder('opencode'), status: 'available', stale: false,
      checkedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(),
      windows: [{ id: 'rolling', label: 'rolling', scope: 'account', model: null,
        usedPercent: 10, remainingPercent: 90, resetsAt: new Date(now + 60_000).toISOString(),
        durationMinutes: 60, used: null, total: null, remaining: null, unit: 'percent' }],
    };
    const save = (channel: string, records: Partial<Record<QuotaEngine, EngineQuotaRecord>>) => {
      store.scope!(channel).save({ records, fingerprints: {}, lastAccounts: {}, nextRequests: {} });
    };
    for (const [channel, patch] of [
      ['ready', {}], ['spent', { status: 'exhausted' }], ['untrusted', { source: 'fixture' }],
      ['cached-full', { windows: available.windows.map(window => ({ ...window, usedPercent: 100, remainingPercent: 0 })) }],
    ] as const) {
      save(channel, {
        codex: placeholder('codex'), claude: placeholder('claude'), grok: placeholder('grok'),
        opencode: { ...available, ...patch },
      });
    }
    // A valid observation of another engine or channel cannot fill a missing OpenCode observation.
    save('wrong-engine', { codex: { ...available, engine: 'codex', source: sources.codex } });
    save('outside-pool', { opencode: available });
    const ids = ['ready', 'spent', 'untrusted', 'wrong-engine', 'missing', 'cached-full'];
    const config: Config = {
      version: 1, engines: { pool: { enabled: true, kind: 'opencode' } },
      channels: Object.fromEntries(ids.map(id => [id, { engine: 'pool', label: id, enabled: true, kind: 'subscription' }])),
      workers: { w: { channels: ids, enabled: true, model: 'opencode-go/model', effort: 'high' } },
      owners: {}, herdr: { max_wait_minutes: 1 },
    };
    const quotas = store.channelRecords!();
    assert.deepEqual(quotas.filter(record => record.channel === 'ready').map(record => record.engine), ['codex', 'claude', 'grok', 'opencode']);
    const context = { now, quotas, credentialsReady: () => true,
      pickIndex: () => { throw Error('only one eligible account; randomness is unnecessary'); } };
    assert.deepEqual(workerChannelCandidates(config, [], 'w', context).map(({ channel, eligible, reason }) => ({ channel, eligible, reason })), [
      { channel: 'ready', eligible: true, reason: 'ELIGIBLE' },
      { channel: 'spent', eligible: false, reason: 'QUOTA_NOT_AVAILABLE' },
      { channel: 'untrusted', eligible: false, reason: 'QUOTA_SOURCE_MISMATCH' },
      { channel: 'wrong-engine', eligible: false, reason: 'QUOTA_ENGINE_MISMATCH' },
      { channel: 'missing', eligible: false, reason: 'QUOTA_MISSING' },
      { channel: 'cached-full', eligible: false, reason: 'QUOTA_WINDOW_EXHAUSTED' },
    ]);
    assert.equal(selectWorkerChannel(config, [], 'w', context), 'ready');
    assert.equal(selectWorkerChannel(config, [], 'w', context, { frozenChannel: 'ready' }), 'ready');
  } finally {
    db.close();
  }
});
