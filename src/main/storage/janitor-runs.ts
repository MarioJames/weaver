import type { DatabaseSync } from 'node:sqlite';
import type { JanitorSweepResult } from '../../shared/contracts/janitor';
import { transact, type Transactional } from './transaction';

/** Newest sweeps kept in weaver.db; each one already bounds its own entry list. */
export const JANITOR_HISTORY_LIMIT = 50;

export interface JanitorRunStore extends Transactional {
  /** Newest first. */
  load(): JanitorSweepResult[];
  save(result: JanitorSweepResult): void;
}

/** The janitor's durable record: one JSON row per sweep, pruned to the newest JANITOR_HISTORY_LIMIT. */
export function dbJanitorStore(db: DatabaseSync, log: (message: string) => void = message => console.error(message)): JanitorRunStore {
  return {
    connection: db,
    load(): JanitorSweepResult[] {
      const rows = db.prepare('SELECT body FROM janitor_sweeps ORDER BY id DESC LIMIT ?').all(JANITOR_HISTORY_LIMIT) as Record<string, unknown>[];
      const history: JanitorSweepResult[] = [];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(String(row.body)) as JanitorSweepResult;
          if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) history.push(parsed);
        } catch {
          log('Janitor sweep record ignored: unreadable');
        }
      }
      return history;
    },
    save(result: JanitorSweepResult): void {
      transact(db, () => {
        db.prepare('INSERT INTO janitor_sweeps(at,body) VALUES (?,?)').run(Date.parse(result.finishedAt), JSON.stringify(result));
        db.prepare('DELETE FROM janitor_sweeps WHERE id NOT IN (SELECT id FROM janitor_sweeps ORDER BY id DESC LIMIT ?)').run(JANITOR_HISTORY_LIMIT);
      });
    },
  };
}
