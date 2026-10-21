import assert from 'node:assert/strict';
import test from 'node:test';
import { command } from '../../src/renderer/api/commands';
import type { WeaverAPI } from '../../src/shared/contracts/api';
import type { CommandRequest } from '../../src/shared/contracts/commands';

function bridge(fn: WeaverAPI['command']) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { weaver: { command: fn } } });
}

const args = { scheduleId: 'schedule-1', expectedRevision: 3 };

test('caller-controlled mutation IDs survive repeated submissions without hidden retry', async () => {
  const seen: CommandRequest[] = [];
  bridge(async request => {
    seen.push(request);
    return { apiVersion: 'weaver.v1', ok: true, data: { accepted: true } };
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await command('schedules.run', args, true, 'same-intent'), { accepted: true });
    }
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], { apiVersion: 'weaver.v1', command: 'schedules.run', args, commandId: 'same-intent' });
    assert.deepEqual(seen[1], seen[0]);
    await command('schedules.run', args, true);
    assert.match(seen[2].commandId ?? '', /^[0-9a-f-]{36}$/);
    assert.notEqual(seen[2].commandId, 'same-intent');
    await command('schedules.get', args, false, 'unused-mutation-intent');
    assert.equal(seen[3].commandId, undefined);
  } finally { Reflect.deleteProperty(globalThis, 'window'); }
});

test('command failures retain code and retryable without retrying uncertain mutations', async () => {
  for (const [code, retryable] of [['COMMAND_INDETERMINATE', true], ['REVISION_CONFLICT', false]] as const) {
    let calls = 0;
    bridge(async request => {
      calls += 1;
      assert.equal(request.commandId, 'uncertain-intent');
      return { apiVersion: 'weaver.v1', ok: false, error: { code, message: '需要核对原回执', retryable } };
    });
    try {
      await assert.rejects(command('schedules.run', args, true, 'uncertain-intent'), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, `${code}: 需要核对原回执`);
        assert.equal((error as Error & { code: string }).code, code);
        assert.equal((error as Error & { retryable: boolean }).retryable, retryable);
        return true;
      });
      assert.equal(calls, 1);
    } finally { Reflect.deleteProperty(globalThis, 'window'); }
  }
});

test('a rejected bridge call is propagated once with its original error', async () => {
  const failure = Object.assign(new Error('response lost'), { code: 'NETWORK_ERROR', retryable: true });
  let calls = 0;
  bridge(async () => { calls += 1; throw failure; });
  try {
    await assert.rejects(command('schedules.create', {}, true, 'lost-intent'), error => error === failure);
    assert.equal(calls, 1);
  } finally { Reflect.deleteProperty(globalThis, 'window'); }
});
