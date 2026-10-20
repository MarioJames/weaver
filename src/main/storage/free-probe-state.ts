import type { DatabaseSync } from 'node:sqlite';
import { object } from '../../shared/validation';
import type { TaskFailure } from '../../shared/contracts/tasks';
import type { FreeProbeHistoryRecord, FreeProbeMode } from '../../shared/contracts/monitoring';
import { STALL_LADDER } from '../domain/penalties';
import { boundedProbeError, boundedReason } from '../redact-context';
import { transact, type Transactional } from './transaction';

export const HISTORY_LIMIT = 50;

/** What one worker carries: one open question to the vendor, or nothing. */
export interface WorkerProbe {
  level: number;
  lastTriggerAt: number | null;
  /** stall: ladder without deadline; rate_limit: vendor ladder; quota: free-quota ban. null is healthy. */
  mode: FreeProbeMode;
  needsAttention: boolean;
  /** Nominal deadline of the current stage; a level 3 stall stage has none. Not a policy release time. */
  blockedUntil: number | null;
  /** Next probe the monitor owes this worker; null means the scheduled rounds own it. */
  nextProbeAt: number | null;
  /** Consecutive passing probes at the top of the stall ladder; any failure resets it. */
  probeSuccesses: number;
  /** The evidence the stage was triggered with, so an escalation can restate the block honestly. */
  head: string;
  /** since of the block this monitor wrote for the open question; hold and block are one unit. */
  blockSince?: string;
}

export interface FreeProbeState { version: 1; workers: Record<string, WorkerProbe>; history: ProbeRecord[] }

/** One history line: a probe with its answer and what the answer wrote into the policy. */
export type ProbeRecord = Omit<FreeProbeHistoryRecord, 'at'> & { at: number };

function timestampOrDefault(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(new Date(value).getTime())) throw new Error(`Invalid free probe ${name}`);
  return value;
}

function parseRecord(raw: unknown): ProbeRecord {
  const item = object(raw);
  if (typeof item.worker !== 'string' || !item.worker || item.worker.length > 120) throw new Error('Invalid free probe history worker');
  if (typeof item.engine !== 'string' || !item.engine) throw new Error('Invalid free probe history engine');
  const level = typeof item.level === 'number' && Number.isSafeInteger(item.level) && item.level >= 0 ? item.level : NaN;
  if (Number.isNaN(level)) throw new Error('Invalid free probe history level');
  const probe = object(item.probe);
  const ms = typeof probe.ms === 'number' && Number.isFinite(probe.ms) ? probe.ms : NaN;
  if (Number.isNaN(ms) || ms < 0) throw new Error('Invalid free probe history ms');
  const record: ProbeRecord = {
    worker: item.worker, engine: item.engine, level, at: timestampOrDefault(item.at, 'history at'),
    probe: { ok: probe.ok === true, ms, ...(typeof probe.error === 'string' ? { error: boundedProbeError(probe.error) } : {}) },
  };
  if (typeof item.classification === 'string' && ['quota', 'rate_limit', 'auth', 'early_exit', 'no_output', 'vendor', 'cancelled', 'other'].includes(item.classification)) record.classification = item.classification as TaskFailure['kind'];
  if (item.block !== undefined) {
    const block = object(item.block);
    record.block = {
      by: typeof block.by === 'string' ? block.by : '',
      reason: typeof block.reason === 'string' ? boundedReason(block.reason) : '',
      since: typeof block.since === 'string' ? block.since : '',
      ...(typeof block.release_at === 'string' ? { release_at: block.release_at } : {}),
    };
  }
  if (typeof item.message === 'string') record.message = item.message;
  return record;
}

export function parseFreeProbeState(value: unknown): FreeProbeState {
  const data = object(value);
  if (data.version !== 1 || !data.workers || typeof data.workers !== 'object' || Array.isArray(data.workers)) throw new Error('Unsupported free probe store');
  const rawWorkers = data.workers as Record<string, unknown>;
  const workers: Record<string, WorkerProbe> = {};
  for (const [worker, raw] of Object.entries(rawWorkers)) {
    const item = object(raw);
    const mode = item.mode === 'stall' || item.mode === 'rate_limit' || item.mode === 'quota' ? item.mode : null;
    const level = typeof item.level === 'number' && Number.isSafeInteger(item.level) && item.level >= 0 ? item.level : Math.max(1, STALL_LADDER.length);
    const blockedUntil = item.blockedUntil === null || item.blockedUntil === undefined ? null : timestampOrDefault(item.blockedUntil, 'blockedUntil');
    const nextProbeAt = item.nextProbeAt === null || item.nextProbeAt === undefined ? null : timestampOrDefault(item.nextProbeAt, 'nextProbeAt');
    workers[worker] = {
      level,
      mode,
      needsAttention: item.needsAttention === true,
      blockedUntil,
      nextProbeAt,
      probeSuccesses: typeof item.probeSuccesses === 'number' && Number.isSafeInteger(item.probeSuccesses) ? item.probeSuccesses : 0,
      lastTriggerAt: item.lastTriggerAt === null || item.lastTriggerAt === undefined ? null : timestampOrDefault(item.lastTriggerAt, 'lastTriggerAt'),
      head: typeof item.head === 'string' ? item.head : '',
      ...(typeof item.blockSince === 'string' ? { blockSince: item.blockSince } : {}),
    };
  }
  if (!Array.isArray(data.history) || data.history.length > HISTORY_LIMIT) throw new Error('Invalid free probe history');
  return { version: 1, workers, history: data.history.map(parseRecord) };
}

/** Where the probe monitor keeps its per-worker questions and history: the weaver.db tables. */
export interface FreeProbeStore extends Transactional { load(): FreeProbeState; save(state: FreeProbeState): void }

/** Same rows the migration script fills: one question per worker, history bounded like the file kept it. */
export function dbFreeProbeStore(db: DatabaseSync, log: (message: string) => void = message => console.error(message)): FreeProbeStore {
  return {
    connection: db,
    load(): FreeProbeState {
      const workers: Record<string, WorkerProbe> = {};
      for (const row of db.prepare('SELECT * FROM free_probe_workers').all() as Record<string, unknown>[]) {
        const mode = row.mode === 'stall' || row.mode === 'rate_limit' || row.mode === 'quota' ? row.mode as WorkerProbe['mode'] : null;
        workers[String(row.worker)] = {
          level: Number(row.level),
          lastTriggerAt: row.last_trigger_at === null || row.last_trigger_at === undefined ? null : Number(row.last_trigger_at),
          mode,
          needsAttention: Number(row.needs_attention) === 1,
          blockedUntil: row.blocked_until === null || row.blocked_until === undefined ? null : Number(row.blocked_until),
          nextProbeAt: row.next_probe_at === null || row.next_probe_at === undefined ? null : Number(row.next_probe_at),
          probeSuccesses: Number(row.probe_successes),
          head: String(row.head ?? ''),
          ...(row.block_since !== null && row.block_since !== undefined ? { blockSince: String(row.block_since) } : {}),
        };
      }
      const history = (db.prepare('SELECT body FROM free_probe_history ORDER BY id').all() as Record<string, unknown>[])
        .map(row => JSON.parse(String(row.body)) as ProbeRecord);
      try { return parseFreeProbeState({ version: 1, workers, history }); }
      catch (error) {
        log(`Free probe state ignored: ${error instanceof Error ? error.message : 'unreadable'}`);
        return { version: 1, workers: {}, history: [] };
      }
    },
    save(state: FreeProbeState): void {
      transact(db, () => {
        db.exec('DELETE FROM free_probe_workers');
        const insertWorker = db.prepare('INSERT INTO free_probe_workers(worker,level,mode,last_trigger_at,needs_attention,blocked_until,next_probe_at,probe_successes,head,block_since) VALUES (?,?,?,?,?,?,?,?,?,?)');
        for (const [worker, item] of Object.entries(state.workers)) {
          insertWorker.run(worker, item.level, item.mode, item.lastTriggerAt, item.needsAttention ? 1 : 0, item.blockedUntil, item.nextProbeAt, item.probeSuccesses, item.head, item.blockSince ?? null);
        }
        db.exec('DELETE FROM free_probe_history');
        const insertRecord = db.prepare('INSERT INTO free_probe_history(worker,engine,level,at,body) VALUES (?,?,?,?,?)');
        for (const record of state.history) insertRecord.run(record.worker, record.engine, record.level, record.at, JSON.stringify(record));
      });
    },
  };
}

