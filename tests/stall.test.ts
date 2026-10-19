import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultConfig } from '../src/main/policy/routing';
import { PolicyStore } from '../src/main/policy/store';
import { parseRpcBody } from '../src/main/rpc';
import {
  CPU_IDLE_SHARE, LADDER_RESET_MS, STALL_BLOCK_BY, STALL_LADDER, STALL_MS, STALL_QUORUM, StallMonitor,
  idleSince, isStalled, nextPenalty, silenceMs, stalledTasks, systemdCpuUsage, unhealthyEngines,
  type CpuReader, type CpuSample, type StallPolicy, type StallState,
} from '../src/main/stall';
import type { Task } from '../src/shared/types';

const START = Date.parse('2030-01-01T00:00:00Z');
const MINUTE = 60_000;
/** ns of CPU that one fully busy core burns in a minute. */
const CORE_MINUTE = MINUTE * 1_000_000;

function makeTask(options: { engine?: string; scope?: string; silentMs?: number; status?: Task['status']; execution?: 'real' | 'mock' | 'native' } = {}): Task {
  const id = randomUUID();
  const engine = options.engine ?? 'claude';
  const execution = options.execution ?? 'real';
  const at = new Date(START - (options.silentMs ?? 0)).toISOString();
  return {
    id, title: 'package', instruction: 'work',
    owner: { name: 'owner', transport: 'herdr-visible', session: 's', pane: 'p' },
    createdAt: at, updatedAt: at, status: options.status ?? 'running', progress: 0,
    events: [{ id: randomUUID(), at, kind: 'lifecycle', message: 'started' }],
    artifacts: [],
    dispatch: { owner: `${engine}_owner`, worker: `${engine}_worker`, engine, model: 'm', effort: 'high', execution, maxParallel: 2 },
    run: { id: randomUUID(), adapter: engine, execution, status: 'running', startedAt: at, ...(execution === 'real' ? { scopeUnit: options.scope ?? `weaver-cli-${engine}-${id.slice(0, 8)}` } : {}) },
  };
}

const report = (task: Task, at: number) => task.events.push({ id: randomUUID(), at: new Date(at).toISOString(), kind: 'log', message: 'still working' });

/** Cumulative scope CPU in ns, one step per call. */
function cpu(options: { busy?: boolean; unreadable?: boolean } = {}): { reader: CpuReader; reads: string[] } {
  const totals = new Map<string, number>();
  const reads: string[] = [];
  const reader: CpuReader = async unit => {
    reads.push(unit);
    if (options.unreadable) return null;
    const next = (totals.get(unit) ?? 0) + (options.busy ? CORE_MINUTE / 2 : 0);
    totals.set(unit, next);
    return next;
  };
  return { reader, reads };
}

const series = (count: number, step = MINUTE, cpuPerStep = 0, startAt = START): CpuSample[] =>
  Array.from({ length: count }, (_, index) => ({ at: startAt + index * step, cpu: index * cpuPerStep }));

const samplesOf = (task: Task, list: CpuSample[]) => ({ [task.id]: list });

test('silence is measured from the last event, and from the run start when there is none', () => {
  const task = makeTask({ silentMs: 4 * MINUTE });
  assert.equal(silenceMs(task, START), 4 * MINUTE);
  assert.equal(silenceMs({ ...task, events: [] }, START), 4 * MINUTE, 'falls back to run.startedAt');
  assert.equal(silenceMs({ ...task, events: [], run: { ...task.run!, startedAt: undefined } }, START), null);
});

test('only a running real task can stall', () => {
  const base = makeTask({ silentMs: 30 * MINUTE });
  const busy = series(12);
  assert.equal(isStalled(base, START, samplesOf(base, busy)), true);
  const variants: Task[] = [
    { ...base, status: 'queued' },
    { ...base, status: 'completed' },
    { ...base, status: 'cancelling' },
    { ...base, dispatch: { ...base.dispatch!, execution: 'mock' }, run: { ...base.run!, execution: 'mock' } },
    { ...base, dispatch: { ...base.dispatch!, execution: 'native' }, run: { ...base.run!, execution: 'native' } },
    { ...base, run: { ...base.run!, scopeUnit: undefined } },
  ];
  for (const variant of variants) assert.equal(isStalled(variant, START, samplesOf(base, busy)), false, JSON.stringify(variant.status) + String(variant.dispatch?.execution));
  assert.equal(silenceMs(variants[0]!, START), null);
});

test('five minutes of idle intervals is the stall boundary', () => {
  const task = makeTask({ silentMs: 20 * MINUTE });
  // Six samples five minutes apart cover exactly the required idle window.
  assert.equal(isStalled(task, START + 5 * MINUTE, samplesOf(task, series(6))), true);
  assert.equal(stalledTasks([task], START + 5 * MINUTE, samplesOf(task, series(6))).length, 1);
  // One millisecond short of five minutes of intervals is not enough, however long the silence is.
  assert.equal(isStalled(task, START + 5 * MINUTE, samplesOf(task, series(6, MINUTE - 1))), false);
  assert.equal(isStalled(task, START + 5 * MINUTE, samplesOf(task, series(5))), false);
  assert.equal(isStalled(task, START + 5 * MINUTE, samplesOf(task, series(1))), false);
  assert.equal(stalledTasks([task], START + 5 * MINUTE).length, 0, 'a monitor without samples yet judges nothing');
  // The silence itself must reach five minutes too.
  const quiet = makeTask({ silentMs: 4 * MINUTE });
  assert.equal(isStalled(quiet, START, samplesOf(quiet, series(12, MINUTE, 0, START - 12 * MINUTE))), false);
  assert.equal(isStalled(quiet, START + MINUTE, samplesOf(quiet, series(13, MINUTE, 0, START - 12 * MINUTE))), true);
});

test('a busy scope never stalls, however long it stays silent', () => {
  const task = makeTask({ silentMs: 120 * MINUTE });
  const now = START + 120 * MINUTE;
  // Half a core: a long type-check, test run or build.
  assert.equal(isStalled(task, now, samplesOf(task, series(121, MINUTE, CORE_MINUTE / 2))), false);
  // Just under the idle share still counts as idle.
  assert.equal(isStalled(task, now, samplesOf(task, series(121, MINUTE, CPU_IDLE_SHARE * CORE_MINUTE * 0.99))), true);
  // Exactly the share is busy.
  assert.equal(isStalled(task, now, samplesOf(task, series(121, MINUTE, CPU_IDLE_SHARE * CORE_MINUTE))), false);
});

test('idleSince reports the newest idle run and stops at the first busy or unreadable interval', () => {
  assert.equal(idleSince(undefined), null);
  assert.equal(idleSince([]), null);
  assert.equal(idleSince(series(1)), null);
  assert.equal(idleSince(series(8)), START);
  // A busy interval five minutes ago: only the tail after it can be idle.
  const interrupted = series(8).map((sample, index) => index === 5 ? { ...sample, cpu: 50 * CORE_MINUTE } : sample);
  assert.equal(idleSince(interrupted), START + 6 * MINUTE);
  // Busy in the middle, quiet afterwards.
  const woke = series(8).map((sample, index) => index < 4 ? sample : { at: sample.at, cpu: 100 * CORE_MINUTE + index });
  assert.equal(idleSince(woke), START + 4 * MINUTE);
  assert.equal(isStalled(makeTask({ silentMs: 20 * MINUTE }), START + 8 * MINUTE, samplesOf(makeTask({ silentMs: 20 * MINUTE }), woke)), false);
  // An unreadable newest sample proves nothing, and so does a counter that went backwards.
  assert.equal(idleSince(series(8).map((sample, index) => index === 7 ? { ...sample, cpu: null } : sample)), START + 7 * MINUTE);
  assert.equal(idleSince([{ at: START, cpu: 10 }, { at: START + MINUTE, cpu: 5 }]), START + MINUTE);
  assert.equal(idleSince([{ at: START, cpu: 10 }, { at: START, cpu: 10 }]), START);
});

test('unreadable CPU is never counted as evidence of a stall', () => {
  const task = makeTask({ silentMs: 30 * MINUTE });
  const withNull = (index: number) => series(31).map((sample, position) => position === index ? { ...sample, cpu: null } : sample);
  // Nothing was ever read: the scope cannot be judged at all.
  assert.equal(isStalled(task, START, samplesOf(task, series(30).map(sample => ({ ...sample, cpu: null })))), false);
  // The newest sample unreadable leaves an idle run without a single interval.
  assert.equal(isStalled(task, START + 30 * MINUTE, samplesOf(task, withNull(30))), false);
  // A failure only restarts the counting; three proven idle minutes are still not five.
  assert.equal(isStalled(task, START + 30 * MINUTE, samplesOf(task, withNull(27))), false);
  assert.equal(isStalled(task, START + 30 * MINUTE, samplesOf(task, withNull(20))), true);
  // No samples at all, and a scope that vanished, are not stalls either.
  assert.equal(isStalled(task, START + 30 * MINUTE, {}), false);
  const orphan = makeTask({ silentMs: 30 * MINUTE });
  delete (orphan.run as { scopeUnit?: string }).scopeUnit;
  assert.equal(isStalled(orphan, START + 30 * MINUTE, samplesOf(orphan, series(30))), false);
  assert.deepEqual(stalledTasks([orphan], START + 30 * MINUTE, samplesOf(orphan, series(30))), []);
});

test('an engine is unhealthy only at the quorum, and per engine', () => {
  const idle = series(8);
  const claude = [makeTask({ silentMs: 8 * MINUTE, scope: 'a' }), makeTask({ silentMs: 8 * MINUTE, scope: 'b' })];
  const both = { [claude[0]!.id]: idle, [claude[1]!.id]: idle };
  assert.equal(unhealthyEngines(claude, START, both).length, 1);
  assert.equal(unhealthyEngines(claude, START, both)[0]!.engine, 'claude');
  assert.equal(unhealthyEngines(claude.slice(0, 1), START, { [claude[0]!.id]: idle }).length, 0, 'one stall is not an unhealthy engine');
  assert.equal(unhealthyEngines(claude, START, {}).length, 0);
  const split = [claude[0]!, makeTask({ engine: 'codex', silentMs: 8 * MINUTE, scope: 'c' })];
  assert.deepEqual(unhealthyEngines(split, START, { [split[0]!.id]: idle, [split[1]!.id]: idle }), []);
  assert.equal(STALL_QUORUM, 2);
});

test('the ladder is 5 minutes, then 10 minutes, then attention, and does not stack while blocked', () => {
  const stalled = [makeTask(), makeTask()];
  const state: StallState = { engines: {}, history: [] };
  const first = nextPenalty(state, 'claude', START, stalled)!;
  assert.deepEqual(STALL_LADDER, [5, 10, null]);
  assert.equal(first.level, 1);
  assert.equal(first.block.engine, 'claude');
  assert.equal(first.block.by, STALL_BLOCK_BY);
  assert.equal(first.block.release_at, new Date(START + 5 * MINUTE).toISOString());
  assert.match(first.block.reason, /^2 个工作代理超过 5 分钟无响应（task /);
  assert.match(first.block.reason, /第 1 次惩罚性暂停 5 分钟$/);

  state.engines.claude = { level: 1, lastTriggerAt: START, needsAttention: false, blockedUntil: START + 5 * MINUTE };
  assert.equal(nextPenalty(state, 'claude', START + 4 * MINUTE, stalled), null, 'no stacking while the penalty is in force');
  const second = nextPenalty(state, 'claude', START + 5 * MINUTE, stalled)!;
  assert.equal(second.level, 2);
  assert.equal(second.block.release_at, new Date(START + 15 * MINUTE).toISOString());
  assert.match(second.block.reason, /第 2 次惩罚性暂停 10 分钟$/);

  state.engines.claude = { level: 2, lastTriggerAt: START + 5 * MINUTE, needsAttention: false, blockedUntil: START + 15 * MINUTE };
  const third = nextPenalty(state, 'claude', START + 15 * MINUTE, stalled)!;
  assert.equal(third.level, 3);
  assert.equal(third.block.release_at, undefined);
  assert.match(third.block.reason, /连续第 3 次出现，已停止自动恢复，需要人工查看$/);

  state.engines.claude = { level: 3, lastTriggerAt: START + 15 * MINUTE, needsAttention: true, blockedUntil: null };
  assert.equal(nextPenalty(state, 'claude', START + 40 * MINUTE, stalled), null, 'level 3 waits for the user');
});

test('two quiet hours reset the ladder, and the level never passes the ladder length', () => {
  const stalled = [makeTask(), makeTask()];
  const state: StallState = { engines: { claude: { level: 2, lastTriggerAt: START, needsAttention: false, blockedUntil: null } }, history: [] };
  assert.equal(nextPenalty(state, 'claude', START + LADDER_RESET_MS, stalled)!.level, 1);
  assert.equal(nextPenalty(state, 'claude', START + LADDER_RESET_MS - 1, stalled)!.level, 3);
  const capped: StallState = { engines: { claude: { level: 3, lastTriggerAt: START - MINUTE, needsAttention: false, blockedUntil: null } }, history: [] };
  assert.equal(nextPenalty(capped, 'claude', START, stalled)!.level, 3);
});

async function harness(options: { busy?: boolean; unreadable?: boolean; tasks?: Task[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wv-stall-'));
  let now = START;
  const config = defaultConfig();
  config.engines.codex.enabled = true;
  const policy = new PolicyStore(join(dir, 'policy.v1.json'), () => now);
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config, blocks: base.blocks });
  const tasks = options.tasks ?? [makeTask({ silentMs: 20 * MINUTE, scope: 'w-a' }), makeTask({ silentMs: 20 * MINUTE, scope: 'w-b' })];
  const { reader, reads } = cpu(options);
  const statePath = join(dir, 'stall.v1.json');
  const logs: string[] = [];
  let pumps = 0;
  const monitor = new StallMonitor({
    tasks: () => tasks,
    policy: () => policy,
    statePath,
    cpu: reader,
    now: () => now,
    onBlocksChanged: () => { pumps += 1; },
    log: message => logs.push(message),
  });
  /** One minute per tick, so a penalty can only fire after its own block released. */
  const step = async (which: StallMonitor, minutes: number) => {
    for (let index = 0; index < minutes; index += 1) { now += MINUTE; await which.tick(); }
  };
  const released = (engine = 'claude') => {
    const snapshot = policy.snapshot();
    policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: snapshot.blocks.filter(block => !(block.by === STALL_BLOCK_BY && block.engine === engine)) });
  };
  return {
    dir, policy, monitor, tasks, reads, logs, statePath, released,
    now: () => now,
    step,
    advance: (minutes: number) => step(monitor, minutes),
    stallBlocks: () => policy.snapshot().blocks.filter(block => block.by === STALL_BLOCK_BY),
    pumps: () => pumps,
    status: () => monitor.status(),
  };
}

test('the monitor pauses an engine after two stalls, pumps once per penalty and never cancels a task', async () => {
  const h = await harness();
  try {
    await h.advance(3);
    assert.equal(h.stallBlocks().length, 0, 'not enough idle intervals yet');
    await h.advance(3);
    const blocks = h.stallBlocks();
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.engine, 'claude');
    assert.equal(blocks[0]!.model, undefined);
    assert.equal(blocks[0]!.release_at, new Date(h.now() + 5 * MINUTE).toISOString());
    assert.equal(h.pumps(), 1);
    assert.equal(h.status().engines.claude!.level, 1);
    assert.equal(h.status().engines.claude!.needsAttention, false);
    assert.deepEqual(h.tasks.map(task => task.status), ['running', 'running'], 'Weaver pauses the engine, the owner decides about the tasks');
    assert.deepEqual(h.tasks.map(task => task.events.length), [1, 1], 'no lifecycle events were added to the stalled tasks');
    // Blocked is the existing routing state that keeps new dispatch away.
    assert.equal(h.policy.snapshot().workers.claude_worker!.status, 'blocked');
    assert.equal(h.policy.preview({ owner: 'codex_owner', worker: 'codex_worker' }).worker, 'codex_worker');
    await h.advance(4);
    assert.equal(h.stallBlocks().length, 1, 'no stacking while blocked');
    assert.equal(h.pumps(), 1);
    assert.equal(h.status().engines.claude!.level, 1);
  } finally { await h.monitor.stop(); }
});

test('one stalled worker is not enough to pause an engine', async () => {
  const h = await harness({ tasks: [makeTask({ silentMs: 20 * MINUTE, scope: 'only' })] });
  try {
    await h.advance(30);
    assert.equal(h.stallBlocks().length, 0);
    assert.deepEqual(h.status().engines, {});
    assert.equal(h.pumps(), 0);
  } finally { await h.monitor.stop(); }
});

test('a busy or unreadable scope is never punished', async () => {
  for (const options of [{ busy: true }, { unreadable: true }]) {
    const h = await harness(options);
    try {
      await h.advance(60);
      assert.equal(h.stallBlocks().length, 0, JSON.stringify(options));
      assert.ok(h.reads.length > 0, 'the scope was actually watched');
      assert.deepEqual(h.status().engines, {});
    } finally { await h.monitor.stop(); }
  }
});

test('a restarted monitor samples before it judges', async () => {
  const h = await harness();
  try {
    // These tasks have been silent for hours, but this process has no intervals yet.
    await h.advance(1);
    assert.equal(h.stallBlocks().length, 0);
    await h.advance(4);
    assert.equal(h.stallBlocks().length, 0, 'four idle intervals are not five');
    await h.advance(1);
    assert.equal(h.stallBlocks().length, 1);
  } finally { await h.monitor.stop(); }
});

test('the ladder escalates 5, then 10, then attention, and stops there', async () => {
  const h = await harness();
  try {
    const levels: number[] = [];
    let last = 0;
    for (let minute = 0; minute < 45; minute += 1) {
      await h.advance(1);
      const level = h.status().engines.claude?.level ?? 0;
      if (level !== last) { levels.push(level); last = level; }
    }
    assert.deepEqual(levels, [1, 2, 3]);
    assert.equal(h.pumps(), 3);
    const blocks = h.stallBlocks();
    assert.equal(blocks.length, 1, 'one penalty block per engine');
    assert.equal(blocks[0]!.release_at, undefined);
    assert.equal(h.status().engines.claude!.needsAttention, true);
    const history = h.status().engines.claude!.history;
    assert.deepEqual(history.map(item => item.level), [1, 2, 3]);
    assert.equal(history[0]!.tasks.length, 2);
    assert.ok(history[0]!.minutes >= 5);
    const times = history.map(item => Date.parse(item.at));
    assert.equal(Math.min(...times), times[0]);
    assert.equal(Math.max(...times), times[2]);
    assert.equal(times[2] <= h.now(), true);
  } finally { await h.monitor.stop(); }
});

test('the user clearing the attention block resets the ladder', async () => {
  const h = await harness();
  try {
    await h.advance(25);
    assert.equal(h.status().engines.claude!.level, 3);
    h.released();
    // The workers come back first: clearing the block alone must not immediately re-penalize them.
    for (let minute = 0; minute < 20; minute += 1) { for (const task of h.tasks) report(task, h.now()); await h.advance(1); }
    assert.equal(h.stallBlocks().length, 0);
    assert.equal(h.status().engines.claude!.level, 0);
    assert.equal(h.status().engines.claude!.needsAttention, false);
    assert.equal(h.status().engines.claude!.lastTriggerAt, null);
    assert.deepEqual(h.status().engines.claude!.history.map(item => item.level), [1, 2, 3], 'history survives the reset');
    // A fresh stall starts at level 1 again.
    await h.advance(8);
    assert.equal(h.status().engines.claude!.level, 1);
    assert.equal(h.stallBlocks()[0]!.release_at !== undefined, true);
  } finally { await h.monitor.stop(); }
});

test('a worker that keeps reporting drops out of the stall group', async () => {
  const h = await harness();
  try {
    await h.advance(6);
    assert.equal(h.stallBlocks().length, 1);
    h.released();
    for (let minute = 0; minute < 15; minute += 1) { for (const task of h.tasks) report(task, h.now()); await h.advance(1); }
    assert.equal(h.stallBlocks().length, 0, 'a talking worker is not stalled');
    assert.equal(h.status().engines.claude!.level, 1, 'the level only decays with the reset window');
    assert.equal(h.pumps(), 1);
  } finally { await h.monitor.stop(); }
});

test('an existing block or an unknown engine prevents a penalty', async () => {
  const h = await harness();
  try {
    const snapshot = h.policy.snapshot();
    h.policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [...snapshot.blocks, { engine: 'claude', reason: '人工暂停', since: new Date(START).toISOString(), release_at: new Date(START + 60 * MINUTE).toISOString(), by: 'user' }] });
    await h.advance(30);
    assert.equal(h.stallBlocks().length, 0, 'the engine is already out of routing');
    assert.deepEqual(h.status().engines, {});
    h.released('claude');
    const current = h.policy.snapshot();
    h.policy.save({ revision: current.revision, config: current.config, blocks: current.blocks.filter(block => block.by !== 'user') });
    await h.advance(30);
    assert.equal(h.stallBlocks().length, 1, 'and penalizes again once that block is gone');
    h.released();
    for (const task of h.tasks) task.dispatch = { ...task.dispatch!, engine: 'ghost' };
    await h.advance(30);
    assert.equal(h.stallBlocks().length, 0, 'an engine outside the policy cannot be blocked');
  } finally { await h.monitor.stop(); }
});

test('penalty state persists, and a damaged file starts the ladder over', async () => {
  const h = await harness();
  try {
    await h.advance(6);
    const raw = await readFile(h.statePath, 'utf8');
    const saved = JSON.parse(raw);
    assert.equal(saved.version, 1);
    assert.equal(saved.engines.claude.level, 1);
    assert.equal(saved.engines.claude.blockedUntil, h.now() + 5 * MINUTE);
    assert.equal(saved.history.length, 1);
    assert.deepEqual(saved.history[0].tasks, h.tasks.map(task => task.id));
    assert.equal(saved.history[0].engine, 'claude');
    assert.equal(statSync(h.statePath).mode & 0o777, 0o600);

    // A second process reads the ladder back.
    await h.advance(27);
    assert.equal(h.status().engines.claude!.level, 3);
    const reopened = new StallMonitor({ tasks: () => [], policy: () => h.policy, statePath: h.statePath, cpu: cpu().reader, now: h.now });
    const restored = reopened.status().engines.claude!;
    assert.equal(restored.level, 3);
    assert.equal(restored.needsAttention, true);
    assert.equal(restored.lastTriggerAt, h.status().engines.claude!.lastTriggerAt);
    assert.deepEqual(restored.history.map(item => item.level), [1, 2, 3]);
    await reopened.stop();

    await writeFile(h.statePath, '{not json');
    const logs: string[] = [];
    const recovered = new StallMonitor({ tasks: () => [], policy: () => h.policy, statePath: h.statePath, cpu: cpu().reader, now: h.now, log: message => logs.push(message) });
    assert.deepEqual(recovered.status().engines, {}, 'level 0 after damage');
    assert.match(logs.join('\n'), /Stall state ignored/);
    await recovered.stop();

    await writeFile(h.statePath, JSON.stringify({ version: 2, engines: {}, history: [] }));
    const mismatched = new StallMonitor({ tasks: () => [], policy: () => h.policy, statePath: h.statePath, cpu: cpu().reader, now: h.now, log: message => logs.push(message) });
    assert.deepEqual(mismatched.status().engines, {});
    assert.match(logs.at(-1)!, /Unsupported stall store/);
    await mismatched.stop();
  } finally { await h.monitor.stop(); }
});

test('the history keeps the last fifty triggers', async () => {
  const h = await harness();
  try {
    const seeded = { version: 1, engines: {}, history: Array.from({ length: 50 }, (_, index) => ({ engine: 'codex', level: 1, at: START - (50 - index) * MINUTE, tasks: [`seed-${index}`], minutes: 5 })) };
    await writeFile(h.statePath, JSON.stringify(seeded));
    const monitor = new StallMonitor({ tasks: () => h.tasks, policy: () => h.policy, statePath: h.statePath, cpu: cpu().reader, now: () => h.now(), log: () => {} });
    await monitor.stop();
    const before = JSON.parse(await readFile(h.statePath, 'utf8'));
    assert.equal(before.history.length, 50, 'loading does not invent history');
    assert.equal(before.history[0].tasks[0], 'seed-0', 'loading does not invent or drop history');
    for (let minute = 0; minute < 6; minute += 1) { await h.step(monitor, 1); }
    const after = JSON.parse(await readFile(h.statePath, 'utf8'));
    assert.equal(after.history.length, 50);
    assert.equal(after.history[0].tasks[0], 'seed-1', 'the oldest entry fell out');
    assert.equal(after.history.at(-1)!.engine, 'claude');
    assert.equal(after.engines.claude.level, 1);
  } finally { await h.monitor.stop(); }
});

test('a revision conflict is retried and the penalty still lands', async () => {
  const h = await harness();
  try {
    let conflicts = 0;
    const flaky: StallPolicy = {
      snapshot: () => h.policy.snapshot(),
      save: input => {
        if (conflicts === 0) {
          conflicts += 1;
          const current = h.policy.snapshot();
          // Somebody else saved between our read and our write.
          h.policy.save({ revision: current.revision, config: current.config, blocks: [...current.blocks, { engine: 'codex', reason: '并发修改', since: new Date(h.now()).toISOString(), by: 'user' }] });
          throw new Error('Settings changed; reload before saving');
        }
        return h.policy.save(input);
      },
    };
    let pumps = 0;
    const retried: string[] = [];
    const monitor = new StallMonitor({ tasks: () => h.tasks, policy: () => flaky, statePath: h.statePath, cpu: cpu().reader, now: h.now, onBlocksChanged: () => { pumps += 1; }, log: message => retried.push(message) });
    await h.step(monitor, 6);
    assert.equal(conflicts, 1);
    assert.match(retried.join('\n'), /will be retried/);
    const blocks = h.policy.snapshot().blocks.filter(block => block.engine === 'claude');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.by, STALL_BLOCK_BY);
    assert.equal(h.policy.snapshot().blocks.filter(block => block.engine === 'codex').length, 1, 'the concurrent block survived');
    assert.equal(pumps, 1);
    assert.equal(monitor.status().engines.claude!.level, 1);
    await monitor.stop();
  } finally { await h.monitor.stop(); }
});

test('a penalty that cannot be saved leaves the ladder untouched', async () => {
  const h = await harness();
  try {
    const broken: StallPolicy = { snapshot: () => h.policy.snapshot(), save: () => { throw new Error('disk is full'); } };
    const logs: string[] = [];
    const monitor = new StallMonitor({ tasks: () => h.tasks, policy: () => broken, statePath: h.statePath, cpu: cpu().reader, now: h.now, log: message => logs.push(message) });
    await h.step(monitor, 6);
    assert.equal(h.stallBlocks().length, 0);
    assert.deepEqual(monitor.status().engines, {});
    assert.equal(h.pumps(), 0);
    assert.match(logs.join('\n'), /will be retried/);
    assert.match(logs.at(-1)!, /was not saved/);
    assert.equal(monitor.status().engines.claude, undefined, 'the next tick may try again');
    await monitor.stop();
  } finally { await h.monitor.stop(); }
});

test('ticks never overlap and a tick joins the one in flight', async () => {
  const h = await harness();
  try {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    let checks = 0;
    let clock = START;
    const slow: CpuReader = async () => { reads += 1; await gate; return 0; };
    const monitor = new StallMonitor({
      tasks: () => h.tasks,
      policy: () => h.policy,
      statePath: join(h.dir, 'once.v1.json'),
      now: () => { checks += 1; return clock += MINUTE; },
      cpu: slow,
    });
    const first = monitor.tick();
    const second = monitor.tick();
    assert.equal(second, first, 'a tick while one is running joins it');
    assert.equal(checks, 1, 'the joined tick never started a second pass');
    assert.equal(reads, 2, 'one sample per running real task');
    release();
    await Promise.all([first, second]);
    await monitor.tick();
    assert.equal(checks, 2);
    assert.equal(reads, 4, 'the next tick samples again');
    await monitor.stop();
  } finally { await h.monitor.stop(); }
});

test('start samples on a timer and stop ends it', async () => {
  const h = await harness();
  try {
    let reads = 0;
    let clock = START;
    const monitor = new StallMonitor({ tasks: () => h.tasks, policy: () => h.policy, statePath: join(h.dir, 'timer.v1.json'), now: () => (clock += 60_000), cpu: async () => { reads += 1; return 0; } });
    monitor.start(2);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(reads >= 4, `expected repeated samples, saw ${reads}`);
    await monitor.stop();
    const settled = reads;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(reads, settled, 'stop ends the timer');
  } finally { await h.monitor.stop(); }
});

test('the systemd reader degrades to null instead of guessing', async () => {
  // An unknown unit must not read as zero CPU, which would look idle and punish a healthy worker.
  assert.equal(await systemdCpuUsage('weaver-stall-test-missing.scope'), null);
});

test('getStall is a zero-arg RPC returning the ladder and its configuration', async () => {
  const h = await harness();
  try {
    assert.deepEqual(parseRpcBody({ method: 'getStall', args: [] }), { method: 'getStall', args: [] });
    assert.throws(() => parseRpcBody({ method: 'getStall', args: [{}] }), /Invalid argument arity/);
    assert.deepEqual(h.status(), {
      engines: {},
      config: { stallMinutes: STALL_MS / MINUTE, quorum: STALL_QUORUM, ladder: [5, 10, null], resetHours: LADDER_RESET_MS / (60 * MINUTE) },
    });
    await h.advance(6);
    assert.deepEqual(h.status().config, { stallMinutes: 5, quorum: 2, ladder: [5, 10, null], resetHours: 2 });
    assert.equal(h.status().engines.claude!.level, 1);
  } finally { await h.monitor.stop(); }
});
