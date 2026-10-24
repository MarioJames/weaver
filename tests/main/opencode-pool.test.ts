import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OpenCodeQuotaPool } from '../../src/main/quota/opencode-pool';
import type { OpenCodePoolPersistence } from '../../src/main/storage/opencode-account-pool';
import { TaskStore } from '../../src/main/store';
import { dbOpenCodePoolStore } from '../../src/main/storage/opencode-account-pool';
import { QUOTA_FRESH_MS } from '../../src/shared/contracts/quota';
import type { OpenCodeConsoleOrg } from '../../src/shared/contracts/opencode-accounts';

const initial = Date.parse('2026-10-18T12:00:00Z');
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const body = () => ({ access: { meters: Object.fromEntries(['fiveHour', 'week', 'month'].map(name => [name, { usedMicroCents: '10', limitMicroCents: '100', resetsAt: new Date(initial + 86400_000).toISOString() }])) } });
const refs = [ { accountID: 'account-a', orgID: 'org-a' }, { accountID: 'account-b', orgID: 'org-b' } ];
function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), 'weaver-pool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'native.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE account(id TEXT PRIMARY KEY,email TEXT,url TEXT,access_token TEXT,refresh_token TEXT,token_expiry INTEGER); CREATE TABLE account_state(id INTEGER PRIMARY KEY,active_account_id TEXT,active_org_id TEXT); CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT);');
  for (const ref of refs) db.prepare('INSERT INTO account VALUES (?,?,?,?,?,?)').run(ref.accountID, `${ref.accountID}@example.invalid`, 'https://opencode.ai/console', `fixture-token-${ref.accountID}`, 'fixture-refresh-never-read', initial + 86400_000);
  db.prepare('INSERT INTO account_state VALUES (1,?,?)').run(refs[0].accountID, refs[0].orgID);
  db.exec("INSERT INTO session VALUES ('ses-preserved','Existing conversation')");
  t.after(() => db.close());
  const authDir = join(root, '.local', 'share', 'opencode'); mkdirSync(authDir, { recursive: true });
  const auth = join(authDir, 'auth.json'); writeFileSync(auth, '{"unrelated":{"key":"fixture-other"}}');
  let time = initial;
  let listed: OpenCodeConsoleOrg[] = refs.map((ref, index) => ({ ...ref, accountEmail: `${ref.accountID}@example.invalid`, accountUrl: 'https://opencode.ai/console', orgName: ref.orgID, active: index === 0 }));
  let mode: 'ok' | 'auth-b' | 'rate-b' | 'config-b' | 'oversize-b' | 'redirect-b' = 'ok';
  const calls: Array<{ url: string; org: string }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers), org = headers.get('x-org-id')!;
    assert.equal(headers.get('Authorization'), `Bearer ${db.prepare('SELECT access_token FROM account WHERE id=?').get(org === 'org-a' ? 'account-a' : 'account-b')!.access_token}`);
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'GET');
    assert.ok(['https://opencode.ai/console/api/go/status', 'https://opencode.ai/console/api/config'].includes(String(url)));
    calls.push({ url: String(url), org });
    if (String(url).endsWith('/api/config')) return json({ config: { provider: mode === 'config-b' && org === 'org-b' ? {} : { 'opencode-go': { options: { apiKey: 'fixture-go-api-key' } } } } });
    if (org === 'org-b' && mode === 'auth-b') return json({ error: 'fixture-token-account-b' }, 401);
    if (org === 'org-b' && mode === 'rate-b') return json({}, 429, { 'Retry-After': '180' });
    if (org === 'org-b' && mode === 'oversize-b') return json({ data: 'fixture-token-account-b'.repeat(20000) });
    if (org === 'org-b' && mode === 'redirect-b') return new Response('', { status: 302, headers: { Location: 'https://evil.invalid/' } });
    return json(body());
  };
  let saved: ReturnType<OpenCodePoolPersistence['load']>;
  let failPersist = false;
  const persistence: OpenCodePoolPersistence = { load: () => structuredClone(saved), save: value => { if (failPersist) throw new Error('fixture storage unavailable'); saved = structuredClone(value); } };
  const make = (fetchOverride?: typeof fetch, persistenceOverride?: OpenCodePoolPersistence) => new OpenCodeQuotaPool({ env: { HOME: root, OPENCODE_DB: file }, now: () => new Date(time), accounts: { list: async () => ({ orgs: listed, consoleManagedProviders: ['opencode-go'], switchableOrgCount: listed.length }) }, fetch: fetchOverride ?? fetcher, persistence: persistenceOverride ?? persistence });
  const pool = make(); t.after(() => pool.close());
  return { pool, make, db, calls, persistence, failPersist: (value: boolean) => { failPersist = value; }, saved: () => saved, time: (value: number) => { time = value; }, mode: (value: typeof mode) => { mode = value; }, listed: (value: OpenCodeConsoleOrg[]) => { listed = value; }, orgs: () => listed, auth: () => readFileSync(auth, 'utf8') };
}

test('per-account lookup preserves active cursor, conversations and other credentials; get never performs IO', async t => {
  const f = fixture(t);
  assert.deepEqual(f.pool.get().accounts, []);
  const before = f.auth();
  const result = await f.pool.refresh(refs[1]);
  const b = result.accounts.find(row => row.account.accountID === 'account-b')!;
  assert.equal(b.quota.status, 'available'); assert.equal(b.goReady, true);
  assert.equal(result.accounts.find(row => row.account.accountID === 'account-a')!.quota.status, 'unknown');
  assert.deepEqual(result.active, refs[0]);
  assert.deepEqual(f.db.prepare('SELECT active_account_id,active_org_id FROM account_state').get(), Object.assign(Object.create(null), { active_account_id: 'account-a', active_org_id: 'org-a' }));
  assert.equal(f.db.prepare('SELECT title FROM session').get()!.title, 'Existing conversation');
  assert.equal(f.auth(), before);
  assert.equal(f.calls.every(call => call.org === 'org-b'), true);
  const count = f.calls.length; f.pool.get(); f.pool.candidate(); assert.equal(f.calls.length, count);
  const text = JSON.stringify([result, f.saved()]);
  for (const secret of ['fixture-token-', 'fixture-refresh', 'fixture-go-api-key']) assert.equal(text.includes(secret), false);
});

test('401 and 429 pacing belong to their account; new credentials do not inherit another observation', async t => {
  const f = fixture(t); f.mode('rate-b');
  let result = await f.pool.refresh();
  assert.equal(result.accounts[0].quota.status, 'available'); assert.equal(result.accounts[1].quota.status, 'error');
  assert.equal(result.accounts[1].quota.retryAt, new Date(initial + 180_000).toISOString());
  const bCalls = () => f.calls.filter(call => call.org === 'org-b' && call.url.endsWith('/status')).length;
  f.time(initial + 61_000); f.mode('auth-b'); await f.pool.refresh(); assert.equal(bCalls(), 1);
  f.time(initial + 181_000); result = await f.pool.refresh();
  assert.equal(result.accounts[1].quota.status, 'unauthenticated'); assert.equal(result.accounts[0].quota.status, 'available');
  assert.equal(JSON.stringify(result).includes('fixture-token'), false);
  f.db.prepare('UPDATE account SET access_token=? WHERE id=?').run('fixture-token-account-b-new', 'account-b');
  // Changed credentials invalidate only B even while its previous request is paced.
  f.time(initial + 182_000); result = await f.pool.refresh(refs[1]);
  assert.equal(result.accounts[1].quota.observedAt, null); assert.equal(result.accounts[0].quota.status, 'available');
});

test('Go readiness needs verified provider config; stale and restored observations cannot become candidates', async t => {
  const f = fixture(t); f.mode('config-b'); await f.pool.refresh();
  assert.equal(f.pool.get().accounts[1].quota.status, 'available');
  assert.equal(f.pool.candidate(refs[0]), undefined);
  const restored = f.make(); t.after(() => restored.close());
  assert.equal(restored.candidate(), undefined); assert.equal(restored.get().accounts[0].quota.stale, true);
  f.time(initial + QUOTA_FRESH_MS + 1); assert.equal(f.pool.candidate(), undefined);
  f.listed([f.orgs()[0]]); await f.pool.refresh();
  assert.equal(f.pool.get().accounts.length, 2); assert.equal(f.pool.get().accounts[1].quota.stale, true);
});

test('failure attribution is durable and idempotent; fresh observations after cooldown recover the same pair', async t => {
  const f = fixture(t); await f.pool.refresh();
  f.pool.recordFailure(refs[0], { kind: 'rate_limit', runID: 'run-one' });
  const until = f.pool.get().accounts[0].cooldownUntil;
  f.pool.recordFailure(refs[0], { kind: 'rate_limit', runID: 'run-one' }); assert.equal(f.pool.get().accounts[0].cooldownUntil, until);
  assert.equal(f.pool.candidate()!.account.accountID, 'account-b');
  const restored = f.make(); t.after(() => restored.close());
  restored.recordFailure(refs[0], { kind: 'rate_limit', runID: 'run-one' }); assert.equal(restored.get().accounts[0].cooldownUntil, until);
  f.time(initial + 600_001);
  assert.equal(restored.get().accounts[0].cooldownUntil, null);
  assert.equal(restored.hasFailure(refs[0]), true);
  await restored.refresh();
  assert.equal(restored.hasFailure(refs[0]), false);
  assert.equal(restored.get().accounts[0].cooldownUntil, null); assert.equal(restored.candidate()!.account.accountID, 'account-a');
  restored.recordFailure(refs[0], { kind: 'quota', runID: 'run-quota' });
  assert.equal(restored.get().accounts[0].quota.status, 'exhausted');
  f.time(initial + 661_001); await restored.refresh(refs[0]);
  assert.equal(restored.get().accounts[0].quota.status, 'available'); assert.equal(restored.candidate(refs[1])!.account.accountID, 'account-a');
});

test('missing accounts retain only stale history; oversized and redirect responses never leak supplier content', async t => {
  const f = fixture(t); await f.pool.refresh();
  f.time(initial + 61_000); f.mode('oversize-b'); let result = await f.pool.refresh();
  assert.equal(result.accounts[1].quota.stale, true); assert.equal(result.accounts[1].goReady, false);
  assert.equal(JSON.stringify(result).includes('fixture-token'), false);
  f.time(initial + 122_000); f.mode('redirect-b'); result = await f.pool.refresh(); assert.equal(result.accounts[1].quota.status, 'error');
  f.listed([]); result = await f.pool.refresh(); assert.equal(result.accounts.length, 2); assert.equal(f.pool.candidate(), undefined);
  await assert.rejects(f.pool.refresh({ accountID: 'account-a' }), /参数无效/);
});


test('failed persistence rolls back failure idempotency and ladder before a retry', async t => {
  const f = fixture(t); await f.pool.refresh();
  f.failPersist(true);
  assert.throws(() => f.pool.recordFailure(refs[0], { kind: 'rate_limit', runID: 'run-storage' }), /storage unavailable/);
  assert.equal(f.pool.get().accounts[0].cooldownUntil, null);
  assert.equal(f.pool.candidate()!.account.accountID, 'account-a');
  f.failPersist(false); f.pool.recordFailure(refs[0], { kind: 'rate_limit', runID: 'run-storage' });
  assert.equal(f.pool.get().accounts[0].cooldownUntil, new Date(initial + 600_000).toISOString());
});

test('Go config readiness cannot be reused after a native token change during pacing', async t => {
  const f = fixture(t); await f.pool.refresh();
  assert.equal(f.pool.candidate(refs[0])!.account.accountID, 'account-b');
  f.db.prepare('UPDATE account SET access_token=? WHERE id=?').run('fixture-token-account-b-new', 'account-b');
  f.time(initial + 1000); await f.pool.refresh(refs[1]);
  assert.equal(f.pool.candidate(refs[0]), undefined);
  assert.equal(f.pool.get().accounts[1].goReady, false);
  f.time(initial + 61_000); await f.pool.refresh(refs[1]);
  assert.equal(f.pool.candidate(refs[0])!.account.accountID, 'account-b');
});

test('overlapping refreshes share pair requests and respect three concurrent account probes', async t => {
  const f = fixture(t);
  const orgs = f.orgs();
  for (let n = 0; n < 4; n++) {
    const ref = { accountID: `extra-${n}`, orgID: `extra-org-${n}` };
    f.db.prepare('INSERT INTO account VALUES (?,?,?,?,?,?)').run(ref.accountID, 'fixture@example.invalid', 'https://opencode.ai/console', 'fixture-extra-token', 'refresh-fixture', initial + 86400_000);
    orgs.push({ ...ref, accountEmail: 'fixture@example.invalid', accountUrl: 'https://opencode.ai/console', orgName: ref.orgID, active: false });
  }
  f.listed(orgs);
  let concurrent = 0, maximum = 0, statusCalls = 0;
  const pool = f.make(async url => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    await new Promise<void>(resolve => setImmediate(resolve));
    concurrent--;
    if (String(url).endsWith('/status')) { statusCalls++; return json(body()); }
    return json({ config: { provider: { 'opencode-go': { options: { apiKey: 'fixture-api-key' } } } } });
  }); t.after(() => pool.close());
  await Promise.all([pool.refresh(), pool.refresh(refs[1]), pool.refresh()]);
  assert.equal(statusCalls, 6); assert.equal(maximum, 3);
  assert.equal(pool.get().accounts.every(row => row.goReady && row.quota.status === 'available'), true);
});

test('expired native tokens never reach the network and list failures retain safe stale history', async t => {
  const f = fixture(t); await f.pool.refresh();
  f.db.prepare('UPDATE account SET token_expiry=? WHERE id=?').run(initial + 100, 'account-b');
  f.time(initial + 61_000); const count = f.calls.filter(call => call.org === 'org-b').length;
  const result = await f.pool.refresh(refs[1]);
  assert.equal(result.accounts[1].quota.stale, true); assert.equal(result.accounts[1].goReady, false);
  assert.equal(f.calls.filter(call => call.org === 'org-b').length, count);
  assert.equal(f.pool.candidate(refs[0]), undefined);
});


test('native config Retry-After paces only that pair and config keys never enter durable KV', async t => {
  const f = fixture(t);
  let bConfig = 0;
  const pool = f.make(async (url, init) => {
    const org = new Headers(init?.headers).get('x-org-id');
    if (String(url).endsWith('/status')) return json(body());
    if (org === 'org-b' && ++bConfig === 1) return json({}, 429, { 'Retry-After': '180' });
    return json({ config: { provider: { 'opencode-go': { options: { apiKey: 'fixture-config-key-never-persist' } } } } });
  }); t.after(() => pool.close());
  await pool.refresh(); assert.equal(pool.get().accounts[1].goReady, false);
  f.time(initial + 61_000); await pool.refresh(refs[1]); assert.equal(bConfig, 1);
  f.time(initial + 181_000); await pool.refresh(refs[1]); assert.equal(bConfig, 2); assert.equal(pool.get().accounts[1].goReady, true);
  const root = mkdtempSync(join(tmpdir(), 'weaver-pool-kv-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'weaver.db')); t.after(() => store.close());
  const persistence = dbOpenCodePoolStore(store);
  pool.recordFailure(refs[0], { kind: 'rate_limit', runID: 'run-durable-kv' });
  persistence.save(f.saved()!);
  assert.equal(JSON.stringify(persistence.load()), JSON.stringify(f.saved()));
  const restored = f.make(undefined, persistence); t.after(() => restored.close());
  const until = restored.get().accounts[0].cooldownUntil;
  restored.recordFailure(refs[0], { kind: 'rate_limit', runID: 'run-durable-kv' });
  assert.equal(restored.get().accounts[0].cooldownUntil, until);
  const rows = JSON.stringify(store.db.prepare('SELECT body FROM kv').all());
  assert.equal(rows.includes('fixture-config-key-never-persist'), false); assert.equal(rows.includes('fixture-token'), false);
  store.putValue('unrelated-fixture', { preserved: true });
  assert.equal(JSON.stringify(persistence.load()), JSON.stringify(f.saved()));
});

test('a quota failure arriving during a request cannot be cleared by its earlier observation', async t => {
  const f = fixture(t);
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
  const pool = f.make(async url => {
    if (String(url).endsWith('/status')) { started(); await blocked; return json(body()); }
    return json({ config: { provider: { 'opencode-go': { options: { apiKey: 'fixture-go-key' } } } } });
  }); t.after(() => pool.close());
  const pending = pool.refresh(refs[0]); await began;
  pool.recordFailure(refs[0], { kind: 'quota', runID: 'run-arrived-during-request' }); release();
  await pending;
  assert.equal(pool.get().accounts[0].quota.status, 'exhausted'); assert.equal(pool.candidate(refs[1]), undefined);
  f.time(initial + 61_000); await pool.refresh(refs[0]);
  assert.equal(pool.get().accounts[0].quota.status, 'available'); assert.equal(pool.candidate(refs[1])!.account.accountID, 'account-a');
});


test('candidate freshness expires with native access token even when cached quota remains fresh', async t => {
  const f = fixture(t);
  f.db.prepare('UPDATE account SET token_expiry=? WHERE id=?').run(initial + 20_000, 'account-b');
  await f.pool.refresh(); assert.equal(f.pool.candidate(refs[0])!.account.accountID, 'account-b');
  f.time(initial + 21_000);
  assert.equal(f.pool.get().accounts[1].quota.stale, false);
  assert.equal(f.pool.get().accounts[1].goReady, false);
  assert.equal(f.pool.candidate(refs[0]), undefined);
});


test('close drains a refresh waiting on native listing and a late list failure cannot write to a closed store', async () => {
  let rejectList!: (error: Error) => void;
  const listing = new Promise<never>((_resolve, reject) => { rejectList = reject; });
  let storeClosed = false, saves = 0;
  const pool = new OpenCodeQuotaPool({
    accounts: { list: () => listing },
    persistence: { load: () => undefined, save: () => { assert.equal(storeClosed, false); saves++; } },
  });
  let settled = false;
  const refresh = pool.refresh().then(value => { settled = true; return value; });
  await pool.close();
  assert.equal(settled, true);
  storeClosed = true;
  rejectList(new Error('fixture late native transport failure'));
  await refresh;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(saves, 0);
  await assert.rejects(pool.refresh(), /已关闭/);
});

test('close drains active quota probes and ignores a transport result arriving after storage shutdown', async t => {
  const f = fixture(t);
  let release!: (response: Response) => void;
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
  let storeClosed = false, saves = 0;
  const pool = f.make(async () => { started(); return new Promise<Response>(resolve => { release = resolve; }); }, {
    load: () => undefined,
    save: () => { assert.equal(storeClosed, false); saves++; },
  });
  const refresh = pool.refresh(refs[0]); await began;
  await pool.close(); const before = saves;
  storeClosed = true; release(json(body()));
  await refresh;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(saves, before);
});
