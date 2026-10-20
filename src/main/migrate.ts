import type { DatabaseSync } from 'node:sqlite';

/** Every schema change lands here as one ordered step; PRAGMA user_version tracks what ran. */
export const SCHEMA_VERSION = 9;

const STEPS: string[][] = [
  // 1: the task store tables.
  [
    `CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, owner_id TEXT, parent_task_id TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_id)`,
    `CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id)`,
    `CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status)`,
    `CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at)`,
    `CREATE TABLE IF NOT EXISTS task_events(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, id TEXT NOT NULL, position INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id,id))`,
    `CREATE INDEX IF NOT EXISTS task_events_position ON task_events(task_id,position)`,
    `CREATE TABLE IF NOT EXISTS artifacts(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, id TEXT NOT NULL, position INTEGER NOT NULL, body TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(task_id,id))`,
    `CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY, body TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS packages(id TEXT PRIMARY KEY, body TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY, body TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, body TEXT NOT NULL)`,
  ],
  // 2: the policy store: normalized config plus the revision history a rollback reads.
  [
    `CREATE TABLE IF NOT EXISTS policy_engines(id TEXT PRIMARY KEY, position INTEGER NOT NULL, enabled INTEGER NOT NULL, kind TEXT NOT NULL, quota_refresh INTEGER)`,
    `CREATE TABLE IF NOT EXISTS policy_owners(id TEXT PRIMARY KEY, position INTEGER NOT NULL, enabled INTEGER NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, proxy TEXT, max_parallel INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS policy_owner_workers(owner_id TEXT NOT NULL REFERENCES policy_owners(id) ON DELETE CASCADE, worker_id TEXT NOT NULL, position INTEGER NOT NULL, weight INTEGER, PRIMARY KEY(owner_id, worker_id))`,
    `CREATE TABLE IF NOT EXISTS policy_workers(id TEXT PRIMARY KEY, position INTEGER NOT NULL, enabled INTEGER NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, proxy TEXT, description TEXT, free_channel INTEGER)`,
    `CREATE TABLE IF NOT EXISTS policy_settings(key TEXT PRIMARY KEY, body TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS policy_blocks(position INTEGER PRIMARY KEY, engine TEXT NOT NULL, model TEXT, reason TEXT NOT NULL, since TEXT NOT NULL, release_at TEXT, by TEXT)`,
    `CREATE TABLE IF NOT EXISTS policy_revisions(revision INTEGER PRIMARY KEY, saved_at TEXT NOT NULL, source TEXT NOT NULL, body TEXT NOT NULL)`,
  ],
  // 3: the stall monitor: per-engine ladder state and the retained history.
  [
    `CREATE TABLE IF NOT EXISTS stall_penalties(engine TEXT PRIMARY KEY, level INTEGER NOT NULL, last_trigger_at INTEGER, needs_attention INTEGER NOT NULL, blocked_until INTEGER, next_probe_at INTEGER, probe_successes INTEGER NOT NULL, head TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS stall_history(id INTEGER PRIMARY KEY AUTOINCREMENT, engine TEXT NOT NULL, level INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL)`,
  ],
  // 4: the free-channel probe monitor: per-worker question state and probe history.
  [
    `CREATE TABLE IF NOT EXISTS free_probe_workers(worker TEXT PRIMARY KEY, level INTEGER NOT NULL, mode TEXT, last_trigger_at INTEGER, needs_attention INTEGER NOT NULL, blocked_until INTEGER, next_probe_at INTEGER, probe_successes INTEGER NOT NULL, head TEXT NOT NULL, block_since TEXT)`,
    `CREATE TABLE IF NOT EXISTS free_probe_history(id INTEGER PRIMARY KEY AUTOINCREMENT, worker TEXT NOT NULL, engine TEXT NOT NULL, level INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL)`,
  ],
  // 5: the quota prober: the last observation per engine plus its credential and pacing state.
  [
    `CREATE TABLE IF NOT EXISTS quota_records(engine TEXT PRIMARY KEY, body TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS quota_state(key TEXT PRIMARY KEY, body TEXT NOT NULL)`,
  ],
  // 6: the vendor rate-limit ladder per engine (was a kv blob).
  [
    `CREATE TABLE IF NOT EXISTS vendor_limits(engine TEXT PRIMARY KEY, level INTEGER NOT NULL, last_trigger_at INTEGER NOT NULL)`,
  ],
  // 7: blocks can name one worker, and the vendor rate-limit ladder is kept per worker (the per-engine rows are dropped).
  [
    `ALTER TABLE policy_blocks ADD COLUMN worker TEXT`,
    `DROP TABLE IF EXISTS vendor_limits`,
    `CREATE TABLE IF NOT EXISTS vendor_worker_limits(worker TEXT PRIMARY KEY, level INTEGER NOT NULL, last_trigger_at INTEGER NOT NULL)`,
  ],
  // 8: owners and workers no longer carry a proxy; every agent process uses the service process environment.
  // Saved policy snapshots drop the field too (a JSON merge-patch with null deletes the key; only snapshots that hold at least one role object are touched), or a rollback to one would be refused by the schema.
  [
    `ALTER TABLE policy_owners DROP COLUMN proxy`,
    `ALTER TABLE policy_workers DROP COLUMN proxy`,
    `UPDATE policy_revisions SET body=json_patch(body, json_object('config', json_object('owners', json((SELECT json_group_object(key, json_object('proxy', json('null'))) FROM json_each(body, '$.config.owners') WHERE type='object'))))) WHERE CASE WHEN json_valid(body) THEN json_type(body, '$.config.owners')='object' AND EXISTS (SELECT 1 FROM json_each(body, '$.config.owners') WHERE type='object') ELSE 0 END`,
    `UPDATE policy_revisions SET body=json_patch(body, json_object('config', json_object('workers', json((SELECT json_group_object(key, json_object('proxy', json('null'))) FROM json_each(body, '$.config.workers') WHERE type='object'))))) WHERE CASE WHEN json_valid(body) THEN json_type(body, '$.config.workers')='object' AND EXISTS (SELECT 1 FROM json_each(body, '$.config.workers') WHERE type='object') ELSE 0 END`,
  ],
  // 9: one vendor rate-limit ladder per worker. The free-channel probe used to keep its own rate-limit level in
  // free_probe_workers (level, last_trigger_at of rows with mode 'rate_limit'); those rows merge into vendor_worker_limits
  // and the probe table keeps only the probe schedule for them. Merge rule per worker present in both tables:
  // last_trigger_at is the newer of the two; the level is the higher one when the two triggers are less than 7200000 ms
  // (LADDER_RESET_MS, the 2 hour reset window) apart, otherwise the level of the newer trigger. A worker in only one
  // table keeps its row. Rows with no trigger time or no level carry no ladder and are not merged. Idempotent.
  [
    `INSERT INTO vendor_worker_limits(worker, level, last_trigger_at)
     SELECT worker, level, last_trigger_at FROM free_probe_workers WHERE mode = 'rate_limit' AND last_trigger_at IS NOT NULL AND level > 0
     ON CONFLICT(worker) DO UPDATE SET
       level = CASE
         WHEN abs(excluded.last_trigger_at - vendor_worker_limits.last_trigger_at) < 7200000 THEN max(excluded.level, vendor_worker_limits.level)
         WHEN excluded.last_trigger_at > vendor_worker_limits.last_trigger_at THEN excluded.level
         ELSE vendor_worker_limits.level
       END,
       last_trigger_at = max(excluded.last_trigger_at, vendor_worker_limits.last_trigger_at)`,
    `UPDATE free_probe_workers SET level = 0, last_trigger_at = NULL WHERE mode = 'rate_limit'`,
  ],
];

/** Bring an opened database up to SCHEMA_VERSION: empty at 0 runs every step, current runs nothing. */
export function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number | string }).user_version);
  if (!Number.isSafeInteger(current) || current < 0) throw new Error(`Invalid Weaver database schema version: ${current}`);
  if (current > SCHEMA_VERSION) throw new Error(`Weaver database schema version ${current} is newer than this build supports (${SCHEMA_VERSION})`);
  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of STEPS[version - 1]!) db.exec(statement);
      db.exec(`PRAGMA user_version=${version}`);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back an I/O failure. */ }
      throw new Error(`Weaver database migration to version ${version} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}
