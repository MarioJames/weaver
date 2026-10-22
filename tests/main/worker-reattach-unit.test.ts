import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { reattach, type ReattachDeps } from '../../src/main/application/tasks/reattach';
import type { CliRun, RunAttachState, RunCursor, RunLaunchRecord } from '../../src/main/adapters/cli/run';
import type { AgentRun, Task, TaskFailure, TaskInput, WorkerRecord } from '../../src/shared/contracts/tasks';
import type { WorkerAdapter } from '../../src/main/adapters/worker';

const TMP = mkdtempSync(join(tmpdir(), 'wv-reattach-unit-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const input: TaskInput = { title: 'fixture', instruction: 'safe fixture', owner: { name: 'owner', transport: 'herdr-visible', session: 'main', pane: '1' } };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await pause(10);
  }
};
const quiet: ReattachDeps = { console: () => {} };

function launchRecord(dir: string, runId: string): RunLaunchRecord {
  return {
    unit: `weaver-p1test-${runId.slice(0, 8)}`,
    stateDir: dir,
    nonce: 'cd'.repeat(16),
    logs: {
      stdout: join(dir, `stdout-${runId}.log`),
      stderr: join(dir, `stderr-${runId}.log`),
      exit: join(dir, `exit-${runId}.json`),
      exitTmp: join(dir, `exit-${runId}.tmp`),
    },
    logIdentity: { stdout: { dev: 11, ino: 22 }, stderr: { dev: 11, ino: 23 } },
    promptPath: join(dir, 'prompt.txt'),
  };
}

class FakeRun extends EventEmitter implements CliRun {
  readonly launch: RunLaunchRecord;
  readonly evidence: NonNullable<AgentRun['evidence']>;
  readonly unit: string;
  readonly terminated: string[] = [];
  detached = false;
  constructor(launch: RunLaunchRecord, engine: NonNullable<AgentRun['evidence']>['engine'] = 'opencode') {
    super();
    this.launch = launch;
    this.unit = launch.unit;
    this.evidence = { engine, requestedModel: 'opencode/test', requestedEffort: 'max', workspace: launch.stateDir, terminal: 'pending' };
  }
  setInvocation(): void {}
  setCancelled(): void {}
  async terminate(signal: 'SIGTERM' | 'SIGKILL'): Promise<{ ok: true }> {
    this.terminated.push(signal);
    return { ok: true };
  }
  detach(): void { this.detached = true; }
}

interface FakeAdapter extends WorkerAdapter {
  startRun(task: Task, runId: string, beforeSpawn: (record: RunLaunchRecord) => void): CliRun;
  attachRun(task: Task, state: RunAttachState): CliRun;
  started?: FakeRun;
  attached?: FakeRun;
  attachState?: RunAttachState;
}

function adapter(options: { onAttach?: (run: FakeRun, state: RunAttachState) => void } = {}): FakeAdapter {
  const result: FakeAdapter = {
    id: 'routing',
    canLaunchReal: () => true,
    start: () => { throw new Error('pipe start must not be used'); },
    startRun(task, runId, beforeSpawn) {
      const dir = mkdtempSync(join(TMP, 'start-'));
      const launch = launchRecord(dir, runId);
      beforeSpawn(launch);
      const run = new FakeRun(launch, (task.dispatch?.engineKind ?? 'opencode') as NonNullable<AgentRun['evidence']>['engine']);
      result.started = run;
      return run;
    },
    attachRun(_task, state) {
      const run = new FakeRun(state.launch, state.input.engine);
      result.attached = run;
      result.attachState = state;
      options.onAttach?.(run, state);
      return run;
    },
  };
  return result;
}

function startReal(manager: TaskManager): Task {
  const task = manager.create(input);
  task.dispatch = { owner: 'owner', worker: 'w', engine: 'opencode', engineKind: 'opencode', model: 'opencode/test', effort: 'max', execution: 'real', adapter: 'opencode', maxParallel: 2, workspace: join(TMP, `ws-${task.id}`) };
  manager.store.put(task);
  return manager.start(task.id);
}

function persisted(store: TaskStore, overrides: { status?: Task['status']; invocation?: string; run?: Partial<AgentRun>; failure?: TaskFailure; artifacts?: Task['artifacts'] } = {}): Task {
  const id = randomUUID();
  const runId = randomUUID();
  const dir = mkdtempSync(join(TMP, 'persist-'));
  const at = new Date().toISOString();
  const launch = launchRecord(dir, runId);
  const run: AgentRun = {
    id: runId, adapter: 'opencode', execution: 'real', status: 'running', engine: 'opencode', model: 'opencode/test', effort: 'max', workspace: dir,
    startedAt: at, launchPermittedAt: at, scopeUnit: launch.unit, stateDir: dir, logs: launch.logs, logIdentity: launch.logIdentity, nonce: launch.nonce,
    replay: { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 0 }, noOutputDeadline: new Date(Date.parse(at) + 120000).toISOString(),
    ...(overrides.invocation ? { scopeInvocation: overrides.invocation } : {}),
    ...overrides.run,
  };
  const task: Task = {
    ...input, id, title: 'fixture', instruction: 'safe fixture', createdAt: at, updatedAt: at,
    status: overrides.status ?? 'running', progress: 0, events: [], artifacts: overrides.artifacts ?? [], run,
    ...(overrides.failure ? { failure: overrides.failure } : {}),
    dispatch: { owner: 'owner', worker: 'w', engine: 'opencode', engineKind: 'opencode', model: 'opencode/test', effort: 'max', execution: 'real', adapter: 'opencode', maxParallel: 2, workspace: dir },
  };
  store.put(task);
  return store.get(id);
}

function harness() {
  const dir = mkdtempSync(join(TMP, 'manager-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const runs: FakeRun[] = [];
  const manager = new TaskManager(store, adapter(), () => {}, undefined, error => { throw error; });
  return {
    dir, store, manager, runs,
    async close() { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a 1001-record batch is applied atomically and kept by bounded retention, not failed', async () => {
  const h = harness();
  try {
    const task = startReal(h.manager);
    const run = (h.manager as unknown as { fileAdapter(): { started?: FakeRun } }).fileAdapter().started!;
    const records: WorkerRecord[] = Array.from({ length: 1001 }, (_, i) => ({ type: 'log', message: `line-${i}` }));
    run.emit('batch', { cursor: { stdoutOffset: 5000, stderrOffset: 0, appliedRecords: 1001 }, records });
    const applied = h.store.get(task.id);
    assert.equal(applied.status, 'running', 'there is no cumulative record limit');
    assert.equal(applied.run?.replay?.stdoutOffset, 5000, 'the applied row commits its cursor');
    const marker = applied.events.find(value => /^已省略 \d+ 条过程记录（/.test(value.message));
    assert.ok(marker, 'the retained timeline names the omitted gap');
    const logs = applied.events.filter(value => value.kind === 'log' && value !== marker);
    assert.equal(logs.length, 450, 'process records keep 50 head + 400 tail');
    assert.equal(logs[0]?.message, 'line-0');
    assert.equal(logs.at(-1)?.message, 'line-1000');
    run.emit('batch', { cursor: { stdoutOffset: 6000, stderrOffset: 0, appliedRecords: 1002 }, records: [{ type: 'log', message: 'after' }] });
    assert.equal(h.store.get(task.id).events.filter(value => value.message === 'after').length, 1, 'later rows still apply');
    run.emit('final', { cursor: { stdoutOffset: 6000, stderrOffset: 0, appliedRecords: 1002 }, records: [{ type: 'result', summary: 'late result' }], evidence: { ...run.evidence, terminal: 'success' }, exit: { code: 0, signal: null, recorded: true } });
    const final = h.store.get(task.id);
    assert.equal(final.status, 'completed');
    assert.equal(final.summary, 'late result');
  } finally { await h.close(); }
});

test('artifact overflow keeps the first 20 with one note instead of failing the row', async () => {
  const h = harness();
  try {
    const task = startReal(h.manager);
    const run = (h.manager as unknown as { fileAdapter(): { started?: FakeRun } }).fileAdapter().started!;
    const records: WorkerRecord[] = [{ type: 'log', message: 'before-artifacts' }];
    for (let i = 0; i < 21; i++) records.push({ type: 'artifact', name: `a${i}.txt`, mediaType: 'text/plain', content: 'x' });
    run.emit('batch', { cursor: { stdoutOffset: 1, stderrOffset: 0, appliedRecords: 22 }, records });
    const applied = h.store.get(task.id);
    assert.equal(applied.status, 'running');
    assert.equal(applied.artifacts.length, 20);
    assert.deepEqual(applied.artifacts.map(value => value.name), Array.from({ length: 20 }, (_, i) => `a${i}.txt`));
    assert.equal(applied.events.filter(value => value.message === 'before-artifacts').length, 1);
    assert.equal(applied.events.filter(value => /Artifact limit reached/.test(value.message)).length, 1);
    run.emit('batch', { cursor: { stdoutOffset: 2, stderrOffset: 0, appliedRecords: 23 }, records: [{ type: 'artifact', name: 'a21.txt', mediaType: 'text/plain', content: 'x' }] });
    assert.equal(h.store.get(task.id).events.filter(value => /Artifact limit reached/.test(value.message)).length, 1, 'the note is emitted once per run');
    run.emit('final', { cursor: { stdoutOffset: 2, stderrOffset: 0, appliedRecords: 23 }, records: [{ type: 'result', summary: 'artifacts ok' }], evidence: { ...run.evidence, terminal: 'success' }, exit: { code: 0, signal: null, recorded: true } });
    const final = h.store.get(task.id);
    assert.equal(final.status, 'completed');
    assert.equal(final.summary, 'artifacts ok');
    assert.equal(final.artifacts.length, 20);
  } finally { await h.close(); }
});

test('reattach hands the persisted root pid to the resumed run for process-tree health and cleanup', async () => {
  const h = harness();
  try {
    const task = persisted(h.store, { run: { pid: 4321 } });
    const fake = adapter();
    const manager = new TaskManager(h.store, fake, () => {}, undefined, error => { throw error; });
    try {
      assert.equal(manager.attachRecovered(task.id, { invocation: 'b'.repeat(32), cancelled: false, deferNoOutput: true }), true);
      assert.equal(fake.attachState?.pid, 4321);
    } finally { await manager.shutdown(); }
  } finally { h.store.close(); rmSync(h.dir, { recursive: true, force: true }); }
});

test('detach and reattach resume at the committed cursor without duplicate records, artifacts or result', async () => {
  const h = harness();
  const path = h.store.path;
  let taskId = '';
  try {
    const task = startReal(h.manager);
    taskId = task.id;
    const run = (h.manager as unknown as { fileAdapter(): { started?: FakeRun } }).fileAdapter().started!;
    run.emit('batch', { cursor: { stdoutOffset: 10, stderrOffset: 0, appliedRecords: 2 }, records: [{ type: 'log', message: 'one' }, { type: 'artifact', name: 'a.txt', mediaType: 'text/plain', content: 'A' }] });
    await h.manager.shutdown();
    h.store.close();
    const store2 = new TaskStore(path);
    const manager2 = new TaskManager(store2, adapter(), () => {}, undefined, error => { throw error; });
    try {
      const attached = manager2.attachRecovered(taskId, { invocation: 'a'.repeat(32), cancelled: false, deferNoOutput: true });
      assert.equal(attached, true);
      const run2 = (manager2 as unknown as { fileAdapter(): { attached?: FakeRun } }).fileAdapter().attached!;
      assert.deepEqual((manager2 as unknown as { fileAdapter(): { attachState?: RunAttachState } }).fileAdapter().attachState!.cursor, { stdoutOffset: 10, stderrOffset: 0, appliedRecords: 2 });
      run2.emit('batch', { cursor: { stdoutOffset: 20, stderrOffset: 0, appliedRecords: 3 }, records: [{ type: 'log', message: 'two' }] });
      run2.emit('batch', { cursor: { stdoutOffset: 30, stderrOffset: 0, appliedRecords: 4 }, records: [{ type: 'artifact', name: 'b.txt', mediaType: 'text/plain', content: 'B' }] });
      run2.emit('final', { cursor: { stdoutOffset: 40, stderrOffset: 0, appliedRecords: 5 }, records: [{ type: 'result', summary: 'done' }], evidence: { ...run2.evidence, terminal: 'success' }, exit: { code: 0, signal: null, recorded: true } });
      const done = store2.get(taskId);
      assert.equal(done.status, 'completed');
      assert.deepEqual(done.artifacts.map(value => value.name), ['a.txt', 'b.txt']);
      assert.equal(done.events.filter(value => value.message === 'one').length, 1);
      assert.equal(done.events.filter(value => value.message === 'two').length, 1);
      assert.equal(done.events.filter(value => value.kind === 'result').length, 1);
      assert.equal(done.run?.resultSummary, 'done');
    } finally { await manager2.shutdown(); store2.close(); }
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test('a finalized run is skipped on restart and never processes a second final', async () => {
  const h = harness();
  try {
    const task = startReal(h.manager);
    const run = (h.manager as unknown as { fileAdapter(): { started?: FakeRun } }).fileAdapter().started!;
    run.emit('final', { cursor: { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 1 }, records: [{ type: 'result', summary: 'done' }], evidence: { ...run.evidence, terminal: 'success' }, exit: { code: 0, signal: null, recorded: true } });
    assert.ok(h.store.get(task.id).run?.finalizedAt);
    const store2 = new TaskStore(h.store.path);
    const manager2 = new TaskManager(store2, adapter(), () => {}, undefined, error => { throw error; });
    try {
      const report = await reattach(manager2, quiet);
      assert.equal(report.counts.attached, 0);
      assert.equal(report.counts.finalized, 0);
      assert.equal(manager2.attachRecovered(task.id, { cancelled: false }), false);
      const again = store2.get(task.id);
      assert.equal(again.events.filter(value => value.kind === 'result').length, 1);
    } finally { await manager2.shutdown(); store2.close(); }
  } finally { await h.close(); }
});

test('a persisted cancellation continues after restart and finishes cancelled; 143 without intent is not cancelled', async () => {
  const h = harness();
  try {
    const task = startReal(h.manager);
    h.manager.setScopeInvocation(task.id, 'b'.repeat(32));
    h.manager.requestCancel(task.id);
    await h.manager.shutdown();
    const manager2 = new TaskManager(h.store, adapter(), () => {}, undefined, error => { throw error; });
    const deps: ReattachDeps = {
      ...quiet,
      inspectScope: async () => ({ state: 'present', active: 'active', invocation: 'b'.repeat(32) }),
      checkLogIdentity: () => ({ ok: true }),
      statSize: () => 0,
      backlogWaitMs: 10,
    };
    await reattach(manager2, deps);
    const run = (manager2 as unknown as { fileAdapter(): { attached?: FakeRun } }).fileAdapter().attached!;
    assert.deepEqual(run.terminated, ['SIGTERM']);
    run.emit('final', { cursor: { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 1 }, records: [], evidence: { ...run.evidence, terminal: 'cancelled' }, exit: { code: 143, signal: null, recorded: true } });
    const cancelled = h.store.get(task.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.run?.finalizedAt !== undefined, true);
    await manager2.shutdown();

    const plain = persisted(h.store, { invocation: 'c'.repeat(32) });
    const manager3 = new TaskManager(h.store, adapter(), () => {}, undefined, error => { throw error; });
    await reattach(manager3, { ...deps, inspectScope: async () => ({ state: 'present', active: 'active', invocation: 'c'.repeat(32) }) });
    const run3 = (manager3 as unknown as { fileAdapter(): { attached?: FakeRun } }).fileAdapter().attached!;
    run3.emit('final', { cursor: { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 1 }, records: [], evidence: { ...run3.evidence, terminal: 'error' }, exit: { code: 143, signal: null, recorded: true } });
    const failed = h.store.get(plain.id);
    assert.equal(failed.status, 'failed');
    assert.notEqual(failed.status, 'cancelled');
    assert.equal(failed.failure?.exitCode, 143);
    await manager3.shutdown();
  } finally { await h.close(); }
});

test('recovery never extends killAfter and an expired deadline goes straight to SIGKILL', async () => {
  const h = harness();
  try {
    const past = persisted(h.store, { status: 'failed', invocation: 'd'.repeat(32), failure: { kind: 'rate_limit', message: 'limited' }, run: { status: 'stopping', killAfter: new Date(Date.now() - 1000).toISOString(), terminationPhase: 'term' } });
    const before = h.store.get(past.id).run!.killAfter;
    const manager2 = new TaskManager(h.store, adapter(), () => {}, undefined, error => { throw error; });
    await reattach(manager2, {
      ...quiet,
      inspectScope: async () => ({ state: 'present', active: 'active', invocation: 'd'.repeat(32) }),
      checkLogIdentity: () => ({ ok: true }),
      statSize: () => 0,
      backlogWaitMs: 10,
    });
    const run = (manager2 as unknown as { fileAdapter(): { attached?: FakeRun } }).fileAdapter().attached!;
    assert.deepEqual(run.terminated, ['SIGKILL']);
    assert.equal(h.store.get(past.id).run?.killAfter, before, 'the absolute deadline is not extended');
    assert.equal(h.store.get(past.id).run?.terminationPhase, 'kill');
    await manager2.shutdown();

    const future = persisted(h.store, { status: 'failed', invocation: 'a1'.repeat(16), failure: { kind: 'rate_limit', message: 'limited' }, run: { killAfter: new Date(Date.now() + 60_000).toISOString(), terminationPhase: 'term' } });
    const futureDeadline = h.store.get(future.id).run!.killAfter;
    const manager3 = new TaskManager(h.store, adapter(), () => {}, undefined, error => { throw error; });
    await reattach(manager3, {
      ...quiet,
      inspectScope: async () => ({ state: 'present', active: 'active', invocation: 'a1'.repeat(16) }),
      checkLogIdentity: () => ({ ok: true }),
      statSize: () => 0,
      backlogWaitMs: 10,
    });
    const futureRun = (manager3 as unknown as { fileAdapter(): { attached?: FakeRun } }).fileAdapter().attached!;
    assert.deepEqual(futureRun.terminated, ['SIGTERM'], 'a future deadline keeps the remaining grace instead of extending it');
    assert.equal(h.store.get(future.id).run?.killAfter, futureDeadline);
    assert.equal(h.store.get(future.id).run?.terminationPhase, 'term');
    await manager3.shutdown();
  } finally { await h.close(); }
});

test('a failed run whose scope is still alive is attached, terminated, and finalized as failed', async () => {
  const h = harness();
  try {
    const task = persisted(h.store, { status: 'failed', invocation: 'e'.repeat(32), failure: { kind: 'rate_limit', message: 'limited' }, run: { killAfter: new Date(Date.now() + 60_000).toISOString(), terminationPhase: 'term' } });
    const manager2 = new TaskManager(h.store, adapter(), () => {}, undefined, error => { throw error; });
    await reattach(manager2, {
      ...quiet,
      inspectScope: async () => ({ state: 'present', active: 'active', invocation: 'e'.repeat(32) }),
      checkLogIdentity: () => ({ ok: true }),
      statSize: () => 0,
      backlogWaitMs: 10,
    });
    const run = (manager2 as unknown as { fileAdapter(): { attached?: FakeRun } }).fileAdapter().attached!;
    assert.deepEqual(run.terminated, ['SIGTERM']);
    run.emit('final', { cursor: { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 0 }, records: [], evidence: { ...run.evidence, terminal: 'error' }, exit: { code: 143, signal: null, recorded: true } });
    const done = h.store.get(task.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.failure?.kind, 'rate_limit');
    assert.equal(done.run?.finalizedAt !== undefined, true);
    await manager2.shutdown();
  } finally { await h.close(); }
});

test('a present scope without an invocation and without FD evidence stays recovery-pending and is not killed', async () => {
  const h = harness();
  try {
    const task = persisted(h.store);
    let kills = 0;
    let inspections = 0;
    const manager2 = new TaskManager(h.store, adapter(), () => {}, undefined, error => { throw error; });
    const report = await reattach(manager2, {
      ...quiet,
      inspectScope: async () => { inspections++; return { state: 'present', active: 'active', invocation: 'f'.repeat(32) }; },
      findFdEvidence: async () => undefined,
      killOwnedScope: async () => { kills++; return { ok: true }; },
      retryMs: 60_000,
    });
    assert.equal(report.counts.pending, 1);
    assert.ok(report.pending.includes(task.id));
    assert.equal(h.store.get(task.id).run?.recovery?.state, 'pending');
    assert.equal(h.store.get(task.id).status, 'running');
    assert.equal(kills, 0);
    assert.ok(inspections >= 1);
    await manager2.shutdown();
  } finally { await h.close(); }
});

test('proven attribution with truncated logs kills the scope before finalizing failed with logTruncated', async () => {
  const h = harness();
  try {
    const task = persisted(h.store, { invocation: '1'.repeat(32) });
    const operations: string[] = [];
    const manager2 = new TaskManager(h.store, adapter(), () => {}, undefined, error => { throw error; });
    const report = await reattach(manager2, {
      ...quiet,
      inspectScope: async () => { operations.push('inspect'); return { state: 'present', active: 'active', invocation: '1'.repeat(32) }; },
      checkLogIdentity: () => { operations.push('check'); return { ok: false, reason: 'truncated', detail: 'stdout: size 1 < offset 2' }; },
      killOwnedScope: async (_unit, _invocation, signal) => { operations.push(`kill:${signal}`); return { ok: true }; },
      confirmScopeAbsent: async () => { operations.push('absent'); return true; },
      statSize: () => 0,
    });
    assert.equal(report.counts.failed, 1);
    const done = h.store.get(task.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.run?.logTruncated, true);
    assert.ok(done.run?.finalizedAt);
    assert.equal(operations.includes('kill:SIGTERM'), true);
    assert.ok(operations.indexOf('kill:SIGTERM') < operations.lastIndexOf('absent'), 'kill precedes the disappearance check');
    await manager2.shutdown();
  } finally { await h.close(); }
});

test('a preparing run with no launch permission returns to queued and scheduled without touching a scope', async () => {
  const h = harness();
  try {
    const task = h.manager.create(input);
    task.status = 'running';
    task.run = { id: randomUUID(), adapter: 'opencode', execution: 'real', status: 'running', engine: 'opencode', model: 'opencode/test', effort: 'max', startedAt: new Date().toISOString() };
    h.store.put(task);
    let inspections = 0;
    const report = await reattach(h.manager, { ...quiet, inspectScope: async () => { inspections++; return { state: 'absent' }; } });
    const queued = h.store.get(task.id);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.scheduled, true);
    assert.equal(queued.run, undefined);
    assert.equal(report.counts.requeued, 1);
    assert.equal(inspections, 0);
  } finally { await h.close(); }
});

test('a permitted run with no logs and a confirmed-absent scope fails as unknown_outcome instead of requeueing', async () => {
  const h = harness();
  try {
    const task = persisted(h.store);
    h.store.transaction(() => {
      const current = h.store.get(task.id);
      delete current.run!.logs;
      delete current.run!.logIdentity;
      delete current.run!.nonce;
      delete current.run!.stateDir;
      h.store.put(current);
    });
    const manager2 = new TaskManager(h.store, adapter(), () => {}, undefined, error => { throw error; });
    const report = await reattach(manager2, {
      ...quiet,
      inspectScope: async () => ({ state: 'absent' }),
      confirmScopeAbsent: async () => true,
    });
    const done = h.store.get(task.id);
    assert.equal(report.counts.requeued, 0);
    assert.equal(done.status, 'failed');
    assert.equal(done.failure?.kind, 'unknown_outcome');
    assert.ok(done.run?.finalizedAt);
    await manager2.shutdown();
  } finally { await h.close(); }
});

test('no_output waits for backlog output across a restart and does not kill an output-producing worker', async () => {
  const h = harness();
  try {
    const task = persisted(h.store, { invocation: '2'.repeat(32), run: { noOutputDeadline: new Date(Date.now() - 60_000).toISOString() } });
    const onAttach = (run: FakeRun): void => {
      setTimeout(() => {
        run.emit('batch', { cursor: { stdoutOffset: 100, stderrOffset: 0, appliedRecords: 1 }, records: [{ type: 'log', message: 'backlog output' }], firstOutput: true });
      }, 20);
    };
    const manager2 = new TaskManager(h.store, adapter({ onAttach }), () => {}, undefined, error => { throw error; });
    await reattach(manager2, {
      ...quiet,
      inspectScope: async () => ({ state: 'present', active: 'active', invocation: '2'.repeat(32) }),
      checkLogIdentity: () => ({ ok: true }),
      statSize: () => 100,
      backlogWaitMs: 500,
    });
    await waitFor(() => (h.store.get(task.id).run?.replay?.stdoutOffset ?? 0) >= 100);
    assert.equal(h.store.get(task.id).run?.firstOutputAt !== undefined, true);
    assert.ok(h.store.get(task.id).events.some(value => value.message.includes('firstOutputAt approximated at reattach')));
    assert.equal(h.store.get(task.id).status, 'running');
    assert.equal(h.store.get(task.id).failure, undefined);
    await manager2.shutdown();
  } finally { await h.close(); }
});

test('no_output fails after backlog is drained with no output and the absolute deadline expired', async () => {
  const h = harness();
  try {
    const task = persisted(h.store, { invocation: '3'.repeat(32), run: { noOutputDeadline: new Date(Date.now() - 60_000).toISOString() } });
    const manager2 = new TaskManager(h.store, adapter(), () => {}, undefined, error => { throw error; });
    await reattach(manager2, {
      ...quiet,
      inspectScope: async () => ({ state: 'present', active: 'active', invocation: '3'.repeat(32) }),
      checkLogIdentity: () => ({ ok: true }),
      statSize: () => 0,
      backlogWaitMs: 30,
    });
    await waitFor(() => h.store.get(task.id).status === 'failed');
    assert.equal(h.store.get(task.id).failure?.kind, 'no_output');
    await manager2.shutdown();
  } finally { await h.close(); }
});

test('a committed vendor retryAt is not recomputed from replayed diagnostics', async () => {
  const h = harness();
  try {
    const original = '2030-01-01T00:00:00.000Z';
    const task = persisted(h.store, { status: 'failed', invocation: '4'.repeat(32), failure: { kind: 'rate_limit', message: 'limited', retryAt: original }, run: { retryAt: original, killAfter: new Date(Date.now() + 60_000).toISOString(), terminationPhase: 'term' } });
    const manager2 = new TaskManager(h.store, adapter(), () => {}, undefined, error => { throw error; });
    await reattach(manager2, {
      ...quiet,
      inspectScope: async () => ({ state: 'present', active: 'active', invocation: '4'.repeat(32) }),
      checkLogIdentity: () => ({ ok: true }),
      statSize: () => 0,
      backlogWaitMs: 10,
    });
    const run = (manager2 as unknown as { fileAdapter(): { attached?: FakeRun } }).fileAdapter().attached!;
    run.emit('batch', { cursor: { stdoutOffset: 10, stderrOffset: 0, appliedRecords: 1 }, records: [], vendorError: 'quota again', failure: { kind: 'quota', message: 'quota', retryAt: '2031-01-01T00:00:00.000Z' } });
    assert.equal(h.store.get(task.id).failure?.retryAt, original);
    assert.equal(h.store.get(task.id).run?.retryAt, original);
    await manager2.shutdown();
  } finally { await h.close(); }
});

test('after detach no late callback writes or launches a new worker, and the gate stays closed', async () => {
  const h = harness();
  try {
    const task = startReal(h.manager);
    const run = (h.manager as unknown as { fileAdapter(): { started?: FakeRun } }).fileAdapter().started!;
    await h.manager.shutdown();
    assert.equal(run.detached, true);
    const before = h.store.get(task.id);
    run.emit('batch', { cursor: { stdoutOffset: 100, stderrOffset: 0, appliedRecords: 9 }, records: [{ type: 'log', message: 'late' }] });
    run.emit('final', { cursor: { stdoutOffset: 100, stderrOffset: 0, appliedRecords: 9 }, records: [{ type: 'result', summary: 'late' }], evidence: { ...run.evidence, terminal: 'success' }, exit: { code: 0, signal: null, recorded: true } });
    run.emit('error', new Error('late error'));
    const after = h.store.get(task.id);
    assert.equal(after.status, before.status);
    assert.equal(after.events.length, before.events.length);
    assert.equal(after.run?.finalizedAt, undefined);
    assert.equal(h.manager.launchGateOpen, false);
    assert.throws(() => h.manager.start(task.id), /shutting down/);
  } finally { await h.close(); }
});

test('a final with no exit record and no intent fails as unknown_outcome, not cancelled', async () => {
  const h = harness();
  try {
    const task = persisted(h.store, { invocation: '5'.repeat(32) });
    const manager2 = new TaskManager(h.store, adapter(), () => {}, undefined, error => { throw error; });
    await reattach(manager2, {
      ...quiet,
      inspectScope: async () => ({ state: 'present', active: 'active', invocation: '5'.repeat(32) }),
      checkLogIdentity: () => ({ ok: true }),
      statSize: () => 0,
      backlogWaitMs: 10,
    });
    const run = (manager2 as unknown as { fileAdapter(): { attached?: FakeRun } }).fileAdapter().attached!;
    run.emit('final', { cursor: { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 0 }, records: [], evidence: { ...run.evidence, terminal: 'missing' }, exit: { code: null, signal: null, recorded: false } });
    const done = h.store.get(task.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.failure?.kind, 'unknown_outcome');
    assert.match(done.failure?.message ?? '', /unknown|without an exit record/i);
    await manager2.shutdown();
  } finally { await h.close(); }
});

test('mock, native and historical real recovery semantics stay unchanged', async () => {
  const h = harness();
  try {
    const nativeTask = h.manager.create(input);
    nativeTask.dispatch = { owner: 'owner', worker: 'w', engine: 'opencode', model: 'm', effort: 'high', execution: 'native', maxParallel: 1 };
    h.manager.store.put(nativeTask);
    h.manager.start(nativeTask.id);
    assert.equal(h.store.get(nativeTask.id).status, 'running');

    const legacy = h.manager.create(input);
    legacy.status = 'running';
    legacy.run = { id: randomUUID(), adapter: 'opencode', execution: 'real', status: 'running', pid: 1234, startedAt: new Date().toISOString(), scopeUnit: 'weaver-cli-opencode-legacy' };
    h.store.put(legacy);
    const report = await reattach(h.manager, quiet);
    assert.equal(h.store.get(nativeTask.id).status, 'running');
    const recovered = h.store.get(legacy.id);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.run?.pid, undefined);
    assert.ok(recovered.events.some(value => /Interrupted by app exit/.test(value.message)));
    assert.ok(report.interrupted.includes(legacy.id));
  } finally { await h.close(); }
});
