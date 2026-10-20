import type { DatabaseSync } from 'node:sqlite';
import type { EngineQuotaRecord, QuotaEngine } from '../../shared/contracts/quota';
import { QUOTA_ENGINES as ENGINES } from '../domain/quota-engines';
import { transact } from './transaction';

/** What the prober keeps across restarts: the last observation per engine plus its credential and pacing state. */
export interface QuotaPersistence {
  records: Partial<Record<QuotaEngine, EngineQuotaRecord>>;
  fingerprints: Partial<Record<QuotaEngine, string>>;
  lastAccounts: Partial<Record<QuotaEngine, string>>;
  nextRequests: Partial<Record<QuotaEngine, number>>;
}

/** Where the prober persists its snapshot: a DatabaseSync-backed adapter in product, nothing in tests. */
export interface QuotaSnapshotStore { load(): QuotaPersistence | undefined; save(snapshot: QuotaPersistence): void }

/** The weaver.db quota tables: one observation row per engine plus the prober's own pacing keys. */
export function dbQuotaStore(db: DatabaseSync): QuotaSnapshotStore {
  return {
    load(): QuotaPersistence | undefined {
      const records: QuotaPersistence['records'] = {};
      for (const row of db.prepare('SELECT engine,body FROM quota_records').all() as Record<string, unknown>[]) {
        const engine = String(row.engine) as QuotaEngine;
        if (ENGINES.includes(engine)) records[engine] = JSON.parse(String(row.body)) as EngineQuotaRecord;
      }
      const state: QuotaPersistence = { records, fingerprints: {}, lastAccounts: {}, nextRequests: {} };
      for (const row of db.prepare('SELECT key,body FROM quota_state').all() as Record<string, unknown>[]) {
        const key = String(row.key);
        if (!(key in state)) continue;
        Object.assign(state[key as keyof QuotaPersistence] as Record<string, unknown>, JSON.parse(String(row.body)));
      }
      return state;
    },
    save(snapshot: QuotaPersistence): void {
      transact(db, () => {
        db.exec('DELETE FROM quota_records');
        const insertRecord = db.prepare('INSERT INTO quota_records(engine,body) VALUES (?,?)');
        for (const [engine, record] of Object.entries(snapshot.records)) if (record) insertRecord.run(engine, JSON.stringify(record));
        db.exec('DELETE FROM quota_state');
        const insertState = db.prepare('INSERT INTO quota_state(key,body) VALUES (?,?)');
        for (const key of ['fingerprints', 'lastAccounts', 'nextRequests'] as const) insertState.run(key, JSON.stringify(snapshot[key]));
      });
    },
  };
}
