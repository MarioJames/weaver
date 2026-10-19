import assert from 'node:assert/strict';
import test from 'node:test';
import { routePreviewReducer, type PreviewState } from '../src/renderer/route-preview';
import type { RoutePreview } from '../src/shared/policy';

const result = { worker: 'codex_worker' } as RoutePreview;
test('changed preview conditions discard both a failed pin preview and successful result', () => {
  for (const outcome of [{ error: 'no available worker: fixed engine grok' }, { result }]) {
    const previous = { key: 'revision5/pin-grok', request: 1, ...outcome };
    const changed = routePreviewReducer(previous, { type: 'invalidate', key: 'revision6/no-pin' });
    assert.deepEqual(changed, { key: 'revision6/no-pin', request: 0 });
    assert.equal(routePreviewReducer(changed, { type: 'settled', key: previous.key, request: 1, ...outcome }), changed);
  }
});
test('late preview cannot overwrite a newer request, even with the same selection', () => {
  const pending = routePreviewReducer({ key: 'ownerA', request: 1 }, { type: 'request', key: 'ownerA', request: 2 });
  const current = routePreviewReducer(pending, { type: 'settled', key: 'ownerA', request: 2, result });
  assert.equal(current.result, result);
  assert.equal(routePreviewReducer(current, { type: 'settled', key: 'ownerA', request: 1, error: 'offline' }), current);
});
test('returning to previous conditions does not revive an old preview and offline preview can be retried', () => {
  let state: PreviewState = { key: 'ownerA', request: 1, error: 'NETWORK: Failed to fetch' };
  state = routePreviewReducer(state, { type: 'invalidate', key: 'ownerB' });
  state = routePreviewReducer(state, { type: 'invalidate', key: 'ownerA' });
  assert.equal(routePreviewReducer(state, { type: 'settled', key: 'ownerA', request: 1, result }), state);
  state = routePreviewReducer(state, { type: 'request', key: 'ownerA', request: 2 });
  state = routePreviewReducer(state, { type: 'settled', key: 'ownerA', request: 2, result });
  assert.equal(state.error, undefined);
  assert.equal(state.result, result);
});
