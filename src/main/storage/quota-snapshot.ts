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
export interface QuotaSnapshotStore { load(): QuotaPersistence | undefined; save(snapshot: QuotaPersistence): void; invalidateChannel?(id:string): void; channelRecords?(): EngineQuotaRecord[]; scope?(id: string): QuotaSnapshotStore }

/** The weaver.db quota tables: one observation row per engine plus the prober's own pacing keys. */
export function dbQuotaStore(db: DatabaseSync, namespace = ''): QuotaSnapshotStore {
  const prefix = namespace ? `channel:${namespace}:` : '';
  return {
    invalidateChannel: id => {
      const start=`channel:${id}:`;
      for(const row of db.prepare('SELECT engine,body FROM quota_records').all() as {engine:string;body:string}[]) {
        if(!row.engine.startsWith(start))continue;
        const record=JSON.parse(row.body) as EngineQuotaRecord;
        db.prepare('UPDATE quota_records SET body=? WHERE engine=?').run(JSON.stringify({...record,status:'error',stale:true,detail:'账号认证失败，请刷新认证后重新获取额度'}),row.engine);
      }
    },
    channelRecords: () => (db.prepare('SELECT engine,body FROM quota_records').all() as {engine:string;body:string}[]).flatMap(row=>{
      if(!row.engine.startsWith('channel:'))return [];
      const split=row.engine.lastIndexOf(':');
      const channel=row.engine.slice('channel:'.length,split);
      const record=JSON.parse(row.body) as EngineQuotaRecord;
      return [{channel,engine:record.engine,source:record.source,status:record.status,checkedAt:record.checkedAt,observedAt:record.observedAt,stale:record.stale,windows:record.windows,detail:'',retryAt:record.retryAt,...(record.statusBasis?{statusBasis:record.statusBasis}:{})}];
    }),
    scope: id => dbQuotaStore(db, id),
    load(): QuotaPersistence | undefined {
      const records: QuotaPersistence['records'] = {};
      for (const row of db.prepare('SELECT engine,body FROM quota_records').all() as Record<string, unknown>[]) {
        const key = String(row.engine);
        if (prefix ? !key.startsWith(prefix) : key.startsWith('channel:')) continue;
        const engine = key.slice(prefix.length) as QuotaEngine;
        if (ENGINES.includes(engine)) records[engine] = JSON.parse(String(row.body)) as EngineQuotaRecord;
      }
      const state: QuotaPersistence = { records, fingerprints: {}, lastAccounts: {}, nextRequests: {} };
      for (const row of db.prepare('SELECT key,body FROM quota_state').all() as Record<string, unknown>[]) {
        const stored = String(row.key);
        if (prefix ? !stored.startsWith(prefix) : stored.startsWith('channel:')) continue;
        const key = stored.slice(prefix.length);
        if (!(key in state)) continue;
        Object.assign(state[key as keyof QuotaPersistence] as Record<string, unknown>, JSON.parse(String(row.body)));
      }
      return state;
    },
    save(snapshot: QuotaPersistence): void {
      transact(db, () => {
        for (const row of db.prepare('SELECT engine FROM quota_records').all()) {const key=String(row.engine);if(prefix?key.startsWith(prefix):!key.startsWith('channel:'))db.prepare('DELETE FROM quota_records WHERE engine=?').run(key);}
        const insertRecord = db.prepare('INSERT INTO quota_records(engine,body) VALUES (?,?)');
        for (const [engine, record] of Object.entries(snapshot.records)) if (record) insertRecord.run(`${prefix}${engine}`, JSON.stringify(record));
        for(const row of db.prepare('SELECT key FROM quota_state').all()){const key=String(row.key);if(prefix?key.startsWith(prefix):!key.startsWith('channel:'))db.prepare('DELETE FROM quota_state WHERE key=?').run(key);}
        const insertState = db.prepare('INSERT INTO quota_state(key,body) VALUES (?,?)');
        for (const key of ['fingerprints', 'lastAccounts', 'nextRequests'] as const) insertState.run(`${prefix}${key}`, JSON.stringify(snapshot[key]));
      });
    },
  };
}
