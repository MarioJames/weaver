import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/main/migrate';
import { PolicyStore } from '../../src/main/policy/store';
import { ChannelStore } from '../../src/main/channels/store';
import { NativeChannelImporter } from '../../src/main/channels/import';
import { ImService } from '../../src/main/im/service';
import { ImSettingsStore } from '../../src/main/im/settings';
import type { ParentAgentInput } from '../../src/main/im/parent-agent';
import type { Channel, ChannelSecret } from '../../src/shared/contracts/channels';

test('legacy IM selects the sole imported dsh identity without rewriting private settings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'im-channel-migration-'));
  const db = new DatabaseSync(':memory:');
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  migrate(db);
  const policy = new PolicyStore(db); const secrets = new ChannelStore(db);
  const saved = policy.snapshot();
  saved.config.engines.deep = { enabled: true, kind: 'dsh' };
  saved.config.channels.default_deep = { engine: 'deep', enabled: true, kind: 'api', label: 'pending' };
  policy.save({ revision: saved.revision, config: saved.config, blocks: [] }, { allowEngineEnable: true });
  const home = join(root, 'home'); await mkdir(join(home, '.dsh'), { recursive: true });
  const source = join(home, '.dsh', '.credentials.yaml');
  const sourceBytes = 'refs:\n  DEEPSEEK_API_KEY: FAKE_MIGRATION_KEY\n'; await writeFile(source, sourceBytes);
  await new NativeChannelImporter(policy, secrets, { root: join(root, 'channels'), env: { HOME: home } }).import({ revision: policy.snapshot().revision, engine: 'deep' });
  const imported = Object.keys(policy.snapshot().config.channels).find(id => id.startsWith('import_'))!;
  assert.ok(imported);
  const binding = (id: string) => ({ channel: policy.snapshot().config.channels[id]!, secret: secrets.getSecret(id) ?? {}, engineKind: 'dsh' });
  for (const version of [2, 3, 4]) {
    const dir = join(root, `v${version}`); await mkdir(dir);
    const config = { enabled: true, appId: 'cli_fake', appSecret: 'FAKE_IM_SECRET', allowedOpenIds: ['ou_fake'], engine: 'deep', model: 'deepseek/deepseek-chat', effort: 'high', idleTimeoutMinutes: 30,
      ...(version === 2 ? { workspace: dir } : { workspaces: [dir] }), ...(version === 4 ? { ownerProfileId: 'retained_pin' } : {}) };
    const path = join(dir, 'im-settings.json'); const bytes = JSON.stringify({ version, revision: 17, config }); await writeFile(path, bytes);
    const inputs: ParentAgentInput[] = [];
    const service = new ImService({ dataDir: dir, policy: () => policy.snapshot(), channelConfig: binding,
      parentFactory: async input => { inputs.push(input); return { send: async () => '', close: async () => {} }; },
      channelFactory: () => ({ connect: async () => {}, close: async () => {}, state: () => 'connected', send: async () => {}, stream: async () => '', updateCard: async () => {}, retireCard: async () => {} }) });
    try {
      const snapshot = service.snapshot();
      assert.equal(snapshot.config.channel, imported);
      assert.equal(snapshot.revision, 17); assert.equal(snapshot.config.ownerProfileId, version === 4 ? 'retained_pin' : '');
      assert.equal(snapshot.config.appSecretConfigured, true); assert.equal(snapshot.config.enabled, true);
      assert.deepEqual(snapshot.config.allowedOpenIds, ['ou_fake']); assert.deepEqual(snapshot.config.workspaces, [dir]);
      assert.equal(snapshot.config.model, config.model); assert.equal(snapshot.config.effort, config.effort);
      await service.reconnect();
      for (let n = 0; n < 12; n++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(inputs.length, 1); assert.equal(inputs[0]!.channel, imported);
      assert.equal(inputs[0]!.channelConfig?.secret.apiKey, 'FAKE_MIGRATION_KEY');
      assert.equal(service.snapshot().status.agentState, 'ready');
      assert.equal(await readFile(path, 'utf8'), bytes);
      assert.equal(new ImSettingsStore(dir).current().config.appSecret, 'FAKE_IM_SECRET');
      const store = new ImSettingsStore(dir);
      assert.throws(() => store.save({ expectedRevision: 16, config: store.current().config }), { code: 'IM_SETTINGS_CONFLICT' });
      assert.equal(await readFile(path, 'utf8'), bytes);
      const { appSecretConfigured, ...keep } = snapshot.config; void appSecretConfigured;
      const updated = await service.save({ expectedRevision: 17, config: { ...keep, enabled: false } });
      assert.equal(updated.revision, 18); assert.equal(updated.config.channel, imported);
      const reopened = new ImSettingsStore(dir).current();
      assert.deepEqual(reopened.config, { ...store.current().config, channel: imported, enabled: false });
      assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 5);
    } finally { await service.close(); }
  }
  assert.equal(await readFile(source, 'utf8'), sourceBytes);
});

test('legacy resolution preserves explicit identities and refuses unavailable or ambiguous imports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'im-channel-safety-'));
  const db = new DatabaseSync(':memory:');
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  migrate(db); const base = new PolicyStore(db).snapshot();
  const channel: Channel = { engine: 'alias', kind: 'api', provider: 'deepseek-official', enabled: true, label: 'fake' };
  const cases: { name: string; version?: number; kind?: string; model?: string; original?: Partial<Channel>; candidate?: Partial<Channel>; second?: Partial<Channel>; secret?: ChannelSecret; defaultSecret?: ChannelSecret; selection?: string; expected: string }[] = [
    { name: 'single plain dsh model', model: 'deepseek-chat', expected: 'import_one' },
    { name: 'v5 empty default', version: 5, expected: 'default_alias' },
    { name: 'v5 missing key', version: 5, selection: 'chosen_account', expected: 'chosen_account' },
    { name: 'v5 disabled selection', version: 5, selection: 'import_one', candidate: { enabled: false }, expected: 'import_one' },
    { name: 'configured default', defaultSecret: { apiKey: 'FAKE_DEFAULT' }, expected: 'default_alias' },
    { name: 'incomplete default config belongs to user', defaultSecret: { config: '[]' }, expected: 'default_alias' },
    { name: 'disabled default', original: { enabled: false }, expected: 'default_alias' },
    { name: 'disabled import', candidate: { enabled: false }, expected: '' },
    { name: 'missing import key', secret: {}, expected: '' },
    { name: 'config without dsh key', secret: { config: '[]' }, expected: '' },
    { name: 'multiple identities', second: {}, expected: '' },
    { name: 'disabled second identity still ambiguous', second: { enabled: false }, expected: '' },
    { name: 'provider mismatch', candidate: { provider: 'other' }, expected: '' },
    { name: 'engine alias mismatch', candidate: { engine: 'other' }, expected: '' },
    { name: 'never swap API to subscription', candidate: { kind: 'subscription' }, secret: { authDir: root }, expected: '' },
    { name: 'unknown engine kind', kind: 'unknown', expected: 'default_alias' },
    { name: 'pi provider model', kind: 'pi', model: 'vendor/model', candidate: { provider: 'vendor' }, expected: 'import_one' },
    { name: 'pi provider mismatch', kind: 'pi', model: 'vendor/model', expected: '' },
    { name: 'pi without provider is ambiguous', kind: 'pi', model: 'model', expected: '' },
    { name: 'subscription identity', kind: 'codex', model: 'gpt-test', original: { kind: 'subscription' }, candidate: { kind: 'subscription', provider: undefined }, secret: { authDir: root }, expected: 'import_one' },
    { name: 'never swap subscription to API', kind: 'codex', model: 'gpt-test', original: { kind: 'subscription' }, expected: '' },
  ];
  for (const [n, scenario] of cases.entries()) {
    const dir = join(root, String(n)); await mkdir(dir);
    const live = structuredClone(base);
    live.config.engines = { alias: { kind: scenario.kind ?? 'dsh', enabled: true } };
    live.config.channels = { default_alias: { ...channel, ...scenario.original }, import_one: { ...channel, ...scenario.candidate }, ...(scenario.second ? { import_two: { ...channel, ...scenario.second } } : {}) };
    const version = scenario.version ?? 4;
    const config = { enabled: false, appId: 'cli_fake', appSecret: 'FAKE_PRIVATE', allowedOpenIds: ['ou_fake'], model: scenario.model ?? 'deepseek/deepseek-chat', effort: 'high', idleTimeoutMinutes: 30, workspaces: [dir], ownerProfileId: '',
      ...(version === 5 ? { channel: scenario.selection ?? 'default_alias' } : { engine: 'alias' }) };
    const path = join(dir, 'im-settings.json'); const bytes = JSON.stringify({ version, revision: 9, config }); await writeFile(path, bytes);
    const service = new ImService({ dataDir: dir, policy: () => live, channelConfig: id => ({ channel: live.config.channels[id]!, secret: id === 'default_alias' ? scenario.defaultSecret ?? {} : scenario.secret ?? { apiKey: 'FAKE_IMPORTED' } }) });
    try {
      assert.equal(service.snapshot().config.channel, scenario.expected, scenario.name);
      assert.equal(service.snapshot().revision, 9, scenario.name);
      assert.equal(await readFile(path, 'utf8'), bytes, scenario.name);
    } finally { await service.close(); }
  }
});
