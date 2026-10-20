import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unblockEngine } from '../../src/main/application/engines/unblock';
import { migrate } from '../../src/main/migrate';
import { PolicyBlockService } from '../../src/main/policy/blocks';
import { defaultConfig } from '../../src/main/policy/routing';
import { PolicyStore } from '../../src/main/policy/store';
import { StallMonitor, type RecoveryProbe } from '../../src/main/stall';
import { dbStallStore, type StallStateStore } from '../../src/main/storage/stall-state';
import type { Task } from '../../src/shared/contracts/tasks';
import { STALL_BLOCK_BY } from '../../src/shared/policy/blocks';

// The user's 「恢复派发」 is three steps (clear blocks, reset the stall ladder, reset free-channel questions) that
// cannot share one transaction. These tests cut the middle step and check that the blocks that already went stay
// gone, the ladder converges on the next tick, the pump is still told, and the later step still runs. They also cut
// a probe escalation's block write: the ladder must not advance past a block that was not rewritten.

const MINUTE = 60_000;
const START = Date.parse('2030-01-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const dirs: string[] = [];
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function connection(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'wv-unblock-'));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, 'weaver.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  migrate(db);
  return db;
}

function failing(inner: StallStateStore): StallStateStore & { failNext(message?: string): void } {
  let fail: string | undefined;
  return {
    connection: inner.connection,
    load: () => inner.load(),
    save: state => { if (fail) { const message = fail; fail = undefined; throw new Error(message); } inner.save(state); },
    failNext(message = 'injected: state write failed') { fail = message; },
  };
}

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

function fixture(options: { probe?: RecoveryProbe; engines?: string[] } = {}) {
  const db = connection();
  let now = START;
  const policy = new PolicyStore(db, () => now);
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config: defaultConfig(), blocks: [] });
  const store = failing(dbStallStore(db, () => {}));
  const tasks = (options.engines ?? ['claude']).flatMap(engine => [stalledTask(engine, `${engine}-a`), stalledTask(engine, `${engine}-b`)]);
  let pumps = 0;
  const monitor = new StallMonitor({
    tasks: () => tasks, policy: () => policy, stateStore: store, cpu: async () => 0, probe: options.probe,
    now: () => now, ready: () => true, onBlocksChanged: () => { pumps += 1; }, log: () => {},
  });
  const blocks = new PolicyBlockService(() => policy, { onChanged: () => { pumps += 1; } });
  return {
    db, policy, store, monitor, blocks, pumps: () => pumps,
    advance: async (minutes: number) => { for (let index = 0; index < minutes; index += 1) { now += MINUTE; await monitor.tick(); } },
  };
}

const rows = (db: DatabaseSync) => db.prepare('SELECT engine, level, next_probe_at, needs_attention FROM stall_penalties ORDER BY engine').all().map(row => ({ ...row }));
const historyCount = (db: DatabaseSync, engine: string) => Number((db.prepare('SELECT count(*) AS n FROM stall_history WHERE engine = ?').get(engine) as { n: number }).n);
const persistedBlocks = (db: DatabaseSync) => new PolicyStore(db).snapshot().blocks.map(block => [block.engine, block.by]);

test('unblock: a stall reset that cannot be saved keeps the cleared blocks, still resets the free probe and notifies, and one tick converges', async () => {
  const f = fixture({ engines: ['claude', 'codex'] });
  try {
    await f.advance(6);
    assert.deepEqual(persistedBlocks(f.db), [['claude', STALL_BLOCK_BY], ['codex', STALL_BLOCK_BY]]);
    const codexBefore = rows(f.db).find(row => row.engine === 'codex');
    const history = { claude: historyCount(f.db, 'claude'), codex: historyCount(f.db, 'codex') };
    assert.equal(history.claude, 1);
    const pumpsBefore = f.pumps();
    let freeResets = 0;

    f.store.failNext();
    assert.throws(
      () => unblockEngine({ blocks: f.blocks, stall: f.monitor, freeProbe: { resetEngine: () => { freeResets += 1; } } }, 'claude'),
      /Engine claude was only partly unblocked.*already cleared.*stall reset: injected: state write failed/s,
    );
    assert.deepEqual(persistedBlocks(f.db), [['codex', STALL_BLOCK_BY]], 'the committed block removal stays');
    assert.equal(freeResets, 1, 'the free probe reset still ran after the stall reset failed');
    assert.equal(f.pumps(), pumpsBefore + 1, 'queued work is told to re-route although a later step failed');
    assert.equal(rows(f.db).find(row => row.engine === 'claude')!.level, 1, 'the database still holds the old penalty until the next save');

    // The next tick finds the ladder dirty, writes it and lifts nothing else; the same stalled tasks do not punish again.
    await f.advance(1);
    assert.equal(f.monitor.status().engines.claude!.level, 0);
    assert.equal(f.monitor.status().engines.claude!.nextProbeAt, null);
    const claude = rows(f.db).find(row => row.engine === 'claude')!;
    assert.equal(claude.level, 0, 'the database converged on the unblocked ladder');
    assert.equal(claude.next_probe_at, null);
    assert.deepEqual(persistedBlocks(f.db), [['codex', STALL_BLOCK_BY]], 'no new penalty on the tick that follows an unblock');
    assert.equal(historyCount(f.db, 'claude'), history.claude, 'the record is retained');
    assert.equal(historyCount(f.db, 'codex'), history.codex);
    assert.deepEqual(rows(f.db).find(row => row.engine === 'codex'), codexBefore, 'the other engine is untouched');
    assert.equal(f.monitor.status().engines.codex!.level, 1);
    // A restart reads the converged state, not the old penalty.
    const reopened = dbStallStore(f.db, () => {}).load();
    assert.equal(reopened.engines.claude!.level, 0);
  } finally { await f.monitor.stop(); }
});

test('unblock: a failing free probe reset does not hide the stall reset and is reported after the pump is told', async () => {
  const f = fixture();
  try {
    await f.advance(6);
    const pumpsBefore = f.pumps();
    assert.throws(
      () => unblockEngine({ blocks: f.blocks, stall: f.monitor, freeProbe: { resetEngine: () => { throw new Error('injected: free state write failed'); } } }, 'claude'),
      /injected: free state write failed/,
    );
    assert.equal(f.pumps(), pumpsBefore + 1);
    assert.deepEqual(persistedBlocks(f.db), []);
    assert.equal(rows(f.db).find(row => row.engine === 'claude')!.level, 0, 'the stall reset was saved');
  } finally { await f.monitor.stop(); }
});

test('unblock: an unknown engine is still rejected before any step runs', async () => {
  const f = fixture();
  try {
    let calls = 0;
    assert.throws(() => unblockEngine({ blocks: f.blocks, stall: { resetEngine: () => { calls += 1; } } }, 'ghost'), /Unknown engine ghost/);
    assert.equal(calls, 0);
    assert.equal(f.pumps(), 0);
  } finally { await f.monitor.stop(); }
});

test('stall: an escalation whose block cannot be rewritten moves neither the ladder, the record nor the database', async () => {
  const probe: RecoveryProbe = async () => ({ ok: false, ms: 20, error: '进程退出码 1，没有回复。' });
  const f = fixture({ probe });
  try {
    // A penalty block whose reason is not the one the state would restate (an adopted block carries no head), so the
    // escalation has to rewrite it.
    const base = f.policy.snapshot();
    f.policy.save({ revision: base.revision, config: base.config, blocks: [{ engine: 'claude', reason: '旧的原因', since: iso(START), by: STALL_BLOCK_BY }] });
    await f.advance(1);
    assert.equal(f.monitor.status().engines.claude!.level, 1, 'the block was adopted onto the first rung');
    const before = { blocks: f.policy.snapshot(), rows: rows(f.db), history: historyCount(f.db, 'claude') };
    // Every revision-checked save of the policy fails while the probe's answer is being committed.
    f.db.exec("CREATE TRIGGER fail_block_write BEFORE INSERT ON policy_blocks BEGIN SELECT RAISE(ABORT, 'injected: block write failed'); END");
    await assert.rejects(() => f.advance(5), /injected|could not be saved|not saved/);
    assert.equal(f.monitor.status().engines.claude!.level, 1, 'the ladder stayed on its rung');
    assert.deepEqual(rows(f.db), before.rows);
    assert.equal(historyCount(f.db, 'claude'), before.history, 'and the answer left no history line');
    assert.equal(f.policy.snapshot().revision, before.blocks.revision);
    assert.deepEqual(f.policy.snapshot().blocks, before.blocks.blocks);
    // Writable again: the same overdue probe is answered once and the ladder moves one level.
    f.db.exec('DROP TRIGGER fail_block_write');
    await f.advance(1);
    assert.equal(f.monitor.status().engines.claude!.level, 2);
    assert.equal(historyCount(f.db, 'claude'), before.history + 1);
  } finally { await f.monitor.stop(); }
});

test('stall: an escalation whose block text did not change writes no policy revision', async () => {
  const probe: RecoveryProbe = async () => ({ ok: false, ms: 20, error: 'no reply' });
  const f = fixture({ probe });
  try {
    await f.advance(6);
    const revision = f.policy.snapshot().revision;
    // Level 1 -> 2: the block reason is the same head, so only the ladder moves.
    await f.advance(5);
    assert.equal(f.monitor.status().engines.claude!.level, 2);
    assert.equal(f.policy.snapshot().revision, revision, 'the unchanged block was not saved again');
    assert.deepEqual(persistedBlocks(f.db), [['claude', STALL_BLOCK_BY]]);
  } finally { await f.monitor.stop(); }
});
