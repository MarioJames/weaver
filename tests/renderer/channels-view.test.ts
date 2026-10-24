import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNEL_CONFIG_MAX_BYTES } from '../../src/shared/contracts/channels';
import { blankOwner, blankWorker } from '../../src/renderer/policy/policy-edit';
import { defaultConfig } from '../../src/main/policy/routing';
import { channelContentError, channelImportInput, channelQuota, channelSaveInput, channelUsers, directApiAllowed, mergeChannelPolicy, subscriptionAllowed } from '../../src/renderer/features/channels/channels-view';

test('channel edit preserves secrets and native config unless explicitly replaced', () => {
  const channel = { label: '私有渠道', engine: 'codex', kind: 'api' as const, enabled: true, provider: 'example' };
  const saved = channelSaveInput(5, 'existing', channel, '', '', false);
  assert.deepEqual(saved, { revision: 5, id: 'existing', channel });
  const cleared = channelSaveInput(5, 'existing', channel, 'new-key', '', true);
  assert.equal(cleared.config, '');
  assert.equal(cleared.apiKey, 'new-key');
  assert.equal(channelSaveInput(5, undefined, channel, '', '', false).id, undefined);
});

test('channel update rebases a role draft without losing an unrelated channel edit', () => {
  const base = defaultConfig();
  const next = structuredClone(base);
  next.channels.default_codex.label = '已保存名称';
  const draft = structuredClone(base);
  draft.workers.codex_worker.model = 'unsaved-model';
  draft.channels.default_opencode.label = '其他渠道草稿';
  const merged = mergeChannelPolicy(draft, base, next);
  assert.equal(merged.workers.codex_worker.model, 'unsaved-model');
  assert.equal(merged.channels.default_codex.label, '已保存名称');
  assert.equal(merged.channels.default_opencode.label, '其他渠道草稿');
});

test('channel references name all users and API-only tools reject subscription creation', () => {
  const config = defaultConfig();
  const users = channelUsers(config, config.workers.codex_worker.channel);
  assert.ok(users.includes('子 Agent codex_worker'));
  assert.ok(users.includes('父 Agent codex_owner'));
  assert.equal(subscriptionAllowed('pi'), false);
  assert.equal(subscriptionAllowed('dsh'), false);
  assert.equal(subscriptionAllowed('codex'), true);
});


test('quota displays only for the exact subscription channel, never for API or another account', () => {
  const channel = { label: '订阅', engine: 'codex', kind: 'subscription' as const, enabled: true };
  const quota = { channel: 'account-a', engine: 'codex' as const, status: 'available' as const, statusBasis: undefined, source: 'fixture', checkedAt: null, observedAt: null, stale: false, windows: [], detail: '', retryAt: null };
  const configuration = { hasApiKey: false, hasConfig: false, hasCredentials: true, quota };
  assert.equal(channelQuota('account-a', channel, configuration), quota);
  assert.equal(channelQuota('account-b', channel, configuration), undefined);
  assert.equal(channelQuota('account-a', { ...channel, kind: 'api' }, configuration), undefined);
  assert.equal(channelQuota('account-a', channel, { ...configuration, quota: { ...quota, channel: undefined } }), undefined);
});


test('new roles select an enabled channel on an enabled tool instead of the first engine', () => {
  const config = defaultConfig();
  for (const channel of Object.values(config.channels)) channel.enabled = false;
  config.engines.codex.enabled = true;
  config.channels.work_account = { engine: 'codex', label: '工作账号', kind: 'subscription', enabled: true };
  assert.equal(blankOwner(config).channel, 'work_account');
  assert.equal(blankWorker(config).channel, 'work_account');
});


test('Qoder BYOK can only enter through native import instead of a generic API form', () => {
  assert.equal(directApiAllowed('qodercli'), false);
  assert.equal(directApiAllowed('qoder'), false);
  assert.equal(directApiAllowed('codex'), true);
  assert.equal(directApiAllowed('dsh'), true);
});


test('native import keeps managed auth by default and replaces it only when explicitly selected', () => {
  assert.deepEqual(channelImportInput(8, 'all', '', false), { revision: 8 });
  assert.deepEqual(channelImportInput(8, 'codex', ' /private/source ', true), { revision: 8, engine: 'codex', sourceDir: '/private/source', replaceExisting: true });
  assert.deepEqual(channelImportInput(8, 'codex', '', false), { revision: 8, engine: 'codex' });
});


test('native text and API key guard uses UTF-8 bytes and never repeats secret contents', () => {
  assert.equal(channelContentError('a'.repeat(CHANNEL_CONFIG_MAX_BYTES)), '');
  const secret = '私密'.repeat(Math.floor(CHANNEL_CONFIG_MAX_BYTES / 6) + 1);
  assert.ok(secret.length < CHANNEL_CONFIG_MAX_BYTES);
  const error = channelContentError(secret);
  assert.match(error, /KiB/);
  assert.equal(error.includes(secret), false);
});
