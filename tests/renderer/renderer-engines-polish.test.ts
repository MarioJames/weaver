import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaVisibleWindows } from '../../src/renderer/features/quota/quota-view';
import type { EngineQuotaRecord, QuotaWindow } from '../../src/shared/contracts/quota';

test('unknown quota hides contradictory measured windows; known and failed queries keep observations', () => {
  const windows = [{ id: 'session', usedPercent: 56 }, { id: 'week', usedPercent: 26 }] as QuotaWindow[];
  const record = { status: 'unknown', windows } as EngineQuotaRecord;
  assert.deepEqual(quotaVisibleWindows(record), []);
  for (const status of ['available', 'exhausted', 'error'] as const) {
    assert.deepEqual(quotaVisibleWindows({ ...record, status }), windows);
  }
});
