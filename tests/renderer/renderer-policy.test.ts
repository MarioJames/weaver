import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfig, validateConfig } from '../../src/main/policy/routing';
import { appendWorker, removeRole, renameRole, reorderRoles, roleDeleteImpact, roleIdError, syncRoleEditor, withWorkerWeight, withoutListedWorker, workerWeight } from '../../src/renderer/policy/policy-edit';


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
test('reordering rebuilds only the chosen section and leaves records, references and weights intact', () => {
  const config = defaultConfig();
  config.owners.claude_owner = withWorkerWeight(config.owners.claude_owner, 'opencode_worker', 7);
  const workerOrder = Object.keys(config.workers);
  const owners = structuredClone(config.owners);
  const reorderedWorkers = reorderRoles(config, 'workers', [...workerOrder].reverse());
  assert.deepEqual(Object.keys(reorderedWorkers.workers), [...workerOrder].reverse());
  assert.notEqual(reorderedWorkers.workers, config.workers);
  assert.equal(reorderedWorkers.workers.opencode_worker, config.workers.opencode_worker);
  assert.equal(reorderedWorkers.owners, config.owners);
  assert.deepEqual(reorderedWorkers.owners, owners);

  const ownerOrder = Object.keys(config.owners);
  const workers = structuredClone(config.workers);
  const reorderedOwners = reorderRoles(config, 'owners', [...ownerOrder].reverse());
  assert.deepEqual(Object.keys(reorderedOwners.owners), [...ownerOrder].reverse());
  assert.notEqual(reorderedOwners.owners, config.owners);
  assert.equal(reorderedOwners.owners.claude_owner, config.owners.claude_owner);
  assert.equal(reorderedOwners.workers, config.workers);
  assert.deepEqual(reorderedOwners.workers, workers);
  assert.deepEqual(reorderedOwners.owners.claude_owner.worker_weights, { opencode_worker: 7 });
});

test('reordering ignores unknown and repeated ids and keeps every omitted record', () => {
  const config = defaultConfig();
  const ids = Object.keys(config.workers);
  const next = reorderRoles(config, 'workers', [ids[2]!, 'missing', ids[2]!]);
  assert.deepEqual(Object.keys(next.workers), [ids[2], ...ids.filter(id => id !== ids[2])]);
  assert.deepEqual(Object.keys(next.workers).sort(), [...ids].sort());
  assert.deepEqual(reorderRoles(config, 'owners', []).owners, config.owners);
  assert.deepEqual(Object.keys(reorderRoles(config, 'owners', ['missing']).owners), Object.keys(config.owners));
});

test('the role id editor and the saved schema accept the same suffix-free ids', () => {
  const config = defaultConfig();
  const withWorker = (id: string) => {
    const next = structuredClone(config);
    next.workers[id] = { ...next.workers.claude_worker! };
    return next;
  };
  for (const id of ['research', 'codex', 'research_worker', 'a'.repeat(40)]) {
    assert.equal(roleIdError('workers', id, config), '', id);
    assert.equal(roleIdError('owners', id, config), '', id);
    assert.deepEqual(validateConfig(withWorker(id)), [], id);
  }
  for (const id of ['Research', 'research-worker', '9research', '_research', 'a'.repeat(41)]) {
    assert.notEqual(roleIdError('workers', id, config), '', id);
    assert.notEqual(roleIdError('owners', id, config), '', id);
    assert.ok(validateConfig(withWorker(id)).length > 0, id);
  }
  assert.equal(roleIdError('workers', 'claude_worker', config), '这个 ID 已经存在');
  assert.equal(roleIdError('workers', 'claude_worker', config, 'claude_worker'), '');
  assert.equal(roleIdError('owners', 'claude_owner', config), '这个 ID 已经存在');
  assert.equal(roleIdError('owners', 'claude_owner', config, 'claude_owner'), '');
});

test('renaming a worker to a suffix-free id updates every reference and still validates', () => {
  const config = defaultConfig();
  config.owners.claude_owner = withWorkerWeight(config.owners.claude_owner, 'opencode_worker', 7);
  const renamed = renameRole(config, 'workers', 'opencode_worker', 'research');
  assert.ok(renamed.workers.research);
  assert.equal(Object.hasOwn(renamed.workers, 'opencode_worker'), false);
  assert.equal(renamed.owners.claude_owner.workers.includes('research'), true);
  assert.equal(renamed.owners.claude_owner.worker_weights?.research, 7);
  assert.equal(Object.hasOwn(renamed.owners.claude_owner.worker_weights ?? {}, 'opencode_worker'), false);
  assert.deepEqual(validateConfig(renamed), []);
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
  assert.equal(workerWeight(removed.owners.claude_owner, 'claude_worker'), 5);
  assert.equal(withWorkerWeight(config.owners.claude_owner, 'opencode_worker', 5).worker_weights, undefined);
});

test('a role list item only notes states its enable switch does not already show', async () => {
  const { roleNote } = await import('../../src/renderer/features/roles/RolesPage');
  assert.equal(roleNote({ status: 'available' }, false), undefined);
  assert.equal(roleNote({ status: 'disabled' }, false), undefined);
  assert.deepEqual(roleNote({ status: 'channel_disabled', channel: 'default_claude' }, false), { text: '渠道未启用' });
  assert.equal(roleNote({ status: 'blocked', reason: '额度耗尽' }, false)?.warning, true);
  assert.match(roleNote({ status: 'blocked', reason: '额度耗尽' }, false)!.text, /额度耗尽/);
  assert.deepEqual(roleNote(undefined, true), { text: '尚未保存', warning: true });
  assert.deepEqual(roleNote({ status: 'available' }, true), { text: '有未保存的修改', warning: true });
});
