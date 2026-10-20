import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VendorLimits } from '../src/main/application/scheduling/vendor-limits';
import { FreeChannelProbeMonitor } from '../src/main/free-channel';
import { TaskManager } from '../src/main/manager';
import { migrate } from '../src/main/migrate';
import { PolicyStore } from '../src/main/policy/store';
import { defaultConfig } from '../src/main/policy/routing';
import { StallMonitor, type RecoveryProbe } from '../src/main/stall';
import { dbFreeProbeStore, type FreeProbeStore } from '../src/main/storage/free-probe-state';
import { dbStallStore, type StallStateStore } from '../src/main/storage/stall-state';
import { transact } from '../src/main/storage/transaction';
import { dbVendorLadder } from '../src/main/storage/vendor-limits';
import { TaskStore } from '../src/main/store';
import type { Block } from '../src/shared/contracts/policy';
import type { Task } from '../src/shared/contracts/tasks';
import { STALL_BLOCK_BY } from '../src/shared/policy/blocks';

// A block and the ladder it starts are written in one SQLite transaction. These tests cut every path in the middle
// (after the block write, before the ladder write) and check that nothing half-done is left behind: not in the
// database, not in the policy snapshot, not in the monitor's memory, and that the same evidence handled again
// steps the ladder exactly once.

const MINUTE = 60_000;
const START = Date.parse('2030-01-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'wv-atomic-')); dirs.push(dir); return dir; };
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function connection(): { db: DatabaseSync; path: string } {
  const path = join(scratch(), 'weaver.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  migrate(db);
  return { db, path };
}

/** A state store whose save fails on demand: the write that comes after the block in every unit. */
function failing<S extends StallStateStore | FreeProbeStore>(inner: S): S & { failNext(message?: string): void; saves: number } {
  let fail: string | undefined;
  let saves = 0;
  const wrapped = {
    connection: inner.connection,
    load: () => inner.load(),
    save: (state: never) => { saves += 1; if (fail) { const message = fail; fail = undefined; throw new Error(message); } (inner.save as (value: never) => void)(state); },
    failNext(message = 'injected: state write failed') { fail = message; },
    get saves() { return saves; },
  };
  return wrapped as unknown as S & { failNext(message?: string): void; saves: number };
}

const countRows = (db: DatabaseSync, table: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
/** What a restart would read: the policy tables through a fresh store. */
const persistedPolicy = (db: DatabaseSync) => { const snapshot = new PolicyStore(db).snapshot(); return { revision: snapshot.revision, blocks: snapshot.blocks }; };

function stalledTask(engine: string, scope: string): Task {
  const at = iso(START - 20 * MINUTE);
  return {
    id: `task-${scope}`, title: 'package', instruction: 'work', owner: { name: 'owner', transport: 'herdr-visible', session: 's', pane: 'p' },
    createdAt: at, updatedAt: at, status: 'running', progress: 0,
    events: [{ id: `e-${scope}`, at, kind: 'lifecycle', message: 'started' }], artifacts: [],
    dispatch: { owner: `${engine}_owner`, worker: `${engine}_worker`, engine, model: 'm', effort: 'high', execution: 'real', maxParallel: 2 },
    run: { id: `run-${scope}`, adapter: engine, execution: 'real', status: 'running', startedAt: at, firstOutputAt: at, scopeUnit: scope },
  } as Task;
}

function stallFixture(options: { probe?: RecoveryProbe } = {}) {
  const { db } = connection();
  let now = START;
  const policy = new PolicyStore(db, () => now);
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config: defaultConfig(), blocks: [] });
  const store = failing(dbStallStore(db, () => {}));
  const tasks = [stalledTask('claude', 'w-a'), stalledTask('claude', 'w-b')];
  let pumps = 0;
  const logs: string[] = [];
  const make = (policyStore: PolicyStore, stateStore: StallStateStore) => new StallMonitor({
    tasks: () => tasks, policy: () => policyStore, stateStore, cpu: async () => 0, probe: options.probe,
    now: () => now, ready: () => true, onBlocksChanged: () => { pumps += 1; }, log: message => logs.push(message),
  });
  const monitor = make(policy, store);
  return {
    db, policy, store, monitor, make, tasks, logs,
    pumps: () => pumps,
    advance: async (minutes: number, which: StallMonitor = monitor) => { for (let index = 0; index < minutes; index += 1) { now += MINUTE; await which.tick(); } },
    now: () => now,
  };
}

test('stall: a state write that fails after the penalty block was written leaves neither, and the retry penalizes once', async () => {
  const f = stallFixture();
  try {
    await f.advance(5);
    const revision = f.policy.snapshot().revision;
    assert.equal(f.monitor.status().engines.claude!.level, 0);
    // The sixth idle interval is the one that triggers; its ladder write is cut.
    f.store.failNext();
    await assert.rejects(() => f.advance(1), /injected: state write failed/);
    assert.deepEqual(f.policy.snapshot().blocks, [], 'the block was rolled back with the ladder');
    assert.equal(f.policy.snapshot().revision, revision, 'and the policy snapshot did not advance');
    assert.deepEqual(persistedPolicy(f.db), { revision, blocks: [] }, 'nor did the database');
    assert.equal(countRows(f.db, 'stall_penalties'), 0);
    assert.equal(countRows(f.db, 'stall_history'), 0);
    assert.equal(f.monitor.status().engines.claude!.level, 0, 'the monitor remembers no ladder step');
    assert.equal(f.pumps(), 0, 'and announced nothing');
    // The same failure is handled again on the next tick: one level, one block, one announcement.
    await f.advance(1);
    const after = f.monitor.status().engines.claude!;
    assert.equal(after.level, 1);
    assert.equal(f.policy.snapshot().blocks.length, 1);
    assert.equal(f.policy.snapshot().blocks[0]!.by, STALL_BLOCK_BY);
    assert.equal(f.policy.snapshot().revision, revision + 1);
    assert.equal(f.pumps(), 1);
    assert.equal(countRows(f.db, 'stall_penalties'), 1);
    // After a restart the same stalled tasks do not escalate a second time: the open penalty already answers them.
    const restarted = f.make(new PolicyStore(f.db, f.now), failing(dbStallStore(f.db, () => {})));
    await f.advance(3, restarted);
    assert.equal(restarted.status().engines.claude!.level, 1);
    assert.equal(persistedPolicy(f.db).revision, revision + 1);
    assert.equal(f.db.prepare('SELECT level FROM stall_penalties').all().length, 1);
    await restarted.stop();
  } finally { await f.monitor.stop(); }
});

test('stall: a failed probe whose escalation cannot be saved keeps the block, the level and the record as they were', async () => {
  const probe: RecoveryProbe = async () => ({ ok: false, ms: 20, error: '进程退出码 1，没有回复。' });
  const f = stallFixture({ probe });
  try {
    await f.advance(6);
    const level1 = f.monitor.status().engines.claude!;
    assert.equal(level1.level, 1);
    const before = { policy: persistedPolicy(f.db), rows: JSON.stringify(f.db.prepare('SELECT * FROM stall_penalties').all().map(row => ({ ...row }))), history: countRows(f.db, 'stall_history') };
    // The probe is due at the first rung's deadline; the ladder write that follows its answer is cut.
    f.store.failNext();
    await assert.rejects(() => f.advance(5), /injected/);
    assert.deepEqual(persistedPolicy(f.db), before.policy, 'the rewritten block did not survive');
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM stall_penalties').all().map(row => ({ ...row }))), before.rows);
    assert.equal(countRows(f.db, 'stall_history'), before.history, 'and the answer left no history line');
    assert.equal(f.monitor.status().engines.claude!.level, 1);
    assert.equal(f.monitor.status().engines.claude!.history.length, level1.history.length);
    // Asked again, the engine fails again and the ladder moves one level.
    await f.advance(1);
    assert.equal(f.monitor.status().engines.claude!.level, 2);
    assert.equal(f.monitor.status().engines.claude!.history.filter(item => item.probe !== undefined).length, 1);
  } finally { await f.monitor.stop(); }
});

test('stall: a recovery whose ladder write fails leaves the penalty block in force', async () => {
  const f = stallFixture({ probe: async () => ({ ok: true, ms: 10 }) });
  try {
    await f.advance(6);
    assert.equal(f.policy.snapshot().blocks.length, 1);
    f.store.failNext();
    await assert.rejects(() => f.advance(5), /injected/);
    assert.equal(persistedPolicy(f.db).blocks.length, 1, 'the block removal was rolled back');
    assert.equal(f.policy.snapshot().blocks.length, 1);
    assert.equal(f.monitor.status().engines.claude!.blocked, true);
    await f.advance(1);
    assert.equal(f.policy.snapshot().blocks.length, 0, 'the next probe lifts it');
    assert.equal(f.monitor.status().engines.claude!.level, 1, 'the ladder memory is kept');
  } finally { await f.monitor.stop(); }
});

test('stall: a revision conflict inside the unit is re-read and the penalty still commits once, with its ladder', async () => {
  const f = stallFixture();
  try {
    let conflicts = 0;
    const racing = {
      get connection() { return f.policy.connection; },
      snapshot: () => f.policy.snapshot(),
      transaction: <T,>(work: () => T) => f.policy.transaction(work),
      save: (input: unknown) => {
        if (conflicts === 0) {
          conflicts += 1;
          const current = f.policy.snapshot();
          f.policy.save({ revision: current.revision, config: current.config, blocks: [...current.blocks, { engine: 'codex', reason: '并发修改', since: iso(f.now()), by: 'user' }] });
          throw new Error('Settings changed; reload before saving');
        }
        return f.policy.save(input);
      },
    };
    const monitor = f.make(racing as unknown as PolicyStore, dbStallStore(f.db, () => {}));
    await f.advance(6, monitor);
    assert.equal(conflicts, 1);
    assert.deepEqual(f.policy.snapshot().blocks.map(block => [block.engine, block.by]), [['codex', 'user'], ['claude', STALL_BLOCK_BY]], 'the concurrent block survived next to the penalty');
    assert.equal(monitor.status().engines.claude!.level, 1);
    assert.equal(countRows(f.db, 'stall_penalties'), 1);
    assert.equal(persistedPolicy(f.db).revision, f.policy.snapshot().revision);
    await monitor.stop();
  } finally { await f.monitor.stop(); }
});

function freeFixture(script: Record<string, ({ ok: boolean; ms: number; error?: string })[]>) {
  const { db } = connection();
  let now = START;
  const config = defaultConfig();
  config.engines.qoder!.enabled = true;
  config.workers.qoder_worker!.enabled = true;
  config.workers.qoder_paid_worker = { engine: 'qoder', model: 'paid-model', effort: 'auto', enabled: true };
  const policy = new PolicyStore(db, () => now);
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config, blocks: [] }, { allowEngineEnable: true });
  const store = failing(dbFreeProbeStore(db, () => {}));
  const ladder = dbVendorLadder(db);
  let pumps = 0;
  const queues = structuredClone(script);
  const monitor = new FreeChannelProbeMonitor({
    policy: () => policy, stateStore: store, vendorLadder: ladder,
    probe: async route => queues[route.worker]?.shift() ?? { ok: true, ms: 5 },
    now: () => now, ready: () => true, onBlocksChanged: () => { pumps += 1; }, log: () => {},
  });
  monitor.start();
  return {
    db, policy, store, ladder, monitor, pumps: () => pumps, now: () => now,
    advance: async (minutes: number) => { for (let index = 0; index < minutes; index += 1) { now += MINUTE; await monitor.tick(); } },
    free: () => monitor.status().workers.find(item => item.worker === 'qoder_worker')!,
  };
}

const RATE = { ok: false, ms: 5, error: '429 too many requests, retry after 5 minutes' };
const QUOTA = { ok: false, ms: 5, error: 'FreeUsageLimitError: free quota used up' };
const AUTH = { ok: false, ms: 5, error: '401 authentication failed' };

test('free channel: a rate-limit answer whose state write fails leaves no block, no ladder step and no row; the retry steps once', async () => {
  const f = freeFixture({ qoder_worker: [RATE, RATE] });
  try {
    await f.advance(9);
    const revision = f.policy.snapshot().revision;
    f.store.failNext();
    await assert.rejects(() => f.advance(1), /injected/);
    assert.deepEqual(persistedPolicy(f.db), { revision, blocks: [] }, 'the block write was rolled back');
    assert.equal(f.policy.snapshot().revision, revision);
    assert.deepEqual(f.ladder.list(), {}, 'the ladder did not move');
    assert.equal(countRows(f.db, 'free_probe_workers'), 0);
    assert.equal(countRows(f.db, 'free_probe_history'), 0);
    assert.equal(f.free().mode, null, 'the monitor remembers no question');
    assert.equal(f.pumps(), 0);
    // The failed answer was never recorded, so the worker is asked again at the next round: one step, level 1.
    await f.advance(10);
    assert.equal(f.free().mode, 'rate_limit');
    assert.equal(f.free().level, 1);
    assert.deepEqual(f.ladder.get('qoder_worker'), { level: 1, lastTriggerAt: f.now() });
    assert.equal(f.policy.snapshot().blocks.filter(block => block.worker === 'qoder_worker').length, 1);
    assert.equal(persistedPolicy(f.db).revision, revision + 1);
    // A restart reads the same question and the same ladder; the next answer is the second step, not a repeat of the first.
    const reopened = new FreeChannelProbeMonitor({ policy: () => new PolicyStore(f.db, f.now), stateStore: dbFreeProbeStore(f.db, () => {}), vendorLadder: f.ladder, now: f.now, ready: () => true, log: () => {} });
    assert.equal(reopened.status().workers.find(item => item.worker === 'qoder_worker')!.level, 1);
  } finally { await f.monitor.stop(); }
});

test('free channel: quota and stall answers are cut the same way', async () => {
  for (const [answer, mode] of [[QUOTA, 'quota'], [AUTH, 'stall']] as const) {
    // The first copy is consumed by the cut attempt; the second is what the retry sees.
    const f = freeFixture({ qoder_worker: [answer, answer] });
    try {
      await f.advance(9);
      const revision = f.policy.snapshot().revision;
      f.store.failNext();
      await assert.rejects(() => f.advance(1), /injected/);
      assert.deepEqual(persistedPolicy(f.db), { revision, blocks: [] }, mode);
      assert.equal(countRows(f.db, 'free_probe_workers'), 0);
      assert.equal(f.free().mode, null);
      assert.equal(f.pumps(), 0);
      await f.advance(10);
      assert.equal(f.free().mode, mode);
      assert.equal(f.free().level, 1);
      assert.equal(f.policy.snapshot().blocks.filter(block => block.worker === 'qoder_worker').length, 1);
      assert.equal(persistedPolicy(f.db).revision, revision + 1);
    } finally { await f.monitor.stop(); }
  }
});

test('free channel: a passing probe whose state write fails keeps its block', async () => {
  const f = freeFixture({ qoder_worker: [QUOTA, { ok: true, ms: 5 }] });
  try {
    await f.advance(10);
    assert.equal(f.free().mode, 'quota');
    f.store.failNext();
    await assert.rejects(() => f.advance(10), /injected/);
    assert.equal(persistedPolicy(f.db).blocks.filter(block => block.worker === 'qoder_worker').length, 1, 'the lift was rolled back');
    assert.equal(f.free().mode, 'quota');
    await f.advance(10);
    assert.equal(f.free().mode, null);
    assert.equal(persistedPolicy(f.db).blocks.filter(block => block.worker === 'qoder_worker').length, 0);
  } finally { await f.monitor.stop(); }
});

function vendorFixture() {
  const path = join(scratch(), 'weaver.db');
  const store = new TaskStore(path);
  const children: EventEmitter[] = [];
  const manager = new TaskManager(store, { id: 'fixture', canLaunchReal: () => true, start() { const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); children.push(child); return child; } });
  const policy = new PolicyStore(store.db);
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config: base.config, blocks: [] });
  const limited = (worker: string) => {
    const task = manager.create({ title: 'limited', instruction: 'fake only', workspace: scratch(), owner: { name: 'o', transport: 'herdr-visible', session: 's', pane: 'p' } });
    task.status = 'failed';
    task.dispatch = { engine: 'codex', execution: 'real', owner: 'claude_owner', worker, model: 'fake', effort: 'high', maxParallel: 2 };
    task.failure = { kind: 'rate_limit', message: '429 too many requests' } as Task['failure'];
    store.put(task);
  };
  return { store, manager, policy, limited, close: async () => { for (const child of children) child.emit('close', 0, null); await manager.shutdown(); } };
}

test('dispatch failures: a block that cannot be written leaves the ladder where it was, so the retry steps it once', async () => {
  const f = vendorFixture();
  try {
    // Failures that exist when the service is built count as history; the one made afterwards is new.
    const vendor = new VendorLimits(f.manager, f.policy);
    f.limited('codex_worker');
    const revision = f.policy.snapshot().revision;
    // Cut the policy write: the ladder step comes first in the unit, then the block.
    f.store.db.exec("CREATE TRIGGER fail_block_write BEFORE INSERT ON policy_blocks BEGIN SELECT RAISE(ABORT, 'injected: block write failed'); END");
    assert.throws(() => vendor.applyVendorBlocks(), /injected: block write failed/);
    assert.deepEqual(f.store.listVendorLimits(), {}, 'the ladder step was rolled back with the block');
    assert.equal(f.policy.snapshot().revision, revision, 'the policy snapshot did not advance');
    assert.deepEqual(f.policy.snapshot().blocks, []);
    assert.equal(persistedPolicy(f.store.db).revision, revision);
    // The failed attempt stayed unmarked, so the next pass handles it: level 1, one block.
    f.store.db.exec('DROP TRIGGER fail_block_write');
    vendor.applyVendorBlocks();
    assert.equal(f.store.getVendorLimit('codex_worker')!.level, 1);
    assert.equal(f.policy.snapshot().blocks.filter(block => block.worker === 'codex_worker').length, 1);
    assert.equal(f.policy.snapshot().revision, revision + 1);
    // Handled once: another pass does not step it again.
    vendor.applyVendorBlocks();
    assert.equal(f.store.getVendorLimit('codex_worker')!.level, 1);
    assert.equal(f.policy.snapshot().revision, revision + 1);
  } finally { await f.close(); }
});

test('transact nests with savepoints, rolls back only the failed part and restores memory its owners registered', () => {
  const { db } = connection();
  db.exec('CREATE TABLE t(v INTEGER)');
  const rows = () => (db.prepare('SELECT v FROM t ORDER BY v').all() as { v: number }[]).map(row => row.v);
  let memory = 'start';
  transact(db, () => {
    db.exec('INSERT INTO t VALUES (1)');
    assert.throws(() => transact(db, () => { db.exec('INSERT INTO t VALUES (2)'); throw new Error('inner'); }, () => { memory = 'inner restored'; }), /inner/);
    assert.equal(memory, 'inner restored');
    transact(db, () => db.exec('INSERT INTO t VALUES (3)'), () => { memory = 'three restored'; });
  });
  assert.deepEqual(rows(), [1, 3], 'the failed inner part is gone and the rest committed');
  memory = 'start';
  assert.throws(() => transact(db, () => {
    transact(db, () => db.exec('INSERT INTO t VALUES (4)'), () => { memory = 'inner finished, outer failed'; });
    throw new Error('outer');
  }), /outer/);
  assert.deepEqual(rows(), [1, 3], 'a finished inner part goes with the outer one');
  assert.equal(memory, 'inner finished, outer failed', 'and so does the memory it registered');
});

test('policy saves inside a failed unit leave the snapshot and the database as they were', () => {
  const { db } = connection();
  const policy = new PolicyStore(db);
  const revision = policy.snapshot().revision;
  const block: Block = { engine: 'codex', reason: 'r', since: iso(START), by: 'user' };
  assert.throws(() => policy.transaction(() => {
    const base = policy.snapshot();
    policy.save({ revision: base.revision, config: base.config, blocks: [block] });
    assert.equal(policy.snapshot().blocks.length, 1);
    throw new Error('unit failed');
  }), /unit failed/);
  assert.equal(policy.snapshot().revision, revision);
  assert.deepEqual(policy.snapshot().blocks, []);
  assert.deepEqual(persistedPolicy(db), { revision, blocks: [] });
  // The same store saves normally afterwards.
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config: base.config, blocks: [block] });
  assert.equal(persistedPolicy(db).blocks.length, 1);
});

test('the task store keeps its stream records and sequence when a unit it ran inside of rolls back', () => {
  const store = new TaskStore(join(scratch(), 'weaver.db'));
  try {
    const task = store.get(((): string => { const created = { id: 't-1', title: 'x', instruction: 'y', owner: { name: 'o', transport: 'herdr-visible', session: 's', pane: 'p' }, createdAt: iso(START), updatedAt: iso(START), status: 'running', progress: 0, events: [], artifacts: [] } as unknown as Task; store.put(created); return created.id; })());
    const sequence = store.revision;
    store.put({ ...task, progress: 50 }, 'stream');
    const afterStream = store.revision;
    assert.ok(afterStream > sequence);
    assert.throws(() => transact(store.db, () => {
      store.transaction(() => store.putValue('probe', 1));
      throw new Error('outer unit failed');
    }), /outer unit failed/);
    assert.equal(store.revision, afterStream, 'the sequence is back');
    assert.equal(store.getValue('probe'), undefined, 'the nested write rolled back');
    assert.equal(store.get('t-1').progress, 50, 'and the stream record is still the newest');
    store.flush();
    assert.equal(store.get('t-1').progress, 50);
  } finally { store.close(); }
});
