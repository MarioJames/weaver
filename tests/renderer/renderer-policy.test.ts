import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfig, validateConfig } from '../../src/main/policy/routing';
import { appendWorker, deleteRole, removeRole, renameRole, reorderRoles, roleDeleteImpact, roleIdError, syncRoleEditor, withWorkerWeight, withoutListedWorker, workerWeight } from '../../src/renderer/policy/policy-edit';
import type { PolicyDraft, PolicyUpdate } from '../../src/renderer/policy/usePolicyDraft';

test('confirmed saved deletion commits only removal and reference cleanup, preserving unrelated draft edits', async () => {
  const saved = defaultConfig();
  saved.workers.opencode_worker!.enabled = false;
  saved.owners.claude_owner = withWorkerWeight(saved.owners.claude_owner, 'opencode_worker', 7);
  let draft = structuredClone(saved);
  draft.workers.claude_worker!.model = 'unsaved-model';
  draft.workers.claude_worker!.channels = ['default_claude', 'second_claude', 'third_claude'];
  draft.owners.claude_owner.max_parallel = 42;
  let update: PolicyUpdate | undefined;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let done = false;
  const deletion = deleteRole({ config: draft, snapshot: { config: saved } as PolicyDraft['snapshot'],
    setConfig: () => assert.fail('saved deletion must use commit'),
    commit: async change => { update = change; await pending; },
  }, 'workers', 'opencode_worker').then(() => { done = true; });
  assert.ok(update, 'confirmation immediately requests persistence');
  assert.ok(draft.workers.opencode_worker, 'pending save keeps the role visible');
  assert.equal(done, false);
  const next = update({ config: structuredClone(saved), blocks: [] }).config;
  const expected = structuredClone(saved);
  delete expected.workers.opencode_worker;
  expected.owners.claude_owner.workers = expected.owners.claude_owner.workers.filter(id => id !== 'opencode_worker');
  expected.owners.codex_owner.workers = expected.owners.codex_owner.workers.filter(id => id !== 'opencode_worker');
  delete expected.owners.claude_owner.worker_weights;
  assert.deepEqual(next, expected, 'no other draft edits enter the saved policy');
  draft = update({ config: draft, blocks: [] }).config;
  assert.equal(draft.workers.opencode_worker, undefined);
  assert.equal(draft.workers.claude_worker!.model, 'unsaved-model');
  assert.deepEqual(draft.workers.claude_worker!.channels, ['default_claude', 'second_claude', 'third_claude']);
  assert.equal(draft.owners.claude_owner.max_parallel, 42);
  assert.equal(draft.owners.claude_owner.worker_weights, undefined);
  finish();
  await deletion;
});

test('failed saved deletion leaves the draft intact and can be retried', async () => {
  const config = defaultConfig();
  const before = structuredClone(config);
  let calls = 0;
  const policy = { config, snapshot: { config } as PolicyDraft['snapshot'], setConfig: () => assert.fail('must not change draft before success'),
    commit: async () => { if (++calls === 1) throw new Error('save failed'); },
  };
  await assert.rejects(deleteRole(policy, 'owners', 'claude_owner'), /save failed/);
  assert.deepEqual(config, before);
  await deleteRole(policy, 'owners', 'claude_owner');
  assert.equal(calls, 2);
});

test('saved parent deletion preserves workers and blocks and never submits other parent edits', async () => {
  const saved = defaultConfig();
  const draft = structuredClone(saved);
  draft.owners.codex_owner.model = 'unsaved-model';
  let committed = false;
  await deleteRole({ config: draft, snapshot: { config: saved } as PolicyDraft['snapshot'],
    setConfig: () => assert.fail('must commit saved parent deletion'),
    commit: async update => {
      committed = true;
      const blocks = [{ engine: 'claude', reason: 'pause', since: '2026-10-25T00:00:00Z', by: 'manual' as const }];
      const next = update({ config: saved, blocks });
      assert.equal(next.config.owners.claude_owner, undefined);
      assert.deepEqual(next.config.owners.codex_owner, saved.owners.codex_owner);
      assert.deepEqual(next.config.workers, saved.workers);
      assert.equal(next.blocks, blocks);
      assert.equal(update({ config: draft, blocks }).config.owners.codex_owner.model, 'unsaved-model');
    },
  }, 'owners', 'claude_owner');
  assert.equal(committed, true);
});

test('new unsaved role deletion is local; unsaved renames including reused saved IDs cannot delete saved roles', async () => {
  const saved = defaultConfig();
  let config = structuredClone(saved);
  config.workers.new = { ...config.workers.claude_worker! };
  const policy = () => ({ config, snapshot: { config: saved } as PolicyDraft['snapshot'],
    setConfig: (next: Parameters<PolicyDraft['setConfig']>[0]) => { config = (typeof next === 'function' ? next(config) : next)!; },
    commit: async () => assert.fail('must not write saved policy'),
  });
  await deleteRole(policy(), 'workers', 'new');
  assert.deepEqual(config, saved);
  config = renameRole(config, 'workers', 'claude_worker', 'renamed');
  await assert.rejects(deleteRole(policy(), 'workers', 'renamed'), /改名/);
  config = renameRole(config, 'workers', 'codex_worker', 'claude_worker');
  await assert.rejects(deleteRole(policy(), 'workers', 'claude_worker'), /改名/);
  assert.ok(config.workers.claude_worker);
});


test('role id editor follows the visible record', () => {
  assert.deepEqual(syncRoleEditor(['codex_worker'], 'claude_owner'), { selected: 'codex_worker', pendingId: 'codex_worker' });
  assert.deepEqual(syncRoleEditor(['codex_owner'], ''), { selected: 'codex_owner', pendingId: 'codex_owner' });
  assert.deepEqual(syncRoleEditor([], 'claude_owner'), { selected: '', pendingId: '' });
});

test('deleting a worker names the owners that reference it', () => {
  const impact = roleDeleteImpact(defaultConfig(), 'workers', 'claude_worker');
  assert.match(impact.title, /claude_worker/);
  assert.match(impact.detail, /claude_owner/);
  assert.match(impact.detail, /立即保存删除/);
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
  const { roleNote } = await import('../../src/renderer/features/roles/roles-view');
  assert.equal(roleNote({ status: 'available' }, false), undefined);
  assert.equal(roleNote({ status: 'disabled' }, false), undefined);
  assert.deepEqual(roleNote({ status: 'channel_disabled', channel: 'default_claude' }, false), { text: '渠道未启用' });
  assert.equal(roleNote({ status: 'blocked', reason: '额度耗尽' }, false)?.warning, true);
  assert.match(roleNote({ status: 'blocked', reason: '额度耗尽' }, false)!.text, /额度耗尽/);
  assert.deepEqual(roleNote(undefined, true), { text: '尚未保存', warning: true });
  assert.deepEqual(roleNote({ status: 'available' }, true), { text: '有未保存的修改', warning: true });
});

test('official pools retain all members through role edits and policy validation, with clear unsupported pool errors', async () => {
  const { workerChannelsError } = await import('../../src/renderer/policy/policy-edit');
  const config = defaultConfig();
  config.channels.second = { ...config.channels.default_codex, enabled: false };
  config.channels.third = { ...config.channels.default_codex };
  config.workers.codex_worker = { ...config.workers.codex_worker, channels: ['default_codex', 'second', 'third'] };
  const renamed = renameRole(config, 'workers', 'codex_worker', 'pool');
  const ordered = reorderRoles(renamed, 'workers', ['pool']);
  assert.deepEqual(ordered.workers.pool.channels, ['default_codex', 'second', 'third']);
  assert.deepEqual(validateConfig(ordered), []);
  assert.equal(workerChannelsError(ordered, ordered.workers.pool), '');
  assert.match(workerChannelsError(ordered, { ...ordered.workers.pool, free_channel: true }), /免费渠道/);
  ordered.channels.second.kind = 'api';
  assert.match(workerChannelsError(ordered, ordered.workers.pool), /API/);
  ordered.channels.second = { ...ordered.channels.default_claude };
  assert.match(workerChannelsError(ordered, ordered.workers.pool), /同一个执行引擎 ID/);
  assert.equal(typeof ordered.owners.codex_owner.channel, 'string');
});

test('the real role form renders every selected member while the parent keeps a single account', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ConfigProvider, ThemeProvider } = await import('@lobehub/ui');
  const { motion } = await import('motion/react');
  const { RolesPage } = await import('../../src/renderer/features/roles/RolesPage');
  const config = defaultConfig();
  config.channels.second = { ...config.channels.default_codex, label: 'Second account', enabled: false };
  config.channels.third = { ...config.channels.default_codex, label: 'Third account' };
  config.workers = { pool: { ...config.workers.codex_worker, channels: ['default_codex', 'second', 'third'] } };
  config.owners = { parent: { ...config.owners.codex_owner, workers: ['pool'] } };
  const policy = { config, blocks: [], snapshot: { config, blocks: [], revision: 1, workers: {}, owners: {} }, issues: [], dirty: true } as unknown as PolicyDraft;
  const render = (section: 'workers' | 'owners') => renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: React.createElement(RolesPage, { section, policy }) }) }));
  const worker = render('workers');
  assert.match(worker, /Second account/);
  assert.match(worker, /Third account/);
  assert.match(worker, /用于查看模型和连通测试的账号/);
  assert.match(worker, /选择一个成员账号/);
  const parent = render('owners');
  assert.doesNotMatch(parent, /用于查看模型和连通测试的账号/);
  assert.match(parent, /选择父 Agent 使用的一个账号/);
  assert.deepEqual(config.workers.pool.channels, ['default_codex', 'second', 'third']);

  config.workers.pool.channels = [];
  const empty = render('workers');
  assert.match(empty, /aria-invalid="true"/);
  assert.match(empty, /id="[^"]+-channel-error"[^>]*role="alert"|role="alert"[^>]*id="[^"]+-channel-error"/);
  assert.match(empty, /请至少选择一个账号或渠道/);
  assert.match(empty, /title="子 Agent pool：请至少选择一个账号或渠道"/);
  const saveButton = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.endsWith('保存</button>'));
  assert.match(saveButton(empty) ?? '', / disabled/);
  assert.match(render('owners'), /title="子 Agent pool：请至少选择一个账号或渠道"/, 'a hidden empty worker still blocks saving from the parent editor');

  config.workers.pool.channels = ['default_codex'];
  const restored = render('workers');
  assert.doesNotMatch(restored, /aria-invalid="true"|id="[^"]+-channel-error"|子 Agent pool：请至少选择一个账号或渠道/);
  const save = saveButton(restored);
  assert.ok(save);
  assert.doesNotMatch(save, /disabled/);
});
