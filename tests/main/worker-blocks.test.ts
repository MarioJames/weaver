import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { CommandHandler } from '../../src/main/commands';
import { PolicyStore } from '../../src/main/policy/store';
import { StallMonitor } from '../../src/main/stall';
import { validateConfig } from '../../src/main/policy/routing';
import { type Block } from '../../src/shared/contracts/policy';
import type { Task, TaskDispatch, TaskFailure } from '../../src/shared/contracts/tasks';
import { stallStoreAt } from '../helpers/state-db';
import { engineDiagnostics } from '../helpers/diagnostics';
import { previewOn } from '../helpers/policy-preview';

class HeldWorker extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() { return true; }
  close() { this.stdout.end(); this.stderr.end(); this.emit('close', null, 'SIGTERM'); }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const VENDOR = 'weaver-vendor-limit';
const MINUTE = 60_000;

/** claude_owner (claude engine) with two enabled workers on codex plus a free opencode worker. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-worker-blocks-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const children: HeldWorker[] = [];
  const manager = new TaskManager(store, { id: 'fixture', canLaunchReal: () => true, start() { const child = new HeldWorker(); children.push(child); return child; } });
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  const snapshot = policy.snapshot();
  const config = snapshot.config;
  config.workers.codexb_worker = { ...config.workers.codex_worker!, model: 'gpt-b' };
  config.workers.opencode_worker!.enabled = true;
  config.engines.opencode!.enabled = true;
  config.owners.claude_owner!.workers = ['codex_worker', 'codexb_worker', 'opencode_worker'];
  config.owners.claude_owner!.worker_weights = { codex_worker: 10, codexb_worker: 8, opencode_worker: 2 };
  config.owners.claude_owner!.max_parallel = 10;
  policy.save({ revision: snapshot.revision, config, blocks: [] }, { allowEngineEnable: true });
  const monitor = new StallMonitor({ tasks: () => store.list(), policy: () => policy, stateStore: stallStoreAt(join(dir, 'state.db')), cpu: async () => null, log: () => {} });
  const handler = new CommandHandler(manager, policy, () => { throw new Error('No owner launch in fixture'); }, () => false, engineDiagnostics(policy, monitor));
  const raw = (command: string, args: Record<string, unknown> = {}) => handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command, args });
  const call = (command: string, args: Record<string, unknown> = {}): any => { const response = raw(command, args); assert.equal(response.ok, true, JSON.stringify(response)); return response.data; };
  const create = (): Task => store.get(call('tasks.create', { title: 'Worker block', instruction: 'Inspect the fixture', ownerProfileId: 'claude_owner', workspace: dir }).id);
  const route = (worker: string, engine: string): TaskDispatch => ({ owner: 'claude_owner', worker, engine, model: 'fixture', effort: 'high', execution: 'real', adapter: 'codex', engineKind: 'codex', maxParallel: 10, workspace: dir });
  /** A finished attempt that ended on the given failure. */
  const failed = (worker: string, engine: string, failure: TaskFailure): Task => {
    const task = create(); task.dispatch = route(worker, engine); task.status = 'failed'; task.failure = failure; store.put(task); return store.get(task.id);
  };
  const settle = async () => { handler.pump(); await turn(); await turn(); };
  const blocks = () => policy.snapshot().blocks;
  return { dir, store, manager, policy, handler, monitor, raw, call, create, route, failed, settle, blocks, children, close: async () => {
    handler.draining = true;
    for (const child of children) child.close();
    await manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  } };
}
const rate = (extra: Partial<TaskFailure> = {}): TaskFailure => ({ kind: 'rate_limit', message: '429 too many requests', ...extra });

test('a rate-limited worker is blocked alone: its sibling stays routable and owners are untouched', async () => {
  const f = setup();
  try {
    f.failed('codex_worker', 'codex', rate());
    await f.settle();
    assert.equal(f.blocks().length, 1);
    const block = f.blocks()[0]!;
    assert.deepEqual([block.engine, block.worker, block.by, block.model], ['codex', 'codex_worker', VENDOR, undefined]);
    assert.ok(block.release_at, 'a rate limit carries a ladder release');
    const snapshot = f.policy.snapshot();
    assert.equal(snapshot.workers.codex_worker!.status, 'blocked');
    assert.equal(snapshot.workers.codex_worker!.worker, 'codex_worker');
    assert.equal(snapshot.workers.codex_worker!.release_at, block.release_at);
    assert.match(snapshot.workers.codex_worker!.reason!, /限流/);
    assert.equal(snapshot.workers.codexb_worker!.status, 'available');
    assert.equal(snapshot.owners.codex_owner!.status, 'available', 'a worker block never reaches an owner on the same engine');
    assert.equal(snapshot.owners.claude_owner!.status, 'available');
    assert.equal(previewOn(f.policy, { owner: 'claude_owner' }).worker, 'codexb_worker');
    assert.equal(previewOn(f.policy, { owner: 'claude_owner', worker: 'codexb_worker' }).worker, 'codexb_worker');
    assert.throws(() => previewOn(f.policy, { owner: 'claude_owner', worker: 'codex_worker' }), /unavailable: blocked \(codex worker codex_worker/);
  } finally { await f.close(); }
});

test('once every enabled worker of the engine is blocked the engine is blocked too, released with the earliest worker block', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-01T00:00:00Z') });
  const f = setup();
  try {
    f.failed('codex_worker', 'codex', rate());
    await f.settle();
    t.mock.timers.tick(MINUTE);
    f.failed('codexb_worker', 'codex', rate());
    await f.settle();
    const workers = f.blocks().filter(block => block.worker !== undefined);
    assert.deepEqual(workers.map(block => block.worker).sort(), ['codex_worker', 'codexb_worker']);
    const engine = f.blocks().filter(block => block.worker === undefined);
    assert.equal(engine.length, 1);
    assert.deepEqual([engine[0]!.engine, engine[0]!.model, engine[0]!.by], ['codex', undefined, VENDOR]);
    assert.match(engine[0]!.reason, /该引擎全部子 Agent 均被限流\/额度耗尽/);
    const earliest = Math.min(...workers.map(block => Date.parse(block.release_at!)));
    assert.equal(engine[0]!.release_at, new Date(earliest).toISOString());
    assert.equal(earliest, Date.parse('2030-01-01T00:10:00Z'));
    assert.equal(f.policy.snapshot().owners.codex_owner!.status, 'blocked', 'the whole-engine block reaches the owner on that engine');
    // A third failure refreshes the worker block; the engine block is refreshed in place, never duplicated.
    t.mock.timers.tick(MINUTE);
    f.failed('codexb_worker', 'codex', rate());
    await f.settle();
    assert.equal(f.blocks().filter(block => block.worker === undefined).length, 1);
    assert.equal(f.blocks().filter(block => block.worker === 'codexb_worker').length, 1);
  } finally { await f.close(); t.mock.timers.reset(); }
});

test('an engine-level block from another source is not duplicated by the escalation', async () => {
  const f = setup();
  try {
    const snapshot = f.policy.snapshot();
    f.policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [{ engine: 'codex', reason: 'manual stop', since: new Date().toISOString(), by: 'manual' }] });
    f.failed('codex_worker', 'codex', rate());
    f.failed('codexb_worker', 'codex', rate());
    await f.settle();
    assert.deepEqual(f.blocks().map(block => block.by), ['manual'], 'the engine is already out; no worker or engine vendor block is stacked');
  } finally { await f.close(); }
});

test('quota exhaustion without a reset time blocks the worker with no release and the engine without one', async () => {
  const f = setup();
  try {
    f.failed('codex_worker', 'codex', { kind: 'quota', message: 'FreeUsageLimitError' });
    f.failed('codexb_worker', 'codex', { kind: 'quota', message: 'FreeUsageLimitError' });
    await f.settle();
    assert.equal(f.blocks().length, 3);
    assert.ok(f.blocks().every(block => block.release_at === undefined && block.by === VENDOR));
  } finally { await f.close(); }
});

test('a dispatch without a known worker falls back to the whole-engine block', async () => {
  const f = setup();
  try {
    const task = f.failed('ghost_worker', 'codex', rate());
    await f.settle();
    assert.deepEqual(f.blocks().map(block => [block.engine, block.worker]), [['codex', undefined]]);
    const bare = f.create(); const dispatch = f.route('x', 'opencode') as Partial<TaskDispatch>; delete dispatch.worker;
    bare.dispatch = dispatch as TaskDispatch; bare.status = 'failed'; bare.failure = rate(); f.store.put(bare);
    await f.settle();
    assert.ok(f.blocks().some(block => block.engine === 'opencode' && block.worker === undefined));
    assert.ok(task.id);
  } finally { await f.close(); }
});

test('the rate-limit ladder is kept per worker: 10, 30, 60 minutes for one worker while its sibling starts at 10', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-01T00:00:00Z') });
  const f = setup();
  try {
    const release = (worker: string) => Date.parse(f.blocks().find(block => block.worker === worker)!.release_at!) - Date.now();
    for (const minutes of [10, 30, 60, 60]) {
      f.failed('codex_worker', 'codex', rate());
      await f.settle();
      assert.equal(release('codex_worker'), minutes * MINUTE);
      t.mock.timers.tick(1000);
    }
    f.failed('codexb_worker', 'codex', rate());
    await f.settle();
    assert.equal(release('codexb_worker'), 10 * MINUTE, 'a sibling worker has its own ladder');
    assert.deepEqual(Object.keys(f.store.listVendorLimits()).sort(), ['codex_worker', 'codexb_worker']);
    assert.equal(f.store.getVendorLimit('codex_worker')!.level, 3);
    assert.equal(f.store.getVendorLimit('codexb_worker')!.level, 1);
    t.mock.timers.tick(2 * 60 * MINUTE);
    f.failed('codex_worker', 'codex', rate());
    await f.settle();
    assert.equal(release('codex_worker'), 10 * MINUTE, 'two quiet hours reset the worker ladder');
  } finally { await f.close(); t.mock.timers.reset(); }
});

test('a removed block is not written again for the same failure', async () => {
  const f = setup();
  try {
    f.failed('codex_worker', 'codex', rate());
    await f.settle();
    const snapshot = f.policy.snapshot();
    f.policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [] });
    await f.settle();
    assert.deepEqual(f.blocks(), []);
  } finally { await f.close(); }
});

test('a queued task frozen to a worker-blocked worker is rerouted to its sibling; a whole-engine block reroutes by engine', async () => {
  const f = setup();
  try {
    const queued = (worker: string, engine: string): Task => {
      const task = f.create(); task.dispatch = f.route(worker, engine); task.scheduled = true; task.status = 'queued'; f.store.put(task); return task;
    };
    const first = queued('codex_worker', 'codex');
    const snapshot = f.policy.snapshot();
    const hold: Block = { engine: 'codex', worker: 'codex_worker', reason: '限流：test', since: new Date().toISOString(), by: VENDOR, release_at: new Date(Date.now() + 10 * MINUTE).toISOString() };
    f.policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [hold] });
    await f.settle();
    const moved = f.store.get(first.id);
    assert.equal(moved.dispatch?.worker, 'codexb_worker');
    assert.equal(moved.dispatch?.engine, 'codex', 'the same engine is still used');
    assert.ok(moved.events.some(item => /Vendor limit rerouted queued worker to codex \(codexb_worker\)/.test(item.message)));
    // Whole-engine block: the engine is excluded, so the free opencode worker is chosen.
    const second = queued('codexb_worker', 'codex');
    const next = f.policy.snapshot();
    f.policy.save({ revision: next.revision, config: next.config, blocks: [{ engine: 'codex', reason: '限流：test', since: new Date().toISOString(), by: VENDOR, release_at: new Date(Date.now() + 10 * MINUTE).toISOString() }] });
    await f.settle();
    assert.equal(f.store.get(second.id).dispatch?.engine, 'opencode');
  } finally { await f.close(); }
});

test('a vendor reroute keeps the retry chain out and never returns to a failed worker', async () => {
  const f = setup();
  try {
    const chain = f.failed('codexb_worker', 'codex', { kind: 'other', message: 'boom' });
    const task = f.create();
    task.retryOf = chain.id;
    task.dispatch = f.route('codex_worker', 'codex');
    task.scheduled = true;
    task.status = 'queued';
    f.store.put(task);
    const snapshot = f.policy.snapshot();
    const hold: Block = { engine: 'codex', worker: 'codex_worker', reason: '限流：test', since: new Date().toISOString(), by: VENDOR, release_at: new Date(Date.now() + 10 * MINUTE).toISOString() };
    f.policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [hold] });
    await f.settle();
    const moved = f.store.get(task.id);
    assert.equal(moved.dispatch?.worker, 'opencode_worker', 'codexb_worker is in the retry chain and stays excluded');
    assert.equal(moved.dispatch?.engine, 'opencode');
    assert.ok(moved.events.some(item => /Vendor limit rerouted queued worker to opencode \(opencode_worker\)/.test(item.message)));
  } finally { await f.close(); }
});

test('after a rate-limit failure tasks retry still chooses another worker on the same engine; other failures exclude only that worker', async () => {
  const f = setup();
  try {
    const limited = f.failed('codex_worker', 'codex', rate());
    const retry = f.call('tasks.retry', { taskId: limited.id });
    assert.equal(retry.dispatch.worker, 'codexb_worker');
    assert.equal(retry.dispatch.engine, 'codex');
    assert.deepEqual(retry.excludedWorkers, ['codex_worker']);
    assert.equal(retry.excludedEngines, undefined, 'the rate-limited engine is not excluded');
    assert.ok(f.blocks().some(block => block.worker === 'codex_worker'), 'the retry already saw the worker block');
    // The chain walks on: the second worker is now blocked too, so only the other engine is left.
    const second = f.store.get(retry.id);
    second.status = 'failed'; second.failure = rate(); f.store.put(second);
    const again = f.call('tasks.retry', { taskId: second.id });
    assert.equal(again.dispatch.engine, 'opencode', 'both codex workers are blocked, so only the other engine is left');
    assert.deepEqual(new Set(again.excludedWorkers), new Set(['codex_worker', 'codexb_worker']));
    // Any other failure excludes only the worker that ran it.
    const other = f.failed('codexb_worker', 'codex', { kind: 'other', message: 'boom' });
    const third = f.call('tasks.retry', { taskId: other.id });
    assert.equal(third.dispatch.engine, 'opencode');
    assert.deepEqual(third.excludedWorkers, ['codexb_worker']);
  } finally { await f.close(); }
});

test('engines unblock clears the engine block and its worker-level blocks and leaves other engines alone', async () => {
  const f = setup();
  try {
    f.failed('codex_worker', 'codex', rate());
    f.failed('codexb_worker', 'codex', rate());
    f.failed('opencode_worker', 'opencode', rate());
    await f.settle();
    assert.equal(f.blocks().filter(block => block.engine === 'codex').length, 3);
    const result = f.call('engines.unblock', { engine: 'codex' });
    assert.equal(result.engine, 'codex');
    // opencode has a single enabled worker, so its worker block and the engine block it implied are both another engine's business.
    assert.deepEqual(f.blocks().map(block => [block.engine, block.worker]), [['opencode', 'opencode_worker'], ['opencode', undefined]]);
    assert.equal(f.policy.snapshot().workers.codex_worker!.status, 'available');
    assert.equal(f.policy.snapshot().workers.codexb_worker!.status, 'available');
  } finally { await f.close(); }
});

test('workers.unblock lifts one worker and the all-limited engine block it held up, keeps the vendor ladder, and replays its receipt', async () => {
  const f = setup();
  try {
    f.failed('codex_worker', 'codex', rate());
    f.failed('codexb_worker', 'codex', rate());
    await f.settle();
    assert.equal(f.blocks().filter(block => block.engine === 'codex').length, 3, 'two worker blocks and the engine block they imply');
    const ladder = JSON.stringify(f.store.listVendorLimits());
    const commandId = randomUUID();
    const unblock = (worker: string, id = commandId) => f.handler.handle({ apiVersion: 'weaver.v1', commandId: id, command: 'workers.unblock', args: { worker } });
    const first = unblock('codex_worker');
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(first.data, { worker: 'codex_worker', engine: 'codex', removed: 2, wasBlocked: true });
    assert.deepEqual(f.blocks().map(block => [block.engine, block.worker]), [['codex', 'codexb_worker']], 'the sibling keeps its own ban');
    assert.equal(f.policy.snapshot().workers.codex_worker!.status, 'available');
    assert.equal(f.policy.snapshot().workers.codexb_worker!.status, 'blocked');
    assert.equal(JSON.stringify(f.store.listVendorLimits()), ladder, 'the rate-limit ladder is not reset by an unblock');
    // The same command ID replays the receipt; a different worker under it is a conflict.
    const revision = f.policy.snapshot().revision;
    assert.deepEqual(unblock('codex_worker').data, first.data);
    assert.equal(unblock('codexb_worker').error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(f.policy.snapshot().revision, revision);
    // A fresh command on a worker with nothing to lift is a no-op.
    assert.deepEqual(unblock('codex_worker', randomUUID()).data, { worker: 'codex_worker', engine: 'codex', removed: 0, wasBlocked: false });
    assert.equal(f.policy.snapshot().revision, revision);
    // An unknown worker is refused before any write; a missing one is an invalid request.
    assert.equal(unblock('ghost', randomUUID()).error?.code, 'NOT_FOUND');
    assert.equal(f.handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command: 'workers.unblock', args: {} }).ok, false);
    assert.equal(f.policy.snapshot().revision, revision);
  } finally { await f.close(); }
});

test('policy save accepts worker-level blocks, drops those of a removed worker and rejects duplicates and unknown fields', async () => {
  const f = setup();
  try {
    const snapshot = f.policy.snapshot();
    const since = new Date().toISOString();
    const hold = (worker: string): Block => ({ engine: 'codex', worker, reason: 'x', since, by: 'manual' });
    const saved = f.policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [hold('codex_worker'), hold('codexb_worker'), { engine: 'codex', reason: 'y', since }] });
    assert.deepEqual(saved.blocks.map(block => block.worker), ['codex_worker', 'codexb_worker', undefined]);
    assert.throws(() => f.policy.save({ revision: saved.revision, config: saved.config, blocks: [hold('codex_worker'), hold('codex_worker')] }), /Duplicate/);
    assert.throws(() => f.policy.save({ revision: saved.revision, config: saved.config, blocks: [{ ...hold('codex_worker'), worker: '' }] }), /Invalid worker/);
    assert.throws(() => f.policy.save({ revision: saved.revision, config: saved.config, blocks: [{ ...hold('codex_worker'), extra: 1 } as unknown as Block] }), /Unknown policy field/);
    const config = structuredClone(saved.config);
    delete config.workers.codexb_worker;
    config.owners.claude_owner!.workers = ['codex_worker', 'opencode_worker'];
    delete config.owners.claude_owner!.worker_weights!.codexb_worker;
    const trimmed = f.policy.save({ revision: saved.revision, config, blocks: saved.blocks });
    assert.deepEqual(trimmed.blocks.map(block => block.worker), ['codex_worker', undefined], 'the block of a removed worker leaves with it');
  } finally { await f.close(); }
});
