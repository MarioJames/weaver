import assert from 'node:assert/strict';
import test from 'node:test';
import type { ImStatus } from '../../src/shared/contracts/im';
import {
  IM_STABLE_POLL_MS,
  IM_TRANSITION_POLL_MS,
  isImTransitional,
  nextImPollDelay,
} from '../../src/renderer/features/bots/im-polling';

function statusOf(over: Partial<ImStatus> = {}): ImStatus {
  return { connection: 'connected', agentState: 'ready', activeSessions: 1, busySessions: 0, ...over };
}

test('transitional states need the short poll cycle: connecting or agent starting/closing', () => {
  assert.equal(isImTransitional(statusOf({ connection: 'connecting', agentState: 'starting' })), true);
  assert.equal(isImTransitional(statusOf({ connection: 'connecting', agentState: 'ready' })), true);
  // 后端仅重建 Agent 时连接保持 connected，仍按 agentState 短周期跟进。
  assert.equal(isImTransitional(statusOf({ connection: 'connected', agentState: 'starting' })), true);
  assert.equal(isImTransitional(statusOf({ connection: 'connected', agentState: 'closing' })), true);
  assert.equal(isImTransitional(undefined), false);
});

test('stable states stay on the low-frequency cycle', () => {
  for (const status of [
    statusOf({ connection: 'connected', agentState: 'ready' }),
    statusOf({ connection: 'connected', agentState: 'busy' }),
    statusOf({ connection: 'connected', agentState: 'error' }),
    statusOf({ connection: 'disabled', agentState: 'disabled' }),
    statusOf({ connection: 'error', agentState: 'error' }),
  ]) {
    assert.equal(isImTransitional(status), false, `${status.connection}/${status.agentState} must not fast-poll`);
    assert.equal(nextImPollDelay(status), IM_STABLE_POLL_MS);
  }
  assert.equal(IM_STABLE_POLL_MS, 30_000, 'stable cycle keeps the existing 30s rhythm');
  assert.equal(IM_TRANSITION_POLL_MS, 1_000, 'transitional cycle follows up in ~1s without a manual refresh');
  assert.equal(nextImPollDelay(statusOf({ connection: 'connecting', agentState: 'starting' })), IM_TRANSITION_POLL_MS);
  assert.equal(nextImPollDelay(statusOf({ connection: 'connected', agentState: 'closing' })), IM_TRANSITION_POLL_MS);
  assert.equal(nextImPollDelay(undefined), IM_STABLE_POLL_MS);
});
