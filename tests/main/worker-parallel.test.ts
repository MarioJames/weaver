import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, migrate } from '../../src/main/migrate';
import { PolicyStore } from '../../src/main/policy/store';
import { previewRoute } from '../../src/main/policy/preview';
import { defaultConfig, resolveDispatch, validateConfig } from '../../src/main/policy/routing';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { CommandHandler } from '../../src/main/commands';
import type { WorkerAdapter } from '../../src/main/adapters/worker';
import type { Config } from '../../src/shared/contracts/policy';

// A worker's max_parallel is the one knob that keeps a vendor from being hit by several tasks at once.

const version = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number | string }).user_version);
const columns = (db: DatabaseSync) => (db.prepare('PRAGMA table_info(policy_workers)').all() as { name: string }[]).map(column => column.name);

/** Two enabled workers under one owner, so a full one has somewhere to hand work to. */
function pair(caps: { claude_worker?: number; codex_worker?: number } = {}): Config {
  const config = defaultConfig();
  config.owners.claude_owner!.workers = ['claude_worker', 'codex_worker'];
  Object.assign(config.workers.claude_worker!, caps.claude_worker === undefined ? {} : { max_parallel: caps.claude_worker });
  Object.assign(config.workers.codex_worker!, caps.codex_worker === undefined ? {} : { max_parallel: caps.codex_worker });
  return config;
}

test('max_parallel is an optional integer between 1 and 100', () => {
  const config = defaultConfig();
  assert.deepEqual(validateConfig(config), [], 'absent means no cap');
  for (const value of [1, 7, 100]) {
    config.workers.claude_worker!.max_parallel = value;
    assert.deepEqual(validateConfig(config), [], String(value));
  }
  for (const value of [0, -1, 1.5, 101, '3', null, Number.NaN] as unknown[]) {
    (config.workers.claude_worker as { max_parallel?: unknown }).max_parallel = value;
    const issues = validateConfig(config);
    assert.ok(issues.some(issue => issue.path === '$.workers.claude_worker.max_parallel'), `${String(value)} is rejected on its own path`);
  }
});

test('an empty database gets the column, an older database keeps its rows and upgrades once', () => {
  const empty = new DatabaseSync(':memory:');
  migrate(empty);
  assert.ok(SCHEMA_VERSION >= 10);
  assert.ok(columns(empty).includes('max_parallel'));
  assert.equal(version(empty), SCHEMA_VERSION);
  empty.close();

  // The shape version 9 had: a fully migrated database without the column, stopped at 9.
  const old = new DatabaseSync(':memory:');
  migrate(old);
  old.exec('ALTER TABLE policy_workers DROP COLUMN max_parallel; PRAGMA user_version=9');
  assert.ok(!columns(old).includes('max_parallel'));
  old.prepare('INSERT INTO policy_workers(id,position,enabled,engine,model,effort) VALUES (?,?,?,?,?,?)').run('legacy_worker', 0, 1, 'claude', 'sonnet', 'high');
  migrate(old);
  assert.ok(columns(old).includes('max_parallel'));
  assert.equal(version(old), SCHEMA_VERSION);
  assert.deepEqual({ ...(old.prepare('SELECT id,model,max_parallel FROM policy_workers').get() as object) }, { id: 'legacy_worker', model: 'sonnet', max_parallel: null });
  // Running again changes nothing, and the old row is still readable as uncapped.
  migrate(old);
  migrate(old);
  assert.equal(version(old), SCHEMA_VERSION);
  assert.equal(columns(old).filter(name => name === 'max_parallel').length, 1);
  assert.equal((old.prepare('SELECT count(*) n FROM policy_workers').get() as { n: number }).n, 1);
  old.close();
});

test('the store round-trips a worker cap and drops it again when the key is removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-worker-cap-'));
  const path = join(dir, 'weaver.db');
  try {
    const store = new PolicyStore(path);
    const first = store.snapshot();
    const config = structuredClone(first.config);
    config.workers.claude_worker!.max_parallel = 2;
    store.save({ revision: first.revision, config, blocks: [] });
    const reopened = new PolicyStore(path);
    assert.equal(reopened.snapshot().config.workers.claude_worker!.max_parallel, 2);
    assert.equal(Object.hasOwn(reopened.snapshot().config.workers.codex_worker!, 'max_parallel'), false, 'workers without a cap stay without the key');
    const next = reopened.snapshot();
    const cleared = structuredClone(next.config);
    delete cleared.workers.claude_worker!.max_parallel;
    reopened.save({ revision: next.revision, config: cleared, blocks: [] });
    assert.equal(Object.hasOwn(new PolicyStore(path).snapshot().config.workers.claude_worker!, 'max_parallel'), false);
    assert.throws(() => {
      const bad = reopened.snapshot();
      bad.config.workers.claude_worker!.max_parallel = 0;
      reopened.save({ revision: bad.revision, config: bad.config, blocks: [] });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('routing skips a worker at its cap with the count in the reason and sends work to the other', () => {
  const config = pair({ claude_worker: 2 });
  const route = resolveDispatch(config, [], { owner: 'claude_owner', workerLoad: { claude_worker: 2 } });
  assert.equal(route.worker, 'codex_worker');
  assert.deepEqual(route.skipped?.find(item => item.worker === 'claude_worker'), { worker: 'claude_worker', reason: '并发已满（2/2）' });
  assert.deepEqual(route.candidates?.map(item => item.worker), ['codex_worker']);
  // One slot short of the cap is still open.
  assert.equal(resolveDispatch(config, [], { owner: 'claude_owner', workerLoad: { claude_worker: 1, codex_worker: 1 } }).worker, 'claude_worker');
  // Uncapped workers behave exactly as before, however loaded they are.
  const plain = resolveDispatch(pair(), [], { owner: 'claude_owner', workerLoad: { claude_worker: 50 } });
  assert.equal(plain.worker, 'codex_worker');
  assert.equal(plain.skipped?.length, 0);
  assert.equal(resolveDispatch(pair(), [], { owner: 'claude_owner' }).worker, 'claude_worker');
});

test('when every worker is full the preview says there is no capacity and names the worker it waits for', () => {
  const config = pair({ claude_worker: 1, codex_worker: 2 });
  const preview = previewRoute(config, [], Date.now(), { owner: 'claude_owner', workerLoad: { claude_worker: 1, codex_worker: 2 } });
  assert.equal(preview.capacityAvailable, false);
  assert.deepEqual(preview.workerCapacity, { running: 1, limit: 1 });
  assert.equal(preview.worker, 'claude_worker', 'the worker closest to a free slot, with the stronger weight on a tie');
  assert.deepEqual(preview.skipped?.map(item => item.reason), ['并发已满（1/1）', '并发已满（2/2）']);
  assert.deepEqual(preview.candidates, []);
  // A slot opening on either worker makes the next preview dispatchable again.
  const freed = previewRoute(config, [], Date.now(), { owner: 'claude_owner', workerLoad: { claude_worker: 1, codex_worker: 1 } });
  assert.equal(freed.capacityAvailable, true);
  assert.equal(freed.worker, 'codex_worker');
});

test('a named worker at its cap is not available and an uncapped preview carries no capacity', () => {
  const config = pair({ claude_worker: 1 });
  const named = previewRoute(config, [], Date.now(), { owner: 'claude_owner', worker: 'claude_worker', workerLoad: { claude_worker: 1 } });
  assert.equal(named.worker, 'claude_worker');
  assert.equal(named.selected_by, 'worker');
  assert.equal(named.capacityAvailable, false);
  assert.deepEqual(named.workerCapacity, { running: 1, limit: 1 });
  assert.equal(previewRoute(config, [], Date.now(), { owner: 'claude_owner', worker: 'claude_worker' }).capacityAvailable, true);
  const uncapped = previewRoute(pair(), [], Date.now(), { owner: 'claude_owner', worker: 'claude_worker', workerLoad: { claude_worker: 9 } });
  assert.equal(uncapped.capacityAvailable, true);
  assert.equal(Object.hasOwn(uncapped, 'workerCapacity'), false);
});

// Native workers stay running until the owner reports, which makes them the cleanest way to hold a worker slot.
const adapter = { id: 'routing', canLaunchReal: () => false, start: () => { throw new Error('native work must not launch a process'); } } as unknown as WorkerAdapter;

function runtime(cap: number | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-worker-cap-run-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const manager = new TaskManager(store, adapter);
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  const handler = new CommandHandler(manager, policy);
  const saved = policy.snapshot();
  if (cap !== undefined) saved.config.workers.claude_worker!.max_parallel = cap;
  saved.config.owners.claude_owner!.workers = ['claude_worker'];
  policy.save({ revision: saved.revision, config: saved.config, blocks: [] });
  const call = (command: string, args: Record<string, unknown> = {}): any => {
    const result = handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command, args });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  // Each create registers its own owner instance, so only the worker's cap can hold a task back.
  const task = () => call('tasks.create', { title: 'Native', goal: 'edit a file', workspace: dir, ownerProfileId: 'claude_owner' });
  const settle = async (taskId: string, status: string) => {
    for (let i = 0; i < 100 && store.get(taskId).status !== status; i++) { handler.pump(); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  return { store, call, task, settle, close: async () => { handler.draining = true; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

for (const mode of ['routed', 'named'] as const) {
  test(`a ${mode} task over the worker cap waits in the queue and starts by itself when a slot frees`, async () => {
    const f = runtime(1);
    try {
      const args = (taskId: string) => ({ taskId, ...(mode === 'named' ? { worker: 'claude_worker' } : {}) });
      const a = f.task(); const b = f.task();
      assert.equal(f.call('workers.spawn', args(a.id)).status, 'running');
      const held = f.call('workers.spawn', args(b.id));
      assert.equal(held.status, 'queued');
      const queued = f.store.get(b.id);
      assert.equal(queued.queueReason?.code, 'waiting_for_capacity');
      assert.match(queued.queueReason!.message, /claude_worker.*并发已满（1\/1）/);
      assert.equal(queued.dispatch?.worker, 'claude_worker');
      f.call('workers.complete', { taskId: a.id, outcome: 'completed', summary: 'done' });
      await f.settle(b.id, 'running');
      const started = f.store.get(b.id);
      assert.equal(started.status, 'running');
      assert.equal(started.queueReason, undefined);
      assert.equal(started.run?.execution, 'native');
    } finally { await f.close(); }
  });
}

test('without a cap two tasks of one worker run at the same time', async () => {
  const f = runtime(undefined);
  try {
    const a = f.task(); const b = f.task();
    assert.equal(f.call('workers.spawn', { taskId: a.id }).status, 'running');
    assert.equal(f.call('workers.spawn', { taskId: b.id }).status, 'running');
  } finally { await f.close(); }
});
