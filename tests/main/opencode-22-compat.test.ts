import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { nativeCredentialsReady } from '../../src/main/channels/native';
import { ChannelLogins } from '../../src/main/channels/login';
import { NativeChannelImporter } from '../../src/main/channels/import';
import { ChannelService } from '../../src/main/channels/service';
import { ChannelStore } from '../../src/main/channels/store';
import { PolicyStore } from '../../src/main/policy/store';
import { QuotaProber } from '../../src/main/quota';
import { readNativeCredential } from '../../src/main/quota/credentials';
import type { OwnedScope } from '../../src/main/adapters/cli/scope';

const start = Date.parse('2026-10-18T12:00:00Z');
const reset = '2026-10-18T17:00:00.000Z';
const credentialSql = `CREATE TABLE credential (
  id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL,
  connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL
)`;
const accountSql = `CREATE TABLE account (
  id text PRIMARY KEY, email text NOT NULL, url text NOT NULL, access_token text NOT NULL,
  refresh_token text NOT NULL, token_expiry integer, time_created integer NOT NULL, time_updated integer NOT NULL
)`;
const stateSql = `CREATE TABLE account_state (id integer PRIMARY KEY, active_account_id text, active_org_id text)`;

function openCodeDb(file: string, options: {
  goKey?: string;
  console?: { access: string; refresh?: string; expires?: number; orgID?: string };
  account?: { id: string; email?: string; orgID?: string; token?: string };
  sessionRows?: number;
} = {}): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(credentialSql); db.exec(accountSql); db.exec(stateSql);
    const now = Date.now();
    if (options.goKey !== undefined) {
      db.prepare('INSERT INTO credential VALUES (?,?,?,?,?,?,?,?,?)').run(
        'cred_fixture_go', 'opencode-go', 'OpenCode Go', JSON.stringify({ type: 'key', key: options.goKey }), null, null, 1, now, now,
      );
    }
    if (options.console) {
      db.prepare('INSERT INTO credential VALUES (?,?,?,?,?,?,?,?,?)').run(
        'cred_fixture_console', 'opencode', 'OpenCode Console', JSON.stringify({
          type: 'oauth', methodID: 'device', access: options.console.access,
          refresh: options.console.refresh ?? 'refresh-fixture', expires: options.console.expires ?? now + 86_400_000,
          metadata: { accountID: 'acct_fixture', email: 'fixture@example.invalid', orgID: options.console.orgID ?? 'org_fixture' },
        }), null, null, 1, now, now,
      );
    }
    if (options.account) {
      db.prepare('INSERT INTO account VALUES (?,?,?,?,?,?,?,?)').run(
        options.account.id, options.account.email ?? 'fixture@example.invalid', 'https://opencode.ai/console',
        options.account.token ?? 'token-fixture', 'refresh-fixture', now + 86_400_000, now, now,
      );
      db.prepare('INSERT INTO account_state VALUES (?,?,?)').run(1, options.account.id, options.account.orgID ?? 'org_fixture');
    }
    if (options.sessionRows) db.exec('CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)');
    for (let index = 0; index < (options.sessionRows ?? 0); index++) {
      db.prepare('INSERT INTO session VALUES (?,?)').run(`ses_${index}`, now);
    }
  } finally { db.close(); }
}

function temp(): string { return mkdtempSync(join(tmpdir(), 'weaver-oc22-')); }

function fakeOpencodeModels(bin: string, log: string): void {
  mkdirSync(bin, { recursive: true });
  const script = `#!${process.execPath}
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: args, db: process.env.OPENCODE_DB }) + '\\n');
if (args.includes('--version')) { process.stdout.write('opencode v2.2.7\\n'); process.exit(0); }
if (args[0] === 'models') {
  const db = new DatabaseSync(process.env.OPENCODE_DB, { readOnly: true });
  const row = db.prepare("SELECT value FROM credential WHERE integration_id='opencode-go'").get();
  db.close();
  if (!row) { process.stderr.write('no opencode-go credential\\n'); process.exit(1); }
  process.stdout.write('opencode-go/deepseek-v4.1-flash\\nopencode/free\\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{ id: 'opencode-go', name: 'OpenCode Go', connections: [{ type: 'credential', id: 'cred_fixture_go', label: 'OpenCode Go', method: 'key' }] }]) + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected fake opencode invocation: ' + args.join(' ') + '\\n');
process.exit(2);
`;
  writeFileSync(join(bin, 'opencode'), script, { mode: 0o700 });
  chmodSync(join(bin, 'opencode'), 0o700);
}

test('OpenCode 2.2 readiness requires the opencode-go credential, not a legacy account cursor', () => {
  const root = temp();
  try {
    mkdirSync(join(root, 'native'));
    const file = join(root, 'native', 'opencode.db');
    openCodeDb(file, { account: { id: 'acct_legacy' } });
    assert.equal(nativeCredentialsReady('opencode', { authDir: join(root, 'native') }), false, 'legacy account only cannot list opencode-go models');
    rmSync(file);
    openCodeDb(file, { goKey: 'fixture-go-key' });
    assert.equal(nativeCredentialsReady('opencode', { authDir: join(root, 'native') }), true);
    rmSync(file);
    openCodeDb(join(root, 'native', 'opencode.db'), { account: { id: 'acct_legacy' }, goKey: 'fixture-go-key' });
    assert.equal(nativeCredentialsReady('opencode', { authDir: join(root, 'native') }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode quota resolves the 2.2 credential table: Console OAuth first, then the Go key', async () => {
  const root = temp();
  try {
    const env = { HOME: root };
    const data = join(root, '.local', 'share', 'opencode');
    mkdirSync(data, { recursive: true });
    openCodeDb(join(data, 'opencode.db'), { goKey: 'fixture-go-key' });
    const key = await readNativeCredential('opencode', env, start);
    assert.equal(key.opencodeKind, 'api');
    assert.equal(key.token, 'fixture-go-key');
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const prober = new QuotaProber({
      env, now: () => new Date(start), fetch: async (url, init) => {
        calls.push({ url: String(url), authorization: new Headers(init!.headers).get('Authorization') });
        return Response.json({ usage: {
          rolling: { status: 'ok', percent: 10, resetsAt: reset },
          weekly: { status: 'ok', percent: 20, resetsAt: reset },
          monthly: { status: 'ok', percent: 30, resetsAt: reset },
        } }, { headers: { 'Content-Type': 'application/json' } });
      },
    });
    try {
      const record = (await prober.refresh({ engine: 'opencode' })).records[3];
      assert.equal(record.source, 'opencode_go_usage');
      assert.equal(record.status, 'available');
      assert.deepEqual(calls, [{ url: 'https://opencode.ai/zen/go/v1/usage', authorization: 'Bearer fixture-go-key' }]);
      assert.doesNotMatch(JSON.stringify(record), /fixture-go-key/);
    } finally { await prober.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode 2.2 import copies the credential table and verifies the private root can list Go models', async () => {
  const root = temp();
  try {
    const source = join(root, 'source');
    const bin = join(root, 'bin');
    const log = join(root, 'models.log');
    const managed = join(root, 'managed');
    mkdirSync(source);
    const sourceDb = join(source, 'opencode.db');
    openCodeDb(sourceDb, { goKey: 'fixture-go-key', account: { id: 'acct_fixture', email: 'fixture@example.invalid', orgID: 'org_fixture' }, sessionRows: 2 });
    const before = createHash('sha256').update(readFileSync(sourceDb)).digest('hex');
    fakeOpencodeModels(bin, log);
    const db = new DatabaseSync(':memory:');
    try {
      const policy = new PolicyStore(db), secrets = new ChannelStore(db);
      const importer = new NativeChannelImporter(policy, secrets, { root: managed, env: { HOME: root, PATH: `${bin}:${process.env.PATH ?? ''}` } });
      const result = await importer.import({ revision: 0, engine: 'opencode', sourceDir: source });
      const imported = Object.entries(result.policy.config.channels).filter(([id]) => id.startsWith('import_'));
      assert.equal(imported.length, 1);
      const [id, channel] = imported[0]!;
      assert.equal(channel.kind, 'subscription');
      assert.equal(channel.enabled, true);
      assert.equal(result.configurations[id]!.hasCredentials, true);
      const authDir = secrets.getSecret(id)!.authDir!;
      const copied = new DatabaseSync(join(authDir, 'opencode.db'), { readOnly: true });
      try {
        assert.equal(copied.prepare("SELECT count(*) AS n FROM credential WHERE integration_id='opencode-go'").get()!.n, 1);
        assert.equal(copied.prepare('SELECT count(*) AS n FROM session').get()!.n, 2);
        assert.equal(copied.prepare('SELECT active_org_id FROM account_state WHERE id=1').get()!.active_org_id, 'org_fixture');
      } finally { copied.close(); }
      const invocations = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { argv: string[]; db: string });
      assert.ok(invocations.length >= 2, 'enumeration and staged verification both list models');
      assert.ok(invocations.every(row => row.argv[0] === 'models' && row.argv.includes('--standalone')));
      assert.ok(invocations.every(row => row.db !== sourceDb));
      assert.equal(createHash('sha256').update(readFileSync(sourceDb)).digest('hex'), before, 'source database is byte-identical');
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode 2.2 import refuses a database whose Go credential cannot list models', async () => {
  const root = temp();
  try {
    const source = join(root, 'source');
    mkdirSync(source);
    openCodeDb(join(source, 'opencode.db'), { account: { id: 'acct_legacy' } });
    const db = new DatabaseSync(':memory:');
    try {
      const policy = new PolicyStore(db), secrets = new ChannelStore(db);
      const importer = new NativeChannelImporter(policy, secrets, {
        root: join(root, 'managed'), env: { HOME: root },
        openCodeModels: async () => { throw new Error('no opencode-go model'); },
      });
      await assert.rejects(importer.import({ revision: 0, engine: 'opencode', sourceDir: source }), /导入|OpenCode/i);
      assert.equal(db.prepare('SELECT count(*) AS n FROM channel_secrets').get()!.n, 0);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('new OpenCode login uses the 2.2 device method and only reports success after the private root lists Go models', async () => {
  const root = temp();
  const native = join(root, 'native');
  mkdirSync(native, { recursive: true });
  const scopes: OwnedScope[] = [];
  const calls: Array<{ env: NodeJS.ProcessEnv; command: string[] }> = [];
  try {
    const logins = new ChannelLogins(
      id => ({ channel: { engine: 'opencode', kind: 'subscription', label: 'OpenCode', enabled: true }, secret: { authDir: native }, engineKind: 'opencode' }),
      {
        env: { PATH: '/fixture', HOME: root },
        find: async () => '/fixture/opencode',
        start: input => {
          calls.push({ env: input.env, command: [...input.command] });
          const scope = Object.assign(new EventEmitter(), {
            unit: input.unit, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
            kill: () => { queueMicrotask(() => scope.emit('close', 0)); return true; }, detach: () => {},
          }) as OwnedScope;
          scopes.push(scope);
          return scope;
        },
        confirmAbsent: async () => true,
        capture: async (executable, args, _timeout, _limit, env) => {
          assert.equal(executable, '/fixture/opencode');
          assert.deepEqual(args, ['models', '--standalone']);
          assert.equal(env.OPENCODE_DB, join(native, 'opencode.db'));
          return { code: 0, stdout: 'opencode-go/deepseek-v4.1-flash\nopencode/free\n', stderr: '', timedOut: false, overflow: false };
        },
      },
    );
    try {
      const job = await logins.start({ channel: 'fixture' });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls[0]!.command.slice(1), ['auth', 'login', 'opencode', '--method', 'device', '--standalone']);
      (scopes[0]!.stdout as PassThrough).write('●  Enter code: ABCD-EFGH\n●  https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli\n◇  Waiting for authorization...\n');
      const authorizing = logins.get({ channel: 'fixture', id: job.id });
      assert.equal(authorizing.status, 'authorizing');
      assert.equal(authorizing.userCode, 'ABCD-EFGH');
      assert.equal(authorizing.verificationUrl, 'https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli');
      openCodeDb(join(native, 'opencode.db'), { goKey: 'fixture-go-key', account: { id: 'acct_fixture' } });
      scopes[0]!.emit('close', 0);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      const done = logins.get({ channel: 'fixture', id: job.id });
      assert.equal(done.status, 'succeeded');
      assert.equal(nativeCredentialsReady('opencode', { authDir: native }), true);
      assert.ok(readFileSync(join(native, '.weaver-identity.json'), 'utf8').includes('acct_fixture'));
    } finally { await logins.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
