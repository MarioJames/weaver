import { migrateChannelPolicy } from '../shared/policy/channels';
import type { DatabaseSync } from 'node:sqlite';

/** Every schema change lands here as one ordered step; PRAGMA user_version tracks what ran. */
export const SCHEMA_VERSION = 13;

/** A step is plain SQL, or a function for data work SQL alone cannot express (here: rewriting JSON snapshots). */
type Step = (string | ((db: DatabaseSync) => void))[];

const STEPS: Step[] = [
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
  // 10: workers may carry an optional concurrency cap: tasks this worker runs at once across every owner.
  // Nullable; NULL (or an absent older snapshot) means no cap, so a plain ALTER TABLE upgrades any database in place.
  [
    `ALTER TABLE policy_workers ADD COLUMN max_parallel INTEGER`,
  ],
  // 11: the zcode engine is gone (ZCode is a desktop client, not a schedulable agent engine). Remove what an older default
  // policy and its users left behind: the engine rows of kind 'zcode', every worker and owner running on them, the
  // owner-to-worker links and weights that name those workers, blocks aimed at them, and their runtime state (stall, quota,
  // free-channel probe and vendor ladder rows). An owner of another engine whose workers were all zcode ones is deleted too
  // (an owner needs at least one worker to pass the schema); one that keeps workers but loses its last enabled one is
  // disabled instead, because an enabled owner without an enabled worker fails policy validation. Either would otherwise
  // stop the whole policy from loading. Task history is not touched: tasks keep dispatch.engine/run.adapter 'zcode'
  // as plain text. Saved policy snapshots (policy_revisions) are pruned the same way so a rollback to an old revision is
  // not refused by the schema. Idempotent: with nothing of kind 'zcode' left every statement matches no rows.
  [
    `UPDATE policy_owners SET enabled = 0 WHERE enabled = 1 AND engine NOT IN (SELECT id FROM policy_engines WHERE kind = 'zcode')
       AND EXISTS (SELECT 1 FROM policy_owner_workers l WHERE l.owner_id = policy_owners.id AND l.worker_id IN (SELECT id FROM policy_workers WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode')))
       AND NOT EXISTS (SELECT 1 FROM policy_owner_workers l JOIN policy_workers w ON w.id = l.worker_id
                       WHERE l.owner_id = policy_owners.id AND w.enabled = 1 AND w.engine NOT IN (SELECT id FROM policy_engines WHERE kind = 'zcode'))`,
    `DELETE FROM policy_owners WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode')
       OR (EXISTS (SELECT 1 FROM policy_owner_workers l WHERE l.owner_id = policy_owners.id AND l.worker_id IN (SELECT id FROM policy_workers WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode')))
           AND NOT EXISTS (SELECT 1 FROM policy_owner_workers l WHERE l.owner_id = policy_owners.id AND l.worker_id NOT IN (SELECT id FROM policy_workers WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode'))))`,
    `DELETE FROM policy_owner_workers WHERE worker_id IN (SELECT id FROM policy_workers WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode')) OR owner_id NOT IN (SELECT id FROM policy_owners)`,
    `DELETE FROM policy_blocks WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode') OR worker IN (SELECT id FROM policy_workers WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode'))`,
    `DELETE FROM stall_penalties WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode')`,
    `DELETE FROM stall_history WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode')`,
    `DELETE FROM quota_records WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode')`,
    `DELETE FROM free_probe_history WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode') OR worker IN (SELECT id FROM policy_workers WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode'))`,
    `DELETE FROM free_probe_workers WHERE worker IN (SELECT id FROM policy_workers WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode'))`,
    `DELETE FROM vendor_worker_limits WHERE worker IN (SELECT id FROM policy_workers WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode'))`,
    `DELETE FROM policy_workers WHERE engine IN (SELECT id FROM policy_engines WHERE kind = 'zcode')`,
    `DELETE FROM policy_engines WHERE kind = 'zcode'`,
    dropZcodeFromSnapshots,
  ],
  // 12: the temp-directory janitor keeps one bounded history row per sweep, so every removal or skip is queryable.
  [
    `CREATE TABLE IF NOT EXISTS janitor_sweeps(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, body TEXT NOT NULL)`,
  ],
  // 13: channel metadata and independent private native configuration. No cascading FK: policy rewrites metadata.
  [
    `CREATE TABLE policy_channels(id TEXT PRIMARY KEY, position INTEGER NOT NULL, body TEXT NOT NULL)`,
    `CREATE TABLE channel_secrets(id TEXT PRIMARY KEY, body TEXT NOT NULL)`,
    `ALTER TABLE policy_owners RENAME COLUMN engine TO channel`,
    `ALTER TABLE policy_workers RENAME COLUMN engine TO channel`,
    `ALTER TABLE policy_blocks ADD COLUMN channel TEXT`,
    migrateChannels,
  ],
];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The same removal as step 11's SQL, applied to one saved policy snapshot body; returns the new body, or undefined when nothing changes. */
function withoutZcode(body: string): string | undefined {
  let snapshot: unknown;
  try { snapshot = JSON.parse(body); } catch { return undefined; }
  if (!isRecord(snapshot) || !isRecord(snapshot.config) || !isRecord(snapshot.config.engines)) return undefined;
  const { config } = snapshot;
  const engines = config.engines as Record<string, unknown>;
  const gone = new Set(Object.keys(engines).filter(id => isRecord(engines[id]) && engines[id].kind === 'zcode'));
  if (!gone.size) return undefined;
  const workers: Record<string, unknown> = isRecord(config.workers) ? config.workers : {};
  const goneWorkers = new Set(Object.keys(workers).filter(id => { const worker = workers[id]; return isRecord(worker) && gone.has(String(worker.engine)); }));
  for (const id of goneWorkers) delete workers[id];
  const enabledWorker = (id: unknown) => { const worker = workers[String(id)]; return isRecord(worker) && worker.enabled === true; };
  const owners: Record<string, unknown> = isRecord(config.owners) ? config.owners : {};
  for (const [id, owner] of Object.entries(owners)) {
    if (!isRecord(owner)) continue;
    if (gone.has(String(owner.engine))) { delete owners[id]; continue; }
    if (!Array.isArray(owner.workers) || !owner.workers.some(worker => goneWorkers.has(String(worker)))) continue;
    const kept = owner.workers.filter(worker => !goneWorkers.has(String(worker)));
    if (!kept.length) { delete owners[id]; continue; }
    owner.workers = kept;
    if (isRecord(owner.worker_weights)) for (const worker of goneWorkers) delete owner.worker_weights[worker];
    if (owner.enabled === true && !kept.some(enabledWorker)) owner.enabled = false;
  }
  for (const id of gone) delete engines[id];
  if (Array.isArray(snapshot.blocks)) {
    snapshot.blocks = snapshot.blocks.filter(block => !isRecord(block) || !(gone.has(String(block.engine)) || (typeof block.worker === 'string' && goneWorkers.has(block.worker))));
  }
  return JSON.stringify(snapshot);
}

function dropZcodeFromSnapshots(db: DatabaseSync): void {
  const update = db.prepare('UPDATE policy_revisions SET body=? WHERE revision=?');
  for (const row of db.prepare('SELECT revision, body FROM policy_revisions').all() as { revision: number | bigint; body: string }[]) {
    const next = withoutZcode(String(row.body));
    if (next !== undefined) update.run(next, row.revision);
  }
}

/** Bring an opened database up to SCHEMA_VERSION: empty at 0 runs every step, current runs nothing. */
export function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number | string }).user_version);
  if (!Number.isSafeInteger(current) || current < 0) throw new Error(`Invalid Weaver database schema version: ${current}`);
  if (current > SCHEMA_VERSION) throw new Error(`Weaver database schema version ${current} is newer than this build supports (${SCHEMA_VERSION})`);
  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of STEPS[version - 1]!) { if (typeof statement === 'string') db.exec(statement); else statement(db); }
      db.exec(`PRAGMA user_version=${version}`);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back an I/O failure. */ }
      throw new Error(`Weaver database migration to version ${version} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

function migrateChannels(db: DatabaseSync): void {
 const engines=Object.fromEntries((db.prepare('SELECT * FROM policy_engines ORDER BY position').all() as any[]).map(r=>[r.id,{kind:r.kind,enabled:!!r.enabled,...(r.quota_refresh!==null?{quota_refresh:!!r.quota_refresh}:{})}]));
 const owners=Object.fromEntries((db.prepare('SELECT * FROM policy_owners').all() as any[]).map(r=>[r.id,{engine:r.channel,model:r.model}]));
 const workers=Object.fromEntries((db.prepare('SELECT * FROM policy_workers').all() as any[]).map(r=>[r.id,{engine:r.channel,model:r.model}]));
 const originalWorkers=structuredClone(workers);
 const upgraded=migrateChannelPolicy({engines,owners,workers});
 const insert=db.prepare('INSERT INTO policy_channels(id,position,body) VALUES (?,?,?)');
 db.exec('UPDATE policy_engines SET quota_refresh=NULL');
 Object.entries(upgraded.config.channels).forEach(([id,ch],i)=>insert.run(id,i,JSON.stringify(ch)));
 for (const table of ['policy_owners','policy_workers']) db.exec(`UPDATE ${table} SET channel='default_' || channel`);
 const blocks=(db.prepare('SELECT * FROM policy_blocks').all() as any[]).map(row=>Object.fromEntries(Object.entries(row).filter(([,value])=>value!==null))) as any[];
 for(const block of blocks){
  const result=migrateChannelPolicy({engines:structuredClone(engines),owners:{},workers:structuredClone(originalWorkers)},[block]).blocks;
  if(!result.length) db.prepare('DELETE FROM policy_blocks WHERE position=?').run(block.position);
  else if(result[0].channel) db.prepare('UPDATE policy_blocks SET channel=? WHERE position=?').run(result[0].channel,block.position);
 }
 const update=db.prepare('UPDATE policy_revisions SET body=? WHERE revision=?');
 for(const row of db.prepare('SELECT revision,body FROM policy_revisions').all() as any[]){
  let body:Record<string,any>;try{body=JSON.parse(row.body);}catch{continue;}
  if(!isRecord(body)||!isRecord(body.config)||!isRecord(body.config.engines)||!isRecord(body.config.owners)||!isRecord(body.config.workers)||!Array.isArray(body.blocks))continue;
  const next=migrateChannelPolicy(body.config,body.blocks??[]);body.config=next.config;body.blocks=next.blocks;
  update.run(JSON.stringify(body),row.revision);
 }
}
