import type { DatabaseSync } from 'node:sqlite';
import { object } from '../../shared/validation';
import type { StallHistoryRecord } from '../../shared/contracts/monitoring';
import { PROBE_SUCCESSES, STALL_LADDER } from '../domain/penalties';
import { boundedProbeError } from '../redact-context';

export const HISTORY_LIMIT = 50;
/** How many of a trigger's task ids the record keeps: the count stays whole, the ids are bounded. */
export const RECORD_TASKS_MAX = 50;

/** One line of the record: a trigger carries tasks, a probe carries its route and outcome, a recovery carries a message. */
export type StallRecord = Omit<StallHistoryRecord, 'at'> & { at: number };

export interface EnginePenalty {
  level: number;
  lastTriggerAt: number | null;
  needsAttention: boolean;
  /** Nominal deadline of the current penalty. It is not a policy release time: no stall block ever expires on its own. */
  blockedUntil: number | null;
  nextProbeAt: number | null;
  /** Consecutive passing probes at level 3; any failure or escalation resets it. */
  probeSuccesses: number;
  /** The evidence the penalty was triggered with, so an escalation can restate the block honestly. */
  head: string;
}

export interface StallState { engines: Record<string, EnginePenalty>; history: StallRecord[] }

export const emptyState = (): StallState => ({ engines: {}, history: [] });

function numberOr(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid stall ${name}`);
  return value;
}

function integerOr(value: unknown, name: string, max: number): number {
  const number = numberOr(value, name);
  if (!Number.isInteger(number) || number < 0 || number > max) throw new Error(`Invalid stall ${name}`);
  return number;
}

function timestampOr(value: unknown, name: string): number {
  const number = numberOr(value, name);
  if (!Number.isFinite(new Date(number).getTime())) throw new Error(`Invalid stall ${name}`);
  return number;
}

/** A stall record is either a trigger, a probe or a recovery; each keeps engine, level, time and task ids. */
function parseRecord(raw: unknown): StallRecord {
  const item = object(raw);
  if (typeof item.engine !== 'string' || !item.engine) throw new Error('Invalid stall history engine');
  if (!Array.isArray(item.tasks) || item.tasks.length > RECORD_TASKS_MAX || item.tasks.some(id => typeof id !== 'string')) throw new Error('Invalid stall history tasks');
  const record: StallRecord = { engine: item.engine, level: integerOr(item.level, 'history level', STALL_LADDER.length), at: timestampOr(item.at, 'history at'), tasks: item.tasks as string[] };
  // The count is what the evidence covered; an unbounded id list would be a file that cannot be read back.
  if (item.taskCount !== undefined) {
    if (!Number.isSafeInteger(item.taskCount) || (item.taskCount as number) < item.tasks.length) throw new Error('Invalid stall history taskCount');
    record.taskCount = item.taskCount as number;
  }
  // `minutes` is what this field was called before probes were recorded.
  const minutes = item.stalledMinutes ?? item.minutes;
  if (minutes !== undefined) record.stalledMinutes = numberOr(minutes, 'history minutes');
  if (item.probe !== undefined) {
    const probe = object(item.probe);
    record.probe = { ok: probe.ok === true, ms: numberOr(probe.ms, 'probe ms'), ...(typeof probe.error === 'string' ? { error: boundedProbeError(probe.error) } : {}) };
  }
  for (const key of ['model', 'effort', 'message'] as const) if (typeof item[key] === 'string') record[key] = item[key] as string;
  return record;
}

export function parseStallState(value: unknown): StallState {
  const data = object(value);
  if (data.version !== 1 || !data.engines || typeof data.engines !== 'object' || Array.isArray(data.engines)) throw new Error('Unsupported stall store');
  const engines: Record<string, EnginePenalty> = {};
  for (const [engine, raw] of Object.entries(object(data.engines))) {
    const item = object(raw);
    const penalty: EnginePenalty = {
      level: integerOr(item.level, 'level', STALL_LADDER.length),
      lastTriggerAt: item.lastTriggerAt === null ? null : timestampOr(item.lastTriggerAt, 'lastTriggerAt'),
      needsAttention: item.needsAttention === true,
      blockedUntil: item.blockedUntil === null ? null : timestampOr(item.blockedUntil, 'blockedUntil'),
      nextProbeAt: item.nextProbeAt === undefined || item.nextProbeAt === null ? null : timestampOr(item.nextProbeAt, 'nextProbeAt'),
      probeSuccesses: item.probeSuccesses === undefined ? 0 : integerOr(item.probeSuccesses, 'probeSuccesses', PROBE_SUCCESSES - 1),
      head: typeof item.head === 'string' ? item.head : '',
    };
    engines[engine] = penalty;
  }
  if (!Array.isArray(data.history) || data.history.length > HISTORY_LIMIT) throw new Error('Invalid stall history');
  return { engines, history: data.history.map(parseRecord) };
}

/** Where the monitor keeps its ladder and history: the weaver.db tables. */
export interface StallStateStore { load(): StallState; save(state: StallState): void }

/** Same rows the migration script fills: penalties per engine, history bounded like the file kept it. */
export function dbStallStore(db: DatabaseSync, log: (message: string) => void = message => console.error(message)): StallStateStore {
  return {
    load(): StallState {
      const engines: Record<string, EnginePenalty> = {};
      for (const row of db.prepare('SELECT * FROM stall_penalties').all() as Record<string, unknown>[]) {
        engines[String(row.engine)] = {
          level: Number(row.level),
          lastTriggerAt: row.last_trigger_at === null || row.last_trigger_at === undefined ? null : Number(row.last_trigger_at),
          needsAttention: Number(row.needs_attention) === 1,
          blockedUntil: row.blocked_until === null || row.blocked_until === undefined ? null : Number(row.blocked_until),
          nextProbeAt: row.next_probe_at === null || row.next_probe_at === undefined ? null : Number(row.next_probe_at),
          probeSuccesses: Number(row.probe_successes),
          head: String(row.head ?? ''),
        };
      }
      const history = (db.prepare('SELECT body FROM stall_history ORDER BY id').all() as Record<string, unknown>[])
        .map(row => JSON.parse(String(row.body)) as StallRecord);
      try { return parseStallState({ version: 1, engines, history }); }
      catch (error) {
        log(`Stall state ignored: ${error instanceof Error ? error.message : 'unreadable'}`);
        return emptyState();
      }
    },
    save(state: StallState): void {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM stall_penalties');
        const insertPenalty = db.prepare('INSERT INTO stall_penalties(engine,level,last_trigger_at,needs_attention,blocked_until,next_probe_at,probe_successes,head) VALUES (?,?,?,?,?,?,?,?)');
        for (const [engine, penalty] of Object.entries(state.engines)) {
          insertPenalty.run(engine, penalty.level, penalty.lastTriggerAt, penalty.needsAttention ? 1 : 0, penalty.blockedUntil, penalty.nextProbeAt, penalty.probeSuccesses, penalty.head);
        }
        db.exec('DELETE FROM stall_history');
        const insertRecord = db.prepare('INSERT INTO stall_history(engine,level,at,body) VALUES (?,?,?,?)');
        for (const record of state.history) insertRecord.run(record.engine, record.level, record.at, JSON.stringify(record));
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ } throw error; }
    },
  };
}

