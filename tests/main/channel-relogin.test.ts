import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { ChannelLogins } from '../../src/main/channels/login';
import { ChannelService } from '../../src/main/channels/service';
import { ChannelStore } from '../../src/main/channels/store';
import { prepareChannelRun, cleanupChannelRun } from '../../src/main/channels/runtime';
import { PolicyStore } from '../../src/main/policy/store';
import type { OwnedScope } from '../../src/main/adapters/cli/scope';
import type { ChannelBinding } from '../../src/main/channels/runtime';

const token = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;

function temp(): string { return mkdtempSync(join(tmpdir(), 'weaver-relogin-')); }
function hash(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function writeOpenCodeDb(file: string, account: string, org: string, key = 'fixture-go-key'): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)`);
    db.exec(`CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL, url text NOT NULL, access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer, time_created integer NOT NULL, time_updated integer NOT NULL)`);
    db.exec('CREATE TABLE account_state (id integer PRIMARY KEY, active_account_id text, active_org_id text)');
    const now = Date.now();
    db.prepare('INSERT INTO credential VALUES (?,?,?,?,?,?,?,?,?)').run(`cred_${account}`, 'opencode-go', 'OpenCode Go', JSON.stringify({ type: 'key', key }), null, null, 1, now, now);
    db.prepare('INSERT INTO account VALUES (?,?,?,?,?,?,?,?)').run(account, 'fixture@example.invalid', 'https://opencode.ai/console', 'access-fixture', 'refresh-fixture', now + 86_400_000, now, now);
    db.prepare('INSERT INTO account_state VALUES (?,?,?)').run(1, account, org);
  } finally { db.close(); }
}

interface EngineCase {
  engine: 'codex' | 'claude' | 'grok' | 'opencode' | 'qoder';
  prepare(root: string, identity: string): void;
  file(root: string): string;
  capture(identity: string): (exe: string, args: readonly string[], timeout: number, limit: number, env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; overflow: boolean }>;
}

const cases: EngineCase[] = [
  {
    engine: 'codex',
    prepare: (root, identity) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: identity, access_token: token(identity), refresh_token: 'refresh' } }));
    },
    file: root => join(root, 'auth.json'),
    capture: () => async () => ({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '', timedOut: false, overflow: false }),
  },
  {
    engine: 'claude',
    prepare: (root, identity) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 86_400_000 } }));
      writeFileSync(join(root, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: identity, organizationUuid: 'org-fixture' } }));
    },
    file: root => join(root, '.claude.json'),
    capture: identity => async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: `${identity}@example.invalid` }), stderr: '', timedOut: false, overflow: false }),
  },
  {
    engine: 'grok',
    prepare: (root, identity) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'auth.json'), JSON.stringify({
        [`https://auth.x.ai::${identity}`]: { auth_mode: 'oidc', key: token(identity), refresh_token: 'refresh', oidc_issuer: 'https://auth.x.ai', client_id: 'fixture' },
      }));
    },
    file: root => join(root, 'auth.json'),
    capture: () => async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, overflow: false }),
  },
  {
    engine: 'opencode',
    prepare: (root, identity) => {
      mkdirSync(root, { recursive: true });
      writeOpenCodeDb(join(root, 'opencode.db'), identity, `org-${identity}`);
    },
    file: root => join(root, 'opencode.db'),
    capture: () => async () => ({ code: 0, stdout: 'opencode-go/deepseek-v4.1-flash\n', stderr: '', timedOut: false, overflow: false }),
  },
  {
    engine: 'qoder',
    prepare: (root, identity) => {
      mkdirSync(join(root, '.auth'), { recursive: true });
      writeFileSync(join(root, '.auth', 'user'), identity);
      writeFileSync(join(root, '.auth', 'machine_id'), 'machine-fixture');
      writeFileSync(join(root, '.weaver-identity.json'), JSON.stringify({ engine: 'qoder', subject: `qoder:${identity}` }));
    },
    file: root => join(root, '.auth', 'user'),
    capture: () => async (_exe, args, _timeout, _limit, env) => {
      const identity = readFileSync(join(env.QODER_CONFIG_DIR!, '.auth', 'user'), 'utf8');
      return { code: 0, stdout: JSON.stringify({ logged_in: true, username: identity }), stderr: '', timedOut: false, overflow: false };
    },
  },
];

function fixture(engine: EngineCase, identity = 'acct-a') {
  const root = temp();
  const oldRoot = join(root, 'channel', 'native');
  const newRoot = join(root, 'channel', 'native-relogin');
  engine.prepare(oldRoot, identity);
  const channel = { engine: engine.engine, kind: 'subscription' as const, label: 'Official', enabled: true };
  const binding: ChannelBinding = { channel, secret: { authDir: oldRoot }, engineKind: engine.engine };
  let committed = 0;
  let nextIdentity = identity;
  const launches: Array<{ command: string[]; env: NodeJS.ProcessEnv }> = [];
  const scopes: OwnedScope[] = [];
  let grokSubject = identity;
  const options = {
    env: { PATH: '/fixture', HOME: root },
    find: async () => `/fixture/${engine.engine}`,
    start: (input: Parameters<typeof import('../../src/main/adapters/cli/scope').startOwnedScope>[0]) => {
      launches.push({ command: [...input.command], env: input.env });
      const scope = Object.assign(new EventEmitter(), {
        unit: input.unit, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
        kill: () => { queueMicrotask(() => scope.emit('close', 1)); return true; }, detach: () => {},
      }) as OwnedScope;
      scopes.push(scope);
      return scope;
    },
    confirmAbsent: async () => true,
    capture: engine.capture(identity),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.hostname === 'auth.x.ai' && target.pathname === '/.well-known/openid-configuration') {
        return Response.json({ issuer: 'https://auth.x.ai', userinfo_endpoint: 'https://auth.x.ai/userinfo' });
      }
      if (target.hostname === 'auth.x.ai' && target.pathname === '/userinfo') {
        return Response.json({ sub: grokSubject });
      }
      throw new Error('unexpected fetch');
    }) as typeof fetch,
    reloginRoot: () => newRoot,
    commitRelogin: (_channel: string, original: string, next: string) => {
      assert.equal(original, oldRoot); assert.equal(next, newRoot); committed++;
      binding.secret = { ...binding.secret, authDir: next };
    },
  };
  return {
    root, oldRoot, newRoot, binding, options, launches, scopes,
    get committed() { return committed; },
    setNextIdentity(value: string) { nextIdentity = value; grokSubject = value; },
    get nextIdentity() { return nextIdentity; },
    async complete(identity: string, code = 0) {
      const rootForLogin = this.nextIdentity ? newRoot : newRoot;
      engine.prepare(rootForLogin, identity);
      scopes.at(-1)!.emit('close', code);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

for (const engine of cases) {
  test(`${engine.engine} relogin keeps the same identity by switching only the channel root`, async () => {
    const f = fixture(engine);
    try {
      const logins = new ChannelLogins(channel => ({ ...f.binding, channel: { ...f.binding.channel, engine: channel === 'other' ? 'codex' : f.binding.channel.engine } }), f.options);
      try {
        const held = prepareChannelRun({ ...f.binding, model: 'fixture', stateDir: join(f.root, 'state') });
        const oldBytes = hash(f.oldRoot ? engine.file(f.oldRoot) : '');
        const job = await logins.start({ channel: 'fixture', relogin: true });
        await new Promise(resolve => setImmediate(resolve));
        await f.complete(f.nextIdentity);
        const done = logins.get({ channel: 'fixture', id: job.id });
        assert.equal(done.status, 'succeeded', JSON.stringify(done));
        assert.equal(f.committed, 1);
        assert.equal(bindingAuthDir(f.binding), f.newRoot);
        assert.equal(hash(engine.file(f.oldRoot)), oldBytes, 'old root is not modified');
        assert.equal(existsSync(engine.file(f.newRoot)), true, 'new root has the replacement credential');
        assert.equal(held.env[engine.engine === 'codex' ? 'CODEX_HOME' : engine.engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : engine.engine === 'grok' ? 'GROK_HOME' : engine.engine === 'opencode' ? 'OPENCODE_DB' : 'QODER_CONFIG_DIR'],
          engine.engine === 'opencode' ? join(f.oldRoot, 'opencode.db') : f.oldRoot, 'a held run keeps its original root');
        assert.ok(existsSync(engine.file(f.oldRoot)), 'held run files are still present');
        cleanupChannelRun(held);
      } finally { await logins.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test(`${engine.engine} relogin rejects a different identity and preserves the original credential`, async () => {
    const f = fixture(engine);
    try {
      const logins = new ChannelLogins(() => f.binding, f.options);
      try {
        const oldBytes = hash(engine.file(f.oldRoot));
        f.setNextIdentity('acct-b');
        const job = await logins.start({ channel: 'fixture', relogin: true });
        await new Promise(resolve => setImmediate(resolve));
        await f.complete('acct-b');
        const done = logins.get({ channel: 'fixture', id: job.id });
        assert.equal(done.status, 'failed');
        assert.equal(done.error?.code, 'LOGIN_IDENTITY_CHANGED');
        assert.equal(f.committed, 0);
        assert.equal(bindingAuthDir(f.binding), f.oldRoot);
        assert.equal(hash(engine.file(f.oldRoot)), oldBytes);
        assert.equal(existsSync(f.newRoot), false, 'temporary relogin root is removed');
      } finally { await logins.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test(`${engine.engine} relogin cancellation and failure leave the original credential untouched`, async () => {
    for (const outcome of ['cancel', 'fail'] as const) {
      const f = fixture(engine);
      try {
        const logins = new ChannelLogins(() => f.binding, f.options);
        try {
          const oldBytes = hash(engine.file(f.oldRoot));
          const job = await logins.start({ channel: 'fixture', relogin: true });
          await new Promise(resolve => setImmediate(resolve));
          if (outcome === 'cancel') await logins.cancel({ channel: 'fixture', id: job.id });
          else await f.complete(f.nextIdentity, 1);
          assert.equal(f.committed, 0, outcome);
          assert.equal(bindingAuthDir(f.binding), f.oldRoot, outcome);
          assert.equal(hash(engine.file(f.oldRoot)), oldBytes, outcome);
          assert.equal(existsSync(f.newRoot), false, `${outcome} removes the temporary root`);
        } finally { await logins.close(); }
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  });
}

function bindingAuthDir(binding: ChannelBinding): string | undefined { return binding.secret.authDir; }

test('ChannelService commits a relogin root only while the channel still points at the original root', () => {
  const root = temp();
  const db = new DatabaseSync(':memory:');
  try {
    const policy = new PolicyStore(db), secrets = new ChannelStore(db), service = new ChannelService(policy, secrets, { root });
    const saved = service.save({ revision: 0, channel: { engine: 'codex', kind: 'subscription', label: 'Official', enabled: true } });
    const id = saved.savedChannel;
    const original = secrets.getSecret(id)!.authDir!;
    const next = service.reloginRoot(id, original);
    assert.notEqual(next, original);
    assert.equal(existsSync(next), true);
    service.commitRelogin(id, original, next);
    assert.equal(secrets.getSecret(id)!.authDir, next);
    assert.throws(() => service.commitRelogin(id, original, next), /变化|重新读取/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
