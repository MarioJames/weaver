import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LADDER_RESET_MS } from '../../src/main/domain/penalties';
import { SCHEMA_VERSION, migrate } from '../../src/main/migrate';

// Step 9 changes data only, so a database sitting at version 8 has exactly the version 9 tables: a fully migrated
// database with its user_version put back to 8 is the historical shape the step has to upgrade.

const version = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number | string }).user_version);
const HOUR = 3_600_000;
const T = Date.parse('2030-01-01T12:00:00Z');

function v8Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.exec(`UPDATE policy_owners SET channel=(SELECT json_extract(body, '$.engine') FROM policy_channels WHERE id=channel) WHERE channel IN (SELECT id FROM policy_channels); UPDATE policy_workers SET channel=(SELECT json_extract(body, '$.engine') FROM policy_channels WHERE id=channel) WHERE channel IN (SELECT id FROM policy_channels); DROP TABLE policy_channels; DROP TABLE channel_secrets; ALTER TABLE policy_owners RENAME COLUMN channel TO engine; ALTER TABLE policy_workers RENAME COLUMN channel TO engine; ALTER TABLE policy_blocks DROP COLUMN channel`);
  // Step 10 added a column; the version 8 shape does not have it.
  db.exec('ALTER TABLE policy_workers DROP COLUMN max_parallel');
  db.exec('PRAGMA user_version=8');
  return db;
}

const probe = (db: DatabaseSync, worker: string, row: { mode: string | null; level: number; last: number | null; blockedUntil?: number | null; nextProbeAt?: number | null; head?: string; blockSince?: string | null; needsAttention?: number; probeSuccesses?: number }) =>
  db.prepare('INSERT INTO free_probe_workers(worker,level,mode,last_trigger_at,needs_attention,blocked_until,next_probe_at,probe_successes,head,block_since) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(worker, row.level, row.mode, row.last, row.needsAttention ?? 0, row.blockedUntil ?? null, row.nextProbeAt ?? null, row.probeSuccesses ?? 0, row.head ?? '', row.blockSince ?? null);
const ladder = (db: DatabaseSync, worker: string, level: number, last: number) =>
  db.prepare('INSERT INTO vendor_worker_limits(worker,level,last_trigger_at) VALUES (?,?,?)').run(worker, level, last);
const ladders = (db: DatabaseSync) => Object.fromEntries((db.prepare('SELECT * FROM vendor_worker_limits ORDER BY worker').all() as Record<string, unknown>[]).map(row => [row.worker, [row.level, row.last_trigger_at]]));
const probes = (db: DatabaseSync) => (db.prepare('SELECT * FROM free_probe_workers ORDER BY worker').all() as Record<string, unknown>[]).map(row => ({ ...row }));

test('the window the merge uses is the ladder reset window', () => {
  assert.equal(LADDER_RESET_MS, 2 * HOUR);
});

test('an empty database migrates from 0 to the current version with both ladder tables in place and nothing in them', () => {
  const db = new DatabaseSync(':memory:');
  assert.equal(version(db), 0);
  migrate(db);
  assert.ok(SCHEMA_VERSION >= 9);
  assert.equal(version(db), SCHEMA_VERSION);
  assert.deepEqual(ladders(db), {});
  assert.deepEqual(probes(db), []);
  migrate(db);
  assert.equal(version(db), SCHEMA_VERSION, 'a current database runs nothing');
  db.close();
});

test('a worker with a rate-limit question in both tables keeps the newer trigger and, inside the window, the higher level', () => {
  const db = v8Database();
  // Probe row newer by 30 minutes, lower level: the higher level of the two wins.
  ladder(db, 'both_close_vendor_higher', 3, T - 30 * 60_000);
  probe(db, 'both_close_vendor_higher', { mode: 'rate_limit', level: 1, last: T });
  // Probe row newer and higher.
  ladder(db, 'both_close_probe_higher', 1, T - 10 * 60_000);
  probe(db, 'both_close_probe_higher', { mode: 'rate_limit', level: 2, last: T });
  // Exactly the window apart is already outside it: the newer trigger's level stands.
  ladder(db, 'both_edge_probe_newer', 3, T - LADDER_RESET_MS);
  probe(db, 'both_edge_probe_newer', { mode: 'rate_limit', level: 1, last: T });
  // Far apart, probe row newer: its level replaces the stale higher one.
  ladder(db, 'both_far_probe_newer', 3, T - 5 * HOUR);
  probe(db, 'both_far_probe_newer', { mode: 'rate_limit', level: 1, last: T });
  // Far apart, dispatch ladder newer: it stays, the stale probe level is dropped.
  ladder(db, 'both_far_vendor_newer', 1, T);
  probe(db, 'both_far_vendor_newer', { mode: 'rate_limit', level: 3, last: T - 5 * HOUR });
  // One second inside the window, dispatch ladder newer: higher level, newer time.
  ladder(db, 'both_inside_vendor_newer', 2, T);
  probe(db, 'both_inside_vendor_newer', { mode: 'rate_limit', level: 3, last: T - LADDER_RESET_MS + 1_000 });
  migrate(db);
  assert.equal(version(db), SCHEMA_VERSION);
  assert.deepEqual(ladders(db), {
    both_close_vendor_higher: [3, T],
    both_close_probe_higher: [2, T],
    both_edge_probe_newer: [1, T],
    both_far_probe_newer: [1, T],
    both_far_vendor_newer: [1, T],
    both_inside_vendor_newer: [3, T],
  });
  db.close();
});

test('a worker known to only one table keeps that row, and a worker known to neither gets none', () => {
  const db = v8Database();
  probe(db, 'probe_only', { mode: 'rate_limit', level: 2, last: T - HOUR, blockedUntil: T + 600_000, nextProbeAt: T + 600_000, head: '429', blockSince: '2030-01-01T11:00:00.000Z' });
  ladder(db, 'dispatch_only', 3, T - 10 * 60_000);
  ladder(db, '@engine:claude', 2, T - 20 * 60_000);
  probe(db, 'healthy', { mode: null, level: 0, last: null });
  migrate(db);
  assert.deepEqual(ladders(db), { '@engine:claude': [2, T - 20 * 60_000], dispatch_only: [3, T - 10 * 60_000], probe_only: [2, T - HOUR] });
  assert.equal(ladders(db).healthy, undefined);
  db.close();
});

test('only rate-limit questions with a ladder move; stall and quota questions and unusable rows stay as they were', () => {
  const db = v8Database();
  probe(db, 'stall_worker', { mode: 'stall', level: 2, last: T - 5 * 60_000, blockedUntil: T, nextProbeAt: T, head: 'auth', blockSince: 's', needsAttention: 0 });
  probe(db, 'quota_worker', { mode: 'quota', level: 1, last: T - 60_000, head: 'quota', blockSince: 'q' });
  probe(db, 'residual_worker', { mode: null, level: 2, last: T - 60_000 });
  probe(db, 'no_time', { mode: 'rate_limit', level: 2, last: null });
  probe(db, 'no_level', { mode: 'rate_limit', level: 0, last: T });
  const before = probes(db).filter(row => ['stall_worker', 'quota_worker', 'residual_worker'].includes(String(row.worker)));
  migrate(db);
  assert.deepEqual(ladders(db), {}, 'nothing else becomes a vendor ladder');
  assert.deepEqual(probes(db).filter(row => ['stall_worker', 'quota_worker', 'residual_worker'].includes(String(row.worker))), before, 'their own ladders and schedules are untouched');
  db.close();
});

test('the probe table keeps its schedule for a merged question but no longer holds the rate-limit level', () => {
  const db = v8Database();
  probe(db, 'qoder_worker', { mode: 'rate_limit', level: 2, last: T, blockedUntil: T + 1_800_000, nextProbeAt: T + 1_800_000, head: '429 too many requests', blockSince: '2030-01-01T12:00:00.000Z', needsAttention: 0, probeSuccesses: 0 });
  migrate(db);
  assert.deepEqual(ladders(db), { qoder_worker: [2, T] });
  assert.deepEqual(probes(db), [{
    worker: 'qoder_worker', level: 0, mode: 'rate_limit', last_trigger_at: null, needs_attention: 0,
    blocked_until: T + 1_800_000, next_probe_at: T + 1_800_000, probe_successes: 0, head: '429 too many requests', block_since: '2030-01-01T12:00:00.000Z',
  }]);
  db.close();
});

test('running the migration again, even from version 8 once more, neither fails nor changes data', () => {
  const db = v8Database();
  ladder(db, 'w1', 3, T - 30 * 60_000);
  probe(db, 'w1', { mode: 'rate_limit', level: 1, last: T, nextProbeAt: T + 600_000 });
  probe(db, 'w2', { mode: 'rate_limit', level: 2, last: T - HOUR });
  probe(db, 'w3', { mode: 'stall', level: 3, last: T - 60_000, needsAttention: 1, head: 'stuck' });
  migrate(db);
  const merged = { ladders: ladders(db), probes: probes(db) };
  assert.deepEqual(merged.ladders, { w1: [3, T], w2: [2, T - HOUR] });
  migrate(db);
  assert.deepEqual({ ladders: ladders(db), probes: probes(db) }, merged, 'a current database is left alone');
  db.exec('ALTER TABLE policy_workers DROP COLUMN max_parallel');
  db.exec(`UPDATE policy_owners SET channel=(SELECT json_extract(body, '$.engine') FROM policy_channels WHERE id=channel) WHERE channel IN (SELECT id FROM policy_channels); UPDATE policy_workers SET channel=(SELECT json_extract(body, '$.engine') FROM policy_channels WHERE id=channel) WHERE channel IN (SELECT id FROM policy_channels); DROP TABLE policy_channels; DROP TABLE channel_secrets; ALTER TABLE policy_owners RENAME COLUMN channel TO engine; ALTER TABLE policy_workers RENAME COLUMN channel TO engine; ALTER TABLE policy_blocks DROP COLUMN channel`);
  db.exec('PRAGMA user_version=8');
  migrate(db);
  assert.equal(version(db), SCHEMA_VERSION);
  assert.deepEqual({ ladders: ladders(db), probes: probes(db) }, merged, 'and so is one that runs the step a second time');
  db.close();
});
