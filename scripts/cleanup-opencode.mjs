#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export function cutoffTime(now, keepDays) {
  const date = new Date(now + 8 * 3600000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - keepDays + 1) - 8 * 3600000;
}
function activeOpenCode(filename) {
  const targets = ['', '-wal', '-shm'].flatMap(suffix => {
    try { const file = statSync(filename + suffix); return [{ dev: file.dev, ino: file.ino }]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
  if (process.platform !== 'linux') throw new Error('Active-process detection requires Linux /proc');
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      if (statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      const exe = basename(args[0] || '');
      if (/^opencode(?:-.*)?$/.test(exe) || (/^(node|bun)$/.test(exe) && args.slice(1, 3).some(arg => /(?:^|\/)opencode(?:\.(?:js|mjs|cjs))?$/.test(arg)))) {
        try {
          for (const fd of readdirSync(`/proc/${pid}/fd`)) {
            try {
              const file = statSync(`/proc/${pid}/fd/${fd}`);
              if (targets.some(target => target.dev === file.dev && target.ino === file.ino)) return Number(pid);
            } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) return Number(pid); }
          }
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) return Number(pid); }
      }
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
}
function schema(db) {
  for (const [table, columns] of Object.entries({ session: ['id', 'time_updated'], message: ['id', 'session_id'], part: ['id', 'message_id', 'session_id'], event_sequence: ['aggregate_id', 'seq', 'owner_id'], event: ['id', 'aggregate_id', 'seq', 'type', 'data'] })) {
    const info = db.prepare(`PRAGMA table_info("${table}")`).all();
    if (!columns.every(column => info.some(row => row.name === column))) throw new Error(`Unknown schema: ${table}`);
    if (table === 'session' && !info.some(row => row.name === 'time_updated' && row.type.toUpperCase() === 'INTEGER' && row.notnull === 1)) throw new Error('Unknown session timestamp schema');
    if (!info.some(row => row.name === columns[0] && row.pk === 1)) throw new Error(`Unknown primary key: ${table}`);
  }
  for (const [table, column, target, to] of [['message', 'session_id', 'session', 'id'], ['part', 'message_id', 'message', 'id'], ['event', 'aggregate_id', 'event_sequence', 'aggregate_id']]) {
    if (!db.prepare(`PRAGMA foreign_key_list("${table}")`).all().some(row => row.from === column && row.table === target && row.to === to && row.on_delete === 'CASCADE')) throw new Error(`Unknown foreign key: ${table}.${column}`);
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  for (const table of tables) {
    const name = table.replaceAll('"', '""');
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all()) {
      if (['session', 'message', 'part', 'event_sequence', 'event'].includes(fk.table) && (!['message', 'part', 'event', 'session_context_epoch', 'session_input', 'session_message', 'todo', 'session_share'].includes(table) || fk.on_delete !== 'CASCADE')) throw new Error(`Unsupported deletion foreign key: ${table}`);
    }
  }
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().length) throw new Error('Unknown schema: triggers require review');
  return tables;
}
const busy = error => /locked|busy/i.test(error.message);
export function cleanup({ db: filename, keepDays = 1, apply = false, vacuum = false, pruneEvents = false, eventIdleMinutes = 60, now = Date.now() }) {
  if (!Number.isSafeInteger(keepDays) || keepDays <= 0) throw new Error('--keep-days must be a positive integer');
  if (!Number.isSafeInteger(eventIdleMinutes) || eventIdleMinutes < 0) throw new Error('--event-idle-minutes must be a non-negative integer');
  if (vacuum && !apply) throw new Error('--vacuum requires --apply');
  // Validate every derived timestamp before opening the DB or acquiring a lock.
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid current time');
  const cutoff = cutoffTime(now, keepDays);
  const eventIdleCutoff = now - eventIdleMinutes * 60000;
  if (![cutoff, eventIdleCutoff].every(value => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime()))) throw new Error('Retention parameters exceed the supported date range');
  const cutoffISO = new Date(cutoff).toISOString();
  const eventIdleCutoffISO = new Date(eventIdleCutoff).toISOString();
  if (!existsSync(filename)) throw new Error(`Database does not exist: ${filename}`);
  filename = realpathSync(filename);
  if (statSync(filename).uid !== process.getuid()) throw new Error('Database must be owned by the current user');
  const pid = activeOpenCode(filename);
  if (pid) return { status: 'skipped', reason: 'active-opencode', pid };
  const lock = `${filename}.cleanup.lock`;
  const startTime = pid => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  const owner = { pid: process.pid, start: startTime(process.pid) };
  try { mkdirSync(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stale = false;
    try {
      const previous = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
      if (Number.isSafeInteger(previous.pid) && typeof previous.start === 'string') {
        try { stale = startTime(previous.pid) !== previous.start; }
        catch (probe) { if (probe.code === 'ENOENT') stale = true; else throw probe; }
      }
    } catch (probe) { if (!['ENOENT', 'EACCES'].includes(probe.code) && !(probe instanceof SyntaxError)) throw probe; }
    if (!stale) return { status: 'skipped', reason: 'cleanup-running', lock };
    const reaper = `${lock}.reap`;
    try { mkdirSync(reaper); } catch (probe) { if (probe.code === 'EEXIST') return { status: 'skipped', reason: 'cleanup-running', lock }; throw probe; }
    try {
      // Recheck under the collector lock, so another collector cannot retire a new owner.
      const previous = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
      let stillStale = false;
      try { stillStale = startTime(previous.pid) !== previous.start; }
      catch (probe) { if (probe.code === 'ENOENT') stillStale = true; else throw probe; }
      if (!stillStale) return { status: 'skipped', reason: 'cleanup-running', lock };
      rmSync(lock, { recursive: true });
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner));
    } catch (probe) { if (probe.code === 'ENOENT' || probe.code === 'EEXIST') return { status: 'skipped', reason: 'cleanup-running', lock }; throw probe; }
    finally { rmSync(reaper, { recursive: true }); }
  }
  writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner));
  const bytes = () => Object.fromEntries(['', '-wal', '-shm'].map(suffix => {
    try { return [suffix || 'database', statSync(filename + suffix).size]; } catch (error) { if (error.code === 'ENOENT') return [suffix || 'database', 0]; throw error; }
  }));
  const bytesBefore = bytes();
  let db, transaction = false;
  try {
    db = new DatabaseSync(filename, { readOnly: !apply });
    db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON;');
    process.stderr.write(`Starting ${apply ? 'write' : 'preview'} transaction…\n`);
    db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN'); transaction = true;
    const tables = schema(db);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Existing foreign key violations');
    const expired = db.prepare('SELECT id FROM session WHERE time_updated < ? ORDER BY id').all(cutoff).map(row => row.id);
    const retained = db.prepare('SELECT id FROM session WHERE time_updated >= ? ORDER BY id').all(cutoff).map(row => row.id);
    const eventCandidates = pruneEvents ? db.prepare('SELECT id FROM session WHERE time_updated >= ? AND time_updated <= ? ORDER BY id').all(cutoff, eventIdleCutoff).map(row => row.id) : [];
    const candidateEventCount = pruneEvents ? db.prepare('SELECT count(*) AS n FROM event JOIN session ON session.id=event.aggregate_id WHERE session.time_updated >= ? AND session.time_updated <= ?').get(cutoff, eventIdleCutoff).n : 0;
    const counts = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT count(*) AS n FROM "${table.replaceAll('"', '""')}"`).get().n]));
    const before = counts();
    const retainedCounts = () => ({
      message: db.prepare('SELECT count(*) AS n FROM message JOIN session ON session.id=message.session_id WHERE session.time_updated >= ?').get(cutoff).n,
      part: db.prepare('SELECT count(*) AS n FROM part JOIN session ON session.id=part.session_id WHERE session.time_updated >= ?').get(cutoff).n,
      event: db.prepare('SELECT count(*) AS n FROM event JOIN session ON session.id=event.aggregate_id WHERE session.time_updated >= ?').get(cutoff).n,
      orphanEvents: db.prepare('SELECT count(*) AS n FROM event WHERE NOT EXISTS(SELECT 1 FROM session WHERE session.id=event.aggregate_id)').get().n,
    });
    const protectedDigest = () => {
      const hash = createHash('sha256');
      for (const table of tables.filter(name => ['auth', 'project', 'permission', 'account', 'account_state'].includes(name)).sort()) {
        hash.update(table);
        for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).iterate()) hash.update(JSON.stringify(row));
      }
      return hash.digest('hex');
    };
    const projectionDigest = () => {
      const hash = createHash('sha256');
      for (const table of ['session', 'message', 'part', 'session_message', 'session_input', 'session_context_epoch', 'todo', 'session_share'].filter(name => tables.includes(name))) {
        const key = table === 'session' ? 'id' : 'session_id';
        // Only local projections are read; the large event JSON payload is never hashed.
        const query = `SELECT p.* FROM "${table}" p JOIN session s ON s.id=p."${key}" WHERE s.time_updated >= ? ORDER BY p.rowid`;
        hash.update(table);
        for (const row of db.prepare(query).iterate(cutoff)) hash.update(JSON.stringify(row));
      }
      for (const row of db.prepare('SELECT * FROM event_sequence WHERE NOT EXISTS(SELECT 1 FROM session WHERE session.id=aggregate_id AND time_updated < ?) ORDER BY aggregate_id').iterate(cutoff)) hash.update(JSON.stringify(row));
      return hash.digest('hex');
    };
    const projectionBefore = projectionDigest();
    const protectedBefore = protectedDigest();
    const retainedBefore = retainedCounts();
    if (apply) {
      process.stderr.write('Deleting selected sessions and event history…\n');
      // Fixed IDs selected under the write lock; retained sessions and orphan event groups never enter this set.
      const deleteEvents = db.prepare('DELETE FROM event_sequence WHERE aggregate_id = ?');
      const deleteSession = db.prepare('DELETE FROM session WHERE id = ?');
      for (const id of expired) { deleteEvents.run(id); deleteSession.run(id); }
      const prune = db.prepare('DELETE FROM event WHERE aggregate_id = ?');
      for (const id of eventCandidates) prune.run(id);
      for (const id of eventCandidates) {
        if (db.prepare('SELECT count(*) AS n FROM event WHERE aggregate_id = ?').get(id).n !== 0) throw new Error('Pruned event verification failed');
      }
      const remaining = db.prepare('SELECT id FROM session ORDER BY id').all().map(row => row.id);
      if (JSON.stringify(remaining) !== JSON.stringify(retained)) throw new Error('Retained session verification failed');
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key verification failed');
    }
    const after = counts();
    if (apply && protectedBefore !== protectedDigest()) throw new Error('Protected configuration verification failed');
    const retainedAfter = retainedCounts();
    const expectedRetained = { ...retainedBefore, event: retainedBefore.event - candidateEventCount };
    if (apply && JSON.stringify(expectedRetained) !== JSON.stringify(retainedAfter)) throw new Error('Retained projection verification failed');
    if (apply && projectionBefore !== projectionDigest()) throw new Error('Retained projection content verification failed');
    if (apply) {
      const affected = new Set(['session', 'message', 'part', 'event_sequence', 'event', 'session_context_epoch', 'session_input', 'session_message', 'todo', 'session_share']);
      for (const table of tables) {
        if ((!affected.has(table) && before[table] !== after[table]) || after[table] > before[table]) throw new Error(`Table count verification failed: ${table}`);
      }
      if (before.session - after.session !== expired.length) throw new Error('Deleted session count verification failed');
    }
    db.exec('COMMIT'); transaction = false;
    process.stderr.write(`${apply ? 'Cleanup' : 'Preview'} transaction committed.\n`);
    let vacuumStatus = 'not-requested';
    if (vacuum) {
      process.stderr.write('Checking eligibility for VACUUM and WAL checkpoint…\n');
      if (activeOpenCode(filename)) vacuumStatus = 'skipped-active-opencode';
      else { try { db.exec('VACUUM'); const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); vacuumStatus = checkpoint.busy ? 'vacuum-completed-checkpoint-busy' : 'completed'; } catch (error) { vacuumStatus = busy(error) ? 'skipped-busy' : `failed-after-commit: ${error.message}`; } }
    }
    return { status: apply ? 'applied' : 'preview', cutoff: cutoffISO, keepDays, eventPruning: { enabled: pruneEvents, idleMinutes: eventIdleMinutes, idleCutoff: eventIdleCutoffISO, candidateSessions: eventCandidates.length, candidateEvents: candidateEventCount }, expiredIds: expired, retainedCount: retained.length, before, after, deleted: Object.fromEntries(tables.map(table => [table, before[table] - after[table]])), retained: retainedAfter, bytesBefore, bytesAfter: bytes(), vacuum: vacuumStatus };
  } catch (error) {
    if (transaction) { try { db.exec('ROLLBACK'); } catch {} }
    if (busy(error)) return { status: 'skipped', reason: 'database-busy' };
    throw error;
  } finally { db?.close(); rmSync(lock, { recursive: true }); }
}
function main() {
  const options = { db: join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'opencode/opencode.db') };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return { usage: 'node scripts/cleanup-opencode.mjs [--db PATH] [--keep-days POSITIVE_INTEGER] [--apply] [--vacuum] [--prune-events] [--event-idle-minutes NON_NEGATIVE_INTEGER]', default: 'preview; retain Shanghai calendar today' };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--vacuum') options.vacuum = true;
    else if (arg === '--prune-events') options.pruneEvents = true;
    else if (arg === '--db' || arg === '--keep-days' || arg === '--event-idle-minutes') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--db') options.db = resolve(value);
      else if (arg === '--event-idle-minutes') { if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('--event-idle-minutes must be a non-negative integer'); options.eventIdleMinutes = Number(value); }
      else { if (!/^[1-9]\d*$/.test(value)) throw new Error('--keep-days must be a positive integer'); options.keepDays = Number(value); }
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  process.stderr.write('Checking OpenCode database cleanup eligibility…\n');
  return cleanup(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.stdout.write(`${JSON.stringify({ status: 'error', error: error.message })}\n`); process.exitCode = 1; }
}
