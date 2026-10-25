import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QuotaProber } from '../../src/main/quota';
import { QuotaFailure, QuotaRenewalPending, readNativeCredential } from '../../src/main/quota/credentials';
import { normalizeConsoleStatus, normalizeUsage } from '../../src/main/quota/providers';
import type { QuotaEngine } from '../../src/shared/contracts/quota';

const start = Date.parse('2026-10-18T12:00:00Z');
const reset = '2026-10-19T12:00:00Z';
const token = (name: string, exp = start / 1000 + 86400) => `header.${Buffer.from(JSON.stringify({ exp, sub: name })).toString('base64url')}.signature`;
const codexBody = (used = 25, extra: Record<string, unknown> = {}) => ({
  rate_limit: { allowed: used < 100, limit_reached: used >= 100, primary_window: { used_percent: used, reset_at: Date.parse(reset) / 1000, limit_window_seconds: 18000 } },
  credits: { has_credits: false, unlimited: false, balance: '0' }, ...extra,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), 'wq-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root };
  const credential = (engine: QuotaEngine, body?: unknown) => {
    const dir = join(root, engine === 'codex' ? '.codex' : engine === 'claude' ? '.claude' : engine === 'grok' ? '.grok' : join('.local', 'share', 'opencode'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, engine === 'claude' ? '.credentials.json' : 'auth.json');
    const defaults = engine === 'codex' ? { auth_mode: 'chatgpt', tokens: { access_token: token('secret-native'), account_id: 'account-secret', refresh_token: 'never-use' } }
      : engine === 'claude' ? { claudeAiOauth: { accessToken: 'secret-claude', expiresAt: start + 86400000, refreshToken: 'never-use' }, mcpOAuth: { accessToken: 'wrong-mcp-secret' } }
        : engine === 'grok' ? { 'https://auth.x.ai::official-client': { auth_mode: 'oidc', key: 'secret-grok', expires_at: reset, refresh_token: 'never-use' } }
          : { 'opencode-go': { type: 'api', key: 'secret-opencode' } };
    writeFileSync(file, JSON.stringify(body ?? defaults));
    return file;
  };
  return { root, env, credential };
}

/** The same account, past the short-lived access token, with or without the native CLI refresh token. */
const expiredCredential = (engine: QuotaEngine, renewable: boolean) => engine === 'codex'
  ? { auth_mode: 'chatgpt', tokens: { access_token: token('expired-native', start / 1000 - 1), account_id: 'account-secret', ...(renewable ? { refresh_token: 'never-use' } : {}) } }
  : engine === 'claude'
    ? { claudeAiOauth: { accessToken: 'expired-claude', expiresAt: start - 1, ...(renewable ? { refreshToken: 'never-use' } : {}) } }
    : { 'https://auth.x.ai::official-client': { auth_mode: 'oidc', key: 'expired-grok', expires_at: new Date(start - 1).toISOString(), ...(renewable ? { refresh_token: 'never-use' } : {}) } };

test('quota get starts unknown and never reads credentials or requests a provider', async t => {
  const { env } = fixture(t);
  let calls = 0;
  const prober = new QuotaProber({ env, now: () => new Date(start), fetch: async () => { calls++; throw new Error('must not fetch'); } });
  t.after(() => prober.close());
  const snapshot = prober.get();
  assert.deepEqual(snapshot.records.map(r => r.engine), ['codex', 'claude', 'grok', 'opencode']);
  assert.ok(snapshot.records.every(r => r.status === 'unknown' && r.stale && r.checkedAt === null && r.observedAt === null && r.windows.length === 0));
  snapshot.records[0].windows.push({} as never);
  assert.equal(prober.get().records[0].windows.length, 0);
  assert.equal(calls, 0);
});

test('all providers send only the fixed GET with their own native credential and safe projection', async t => {
  const f = fixture(t);
  for (const engine of ['codex', 'claude', 'grok'] as const) f.credential(engine);
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const prober = new QuotaProber({ env: { ...f.env, OPENAI_API_KEY: 'relay-secret', ANTHROPIC_BASE_URL: 'https://untrusted.invalid' }, now: () => new Date(start), fetch: async (url, init) => {
    requests.push({ url: String(url), init: init! });
    if (String(url).includes('chatgpt.com')) return json({ ...codexBody(0), email: 'private@example.com', account_id: 'private-account' });
    if (String(url).includes('anthropic.com')) return json({ five_hour: { utilization: 15, resets_at: reset }, seven_day: null, extra_usage: { is_enabled: false } });
    return json({ config: { creditUsagePercent: 20, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-12T12:00:00Z', end: reset } } });
  } });
  t.after(() => prober.close());
  const result = await prober.refresh({});
  assert.deepEqual(requests.map(r => r.url).sort(), ['https://api.anthropic.com/api/oauth/usage', 'https://chatgpt.com/backend-api/wham/usage', 'https://cli-chat-proxy.grok.com/v1/billing?format=credits']);
  for (const request of requests) {
    assert.equal(request.init.method, 'GET');
    assert.equal(request.init.redirect, 'error');
    assert.equal(request.init.body, undefined);
    const h = new Headers(request.init.headers);
    assert.equal(h.get('Accept'), 'application/json');
    assert.equal(h.get('x-openai-codex-luna-reserve'), null);
    if (request.url.includes('chatgpt.com')) {
      assert.equal(h.get('Authorization'), `Bearer ${token('secret-native')}`);
      assert.equal(h.get('ChatGPT-Account-Id'), 'account-secret');
    } else if (request.url.includes('anthropic.com')) {
      assert.equal(h.get('Authorization'), 'Bearer secret-claude');
      assert.equal(h.get('anthropic-beta'), 'oauth-2025-04-20');
    } else {
      assert.equal(h.get('Authorization'), 'Bearer secret-grok');
      assert.equal(h.get('x-xai-token-auth'), 'xai-grok-cli');
    }
  }
  assert.deepEqual(result.records.map(r => r.engine), ['codex', 'claude', 'grok', 'opencode']);
  assert.ok(result.records.slice(0, 3).every(r => r.status === 'available' && !r.stale));
  assert.equal(result.records[3].status, 'unsupported', 'OpenCode without a Go login never reaches the official endpoint');
  assert.equal(result.records[0].windows[0].usedPercent, 0);
  assert.equal(result.records[0].windows[0].remainingPercent, 100);
  assert.equal(result.records[0].windows[0].durationMinutes, 300);
  assert.doesNotMatch(JSON.stringify(result), /secret|private@|private-account|account-secret|refresh_token|mcpOAuth/);
});

test('API keys, expired native sessions, ambiguous Grok accounts and symlink credentials never leave the process', async t => {
  const f = fixture(t);
  const file = f.credential('codex', { auth_mode: 'apikey', OPENAI_API_KEY: 'relay-secret' });
  f.credential('claude', { claudeAiOauth: { accessToken: 'expired-secret', expiresAt: start - 1 } });
  f.credential('grok', {
    'https://auth.x.ai::a': { auth_mode: 'oidc', key: 'a', expires_at: reset },
    'https://auth.x.ai::b': { auth_mode: 'oidc', key: 'b', expires_at: reset },
  });
  let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => { calls++; return json({}); } });
  t.after(() => prober.close());
  const result = await prober.refresh({});
  assert.equal(result.records[0].status, 'unsupported');
  assert.equal(result.records[1].status, 'unauthenticated');
  assert.equal(result.records[2].status, 'unsupported');
  assert.equal(calls, 0);
  rmSync(file);
  const target = join(f.root, 'external-auth');
  writeFileSync(target, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token('symlink'), account_id: 'a' } }));
  symlinkSync(target, file);
  assert.equal((await prober.refresh({ engine: 'codex' })).records[0].status, 'unsupported');
  assert.equal(calls, 0);
});

test('scoped model pools remain isolated while paid allowances cannot bypass account caps', async t => {
  const f = fixture(t);
  for (const engine of ['codex', 'claude', 'grok'] as const) f.credential(engine);
  const bodies = {
    codex: codexBody(100, { credits: { has_credits: true, unlimited: false, balance: '15' }, additional_rate_limits: [{ limit_name: 'Spark', metered_feature: 'spark', rate_limit: { primary_window: { used_percent: 100 } } }] }),
    claude: { limits: [{ kind: 'weekly_scoped', percent: 100, scope: { model: { id: 'claude-opus' } }, resets_at: reset }], extra_usage: { is_enabled: false } },
    grok: { config: { creditUsagePercent: 100, onDemandCap: { val: 100 }, onDemandUsed: { val: 10 }, prepaidBalance: { val: 0 } } },
  };
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async url => json(String(url).includes('chatgpt.com') ? bodies.codex : String(url).includes('anthropic.com') ? bodies.claude : bodies.grok) });
  t.after(() => prober.close());
  const result = await prober.refresh({});
  assert.equal(result.records[0].status, 'exhausted');
  assert.equal(result.records[1].status, 'unknown');
  assert.equal(result.records[2].status, 'exhausted');
  assert.equal(result.records[0].windows[1].scope, 'model');
  assert.equal(result.records[1].windows[0].scope, 'model');
});

test('explicit account exhaustion blocks regardless of extras; missing numbers never become zero', async t => {
  const f = fixture(t);
  for (const engine of ['codex', 'claude', 'grok'] as const) f.credential(engine);
  let missing = false;
  let now = start;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async url => {
    if (String(url).includes('chatgpt.com')) return json(missing ? { rate_limit: { primary_window: { used_percent: null } } } : codexBody(105));
    if (String(url).includes('anthropic.com')) return json(missing ? { five_hour: { utilization: null }, seven_day: {} } : { five_hour: { utilization: 100, resets_at: reset }, extra_usage: { is_enabled: false } });
    return json(missing ? { config: { isUnifiedBillingUser: true, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-12T00:00:00Z', end: reset } } } : { config: { creditUsagePercent: 100, currentPeriod: { end: reset }, onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 } } });
  } });
  t.after(() => prober.close());
  const first = await prober.refresh({});
  assert.ok(first.records.filter(r => r.engine !== 'opencode').every(r => r.status === 'exhausted'));
  assert.equal(first.records[3].status, 'unsupported');
  assert.equal(first.records[0].windows[0].usedPercent, 105);
  assert.equal(first.records[0].windows[0].remainingPercent, 0);
  now += 60001; missing = true;
  const second = await prober.refresh({});
  assert.ok(second.records.filter(r => r.engine !== 'opencode').every(r => r.status === 'unknown'));
  assert.ok(second.records.every(r => r.windows.every(w => w.usedPercent === null)));
});

test('Claude new authoritative limits preserve scope, do not duplicate legacy windows, and reject invalid resets', async t => {
  const f = fixture(t); f.credential('claude');
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => json({
    five_hour: { utilization: 99, resets_at: reset },
    limits: [{ kind: 'session', percent: 12, resets_at: 'not-a-date' }, { kind: 'weekly_scoped', percent: 31, resets_at: reset, scope: { model: { id: 'claude-opus' } } }],
  }) });
  t.after(() => prober.close());
  const record = (await prober.refresh({ engine: 'claude' })).records[1];
  assert.equal(record.status, 'available');
  assert.equal(record.windows.length, 2);
  assert.equal(record.windows[0].usedPercent, 12);
  assert.equal(record.windows[0].resetsAt, null);
  assert.equal(record.windows[1].model, 'claude-opus');
});

test('provider failures retain only same-credential previous readings as stale, without raw error text', async t => {
  const f = fixture(t); f.credential('codex');
  let now = start; let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => { calls++; if (calls === 1) return json(codexBody()); throw new Error('Authorization Bearer secret-raw private@example.com'); } });
  t.after(() => prober.close());
  await prober.refresh({ engine: 'codex' });
  now += 60001;
  const failed = (await prober.refresh({ engine: 'codex' })).records[0];
  assert.equal(failed.status, 'error'); assert.equal(failed.stale, true);
  assert.equal(failed.windows[0].usedPercent, 25);
  assert.equal(failed.observedAt, new Date(start).toISOString());
  assert.doesNotMatch(JSON.stringify(failed), /secret|Authorization|private@/);
  f.credential('codex', { auth_mode: 'chatgpt', tokens: { access_token: token('different-account'), account_id: 'new-account' } });
  now += 60001;
  assert.equal((await prober.refresh({ engine: 'codex' })).records[0].windows.length, 0);
});

test('in-flight calls coalesce, 60-second cooldown and Retry-After prevent network storms; get ages cache', async t => {
  const f = fixture(t); f.credential('codex');
  let now = start; let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => { calls++; await gate; return calls === 1 ? json(codexBody()) : json({ secret: 'not-returned' }, 429, { 'Retry-After': '180' }); } });
  t.after(() => prober.close());
  const pending = [prober.refresh({ engine: 'codex' }), prober.refresh({ engine: 'codex' })];
  release(); await Promise.all(pending);
  assert.equal(calls, 1);
  await prober.refresh({ engine: 'codex' }); assert.equal(calls, 1);
  now += 60001;
  const limited = (await prober.refresh({ engine: 'codex' })).records[0];
  assert.equal(limited.status, 'error'); assert.equal(limited.stale, true);
  assert.equal(limited.retryAt, new Date(now + 180000).toISOString());
  now += 60001; await prober.refresh({ engine: 'codex' }); assert.equal(calls, 2);
  now = start + 600000; assert.equal(prober.get().records[0].stale, true);
});

test('body and credential byte limits, invalid JSON and HTTP auth errors are bounded safe failures', async t => {
  const f = fixture(t); const file = f.credential('codex');
  let now = start; let mode = 0; let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => {
    calls++;
    if (mode === 0) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } }), { headers: { 'Content-Type': 'application/json' } });
    if (mode === 1) return new Response('{invalid secret', { headers: { 'Content-Type': 'application/json' } });
    return json({ private: 'secret' }, 401);
  } });
  t.after(() => prober.close());
  assert.equal((await prober.refresh({ engine: 'codex' })).records[0].status, 'error');
  now += 60001; mode++;
  assert.equal((await prober.refresh({ engine: 'codex' })).records[0].status, 'error');
  now += 60001; mode++;
  assert.equal((await prober.refresh({ engine: 'codex' })).records[0].status, 'unauthenticated');
  writeFileSync(file, ' '.repeat(256 * 1024 + 1));
  now += 60001;
  assert.equal((await prober.refresh({ engine: 'codex' })).records[0].status, 'unsupported');
  assert.equal(calls, 3);
});

test('close aborts even a transport ignoring AbortSignal and never publishes its late result', async t => {
  const f = fixture(t); f.credential('codex');
  let entered!: () => void; const active = new Promise<void>(resolve => { entered = resolve; });
  let deliver!: (value: Response) => void;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => { entered(); return new Promise<Response>(resolve => { deliver = resolve; }); } });
  const job = prober.refresh({ engine: 'codex' });
  await active; await prober.close();
  await job;
  deliver(json(codexBody()));
  assert.equal(prober.get().records[0].observedAt, null);
  await assert.rejects(() => prober.refresh({}), /关闭/);
});

test('freshness expires after five minutes and past reset windows cannot become new availability', async t => {
  const f = fixture(t); f.credential('codex', { auth_mode: 'chatgpt', tokens: { access_token: token('long-lived', start / 1000 + 3 * 86400), account_id: 'test-account' } });
  let now = start;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => json(codexBody(20)) });
  t.after(() => prober.close());
  await prober.refresh({ engine: 'codex' });
  now += 299999; assert.equal(prober.get().records[0].stale, false);
  now++; assert.equal(prober.get().records[0].stale, true);
  now = Date.parse(reset) + 1;
  const late = (await prober.refresh({ engine: 'codex' })).records[0];
  assert.equal(late.status, 'unknown');
  assert.equal(late.stale, true);
  assert.equal(late.windows[0].usedPercent, 20);
});

test('HTTP-date Retry-After is honored and body deadline cancels a stalled stream', async t => {
  const f = fixture(t); f.credential('codex');
  const next = new Date(start + 180000).toUTCString();
  const limited = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => json({}, 429, { 'Retry-After': next }) });
  t.after(() => limited.close());
  assert.equal((await limited.refresh({ engine: 'codex' })).records[0].retryAt, new Date(next).toISOString());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered!: () => void; const active = new Promise<void>(resolve => { entered = resolve; });
  let cancelled = false;
  const stalled = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); entered(); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'application/json' } }) });
  t.after(() => stalled.close());
  const job = stalled.refresh({ engine: 'codex' });
  await active;
  t.mock.timers.tick(8000);
  const result = (await job).records[0];
  assert.equal(result.status, 'error');
  assert.match(result.detail, /超时/);
  assert.equal(cancelled, true);
});

test('native directory overrides stay local and malformed or non-official sessions are never sent', async t => {
  const f = fixture(t);
  const codexDir = join(f.root, 'alternate-codex'); const claudeDir = join(f.root, 'alternate-claude');
  mkdirSync(codexDir); mkdirSync(claudeDir);
  writeFileSync(join(codexDir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token('override'), account_id: 'override-account' } }));
  writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'override-claude', expiresAt: start + 600000 } }));
  f.credential('grok', { 'https://evil.invalid::client': { auth_mode: 'oidc', key: 'never-send', expires_at: reset } });
  let calls = 0;
  const prober = new QuotaProber({ env: { ...f.env, CODEX_HOME: codexDir, CLAUDE_CONFIG_DIR: claudeDir }, now: () => new Date(start), fetch: async url => { calls++; return String(url).includes('chatgpt.com') ? json(codexBody()) : json({ five_hour: { utilization: 12, resets_at: reset } }); } });
  t.after(() => prober.close());
  const result = await prober.refresh({});
  assert.equal(calls, 2);
  assert.equal(result.records[0].status, 'available'); assert.equal(result.records[1].status, 'available'); assert.equal(result.records[2].status, 'unsupported');
  assert.equal(result.records[3].status, 'unsupported', 'OpenCode without a Go login stays local');
});

test('independent Codex model allowance cannot bypass an account hard cap', async t => {
  const f = fixture(t); f.credential('codex');
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => json(codexBody(100, { additional_rate_limits: [{ metered_feature: 'spark', rate_limit: { allowed: true, primary_window: { used_percent: 10, reset_at: Date.parse(reset) / 1000 } } }] })) });
  t.after(() => prober.close());
  const record = (await prober.refresh({ engine: 'codex' })).records[0];
  assert.equal(record.status, 'exhausted');
  assert.equal(record.windows[0].usedPercent, 100);
  assert.equal(record.windows[1].scope, 'model');
});

test('identity changes during cooldown erase old readings without bypassing the request interval', async t => {
  const f = fixture(t); f.credential('grok');
  let now = start; let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => { calls++; return json({ config: { creditUsagePercent: 14 } }); } });
  t.after(() => prober.close());
  await prober.refresh({ engine: 'grok' });
  now += 1000;
  f.credential('grok', { 'https://auth.x.ai::official-client': { auth_mode: 'oidc', key: 'secret-grok', expires_at: reset, team_id: 'another-team' } });
  const changed = (await prober.refresh({ engine: 'grok' })).records[2];
  assert.equal(calls, 1);
  assert.equal(changed.status, 'unknown'); assert.equal(changed.windows.length, 0);
  assert.equal(changed.observedAt, null); assert.equal(changed.stale, true);
});

test('a partially missing account window cannot clear an earlier whole-account limit', async t => {
  const f = fixture(t); f.credential('codex');
  const body = codexBody(12);
  Object.assign(body.rate_limit, { allowed: undefined, secondary_window: { used_percent: null, reset_at: Date.parse(reset) / 1000 } });
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => json(body) });
  t.after(() => prober.close());
  const record = (await prober.refresh({ engine: 'codex' })).records[0];
  assert.equal(record.status, 'unknown');
  assert.equal(record.windows[0].usedPercent, 12);
  assert.equal(record.windows[1].usedPercent, null);
});

test('Codex rejects mixed ambiguous modes and expired access JWTs without contacting any endpoint', async t => {
  const f = fixture(t);
  f.credential('codex', { OPENAI_API_KEY: 'relay-key', tokens: { access_token: token('old-oauth'), account_id: 'old-account' } });
  let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => { calls++; return json(codexBody()); } });
  t.after(() => prober.close());
  assert.equal((await prober.refresh({ engine: 'codex' })).records[0].status, 'unsupported');
  f.credential('codex', { auth_mode: 'chatgpt', tokens: { access_token: token('expired', start / 1000 - 1), account_id: 'test-account' } });
  assert.equal((await prober.refresh({ engine: 'codex' })).records[0].status, 'unauthenticated');
  assert.equal(calls, 0);
});

test('extra allowance and server permission cannot bypass caps; global restrictions remain independent', async t => {
  const f = fixture(t); f.credential('codex'); f.credential('claude');
  let now = start; let blocked = false;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async url => String(url).includes('chatgpt.com')
    ? json({ ...codexBody(100), rate_limit: { ...codexBody(100).rate_limit, allowed: true, limit_reached: false }, spend_control: { reached: blocked } })
    : json({ five_hour: { utilization: 100, resets_at: reset }, extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 1 } }) });
  t.after(() => prober.close());
  let records = (await prober.refresh({})).records;
  assert.equal(records[0].status, 'exhausted'); assert.equal(records[1].status, 'exhausted');
  assert.equal(records[0].statusBasis, undefined);
  blocked = true; now += 60001;
  records = (await prober.refresh({ engine: 'codex' })).records;
  assert.equal(records[0].status, 'exhausted'); assert.equal(records[0].stale, false);
  assert.equal(records[0].statusBasis, 'account_restriction');
});

test('an expired short window does not stale a currently exhausted weekly account pool', async t => {
  const f = fixture(t); f.credential('claude');
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => json({
    five_hour: { utilization: 10, resets_at: new Date(start - 60000).toISOString() },
    seven_day: { utilization: 100, resets_at: new Date(start + 3600000).toISOString() }, extra_usage: { is_enabled: false },
  }) });
  t.after(() => prober.close());
  const record = (await prober.refresh({ engine: 'claude' })).records[1];
  assert.equal(record.status, 'exhausted'); assert.equal(record.stale, false);
  assert.equal(record.windows[0].usedPercent, 10);
  assert.equal(record.windows[1].resetsAt, new Date(start + 3600000).toISOString());
});

test('known credentials echoed as short model, product or unknown kind strings are removed from output', async t => {
  const f = fixture(t);
  f.credential('codex', { auth_mode: 'chatgpt', tokens: { access_token: token('codex'), account_id: 'sk-account' } });
  f.credential('claude', { claudeAiOauth: { accessToken: 'sk-short', expiresAt: start + 600000 } });
  f.credential('grok', { 'https://auth.x.ai::client': { auth_mode: 'oidc', key: 'xai-short', expires_at: reset } });
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async url => String(url).includes('chatgpt.com')
    ? json({ ...codexBody(), additional_rate_limits: [{ normal_model_slug: 'sk-account', rate_limit: { primary_window: { used_percent: 30 } } }] })
    : String(url).includes('anthropic.com') ? json({ limits: [{ kind: 'weekly_scoped', percent: 20, scope: { model: { id: 'sk-short' } } }, { kind: 'sk-short', percent: 30 }] })
      : json({ config: { creditUsagePercent: 20, productUsage: [{ product: 'xai-short', usagePercent: 5 }] } }) });
  t.after(() => prober.close());
  const records = (await prober.refresh({})).records;
  assert.doesNotMatch(JSON.stringify(records), /sk-account|sk-short|xai-short/);
  assert.equal(records[0].status, 'available');
  assert.equal(records[0].windows[1].scope, 'unknown');
  assert.equal(records[1].windows[0].model, null);
});

test('Claude explicit model and surface scopes cannot become account quota or fall back to legacy windows', async t => {
  const f = fixture(t); f.credential('claude');
  let now = start;
  let limits: unknown[] = [{ kind: 'session', percent: 100, resets_at: reset, scope: { model: { id: 'claude-opus' } } }];
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => json({ limits, five_hour: { utilization: 10, resets_at: reset }, extra_usage: { is_enabled: false } }) });
  t.after(() => prober.close());
  let record = (await prober.refresh({ engine: 'claude' })).records[1];
  assert.equal(record.status, 'unknown');
  assert.equal(record.windows[0].scope, 'model');
  assert.equal(record.windows[0].model, 'claude-opus');
  limits = [{ kind: 'weekly_all', percent: 100, resets_at: reset, scope: { surface: 'specific-product' } }]; now += 60001;
  record = (await prober.refresh({ engine: 'claude' })).records[1];
  assert.equal(record.status, 'unknown');
  assert.equal(record.windows[0].scope, 'unknown');
  limits = [{ kind: 'session', percent: null, scope: { model: {} } }]; now += 60001;
  record = (await prober.refresh({ engine: 'claude' })).records[1];
  assert.equal(record.status, 'unknown');
  assert.equal(record.windows.length, 1, 'an authoritative incomplete model record must not become legacy available quota');
  assert.equal(record.windows[0].scope, 'model');
  assert.equal(record.windows[0].usedPercent, null);
});

test('fresh independent account restriction survives included-window resets while TTL and failures still apply', async t => {
  const f = fixture(t); f.credential('codex');
  let now = start;
  let fail = false;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => fail ? json({}, 500) : json({ ...codexBody(100), rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: start / 1000 - 60 } }, spend_control: { reached: true } }) });
  t.after(() => prober.close());
  let record = (await prober.refresh({ engine: 'codex' })).records[0];
  assert.equal(record.status, 'exhausted');
  assert.equal(record.stale, false);
  now += 300000;
  assert.equal(prober.get().records[0].stale, true);
  fail = true;
  record = (await prober.refresh({ engine: 'codex' })).records[0];
  assert.equal(record.status, 'error');
  assert.equal(record.stale, true);
});

test('an expired access token the native CLI can renew keeps the last reading without any login report', async t => {
  const f = fixture(t);
  for (const engine of ['codex', 'claude', 'grok'] as const) f.credential(engine);
  let now = start; let calls = 0;
  const bodies = (url: string) => url.includes('chatgpt.com') ? codexBody(20)
    : url.includes('anthropic.com') ? { five_hour: { utilization: 30, resets_at: reset }, extra_usage: { is_enabled: false } }
      : { config: { creditUsagePercent: 40, currentPeriod: { end: reset } } };
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async url => { calls++; return json(bodies(String(url))); } });
  t.after(() => prober.close());
  const observed = (await prober.refresh({})).records;
  assert.equal(calls, 3);
  assert.deepEqual(observed.map(r => [r.status, r.stale]), [['available', false], ['available', false], ['available', false], ['unsupported', true]]);
  for (const engine of ['codex', 'claude', 'grok'] as const) f.credential(engine, expiredCredential(engine, true));
  now += 60_001;
  const pending = (await prober.refresh({})).records;
  assert.equal(calls, 3, 'an expired token that the native CLI can renew must never reach the quota API');
  for (const [index, record] of pending.entries()) {
    assert.equal(record.status, observed[index].status, 'the last observation is kept, not replaced by a logout');
    assert.deepEqual(record.windows, observed[index].windows);
    assert.equal(record.observedAt, observed[index].observedAt);
    assert.equal(record.stale, true);
    assert.doesNotMatch(record.detail, /登录|重新登录|确认/);
  }
  assert.doesNotMatch(JSON.stringify(pending), /never-use|expired-|secret/);
});

test('a renewal wait without any earlier reading stays unknown with a safe reason', async t => {
  const f = fixture(t);
  for (const engine of ['codex', 'claude', 'grok'] as const) f.credential(engine, expiredCredential(engine, true));
  let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => { calls++; return json(codexBody()); } });
  t.after(() => prober.close());
  const records = (await prober.refresh({})).records;
  assert.equal(calls, 0);
  assert.deepEqual(records.map(r => [r.status, r.stale, r.windows.length, r.observedAt]), [['unknown', true, 0, null], ['unknown', true, 0, null], ['unknown', true, 0, null], ['unsupported', true, 0, null]]);
  for (const record of records.filter(r => r.engine !== 'opencode')) {
    assert.match(record.detail, /令牌已到期.*等待原生 CLI 续期/, 'unknown quota must explain why no observation is available');
  }
  assert.doesNotMatch(JSON.stringify(records), /never-use|expired-|secret|refresh_token/);
  assert.ok(records.every(r => !/登录|重新登录|确认/.test(r.detail)));
});

test('an expired token with no refresh token is still a real logout that drops earlier readings', async t => {
  const f = fixture(t);
  for (const engine of ['codex', 'claude', 'grok'] as const) f.credential(engine);
  let now = start; let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async url => { calls++; return json(String(url).includes('chatgpt.com') ? codexBody(20) : String(url).includes('anthropic.com') ? { five_hour: { utilization: 30, resets_at: reset }, extra_usage: { is_enabled: false } } : { config: { creditUsagePercent: 40, currentPeriod: { end: reset } } }); } });
  t.after(() => prober.close());
  await prober.refresh({});
  assert.equal(calls, 3);
  for (const engine of ['codex', 'claude', 'grok'] as const) f.credential(engine, expiredCredential(engine, false));
  now += 60_001;
  const records = (await prober.refresh({})).records;
  assert.equal(calls, 3, 'a logout must not reach the quota API either');
  for (const record of records.filter(r => r.engine !== 'opencode')) {
    assert.equal(record.status, 'unauthenticated');
    assert.equal(record.windows.length, 0);
    assert.equal(record.observedAt, null);
    assert.match(record.detail, /登录/);
  }
});

test('a renewal wait for a different native account does not reuse the previous account readings', async t => {
  const f = fixture(t); f.credential('grok');
  let now = start; let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => { calls++; return json({ config: { creditUsagePercent: 14, currentPeriod: { end: reset } } }); } });
  t.after(() => prober.close());
  const observed = (await prober.refresh({ engine: 'grok' })).records[2];
  assert.equal(observed.status, 'available');
  f.credential('grok', { 'https://auth.x.ai::official-client': { auth_mode: 'oidc', key: 'expired-grok', expires_at: new Date(start - 1).toISOString(), refresh_token: 'never-use', team_id: 'another-team' } });
  now += 60_001;
  const changed = (await prober.refresh({ engine: 'grok' })).records[2];
  assert.equal(calls, 1);
  assert.equal(changed.status, 'unknown');
  assert.equal(changed.windows.length, 0);
  assert.equal(changed.observedAt, null);
  assert.equal(changed.stale, true);
  assert.doesNotMatch(changed.detail, /登录|确认/);
});

test('credential reading separates a renewably expired token from a logout and never touches the file', async t => {
  const f = fixture(t);
  const file = f.credential('claude', expiredCredential('claude', true));
  const bytes = readFileSync(file, 'utf8');
  await assert.rejects(() => readNativeCredential('claude', f.env, start), (error: unknown) => {
    if (!(error instanceof QuotaRenewalPending)) throw new Error('expected a renewal wait');
    assert.doesNotMatch(`${error.message}${error.account}`, /never-use|expired-claude|secret/);
    assert.doesNotMatch(error.message, /登录|确认/);
    return true;
  });
  f.credential('codex', expiredCredential('codex', true));
  f.credential('grok', expiredCredential('grok', true));
  for (const engine of ['codex', 'grok'] as QuotaEngine[]) {
    await assert.rejects(() => readNativeCredential(engine, f.env, start), (error: unknown) => error instanceof QuotaRenewalPending && /^[0-9a-f]{64}$/.test(error.account));
  }
  assert.equal(readFileSync(file, 'utf8'), bytes, 'Weaver only reads the native credential');
  for (const engine of ['codex', 'claude', 'grok'] as QuotaEngine[]) {
    f.credential(engine, expiredCredential(engine, false));
    await assert.rejects(() => readNativeCredential(engine, f.env, start), (error: unknown) => error instanceof QuotaFailure && !(error instanceof QuotaRenewalPending) && error.status === 'unauthenticated' && /登录/.test(error.message));
  }
});

const goSlot = (status: unknown, percent: unknown, resetsAt: unknown) => ({ status, percent, resetsAt });
const goUsage = (rolling: unknown = goSlot('ok', 1, reset), weekly: unknown = goSlot('ok', 25, reset), monthly: unknown = goSlot('ok', 29, reset)) => ({ usage: { rolling, weekly, monthly } });

test('OpenCode without a Go API key never reaches the official endpoint and names no logout', async t => {
  const f = fixture(t);
  let calls = 0;
  const prober = new QuotaProber({ env: { ...f.env, OPENCODE_API_KEY: 'env-secret-must-not-send', OPENCODE_AUTH_CONTENT: 'env-content-must-not-send' }, now: () => new Date(start), fetch: async () => { calls++; return json(goUsage()); } });
  t.after(() => prober.close());
  // A missing file is not a logout: free models need no login at all.
  let record = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(record.status, 'unsupported');
  assert.equal(record.windows.length, 0);
  assert.match(record.detail, /免费模型|Go/);
  assert.doesNotMatch(record.detail, /登录|重新登录/);
  assert.equal(calls, 0);
  for (const body of [
    { 'opencode-go': { type: 'oauth', access: 'oauth-secret', refresh: 'oauth-refresh' } },
    { 'opencode-go': { type: 'wellknown', key: 'unknown-secret' } },
    { 'opencode-go': { type: 'api', key: '' } },
    { 'opencode-go': 'public' },
    { opencode: { type: 'oauth', access: 'oauth-secret' } },
  ]) {
    f.credential('opencode', body);
    record = (await prober.refresh({ engine: 'opencode' })).records[3];
    assert.equal(record.status, 'unsupported', JSON.stringify(body));
    assert.equal(record.windows.length, 0);
    assert.equal(calls, 0);
  }
  assert.doesNotMatch(JSON.stringify(prober.get()), /env-secret|oauth-secret|unknown-secret/);
});

test('OpenCode prefers the opencode-go key, falls back to opencode and honors XDG_DATA_HOME', async t => {
  const f = fixture(t);
  f.credential('opencode', { 'opencode-go': { type: 'api', key: 'secret-go' }, opencode: { type: 'api', key: 'secret-plain' } });
  const seen: string[] = [];
  let now = start;
  let prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async (_url, init) => { seen.push(new Headers(init!.headers).get('Authorization')!); return json(goUsage()); } });
  t.after(() => prober.close());
  assert.equal((await prober.refresh({ engine: 'opencode' })).records[3].status, 'available');
  assert.deepEqual(seen, ['Bearer secret-go']);
  f.credential('opencode', { opencode: { type: 'api', key: 'secret-plain' } });
  now += 60001;
  await prober.refresh({ engine: 'opencode' });
  assert.deepEqual(seen, ['Bearer secret-go', 'Bearer secret-plain']);
  await prober.close();
  const xdg = join(f.root, 'xdg-data');
  mkdirSync(join(xdg, 'opencode'), { recursive: true });
  writeFileSync(join(xdg, 'opencode', 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'secret-xdg' } }));
  const xdgSeen: string[] = [];
  const xdgProber = new QuotaProber({ env: { ...f.env, XDG_DATA_HOME: xdg }, now: () => new Date(start), fetch: async () => { xdgSeen.push('called'); return json(goUsage()); } });
  t.after(() => xdgProber.close());
  // HOME holds no fallback key here, so a request proves the XDG file was used.
  rmSync(join(f.root, '.local'), { recursive: true, force: true });
  assert.equal((await xdgProber.refresh({ engine: 'opencode' })).records[3].status, 'available');
  assert.deepEqual(xdgSeen, ['called']);
});

test('OpenCode sends only the fixed official GET with the native key and projects safe windows', async t => {
  const f = fixture(t);
  f.credential('opencode');
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async (url, init) => { requests.push({ url: String(url), init: init! }); return json(goUsage()); } });
  t.after(() => prober.close());
  const record = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(record.source, 'opencode_go_usage');
  assert.deepEqual(requests.map(r => r.url), ['https://opencode.ai/zen/go/v1/usage']);
  const init = requests[0].init;
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.body, undefined);
  assert.equal(init.credentials, 'omit');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('Authorization'), 'Bearer secret-opencode');
  assert.equal(headers.get('ChatGPT-Account-Id'), null);
  assert.equal(headers.get('anthropic-beta'), null);
  assert.equal(headers.get('x-xai-token-auth'), null);
  assert.equal(record.status, 'available');
  assert.deepEqual(record.windows.map(w => [w.id, w.label, w.scope, w.model, w.usedPercent, w.remainingPercent, w.unit, w.durationMinutes]), [
    ['opencode:rolling', 'OpenCode Go · 5 小时额度', 'account', null, 1, 99, 'percent', 300],
    ['opencode:weekly', 'OpenCode Go · 每周额度', 'account', null, 25, 75, 'percent', 10080],
    ['opencode:monthly', 'OpenCode Go · 每月额度', 'account', null, 29, 71, 'percent', null],
  ]);
  assert.ok(record.windows.every(w => w.resetsAt !== null && Date.parse(w.resetsAt) === Date.parse(reset) && w.used === null && w.total === null && w.remaining === null));
  assert.doesNotMatch(JSON.stringify(record), /secret-opencode/);
});

test('OpenCode maps rate limits to an exhausted plan window and malformed shapes to unknown', async t => {
  const f = fixture(t);
  f.credential('opencode');
  let now = start;
  let body: unknown = goUsage(goSlot('rate-limited', 100, reset));
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => json(body) });
  t.after(() => prober.close());
  let record = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(record.status, 'exhausted');
  assert.equal(record.windows.length, 3);
  assert.match(record.detail, /仅指 Go 套餐窗口|不代表/);
  assert.doesNotMatch(JSON.stringify(record), /USD|balance|credit/i);
  now += 60001;
  body = goUsage(goSlot('ok', 100, reset));
  record = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(record.status, 'exhausted');
  for (const malformed of [
    { usage: { weekly: goSlot('ok', 25, reset), monthly: goSlot('ok', 29, reset) } },
    goUsage(goSlot('paused', 10, reset)),
    goUsage(goSlot('ok', -1, reset)),
    goUsage(goSlot('ok', NaN, reset)),
    goUsage(goSlot('ok', 10, 'not-a-date')),
    { usage: null },
    {},
  ]) {
    now += 60001;
    body = malformed;
    record = (await prober.refresh({ engine: 'opencode' })).records[3];
    assert.equal(record.status, 'unknown', JSON.stringify(malformed));
    assert.equal(record.windows.length, 0, 'a partial or malformed Go plan never becomes an account reading');
  }
  // Unknown extra payload keys (older useBalance, balances) are ignored, never turned into dollars.
  now += 60001;
  body = { usage: { rolling: goSlot('ok', 10, reset), weekly: goSlot('ok', 10, reset), monthly: goSlot('ok', 10, reset) }, useBalance: true, balance: 12.5 };
  record = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(record.status, 'available');
  assert.ok(record.windows.every(w => w.unit === 'percent'));
});

test('OpenCode distinguishes missing subscriptions from edge errors and keeps auth failures safe', async t => {
  const f = fixture(t);
  f.credential('opencode');
  let mode = 0;
  let now = start;
  let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => {
    calls++;
    if (mode === 0) return json({ type: 'error', error: { type: 'AuthError', message: 'Unauthorized' } }, 401);
    if (mode === 1) return json({ type: 'error', error: { type: 'EntitlementError', message: 'OpenCode Go subscription required.' } }, 403);
    if (mode === 2) return json({ type: 'error', error: { type: 'OtherError', message: 'edge denied' } }, 403);
    if (mode === 3) return new Response('forbidden page', { status: 403, headers: { 'Content-Type': 'text/html' } });
    return json({ private: 'secret-response-body' }, 500);
  } });
  t.after(() => prober.close());
  assert.equal((await prober.refresh({ engine: 'opencode' })).records[3].status, 'unauthenticated');
  mode = 1; now += 60001;
  let record = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(record.status, 'unsupported');
  assert.match(record.detail, /没有 Go 订阅/);
  mode = 2; now += 60001;
  assert.equal((await prober.refresh({ engine: 'opencode' })).records[3].status, 'error', 'a non-EntitlementError 403 must not look like a missing subscription');
  mode = 3; now += 60001;
  assert.equal((await prober.refresh({ engine: 'opencode' })).records[3].status, 'error');
  mode = 4; now += 60001;
  record = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(record.status, 'error');
  assert.doesNotMatch(JSON.stringify(record), /secret-response-body/);
  assert.equal(calls, 5);
});

test('OpenCode credential reading separates accounts by provider id and never writes the file', async t => {
  const f = fixture(t);
  const file = f.credential('opencode');
  const before = readFileSync(file, 'utf8');
  const first = await readNativeCredential('opencode', f.env, start);
  assert.equal(readFileSync(file, 'utf8'), before, 'Weaver only reads the native credential');
  assert.match(first.token, /secret-opencode/);
  assert.ok(/^[0-9a-f]{64}$/.test(first.fingerprint) && /^[0-9a-f]{64}$/.test(first.account));
  assert.doesNotMatch(`${first.fingerprint}${first.account}`, /secret-opencode/);
  assert.equal(first.accountId, undefined);
  f.credential('opencode', { opencode: { type: 'api', key: 'secret-plain' } });
  const second = await readNativeCredential('opencode', f.env, start);
  assert.notEqual(second.account, first.account, 'different provider ids hash to different accounts');
});

test('Claude five-hour, weekly and configured monthly caps are independent AND constraints', () => {
  for (const full of [null, 'five', 'week', 'month'] as const) {
    for (const percent of [100, 105]) {
      const result = normalizeUsage('claude', {
        five_hour: { utilization: full === 'five' ? percent : 10, resets_at: reset },
        seven_day: { utilization: full === 'week' ? percent : 20, resets_at: reset },
        extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: full === 'month' ? percent * 20 : 600, utilization: full === 'month' ? percent : 30 },
      }, start);
      assert.equal(result.status, full === null ? 'available' : 'exhausted', `${full}: ${percent}`);
      assert.equal(result.windows.length, 3);
      const monthly = result.windows.find(w => w.id === 'claude:extra_usage:monthly')!;
      assert.equal(monthly.scope, 'account');
      assert.equal(monthly.unit, 'credits');
      assert.equal(monthly.total, 2000);
    }
  }
});

test('Claude monthly configured amounts block even without utilization, but disabled or unconfigured extras add no cap', () => {
  for (const used of [2000, 2100]) {
    const result = normalizeUsage('claude', { five_hour: { utilization: 10 }, extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: used } }, start);
    assert.equal(result.status, 'exhausted');
  }
  for (const extra_usage of [undefined, { is_enabled: false, monthly_limit: 2000, used_credits: 2000, utilization: 100 }, { monthly_limit: 2000, used_credits: 2000 }, { is_enabled: true, monthly_limit: null, utilization: 100 }, { is_enabled: true, monthly_limit: 0, used_credits: 0 }, { is_enabled: true, balance: 0 }]) {
    const result = normalizeUsage('claude', { five_hour: { utilization: 0 }, extra_usage }, start);
    assert.equal(result.status, 'available');
    assert.equal(result.windows.length, 1);
  }
  assert.equal(normalizeUsage('claude', { five_hour: { utilization: 0 }, extra_usage: { is_enabled: true, monthly_limit: 2000 } }, start).status, 'unknown');
});

test('Codex permission, credits and model allowances cannot release either account window', () => {
  for (const full of ['primary_window', 'secondary_window']) {
    const result = normalizeUsage('codex', {
      rate_limit: { allowed: true, primary_window: { used_percent: 10 }, secondary_window: { used_percent: 20 }, [full]: { used_percent: 100 } },
      credits: { has_credits: true, unlimited: true, balance: '100' },
      additional_rate_limits: [{ normal_model_slug: 'other', rate_limit: { allowed: true, primary_window: { used_percent: 0 } } }],
    }, start);
    assert.equal(result.status, 'exhausted');
  }
  assert.equal(normalizeUsage('codex', { rate_limit: { allowed: true, primary_window: { used_percent: null } } }, start).status, 'unknown');
  assert.equal(normalizeUsage('codex', { rate_limit: { primary_window: { used_percent: 0 } }, additional_rate_limits: [{ normal_model_slug: 'other', rate_limit: { primary_window: { used_percent: 100 } } }] }, start).status, 'available');
});

test('Grok current account monthly amounts are one cap; billing balances and product stats do not override it', () => {
  for (const used of [100, 105]) {
    const result = normalizeUsage('grok', { config: { monthlyLimit: { val: 100 }, used: { val: used }, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', start: '2026-10-01T00:00:00Z', end: reset }, prepaidBalance: { val: 50 }, onDemandCap: { val: 100 }, onDemandUsed: { val: 0 } } }, start);
    assert.equal(result.status, 'exhausted');
    assert.equal(result.windows.length, 1);
    assert.notEqual(result.windows[0].unit, 'usd');
  }
  assert.equal(normalizeUsage('grok', { config: { creditUsagePercent: 10, productUsage: [{ product: 'other', usagePercent: 100 }], prepaidBalance: { val: 0 } } }, start).status, 'available');
});

test('OpenCode each provided cap blocks at and above 100 and an expired window cannot establish availability', () => {
  for (const key of ['rolling', 'weekly', 'monthly']) {
    for (const percent of [100, 105]) {
      const body = goUsage();
      body.usage[key as keyof typeof body.usage] = goSlot('ok', percent, reset);
      assert.equal(normalizeUsage('opencode', body, start).status, 'exhausted');
    }
  }
  assert.equal(normalizeUsage('opencode', goUsage(), Date.parse(reset)).status, 'unknown');
});

test('an expired or incomplete provided account window cannot be masked by another available window', () => {
  for (const percent of [0, 100, null]) {
    const result = normalizeUsage('claude', { five_hour: { utilization: percent, resets_at: new Date(start - 1).toISOString() }, seven_day: { utilization: 10, resets_at: reset } }, start);
    assert.equal(result.status, 'unknown');
  }
  assert.equal(normalizeUsage('claude', { limits: [{ kind: 'session', percent: null }, { kind: 'weekly_all', percent: 10 }] }, start).status, 'unknown');
});

test('Grok finite current account used/total remain authoritative when utilization is missing or contradictory', () => {
  for (const creditUsagePercent of [undefined, null, 10, NaN]) {
    const result = normalizeUsage('grok', { config: { creditUsagePercent, monthlyLimit: { val: 100 }, used: { val: 100 } } }, start);
    assert.equal(result.status, 'exhausted');
  }
});

test('OpenCode known exhausted windows still block when another window is incomplete', () => {
  assert.equal(normalizeUsage('opencode', { usage: { weekly: goSlot('ok', 100, reset) } }, start).status, 'exhausted');
});

test('Console five-hour, weekly and monthly caps each block despite useBalance', () => {
  for (const key of ['fiveHour', 'week', 'month']) {
    for (const used of ['100', '105']) {
      const meters = Object.fromEntries(['fiveHour', 'week', 'month'].map(name => [name, { usedMicroCents: name === key ? used : '10', limitMicroCents: '100', resetsAt: reset }]));
      assert.equal(normalizeConsoleStatus({ access: { meters }, useBalance: true }).status, 'exhausted');
    }
  }
});

test('a Console rolling window with usage but no reset is incomplete, never fabricated as zero', () => {
  const result = normalizeConsoleStatus({ access: { meters: {
    fiveHour: { usedMicroCents: '100', limitMicroCents: '100' },
    week: { usedMicroCents: '10', limitMicroCents: '100', resetsAt: reset },
    month: { usedMicroCents: '10', limitMicroCents: '100', resetsAt: reset },
  } } });
  assert.equal(result.status, 'unknown');
});

test('Console known exhausted cap takes precedence over incomplete sibling windows', () => {
  assert.equal(normalizeConsoleStatus({ access: { meters: { month: { usedMicroCents: '100', limitMicroCents: '100', resetsAt: reset } } } }).status, 'exhausted');
});
