import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { OpenCodeAccounts, officialVerificationUrl, parseOpenCodeSwitch } from '../../src/main/engines/opencode-accounts';
import type { OwnedScope } from '../../src/main/adapters/cli/scope';
import { openCodeConsoleDbPath } from '../../src/main/quota/opencode-console';

const active = { accountID: 'a', accountEmail: 'a@example.test', accountUrl: 'https://opencode.ai/console', orgID: 'one', orgName: 'One', active: true };
const target = { ...active, accountID: 'b', orgID: 'two', active: false };
function fixture(options: { login?: boolean; failRefresh?: boolean; timeout?: number } = {}) {
  let orgs = [active, target].map(o => ({ ...o })); let writes = 0; let killed = 0; let launches = 0; let login: OwnedScope | undefined;
  const scopes: OwnedScope[] = [];
  const service = new OpenCodeAccounts({
    confirmAbsent: async () => true,
    find: async () => '/fixture/opencode', loginTimeoutMs: options.timeout,
    start: input => {
      launches++;
      const scope = Object.assign(new EventEmitter(), { unit: input.unit, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { killed++; queueMicrotask(() => scope.emit('close', null)); return true; }, detach: () => {} }) as OwnedScope;
      scopes.push(scope);
      if (input.command.includes('login')) { login = scope; setImmediate(() => scope.stdout.emit('data', Buffer.from('Go to: https://opencode.ai/console/auth/device?user_code=ABCD\nEnter code: ABCD-EFGH\nsecret-refresh-token\n'))); }
      else setImmediate(() => scope.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:12345\n')));
      return scope;
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.redirect, 'error'); assert.match(String((init?.headers as Record<string, string>).authorization), /^Basic /);
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/orgs')) return Response.json({ orgs });
      if (path.endsWith('/switch')) { writes++; const body = JSON.parse(String(init?.body)); orgs = orgs.map(o => ({ ...o, active: o.accountID === body.accountID && o.orgID === body.orgID })); return Response.json(true); }
      return Response.json({ consoleManagedProviders: ['opencode-go'], switchableOrgCount: 2 });
    }) as typeof fetch,
    changed: async () => { if (options.failRefresh) throw Error('private-secret'); },
  });
  return { service, scopes, get writes() { return writes; }, get killed() { return killed; }, get launches() { return launches; }, finishLogin: (output = '') => { login!.stdout.emit('data', Buffer.from(output)); login!.emit('close', 0); } };
}
test('strict switch input and official authorization URL never accept arbitrary destinations', () => {
  assert.throws(() => parseOpenCodeSwitch({ accountID: 'a', orgID: 'one' }));
  assert.throws(() => parseOpenCodeSwitch({ accountID: 'a', orgID: 'one', expectedActive: null, url: 'secret' }));
  for (const url of ['http://opencode.ai/console/auth/device', 'https://evil.test/console/auth/device', 'https://opencode.ai.evil.test/auth/device', 'https://user:pass@opencode.ai/auth/device', 'https://opencode.ai/console/auth/device#token']) assert.equal(officialVerificationUrl(url), undefined);
  assert.ok(officialVerificationUrl('https://opencode.ai/console/auth/device?user_code=ABCD'));
});
test('native switch validates target and expected active before write; fresh helper verifies managed providers', async () => {
  const f = fixture();
  await assert.rejects(f.service.switchAccount({ accountID: 'b', orgID: 'one', expectedActive: { accountID: 'a', orgID: 'one' } }), /参数无效/);
  await assert.rejects(f.service.switchAccount({ accountID: 'b', orgID: 'two', expectedActive: null }), /已变化/);
  assert.equal(f.writes, 0);
  const before = f.launches;
  const snapshot = await f.service.switchAccount({ accountID: 'b', orgID: 'two', expectedActive: { accountID: 'a', orgID: 'one' } });
  assert.equal(f.launches - before, 2); assert.equal(snapshot.orgs.find(o => o.active)?.accountID, 'b'); assert.deepEqual(snapshot.consoleManagedProviders, ['opencode-go']); assert.match(snapshot.detail!, /新启动进程/);
  assert.equal(f.killed, f.launches); await f.service.close();
});
test('quota refresh failure reports the completed switch without rollback or secret', async () => {
  const f = fixture({ failRefresh: true }); const result = await f.service.switchAccount({ accountID: 'b', orgID: 'two', expectedActive: { accountID: 'a', orgID: 'one' } });
  assert.equal(f.writes, 1); assert.match(result.detail!, /账号已切换.*刷新失败/); assert.ok(!JSON.stringify(result).includes('private-secret')); await f.service.close();
});
test('login restores current job, serializes mutation, exposes only official link and cancels owned process', async () => {
  const f = fixture(); const job = f.service.startLogin(); assert.equal(f.service.startLogin().id, job.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  const current = f.service.getLogin({ id: 'current' })!; assert.equal(current.id, job.id); assert.equal(current.status, 'authorizing'); assert.equal(current.userCode, 'ABCD-EFGH'); assert.ok(!JSON.stringify(current).includes('secret-refresh-token'));
  await assert.rejects(f.service.switchAccount({ accountID: 'b', orgID: 'two', expectedActive: null }), /操作进行中/);
  const cancelled = await f.service.cancelLogin({ id: job.id }); assert.equal(cancelled.status, 'cancelled'); assert.equal(f.killed, 1); await f.service.close();
});
test('login timeout and runtime close terminate owned login scope', async () => {
  const f = fixture({ timeout: 5 }); f.service.startLogin(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.service.getLogin({ id: 'current' })!.status, 'failed'); assert.equal(f.killed, 1); await f.service.close();
  const g = fixture(); g.service.startLogin(); await new Promise(resolve => setTimeout(resolve, 10)); await g.service.close(); assert.equal(g.killed, 1); assert.equal(g.service.getLogin({ id: 'current' })!.status, 'cancelled');
});
test('OpenCode database override follows native absolute, relative and memory resolution', () => {
  const env = { HOME: '/fixture/home', XDG_DATA_HOME: '/fixture/data' };
  assert.equal(openCodeConsoleDbPath(env), '/fixture/data/opencode/opencode.db');
  assert.equal(openCodeConsoleDbPath({ ...env, OPENCODE_DB: '/isolated/custom.db' }), '/isolated/custom.db');
  assert.equal(openCodeConsoleDbPath({ ...env, OPENCODE_DB: 'custom.db' }), '/fixture/data/opencode/custom.db');
  assert.equal(openCodeConsoleDbPath({ ...env, OPENCODE_DB: ':memory:' }), ':memory:');
});

test('native authorization denied with exit zero never reports successful login', async () => {
  const f = fixture(); f.service.startLogin(); await new Promise(resolve => setTimeout(resolve, 10)); f.finishLogin('Authorization denied\n');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.service.getLogin({ id: 'current' })!.status, 'failed'); await f.service.close();
  const g = fixture(); g.service.startLogin(); await new Promise(resolve => setTimeout(resolve, 10)); g.finishLogin('Logged in as fixture@example.test\n');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(g.service.getLogin({ id: 'current' })!.status, 'succeeded'); await g.service.close();
});

test('RPC entry rejects untrusted switch input without invoking a native write', async () => {
  const { createRpcHandlers } = await import('../../src/main/transport/handlers');
  const f = fixture();
  const handlers = createRpcHandlers({ openCodeAccounts: f.service, track: <T>(p: Promise<T>) => p } as Parameters<typeof createRpcHandlers>[0]);
  await assert.rejects(Promise.resolve().then(() => handlers.switchOpenCodeAccount({} as never, [{ accountID: 'a', orgID: 'one', expectedActive: null, env: { OPENCODE_DB: 'elsewhere' } }])), /参数无效/);
  assert.equal(f.launches, 0); assert.equal(handlers.getOpenCodeLogin({} as never, [{ id: 'current' }]), null); await f.service.close();
});
