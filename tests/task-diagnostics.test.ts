import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/main/store';
import { TaskManager } from '../src/main/manager';
import { MockWorkerAdapter } from '../src/main/adapters/worker';
import { CommandHandler, type TaskDiagnostics } from '../src/main/commands';
import { PolicyStore } from '../src/main/policy/store';
import { OwnerLaunchError, type OwnerLaunchInput, type OwnerLaunchResult } from '../src/main/owner-host';
import { readStall, stallStoreAt } from './helpers/state-db';
import { STALL_BLOCK_BY, STALL_MS, StallMonitor, parseStallState, type StallState, type StallStatus } from '../src/main/stall';

/** A fixed clock and a CPU reader that can only ever say "not observed": nothing here is a real process. */
const NOW = 1_760_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const owner = { name: 'demo', transport: 'herdr-visible' as const, session: 'reference', pane: 'reference' };
const blockedLaunch = (input: OwnerLaunchInput): OwnerLaunchResult => { throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `Test did not inject an owner launcher for ${input.taskId}`); };
/** The seven numbers an owner acts on, without the retained record. */
const summaryOf = (item: StallStatus['engines'][string]) => ({ level: item.level, lastTriggerAt: item.lastTriggerAt, needsAttention: item.needsAttention, blocked: item.blocked, blockedUntil: item.blockedUntil, nextProbeAt: item.nextProbeAt, probeSuccesses: item.probeSuccesses });
/** A penalty as the monitor itself would have left it: armed, waiting, and written into its own record. */
const armed = (level: number, probeSuccesses: number): StallState['engines'][string] => ({
  level, lastTriggerAt: NOW - 60_000, needsAttention: level === 3, blockedUntil: level === 3 ? null : NOW + 300_000,
  nextProbeAt: NOW + 300_000, probeSuccesses, head: `${level} 个子 Agent 超过 5 分钟无响应`,
});

interface SetupOptions { penalties?: StallState['engines']; monitor?: boolean }
function setup(options: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-diag-'));
  const store = new TaskStore(join(dir,'weaver.db'));
  const manager = new TaskManager(store, new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs')));
  const policy = new PolicyStore(join(dir,'weaver.db'));
  const statePath = join(dir, 'state.db');
  const history = options.penalties ? Object.entries(options.penalties).flatMap(([engine]) => [
    { engine, level: 1, at: NOW - 12 * 60_000, tasks: ['aaaa1111', 'bbbb2222'], stalledMinutes: 6 },
    { engine, level: 3, at: NOW - 60_000, tasks: ['aaaa1111'], taskCount: 2, probe: { ok: false, ms: 4_213, error: 'upstream refused' } },
  ]) : [];
  if (options.penalties) stallStoreAt(statePath).save({ engines: options.penalties, history });
  const monitor = new StallMonitor({
    tasks: () => store.list(), policy: () => policy, stateStore: stallStoreAt(statePath), now: () => NOW, ready: () => true,
    cpu: async () => null, probe: async () => ({ ok: false, ms: 0 }), log: () => {},
  });
  const calls = { health: 0, unblock: [] as string[] };
  const diagnostics: TaskDiagnostics = {
    taskHealth: task => { calls.health++; return monitor.taskHealth(task); },
    status: () => monitor.status(),
    unblock: engine => { calls.unblock.push(engine); monitor.unblock(engine); },
  };
  // The stall block each penalty was armed with, so the policy is the same authority the runtime uses.
  if (options.penalties) {
    const snapshot = policy.snapshot();
    policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: Object.keys(options.penalties).map(engine => ({ engine, reason: `惩罚性暂停 ${engine}`, since: iso(NOW - 60_000), by: STALL_BLOCK_BY })) });
  }
  const handler = new CommandHandler(manager, policy, blockedLaunch, () => false, options.monitor === false ? undefined : diagnostics);
  const raw = (command: string, args: Record<string, unknown> = {}, commandId: string = randomUUID()) => handler.handle({ apiVersion: 'weaver.v1', commandId, command, args });
  const call = (command: string, args: Record<string, unknown> = {}, commandId?: string): any => { const r = raw(command, args, commandId); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  /** A real attempt the monitor can judge: running, on an engine, silent for longer than the stall window. */
  const silentRealRun = () => {
    const created = raw('tasks.create', { title: 'Silent', instruction: 'fixture', owner, workspace: dir }).data as { id: string };
    const task = store.get(created.id);
    task.status = 'running';
    task.dispatch = { owner: 'codex_owner', worker: 'codex_worker', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', execution: 'real', maxParallel: 4, adapter: 'codex', workspace: dir };
    task.events = [{ id: randomUUID(), at: iso(NOW - STALL_MS - 60_000), kind: 'lifecycle', message: 'Real worker launched' }];
    task.run = { id: randomUUID(), adapter: 'codex', execution: 'real', status: 'running', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', workspace: dir, startedAt: iso(NOW - STALL_MS - 60_000), scopeUnit: `weaver-cli-codex-${created.id.slice(0, 8)}` };
    store.put(task);
    return store.get(created.id);
  };
  return { dir, store, manager, policy, monitor, handler, raw, call, calls, silentRealRun, close: async () => { handler.draining = true; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('tasks.health is the monitor\'s own reading of the stored task, and unobserved CPU stays unobserved', async () => {
  const f = setup();
  try {
    const task = f.silentRealRun();
    const health = f.call('tasks.health', { taskId: task.id });
    // The same class of answer the monitor gives, from the monitor, for the same stored Task.
    assert.deepEqual(health, f.monitor.taskHealth(f.store.get(task.id)));
    assert.equal(f.calls.health, 1, 'the command asks the monitor once instead of classifying again');
    assert.equal(health.taskId, task.id);
    assert.equal(health.engine, 'codex');
    assert.equal(health.taskStatus, 'running');
    assert.equal(health.scopeUnit, task.run?.scopeUnit);
    assert.equal(health.silenceMs, STALL_MS + 60_000);
    assert.equal(health.state, 'starting');
    const output=f.store.get(task.id);output.run!.firstOutputAt=output.run!.startedAt;f.store.put(output);
    assert.equal(f.monitor.taskHealth(output).state,'waiting_model');
    // Nothing sampled yet: null is the honest answer, not a fabricated idle or busy reading.
    assert.equal(health.cpuActive, null);
    assert.equal(health.cpuIdleMs, null);
    // The health follows the stored task, because the monitor reads the task it is handed.
    const moved = f.store.get(task.id);
    moved.dispatch = { ...moved.dispatch!, engine: 'claude', worker: 'claude_worker' };
    f.store.put(moved);
    assert.equal(f.call('tasks.health', { taskId: task.id }).engine, 'claude');
    // Two ticks of samples that can only say "could not read" still never become a measured idle.
    await f.monitor.tick();
    f.calls.health = 0;
    assert.equal(f.call('tasks.health', { taskId: task.id }).cpuActive, null);
    assert.equal(f.calls.health, 1);
    assert.equal(f.call('tasks.health', { taskId: task.id }).cpuIdleMs, null);
  } finally { await f.close(); }
});

test('tasks.health fails closed on a missing or malformed task instead of guessing', async () => {
  const f = setup();
  try {
    assert.equal(f.raw('tasks.health', { taskId: randomUUID() }).error?.code, 'NOT_FOUND');
    assert.equal(f.raw('tasks.health', { taskId: 'not-a-uuid' }).error?.code, 'NOT_FOUND');
    assert.equal(f.raw('tasks.health', { taskId: 42 }).error?.code, 'NOT_FOUND');
    // A task the monitor cannot be silent about is still the monitor\'s answer, not a refusal.
    const created = f.raw('tasks.create', { title: 'Queued', instruction: 'fixture', owner }).data as { id: string };
    assert.equal(f.call('tasks.health', { taskId: created.id }).silenceMs, null);
  } finally { await f.close(); }
});

test('engines.health gives the armed summary for every engine and keeps the history out', async () => {
  const f = setup({ penalties: { codex: armed(3, 2), claude: armed(1, 0) } });
  try {
    const status = f.monitor.status();
    const health = f.call('engines.health');
    assert.deepEqual(health.config, status.config);
    // Every configured engine is reported, penalized or not.
    for (const engine of Object.keys(f.policy.snapshot().config.engines)) {
      const entry = health.engines[engine];
      assert.ok(entry, engine);
      assert.deepEqual(Object.keys(entry).sort(), ['blocked', 'blockedUntil', 'lastTriggerAt', 'level', 'needsAttention', 'nextProbeAt', 'probeSuccesses'].sort());
      assert.equal(Object.hasOwn(entry, 'history'), false, `${engine}: the retained record belongs to engines penalty`);
    }
    const codex = health.engines.codex;
    assert.equal(codex.level, 3);
    assert.equal(codex.blocked, true);
    assert.equal(codex.needsAttention, true);
    assert.equal(codex.probeSuccesses, 2);
    assert.equal(codex.blockedUntil, null);
    assert.equal(codex.nextProbeAt, iso(NOW + 300_000));
    assert.equal(health.engines.claude.level, 1);
    assert.equal(health.engines.grok.level, 0, 'an engine that was never penalized is still reported');
  } finally { await f.close(); }
});

test('engines.penalty returns the exact retained history for one engine only', async () => {
  const f = setup({ penalties: { codex: armed(3, 2), claude: armed(1, 0) } });
  try {
    const penalty = f.call('engines.penalty', { engine: 'codex' });
    assert.deepEqual(penalty, { engine: 'codex', ...f.monitor.status().engines.codex, vendorLimit: null });
    assert.equal(penalty.history.length, 2);
    assert.deepEqual(penalty.history.map(item => item.level), [1, 3]);
    assert.equal(penalty.history[1].taskCount, 2);
    assert.equal(penalty.history[1].probe!.ok, false);
    assert.equal(penalty.history[1].at, iso(NOW - 60_000));
    assert.equal(f.call('engines.penalty', { engine: 'claude' }).history.length, 2);
    // An engine with no record of its own is refused before anything else is read.
    assert.equal(f.raw('engines.penalty', { engine: 'nope' }).error?.code, 'NOT_FOUND');
    assert.equal(f.raw('engines.penalty', { engine: 'codex codex' }).error?.code, 'NOT_FOUND');
    assert.equal(f.raw('engines.penalty', { engine: 42 }).error?.code, 'INVALID_REQUEST');
    assert.equal(f.raw('engines.penalty', {}).error?.code, 'INVALID_REQUEST');
  } finally { await f.close(); }
});

test('engines.penalty rejects inherited names while preserving configured and historical own records without writes', async () => {
  const f = setup({ penalties: { codex: armed(3, 2) } });
  let monitor: StallMonitor | undefined;
  try {
    f.silentRealRun();
    const statePath = join(f.dir, 'state.db');
    const state = readStall(statePath);
    state.engines['retired-fixture'] = armed(1, 0);
    state.history.push({ engine: 'retired-fixture', level: 1, at: NOW - 60_000, tasks: ['retained-task'] });
    stallStoreAt(statePath).save(state);
    monitor = new StallMonitor({ tasks: () => f.store.list(), policy: () => f.policy, stateStore: stallStoreAt(statePath), now: () => NOW, cpu: async () => null, log: () => {} });
    const handler = new CommandHandler(f.manager, f.policy, blockedLaunch, () => false, monitor);
    const before = { tasks: f.store.list(), metadata: f.store.getMetadata(), policy: f.policy.snapshot(), state: JSON.stringify(readStall(statePath)) };
    const status = monitor.status();
    assert.equal(Object.hasOwn(before.policy.config.engines, 'retired-fixture'), false);
    for (const engine of ['toString', 'constructor', '__proto__', 'missing-fixture']) {
      const response = handler.handle({ apiVersion: 'weaver.v1', command: 'engines.penalty', args: { engine } });
      assert.equal(response.ok, false, engine);
      assert.equal(response.error?.code, 'NOT_FOUND', engine);
      assert.equal(response.data, undefined, engine);
    }
    for (const engine of ['codex', 'retired-fixture']) {
      const response = handler.handle({ apiVersion: 'weaver.v1', command: 'engines.penalty', args: { engine } });
      assert.equal(response.ok, true, engine);
      assert.deepEqual(response.data, { engine, ...status.engines[engine], vendorLimit: null });
    }
    assert.deepEqual({ tasks: f.store.list(), metadata: f.store.getMetadata(), policy: f.policy.snapshot(), state: JSON.stringify(readStall(statePath)) }, before);
    assert.deepEqual(monitor.status(), status);
  } finally { await monitor?.stop(); await f.close(); }
});

test('engines.unblock resets one ladder, keeps its record and every other engine, and replays its receipt', async () => {
  const f = setup({ penalties: { codex: armed(3, 2), claude: armed(1, 0) } });
  try {
    const before = f.monitor.status();
    const commandId = randomUUID();
    const result = f.call('engines.unblock', { engine: 'codex' }, commandId);
    assert.deepEqual(f.calls.unblock, ['codex']);
    assert.equal(result.engine, 'codex');
    assert.equal(result.wasBlocked, true);
    assert.deepEqual(result.cleared, { level: 0, lastTriggerAt: null, needsAttention: false, blocked: false, blockedUntil: null, nextProbeAt: null, probeSuccesses: 0 });
    // The penalty is gone; what it did is not.
    assert.deepEqual(result.retainedHistory, before.engines.codex.history);
    assert.equal(result.retainedHistory.length, 2);
    // The other engine keeps its armed level and its block.
    assert.deepEqual(result.otherEngines.claude, summaryOf(before.engines.claude));
    assert.equal(result.otherEngines.claude.level, 1);
    assert.equal(result.otherEngines.claude.blocked, true);
    // Only the unblocked engine left the policy; the other stall block stays.
    const blocks = f.policy.snapshot().blocks.map(block => block.engine);
    assert.deepEqual(blocks, ['claude']);
    const persisted = readStall(join(f.dir, 'state.db'));
    assert.equal(persisted.engines.codex.level, 0);
    assert.equal(persisted.engines.claude.level, 1);
    assert.equal(persisted.history.length, 4, 'the record of both engines is retained');
    // The same command ID with the same arguments replays the receipt and resets nothing again.
    assert.deepEqual(f.call('engines.unblock', { engine: 'codex' }, commandId), result);
    assert.deepEqual(f.calls.unblock, ['codex'], 'a replayed receipt does not call the monitor a second time');
    assert.equal(f.raw('engines.unblock', { engine: 'claude' }, commandId).error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(f.calls.unblock, ['codex']);
    // An unknown engine is refused before the monitor is asked or any policy write happens.
    const stateBefore = JSON.stringify(readStall(join(f.dir, 'state.db')));
    const revision = f.policy.snapshot().revision;
    assert.equal(f.raw('engines.unblock', { engine: 'nope' }).error?.code, 'NOT_FOUND');
    assert.deepEqual(f.calls.unblock, ['codex']);
    assert.equal(f.policy.snapshot().revision, revision);
    assert.equal(JSON.stringify(readStall(join(f.dir, 'state.db'))), stateBefore);
  } finally { await f.close(); }
});

test('a process without a stall monitor refuses to invent health, penalties or a reset', async () => {
  const f = setup({ penalties: { codex: armed(3, 2) }, monitor: false });
  try {
    const task = f.silentRealRun();
    for (const [command, args] of [['tasks.health', { taskId: task.id }], ['engines.health', {}], ['engines.penalty', { engine: 'codex' }], ['engines.unblock', { engine: 'codex' }]] as [string, Record<string, unknown>][]) {
      const refused = f.raw(command, args);
      assert.equal(refused.error?.code, 'CAPABILITY_UNAVAILABLE', command);
      assert.match(refused.error?.message ?? '', /monitor/i, command);
    }
    // Refusing is not the same as deciding: the penalty the monitor holds is untouched.
    assert.equal(f.policy.snapshot().blocks.length, 1);
    assert.equal(f.store.get(task.id).status, 'running');
  } finally { await f.close(); }
});

test('diagnostics commands are catalogued as reads and one write, and the write needs a command ID', async () => {
  const f = setup({ penalties: { codex: armed(3, 2) } });
  try {
    const caps = f.call('capabilities.get');
    for (const command of ['tasks.health', 'engines.health', 'engines.penalty', 'engines.unblock']) assert.ok(caps.commands.includes(command), command);
    // Reads need no receipt; the reset is a mutation and cannot be issued without one.
    assert.equal(f.handler.handle({ apiVersion: 'weaver.v1', command: 'engines.health', args: {} }).ok, true);
    const unblock = f.handler.handle({ apiVersion: 'weaver.v1', command: 'engines.unblock', args: { engine: 'codex' } });
    assert.equal(unblock.error?.code, 'INVALID_REQUEST');
    assert.deepEqual(f.calls.unblock, []);
  } finally { await f.close(); }
});

test('the owner root never counts as a stall: the health names the owner host and its children', async () => {
  const f = setup();
  try {
    const created = f.raw('tasks.create', { title: 'Owner root', instruction: 'dispatch sub-agents', owner, workspace: f.dir }).data as { id: string };
    const root = f.store.get(created.id);
    root.executionRole = 'owner';
    root.status = 'running';
    root.ownerLastActivityAt = iso(NOW - 120_000);
    f.store.put(root);
    const makeChild = (title: string, status: 'running' | 'completed') => {
      const child = f.raw('tasks.create', { title, instruction: 'child fixture', owner, workspace: f.dir }).data as { id: string };
      const stored = f.store.get(child.id);
      stored.parentTaskId = root.id;
      delete stored.executionRole;
      stored.status = status;
      if (status === 'running') stored.dispatch = { owner: 'codex_owner', worker: 'codex_worker', engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', execution: 'real', maxParallel: 4, adapter: 'codex', workspace: f.dir };
      f.store.put(stored);
      return f.store.get(child.id);
    };
    makeChild('first child', 'running');
    makeChild('second child', 'completed');
    const health = f.call('tasks.health', { taskId: root.id });
    assert.deepEqual(health, f.monitor.taskHealth(f.store.get(root.id)), 'the command hands back the monitor reading');
    assert.equal(health.state, 'owner_starting', 'no owner host yet');
    assert.equal(health.engine, null, 'an owner root has no engine of its own');
    assert.equal(health.silenceMs, null);
    assert.equal(health.cpuActive, null);
    assert.equal(health.cpuIdleMs, null);
    assert.equal(health.scopeUnit, null);
    assert.deepEqual(health.children, { total: 2, running: 1, completed: 1 });
    assert.equal(health.lastEventAt, iso(NOW - 120_000));
    // With the owner host live the answer changes without inventing CPU numbers.
    root.ownerHost = { kind: 'herdr', session: 's1', workspaceId: 'w1', paneId: 'p1', agentName: 'owner', launchedAt: iso(NOW - 60_000) };
    f.store.put(root);
    assert.equal(f.monitor.taskHealth(f.store.get(root.id)).state, 'owner_running');
    // Ended roots stay ended even when children keep running.
    root.status = 'completed';
    f.store.put(root);
    assert.equal(f.monitor.taskHealth(f.store.get(root.id)).state, 'ended');
  } finally { await f.close(); }
});
