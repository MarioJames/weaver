import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfig } from '../src/main/policy/routing';
import { appendWorker, removeRole, renameRole, roleDeleteImpact, syncRoleEditor, withWorkerWeight, withoutListedWorker, workerWeight } from '../src/renderer/policy-edit';


test('role id editor follows the visible record', () => {
  assert.deepEqual(syncRoleEditor(['codex_worker'], 'claude_owner'), { selected: 'codex_worker', pendingId: 'codex_worker' });
  assert.deepEqual(syncRoleEditor(['codex_owner'], ''), { selected: 'codex_owner', pendingId: 'codex_owner' });
  assert.deepEqual(syncRoleEditor([], 'claude_owner'), { selected: '', pendingId: '' });
});

test('deleting a worker names the owners that reference it', () => {
  const impact = roleDeleteImpact(defaultConfig(), 'workers', 'claude_worker');
  assert.match(impact.title, /claude_worker/);
  assert.match(impact.detail, /claude_owner/);
  assert.match(roleDeleteImpact(defaultConfig(), 'owners', 'codex_owner').detail, /取消不改草稿/);
});

test('adding a worker ignores a candidate that is stale or already listed', () => {
  assert.deepEqual(appendWorker(['claude_worker'], ['opencode_worker'], 'opencode_worker'), ['claude_worker', 'opencode_worker']);
  assert.equal(appendWorker(['claude_worker'], ['opencode_worker'], 'claude_worker'), undefined);
  assert.equal(appendWorker(['claude_worker'], ['opencode_worker'], 'grok_worker'), undefined);
  assert.equal(appendWorker(['claude_worker'], [], undefined), undefined);
});
test('renaming or removing a worker keeps weight keys saveable', () => {
  const config = defaultConfig();
  config.owners.claude_owner = withWorkerWeight(config.owners.claude_owner, 'opencode_worker', 20);
  const renamed = renameRole(config, 'workers', 'opencode_worker', 'edit_worker');
  assert.equal(renamed.owners.claude_owner.workers.includes('edit_worker'), true);
  assert.equal(renamed.owners.claude_owner.worker_weights?.edit_worker, 20);
  assert.equal(Object.hasOwn(renamed.owners.claude_owner.worker_weights ?? {}, 'opencode_worker'), false);
  const unlisted = withoutListedWorker(renamed.owners.claude_owner, 'edit_worker');
  assert.equal(unlisted.workers.includes('edit_worker'), false);
  assert.equal(unlisted.worker_weights, undefined);
  const removed = removeRole(config, 'workers', 'opencode_worker');
  assert.equal(removed.workers.opencode_worker, undefined);
  assert.equal(removed.owners.claude_owner.worker_weights, undefined);
  assert.equal(workerWeight(removed.owners.claude_owner, 'claude_worker'), 100);
  assert.equal(withWorkerWeight(config.owners.claude_owner, 'opencode_worker', 100).worker_weights, undefined);
});

test('a role list item only notes states its enable switch does not already show', async () => {
  const { roleNote } = await import('../src/renderer/pages/RolesPage');
  assert.equal(roleNote({ status: 'available' }, false), undefined);
  assert.equal(roleNote({ status: 'disabled' }, false), undefined);
  assert.deepEqual(roleNote({ status: 'engine_disabled' }, false), { text: '引擎未启用' });
  assert.equal(roleNote({ status: 'blocked', reason: '额度耗尽' }, false)?.warning, true);
  assert.match(roleNote({ status: 'blocked', reason: '额度耗尽' }, false)!.text, /额度耗尽/);
  assert.deepEqual(roleNote(undefined, true), { text: '尚未保存', warning: true });
  assert.deepEqual(roleNote({ status: 'available' }, true), { text: '有未保存的修改', warning: true });
});
