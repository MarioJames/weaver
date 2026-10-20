import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultConfig } from '../src/main/policy/routing';
import { PolicyStore } from '../src/main/policy/store';
import { parseRpcBody } from '../src/main/rpc';
import {
  CPU_IDLE_SHARE, LADDER_RESET_MS, PROBE_MS, PROBE_SUCCESSES, STALL_BLOCK_BY, STALL_LADDER, STALL_MS,
  STALL_QUORUM, STALL_RECOVERY, StallMonitor, emptyPenalty, idleSince, isStalled, nextPenalty, silenceMs,
  parseStallState, stalledTasks, systemdCpuUsage, unhealthyEngines,
  type CpuReader, type CpuSample, type EnginePenalty, type ProbeOutcome, type ProbeRoute, type RecoveryProbe,
  type StallPolicy, type StallState, type StallStatus,
} from '../src/main/stall';
import type { Task } from '../src/shared/types';
import { readStall, seedStall, stallStoreAt } from './helpers/state-db';

const START = Date.parse('2030-01-01T00:00:00Z');
const MINUTE = 60_000;
/** ns of CPU that one fully busy core burns in a minute. */
const CORE_MINUTE = MINUTE * 1_000_000;
const PASS: ProbeOutcome = { ok: true, ms: 1_500 };
const FAIL: ProbeOutcome = { ok: false, ms: 2_500, error: '进程退出码 1，没有回复。' };
const iso = (at: number) => new Date(at).toISOString();

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
    run: { id: randomUUID(), adapter: engine, execution, status: 'running', startedAt: at, firstOutputAt: at, ...(execution === 'real' ? { scopeUnit: options.scope ?? `weaver-cli-${engine}-${id.slice(0, 8)}` } : {}) },
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

/** A scripted answer for the monitor's recovery probes. No real engine is ever called. */
function prober(script: (call: number) => ProbeOutcome): { probe: RecoveryProbe; calls: ProbeRoute[] } {
  const calls: ProbeRoute[] = [];
  const probe: RecoveryProbe = async route => {
    const answer = script(calls.length + 1);
    calls.push(route);
    return answer;
  };
  return { probe, calls };
}

/** A probe that only answers when the test says so, so its result can land after the user already acted. */
function pendingProbe(options: { rejectOnAbort?: boolean } = {}): { probe: RecoveryProbe; signals: AbortSignal[]; settle: (outcome: ProbeOutcome) => void; inFlight: Promise<void>; calls: () => number } {
  let answer: (outcome: ProbeOutcome) => void = () => {};
  let reject: (error: Error) => void = () => {};
  let begin: () => void = () => {};
  const inFlight = new Promise<void>(resolve => { begin = resolve; });
  const signals: AbortSignal[] = [];
  let calls = 0;
  const probe: RecoveryProbe = (route, signal) => new Promise<ProbeOutcome>((resolve, refuse) => {
    calls += 1;
    signals.push(signal);
    answer = resolve;
    reject = refuse;
    begin();
    // A killed greeting still answers, exactly like sayHi does after its process is stopped; some throw instead.
    signal.addEventListener('abort', () => (options.rejectOnAbort ? reject(new Error('probe was cancelled')) : resolve(FAIL)), { once: true });
  });
  return { probe, signals, settle: outcome => answer(outcome), inFlight, calls: () => calls };
}

/** CPU reads that hold the tick open, so a stop can land while the monitor is still sampling. */
function slowCpu(): { reader: CpuReader; sampling: Promise<void>; release: () => void } {
  let begin: () => void = () => {};
  let unpause: () => void = () => {};
  const sampling = new Promise<void>(resolve => { begin = resolve; });
  const gate = new Promise<void>(resolve => { unpause = resolve; });
  let counted = false;
  const reader: CpuReader = async () => {
    if (!counted) { counted = true; begin(); }
    await gate;
    return 0;
  };
  return { reader, sampling, release: unpause };
}

/** Waiting on a fake that never gets there must fail the test, not run until the suite times out. */
async function awaited(wait: Promise<void>, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([wait, new Promise<never>((_, refuse) => {
      timer = setTimeout(() => refuse(new Error(`the ${what} never started`)), 5_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Some progress has no promise to hand a test (a restarted tick starts its own): wait for it, with a bound. */
async function until(seen: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!seen()) {
    if (Date.now() > deadline) throw new Error(`the ${what} never happened`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const routeOf = (engine: string, worker: string, model: string, effort: string): ProbeRoute =>
  ({ engine, kind: engine === 'qoder' ? 'qodercli' : engine, worker, model, effort });

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

/** A penalty waiting for its probe or for the user: the deadlines live in the state, never in the block. */
const armed = (level: number, triggeredAt: number): EnginePenalty => {
  const minutes = STALL_LADDER[level - 1];
  const nominal = minutes === null ? null : triggeredAt + minutes * MINUTE;
  return {
    ...emptyPenalty(),
    level,
    lastTriggerAt: triggeredAt,
    needsAttention: level >= STALL_LADDER.length,
    blockedUntil: nominal,
    nextProbeAt: nominal ?? triggeredAt + PROBE_MS,
  };
};

test('a penalty block has no release time, and nothing stacks while one waits for its probe', () => {
  const stalled = [makeTask(), makeTask()];
  const state: StallState = { engines: {}, history: [] };
  const first = nextPenalty(state, 'claude', START, stalled)!;
  assert.deepEqual(STALL_LADDER, [5, 10, null]);
  assert.equal(first.level, 1);
  assert.equal(first.block.engine, 'claude');
  assert.equal(first.block.by, STALL_BLOCK_BY);
  assert.equal(first.block.release_at, undefined, 'only a passing probe or the user lifts this');
  assert.equal(first.block.reason, '2 个子 Agent 超过 5 分钟无响应');
  assert.ok(first.block.reason.length <= 120);

  state.engines.claude = armed(1, START);
  assert.equal(nextPenalty(state, 'claude', START + 4 * MINUTE, stalled), null, 'no stacking while the penalty waits for its probe');
  // The superseded unconditional release is gone: a deadline that passed without a probe is still the same penalty.
  assert.equal(nextPenalty(state, 'claude', START + 90 * MINUTE, stalled), null, 'time passing is not a release');

  // A lifted penalty keeps its ladder, so the next trigger escalates.
  state.engines.claude = { ...emptyPenalty(), level: 1, lastTriggerAt: START };
  const second = nextPenalty(state, 'claude', START + 6 * MINUTE, stalled)!;
  assert.equal(second.level, 2);
  assert.ok(second.block.reason.length <= 120);

  state.engines.claude = { ...emptyPenalty(), level: 2, lastTriggerAt: START + 6 * MINUTE };
  const third = nextPenalty(state, 'claude', START + 16 * MINUTE, stalled)!;
  assert.equal(third.level, 3);
  assert.equal(third.block.release_at, undefined);
  assert.ok(third.block.reason.length <= 120);

  state.engines.claude = armed(3, START + 16 * MINUTE);
  assert.equal(nextPenalty(state, 'claude', START + 60 * MINUTE, stalled), null, 'level 3 waits for its streak or the user');
  // Even after level 3 recovered on its own, a trigger inside the window is level 3 again.
  state.engines.claude = { ...emptyPenalty(), level: 3, lastTriggerAt: START + 16 * MINUTE };
  assert.equal(nextPenalty(state, 'claude', START + 90 * MINUTE, stalled)!.level, 3);
});

test('two quiet hours reset the ladder, and the level never passes the ladder length', () => {
  const stalled = [makeTask(), makeTask()];
  const state: StallState = { engines: { claude: { ...emptyPenalty(), level: 2, lastTriggerAt: START } }, history: [] };
  assert.equal(nextPenalty(state, 'claude', START + LADDER_RESET_MS, stalled)!.level, 1);
  assert.equal(nextPenalty(state, 'claude', START + LADDER_RESET_MS - 1, stalled)!.level, 3);
  const capped: StallState = { engines: { claude: { ...emptyPenalty(), level: 3, lastTriggerAt: START - MINUTE } }, history: [] };
  assert.equal(nextPenalty(capped, 'claude', START, stalled)!.level, 3);
});

interface HarnessOptions {
  busy?: boolean;
  unreadable?: boolean;
  tasks?: Task[];
  probe?: RecoveryProbe;
  configure?: (config: ReturnType<typeof defaultConfig>) => void;
  /** False builds a monitor with no ready callback at all: only its own stop() may fence it. */
  ready?: boolean;
}

/** Every directory this file creates is tracked, so no run can leave scratch behind. */
const tempDirs = new Set<string>();
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wv-stall-'));
  tempDirs.add(dir);
  return dir;
}
after(() => Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true }))));

async function harness(options: HarnessOptions = {}) {
  const dir = await tempDir();
  let now = START;
  let ready = true;
  const config = defaultConfig();
  config.engines.codex.enabled = true;
  options.configure?.(config);
  const policy = new PolicyStore(join(dir,'weaver.db'), () => now);
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config, blocks: base.blocks });
  const tasks = options.tasks ?? [makeTask({ silentMs: 20 * MINUTE, scope: 'w-a' }), makeTask({ silentMs: 20 * MINUTE, scope: 'w-b' })];
  const { reader, reads } = cpu(options);
  const statePath = join(dir, 'state.db');
  const logs: string[] = [];
  let pumps = 0;
  const monitor = new StallMonitor({
    tasks: () => tasks,
    policy: () => policy,
    stateStore: stallStoreAt(statePath),
    cpu: reader,
    probe: options.probe,
    now: () => now,
    ...(options.ready === false ? {} : { ready: () => ready }),
    onBlocksChanged: () => { pumps += 1; },
    log: message => logs.push(message),
  });
  /** One minute per tick, so a probe can only run at its own deadline. */
  const step = async (which: StallMonitor, minutes: number) => {
    for (let index = 0; index < minutes; index += 1) { now += MINUTE; await which.tick(); }
  };
  const keepTalking = async (which: StallMonitor, minutes: number) => {
    for (let index = 0; index < minutes; index += 1) { for (const task of tasks) report(task, now); now += MINUTE; await which.tick(); }
  };
  const released = (engine = 'claude') => {
    const snapshot = policy.snapshot();
    policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: snapshot.blocks.filter(block => !(block.by === STALL_BLOCK_BY && block.engine === engine)) });
  };
  const block = (engine: string, options: { by?: string; model?: string; release_at?: string } = {}) => {
    const snapshot = policy.snapshot();
    policy.save({
      revision: snapshot.revision, config: snapshot.config,
      blocks: [...snapshot.blocks, { engine, reason: '人工暂停', since: iso(now), ...(options.model ? { model: options.model } : {}), ...(options.by ? { by: options.by } : {}), ...(options.release_at ? { release_at: options.release_at } : {}) }],
    });
  };
  return {
    dir, policy, monitor, tasks, reads, logs, statePath, released, block, keepTalking,
    now: () => now,
    setReady: (value: boolean) => { ready = value; },
    step,
    advance: (minutes: number) => step(monitor, minutes),
    /** Time moves without a tick, so a test can leave a probe waiting mid-tick. */
    later: (minutes: number) => { now += minutes * MINUTE; },
    tick: () => monitor.tick(),
    stallBlocks: () => policy.snapshot().blocks.filter(block => block.by === STALL_BLOCK_BY),
    blocksOf: (engine: string) => policy.snapshot().blocks.filter(block => block.engine === engine),
    pumps: () => pumps,
    status: () => monitor.status(),
    engine: (which = 'claude') => monitor.status().engines[which]!,
    cleanup: async () => { tempDirs.delete(dir); await rm(dir, { recursive: true, force: true }); },
  };
}

const penalized = (status: StallStatus) => Object.entries(status.engines).filter(([, item]) => item.level > 0 || item.blocked).map(([engine]) => engine);
const probesOf = (h: Awaited<ReturnType<typeof harness>>, engine = 'claude') => h.engine(engine).history.filter(item => item.probe !== undefined);

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
    assert.equal(blocks[0]!.release_at, undefined, 'a penalty is not on a timer');
    assert.equal(h.pumps(), 1);
    assert.equal(h.engine().level, 1);
    assert.equal(h.engine().needsAttention, false);
    assert.equal(h.engine().blocked, true);
    assert.equal(h.engine().blockedUntil, iso(h.now() + 5 * MINUTE), 'the nominal deadline stays in the stall state');
    assert.equal(h.engine().nextProbeAt, h.engine().blockedUntil);
    assert.deepEqual(h.tasks.map(task => task.status), ['running', 'running'], 'Weaver pauses the engine, the owner decides about the tasks');
    assert.deepEqual(h.tasks.map(task => task.events.length), [1, 1], 'no lifecycle events were added to the stalled tasks');
    // Blocked is the existing routing state that keeps new dispatch away.
    assert.equal(h.policy.snapshot().workers.claude_worker!.status, 'blocked');
    assert.equal(h.policy.preview({ owner: 'codex_owner', worker: 'codex_worker' }).worker, 'codex_worker');
    await h.advance(4);
    assert.equal(h.stallBlocks().length, 1, 'no stacking while blocked');
    assert.equal(h.pumps(), 1);
    assert.equal(h.engine().level, 1);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('nothing lifts a penalty without a probe, however long the engine stays paused', async () => {
  const h = await harness();
  try {
    await h.advance(6);
    assert.equal(h.engine().level, 1);
    await h.advance(120);
    assert.equal(h.stallBlocks().length, 1, 'the block is still there two hours later');
    assert.equal(h.engine().level, 1, 'the ladder only moves on a probe answer or on the user');
    assert.equal(h.engine().blocked, true);
    assert.equal(h.pumps(), 1);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('one stalled worker is not enough to pause an engine', async () => {
  const h = await harness({ tasks: [makeTask({ silentMs: 20 * MINUTE, scope: 'only' })] });
  try {
    await h.advance(30);
    assert.equal(h.stallBlocks().length, 0);
    assert.deepEqual(penalized(h.status()), []);
    assert.equal(h.pumps(), 0);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('a busy or unreadable scope is never punished', async () => {
  for (const options of [{ busy: true }, { unreadable: true }]) {
    const h = await harness(options);
    try {
      await h.advance(60);
      assert.equal(h.stallBlocks().length, 0, JSON.stringify(options));
      assert.ok(h.reads.length > 0, 'the scope was actually watched');
      assert.deepEqual(penalized(h.status()), []);
    } finally { await h.monitor.stop(); await h.cleanup(); }
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
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('a passing probe is the only thing that lifts level 1, and it keeps the ladder', async () => {
  const p = prober(() => PASS);
  const h = await harness({ probe: p.probe });
  try {
    await h.advance(6);
    assert.equal(h.engine().level, 1);
    await h.advance(4);
    assert.equal(p.calls.length, 0, 'the nominal deadline has not arrived yet');
    assert.equal(h.stallBlocks().length, 1);
    await h.advance(1);
    // Exactly one light call, on the enabled worker's own configured route for this engine's kind.
    assert.deepEqual(p.calls, [routeOf('claude', 'claude_worker', 'sonnet', 'high')]);
    assert.equal(h.stallBlocks().length, 0, 'the penalty block is gone');
    assert.equal(h.engine().blocked, false);
    assert.equal(h.engine().level, 1, 'the ladder memory survives its own recovery');
    assert.equal(h.engine().lastTriggerAt, iso(h.now() - 5 * MINUTE));
    assert.equal(h.engine().nextProbeAt, null);
    assert.equal(h.engine().blockedUntil, null);
    assert.equal(h.pumps(), 2, 'once to block, once to release');
    const probe = h.engine().history.at(-1)!;
    assert.deepEqual(probe.tasks, [], 'a probe is not about a task');
    assert.equal(probe.level, 1);
    assert.deepEqual(probe.probe, PASS);
    assert.equal(probe.model, 'sonnet');
    assert.equal(probe.effort, 'high');
    // The same stuck workers are a new trigger, and the retained ladder escalates it instead of restarting at 1.
    await h.advance(1);
    assert.equal(h.engine().level, 2);
    assert.equal(p.calls.length, 1, 'the new penalty waits its own ten minutes');
    assert.equal(h.stallBlocks()[0]!.reason, '2 个子 Agent 超过 5 分钟无响应');
    assert.equal(h.stallBlocks()[0]!.release_at, undefined);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('the tick that recovers an engine never penalizes it again', async () => {
  const p = prober(() => PASS);
  const h = await harness({ probe: p.probe });
  try {
    await h.advance(11);
    assert.equal(p.calls.length, 1);
    assert.equal(h.stallBlocks().length, 0, 'the recovery is not answered with a fresh block in the same tick');
    assert.equal(h.engine().level, 1);
    assert.equal(h.pumps(), 2);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('a failed probe escalates on the spot: 1 to 2 waits ten minutes, 2 to 3 needs attention', async () => {
  const p = prober(() => FAIL);
  const h = await harness({ probe: p.probe });
  try {
    await h.advance(11);
    assert.equal(p.calls.length, 1);
    assert.equal(h.engine().level, 2, 'no second five-minute wait: the failure is evidence already');
    assert.equal(h.engine().blockedUntil, iso(h.now() + 10 * MINUTE));
    assert.equal(h.engine().nextProbeAt, iso(h.now() + 10 * MINUTE));
    assert.equal(h.engine().probeSuccesses, 0);
    const blocks = h.stallBlocks();
    assert.equal(blocks.length, 1, 'still one penalty block for the engine');
    assert.equal(blocks[0]!.release_at, undefined);
    assert.equal(blocks[0]!.reason, '2 个子 Agent 超过 5 分钟无响应');
    assert.equal(h.pumps(), 1, 'the engine never left routing, so nothing re-routes');

    await h.advance(10);
    assert.equal(p.calls.length, 2);
    assert.equal(h.engine().level, 3);
    assert.equal(h.engine().needsAttention, true);
    assert.equal(h.engine().blockedUntil, null, 'level 3 has no nominal deadline at all');
    assert.equal(h.engine().nextProbeAt, iso(h.now() + PROBE_MS));
    assert.deepEqual(h.engine().history.map(item => item.level), [1, 1, 2], 'a probe records the level it tested');

    await h.advance(60);
    assert.equal(p.calls.length, 8, 'level 3 keeps asking every ten minutes');
    assert.equal(h.engine().level, 3);
    assert.equal(h.engine().needsAttention, true);
    assert.equal(h.stallBlocks().length, 1, 'and the engine stays paused');
    assert.equal(h.pumps(), 1, 'and nothing else moved');
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('level 3 lifts only after three consecutive passes, and says so in the record', async () => {
  // Two failures take the engine to level 3; everything after that answers.
  const p = prober(call => call <= 2 ? FAIL : PASS);
  const h = await harness({ probe: p.probe });
  try {
    await h.advance(31);
    assert.equal(p.calls.length, 3);
    assert.equal(h.engine().level, 3);
    assert.equal(h.engine().probeSuccesses, 1, 'the first pass is not recovery yet');
    assert.equal(h.engine().blocked, true);
    assert.equal(h.engine().nextProbeAt, iso(h.now() + PROBE_MS));

    await h.advance(10);
    assert.equal(p.calls.length, 4);
    assert.equal(h.engine().probeSuccesses, 2);
    assert.equal(h.stallBlocks().length, 1, 'two passes are still not three');
    assert.equal(h.pumps(), 1);

    await h.advance(10);
    assert.equal(p.calls.length, 5);
    assert.equal(h.stallBlocks().length, 0);
    assert.equal(h.engine().blocked, false);
    assert.equal(h.engine().needsAttention, false);
    assert.equal(h.engine().level, 3, 'level 3 stays until the two trigger-free hours pass');
    assert.equal(h.engine().probeSuccesses, 0);
    assert.deepEqual(probesOf(h).map(item => item.probe!.ok), [false, false, true, true, true]);
    const recovery = h.engine().history.at(-1)!;
    assert.equal(recovery.message, STALL_RECOVERY);
    assert.equal(STALL_RECOVERY, '自动恢复，请留意');
    assert.deepEqual(recovery.tasks, []);
    assert.equal(recovery.level, 3);
    assert.equal(h.pumps(), 2, 'the recovery re-routes the queue');
    // A new trigger inside the window is level 3 again, not a fresh ladder.
    await h.advance(1);
    assert.equal(h.engine().level, 3);
    assert.equal(h.engine().needsAttention, true);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('a level 3 failure resets the consecutive passes', async () => {
  // Two failures reach level 3, one reset lands on the fifth probe, everything after that passes.
  const p = prober(call => (call <= 2 || call === 5) ? FAIL : PASS);
  const h = await harness({ probe: p.probe });
  try {
    await h.advance(31);
    assert.equal(h.engine().probeSuccesses, 1);
    await h.advance(10);
    assert.equal(h.engine().probeSuccesses, 2);
    await h.advance(10);
    assert.equal(p.calls.length, 5, 'the fifth probe was scripted to fail');
    assert.equal(h.engine().probeSuccesses, 0, 'a failure restarts the streak');
    assert.equal(h.engine().level, 3);
    assert.equal(h.engine().blocked, true);
    await h.advance(10);
    assert.equal(h.engine().probeSuccesses, 1);
    await h.advance(20);
    assert.equal(h.engine().blocked, false, 'and three fresh passes lift it');
    assert.equal(h.engine().level, 3);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('the level 3 streak and its next probe survive a restart', async () => {
  const first = prober(call => call <= 2 ? FAIL : PASS);
  const h = await harness({ probe: first.probe });
  try {
    await h.advance(31);
    assert.equal(h.engine().probeSuccesses, 1);
    const nextProbeAt = h.engine().nextProbeAt;
    assert.equal(nextProbeAt, iso(h.now() + PROBE_MS));

    const second = prober(() => PASS);
    const reopened = new StallMonitor({
      tasks: () => h.tasks, policy: () => h.policy, stateStore: stallStoreAt(h.statePath), cpu: cpu().reader,
      probe: second.probe, now: h.now, onBlocksChanged: () => {}, log: () => {},
    });
    assert.equal(reopened.status().engines.claude!.probeSuccesses, 1, 'the streak was read back');
    assert.equal(reopened.status().engines.claude!.nextProbeAt, nextProbeAt);
    await h.step(reopened, 10);
    assert.equal(second.calls.length, 1);
    assert.equal(reopened.status().engines.claude!.probeSuccesses, 2);
    await h.step(reopened, 10);
    assert.equal(reopened.status().engines.claude!.blocked, false);
    await reopened.stop();
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('no enabled worker on the penalized engine fails the probe without calling anything', async () => {
  const p = prober(() => PASS);
  const h = await harness({
    probe: p.probe,
    configure: config => { config.workers.claude_worker.enabled = false; config.owners.claude_owner.enabled = false; },
  });
  try {
    await h.advance(11);
    assert.equal(p.calls.length, 0, 'there is no route to greet with');
    assert.equal(h.engine().level, 2, 'and that counts as a failed recovery check');
    assert.equal(h.stallBlocks().length, 1);
    const failed = h.engine().history.at(-1)!;
    assert.equal(failed.probe?.ok, false);
    assert.match(String(failed.probe?.error), /没有可用的子 Agent/);
    assert.equal(failed.model, undefined, 'nothing was configured to probe with');
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('the probe uses a configured worker of the penalized engine, not its own engine', async () => {
  const p = prober(() => PASS);
  const h = await harness({ probe: p.probe, tasks: [makeTask({ engine: 'codex', silentMs: 20 * MINUTE, scope: 'x' }), makeTask({ engine: 'codex', silentMs: 20 * MINUTE, scope: 'y' })] });
  try {
    await h.advance(11);
    assert.deepEqual(p.calls, [routeOf('codex', 'codex_worker', 'gpt-6.1-sol', 'high')]);
    assert.equal(h.engine('codex').blocked, false);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('a block the user removed while a probe was running is not restored by its answer', async () => {
  const waiting = pendingProbe();
  const h = await harness({ probe: waiting.probe });
  try {
    await h.advance(10);
    h.later(1);
    const running = h.tick();
    await awaited(waiting.inFlight, 'probe');
    assert.equal(waiting.calls(), 1, 'the probe is in flight');
    h.released();
    waiting.settle(PASS);
    await running;
    assert.equal(h.stallBlocks().length, 0, 'the passing answer does not put a block back');
    assert.equal(probesOf(h).length, 0, 'the stale answer is not even recorded');
    await h.advance(1);
    assert.equal(h.engine().level, 0, 'the removal was the explicit unblock');
    assert.equal(h.engine().lastTriggerAt, null);
    assert.equal(h.engine().blocked, false);
    assert.equal(h.pumps(), 1, 'only the penalty itself pumped');
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('a block replacing the penalty while a probe was running swallows that answer', async () => {
  const waiting = pendingProbe();
  const h = await harness({ probe: waiting.probe });
  try {
    await h.advance(10);
    h.later(1);
    const running = h.tick();
    await awaited(waiting.inFlight, 'probe');
    h.released();
    h.block('claude', { by: 'user', release_at: iso(h.now() + 60 * MINUTE) });
    waiting.settle(PASS);
    await running;
    await h.advance(1);
    assert.equal(h.engine().level, 0, 'the monitor does not escalate over the user');
    assert.equal(probesOf(h).length, 0);
    const blocks = h.policy.snapshot().blocks.filter(block => block.engine === 'claude');
    assert.deepEqual(blocks.map(block => block.by), ['user'], 'the user block stays as they wrote it');
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('stop aborts a probe and nothing is written after draining began', async () => {
  const waiting = pendingProbe();
  const h = await harness({ probe: waiting.probe });
  try {
    await h.advance(10);
    h.later(1);
    const running = h.tick();
    await awaited(waiting.inFlight, 'probe');
    assert.equal(waiting.calls(), 1);
    h.setReady(false);
    await h.monitor.stop();
    assert.equal(waiting.signals[0]!.aborted, true, 'the in-flight probe was aborted');
    await running;
    assert.equal(h.engine().level, 1, 'its answer never escalated or lifted anything');
    assert.equal(h.engine().nextProbeAt, iso(START + 11 * MINUTE));
    assert.equal(probesOf(h).length, 0, 'and no late history was written either');
    assert.equal(h.stallBlocks().length, 1);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('one engine is never probed twice at the same time', async () => {
  const waiting = pendingProbe();
  const h = await harness({ probe: waiting.probe });
  try {
    await h.advance(10);
    h.later(1);
    const running = h.tick();
    await awaited(waiting.inFlight, 'probe');
    // A tick while another is in flight joins it, so the waiting greeting is never doubled.
    const joined = [h.tick(), h.tick()];
    assert.equal(waiting.calls(), 1, 'the joined ticks did not start a second greeting');
    waiting.settle(PASS);
    await Promise.all([running, ...joined]);
    assert.equal(waiting.calls(), 1, 'and the answer ran exactly one greeting');
    assert.equal(h.engine().blocked, false);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('unblock drops one engine and leaves everything else alone', async () => {
  const p = prober(() => FAIL);
  const h = await harness({ probe: p.probe });
  try {
    await h.advance(11);
    assert.equal(h.engine().level, 2);
    h.block('codex', { by: 'user' });
    const before = h.pumps();
    h.monitor.unblock('claude');
    assert.equal(h.stallBlocks().length, 0, 'its own block is gone');
    assert.equal(h.policy.snapshot().blocks.filter(block => block.engine === 'codex').length, 1, 'another engine keeps its block');
    assert.equal(h.engine().level, 0);
    assert.equal(h.engine().lastTriggerAt, null);
    assert.equal(h.engine().nextProbeAt, null);
    assert.equal(h.engine().probeSuccesses, 0);
    assert.equal(h.engine().blocked, false);
    assert.deepEqual(h.engine().history.map(item => item.level), [1, 1], 'the record survives');
    assert.equal(h.pumps(), before + 1, 'and queued work re-routes');
    // The persisted state agrees, so a restart cannot resurrect the dropped ladder.
    const saved = readStall(h.statePath);
    assert.equal(saved.engines.claude.level, 0);
    assert.equal(saved.engines.claude.nextProbeAt, null);
    assert.equal(saved.history.length, 2, 'one trigger and one failed probe');
    // An unknown engine is rejected before anything is written.
    assert.throws(() => h.monitor.unblock('ghost'), /Unknown engine ghost/);
    assert.equal(h.policy.snapshot().blocks.filter(block => block.engine === 'codex').length, 1);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('unblocking an engine with nothing to unblock changes no blocks', async () => {
  const h = await harness();
  try {
    h.monitor.unblock('claude');
    assert.equal(h.stallBlocks().length, 0);
    assert.equal(h.pumps(), 0);
    assert.equal(h.engine().level, 0);
    assert.equal(h.engine().blocked, false);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('the user clearing the attention block resets the ladder', async () => {
  const h = await harness({ probe: prober(() => FAIL).probe });
  try {
    await h.advance(21);
    assert.equal(h.engine().level, 3);
    assert.equal(h.engine().needsAttention, true);
    h.released();
    // The workers come back first: clearing the block alone must not immediately re-penalize them.
    await h.keepTalking(h.monitor, 20);
    assert.equal(h.stallBlocks().length, 0);
    assert.equal(h.engine().level, 0);
    assert.equal(h.engine().needsAttention, false);
    assert.equal(h.engine().lastTriggerAt, null);
    assert.deepEqual(h.engine().history.map(item => item.level), [1, 1, 2], 'history survives the reset');
    // A fresh stall starts at level 1 again.
    await h.advance(8);
    assert.equal(h.engine().level, 1);
    assert.equal(h.stallBlocks()[0]!.release_at, undefined);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('two trigger-free hours retire the level as well as the ladder', async () => {
  const h = await harness({ probe: prober(() => PASS).probe });
  try {
    await h.advance(11);
    assert.equal(h.engine().level, 1, 'a lifted level is kept for its window');
    assert.equal(h.engine().blocked, false);
    await h.keepTalking(h.monitor, 114);
    assert.equal(h.engine().level, 1, 'and it is still the same episode one hour on');
    await h.keepTalking(h.monitor, 2);
    assert.equal(h.engine().level, 0, 'the record stays, the level does not');
    assert.deepEqual(h.engine().history.map(item => item.level), [1, 1]);
    assert.equal(h.pumps(), 2);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('a worker that keeps reporting drops out of the stall group', async () => {
  const h = await harness();
  try {
    await h.advance(6);
    assert.equal(h.stallBlocks().length, 1);
    h.released();
    await h.keepTalking(h.monitor, 15);
    assert.equal(h.stallBlocks().length, 0, 'a talking worker is not stalled');
    assert.equal(h.engine().level, 0, 'the removal was the explicit unblock, so the ladder starts over');
    assert.equal(h.engine().lastTriggerAt, null);
    assert.equal(h.engine().history.length, 1, 'the record of the trigger stays');
    assert.equal(h.pumps(), 1);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('an existing block or an unknown engine prevents a penalty', async () => {
  const h = await harness();
  try {
    h.block('claude', { by: 'user', release_at: iso(START + 60 * MINUTE) });
    await h.advance(30);
    assert.equal(h.stallBlocks().length, 0, 'the engine is already out of routing');
    assert.deepEqual(penalized(h.status()), []);
    const manual = h.policy.snapshot().blocks.filter(block => block.by === 'user');
    assert.equal(manual.length, 1);
    assert.equal(manual[0]!.release_at, iso(START + 60 * MINUTE), 'a manual release_at is still routing business as usual');
    h.released('claude');
    const current = h.policy.snapshot();
    h.policy.save({ revision: current.revision, config: current.config, blocks: current.blocks.filter(block => block.by !== 'user') });
    await h.advance(30);
    assert.equal(h.stallBlocks().length, 1, 'and penalizes again once that block is gone');
    h.released();
    for (const task of h.tasks) task.dispatch = { ...task.dispatch!, engine: 'ghost' };
    await h.advance(30);
    assert.equal(h.stallBlocks().length, 0, 'an engine outside the policy cannot be blocked');
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('penalty state persists, and a restart reads the ladder back from weaver.db', async () => {
  const h = await harness({ probe: prober(() => FAIL).probe });
  try {
    await h.advance(6);
    const saved = readStall(h.statePath);
    assert.equal(saved.engines.claude.level, 1);
    assert.equal(saved.engines.claude.blockedUntil, h.now() + 5 * MINUTE);
    assert.equal(saved.engines.claude.nextProbeAt, h.now() + 5 * MINUTE);
    assert.equal(saved.engines.claude.probeSuccesses, 0);
    assert.equal(saved.history.length, 1);
    assert.deepEqual(saved.history[0]!.tasks, h.tasks.map(task => task.id));
    assert.equal(saved.history[0]!.engine, 'claude');
    assert.equal(saved.history[0]!.stalledMinutes! >= 5, true);

    // A second process reads the ladder back.
    await h.advance(27);
    assert.equal(h.engine().level, 3);
    const reopened = new StallMonitor({ tasks: () => [], policy: () => h.policy, stateStore: stallStoreAt(h.statePath), cpu: cpu().reader, now: h.now });
    const restored = reopened.status().engines.claude!;
    assert.equal(restored.level, 3);
    assert.equal(restored.needsAttention, true);
    assert.equal(restored.lastTriggerAt, h.engine().lastTriggerAt);
    assert.deepEqual(restored.history.map(item => item.level), [1, 1, 2, 3], 'the trigger, then each failing probe at the level it answered for');
    assert.deepEqual(restored.history.map(item => item.tasks.length), [2, 0, 0, 0]);
    await reopened.stop();
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('persisted ladder levels and recovery streaks must be bounded integers', () => {
  const state = () => ({ version: 1, engines: { claude: emptyPenalty() }, history: [{ engine: 'claude', level: 1, at: START, tasks: [] }] });
  for (const value of [-1, 1.5, STALL_LADDER.length + 1]) {
    const engine = state();
    engine.engines.claude.level = value;
    assert.throws(() => parseStallState(engine), /Invalid stall level/, `engine level ${value}`);
    const history = state();
    history.history[0]!.level = value;
    assert.throws(() => parseStallState(history), /Invalid stall history level/, `history level ${value}`);
  }
  for (const value of [-1, 1.5, PROBE_SUCCESSES]) {
    const invalid = state();
    invalid.engines.claude.probeSuccesses = value;
    assert.throws(() => parseStallState(invalid), /Invalid stall probeSuccesses/, `streak ${value}`);
  }
  for (let level = 0; level <= STALL_LADDER.length; level += 1) {
    for (let streak = 0; streak < PROBE_SUCCESSES; streak += 1) {
      const valid = state();
      valid.engines.claude.level = valid.history[0]!.level = level;
      valid.engines.claude.probeSuccesses = streak;
      const { version, ...expected } = valid;
      assert.deepEqual(parseStallState(valid), expected, `level ${level}, streak ${streak}`);
    }
  }
});

test('every persisted timestamp must be representable by Date', () => {
  const state = () => ({ version: 1, engines: { claude: { ...emptyPenalty(), lastTriggerAt: START, blockedUntil: START, nextProbeAt: START } }, history: [{ engine: 'claude', level: 1, at: START, tasks: [] }] });
  const dateLimit = 8_640_000_000_000_000;
  for (const field of ['lastTriggerAt', 'blockedUntil', 'nextProbeAt', 'history at'] as const) {
    for (const value of [Number.MAX_VALUE, -Number.MAX_VALUE, dateLimit + 1, -dateLimit - 1]) {
      const invalid = state();
      if (field === 'history at') invalid.history[0]!.at = value;
      else invalid.engines.claude[field] = value;
      assert.throws(() => parseStallState(invalid), /Invalid stall/, `${field}: ${value}`);
    }
    for (const value of [-dateLimit, dateLimit]) {
      const valid = state();
      if (field === 'history at') valid.history[0]!.at = value;
      else valid.engines.claude[field] = value;
      const { version, ...expected } = valid;
      assert.deepEqual(parseStallState(valid), expected, `${field}: boundary ${value}`);
    }
  }
});

test('semantically damaged files rearm an existing penalty and release it only after a passing probe', async () => {
  for (const invalid of [{ level: 1.5 }, { level: 3, probeSuccesses: 1.5 }, { lastTriggerAt: Number.MAX_VALUE }]) {
    const h = await harness({ tasks: [] });
    const p = prober(call => call === 1 ? FAIL : PASS);
    const logs: string[] = [];
    let monitor: StallMonitor | undefined;
    try {
      h.block('claude', { by: STALL_BLOCK_BY });
      h.block('codex', { by: 'user' });
      const originalPolicy = h.policy.snapshot();
      seedStall(h.statePath, { version: 1, engines: { claude: { ...emptyPenalty(), level: 1, lastTriggerAt: START, ...invalid } }, history: [] });
      monitor = new StallMonitor({ tasks: () => [], policy: () => h.policy, stateStore: stallStoreAt(h.statePath, message => logs.push(message)), cpu: cpu().reader, probe: p.probe, now: h.now, log: message => logs.push(message) });
      assert.match(logs.join('\n'), /Stall state ignored/);
      assert.equal(monitor.status().engines.claude!.level, 0);
      await monitor.tick();
      const adopted = monitor.status().engines.claude!;
      assert.equal(adopted.level, 1);
      assert.equal(adopted.probeSuccesses, 0);
      assert.equal(adopted.nextProbeAt, iso(START + 5 * MINUTE));
      assert.equal(adopted.blocked, true);
      assert.equal(p.calls.length, 0, 'loading or adoption never invents a probe answer');
      assert.deepEqual(h.policy.snapshot(), originalPolicy, 'adoption preserves the existing blocks and configuration');
      await h.step(monitor, 4);
      assert.equal(p.calls.length, 0, 'the rearmed probe waits its full interval');
      await h.step(monitor, 1);
      assert.equal(p.calls.length, 1);
      assert.equal(monitor.status().engines.claude!.blocked, true, 'a failed probe leaves the penalty in force');
      assert.equal(monitor.status().engines.claude!.level, 2);
      await h.step(monitor, 10);
      assert.equal(p.calls.length, 2);
      assert.equal(monitor.status().engines.claude!.blocked, false);
      assert.deepEqual(monitor.status().engines.claude!.history.map(item => item.probe?.ok), [false, true]);
      assert.deepEqual(h.blocksOf('codex'), originalPolicy.blocks.filter(block => block.engine === 'codex'));
      assert.deepEqual(h.policy.snapshot().config, originalPolicy.config);
    } finally { await monitor?.stop(); await h.monitor.stop(); await h.cleanup(); }
  }
});

test('a stall file written before recovery probes still loads', async () => {
  const h = await harness();
  try {
    const legacy = {
      version: 1,
      engines: { claude: { level: 3, lastTriggerAt: START, needsAttention: true, blockedUntil: null } },
      history: [{ engine: 'claude', level: 3, at: START, tasks: ['1ebbfc8f-afc6-4b93-8916-06ec488fbd8a'], minutes: 41 }],
    };
    seedStall(h.statePath, legacy);
    const monitor = new StallMonitor({ tasks: () => h.tasks, policy: () => h.policy, stateStore: stallStoreAt(h.statePath), cpu: cpu().reader, now: h.now });
    const penalty = monitor.status().engines.claude!;
    assert.equal(penalty.level, 3);
    assert.equal(penalty.probeSuccesses, 0);
    assert.deepEqual(penalty.history, [{ engine: 'claude', level: 3, at: iso(START), tasks: ['1ebbfc8f-afc6-4b93-8916-06ec488fbd8a'], stalledMinutes: 41 }]);
    await monitor.stop();

    // A block the state cannot account for is armed and probed rather than left for a human forever.
    const p = prober(() => PASS);
    seedStall(h.statePath, { version: 1, engines: { claude: emptyPenalty() }, history: [] });
    h.block('claude', { by: STALL_BLOCK_BY });
    const adopted = new StallMonitor({ tasks: () => [], policy: () => h.policy, stateStore: stallStoreAt(h.statePath), cpu: cpu().reader, probe: p.probe, now: h.now, log: () => {} });
    await h.step(adopted, 1);
    assert.equal(adopted.status().engines.claude!.level, 1);
    assert.equal(adopted.status().engines.claude!.nextProbeAt, iso(h.now() + 5 * MINUTE));
    await h.step(adopted, 5);
    assert.equal(p.calls.length, 1);
    assert.equal(adopted.status().engines.claude!.blocked, false, 'the orphaned penalty was verified away');
    await adopted.stop();
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('the history keeps the last fifty records', async () => {
  const h = await harness();
  try {
    const seeded = { version: 1, engines: {}, history: Array.from({ length: 50 }, (_, index) => ({ engine: 'codex', level: 1, at: START - (50 - index) * MINUTE, tasks: [`seed-${index}`], stalledMinutes: 5 })) };
    seedStall(h.statePath, seeded);
    const monitor = new StallMonitor({ tasks: () => h.tasks, policy: () => h.policy, stateStore: stallStoreAt(h.statePath), cpu: cpu().reader, now: () => h.now(), log: () => {} });
    const before = readStall(h.statePath);
    assert.equal(before.history.length, 50, 'loading does not invent history');
    assert.equal(before.history[0].tasks[0], 'seed-0', 'loading does not invent or drop history');
    for (let minute = 0; minute < 6; minute += 1) { await h.step(monitor, 1); }
    const after = readStall(h.statePath);
    assert.equal(after.history.length, 50);
    assert.equal(after.history[0].tasks[0], 'seed-1', 'the oldest entry fell out');
    assert.equal(after.history.at(-1)!.engine, 'claude');
    assert.equal(after.engines.claude.level, 1);
    await monitor.stop();
  } finally { await h.monitor.stop(); await h.cleanup(); }
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
          h.policy.save({ revision: current.revision, config: current.config, blocks: [...current.blocks, { engine: 'codex', reason: '并发修改', since: iso(h.now()), by: 'user' }] });
          throw new Error('Settings changed; reload before saving');
        }
        return h.policy.save(input);
      },
    };
    let pumps = 0;
    const retried: string[] = [];
    const monitor = new StallMonitor({ tasks: () => h.tasks, policy: () => flaky, stateStore: stallStoreAt(h.statePath), cpu: cpu().reader, now: h.now, onBlocksChanged: () => { pumps += 1; }, log: message => retried.push(message) });
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
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('a recovery whose save fails is retried on the next probe, not claimed', async () => {
  const h = await harness({ probe: prober(() => PASS).probe });
  try {
    await h.advance(6);
    let broken = false;
    const flaky: StallPolicy = {
      snapshot: () => h.policy.snapshot(),
      save: input => { if (broken) throw new Error('disk is full'); return h.policy.save(input); },
    };
    const logs: string[] = [];
    const monitor = new StallMonitor({ tasks: () => h.tasks, policy: () => flaky, stateStore: stallStoreAt(h.statePath), cpu: cpu().reader, probe: prober(() => PASS).probe, now: h.now, log: message => logs.push(message) });
    broken = true;
    await h.step(monitor, 5);
    assert.equal(monitor.status().engines.claude!.blocked, true, 'a failed removal cannot claim recovery');
    assert.equal(monitor.status().engines.claude!.level, 1);
    assert.match(logs.join('\n'), /was not saved/);
    broken = false;
    await h.step(monitor, 1);
    assert.equal(monitor.status().engines.claude!.blocked, false, 'the next probe lifts it');
    assert.equal(monitor.status().engines.claude!.level, 1, 'and the ladder is still remembered');
    await monitor.stop();
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('a penalty that cannot be saved leaves the ladder untouched', async () => {
  const h = await harness();
  try {
    const broken: StallPolicy = { snapshot: () => h.policy.snapshot(), save: () => { throw new Error('disk is full'); } };
    const logs: string[] = [];
    const monitor = new StallMonitor({ tasks: () => h.tasks, policy: () => broken, stateStore: stallStoreAt(h.statePath), cpu: cpu().reader, now: h.now, log: message => logs.push(message) });
    await h.step(monitor, 6);
    assert.equal(h.stallBlocks().length, 0);
    assert.deepEqual(penalized(monitor.status()), []);
    assert.equal(h.pumps(), 0);
    assert.match(logs.join('\n'), /will be retried/);
    assert.match(logs.at(-1)!, /was not saved/);
    assert.equal(monitor.status().engines.claude!.level, 0, 'the next tick may try again');
    await monitor.stop();
  } finally { await h.monitor.stop(); await h.cleanup(); }
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
      stateStore: stallStoreAt(join(h.dir, 'once.db')),
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
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('start samples on a timer and stop ends it', async () => {
  const h = await harness();
  try {
    let reads = 0;
    let clock = START;
    const monitor = new StallMonitor({ tasks: () => h.tasks, policy: () => h.policy, stateStore: stallStoreAt(join(h.dir, 'timer.db')), now: () => (clock += 60_000), cpu: async () => { reads += 1; return 0; } });
    monitor.start(2);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(reads >= 4, `expected repeated samples, saw ${reads}`);
    await monitor.stop();
    const settled = reads;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(reads, settled, 'stop ends the timer');
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('the systemd reader degrades to null instead of guessing', async () => {
  // An unknown unit must not read as zero CPU, which would look idle and punish a healthy worker.
  assert.equal(await systemdCpuUsage('weaver-stall-test-missing.scope'), null);
});

test('taskHealth reports what the monitor itself saw', async () => {
  const idle = await harness();
  try {
    await idle.advance(4);
    const early = idle.monitor.taskHealth(idle.tasks[0]!);
    assert.equal(early.taskId, idle.tasks[0]!.id);
    assert.equal(early.state, 'waiting_model', 'silent and idle, but the stall window is not over');
    assert.equal(early.taskStatus, 'running');
    assert.equal(early.engine, 'claude');
    assert.equal(early.scopeUnit, idle.tasks[0]!.run!.scopeUnit);
    assert.equal(early.lastEventAt, idle.tasks[0]!.events.at(-1)!.at);
    assert.equal(early.silenceMs, 24 * MINUTE);
    assert.equal(early.cpuActive, false);
    assert.equal(early.cpuIdleMs, 3 * MINUTE, 'only observed intervals count');
    await idle.advance(2);
    assert.equal(idle.monitor.taskHealth(idle.tasks[0]!).state, 'stalled');
    assert.equal(idle.monitor.taskHealth(idle.tasks[1]!).state, 'stalled');
    assert.equal(idle.stallBlocks().length, 1, 'and the engine was penalized on the same verdict');
  } finally { await idle.monitor.stop(); await idle.cleanup(); }

  const busy = await harness({ busy: true });
  try {
    await busy.advance(10);
    const health = busy.monitor.taskHealth(busy.tasks[0]!);
    assert.equal(health.state, 'working');
    assert.equal(health.cpuActive, true);
    assert.equal(health.cpuIdleMs, 0);
    assert.equal(health.silenceMs! > STALL_MS, true, 'a busy scope can be silent for a long time');
    assert.equal(busy.stallBlocks().length, 0);
  } finally { await busy.monitor.stop(); await busy.cleanup(); }

  const blind = await harness({ unreadable: true });
  try {
    await blind.advance(30);
    const health = blind.monitor.taskHealth(blind.tasks[0]!);
    assert.equal(health.cpuActive, null);
    assert.equal(health.cpuIdleMs, null);
    assert.equal(health.state, 'waiting_model', 'unreadable CPU is never called a stall');
    assert.deepEqual(penalized(blind.status()), []);

    const unknown = blind.monitor.taskHealth(makeTask({ execution: 'mock', status: 'completed' }));
    assert.equal(unknown.state, 'ended');
    assert.equal(unknown.silenceMs, null);
    assert.equal(unknown.cpuActive, null);
    assert.equal(unknown.cpuIdleMs, null);
    assert.equal(unknown.scopeUnit, null);
    assert.equal(unknown.taskStatus, 'completed');
  } finally { await blind.monitor.stop(); await blind.cleanup(); }
});

test('getStall is a zero-arg RPC returning the ladder, its deadlines and its configuration', async () => {
  const p = prober(call => call <= 2 ? FAIL : PASS);
  const h = await harness({ probe: p.probe });
  try {
    assert.deepEqual(parseRpcBody({ method: 'getStall', args: [] }), { method: 'getStall', args: [] });
    assert.throws(() => parseRpcBody({ method: 'getStall', args: [{}] }), /Invalid argument arity/);
    assert.deepEqual(Object.keys(h.status().engines).sort(), ['claude', 'codex', 'grok', 'opencode', 'pi', 'qoder', 'zcode'], 'a configured engine without a penalty is level 0');
    assert.deepEqual(h.status().engines.grok, { level: 0, lastTriggerAt: null, needsAttention: false, blocked: false, blockedUntil: null, nextProbeAt: null, probeSuccesses: 0, history: [] });
    await h.advance(11);
    assert.deepEqual(h.status().config, { stallMinutes: 5, quorum: 2, ladder: [5, 10, null], resetHours: 2 });
    const claude = h.engine();
    assert.equal(claude.level, 2, 'the failed probe escalated');
    assert.equal(claude.blocked, true);
    assert.equal(claude.blockedUntil, iso(h.now() + 10 * MINUTE));
    assert.equal(claude.nextProbeAt, claude.blockedUntil);
    assert.deepEqual(claude.history.map(item => item.at), claude.history.map(item => item.at).slice().sort());
    assert.deepEqual(claude.history.map(item => item.tasks.length), [2, 0], 'the trigger names its tasks, the probe names none');
    assert.equal(claude.history[1]!.probe!.ok, false);
    assert.equal(typeof claude.history[1]!.at, 'string');
    await h.advance(10);
    assert.equal(h.engine().level, 3, 'the second failure needs attention');
    assert.equal(h.engine().needsAttention, true);
    assert.equal(PROBE_SUCCESSES, 3);
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

/* ------------------------------- what the owner review found missing ------------------------------- */

/** A real sayHi failure carries whatever the provider and the raw CLI said, credentials included. */
const LEAKY = 'HTTP 401 Unauthorized from https://dispatch:sekret@vendor.example.com/v1/messages\n'
  + ' Authorization: Bearer sk-liveabcdef123456, retry with api_key="live-private-key-1234" password=correct-horse';
const SECRETS = ['sk-liveabcdef123456', 'live-private-key-1234', 'correct-horse', 'sekret'];
/** A vendor ramble long enough that an unclipped one would be a log file inside the record. */
const RAMBLING = `raw CLI failure: Bearer sk-longlivedtoken9999 ${'noise '.repeat(2_000)}`;

test('a probe failure becomes one redacted bounded line, in status and on disk', async () => {
  const answers: { what: string; evidence: RegExp; secrets: string[]; probe: RecoveryProbe }[] = [
    { what: 'returned', evidence: /401/, secrets: SECRETS, probe: async () => ({ ok: false, ms: 1_200, error: LEAKY }) },
    { what: 'thrown', evidence: /401/, secrets: SECRETS, probe: async () => { throw new Error(LEAKY); } },
    { what: 'rambling', evidence: /raw CLI failure/, secrets: ['sk-longlivedtoken9999'], probe: async () => ({ ok: false, ms: 900, error: RAMBLING }) },
  ];
  for (const { what, evidence, secrets, probe } of answers) {
    const h = await harness({ probe });
    try {
      await h.advance(11);
      const failed = h.engine().history.at(-1)!;
      assert.equal(failed.probe?.ok, false, what);
      const line = String(failed.probe!.error);
      assert.ok(!/[\n\r]/.test(line), `${what}: one line, saw ${JSON.stringify(line).slice(0, 120)}`);
      assert.ok(line.length <= 201, `${what}: bounded, saw ${line.length} characters`);
      assert.match(line, evidence, `${what}: the failure itself stays readable evidence`);
      const saved = JSON.stringify(readStall(h.statePath));
      for (const secret of secrets) {
        assert.ok(!line.includes(secret), `${what}: ${secret} never reaches status`);
        assert.ok(!saved.includes(secret), `${what}: ${secret} never reaches the persisted record`);
      }
    } finally { await h.monitor.stop(); await h.cleanup(); }
  }
});

test('a two hundred strong squad leaves a record the state file can read back', async () => {
  const squad = Array.from({ length: 200 }, (_, index) => makeTask({ silentMs: 20 * MINUTE, scope: `squad-${index}` }));
  const h = await harness({ tasks: squad });
  const logs: string[] = [];
  try {
    await h.advance(6);
    const saved = readStall(h.statePath) as { history: { engine: string; tasks: string[]; taskCount: number }[] };
    const record = saved.history[0]!;
    assert.equal(record.engine, 'claude');
    assert.equal(record.taskCount, 200, 'the count says how many workers the evidence really covered');
    assert.ok(record.tasks.length <= 50, `the id list is bounded, saw ${record.tasks.length}`);
    assert.ok(record.tasks.length < record.taskCount, 'and it is the list that stopped early, not the squad');
    assert.ok(JSON.stringify(readStall(h.statePath)).length < 256 * 1024, 'a trigger is small enough to be read back');

    // A restart reads the bounded list and the ladder back whole.
    const note = (message: string): void => { logs.push(message); };
    const reopened = new StallMonitor({ tasks: () => squad, policy: () => h.policy, stateStore: stallStoreAt(h.statePath, note), cpu: cpu().reader, now: h.now, log: note });
    assert.equal(logs.length, 0, 'the saved state is not damaged goods');
    const restored = reopened.status().engines.claude!;
    assert.deepEqual(restored.history[0]!.tasks, record.tasks);
    assert.equal(restored.history[0]!.taskCount, 200);
    assert.equal(restored.level, 1);
    assert.equal(restored.nextProbeAt, iso(START + 11 * MINUTE));
    await reopened.stop();

    // Fifty records at that bound is the largest legal file, so the monitor must survive rewriting its own.
    const ids = Array.from({ length: 50 }, () => randomUUID());
    seedStall(h.statePath, {
      engines: {},
      history: Array.from({ length: 50 }, (_, index) => ({ engine: 'claude', level: 1, at: START - (50 - index) * MINUTE, tasks: ids, taskCount: ids.length, stalledMinutes: 26 })),
    });
    const full = new StallMonitor({ tasks: () => squad, policy: () => h.policy, stateStore: stallStoreAt(h.statePath, note), cpu: cpu().reader, now: h.now, log: note });
    await h.step(full, 1);
    assert.equal(logs.filter(message => /ignored|Unsupported|size limit/.test(message)).length, 0, 'a full history is not a damaged file');
    assert.ok(JSON.stringify(readStall(h.statePath)).length < 256 * 1024, 'and rewriting it never overflowed past what the reader accepts');
    const reread = new StallMonitor({ tasks: () => squad, policy: () => h.policy, stateStore: stallStoreAt(h.statePath, note), cpu: cpu().reader, now: h.now, log: note });
    const kept = reread.status().engines.claude!;
    assert.equal(kept.history.length, 50, 'the engine keeps its fifty records');
    assert.equal(kept.history.at(-1)!.tasks.length, 50);
    assert.equal(kept.level, 1, 'the penalty the policy still holds was adopted, not invented away');
    await reread.stop();
    await full.stop();
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('stop fences in-flight work by itself, with no ready callback in the picture', async () => {
  for (const rejectOnAbort of [false, true]) {
    const waiting = pendingProbe({ rejectOnAbort });
    // ready is absent on purpose: only the monitor's own stop() can fence the answer here.
    const h = await harness({ ready: false, probe: waiting.probe });
    try {
      await h.advance(10);
      h.later(1);
      const before = JSON.stringify(readStall(h.statePath));
      const running = h.tick();
      await awaited(waiting.inFlight, 'probe');
      await h.monitor.stop();
      await running;
      assert.equal(waiting.signals[0]!.aborted, true, `rejected=${rejectOnAbort}: the greeting was aborted`);
      assert.equal(h.engine().level, 1, 'an aborted greeting is not a failed probe');
      assert.equal(h.engine().nextProbeAt, iso(START + 11 * MINUTE), 'its deadline was not moved on');
      assert.equal(probesOf(h).length, 0, 'and it never became history');
      assert.equal(h.stallBlocks().length, 1, 'the penalty is still the one that was written before stop');
      assert.equal(JSON.stringify(readStall(h.statePath)), before, 'nothing was persisted after stop');
      assert.equal(h.pumps(), 1, 'and nothing re-routed');

      // A stopped monitor ignores manual ticks; start() is what resumes the contract.
      h.later(11);
      await h.tick();
      assert.equal(waiting.calls(), 1, 'a manual tick after stop does not probe');
      h.monitor.start(3_600_000);
      await until(() => waiting.calls() > 1, 'probe of the restarted monitor');
      waiting.settle(PASS);
      await until(() => h.engine().blocked === false, 'the restarted probe lifting the penalty it answered');
      assert.equal(h.engine().level, 1, 'a restarted monitor finishes the contract, it does not invent a new one');
      await h.monitor.stop();
    } finally { await h.monitor.stop(); await h.cleanup(); }
  }
});

test('stop fences a tick that is still reading CPU', async () => {
  const h = await harness();
  const hold = slowCpu();
  let sampling = false;
  const reader: CpuReader = async unit => (sampling ? hold.reader(unit) : 0);
  let clock = START;
  let pumps = 0;
  try {
    const monitor = new StallMonitor({
      tasks: () => h.tasks, policy: () => h.policy, stateStore: stallStoreAt(join(h.dir, 'stopped.db')),
      cpu: reader, now: () => (clock += 5 * MINUTE), onBlocksChanged: () => { pumps += 1; }, log: () => {},
    });
    await monitor.tick();
    // One more idle interval and this tick writes a penalty: exactly the write a stop has to fence.
    sampling = true;
    const running = monitor.tick();
    await awaited(hold.sampling, 'CPU read');
    const stopping = monitor.stop();
    hold.release();
    await Promise.all([running, stopping]);
    assert.equal(h.stallBlocks().length, 0, 'the samples never became a block');
    assert.equal(pumps, 0);
    assert.equal(existsSync(join(h.dir, 'stopped.v1.json')), false, 'and nothing was persisted either');
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('the user unblock of an engine drops every block naming it, and keeps everyone elses', async () => {
  const h = await harness({ probe: prober(() => FAIL).probe });
  try {
    await h.advance(11);
    assert.equal(h.engine().level, 2);
    // The engine-level slot is the penalty's own; what else can pile on it are model level pauses.
    h.block('claude', { by: 'user', model: 'sonnet', release_at: iso(h.now() + 30 * MINUTE) });
    h.block('claude', { by: 'quota', model: 'opus' });
    h.block('codex', { by: 'user' });
    h.block('codex', { by: 'quota', model: 'gpt-6.1-sol' });
    const config = h.policy.snapshot().config;
    const history = h.engine().history;
    const pumps = h.pumps();

    h.monitor.unblock('claude');
    assert.deepEqual(h.blocksOf('claude'), [], 'the penalty, the manual pause and the model pause all go');
    assert.equal(h.blocksOf('codex').length, 2, 'another engine keeps every block it was given');
    assert.deepEqual(h.policy.snapshot().config, config, 'the unblock is about blocks, not about the config');
    assert.equal(h.engine().level, 0);
    assert.equal(h.engine().lastTriggerAt, null);
    assert.equal(h.engine().blockedUntil, null);
    assert.equal(h.engine().nextProbeAt, null);
    assert.equal(h.engine().probeSuccesses, 0);
    assert.equal(h.engine().needsAttention, false);
    assert.deepEqual(h.engine().history, history, 'the evidence survives the recovery the user asked for');
    assert.equal(h.pumps(), pumps + 1, 'and the queue gets routed again');
    assert.equal(h.policy.preview({ owner: 'claude_owner', worker: 'claude_worker' }).worker, 'claude_worker');

    const saved = readStall(h.statePath);
    assert.deepEqual(saved.engines.claude, emptyPenalty(), 'a restart cannot resurrect the dropped ladder');
    assert.equal(saved.history.length, history.length, 'and the record was not rewritten either');

    // An unknown engine is refused before any of that happens.
    const state = JSON.stringify(readStall(h.statePath));
    const blocks = h.policy.snapshot().blocks;
    assert.throws(() => h.monitor.unblock('ghost'), /Unknown engine ghost/);
    assert.deepEqual(h.policy.snapshot().blocks, blocks, 'a refused unblock wrote no policy change');
    assert.equal(JSON.stringify(readStall(h.statePath)), state, 'and no stall state change');
    assert.equal(h.pumps(), pumps + 1);

    // Under a revision conflict the unblock re-reads: it drops its engine and keeps whatever arrived in between.
    let conflicted = 0;
    const racing: StallPolicy = {
      snapshot: () => h.policy.snapshot(),
      save: input => {
        if (conflicted === 0) {
          conflicted += 1;
          const current = h.policy.snapshot();
          // Somebody else routed a new engine out between this read and this write.
          h.policy.save({ revision: current.revision, config: current.config, blocks: [...current.blocks, { engine: 'opencode', reason: '并发修改', since: iso(h.now()), by: 'user' }] });
          throw new Error('Settings changed; reload before saving');
        }
        return h.policy.save(input);
      },
    };
    const second = new StallMonitor({ tasks: () => [], policy: () => racing, stateStore: stallStoreAt(h.statePath), cpu: cpu().reader, now: h.now, onBlocksChanged: () => {}, log: () => {} });
    second.unblock('codex');
    assert.deepEqual(h.blocksOf('codex'), [], 'the retried unblock still dropped its own engine');
    assert.equal(h.policy.snapshot().blocks.filter(block => block.engine === 'opencode').length, 1, 'and preserved the block that landed mid-flight');
    assert.deepEqual(h.blocksOf('claude'), [], 'the engine the user already recovered stays recovered');
    await second.stop();
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('a passing probe lifts only Weaver own penalty, never someone elses block', async () => {
  const h = await harness({ probe: prober(() => PASS).probe });
  try {
    h.block('claude', { by: 'user', model: 'sonnet', release_at: iso(h.now() + 60 * MINUTE) });
    await h.advance(6);
    assert.equal(h.stallBlocks().length, 1, 'a model level pause does not excuse the engine from its own penalty');
    await h.advance(5);
    assert.equal(h.stallBlocks().length, 0, 'the passing probe lifted the penalty');
    const left = h.blocksOf('claude');
    assert.deepEqual(left.map(block => block.by), ['user'], "the user's own block is exactly as they wrote it");
    assert.equal(left[0]!.model, 'sonnet');
    assert.equal(left[0]!.release_at, iso(START + 60 * MINUTE));
    assert.equal(h.engine().level, 1, 'and the ladder memory stays, because only the penalty was answered');
  } finally { await h.monitor.stop(); await h.cleanup(); }
});

test('a stall block the state never heard of is adopted onto the ladder and probed', async () => {
  const h = await harness({ tasks: [] });
  const logs: string[] = [];
  const p = prober(call => call === 1 ? FAIL : PASS);
  try {
    // Another process wrote the penalty; this state file does not exist, so it accounts for nothing.
    h.block('claude', { by: STALL_BLOCK_BY });
    h.block('codex', { by: 'user', release_at: iso(h.now() + 60 * MINUTE) });
    const monitor = new StallMonitor({
      tasks: () => [], policy: () => h.policy, stateStore: stallStoreAt(join(h.dir, 'orphan.db')),
      cpu: cpu().reader, probe: p.probe, now: h.now, log: message => logs.push(message),
    });
    await h.step(monitor, 5);
    assert.equal(p.calls.length, 0, 'the adopted penalty waits the first rung before anything is asked');
    assert.equal(monitor.status().engines.claude!.level, 1, 'it is adopted onto the conservative end of the ladder');
    assert.equal(monitor.status().engines.claude!.nextProbeAt, iso(START + 6 * MINUTE));
    assert.equal(monitor.status().engines.claude!.blocked, true);
    assert.match(logs.join('\n'), /Adopted/, 'and the owner is told the state file did not account for it');

    await h.step(monitor, 1);
    assert.equal(p.calls.length, 1, 'the deadline asks the engine for one light greeting');
    assert.equal(monitor.status().engines.claude!.level, 2, 'a failing probe escalates it like any other penalty');
    assert.equal(monitor.status().engines.claude!.blocked, true, 'and never removes it without an answer that passed');

    await h.step(monitor, 10);
    assert.equal(p.calls.length, 2);
    assert.equal(monitor.status().engines.claude!.blocked, false, 'the passing probe is what lifts the orphan');
    assert.deepEqual(monitor.status().engines.claude!.history.map(item => item.probe?.ok), [false, true]);
    const codex = h.blocksOf('codex');
    assert.deepEqual(codex.map(block => block.by), ['user'], 'a foreign block stayed exactly as it was');
    assert.equal(codex[0]!.release_at, iso(START + 60 * MINUTE), 'including its release time');
    await monitor.stop();
  } finally { await h.monitor.stop(); await h.cleanup(); }
});
