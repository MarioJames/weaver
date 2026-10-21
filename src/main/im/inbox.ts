import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicReplaceFile } from './atomic-file';
import { object } from '../../shared/validation';

/**
 * The IM inbox dedup store: a durable, at-most-once claim registry backed by one 0600 JSON file per data
 * directory. A claim returns true only after the id has been persisted atomically, so side effects run at
 * most once per message id across restarts. The registry is single-writer by contract: one process owns the
 * file, and no cross-process lock is claimed or provided. Records carry only the id and timestamps — never
 * a message body or a credential. Every failure mode is fail closed: a corrupt or unreadable file is never
 * treated as an empty set, a failed save never claims in memory, and a full store rejects new claims
 * instead of evicting records that are still inside their replay window.
 */

export const DEFAULT_INBOX_TTL_MS = 24 * 60 * 60 * 1000;
export const INBOX_CAPACITY = 10000;

/** Fixed safe error codes. Messages are static: no paths, no input values, no underlying Error.message. */
export type ImInboxErrorCode = 'IM_INBOX_CORRUPT' | 'IM_INBOX_FULL' | 'IM_INBOX_INVALID' | 'IM_INBOX_IO';

export class ImInboxError extends Error {
  constructor(readonly code: ImInboxErrorCode, message: string) { super(message); this.name = 'ImInboxError'; }
}

export interface ImInboxOptions {
  /** How long a claimed id stays registered, blocking a replay. Default 24 hours. */
  ttlMs?: number;
  /** Hard bound on stored records. Default 10000. */
  capacity?: number;
}

/** Bounded ids: real Feishu message ids and synthetic card/menu event ids in a `kind:...` namespace. */
const INBOX_ID_MAX = 256;
const INBOX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const FILE_KEYS: readonly string[] = ['version', 'entries'];
const ENTRY_KEYS: readonly string[] = ['id', 'at', 'expiresAt'];
const VERSION = 1;

interface InboxEntry { id: string; at: number; expiresAt: number }

interface InboxFile { version: 1; entries: InboxEntry[] }

function parseEntry(value: unknown): InboxEntry {
  let item: Record<string, unknown>;
  try { item = object(value); }
  catch { throw new ImInboxError('IM_INBOX_CORRUPT', 'IM inbox storage is corrupt'); }
  for (const key of Object.keys(item)) if (!ENTRY_KEYS.includes(key)) throw new ImInboxError('IM_INBOX_CORRUPT', 'IM inbox storage is corrupt');
  if (typeof item.id !== 'string' || !INBOX_ID_RE.test(item.id)) throw new ImInboxError('IM_INBOX_CORRUPT', 'IM inbox storage is corrupt');
  if (typeof item.at !== 'number' || !Number.isFinite(item.at) || item.at < 0) throw new ImInboxError('IM_INBOX_CORRUPT', 'IM inbox storage is corrupt');
  if (typeof item.expiresAt !== 'number' || !Number.isFinite(item.expiresAt) || item.expiresAt < item.at) throw new ImInboxError('IM_INBOX_CORRUPT', 'IM inbox storage is corrupt');
  return { id: item.id, at: item.at, expiresAt: item.expiresAt };
}

export class ImInbox {
  readonly path: string;
  private readonly ttlMs: number;
  private readonly capacity: number;
  private loaded: InboxEntry[] | null = null;

  constructor(dataDir: string, options: ImInboxOptions = {}) {
    const { ttlMs = DEFAULT_INBOX_TTL_MS, capacity = INBOX_CAPACITY } = options;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new ImInboxError('IM_INBOX_INVALID', 'IM inbox ttl is malformed');
    if (!Number.isInteger(capacity) || capacity <= 0) throw new ImInboxError('IM_INBOX_INVALID', 'IM inbox capacity is malformed');
    this.ttlMs = ttlMs;
    this.capacity = capacity;
    this.path = join(dataDir, 'im-inbox.json');
    try { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); }
    catch { throw new ImInboxError('IM_INBOX_IO', 'IM inbox storage is unavailable'); }
  }

  /**
   * Registers the id durably and returns true exactly once for it; a known id returns false without
   * refreshing its expiry. Expired records are pruned first. When the store is full of records still
   * inside their replay window the claim is rejected with a fixed error — nothing is evicted. A failed
   * save throws and leaves memory unchanged, so no side effects may follow a thrown claim.
   */
  claim(id: string, nowMs: number = Date.now()): boolean {
    if (typeof id !== 'string' || !INBOX_ID_RE.test(id)) throw new ImInboxError('IM_INBOX_INVALID', 'IM inbox id is malformed');
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0) throw new ImInboxError('IM_INBOX_INVALID', 'IM inbox time is malformed');
    const current = this.load();
    // Prune only expired records; survivors keep their original timestamps, so a duplicate never refreshes them.
    const kept = current.filter(entry => entry.expiresAt > nowMs);
    if (kept.some(entry => entry.id === id)) return false;
    if (kept.length >= this.capacity) throw new ImInboxError('IM_INBOX_FULL', 'IM inbox is full');
    const entries = [...kept, { id, at: nowMs, expiresAt: nowMs + this.ttlMs }];
    this.write({ version: VERSION, entries });
    this.loaded = entries;
    return true;
  }

  /** Loads once per process; a missing file means an empty registry, anything unreadable or malformed fails closed. */
  private load(): InboxEntry[] {
    if (this.loaded) return this.loaded;
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loaded = []; return this.loaded; }
      throw new ImInboxError('IM_INBOX_IO', 'IM inbox could not be read');
    }
    try { chmodSync(this.path, 0o600); } catch { /* hardening only; the save path enforces the mode. */ }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new ImInboxError('IM_INBOX_CORRUPT', 'IM inbox storage is corrupt'); }
    let file: Record<string, unknown>;
    try { file = object(parsed); }
    catch { throw new ImInboxError('IM_INBOX_CORRUPT', 'IM inbox storage is corrupt'); }
    for (const key of Object.keys(file)) if (!FILE_KEYS.includes(key)) throw new ImInboxError('IM_INBOX_CORRUPT', 'IM inbox storage is corrupt');
    if (file.version !== VERSION || !Array.isArray(file.entries)) throw new ImInboxError('IM_INBOX_CORRUPT', 'IM inbox storage is corrupt');
    const entries = file.entries.map(parseEntry);
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new ImInboxError('IM_INBOX_CORRUPT', 'IM inbox storage is corrupt');
    this.loaded = entries;
    return entries;
  }

  /** Atomic replace via the shared helper: a unique 0600 temp file per call, renamed over the target. */
  private write(file: InboxFile): void {
    atomicReplaceFile(this.path, `${JSON.stringify(file)}\n`, () => new ImInboxError('IM_INBOX_IO', 'IM inbox could not be saved'));
  }
}
