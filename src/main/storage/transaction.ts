import type { DatabaseSync } from 'node:sqlite';

/** Anything backed by one SQLite connection can say which one. Two things are atomic together only when they say the same. */
export interface Transactional { readonly connection?: unknown }

export function sameConnection(...parts: (Transactional | undefined)[]): boolean {
  const first = parts[0]?.connection;
  return first !== undefined && parts.every(part => part?.connection === first);
}

interface Frame { undo: (() => void)[] }
const open = new WeakMap<DatabaseSync, Frame[]>();
let savepoints = 0;

/**
 * One SQL transaction on this connection that nests: the outermost call is BEGIN IMMEDIATE ... COMMIT, a call inside
 * another is a SAVEPOINT, so a store that opens its own transaction can run inside a caller's unit of work. A throw
 * rolls back this call's writes and is rethrown.
 *
 * Memory is not rolled back by SQL, so `undo` restores what the work changed outside the database. It runs when this
 * call fails and also when an enclosing call fails after this one finished; it is dropped once the outermost call
 * has committed. Code that advances an in-memory snapshot after its own write registers the same way with onRollback().
 */
export function transact<T>(db: DatabaseSync, work: () => T, undo?: () => void): T {
  let stack = open.get(db);
  if (!stack) { stack = []; open.set(db, stack); }
  const nested = stack.length > 0;
  const name = `weaver_tx_${++savepoints}`;
  db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
  const frame: Frame = { undo: [] };
  stack.push(frame);
  let result: T;
  try {
    result = work();
    db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
  } catch (error) {
    stack.pop();
    try {
      if (nested) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); }
      else db.exec('ROLLBACK');
    } catch { /* SQLite may already have rolled back an I/O failure. */ }
    for (const restore of [...frame.undo, ...(undo ? [undo] : [])].reverse()) {
      try { restore(); } catch { /* Keep the original failure. */ }
    }
    throw error;
  }
  stack.pop();
  if (nested) stack[stack.length - 1]!.undo.push(...frame.undo, ...(undo ? [undo] : []));
  return result;
}

/** Registers memory to restore if the transaction now open on this connection (or the one around it) rolls back; nothing to do outside one. */
export function onRollback(db: DatabaseSync, undo: () => void): void {
  const stack = open.get(db);
  if (stack && stack.length > 0) stack[stack.length - 1]!.undo.push(undo);
}
