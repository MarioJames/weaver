import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startRuntime } from '../../src/main/runtime';
import { OpenCodeAccounts, parseOpenCodeSwitch, type OpenCodeAccountsOptions } from '../../src/main/engines/opencode-accounts';
import { OpenCodeQuotaPool, type OpenCodeQuotaPoolOptions } from '../../src/main/quota/opencode-pool';
import { QuotaProber } from '../../src/main/quota';
import type { OpenCodeAccountQuotas, OpenCodeAccountRef } from '../../src/shared/contracts/opencode-account-quotas';

test('real HTTP account-quota RPC validates selectors; viewing B does not switch active A', async () => {
 const root = mkdtempSync(join(process.env.ACCEPTANCE_TMPDIR ?? tmpdir(), 'rpc-'));
 mkdirSync(join(root, 'renderer')); writeFileSync(join(root, 'renderer', 'index.html'), '<html></html>');
 const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), OPENCODE_DB: 'isolated.db' };
 let actual: OpenCodeAccountRef = { accountID: 'a', orgID: 'one' }; let switches = 0; let lists = 0; let refreshes = 0;
 const snapshot: OpenCodeAccountQuotas = { active: actual, switching: false, accounts: ['a', 'b'].map((accountID, i) => ({ account: { accountID, orgID: i ? 'two' : 'one', accountEmail: `${accountID}@example.test`, accountUrl: 'https://opencode.ai/console', orgName: i ? 'Two' : 'One', active: !i }, goReady: true, cooldownUntil: null, quota: { engine: 'opencode', status: 'available', source: 'fixture', stale: false, checkedAt: new Date().toISOString(), observedAt: new Date().toISOString(), windows: [], detail: '', retryAt: null } })) };
 class NativeFixture extends OpenCodeAccounts {
  constructor(private readonly config: OpenCodeAccountsOptions) { super(config); }
  override async list() { lists++; const result = { orgs: snapshot.accounts.map(a => ({ ...a.account, active: a.account.accountID === actual.accountID })), consoleManagedProviders: ['opencode-go'], switchableOrgCount: 2 }; this.config.observed?.(result); return result; }
  override async switchAccount(value: unknown) { const input = parseOpenCodeSwitch(value); const release = this.config.mutationGuard?.(); try { switches++; actual = input; const result = await this.list(); await this.config.changed?.(result); return result; } finally { release?.(); } }
 }
 class PoolFixture extends OpenCodeQuotaPool {
  constructor(private readonly config: OpenCodeQuotaPoolOptions) { super(config); }
  override get() { return structuredClone(snapshot); }
  override setActive(ref: OpenCodeAccountRef | null) { snapshot.active = ref; }
  override setSwitching(value: boolean, detail?: string) { snapshot.switching = value; snapshot.detail = detail; }
  override async refresh() { refreshes++; await this.config.accounts.list(); return this.get(); }
 }
 const runtime = await startRuntime({ dataDir: root, port: 0, rendererRoot: join(root, 'renderer'), quotaProber: new QuotaProber({ env }), openCode: { env, accountsFactory: config => new NativeFixture(config), poolFactory: config => new PoolFixture(config), readActive: () => actual, externalBusy: () => undefined } });
 const rpc = async (method: string, args: unknown[] = []) => { const response = await fetch(`${runtime.url}/api/rpc`, { method: 'POST', headers: { origin: runtime.url, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) }); return await response.json() as { ok: boolean; result?: OpenCodeAccountQuotas; error?: { code: string } }; };
 try {
  const initial = await rpc('getOpenCodeAccountQuotas'); assert.equal(initial.error, undefined); assert.equal(lists, 0); assert.equal(refreshes, 0);
  const viewing = await rpc('refreshOpenCodeAccountQuotas', [{ accountID: 'b', orgID: 'two' }]); assert.equal(viewing.error, undefined); assert.equal(viewing.result?.active?.accountID, 'a'); assert.equal(switches, 0);
  for (const input of [{ accountID: 'b' }, { orgID: 'two' }, { accountID: 'b', orgID: 'two', url: 'https://evil.test' }, { token: 'never-forward' }]) { const invalid = await rpc('refreshOpenCodeAccountQuotas', [input]); assert.ok(invalid.error); assert.equal(invalid.error?.code, 'INVALID_REQUEST'); }
  assert.equal(refreshes, 1);
  const changed = await rpc('switchOpenCodeAccount', [{ accountID: 'b', orgID: 'two', expectedActive: actual }]); assert.equal(changed.error, undefined); assert.equal(switches, 1);
  const after = await rpc('getOpenCodeAccountQuotas'); assert.equal(after.result?.active?.accountID, 'b');
 } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('native factory injection alone cannot authorize default credential readers in runtime tests', async () => {
 const root = mkdtempSync(join(process.env.ACCEPTANCE_TMPDIR ?? tmpdir(), 'rpc-')); let nativeLists = 0;
 mkdirSync(join(root, 'renderer')); writeFileSync(join(root, 'renderer', 'index.html'), '<html></html>');
 class NativeOnly extends OpenCodeAccounts { override async list() { nativeLists++; return { orgs: [], consoleManagedProviders: [], switchableOrgCount: 0 }; } }
 const runtime = await startRuntime({ dataDir: root, rendererRoot: join(root, 'renderer'), port: 0, openCode: { accountsFactory: config => new NativeOnly(config), externalBusy: () => undefined } });
 const call = async (method: string, args: unknown[] = []) => await (await fetch(`${runtime.url}/api/rpc`, { method: 'POST', headers: { origin: runtime.url, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) })).json() as { result?: unknown; error?: { code: string } };
 try {
  assert.equal((await call('getOpenCodeAccountQuotas')).error, undefined); assert.equal(nativeLists, 0);
  assert.equal((await call('refreshOpenCodeAccountQuotas', [{}])).error?.code, 'OPENCODE_TEST_ISOLATION');
  assert.equal((await call('refreshQuota', [{ engine: 'opencode' }])).error?.code, 'OPENCODE_TEST_ISOLATION'); assert.equal(nativeLists, 0);
  assert.equal((await call('listOpenCodeAccounts')).error, undefined); assert.equal(nativeLists, 1);
 } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an unreadable native account cursor degrades OpenCode state without preventing Weaver startup', async () => {
 const { TaskStore } = await import('../../src/main/store'); const { createHash } = await import('node:crypto');
 const root = mkdtempSync(join(process.env.ACCEPTANCE_TMPDIR ?? tmpdir(), 'rpc-'));
 mkdirSync(join(root, 'renderer')); writeFileSync(join(root, 'renderer', 'index.html'), '<html></html>');
 const file = join(root, 'broken-native.db'); writeFileSync(file, 'not a sqlite database');
 const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), OPENCODE_DB: file };
 const account = { accountID: 'fixture-a', orgID: 'fixture-org', accountEmail: 'fixture@example.test', accountUrl: 'https://opencode.ai/console', orgName: 'fixture', active: true };
 const key = createHash('sha256').update(JSON.stringify([file, 'https://opencode.ai/console', account.accountID, account.orgID])).digest('hex');
 const store = new TaskStore(join(root, 'weaver.db')); store.putValue('opencode-account-pool', { accounts: [{ key, account, goReady: false, managedAt: 0, configNext: 0, seenRuns: [] }] }); store.close();
 const runtime = await startRuntime({ dataDir: root, rendererRoot: join(root, 'renderer'), port: 0, openCode: { env, externalBusy: () => undefined } });
 const call = async (method: string) => await (await fetch(`${runtime.url}/api/rpc`, { method: 'POST', headers: { origin: runtime.url, 'content-type': 'application/json' }, body: JSON.stringify({ method, args: [] }) })).json() as { result?: OpenCodeAccountQuotas; error?: unknown };
 try {
  assert.equal((await call('getPolicy')).error, undefined);
  const state = await call('getOpenCodeAccountQuotas'); assert.equal(state.error, undefined); assert.equal(state.result?.active, null); assert.match(state.result?.detail ?? '', /无法确认原生账号游标/); assert.equal(state.result?.accounts[0]?.quota.stale, true);
 } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
