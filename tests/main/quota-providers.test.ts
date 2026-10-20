import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QuotaProber } from '../../src/main/quota';
import { QuotaFailure, QuotaRenewalPending, readNativeCredential } from '../../src/main/quota/credentials';
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
    const dir = join(root, engine === 'codex' ? '.codex' : engine === 'claude' ? '.claude' : '.grok');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, engine === 'claude' ? '.credentials.json' : 'auth.json');
    const defaults = engine === 'codex' ? { auth_mode: 'chatgpt', tokens: { access_token: token('secret-native'), account_id: 'account-secret', refresh_token: 'never-use' } }
      : engine === 'claude' ? { claudeAiOauth: { accessToken: 'secret-claude', expiresAt: start + 86400000, refreshToken: 'never-use' }, mcpOAuth: { accessToken: 'wrong-mcp-secret' } }
        : { 'https://auth.x.ai::official-client': { auth_mode: 'oidc', key: 'secret-grok', expires_at: reset, refresh_token: 'never-use' } };
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
  assert.deepEqual(snapshot.records.map(r => r.engine), ['codex', 'claude', 'grok']);
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
  assert.ok(result.records.every(r => r.status === 'available' && !r.stale));
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

test('scoped model pools do not claim an exhausted account and paid allowances prevent false blocks', async t => {
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
  assert.equal(result.records[0].status, 'available');
  assert.equal(result.records[1].status, 'unknown');
  assert.equal(result.records[2].status, 'unknown');
  assert.equal(result.records[0].windows[1].scope, 'model');
  assert.equal(result.records[1].windows[0].scope, 'model');
});

test('explicit account exhaustion requires known unavailable extras; missing numbers never become zero', async t => {
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
  assert.ok(first.records.every(r => r.status === 'exhausted'));
  assert.equal(first.records[0].windows[0].usedPercent, 105);
  assert.equal(first.records[0].windows[0].remainingPercent, 0);
  now += 60001; missing = true;
  const second = await prober.refresh({});
  assert.ok(second.records.every(r => r.status === 'unknown'));
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
});

test('independent Codex model allowance prevents a whole-engine exhaustion claim', async t => {
  const f = fixture(t); f.credential('codex');
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => json(codexBody(100, { additional_rate_limits: [{ metered_feature: 'spark', rate_limit: { allowed: true, primary_window: { used_percent: 10, reset_at: Date.parse(reset) / 1000 } } }] })) });
  t.after(() => prober.close());
  const record = (await prober.refresh({ engine: 'codex' })).records[0];
  assert.equal(record.status, 'unknown');
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

test('explicit extra allowance and server permission recover availability while global spend limits win', async t => {
  const f = fixture(t); f.credential('codex'); f.credential('claude');
  let now = start; let blocked = false;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async url => String(url).includes('chatgpt.com')
    ? json({ ...codexBody(100), rate_limit: { ...codexBody(100).rate_limit, allowed: true, limit_reached: false }, spend_control: { reached: blocked } })
    : json({ five_hour: { utilization: 100, resets_at: reset }, extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 1 } }) });
  t.after(() => prober.close());
  let records = (await prober.refresh({})).records;
  assert.equal(records[0].status, 'available'); assert.equal(records[1].status, 'available');
  assert.match(records[1].detail, /额外额度/);
  blocked = true; now += 60001;
  records = (await prober.refresh({ engine: 'codex' })).records;
  assert.equal(records[0].status, 'exhausted'); assert.equal(records[0].stale, false);
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
  assert.equal(record.windows.length, 0, 'an authoritative incomplete record must not become legacy available quota');
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
  assert.deepEqual(observed.map(r => [r.status, r.stale]), [['available', false], ['available', false], ['available', false]]);
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

test('a renewal wait without any earlier reading stays the ordinary no-data state', async t => {
  const f = fixture(t);
  for (const engine of ['codex', 'claude', 'grok'] as const) f.credential(engine, expiredCredential(engine, true));
  let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => { calls++; return json(codexBody()); } });
  t.after(() => prober.close());
  const records = (await prober.refresh({})).records;
  assert.equal(calls, 0);
  assert.deepEqual(records.map(r => [r.status, r.stale, r.windows.length, r.observedAt]), [['unknown', true, 0, null], ['unknown', true, 0, null], ['unknown', true, 0, null]]);
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
  for (const record of records) {
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
