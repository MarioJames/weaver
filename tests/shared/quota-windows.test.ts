import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QuotaWindow } from '../../src/shared/contracts/quota';
import { quotaWindowExhausted } from '../../src/shared/quota-windows';

const base: QuotaWindow = { id: 'test', label: 'test', scope: 'account', model: null, usedPercent: null, remainingPercent: null, resetsAt: null, durationMinutes: null, used: null, total: null, remaining: null, unit: 'credits' };

test('numeric exhaustion recognizes each independent signal without inventing a total', () => {
  for (const fields of [{ usedPercent: 100 }, { usedPercent: 105 }, { remainingPercent: 0 }, { remaining: 0 }, { used: 5, total: 5 }, { used: 6, total: 5 }]) {
    assert.equal(quotaWindowExhausted({ ...base, ...fields }), true, JSON.stringify(fields));
  }
});

test('zero usage and unknown/nonfinite measurements are not exhaustion', () => {
  for (const fields of [{}, { usedPercent: 0 }, { remainingPercent: 100 }, { remaining: 1 }, { used: 0, total: 10 }, { used: 0, total: 0 }, { used: 10, total: null }, { usedPercent: NaN, remainingPercent: NaN, remaining: NaN }, { usedPercent: Infinity, used: Infinity, total: 5 }, { used: 5, total: Infinity }, { used: 5, total: -1 }]) {
    assert.equal(quotaWindowExhausted({ ...base, ...fields }), false, JSON.stringify(fields));
  }
  assert.equal(quotaWindowExhausted({ id: 'missing' } as QuotaWindow), false);
});

test('the numeric predicate leaves scope and time applicability to its caller', () => {
  assert.equal(quotaWindowExhausted({ ...base, scope: 'model', model: 'other', resetsAt: '2000-01-01T00:00:00Z', usedPercent: 100 }), true);
});
