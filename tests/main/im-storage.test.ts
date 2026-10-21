import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImInbox, ImInboxError, DEFAULT_INBOX_TTL_MS } from '../../src/main/im/inbox';
import { ImSettingsError, ImSettingsStore, publicImConfig } from '../../src/main/im/settings';
import type { SaveImSettingsInput } from '../../src/shared/contracts/im';

// Persistence contracts for the Feishu IM bridge: the private settings store (0600, atomic, optimistic lock,
// secret keep/clear/replace semantics) and the inbox dedup registry (durable at-most-once claims). These tests
// only use an isolated fixture root created fresh under the OS temp dir for each run, fully removed afterwards,
// and never touch real credentials. Point TMPDIR at a task-provided root when a shared scratch location is
// required; no fixed path is baked in here.

const ROOT = mkdtempSync(join(tmpdir(), 'weaver-im-storage-'));
const START = Date.parse('2030-01-01T00:00:00Z');
const scratch = (name: string) => mkdtempSync(join(ROOT, `${name}-`));
test.after(() => { rmSync(ROOT, { recursive: true, force: true }); });

const mode = (path: string) => statSync(path).mode & 0o777;

const enabledInput = (overrides: Partial<Extract<SaveImSettingsInput['config'], { appSecret?: string }>> = {}, appSecret = 'secret-one'): SaveImSettingsInput => ({
  expectedRevision: 0,
  config: { enabled: true, appId: 'cli_testapp', allowedOpenIds: ['ou_owner'], engine:'codex',model:'gpt-test',effort:'medium', workspaces: [ROOT], idleTimeoutMinutes: 30, appSecret, ...overrides },
});

const disabledInput = (): SaveImSettingsInput => ({
  expectedRevision: 0,
  config: { enabled: false, appId: '', allowedOpenIds: [], engine:'',model:'',effort:'medium', workspaces: [], idleTimeoutMinutes: 30 },
});

// --- Settings store: defaults and private file handling ---

test('settings: missing file yields defaults without writing anything', () => {
  const dir = scratch('defaults');
  const store = new ImSettingsStore(dir);
  const settings = store.current();
  assert.equal(settings.revision, 0);
  assert.equal(settings.config.enabled, false);
  assert.equal(settings.config.appId, '');
  assert.equal(settings.config.appSecret, '');
  assert.deepEqual(settings.config.allowedOpenIds, []);
  assert.equal(settings.config.effort, 'medium');
  assert.deepEqual(settings.config.workspaces, []);
  assert.equal(settings.config.idleTimeoutMinutes, 30);
  assert.equal(existsSync(join(dir, 'im-settings.json')), false);
});

test('settings: save persists 0600 atomically and bumps the revision', () => {
  const dir = scratch('save');
  const store = new ImSettingsStore(dir);
  const saved = store.save(enabledInput());
  assert.equal(saved.revision, 1);
  assert.equal(saved.config.appSecret, 'secret-one');
  const path = join(dir, 'im-settings.json');
  assert.equal(mode(path), 0o600);
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), ['config', 'revision', 'version']);
  assert.equal(onDisk.config.appSecret, 'secret-one');
  // The atomic replace leaves no temp files behind.
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp-')), []);
});

test('settings: current() returns a copy that cannot tamper with the store', () => {
  const dir = scratch('copy');
  const store = new ImSettingsStore(dir);
  store.save(enabledInput());
  const snapshot = store.current();
  snapshot.config.appSecret = 'tampered';
  snapshot.config.allowedOpenIds.push('ou_extra');
  snapshot.revision = 99;
  const fresh = store.current();
  assert.equal(fresh.config.appSecret, 'secret-one');
  assert.deepEqual(fresh.config.allowedOpenIds, ['ou_owner']);
  assert.equal(fresh.revision, 1);
  assert.equal(new ImSettingsStore(dir).current().config.appSecret, 'secret-one');
});

test('settings: publicImConfig exposes a boolean and never the secret', () => {
  const dir = scratch('public');
  const store = new ImSettingsStore(dir);
  const saved = store.save(enabledInput());
  const pub = publicImConfig(saved.config);
  assert.deepEqual(Object.keys(pub).sort(), ['allowedOpenIds', 'appId', 'appSecretConfigured', 'effort', 'enabled', 'engine', 'idleTimeoutMinutes', 'model', 'workspaces']);
  assert.equal(pub.appSecretConfigured, true);
  const cleared = publicImConfig(store.save({ expectedRevision: 1, config: { ...enabledInput().config, enabled: false, appSecret: '' } }).config);
  assert.equal(cleared.appSecretConfigured, false);
});

// --- Secret semantics ---

test('settings: omitted appSecret keeps the stored secret', () => {
  const dir = scratch('keep');
  const store = new ImSettingsStore(dir);
  store.save(enabledInput());
  const { appSecret, ...rest } = enabledInput().config;
  const saved = store.save({ expectedRevision: 1, config: { ...rest, idleTimeoutMinutes: 15 } });
  assert.equal(saved.config.appSecret, 'secret-one');
  assert.equal(saved.revision, 2);
  assert.equal(saved.config.idleTimeoutMinutes, 15);
});

test('settings: empty string clears the secret, omitted does not', () => {
  const dir = scratch('clear');
  const store = new ImSettingsStore(dir);
  store.save(enabledInput());
  const { appSecret, ...rest } = enabledInput().config;
  // A cleared secret and an enabled bridge are incompatible, so the clear happens together with disabling.
  const cleared = store.save({ expectedRevision: 1, config: { ...rest, enabled: false, appSecret: '' } });
  assert.equal(cleared.config.appSecret, '');
  const kept = store.save({ expectedRevision: 2, config: { ...rest, enabled: false } });
  assert.equal(kept.config.appSecret, '');
});

test('settings: changing appId forces an explicit secret decision', () => {
  const dir = scratch('appid');
  const store = new ImSettingsStore(dir);
  store.save(enabledInput());
  const { appSecret, ...rest } = enabledInput().config;

  // Same appId, omitted secret: keep is fine.
  assert.equal(store.save({ expectedRevision: 1, config: { ...rest } }).config.appSecret, 'secret-one');

  // Different appId with the old secret still stored: rejected, no silent carry-over.
  assert.throws(() => store.save({ expectedRevision: 2, config: { ...rest, appId: 'cli_other' } }), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_INVALID');

  // A new appId with a new secret replaces it.
  store.save({ expectedRevision: 2, config: { ...rest, appId: 'cli_other', appSecret: 'secret-two' } });

  // An explicit clear is a decision in its own right (taken while disabled, since enabled needs a secret).
  const cleared = store.save({ expectedRevision: 3, config: { ...rest, appId: 'cli_other', appSecret: '', enabled: false } });
  assert.equal(cleared.config.appSecret, '');

  // Once cleared, an appId change with no secret field is allowed: there is nothing to carry over.
  const switched = store.save({ expectedRevision: 4, config: { ...rest, appId: 'cli_third', enabled: false } });
  assert.equal(switched.config.appSecret, '');
  assert.equal(switched.config.appId, 'cli_third');

  // And a new secret on the next appId still replaces cleanly.
  assert.equal(store.save({ expectedRevision: 5, config: { ...rest, appId: 'cli_fourth', appSecret: 'secret-three', enabled: true } }).config.appSecret, 'secret-three');
});

test('settings: save and load share one secret rule — a value that cannot be read back is never written', () => {
  const dir = scratch('secret-rule');
  const store = new ImSettingsStore(dir);
  const path = join(dir, 'im-settings.json');
  store.save(enabledInput());
  // Edge whitespace and all-whitespace values were once accepted here and reopened as IM_SETTINGS_CORRUPT;
  // control characters and oversize values document the unchanged parts of the rule.
  for (const bad of [' edge-value ', '\tedge', 'edge\n', '  ', 'sec\tret', 'sec\u0000ret', 'x'.repeat(513)]) {
    assert.throws(() => store.save({ expectedRevision: 1, config: { ...enabledInput().config, appSecret: bad } }), (error: unknown) =>
      error instanceof ImSettingsError && error.code === 'IM_SETTINGS_INVALID');
  }
  // Every rejected save left file and revision untouched, and a fresh store still reads the stored secret.
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).revision, 1);
  const fresh = new ImSettingsStore(dir);
  assert.equal(fresh.current().revision, 1);
  assert.equal(fresh.current().config.appSecret, 'secret-one');
  // A well-formed secret still saves and reads back through a fresh store.
  assert.equal(store.save({ expectedRevision: 1, config: { ...enabledInput().config, appSecret: 'secret-two' } }).revision, 2);
  assert.equal(new ImSettingsStore(dir).current().config.appSecret, 'secret-two');
});

test('settings: a disabled draft enforces the same secret rule and formatted history still loads', () => {
  const dir = scratch('secret-draft');
  const store = new ImSettingsStore(dir);
  const draft = { enabled: false, appId: '', allowedOpenIds: [] as string[], engine:'',model:'',effort:'medium', workspaces: [], idleTimeoutMinutes: 30 };
  store.save({ expectedRevision: 0, config: draft });
  assert.throws(() => store.save({ expectedRevision: 1, config: { ...draft, appSecret: ' padded ' } }), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_INVALID');
  // The stored draft itself is unaffected: a fresh store reads it unchanged.
  assert.deepEqual(new ImSettingsStore(dir).current(), { revision: 1, config: { ...draft, appSecret: '' } });
});

// --- Optimistic locking ---

test('settings: revision is a strict optimistic lock', () => {
  const dir = scratch('revision');
  const store = new ImSettingsStore(dir);
  store.save(enabledInput());
  const stale = enabledInput({ enabled: false }, 'ignored');
  assert.throws(() => store.save({ ...stale, expectedRevision: 0 }), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_CONFLICT');
  assert.throws(() => store.save({ ...stale, expectedRevision: 5 }), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_CONFLICT');
  const next = store.save({ ...stale, expectedRevision: 1 });
  assert.equal(next.revision, 2);
  // A second store instance sees the same revision: the lock lives in the file, not in one process.
  assert.equal(new ImSettingsStore(dir).current().revision, 2);
});

test('settings: an already-initialized second store rejects a stale revision at save time', () => {
  const dir = scratch('stale-second');
  const first = new ImSettingsStore(dir);
  const second = new ImSettingsStore(dir);
  // The second instance snapshots the defaults before the first one saves.
  assert.equal(second.current().revision, 0);
  first.save({ ...enabledInput(), config: { ...enabledInput().config, workspaces: [ROOT] } });
  // expectedRevision 0 no longer matches the on-disk revision: the stale save is rejected, not clobbered.
  assert.throws(() => second.save(enabledInput()), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_CONFLICT');
  const onDisk = JSON.parse(readFileSync(join(dir, 'im-settings.json'), 'utf8'));
  assert.equal(onDisk.revision, 1);
  assert.deepEqual(onDisk.config.workspaces, [ROOT]);
  // Reloading the fresh revision unblocks the second writer.
  const retry = second.save({ ...enabledInput(), expectedRevision: 1, config: { ...enabledInput().config, workspaces: [dir] } });
  assert.equal(retry.revision, 2);
  assert.deepEqual(new ImSettingsStore(dir).current().config.workspaces, [dir]);
});

// --- Validation ---

test('settings: unknown fields are rejected in input and on disk', () => {
  const dir = scratch('unknown');
  const store = new ImSettingsStore(dir);
  const extraField = { expectedRevision: 0, config: { ...enabledInput().config, extra: 1 } } as unknown as SaveImSettingsInput;
  assert.throws(() => store.save(extraField), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_INVALID');
  assert.throws(() => store.save({ ...enabledInput(), unexpected: true } as unknown as SaveImSettingsInput), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_INVALID');
  const path = join(dir, 'im-settings.json');
  writeFileSync(path, JSON.stringify({ version: 3, revision: 3, config: { ...disabledInput().config, appSecret: 'x', surprise: true } }), { mode: 0o600 });
  // A fresh instance models a restart: the cache must not hide the malformed file.
  assert.throws(() => new ImSettingsStore(dir).current(), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_CORRUPT');
});

test('settings: disabled mode tolerates an incomplete config but not a malformed one', () => {
  const dir = scratch('partial');
  const store = new ImSettingsStore(dir);
  const saved = store.save({ expectedRevision: 0, config: { enabled: false, appId: '', allowedOpenIds: [], engine:'',model:'',effort:'medium', workspaces: [], idleTimeoutMinutes: 30 } });
  assert.equal(saved.config.enabled, false);
  // Malformed values stay malformed even when disabled.
  assert.throws(() => store.save({ expectedRevision: 1, config: { enabled: false, appId: 'bad id!', allowedOpenIds: [], engine:'',model:'',effort:'medium', workspaces: [], idleTimeoutMinutes: 30 } }), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_INVALID');
  assert.throws(() => store.save({ expectedRevision: 1, config: { enabled: false, appId: '', allowedOpenIds: [], engine:'',model:'',effort:'medium', workspaces: [], idleTimeoutMinutes: 0 } }), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_INVALID');
  assert.throws(() => store.save({ expectedRevision: 1, config: { enabled: false, appId: '', allowedOpenIds: ['ou_a', 'ou_a'], engine:'',model:'',effort:'medium', workspaces: [], idleTimeoutMinutes: 30 } }), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_INVALID');
});

test('settings: enabling requires appId, secret, engine/model/effort, allowlist and workspace', () => {
  const dir = scratch('enable');
  const store = new ImSettingsStore(dir);
  const base = enabledInput().config;
  for (const missing of [
    { ...base, appId: '' },
    { ...base, appSecret: '' },
    { ...base, engine: '' },
    { ...base, model: '' },
    { ...base, effort: '' },
    { ...base, allowedOpenIds: [] },
    { ...base, workspaces: [] },
  ]) {
    assert.throws(() => store.save({ expectedRevision: 0, config: missing }), (error: unknown) =>
      error instanceof ImSettingsError && error.code === 'IM_SETTINGS_INVALID');
  }
  assert.equal(existsSync(join(dir, 'im-settings.json')), false);
  assert.equal(store.save(enabledInput()).config.enabled, true);
});

// --- Failure modes: corrupt, unwritable, atomic ---

test('settings: a corrupt file fails closed and is never overwritten or rebuilt', () => {
  const dir = scratch('corrupt');
  const path = join(dir, 'im-settings.json');
  const garbage = '{"version":1,"revision":4,"config":{ broken';
  writeFileSync(path, garbage, { mode: 0o600 });
  const store = new ImSettingsStore(dir);
  assert.throws(() => store.current(), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_CORRUPT');
  assert.throws(() => store.save(enabledInput()), (error: unknown) =>
    error instanceof ImSettingsError && error.code === 'IM_SETTINGS_CORRUPT');
  assert.equal(readFileSync(path, 'utf8'), garbage);
});

test('settings: a failed save changes neither the file nor memory or revision', () => {
  const dir = scratch('readonly');
  const store = new ImSettingsStore(dir);
  const saved = store.save(enabledInput());
  const path = join(dir, 'im-settings.json');
  const before = readFileSync(path, 'utf8');
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => store.save({ expectedRevision: 1, config: { ...enabledInput().config, idleTimeoutMinutes: 45 } }), (error: unknown) =>
      error instanceof ImSettingsError && error.code === 'IM_SETTINGS_IO');
    assert.equal(store.current().revision, 1);
    assert.equal(store.current().config.idleTimeoutMinutes, 30);
    assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp-')), []);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(readFileSync(path, 'utf8'), before);
  // The store recovers once the directory is writable again.
  assert.equal(store.save({ expectedRevision: 1, config: { ...enabledInput().config, idleTimeoutMinutes: 45 } }).revision, 2);
  assert.equal(store.current().config.idleTimeoutMinutes, 45);
});

test('settings: unreadable storage fails closed with a fixed IO error', () => {
  const dir = scratch('unreadable');
  const path = join(dir, 'im-settings.json');
  writeFileSync(path, '{}', { mode: 0o600 });
  chmodSync(path, 0o000);
  try {
    assert.throws(() => new ImSettingsStore(dir).current(), (error: unknown) =>
      error instanceof ImSettingsError && error.code === 'IM_SETTINGS_IO');
  } finally {
    chmodSync(path, 0o600);
  }
});

test('settings: non-object input and stored values become fixed typed errors', () => {
  const dir = scratch('non-object');
  const store = new ImSettingsStore(dir);
  for (const bad of [null, undefined, 42, 'text', []]) {
    assert.throws(() => store.save(bad as unknown as SaveImSettingsInput), (error: unknown) =>
      error instanceof ImSettingsError && error.code === 'IM_SETTINGS_INVALID');
    assert.throws(() => store.save({ expectedRevision: 0, config: bad } as unknown as SaveImSettingsInput), (error: unknown) =>
      error instanceof ImSettingsError && error.code === 'IM_SETTINGS_INVALID');
  }
  // Non-object stored files and a null stored config fail closed as corrupt, never as a raw parser error.
  const path = join(dir, 'im-settings.json');
  for (const bad of ['"text"', '[1,2]', 'null', JSON.stringify({ version: 3, revision: 1, config: null })]) {
    writeFileSync(path, bad, { mode: 0o600 });
    assert.throws(() => new ImSettingsStore(dir).current(), (error: unknown) =>
      error instanceof ImSettingsError && error.code === 'IM_SETTINGS_CORRUPT');
  }
});

test('settings: a save never deletes files it did not create, including stale temp files', () => {
  const dir = scratch('temp-safety');
  const store = new ImSettingsStore(dir);
  const path = join(dir, 'im-settings.json');
  // Real fixtures: a leftover at a colliding per-pid temp name and an unrelated temp-like file. A save that
  // wipes the directory's temp names or reuses a name it does not own must fail here.
  const fixtures = new Map([[`${path}.tmp-${process.pid}`, 'leftover-from-an-earlier-run'], [`${path}.tmp-999999`, 'unrelated-leftover']]);
  for (const [name, content] of fixtures) writeFileSync(name, content, { mode: 0o600 });
  store.save(enabledInput());
  // Every pre-existing file keeps its name and content, and the save still lands.
  for (const [name, content] of fixtures) assert.equal(readFileSync(name, 'utf8'), content);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).config.appSecret, 'secret-one');
  // No temp file from this save leaked beyond the fixtures.
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp-') && !fixtures.has(join(dir, name))), []);
});

// --- Inbox dedup registry ---

test('inbox: a claim returns true once, survives a restart, and stores only bounded metadata', () => {
  const dir = scratch('inbox-claim');
  const inbox = new ImInbox(dir);
  assert.equal(inbox.claim('om_dc13264520392913993dd051cdba8ed2', START), true);
  // Same process, same id: a duplicate.
  assert.equal(inbox.claim('om_dc13264520392913993dd051cdba8ed2', START + 1), false);
  // A fresh instance models a restart: the claim is still registered.
  const reopened = new ImInbox(dir);
  assert.equal(reopened.claim('om_dc13264520392913993dd051cdba8ed2', START + 2), false);
  // Synthetic card and menu event namespaces claim independently.
  assert.equal(reopened.claim('card:9f83d0a2-1111-2222-3333-444455556666', START), true);
  assert.equal(reopened.claim('menu:action-1', START), true);
  assert.equal(reopened.claim('menu:action-1', START), false);
  // The record carries no message body and no credential-shaped fields.
  const file = JSON.parse(readFileSync(join(dir, 'im-inbox.json'), 'utf8'));
  for (const entry of file.entries) assert.deepEqual(Object.keys(entry).sort(), ['at', 'expiresAt', 'id']);
  assert.equal(mode(join(dir, 'im-inbox.json')), 0o600);
});

test('inbox: ids are bounded in length and charset', () => {
  const dir = scratch('inbox-ids');
  const inbox = new ImInbox(dir);
  for (const bad of ['', 'a'.repeat(257), 'with space', 'with/slash', '.relative', '-leading-dash-is-fine-but-.dot-first-not', 'semi;colon']) {
    assert.throws(() => inbox.claim(bad, START), (error: unknown) => error instanceof ImInboxError && error.code === 'IM_INBOX_INVALID');
  }
  assert.equal(inbox.claim('a'.repeat(256), START), true);
  assert.throws(() => inbox.claim('ok', Number.NaN), (error: unknown) => error instanceof ImInboxError && error.code === 'IM_INBOX_INVALID');
});

test('inbox: expiry is controlled, never refreshed by duplicates, and prunes only expired records', () => {
  const dir = scratch('inbox-ttl');
  const inbox = new ImInbox(dir, { ttlMs: 1000 });
  assert.equal(inbox.claim('om_one', START), true);
  // Inside the window: still a duplicate.
  assert.equal(inbox.claim('om_one', START + 999), false);
  // Repeated duplicates do not refresh the expiry.
  assert.equal(inbox.claim('om_one', START + 500), false);
  assert.equal(inbox.claim('om_one', START + 999), false);
  // Exactly at expiry the record is gone: a replay is claimable again.
  assert.equal(inbox.claim('om_one', START + 1000), true);
  // The new claim started a fresh window from the new time, not the old one.
  assert.equal(inbox.claim('om_one', START + 1500), false);
  assert.equal(inbox.claim('om_one', START + 2000), true);
  // The default TTL is the documented 24 hours.
  assert.equal(DEFAULT_INBOX_TTL_MS, 24 * 60 * 60 * 1000);
  const longInbox = new ImInbox(dir);
  assert.equal(longInbox.claim('om_two', START), true);
  assert.equal(longInbox.claim('om_two', START + DEFAULT_INBOX_TTL_MS - 1), false);
});

test('inbox: a full store rejects new claims and never evicts records inside their replay window', () => {
  const dir = scratch('inbox-full');
  const inbox = new ImInbox(dir, { capacity: 2, ttlMs: 10 });
  assert.equal(inbox.claim('om_a', START), true);
  assert.equal(inbox.claim('om_b', START), true);
  assert.throws(() => inbox.claim('om_c', START + 1), (error: unknown) => error instanceof ImInboxError && error.code === 'IM_INBOX_FULL');
  // The rejected id is not half-registered and nothing was evicted: the registry still holds both records.
  assert.equal(JSON.parse(readFileSync(inbox.path, 'utf8')).entries.length, 2);
  // Only expiry frees capacity, never eviction: at START+10 both records are expired and pruned.
  assert.equal(inbox.claim('om_c', START + 10), true);
  assert.equal(inbox.claim('om_a', START + 10), true);
  // The registry is full again with records inside their replay window.
  assert.throws(() => inbox.claim('om_d', START + 11), (error: unknown) => error instanceof ImInboxError && error.code === 'IM_INBOX_FULL');
});

test('inbox: a failed save claims nothing in memory or on disk', () => {
  const dir = scratch('inbox-readonly');
  const inbox = new ImInbox(dir);
  assert.equal(inbox.claim('om_first', START), true);
  const path = join(dir, 'im-inbox.json');
  const before = readFileSync(path, 'utf8');
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => inbox.claim('om_second', START + 1), (error: unknown) =>
      error instanceof ImInboxError && error.code === 'IM_INBOX_IO');
    assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp-')), []);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(readFileSync(path, 'utf8'), before);
  // Nothing was claimed: a restart sees only the first id, and the second is still claimable.
  const reopened = new ImInbox(dir);
  assert.equal(reopened.claim('om_first', START + 2), false);
  assert.equal(reopened.claim('om_second', START + 2), true);
});

test('inbox: a corrupt or unreadable registry fails closed instead of acting as an empty set', () => {
  const dir = scratch('inbox-corrupt');
  const path = join(dir, 'im-inbox.json');
  const garbage = '{"version":1,"entries":[{"id":"om_x", broken';
  writeFileSync(path, garbage, { mode: 0o600 });
  const inbox = new ImInbox(dir);
  assert.throws(() => inbox.claim('om_y', START), (error: unknown) =>
    error instanceof ImInboxError && error.code === 'IM_INBOX_CORRUPT');
  assert.equal(readFileSync(path, 'utf8'), garbage);
  // Unknown fields and bad timestamps are equally rejected.
  writeFileSync(path, JSON.stringify({ version: 1, entries: [{ id: 'om_x', at: START, expiresAt: START + 1, body: 'leak' }] }), { mode: 0o600 });
  assert.throws(() => inbox.claim('om_y', START), (error: unknown) =>
    error instanceof ImInboxError && error.code === 'IM_INBOX_CORRUPT');
  writeFileSync(path, JSON.stringify({ version: 1, entries: [{ id: 'om_x', at: START, expiresAt: START - 1 }] }), { mode: 0o600 });
  assert.throws(() => inbox.claim('om_y', START), (error: unknown) =>
    error instanceof ImInboxError && error.code === 'IM_INBOX_CORRUPT');
});

test('inbox: non-object registry files and entries become fixed typed errors', () => {
  const dir = scratch('inbox-non-object');
  const path = join(dir, 'im-inbox.json');
  for (const bad of ['"text"', '[1,2]', 'null', JSON.stringify({ version: 1, entries: [null] }), JSON.stringify({ version: 1, entries: [['om_x', 1, 2]] })]) {
    writeFileSync(path, bad, { mode: 0o600 });
    assert.throws(() => new ImInbox(dir).claim('om_y', START), (error: unknown) =>
      error instanceof ImInboxError && error.code === 'IM_INBOX_CORRUPT');
  }
});

test('inbox: a claim never deletes files it did not create, including stale temp files', () => {
  const dir = scratch('inbox-temp-safety');
  const inbox = new ImInbox(dir);
  const path = join(dir, 'im-inbox.json');
  const fixtures = new Map([[`${path}.tmp-${process.pid}`, 'leftover-from-an-earlier-run'], [`${path}.tmp-999999`, 'unrelated-leftover']]);
  for (const [name, content] of fixtures) writeFileSync(name, content, { mode: 0o600 });
  assert.equal(inbox.claim('om_temp_safety', START), true);
  for (const [name, content] of fixtures) assert.equal(readFileSync(name, 'utf8'), content);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).entries.length, 1);
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp-') && !fixtures.has(join(dir, name))), []);
});

test('inbox: interleaved claims stay serial and at-most-once', () => {
  const dir = scratch('inbox-serial');
  const inbox = new ImInbox(dir);
  const ids = Array.from({ length: 20 }, (_, i) => `om_${i}`);
  const firsts = ids.map((id, i) => inbox.claim(id, START + i));
  assert.deepEqual(firsts, ids.map(() => true));
  const seconds = ids.map((id, i) => inbox.claim(id, START + 100 + i));
  assert.deepEqual(seconds, ids.map(() => false));
  assert.equal(JSON.parse(readFileSync(inbox.path, 'utf8')).entries.length, 20);
  assert.throws(() => inbox.claim('', START), ImInboxError);
  // A deleted file is rebuilt by the next claim from the in-memory registry.
  unlinkSync(join(dir, 'im-inbox.json'));
  assert.equal(inbox.claim('om_after_delete', START), true);
});

 test('settings: strict v3 roundtrip and explicit legacy failure preserve bytes',()=>{
 const dir=scratch('v2');const store=new ImSettingsStore(dir);store.save(enabledInput());const path=join(dir,'im-settings.json');
 const v2=JSON.parse(readFileSync(path,'utf8'));assert.equal(v2.version,3);assert.equal(new ImSettingsStore(dir).current().config.model,'gpt-test');
 const legacy={...v2,version:1,config:{...v2.config,ownerProfileId:'legacy'}};delete legacy.config.engine;delete legacy.config.model;delete legacy.config.effort;const bytes=JSON.stringify(legacy);writeFileSync(path,bytes,{mode:0o600});
 assert.throws(()=>new ImSettingsStore(dir).current(),{code:'IM_SETTINGS_CORRUPT'});assert.throws(()=>new ImSettingsStore(dir).save(disabledInput()),{code:'IM_SETTINGS_CORRUPT'});assert.equal(readFileSync(path,'utf8'),bytes);
 });

test('settings: malformed independent route fields cannot overwrite a disabled draft',()=>{
 const dir=scratch('route-input');const store=new ImSettingsStore(dir);store.save(disabledInput());const path=join(dir,'im-settings.json');const bytes=readFileSync(path,'utf8');
 for(const patch of [{engine:'bad engine'},{engine:'x'.repeat(129)},{model:'x;echo bad'},{model:'x'.repeat(201)},{effort:'high\n'},{effort:'x'.repeat(33)}]){
 assert.throws(()=>store.save({expectedRevision:1,config:{...disabledInput().config,...patch}}),{code:'IM_SETTINGS_INVALID'});assert.equal(readFileSync(path,'utf8'),bytes);
 }
});

test('settings: v2 normalizes without write/revision change, then CAS saves v3 preserving private values',()=>{
 const dir=scratch('migration');const path=join(dir,'im-settings.json');const {workspaces,...config}=enabledInput({effort:'low'}).config;
 const old={version:2,revision:4,config:{...config,workspace:ROOT}};const bytes=JSON.stringify(old);writeFileSync(path,bytes,{mode:0o600});
 const store=new ImSettingsStore(dir);const loaded=store.current();assert.equal(loaded.revision,4);assert.deepEqual(loaded.config.workspaces,[ROOT]);assert.equal(loaded.config.appSecret,'secret-one');assert.equal(loaded.config.effort,'low');assert.equal(readFileSync(path,'utf8'),bytes);
 assert.throws(()=>store.save({...enabledInput(),expectedRevision:3}),{code:'IM_SETTINGS_CONFLICT'});assert.equal(readFileSync(path,'utf8'),bytes);
 const {appSecret,...publicInput}=loaded.config;
 chmodSync(dir,0o500);try { assert.throws(()=>store.save({expectedRevision:4,config:publicInput}),{code:'IM_SETTINGS_IO'});assert.equal(readFileSync(path,'utf8'),bytes);assert.deepEqual(store.current(),loaded); } finally { chmodSync(dir,0o700); }
 const saved=store.save({expectedRevision:4,config:publicInput});assert.deepEqual(saved,{revision:5,config:loaded.config});assert.equal(JSON.parse(readFileSync(path,'utf8')).version,3);assert.equal(mode(path),0o600);
});
test('settings: unavailable saved directories remain readable; rejected replacement preserves bytes',()=>{
 const dir=scratch('missing-project');const path=join(dir,'im-settings.json');const cfg={...enabledInput().config,workspaces:[join(dir,'missing')]};const bytes=JSON.stringify({version:3,revision:2,config:cfg});writeFileSync(path,bytes,{mode:0o600});
 const store=new ImSettingsStore(dir);assert.deepEqual(store.current().config.workspaces,cfg.workspaces);assert.throws(()=>store.save({expectedRevision:2,config:cfg}),{code:'IM_SETTINGS_INVALID'});assert.equal(readFileSync(path,'utf8'),bytes);assert.equal(existsSync(cfg.workspaces[0]!),false);
 assert.equal(store.save({expectedRevision:2,config:{...cfg,workspaces:[ROOT]}}).revision,3);
});
test('settings: v2 migration failure preserves original bytes and never restores v1/profile API',()=>{
 const dir=scratch('bad-migration');const path=join(dir,'im-settings.json');const cfg=enabledInput().config;const {workspaces,...rest}=cfg;const old={version:2,revision:4,config:{...rest,workspace:42}};const bytes=JSON.stringify(old);writeFileSync(path,bytes,{mode:0o600});assert.throws(()=>new ImSettingsStore(dir).current(),{code:'IM_SETTINGS_CORRUPT'});assert.equal(readFileSync(path,'utf8'),bytes);
 rmSync(path);assert.throws(()=>new ImSettingsStore(dir).save({expectedRevision:0,config:{...rest,workspace:ROOT}} as unknown as SaveImSettingsInput),{code:'IM_SETTINGS_INVALID'});
});


test('settings: disabling an unchanged saved directory after it disappears preserves credentials and the CAS revision', () => {
  const project = scratch('moved-project');
  const dataDir = scratch('disable-missing');
  const store = new ImSettingsStore(dataDir);
  const first = store.save(enabledInput({ workspaces: [project, ROOT], effort: 'low' }));
  const { appSecret: _private, ...input } = first.config;
  rmSync(project, { recursive: true });
  const bytes = readFileSync(store.path, 'utf8');
  assert.throws(() => store.save({ expectedRevision: 0, config: { ...input, enabled: false } }), { code: 'IM_SETTINGS_CONFLICT' });
  assert.equal(readFileSync(store.path, 'utf8'), bytes);
  const off = store.save({ expectedRevision: 1, config: { ...input, enabled: false } });
  assert.equal(off.revision, 2);
  assert.deepEqual(off.config, { ...first.config, enabled: false });
  assert.equal(off.config.effort, 'low');
  assert.throws(() => store.save({ expectedRevision: 2, config: { ...input, enabled: false, workspaces: [join(ROOT, 'other-missing')] } }), { code: 'IM_SETTINGS_INVALID' });
  assert.throws(() => store.save({ expectedRevision: 2, config: { ...input, enabled: true } }), { code: 'IM_SETTINGS_INVALID' });
  assert.throws(() => store.save({ expectedRevision: 2, config: { ...input, enabled: false, workspaces: [ROOT, project] } }), { code: 'IM_SETTINGS_INVALID' }, 'the bypass requires the identical ordered list, not just the same set');
  assert.equal(new ImSettingsStore(dataDir).current().revision, 2);
  assert.equal(mode(store.path), 0o600);
  assert.deepEqual(store.save({ expectedRevision: 2, config: { ...input, enabled: false, workspaces: [] } }).config.workspaces, []);
});

test('settings: disabling an unchanged list does not depend on the current credential-home boundary', () => {
  const project = scratch('newly-protected');
  const store = new ImSettingsStore(scratch('disable-protected'));
  const first = store.save(enabledInput({ workspaces: [project], effort: 'low' }));
  const { appSecret: _private, ...input } = first.config;
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = project;
  try {
    assert.equal(store.save({ expectedRevision: 1, config: { ...input, enabled: false } }).revision, 2);
    assert.throws(() => store.save({ expectedRevision: 2, config: { ...input, enabled: true } }), { code: 'IM_SETTINGS_INVALID' });
  } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
});
