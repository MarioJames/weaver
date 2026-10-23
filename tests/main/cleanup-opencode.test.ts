import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
// Standalone maintenance CLI intentionally uses native ESM.
// @ts-expect-error JavaScript script has no declaration file.
import { cleanup, cutoffTime } from '../../scripts/cleanup-opencode.mjs';
const now = Date.parse('2026-10-23T10:00:00Z');
const cutoff = Date.parse('2026-10-22T16:00:00Z');
function fixture(run: (path: string, db: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-opencode-cleanup-'));
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE session(id TEXT PRIMARY KEY,time_updated INTEGER NOT NULL);
      CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE);
      CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,session_id TEXT NOT NULL);
      CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,seq INTEGER NOT NULL,owner_id TEXT);
      CREATE TABLE event(id TEXT PRIMARY KEY,aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,seq INTEGER,type TEXT,data TEXT);
      CREATE TABLE auth(id TEXT PRIMARY KEY,data TEXT);
      INSERT INTO session VALUES ('old',${cutoff - 1}),('boundary',${cutoff}),('new',${now});
      INSERT INTO message VALUES('m-old','old'),('m-new','new');
      INSERT INTO part VALUES('p-old','m-old','old'),('p-new','m-new','new');
      INSERT INTO event_sequence VALUES('old',1,NULL),('new',1,NULL),('orphan',1,NULL);
      INSERT INTO event VALUES('e-old','old',1,'test','{}'),('e-new','new',1,'test','{}'),('e-orphan','orphan',1,'test','{}');
      INSERT INTO auth VALUES('secret','unchanged');`);
    run(path, db);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}
test('Shanghai calendar boundaries and positive retention', () => {
  assert.equal(cutoffTime(now, 1), cutoff);
  assert.equal(cutoffTime(Date.parse('2026-10-22T15:59:59Z'), 1), cutoff - 86400000);
  assert.equal(cutoffTime(now, 2), cutoff - 86400000);
});
test('preview preserves rows; apply cascades only expired sessions and linked events; repeat is safe', () => fixture((path, db) => {
  const preview = cleanup({ db: path, now });
  assert.equal(preview.status, 'preview');
  assert.deepEqual(preview.expiredIds, ['old']);
  assert.deepEqual(preview.before, preview.after);
  const result = cleanup({ db: path, now, apply: true });
  assert.equal(result.status, 'applied');
  for (const [table, ids] of [['session', ['boundary', 'new']], ['message', ['m-new']], ['part', ['p-new']], ['event', ['e-new', 'e-orphan']]] as const) {
    assert.deepEqual(db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => row.id), ids);
  }
  assert.deepEqual(db.prepare('SELECT aggregate_id FROM event_sequence ORDER BY aggregate_id').all().map(row => row.aggregate_id), ['new', 'orphan']);
  assert.equal(db.prepare('SELECT data FROM auth').get()!.data, 'unchanged');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(cleanup({ db: path, now, apply: true }).expiredIds, []);
}));
test('unknown schema and missing path fail closed', () => fixture((path, db) => {
  db.exec('ALTER TABLE event_sequence RENAME COLUMN owner_id TO unknown');
  assert.throws(() => cleanup({ db: path, now, apply: true }), /Unknown schema/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session').get()!.n, 3);
  const missing = `${path}.missing`;
  assert.throws(() => cleanup({ db: missing }), /does not exist/);
  assert.equal(existsSync(missing), false);
  assert.throws(() => cleanup({ db: path, keepDays: 0 }), /positive integer/);
}));
test('a competing write transaction skips without mutations', () => fixture((path, db) => {
  db.exec('BEGIN IMMEDIATE');
  try { assert.equal(cleanup({ db: path, now, apply: true }).reason, 'database-busy'); }
  finally { db.exec('ROLLBACK'); }
  assert.equal(db.prepare('SELECT count(*) AS n FROM event').get()!.n, 3);
  assert.equal(existsSync(`${path}.cleanup.lock`), false);
}));
test('unsupported restrictive FK fails closed', () => fixture((path, db) => {
  // A restrictive FK is rejected before writes, preserving every row.
  db.exec("CREATE TABLE blocker(session_id TEXT REFERENCES session(id)); INSERT INTO blocker VALUES('old')");
  assert.throws(() => cleanup({ db: path, now, apply: true }), /foreign key/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM event').get()!.n, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session').get()!.n, 3);
}));

test('verification failure after deletions rolls the whole transaction back', () => fixture((path, db) => {
  // SQLite permits NULL in legacy non-INTEGER PRIMARY KEY columns. This row
  // cannot be deleted by equality, so the postcondition must abort the batch.
  db.exec(`INSERT INTO session VALUES(NULL,${cutoff - 1})`);
  assert.throws(() => cleanup({ db: path, now, apply: true }), /verification failed/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM session').get()!.n, 4);
  assert.equal(db.prepare('SELECT count(*) AS n FROM event').get()!.n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM message WHERE session_id='old'").get()!.n, 1);
  assert.equal(existsSync(`${path}.cleanup.lock`), false);
}));

test('reentry skips and does not remove another invocation lock', () => fixture((path) => {
  mkdirSync(`${path}.cleanup.lock`);
  assert.equal(cleanup({ db: path, now, apply: true }).reason, 'cleanup-running');
  assert.equal(existsSync(`${path}.cleanup.lock`), true);
}));
test('active OpenCode holding target DB skips; other databases do not block', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-opencode-process-'));
  const path = join(dir, 'held.db');
  writeFileSync(path, 'fixture');
  const fd = openSync(path, 'r');
  const child = spawn('/bin/sleep', ['60'], { argv0: 'opencode', stdio: ['ignore', 'ignore', 'ignore', fd] });
  try {
    await once(child, 'spawn');
    assert.equal(cleanup({ db: path, now, apply: true }).reason, 'active-opencode');
    assert.equal(child.exitCode, null);
    fixture((otherPath) => assert.equal(cleanup({ db: otherPath, now }).status, 'preview'));
  } finally { child.kill(); await once(child, 'exit'); closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
});
test('CLI emits machine-readable errors and refuses missing database creation', () => {
  const path = join(tmpdir(), `absent-opencode-${process.pid}.db`);
  const result = spawnSync(process.execPath, ['scripts/cleanup-opencode.mjs', '--db', path], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).status, 'error');
  assert.equal(existsSync(path), false);
});

test('known expired lock owner is recovered and vacuum reports actual completion', () => fixture((path, db) => {
  db.exec('PRAGMA journal_mode=WAL');
  mkdirSync(`${path}.cleanup.lock`);
  writeFileSync(`${path}.cleanup.lock/owner.json`, JSON.stringify({ pid: process.pid, start: 'not-this-process-start' }));
  const result = cleanup({ db: path, now, apply: true, vacuum: true });
  assert.equal(result.status, 'applied');
  assert.equal(result.vacuum, 'completed');
  assert.equal(result.deleted.session, 1);
  assert.equal(result.deleted.event, 1);
  assert.ok(result.bytesBefore.database > 0);
  assert.equal(result.bytesAfter['-wal'], 0);
  assert.equal(existsSync(`${path}.cleanup.lock`), false);
}));

test('explicit event pruning preserves sequence values, local projections, auth and orphan groups', () => fixture((path, db) => {
  db.exec(`CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT REFERENCES session(id) ON DELETE CASCADE,data TEXT);
    CREATE TABLE session_input(id TEXT PRIMARY KEY,session_id TEXT REFERENCES session(id) ON DELETE CASCADE,data TEXT);
    CREATE TABLE session_context_epoch(id TEXT PRIMARY KEY,session_id TEXT REFERENCES session(id) ON DELETE CASCADE,data TEXT);
    CREATE TABLE account(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE account_state(id TEXT PRIMARY KEY,data TEXT);
    INSERT INTO account VALUES('a','credential'); INSERT INTO account_state VALUES('a','state');
    INSERT INTO session_message VALUES('v2','new','local history');
    INSERT INTO session_input VALUES('input','new','input');
    INSERT INTO session_context_epoch VALUES('epoch','new','context');
    UPDATE event_sequence SET seq=300,owner_id='owner' WHERE aggregate_id='new';`);
  const before = ['session_message', 'session_input', 'session_context_epoch', 'account', 'account_state'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const preview = cleanup({ db: path, now, pruneEvents: true, eventIdleMinutes: 0 });
  assert.equal(preview.eventPruning.candidateSessions, 2);
  assert.equal(preview.eventPruning.candidateEvents, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM event').get()!.n, 3);
  const result = cleanup({ db: path, now, apply: true, pruneEvents: true, eventIdleMinutes: 0 });
  assert.equal(result.status, 'applied');
  assert.equal(result.deleted.event, 2); // one expired + one retained session
  assert.deepEqual(db.prepare('SELECT id FROM event').all().map(row => row.id), ['e-orphan']);
  assert.deepEqual({ ...db.prepare("SELECT * FROM event_sequence WHERE aggregate_id='new'").get() }, { aggregate_id: 'new', seq: 300, owner_id: 'owner' });
  assert.deepEqual(['session_message', 'session_input', 'session_context_epoch', 'account', 'account_state'].map(table => db.prepare(`SELECT * FROM ${table}`).all()), before);
  const repeated = cleanup({ db: path, now, apply: true, pruneEvents: true, eventIdleMinutes: 0 });
  assert.equal(repeated.eventPruning.candidateEvents, 0);
  assert.equal(repeated.deleted.event, 0);
}));
test('event pruning uses inclusive idle boundary and leaves recent event history', () => fixture((path, db) => {
  const idleBoundary = now - 60 * 60000;
  db.prepare('INSERT INTO session VALUES(?,?)').run('idle', idleBoundary);
  db.prepare('INSERT INTO session VALUES(?,?)').run('recent', idleBoundary + 1);
  db.exec("INSERT INTO event_sequence VALUES('idle',5,'owner'),('recent',5,'owner'); INSERT INTO event VALUES('e-idle','idle',5,'t','{}'),('e-recent','recent',5,'t','{}')");
  const result = cleanup({ db: path, now, apply: true, pruneEvents: true });
  assert.equal(result.eventPruning.idleMinutes, 60);
  assert.equal(result.eventPruning.candidateEvents, 1);
  assert.deepEqual(db.prepare('SELECT id FROM event ORDER BY id').all().map(row => row.id), ['e-new', 'e-orphan', 'e-recent']);
  assert.throws(() => cleanup({ db: path, eventIdleMinutes: -1 }), /non-negative integer/);
  assert.throws(() => cleanup({ db: path, eventIdleMinutes: 1.5 }), /non-negative integer/);
}));

test('out-of-range derived dates fail before locks or database changes', () => fixture((path, db) => {
  for (const options of [{ keepDays: Number.MAX_SAFE_INTEGER }, { eventIdleMinutes: Number.MAX_SAFE_INTEGER }, { now: Number.NaN }, { now: 8640000000000001 }]) {
    assert.throws(() => cleanup({ db: path, now, apply: true, pruneEvents: true, ...options }), /date range|current time/);
    assert.equal(existsSync(`${path}.cleanup.lock`), false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM session').get()!.n, 3);
    assert.equal(db.prepare('SELECT count(*) AS n FROM event').get()!.n, 3);
  }
}));
