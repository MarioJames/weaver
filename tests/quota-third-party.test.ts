import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QuotaProber } from '../src/main/quota';
import { THIRD_PARTY_DETAIL } from '../src/shared/contracts/quota';
import { codexModelProvider } from '../src/main/quota/third-party';
import type { EngineQuotaRecord } from '../src/shared/contracts/quota';
import { quotaRecoveryText, quotaStatusText } from '../src/renderer/quota-view';

const start = Date.parse('2026-10-18T12:00:00Z');
const reset = '2026-10-19T12:00:00Z';
const jwt = `header.${Buffer.from(JSON.stringify({ exp: start / 1000 + 86400 })).toString('base64url')}.signature`;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function home(t: { after(fn: () => void | Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), 'wq3-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(join(root, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'native-claude-secret', expiresAt: start + 86400000 } }));
  writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt, account_id: 'account-secret' } }));
  const claudeSettings = (env: Record<string, string>) => writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ env }));
  const codexConfig = (text: string) => writeFileSync(join(root, '.codex', 'config.toml'), text);
  return { root, env: { HOME: root }, claudeSettings, codexConfig };
}

const claudeBody = { limits: [{ kind: 'session', group: 'session', percent: 12, resets_at: reset, scope: null }], extra_usage: { is_enabled: false } };

test('Claude switched to another provider through settings.json env reports no native quota and sends no request', async t => {
  const f = home(t);
  f.claudeSettings({ ANTHROPIC_BASE_URL: 'https://relay.example.invalid/api', ANTHROPIC_AUTH_TOKEN: 'relay-secret-token' });
  let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => { calls++; return json(claudeBody); } });
  t.after(() => prober.close());
  const record = (await prober.refresh({ engine: 'claude' })).records.find(r => r.engine === 'claude')!;
  assert.equal(record.status, 'unsupported');
  assert.equal(record.detail, THIRD_PARTY_DETAIL);
  assert.deepEqual(record.windows, []);
  assert.equal(record.retryAt, null, 'no request was made, so there is no cooldown to wait out');
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(record).includes('relay-secret-token'));
});

test('switching Claude back to the official login makes the very next refresh read the native quota again', async t => {
  const f = home(t);
  f.claudeSettings({ ANTHROPIC_AUTH_TOKEN: 'relay-secret-token' });
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => json(claudeBody) });
  t.after(() => prober.close());
  assert.equal((await prober.refresh({ engine: 'claude' })).records[1].status, 'unsupported');
  f.claudeSettings({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const record = (await prober.refresh({ engine: 'claude' })).records[1];
  assert.equal(record.status, 'available');
  assert.equal(record.windows[0].usedPercent, 12);
});

test('cloud-provider flags and an unparsable base URL count as another provider; an unrelated env block does not', async t => {
  for (const [env, expected] of [
    [{ CLAUDE_CODE_USE_BEDROCK: '1' }, 'unsupported'],
    [{ ANTHROPIC_BASE_URL: 'not a url' }, 'unsupported'],
    [{ ANTHROPIC_BASE_URL: 'https://gateway.anthropic.com' }, 'available'],
    [{ CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_AUTH_TOKEN: '' }, 'available'],
  ] as const) {
    const f = home(t);
    f.claudeSettings(env);
    const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => json(claudeBody) });
    t.after(() => prober.close());
    assert.equal((await prober.refresh({ engine: 'claude' })).records[1].status, expected, JSON.stringify(env));
  }
});

test('the Weaver process environment alone does not make Claude third-party', async t => {
  const f = home(t);
  let calls = 0;
  const prober = new QuotaProber({ env: { ...f.env, ANTHROPIC_BASE_URL: 'https://untrusted.invalid', ANTHROPIC_AUTH_TOKEN: 'x' }, now: () => new Date(start), fetch: async () => { calls++; return json(claudeBody); } });
  t.after(() => prober.close());
  assert.equal((await prober.refresh({ engine: 'claude' })).records[1].status, 'available');
  assert.equal(calls, 1);
});

test('Codex with a non-openai model_provider (cc-switch relay) reports no native quota; the built-in provider and table-only entries do not', async t => {
  const cases: Array<[string, string]> = [
    ['model_provider = "custom"\nmodel = "gpt-6.1-sol"\n[model_providers.custom]\nname = "relay"\n', 'unsupported'],
    ["model_provider = 'relay' # cc-switch\n", 'unsupported'],
    ['model_provider = "openai"\n', 'available'],
    ['model = "gpt-6.1-sol"\n[model_providers.custom]\nname = "relay"\nmodel_provider = "ignored"\n', 'available'],
    ['', 'available'],
  ];
  for (const [toml, expected] of cases) {
    const f = home(t);
    f.codexConfig(toml);
    let calls = 0;
    const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => { calls++; return json({ rate_limit: { allowed: true, primary_window: { used_percent: 20, reset_at: Date.parse(reset) / 1000, limit_window_seconds: 18000 } }, credits: { has_credits: false, unlimited: false, balance: '0' } }); } });
    t.after(() => prober.close());
    const record = (await prober.refresh({ engine: 'codex' })).records[0];
    assert.equal(record.status, expected, toml);
    if (expected === 'unsupported') { assert.equal(record.detail, THIRD_PARTY_DETAIL); assert.equal(calls, 0); }
  }
  assert.equal(codexModelProvider('[projects."/x"]\nmodel_provider = "custom"'), undefined);
});

test('Claude authoritative limits with an empty or null scope are account quota, so the refresh yields a known status', async t => {
  for (const scope of [null, { model: null, surface: null }, { surface: null }, undefined]) {
    const f = home(t);
    const limits = [
      { kind: 'session', group: 'session', percent: 29, resets_at: reset, scope, severity: 'normal', is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 36, resets_at: reset, scope, severity: 'normal', is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: reset, scope: { model: { display_name: 'Fable' }, surface: null }, severity: 'normal', is_active: false },
    ];
    const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => json({ limits, extra_usage: { is_enabled: false } }) });
    t.after(() => prober.close());
    const record = (await prober.refresh({ engine: 'claude' })).records[1];
    assert.equal(record.status, 'available', JSON.stringify(scope));
    assert.deepEqual(record.windows.map(w => [w.scope, w.usedPercent]), [['account', 29], ['account', 36], ['model', 0]]);
  }
});

test('a real surface scope or a non-object scope still cannot become account quota', async t => {
  for (const scope of [{ surface: { display_name: 'Claude Design' } }, 'all']) {
    const f = home(t);
    const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => json({ limits: [{ kind: 'session', percent: 29, resets_at: reset, scope }], extra_usage: { is_enabled: false } }) });
    t.after(() => prober.close());
    const record = (await prober.refresh({ engine: 'claude' })).records[1];
    assert.equal(record.status, 'unknown');
    assert.equal(record.windows[0].scope, 'unknown');
  }
});

test('the card words a third-party engine as such rather than as a login problem', () => {
  const record = { engine: 'claude', status: 'unsupported', source: 'claude_oauth_usage', checkedAt: null, observedAt: null, stale: true, windows: [], detail: THIRD_PARTY_DETAIL, retryAt: null } as EngineQuotaRecord;
  assert.equal(quotaStatusText(record), '第三方供应商');
  assert.match(quotaRecoveryText(record), /cc-switch/);
  assert.doesNotMatch(quotaRecoveryText(record), /登录/);
  assert.doesNotMatch(quotaRecoveryText(record), /请先停用/);
});
