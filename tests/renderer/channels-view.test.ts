import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNEL_CONFIG_MAX_BYTES } from '../../src/shared/contracts/channels';
import type { ChannelsSnapshot } from '../../src/shared/contracts/channels';
import type { EngineQuotaRecord, QuotaWindow } from '../../src/shared/contracts/quota';
import { blankOwner, blankWorker } from '../../src/renderer/policy/policy-edit';
import { defaultConfig } from '../../src/main/policy/routing';
import { channelContentError, channelDraftCanSave, channelDraftDirty, channelDraftFor, channelImportInput, channelImportNotice, channelMetrics, channelQuota, channelQuotaHeadline, channelReferences, channelSaveInput, channelUsers, directApiAllowed, mergeChannelPolicy, subscriptionAllowed } from '../../src/renderer/features/channels/channels-view';

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
  const users = channelUsers(config, config.workers.codex_worker.channels[0]!);
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


test('new roles start with every required choice empty', () => {
  const config = defaultConfig();
  assert.deepEqual(blankOwner(config), { enabled: false, channel: '', model: '', effort: '', workers: [], max_parallel: 1 });
  assert.deepEqual(blankWorker(config), { enabled: false, channels: [], model: '', effort: '', description: '' });
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

test('official creation sends only account metadata even when API editor state is stale', () => {
  const channel = { label: '工作订阅', engine: 'codex', kind: 'subscription' as const, enabled: true, provider: 'old-provider', baseUrl: 'https://old.example', protocol: 'openai' as const };
  assert.deepEqual(channelSaveInput(9, undefined, channel, 'stale-private-key', 'stale-config', true), {
    revision: 9, channel: { label: '工作订阅', engine: 'codex', kind: 'subscription', enabled: true },
  });
});

test('only catalogued official engines can be offered for subscription login', () => {
  assert.equal(subscriptionAllowed('custom-executable'), false);
  assert.equal(subscriptionAllowed(''), false);
  assert.equal(subscriptionAllowed('qodercli'), true);
});

test('import receipts distinguish added, existing, updated, empty sources and partial failure', () => {
  const result = { added: 2, existing: 3, updated: 1, notFound: ['grok'], failures: [{ engine: 'codex', message: '来源不可读取' }] };
  const text = channelImportNotice(result);
  assert.match(text, /新增 2、已有 3、更新 1/);
  assert.match(text, /未发现可导入配置：grok/);
  assert.match(text, /codex：来源不可读取/);
  assert.match(text, /修正来源.*重试/);
  assert.match(channelImportNotice({ added: 0, existing: 0, updated: 0, notFound: ['claude'], failures: [] }), /未发现可导入项/);
  assert.doesNotMatch(channelImportNotice({ ...result, failures: [] }), /部分引擎导入失败/);
});

test('disabled roles and every pool member remain channel references and survive draft rebase', () => {
  const base = defaultConfig();
  const draft = structuredClone(base);
  draft.channels.second = { ...draft.channels.default_codex, label: '第二账号', enabled: false };
  draft.channels.third = { ...draft.channels.default_codex, label: '第三账号' };
  draft.workers.codex_worker = { ...draft.workers.codex_worker, enabled: false, channels: ['default_codex', 'second', 'third'] };
  assert.ok(channelUsers(draft, 'second').includes('子 Agent codex_worker'));
  assert.ok(channelUsers(draft, 'third').includes('子 Agent codex_worker'));
  const next = structuredClone(base);
  next.channels.default_codex.label = '已更新';
  const merged = mergeChannelPolicy(draft, base, next);
  assert.deepEqual(merged.workers.codex_worker.channels, ['default_codex', 'second', 'third']);
  assert.equal(merged.channels.second.enabled, false);
});


const NOW = Date.parse('2026-10-26T12:00:00Z');
const iso = (offset: number) => new Date(NOW + offset).toISOString();
function usageWindow(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return { id: 'week', label: '7 天额度', scope: 'account', model: null, usedPercent: 20, remainingPercent: 80, resetsAt: iso(86_400_000), durationMinutes: 10_080, used: null, total: null, remaining: null, unit: 'percent', ...overrides };
}
function record(overrides: Partial<EngineQuotaRecord> = {}): EngineQuotaRecord {
  return { engine: 'claude', status: 'available', source: 'fixture', checkedAt: iso(-1_000), observedAt: iso(-1_000), stale: false, windows: [usageWindow()], detail: '', retryAt: null, ...overrides };
}
function snapshot(config = defaultConfig(), configurations: ChannelsSnapshot['configurations'] = {}): ChannelsSnapshot {
  return { policy: { revision: 1, config, blocks: [], activeBlocks: [], owners: {}, workers: {}, execution: 'disabled' }, configurations };
}

test('four metrics count kinds, enabled channels and only fresh available subscriptions', () => {
  const config = defaultConfig();
  const fresh = record({ channel: 'default_claude' });
  const stale = record({ channel: 'default_codex', engine: 'codex', observedAt: iso(-300_000), checkedAt: iso(-300_000) });
  const exhausted = record({ channel: 'default_qoder', engine: 'grok', status: 'exhausted', windows: [usageWindow({ usedPercent: 100 })] });
  const metrics = channelMetrics(config, snapshot(config, {
    default_claude: { hasCredentials: true, hasApiKey: false, hasConfig: false, quota: fresh },
    default_codex: { hasCredentials: true, hasApiKey: false, hasConfig: false, quota: stale },
    default_grok: { hasCredentials: false, hasApiKey: false, hasConfig: false },
    default_opencode: { hasCredentials: true, hasApiKey: false, hasConfig: false },
    default_qoder: { hasCredentials: true, hasApiKey: false, hasConfig: false, quota: exhausted },
  }), NOW);
  assert.deepEqual(metrics.total, { value: '7', hint: '启用 7' });
  assert.deepEqual(metrics.subscriptions, { value: '5', hint: '启用 5' });
  assert.deepEqual(metrics.api, { value: '2', hint: '启用 2' });
  assert.equal(metrics.quota.value, '1 / 5');
  assert.equal(metrics.quota.hint, '未登录 1');
  assert.equal(metrics.quota.tone, undefined);
  const none = channelMetrics(config, snapshot(config, {
    default_claude: { hasCredentials: true, hasApiKey: false, hasConfig: false, quota: { ...fresh, observedAt: iso(-300_000), checkedAt: iso(-300_000) } },
  }), NOW);
  assert.equal(none.quota.value, '0 / 5');
  assert.equal(none.quota.tone, 'warning');
});

test('a row headline names the state or the tightest measured window instead of relying on color', () => {
  const config = defaultConfig();
  const channel = config.channels.default_claude;
  assert.equal(channelQuotaHeadline('default_pi', config.channels.default_pi, undefined).text, '无官方订阅额度');
  assert.deepEqual(channelQuotaHeadline('default_claude', channel, { hasCredentials: false, hasApiKey: false, hasConfig: false }, NOW), { text: '未登录', tone: 'warning' });
  const tightest = record({ channel: 'default_claude', windows: [
    usageWindow({ id: 'session', label: '5 小时额度', usedPercent: 22, durationMinutes: 300 }),
    usageWindow({ id: 'week', label: '7 天额度', usedPercent: 40, durationMinutes: 10_080 }),
  ] });
  assert.equal(channelQuotaHeadline('default_claude', channel, { hasCredentials: true, hasApiKey: false, hasConfig: false, quota: tightest }, NOW).text, '7 天 已用 40%');
  assert.match(channelQuotaHeadline('default_claude', channel, { hasCredentials: true, hasApiKey: false, hasConfig: false, quota: { ...tightest, observedAt: iso(-300_000), checkedAt: iso(-300_000) } }, NOW).text, /^上次观测 · 7 天 已用 40%$/);
  assert.deepEqual(channelQuotaHeadline('default_claude', channel, { hasCredentials: true, hasApiKey: false, hasConfig: false, quota: record({ channel: 'default_claude', status: 'error', windows: [] }) }, NOW), { text: '额度查询失败', tone: 'danger' });
  assert.deepEqual(channelQuotaHeadline('default_claude', channel, { hasCredentials: true, hasApiKey: false, hasConfig: false, quota: record({ channel: 'default_claude', status: 'exhausted', windows: [] }) }, NOW), { text: '额度耗尽', tone: 'warning' });
});

test('references split owners and workers for links; channelUsers keeps the old display contract', () => {
  const config = defaultConfig();
  assert.deepEqual(channelReferences(config, 'default_claude'), { owners: ['claude_owner'], workers: ['claude_worker'] });
  config.channels.unused = { label: '未使用', engine: 'codex', kind: 'api', enabled: false };
  assert.deepEqual(channelReferences(config, 'unused'), { owners: [], workers: [] });
  assert.ok(channelUsers(config, 'default_claude').includes('父 Agent claude_owner'));
  assert.ok(channelUsers(config, 'default_claude').includes('子 Agent claude_worker'));
});

test('an in-page draft stays clean at rest and validates the fields the save bar depends on', () => {
  const base = { label: '团队 API', engine: 'codex', kind: 'api' as const, enabled: true, provider: 'openai' };
  const draft = channelDraftFor(base, 'team');
  assert.equal(channelDraftDirty(draft), false);
  assert.equal(channelDraftDirty({ ...draft, channel: { ...draft.channel, label: '改名' } }), true);
  assert.equal(channelDraftDirty({ ...draft, apiKey: 'sk-test' }), true);
  assert.equal(channelDraftDirty({ ...draft, uploadError: '无法读取文件' }), true);
  assert.equal(channelDraftCanSave(draft, false, ['codex'], 'codex'), true);
  assert.equal(channelDraftCanSave({ ...draft, channel: { ...draft.channel, provider: '' } }, false, ['codex'], 'codex'), false);
  assert.equal(channelDraftCanSave({ ...draft, apiKey: 'x'.repeat(CHANNEL_CONFIG_MAX_BYTES + 1) }, false, ['codex'], 'codex'), false);
  const subscription = channelDraftFor({ label: '订阅', engine: 'codex', kind: 'subscription', enabled: true });
  assert.equal(channelDraftCanSave(subscription, false, ['codex'], 'codex'), true);
  assert.equal(channelDraftCanSave(subscription, false, [], 'codex'), false);
});
