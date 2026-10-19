import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfig, validateConfig } from '../src/main/policy/routing';
import type { EngineProbeRecord } from '../src/shared/engines';
import { savedEngineReadiness } from '../src/renderer/pages/EnginesPage';
import { acceptPolicyJson, appendWorker, removeEngine, removeRole, renameEngine, renameRole, roleDeleteImpact, syncRoleEditor, tagChoices, withOnlyEngine, withWorkerWeight, withoutListedWorker, workerWeight } from '../src/renderer/policy-edit';

const validate = async (config: unknown) => validateConfig(config);

test('role id editor follows the visible record', () => {
  assert.deepEqual(syncRoleEditor(['codex_worker'], 'claude_owner'), { selected: 'codex_worker', pendingId: 'codex_worker' });
  assert.deepEqual(syncRoleEditor(['codex_owner'], ''), { selected: 'codex_owner', pendingId: 'codex_owner' });
  assert.deepEqual(syncRoleEditor([], 'claude_owner'), { selected: '', pendingId: '' });
});

test('tag choices do not repeat class tags', () => {
  assert.deepEqual(tagChoices(['mechanical', 'frontend', 'mechanical']), ['mechanical', 'frontend', 'routine']);
});

test('deleting a worker names the owners that reference it', () => {
  const impact = roleDeleteImpact(defaultConfig(), 'workers', 'claude_worker');
  assert.match(impact.title, /claude_worker/);
  assert.match(impact.detail, /claude_owner/);
  assert.match(roleDeleteImpact(defaultConfig(), 'owners', 'codex_owner').detail, /取消不改草稿/);
});

test('advanced policy json keeps the current draft unless config and every block are safe', async () => {
  for (const config of [null, [], { version: 1 }]) assert.equal((await acceptPolicyJson(config, [], validate)).ok, false);
  for (const blocks of [[null], [1], [{}]]) assert.equal((await acceptPolicyJson(defaultConfig(), blocks, validate)).ok, false);
  const accepted = await acceptPolicyJson(defaultConfig(), [{ engine: 'claude', reason: '额度用尽', since: '2026-10-18T00:00:00Z' }], validate);
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.blocks[0]?.engine, 'claude');
});

function probe(id: string): EngineProbeRecord {
  return { id, kind: id, command: id, status: 'installed', probedAt: '2026-10-18T00:00:00.000Z', authenticated: false, modelUsable: false };
}

test('engine readiness follows the newest saved snapshot', () => {
  const saved = defaultConfig();
  const later = structuredClone(saved);
  later.engines.grok = { ...later.engines.grok, enabled: true };
  later.owners.grok_owner = { enabled: true, engine: 'grok', model: 'grok-4.7', effort: 'high', workers: ['grok_worker'], max_parallel: 1 };
  const probes = [probe('claude'), probe('grok')];
  const current = savedEngineReadiness(probes, { revision: 3, config: saved });
  assert.equal(current.find(item => item.id === 'claude')?.ownerConfigured, true);
  assert.equal(current.find(item => item.id === 'grok')?.ownerConfigured, false);
  assert.equal(current.find(item => item.id === 'grok')?.enabled, false);
  const written = savedEngineReadiness(probes, { revision: 3, config: saved }, { revision: 4, config: later });
  assert.equal(written.find(item => item.id === 'grok')?.ownerConfigured, true);
  assert.equal(written.find(item => item.id === 'grok')?.enabled, true);
  const reloaded = savedEngineReadiness(probes, { revision: 5, config: saved }, { revision: 4, config: later });
  assert.equal(reloaded.find(item => item.id === 'grok')?.ownerConfigured, false);
  assert.equal(reloaded.find(item => item.id === 'grok')?.workerConfigured, true);
  assert.deepEqual(savedEngineReadiness(probes, undefined), []);
  const configured = defaultConfig();
  configured.engines.opencode.enabled = true;
  configured.workers.opencode_worker.enabled = true;
  const rows = savedEngineReadiness([probe('opencode'), probe('claude'), probe('gemini')], { revision: 1, config: configured });
  assert.equal(rows.find(item => item.id === 'opencode')?.adapterStatus, 'real');
  assert.equal(rows.find(item => item.id === 'opencode')?.realExecution, true);
  assert.equal(rows.find(item => item.id === 'claude')?.adapterStatus, 'deferred');
  assert.equal(rows.find(item => item.id === 'claude')?.realExecution, false);
  assert.equal(rows.find(item => item.id === 'gemini')?.adapterStatus, 'not_implemented');
  assert.equal(rows.find(item => item.id === 'gemini')?.realExecution, false);
});
test('adding a worker ignores a candidate that is stale or already listed', () => {
  assert.deepEqual(appendWorker(['claude_worker'], ['opencode_worker'], 'opencode_worker'), ['claude_worker', 'opencode_worker']);
  assert.equal(appendWorker(['claude_worker'], ['opencode_worker'], 'claude_worker'), undefined);
  assert.equal(appendWorker(['claude_worker'], ['opencode_worker'], 'grok_worker'), undefined);
  assert.equal(appendWorker(['claude_worker'], [], undefined), undefined);
});
test('renaming or removing a worker or engine keeps weight and pin keys saveable', () => {
  const config = defaultConfig();
  config.owners.claude_owner = withOnlyEngine(withWorkerWeight(config.owners.claude_owner, 'opencode_worker', 20), 'opencode');
  const renamed = renameRole(config, 'workers', 'opencode_worker', 'edit_worker');
  assert.equal(renamed.owners.claude_owner.workers.includes('edit_worker'), true);
  assert.equal(renamed.owners.claude_owner.worker_weights?.edit_worker, 20);
  assert.equal(Object.hasOwn(renamed.owners.claude_owner.worker_weights ?? {}, 'opencode_worker'), false);
  assert.equal(renamed.owners.claude_owner.only_engine, 'opencode');
  const unlisted = withoutListedWorker(renamed.owners.claude_owner, 'edit_worker');
  assert.equal(unlisted.workers.includes('edit_worker'), false);
  assert.equal(unlisted.worker_weights, undefined);
  assert.doesNotThrow(() => structuredClone(unlisted));
  const removed = removeRole(config, 'workers', 'opencode_worker');
  assert.equal(removed.workers.opencode_worker, undefined);
  assert.equal(removed.owners.claude_owner.worker_weights, undefined);
  const pinned = renameEngine(config, 'opencode', 'oc');
  assert.equal(pinned.owners.claude_owner.only_engine, 'oc');
  assert.equal(pinned.workers.opencode_worker?.engine, 'oc');
  const dropped = removeEngine(pinned, 'oc');
  assert.equal(dropped.engines.oc, undefined);
  assert.equal(Object.hasOwn(dropped.owners.claude_owner, 'only_engine'), false);
  assert.equal(workerWeight(dropped.owners.claude_owner, 'claude_worker'), 100);
  assert.equal(withWorkerWeight(config.owners.claude_owner, 'opencode_worker', 100).worker_weights, undefined);
});
