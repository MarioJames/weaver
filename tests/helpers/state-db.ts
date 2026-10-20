import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/main/migrate';
import { dbStallStore, type StallState, type StallStateStore } from '../../src/main/stall';
import { dbFreeProbeStore, type FreeProbeState, type FreeProbeStore } from '../../src/main/free-channel';

/** One connection per database file for the whole test process, migrated to the current schema. */
const open = new Map<string, DatabaseSync>();
export function stateDb(path: string): DatabaseSync {
  let db = open.get(path);
  if (!db) {
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    migrate(db);
    open.set(path, db);
  }
  return db;
}

export const stallStoreAt = (path: string, log?: (message: string) => void): StallStateStore => dbStallStore(stateDb(path), log);
export const freeStoreAt = (path: string, log?: (message: string) => void): FreeProbeStore => dbFreeProbeStore(stateDb(path), log);
/** What the monitor persisted, read back through the same tables a restart reads. */
export const readStall = (path: string): StallState => stallStoreAt(path).load();
export const readFree = (path: string): FreeProbeState => freeStoreAt(path).load();

type Raw = any;
const num = (value: unknown) => (value === undefined ? null : value as number | null);
/** Seed rows exactly as given, bypassing validation, so damaged or legacy shapes can be loaded. */
export function seedStall(path: string, raw: { version?: number; engines?: Record<string, Raw>; history?: Raw[] }): void {
  const db = stateDb(path);
  db.exec('DELETE FROM stall_penalties; DELETE FROM stall_history;');
  for (const [engine, item] of Object.entries(raw.engines ?? {})) {
    db.prepare('INSERT INTO stall_penalties(engine,level,last_trigger_at,needs_attention,blocked_until,next_probe_at,probe_successes,head) VALUES (?,?,?,?,?,?,?,?)')
      .run(engine, item.level as number, num(item.lastTriggerAt), item.needsAttention ? 1 : 0, num(item.blockedUntil), num(item.nextProbeAt), (item.probeSuccesses ?? 0) as number, String(item.head ?? ''));
  }
  for (const record of raw.history ?? []) {
    db.prepare('INSERT INTO stall_history(engine,level,at,body) VALUES (?,?,?,?)').run(String(record.engine), record.level as number, record.at as number, JSON.stringify(record));
  }
}
