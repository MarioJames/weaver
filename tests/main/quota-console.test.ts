import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { QuotaProber } from '../../src/main/quota';
import { readNativeCredential } from '../../src/main/quota/credentials';
import { VERSION } from '../../src/shared/version';

const start = Date.parse('2026-10-18T12:00:00Z');
// Synthetic windows only: fixed-clock-relative resets and small integer ratios.
// Real production meter values must never enter committed fixtures.
const reset5h = '2026-10-18T17:00:00.000Z';
const resetWeek = '2026-10-25T12:00:00.000Z';
const resetMonth = '2026-11-17T12:00:00.000Z';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const consoleBody = (five = ['120', '1200', reset5h], week = ['360', '1200', resetWeek], month = ['600', '1200', resetMonth]) => ({
  subscriberUserId: 'sub-secret',
  paymentMethodId: 'pm-secret',
  useBalance: false,
  access: {
    meters: {
      fiveHour: { usedMicroCents: five[0], limitMicroCents: five[1], resetsAt: five[2] },
      week: { usedMicroCents: week[0], limitMicroCents: week[1], resetsAt: week[2] },
      month: { usedMicroCents: month[0], limitMicroCents: month[1], resetsAt: month[2] },
    },
  },
});

function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), 'wqc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root };
  const dir = join(root, '.local', 'share', 'opencode');
  mkdirSync(dir, { recursive: true });
  const dbFile = join(dir, 'opencode.db');
  const nativeDb = (opts: { accountId?: string; orgId?: string | null; url?: string; token?: string; expiry?: number | null; refresh?: string; rows?: number } = {}) => {
    try { rmSync(dbFile); } catch { /* fresh */ }
    try { rmSync(`${dbFile}-wal`); } catch { /* fresh */ }
    try { rmSync(`${dbFile}-shm`); } catch { /* fresh */ }
    const db = new DatabaseSync(dbFile);
    db.exec(
      'CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL, url text NOT NULL, access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer, time_created integer NOT NULL, time_updated integer NOT NULL)',
    );
    db.exec(
      'CREATE TABLE account_state (id integer PRIMARY KEY, active_account_id text, active_org_id text, CONSTRAINT fk_account_state_active_account_id_account_id_fk FOREIGN KEY (active_account_id) REFERENCES account(id) ON DELETE SET NULL)',
    );
    const accountId = opts.accountId ?? 'acc_01234567890123456789012345';
    const orgId = opts.orgId === undefined ? 'wrk_01234567890123456789012345' : opts.orgId;
    db.prepare('INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      accountId, 'fixture@example.invalid', opts.url ?? 'https://opencode.ai/console', opts.token ?? 'secret-console',
      opts.refresh ?? 'refresh-fixture', opts.expiry === undefined ? start + 86_400_000 : opts.expiry, 1, 1,
    );
    const count = opts.rows ?? 1;
    for (let index = 0; index < count; index++) {
      db.prepare('INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (?, ?, ?)').run(
        index + 1, accountId, orgId,
      );
    }
    db.close();
    return { accountId, dbFile };
  };
  const apiKey = (key = 'secret-apikey-file') => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key } }));
  };
  return { root, env, dir, dbFile, nativeDb, apiKey };
}

test('active Console login uses only the fixed same-origin GET and projects safe percent windows', async t => {
  const f = fixture(t);
  f.nativeDb();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const prober = new QuotaProber({
    env: f.env, now: () => new Date(start), fetch: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return json(consoleBody());
    },
  });
  t.after(() => prober.close());
  const record = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(record.source, 'opencode_console_status');
  assert.deepEqual(requests.map(r => r.url), ['https://opencode.ai/console/api/go/status']);
  const init = requests[0].init;
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.body, undefined);
  const headers = new Headers(init.headers);
  assert.equal(headers.get('Authorization'), 'Bearer secret-console');
  assert.equal(headers.get('x-org-id'), 'wrk_01234567890123456789012345');
  assert.equal(headers.get('Accept'), 'application/json');
  assert.equal(headers.get('User-Agent'), `Weaver/${VERSION}`);
  assert.equal(record.status, 'available');
  assert.deepEqual(record.windows.map(w => w.id), ['opencode:rolling', 'opencode:weekly', 'opencode:monthly']);
  assert.equal(record.windows[0].usedPercent, 10);
  assert.equal(record.windows[0].remainingPercent, 90);
  assert.equal(record.windows[0].durationMinutes, 300);
  assert.equal(record.windows[1].durationMinutes, 10080);
  assert.equal(record.windows[2].durationMinutes, null);
  assert.deepEqual(record.windows.map(w => w.resetsAt), [reset5h, resetWeek, resetMonth]);
  assert.ok(record.windows.every(w => w.scope === 'account' && w.model === null && w.unit === 'percent' && w.used === null && w.total === null && w.remaining === null));
  assert.doesNotMatch(JSON.stringify(record), /secret-console|sub-secret|pm-secret|wrk_0123|acc_0123|refresh-fixture|fixture@example|USD|balance/i);
});

test('active Console wins over a stale file API key without mixing accounts', async t => {
  const f = fixture(t);
  f.nativeDb({ token: 'secret-console-live' });
  f.apiKey('secret-apikey-stale');
  const seen: string[] = [];
  const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async (_url, init) => { seen.push(new Headers(init!.headers).get('Authorization')!); return json(consoleBody()); } });
  t.after(() => prober.close());
  const record = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(record.source, 'opencode_console_status');
  assert.deepEqual(seen, ['Bearer secret-console-live']);
  assert.doesNotMatch(JSON.stringify(record), /secret-apikey-stale/);
});

test('without an active Console login the verified API-key path is kept', async t => {
  const f = fixture(t);
  f.apiKey();
  const urls: string[] = [];
  const prober = new QuotaProber({
    env: f.env, now: () => new Date(start), fetch: async (url) => {
      urls.push(String(url));
      return json({ usage: { rolling: { status: 'ok', percent: 1, resetsAt: resetWeek }, weekly: { status: 'ok', percent: 2, resetsAt: resetWeek }, monthly: { status: 'ok', percent: 3, resetsAt: resetWeek } } });
    },
  });
  t.after(() => prober.close());
  const record = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(record.source, 'opencode_go_usage');
  assert.deepEqual(urls, ['https://opencode.ai/zen/go/v1/usage']);
  assert.equal(record.status, 'available');
});

test('foreign origins, missing org and ambiguous state never send the Console token', async t => {
  const f = fixture(t);
  for (const setup of [
    () => f.nativeDb({ url: 'https://selfhosted.invalid/console' }),
    () => f.nativeDb({ url: 'https://opencode.ai/console/' , token: 'trailing-slash-ok' }),
    () => f.nativeDb({ orgId: null }),
    () => f.nativeDb({ rows: 2 }),
  ]) {
    setup();
    let calls = 0;
    const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => { calls++; return json(consoleBody()); } });
    const record = (await prober.refresh({ engine: 'opencode' })).records[3];
    await prober.close();
    if (record.source === 'opencode_console_status') {
      assert.equal(record.status, 'available', 'trailing-slash official origin is the same origin');
      assert.equal(calls, 1);
    } else {
      assert.equal(record.status, 'unsupported');
      assert.equal(calls, 0);
    }
    assert.doesNotMatch(JSON.stringify(record), /selfhosted|secret-console|trailing-slash-ok/);
  }
  f.nativeDb({ url: 'https://opencode.ai.evil.invalid/console' });
  let calls = 0;
  const evil = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async () => { calls++; return json(consoleBody()); } });
  t.after(() => evil.close());
  assert.equal((await evil.refresh({ engine: 'opencode' })).records[3].status, 'unsupported');
  assert.equal(calls, 0);
});

test('present-but-unusable Console state never falls back to a legacy file key from another account', async t => {
  // Owner-reproduced cross-account fallback: with a legacy Go API key on disk,
  // a missing org and ambiguous account_state rows each yielded requests=1 and
  // status available on the other account's key. Every such case must stay at
  // 0 requests with a safe non-available status.
  const keyUsage = { usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: resetWeek },
    weekly: { status: 'ok', percent: 2, resetsAt: resetWeek },
    monthly: { status: 'ok', percent: 3, resetsAt: resetWeek },
  } };
  const setups: Array<{ name: string; db: (f: ReturnType<typeof fixture>) => void }> = [
    { name: 'missing org', db: f => { f.nativeDb({ orgId: null }); } },
    { name: 'ambiguous state rows', db: f => { f.nativeDb({ rows: 2 }); } },
    { name: 'corrupt database file', db: f => { writeFileSync(f.dbFile, 'not a sqlite database'); } },
  ];
  for (const setup of setups) {
    const f = fixture(t);
    setup.db(f);
    f.apiKey('secret-apikey-other-account');
    let calls = 0;
    const urls: string[] = [];
    const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async (url) => { calls++; urls.push(String(url)); return json(keyUsage); } });
    const record = (await prober.refresh({ engine: 'opencode' })).records[3];
    await prober.close();
    assert.equal(calls, 0, `${setup.name}: must not send any request, not even with the legacy file key`);
    assert.equal(record.status, 'unsupported', `${setup.name}: present-but-unusable Console state fails closed, never available`);
    assert.deepEqual(urls, []);
    assert.doesNotMatch(JSON.stringify(record), /secret-apikey-other-account/);
  }
});

test('a non-empty but invalid active account never falls back to another key; null/empty still allows the verified key path', async t => {
  const keyUsage = { usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: resetWeek },
    weekly: { status: 'ok', percent: 2, resetsAt: resetWeek },
    monthly: { status: 'ok', percent: 3, resetsAt: resetWeek },
  } };
  const setActive = (f: ReturnType<typeof fixture>, value: string | null) => {
    const db = new DatabaseSync(f.dbFile);
    // The native app writes with enforcement off, so a dangling cursor can exist; mirror that.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE account_state SET active_account_id = ?').run(value);
    db.close();
  };
  // Present-but-invalid cursor: must fail closed with zero requests, never the other account's key.
  const bad = fixture(t);
  bad.nativeDb();
  setActive(bad, 'acc with space');
  bad.apiKey('secret-apikey-other-account');
  let calls = 0;
  const badProber = new QuotaProber({ env: bad.env, now: () => new Date(start), fetch: async () => { calls++; return json(keyUsage); } });
  const badRecord = (await badProber.refresh({ engine: 'opencode' })).records[3];
  await badProber.close();
  assert.equal(calls, 0, 'non-empty invalid active account must not send any request');
  assert.equal(badRecord.status, 'unsupported');
  assert.doesNotMatch(JSON.stringify(badRecord), /secret-apikey-other-account/);
  // Genuinely no active account (NULL or empty): the verified API-key path is kept.
  for (const empty of [null, ''] as const) {
    const f = fixture(t);
    f.nativeDb();
    setActive(f, empty);
    f.apiKey();
    const urls: string[] = [];
    const prober = new QuotaProber({ env: f.env, now: () => new Date(start), fetch: async (url) => { urls.push(String(url)); return json(keyUsage); } });
    const record = (await prober.refresh({ engine: 'opencode' })).records[3];
    await prober.close();
    assert.equal(record.source, 'opencode_go_usage', `empty active ${empty === null ? 'NULL' : "''"} keeps the key path`);
    assert.deepEqual(urls, ['https://opencode.ai/zen/go/v1/usage']);
    assert.equal(record.status, 'available');
  }
});

test('Console 200 then failure or renewal keeps stale windows under the Console source; first Console failure is labeled Console', async t => {
  const f = fixture(t);
  f.nativeDb();
  let mode: 'ok' | 'down' | 'limited' = 'ok';
  let now = start;
  let calls = 0;
  const prober = new QuotaProber({
    env: f.env, now: () => new Date(now), fetch: async () => {
      calls++;
      if (mode === 'ok') return json(consoleBody());
      if (mode === 'limited') return json({ error: { type: 'Busy' } }, 429);
      return json({ error: { type: 'Busy' } }, 503);
    },
  });
  t.after(() => prober.close());
  const first = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(first.source, 'opencode_console_status');
  assert.equal(first.status, 'available');
  assert.equal(first.windows.length, 3);
  for (const next of ['down', 'limited'] as const) {
    mode = next; now += 61000;
    const stale = (await prober.refresh({ engine: 'opencode' })).records[3];
    assert.equal(stale.source, 'opencode_console_status', `${next}: stale retention must keep the real Console source`);
    assert.equal(stale.stale, true);
    assert.equal(stale.windows.length, 3);
    assert.deepEqual(stale.windows.map(w => w.usedPercent), first.windows.map(w => w.usedPercent));
  }
  // Expired Console token with a refresh marker keeps the same account's stale Console reading.
  const db = new DatabaseSync(f.dbFile);
  db.prepare('UPDATE account SET token_expiry = ?').run(start - 1);
  db.close();
  now += 61000;
  const renewal = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(renewal.source, 'opencode_console_status', 'renewal retention must keep the real Console source');
  assert.equal(renewal.stale, true);
  assert.equal(renewal.windows.length, 3);
  assert.equal(calls, 3, 'renewal must not send any request');
  // First-request failure with an identified Console login is still labeled Console.
  const f2 = fixture(t);
  f2.nativeDb();
  const prober2 = new QuotaProber({ env: f2.env, now: () => new Date(start), fetch: async () => json({ error: { type: 'Busy' } }, 503) });
  t.after(() => prober2.close());
  const failed = (await prober2.refresh({ engine: 'opencode' })).records[3];
  assert.equal(failed.source, 'opencode_console_status');
  assert.equal(failed.status, 'error');
  assert.equal(failed.windows.length, 0);
});

test('Console reading is read-only and honors seconds and millisecond expiries', async t => {
  const f = fixture(t);
  f.nativeDb({ expiry: Math.floor(start / 1000) + 3600, refresh: 'r' });
  const before = readFileSync(f.dbFile);
  const valid = await readNativeCredential('opencode', f.env, start);
  assert.equal(valid.opencodeKind, 'console');
  assert.equal(readFileSync(f.dbFile).equals(before), true, 'Weaver only reads the native Console database');
  assert.doesNotMatch(`${valid.fingerprint}${valid.account}`, /secret-console|r/);
  f.nativeDb({ expiry: start + 3600_000, refresh: 'r' });
  assert.equal((await readNativeCredential('opencode', f.env, start)).opencodeKind, 'console');
  f.nativeDb({ expiry: Math.floor(start / 1000) - 1, refresh: 'r' });
  await assert.rejects(() => readNativeCredential('opencode', f.env, start), (error: unknown) => {
    const pending = error as { constructor: { name: string }; account: string; message: string };
    assert.equal(pending.constructor.name, 'QuotaRenewalPending');
    assert.doesNotMatch(`${pending.message}${pending.account}`, /secret-console|\br\b/);
    return true;
  });
  assert.equal(readFileSync(f.dbFile).length > 0, true);
  f.nativeDb({ expiry: start - 1, refresh: '' });
  await assert.rejects(() => readNativeCredential('opencode', f.env, start), /重新登录/);
});

test('Console shape errors fail closed without dollars or identifiers', async t => {
  const f = fixture(t);
  f.nativeDb();
  let body: unknown = consoleBody();
  let now = start;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => json(body) });
  t.after(() => prober.close());
  now += 60001;
  body = consoleBody(undefined, undefined, ['1300', '1200', resetMonth]);
  let record = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(record.status, 'exhausted');
  assert.equal(record.windows[2].usedPercent, 100);
  assert.match(record.detail, /仅指 Go 套餐窗口|不代表/);
  for (const malformed of [
    consoleBody(['1', '0', reset5h]),
    consoleBody(['-1', '1200000000', reset5h]),
    consoleBody(['12.5', '1200000000', reset5h]),
    consoleBody(['99999999999999999999999999', '1200000000', reset5h]),
    { access: { meters: { fiveHour: { usedMicroCents: '1', limitMicroCents: '2', resetsAt: 'not-a-date' }, week: { usedMicroCents: '1', limitMicroCents: '2', resetsAt: resetWeek }, month: { usedMicroCents: '1', limitMicroCents: '2', resetsAt: resetMonth } } } },
    { access: { meters: { week: { usedMicroCents: '1', limitMicroCents: '2', resetsAt: resetWeek }, month: { usedMicroCents: '1', limitMicroCents: '2', resetsAt: resetMonth } } } },
    { usage: { rolling: { status: 'ok', percent: 1, resetsAt: reset5h }, weekly: { status: 'ok', percent: 1, resetsAt: resetWeek }, monthly: { status: 'ok', percent: 1, resetsAt: resetWeek } } },
    {},
  ]) {
    now += 60001;
    body = malformed;
    record = (await prober.refresh({ engine: 'opencode' })).records[3];
    assert.equal(record.status, 'unknown', JSON.stringify(malformed).slice(0, 120));
    assert.equal(record.windows.length, 0);
  }
  assert.doesNotMatch(JSON.stringify(prober.get()), /USD|sub-secret|pm-secret/);
});

test('Console auth and network failures stay on the same login without falling back to the file key', async t => {
  const f = fixture(t);
  f.nativeDb({ token: 'secret-console-live' });
  f.apiKey('secret-apikey-stale');
  let mode = 0;
  let now = start;
  let calls = 0;
  const prober = new QuotaProber({
    env: f.env, now: () => new Date(now), fetch: async () => {
      calls++;
      if (mode === 0) return json({ error: { type: 'AuthError' } }, 401);
      if (mode === 1) return json({ error: { type: 'Forbidden' } }, 403);
      throw new Error('down');
    },
  });
  t.after(() => prober.close());
  assert.equal((await prober.refresh({ engine: 'opencode' })).records[3].status, 'unauthenticated');
  mode = 1; now += 60001;
  const forbidden = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(forbidden.status, 'unsupported');
  assert.match(forbidden.detail, /权限|订阅/);
  mode = 2; now += 60001;
  assert.equal((await prober.refresh({ engine: 'opencode' })).records[3].status, 'error');
  assert.equal(calls, 3, 'a failing Console login must not retry with the stale file key');
});

test('switching the active Console account drops the previous reading like other engines', async t => {
  const f = fixture(t);
  f.nativeDb({ accountId: 'acc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', token: 'secret-first' });
  let now = start;
  let calls = 0;
  const prober = new QuotaProber({ env: f.env, now: () => new Date(now), fetch: async () => { calls++; return json(consoleBody()); } });
  t.after(() => prober.close());
  assert.equal((await prober.refresh({ engine: 'opencode' })).records[3].status, 'available');
  f.nativeDb({ accountId: 'acc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', token: 'secret-second' });
  now += 1000;
  const changed = (await prober.refresh({ engine: 'opencode' })).records[3];
  assert.equal(calls, 1);
  assert.equal(changed.status, 'unknown');
  assert.equal(changed.windows.length, 0);
  assert.equal(changed.observedAt, null);
});
