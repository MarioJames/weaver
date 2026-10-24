import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OpenCodeAccounts } from '../../src/main/engines/opencode-accounts';

// Explicit opt-in runs the installed CLI only against a disposable, task-owned HOME/data/database.
test('native isolated account listing preserves conversation and other provider authentication', { skip: !process.env.WEAVER_OPENCODE_NATIVE_TEST_ROOT }, async () => {
  const root = mkdtempSync(join(process.env.WEAVER_OPENCODE_NATIVE_TEST_ROOT!, 'native-'));
  const data = join(root, 'data'); const home = join(root, 'home'); const config = join(root, 'config');
  mkdirSync(join(data, 'opencode'), { recursive: true }); mkdirSync(home); mkdirSync(config);
  const authPath = join(data, 'opencode', 'auth.json'); const auth = JSON.stringify({ fixture: { type: 'api', key: 'isolated-fixture-not-a-real-key' } }); writeFileSync(authPath, auth, { mode: 0o600 });
  let seeded = false;
  const service = new OpenCodeAccounts({ env: { ...process.env, HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENCODE_DB: 'fixture.db', OPENCODE_AUTH_CONTENT: undefined, OPENCODE_CONFIG_CONTENT: undefined }, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    if (!seeded) {
      seeded = true;
      const response = await fetch(new URL('/session', String(url)), { ...init, method: 'POST', body: JSON.stringify({ title: 'fixture conversation preserved' }) });
      assert.equal(response.status, 200);
    }
    return fetch(url, init);
  }) as typeof fetch });
  try {
    const snapshot = await service.list(); assert.deepEqual(snapshot.orgs, []);
    const file = join(data, 'opencode', 'fixture.db');
    const db = new DatabaseSync(file, { readOnly: true }); const before = db.prepare('SELECT * FROM session').all(); db.close(); assert.equal(before.length, 1);
    await assert.rejects(service.switchAccount({ accountID: 'unknown', orgID: 'unknown', expectedActive: null }), /参数无效/);
    const reopened = new DatabaseSync(file, { readOnly: true }); assert.deepEqual(reopened.prepare('SELECT * FROM session').all(), before); reopened.close();
    assert.equal(readFileSync(authPath, 'utf8'), auth);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('native switch writes only its cursor while isolated conversation and other provider auth stay intact', { skip: !process.env.WEAVER_OPENCODE_NATIVE_TEST_ROOT }, async () => {
  const root = mkdtempSync(join(process.env.WEAVER_OPENCODE_NATIVE_TEST_ROOT!, 'native-switch-'));
  const data = join(root, 'data'); const home = join(root, 'home');
  mkdirSync(join(data, 'opencode'), { recursive: true }); mkdirSync(home);
  const authPath = join(data, 'opencode', 'auth.json'); const auth = JSON.stringify({ other: { type: 'api', key: 'not-a-real-fixture-key' } }); writeFileSync(authPath, auth, { mode: 0o600 });
  const file = join(data, 'opencode', 'fixture.db'); let seeded = false; let switched = false; let before: unknown[] = []; let messages: unknown[] = [];
  const service = new OpenCodeAccounts({ env: { ...process.env, HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENCODE_DB: 'fixture.db', OPENCODE_AUTH_CONTENT: undefined, OPENCODE_CONFIG_CONTENT: undefined }, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    const nativeUrl = new URL(String(url)); assert.equal(nativeUrl.hostname, '127.0.0.1');
    if (!seeded) {
      seeded = true; const session = await fetch(new URL('/session', nativeUrl), { ...init, method: 'POST', body: JSON.stringify({ title: 'keep native conversation' }) }); assert.equal(session.status, 200);
      const db = new DatabaseSync(file); before = db.prepare('SELECT * FROM session').all();
      // Localhost-only fake account URLs ensure even unexpected native config reads cannot reach official services.
      db.prepare('INSERT INTO account(id,email,url,access_token,refresh_token,token_expiry,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)').run('fixture-a', 'a@example.test', 'http://127.0.0.1:9', 'not-a-real-access-a', 'not-a-real-refresh-a', Date.now() + 3600_000, Date.now(), Date.now());
      db.prepare('INSERT INTO account(id,email,url,access_token,refresh_token,token_expiry,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)').run('fixture-b', 'b@example.test', 'http://127.0.0.1:9', 'not-a-real-access-b', 'not-a-real-refresh-b', Date.now() + 3600_000, Date.now(), Date.now());
      const sessionID = (before[0] as { id: string }).id;
      db.prepare('INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)').run('fixture-message', sessionID, Date.now(), Date.now(), JSON.stringify({ role: 'user', parts: [] }));
      messages = db.prepare('SELECT * FROM message').all(); db.close();
    }
    if (nativeUrl.pathname.endsWith('/switch')) { const response = await fetch(url, init); assert.equal(response.status, 200); switched = true; return response; }
    if (nativeUrl.pathname.endsWith('/orgs')) return Response.json({ orgs: ['a', 'b'].map(name => ({ accountID: `fixture-${name}`, orgID: `org-${name}`, accountEmail: `${name}@example.test`, accountUrl: 'https://opencode.ai/console', orgName: name, active: switched && name === 'b' })) });
    return Response.json({ consoleManagedProviders: ['opencode-go'], switchableOrgCount: 2 });
  }) as typeof fetch });
  try {
    const result = await service.switchAccount({ accountID: 'fixture-b', orgID: 'org-b', expectedActive: null }); assert.equal(result.orgs.find(org => org.active)?.accountID, 'fixture-b');
    const db = new DatabaseSync(file, { readOnly: true }); assert.equal(db.prepare('SELECT active_account_id FROM account_state WHERE id=1').get()?.active_account_id, 'fixture-b'); assert.equal(db.prepare('SELECT active_org_id FROM account_state WHERE id=1').get()?.active_org_id, 'org-b'); assert.deepEqual(db.prepare('SELECT * FROM session').all(), before); assert.deepEqual(db.prepare('SELECT * FROM message').all(), messages); db.close(); assert.equal(readFileSync(authPath, 'utf8'), auth);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
