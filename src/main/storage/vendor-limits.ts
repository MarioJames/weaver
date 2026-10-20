import type { DatabaseSync } from 'node:sqlite';
import type { Transactional } from './transaction';

/** Where one vendor rate-limit ladder stands: its current level and when it last stepped. */
export type VendorLimit = { level: number; lastTriggerAt: number };

/** Ladder key for a dispatch that names no worker: the per-engine ladder. */
export const engineLadderKey = (engine: string): string => `@engine:${engine}`;

/**
 * The vendor rate-limit ladder, one durable row per worker (an engine-only dispatch uses its engine key). Both the
 * dispatch-failure path and the free-channel probe step this one ladder, and it survives restarts and explicit
 * block removal.
 */
export interface VendorLadderStore extends Transactional {
  get(key: string): VendorLimit | undefined;
  list(): Record<string, VendorLimit>;
  put(key: string, limit: VendorLimit): void;
}

export function dbVendorLadder(db: DatabaseSync): VendorLadderStore {
  const limit = (row: Record<string, unknown>): VendorLimit => ({ level: Number(row.level), lastTriggerAt: Number(row.last_trigger_at) });
  return {
    connection: db,
    get(key: string): VendorLimit | undefined {
      const row = db.prepare('SELECT level,last_trigger_at FROM vendor_worker_limits WHERE worker=?').get(key);
      return row ? limit(row) : undefined;
    },
    list(): Record<string, VendorLimit> {
      return Object.fromEntries(db.prepare('SELECT worker,level,last_trigger_at FROM vendor_worker_limits ORDER BY worker').all().map(row => [String(row.worker), limit(row)]));
    },
    put(key: string, value: VendorLimit): void {
      db.prepare('INSERT INTO vendor_worker_limits(worker,level,last_trigger_at) VALUES (?,?,?) ON CONFLICT(worker) DO UPDATE SET level=excluded.level,last_trigger_at=excluded.last_trigger_at').run(key, value.level, value.lastTriggerAt);
    },
  };
}
