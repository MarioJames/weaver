import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { object } from '../shared/validation';
import type { Config, PolicySnapshot } from '../shared/policy';
import type { Task } from '../shared/types';
import { redactContext } from './continuation';
import { activeBlocks, type Block } from './policy/routing';

/** Silence plus an idle scope for this long is a stall. */
export const STALL_MS = 5 * 60_000;
/** Below this share of one core over a sample interval, the worker scope counts as idle. */
export const CPU_IDLE_SHARE = 0.05;
/** Stalled tasks from one engine needed before the engine itself is considered unhealthy. */
export const STALL_QUORUM = 2;
/** Minutes a level 1 or 2 penalty waits before its recovery probe; null is level 3. */
export const STALL_LADDER: (number | null)[] = [5, 10, null];
/** Level 3 is probed on this cadence and never expires just because time passed. */
export const PROBE_MS = 10 * 60_000;
/** Consecutive passing probes needed before a level 3 penalty lifts on its own. */
export const PROBE_SUCCESSES = 3;
export const LADDER_RESET_MS = 2 * 60 * 60_000;
export const STALL_TICK_MS = 60_000;
export const STALL_BLOCK_BY = 'weaver-stall';
export const STALL_FILE = 'stall.v1.json';
/** What the retained record says when level 3 recovered without a human. */
export const STALL_RECOVERY = '自动恢复，请留意';
const HISTORY_LIMIT = 50;
/** How many of a trigger's task ids the record keeps: the count stays whole, the ids are bounded. */
const RECORD_TASKS_MAX = 50;
const STATE_LIMIT = 256 * 1024;
const PROBE_ERROR_MAX = 200;
const NO_WORKER = '这台引擎没有可用的工作代理，无法探测。';
const NO_HEAD = `${STALL_QUORUM} 个工作代理超过 ${STALL_MS / 60_000} 分钟无响应`;
/** 60s samples, enough to cover the stall window and the ladder's shortest penalty. */
const SAMPLE_LIMIT = 12;
const NS_PER_MS = 1_000_000;

export interface CpuSample { at: number; cpu: number | null }
/** Cumulative CPU of one worker scope in nanoseconds, or null when it cannot be read. */
export type CpuReader = (scopeUnit: string) => Promise<number | null>;
export type CpuSamples = Record<string, CpuSample[]>;

/** The light call a penalty is lifted with: one enabled worker's own route on the penalized engine. */
export interface ProbeRoute { engine: string; kind: string; worker: string; model: string; effort: string }
export interface ProbeOutcome { ok: boolean; ms: number; error?: string }
export type RecoveryProbe = (route: ProbeRoute, signal: AbortSignal) => Promise<ProbeOutcome>;

/** One line of the record: a trigger carries tasks, a probe carries its route and outcome, a recovery carries a message. */
export interface StallRecord {
  engine: string;
  level: number;
  at: number;
  /** The ids this record still names, at most RECORD_TASKS_MAX of them. */
  tasks: string[];
  /** How many tasks the evidence really covered, when the list above had to stop early. */
  taskCount?: number;
  stalledMinutes?: number;
  probe?: ProbeOutcome;
  model?: string;
  effort?: string;
  message?: string;
}

export interface EnginePenalty {
  level: number;
  lastTriggerAt: number | null;
  needsAttention: boolean;
  /** Nominal deadline of the current penalty. It is not a policy release time: no stall block ever expires on its own. */
  blockedUntil: number | null;
  nextProbeAt: number | null;
  /** Consecutive passing probes at level 3; any failure or escalation resets it. */
  probeSuccesses: number;
  /** The evidence the penalty was triggered with, so an escalation can restate the block honestly. */
  head: string;
}

export interface StallState { engines: Record<string, EnginePenalty>; history: StallRecord[] }

export interface StallStatus {
  engines: Record<string, {
    level: number;
    lastTriggerAt: string | null;
    needsAttention: boolean;
    /** Effective stall block in force in the policy right now. */
    blocked: boolean;
    blockedUntil: string | null;
    nextProbeAt: string | null;
    probeSuccesses: number;
    history: (Omit<StallRecord, 'at'> & { at: string })[];
  }>;
  config: { stallMinutes: number; quorum: number; ladder: (number | null)[]; resetHours: number };
}

/** What a running worker looks like from the outside: the monitor's own samples, no second classifier. */
export interface TaskHealth {
  taskId: string;
  state: 'working' | 'waiting_model' | 'stalled';
  taskStatus: Task['status'];
  engine: string | null;
  lastEventAt: string | null;
  silenceMs: number | null;
  cpuActive: boolean | null;
  cpuIdleMs: number | null;
  scopeUnit: string | null;
}

/** The main-process policy writer, narrowed to what a penalty needs. */
export interface StallPolicy {
  snapshot(): PolicySnapshot;
  save(input: unknown): PolicySnapshot;
}

export const emptyPenalty = (): EnginePenalty => ({ level: 0, lastTriggerAt: null, needsAttention: false, blockedUntil: null, nextProbeAt: null, probeSuccesses: 0, head: '' });
export const emptyState = (): StallState => ({ engines: {}, history: [] });

/** A penalty is in force while its block is out and something still has to happen: a probe, or the user. */
const pending = (penalty: EnginePenalty): boolean => penalty.needsAttention || penalty.nextProbeAt !== null;

/** Nominal deadline and first probe time for a penalty of this level. */
function arm(level: number, now: number): Pick<EnginePenalty, 'blockedUntil' | 'nextProbeAt'> {
  const minutes = STALL_LADDER[level - 1];
  if (minutes === null) return { blockedUntil: null, nextProbeAt: now + PROBE_MS };
  const at = now + minutes * 60_000;
  return { blockedUntil: at, nextProbeAt: at };
}

function reasonFor(head: string, level: number): string {
  const minutes = STALL_LADDER[level - 1];
  return minutes === null
    ? `${head}，连续第 ${level} 次出现，每 ${PROBE_MS / 60_000} 分钟探测一次，连续 ${PROBE_SUCCESSES} 次通过才自动恢复`
    : `${head}，第 ${level} 次惩罚性暂停，${minutes} 分钟后探测确认恢复`;
}

/** A vendor message is evidence, not a log file: credentials are stripped, then one bounded line, never the argv. */
function boundedProbeError(value: string): string {
  const line = redactContext(value).replace(/\s+/g, ' ').trim();
  return line.length > PROBE_ERROR_MAX ? `${line.slice(0, PROBE_ERROR_MAX)}…` : line;
}

/** Weaver's own penalty for an engine as a whole; a model-level block is somebody else's business. */
const isStallBlock = (block: Block, engine: string): boolean => block.engine === engine && block.model === undefined && block.by === STALL_BLOCK_BY;

/** Silence measured from the last event, falling back to when the run started. */
export function silenceMs(task: Task, now: number): number | null {
  if (task.status !== 'running' || task.dispatch?.execution !== 'real') return null;
  const at = task.events.at(-1)?.at ?? task.run?.startedAt;
  if (at === undefined || !Number.isFinite(Date.parse(at))) return null;
  return now - Date.parse(at);
}

/** Start of the newest consecutive idle run inside the samples; null when there is nothing to compare. */
export function idleSince(samples: CpuSample[] | undefined): number | null {
  if (!samples || samples.length < 2) return null;
  const latest = samples[samples.length - 1]!;
  let from = latest.at;
  for (let index = samples.length - 1; index > 0; index -= 1) {
    const later = samples[index]!, earlier = samples[index - 1]!;
    const elapsed = later.at - earlier.at;
    // A busy interval ends the idle run, and so does any sample that cannot prove otherwise.
    if (later.cpu === null || earlier.cpu === null || later.cpu < earlier.cpu || elapsed <= 0) return from;
    if (later.cpu - earlier.cpu >= CPU_IDLE_SHARE * elapsed * NS_PER_MS) return from;
    from = earlier.at;
  }
  return from;
}

/** A real run is stalled only when it has been silent and CPU-idle for STALL_MS of observed intervals. */
export function isStalled(task: Task, now: number, samples: CpuSamples): boolean {
  if (!task.run?.scopeUnit) return false;
  const silence = silenceMs(task, now);
  if (silence === null || silence < STALL_MS) return false;
  const list = samples[task.id];
  const idle = idleSince(list);
  if (idle === null) return false;
  return list![list!.length - 1]!.at - idle >= STALL_MS;
}

export function stalledTasks(tasks: Task[], now: number, samples: CpuSamples = {}): Task[] {
  return tasks.filter(task => isStalled(task, now, samples));
}

/** Engines whose stalled task count reached STALL_QUORUM, in task list order. */
export function unhealthyEngines(tasks: Task[], now: number, samples: CpuSamples = {}): { engine: string; tasks: Task[] }[] {
  const groups = new Map<string, Task[]>();
  for (const task of stalledTasks(tasks, now, samples)) {
    const engine = task.dispatch!.engine;
    const group = groups.get(engine);
    if (group) group.push(task);
    else groups.set(engine, [task]);
  }
  return [...groups.entries()].filter(([, group]) => group.length >= STALL_QUORUM).map(([engine, group]) => ({ engine, tasks: group }));
}

/** null means no new penalty: one is already waiting for a probe or for the user. */
export function nextPenalty(state: StallState, engine: string, now: number, stalled: Task[]): { level: number; head: string; block: Block } | null {
  const penalty = state.engines[engine] ?? emptyPenalty();
  if (pending(penalty)) return null;
  const level = Math.min((penalty.lastTriggerAt !== null && now - penalty.lastTriggerAt >= LADDER_RESET_MS ? 0 : penalty.level) + 1, STALL_LADDER.length);
  const ids = stalled.slice(0, 4).map(task => task.id.slice(0, 8));
  const head = `${stalled.length} 个工作代理超过 ${STALL_MS / 60_000} 分钟无响应（task ${ids.join('、')}）`;
  // No release_at: only a passing probe or the user lifts this block.
  return { level, head, block: { engine, reason: reasonFor(head, level), since: new Date(now).toISOString(), by: STALL_BLOCK_BY } };
}

/** The probe reuses one enabled worker's configured route, so it proves the same account path a dispatch would take. */
function probeRoute(config: Config, engine: string): ProbeRoute | null {
  const target = config.engines[engine];
  if (!target?.enabled) return null;
  const worker = Object.entries(config.workers).find(([, item]) => item.enabled && item.engine === engine);
  if (!worker) return null;
  return { engine, kind: target.kind, worker: worker[0], model: worker[1].model, effort: worker[1].effort };
}

/** Is the scope burning CPU in its newest observed interval? Null when nothing was observed to compare. */
function cpuActive(samples: CpuSample[] | undefined): boolean | null {
  if (!samples || samples.length < 2) return null;
  const later = samples[samples.length - 1]!, earlier = samples[samples.length - 2]!;
  const elapsed = later.at - earlier.at;
  if (later.cpu === null || earlier.cpu === null || later.cpu < earlier.cpu || elapsed <= 0) return null;
  return later.cpu - earlier.cpu >= CPU_IDLE_SHARE * elapsed * NS_PER_MS;
}

/** Length of the newest idle run in observed intervals; null while nothing proves an interval was idle. */
function idleRunMs(samples: CpuSample[] | undefined): number | null {
  const active = cpuActive(samples);
  if (active === null) return null;
  if (active) return 0;
  const from = idleSince(samples);
  return from === null ? null : samples![samples!.length - 1]!.at - from;
}

function numberOr(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid stall ${name}`);
  return value;
}

function integerOr(value: unknown, name: string, max: number): number {
  const number = numberOr(value, name);
  if (!Number.isInteger(number) || number < 0 || number > max) throw new Error(`Invalid stall ${name}`);
  return number;
}

function timestampOr(value: unknown, name: string): number {
  const number = numberOr(value, name);
  if (!Number.isFinite(new Date(number).getTime())) throw new Error(`Invalid stall ${name}`);
  return number;
}

/** A stall record is either a trigger, a probe or a recovery; each keeps engine, level, time and task ids. */
function parseRecord(raw: unknown): StallRecord {
  const item = object(raw);
  if (typeof item.engine !== 'string' || !item.engine) throw new Error('Invalid stall history engine');
  if (!Array.isArray(item.tasks) || item.tasks.length > RECORD_TASKS_MAX || item.tasks.some(id => typeof id !== 'string')) throw new Error('Invalid stall history tasks');
  const record: StallRecord = { engine: item.engine, level: integerOr(item.level, 'history level', STALL_LADDER.length), at: timestampOr(item.at, 'history at'), tasks: item.tasks as string[] };
  // The count is what the evidence covered; an unbounded id list would be a file that cannot be read back.
  if (item.taskCount !== undefined) {
    if (!Number.isSafeInteger(item.taskCount) || (item.taskCount as number) < item.tasks.length) throw new Error('Invalid stall history taskCount');
    record.taskCount = item.taskCount as number;
  }
  // `minutes` is what this field was called before probes were recorded.
  const minutes = item.stalledMinutes ?? item.minutes;
  if (minutes !== undefined) record.stalledMinutes = numberOr(minutes, 'history minutes');
  if (item.probe !== undefined) {
    const probe = object(item.probe);
    record.probe = { ok: probe.ok === true, ms: numberOr(probe.ms, 'probe ms'), ...(typeof probe.error === 'string' ? { error: boundedProbeError(probe.error) } : {}) };
  }
  for (const key of ['model', 'effort', 'message'] as const) if (typeof item[key] === 'string') record[key] = item[key] as string;
  return record;
}

export function parseStallState(value: unknown): StallState {
  const data = object(value);
  if (data.version !== 1 || !data.engines || typeof data.engines !== 'object' || Array.isArray(data.engines)) throw new Error('Unsupported stall store');
  const engines: Record<string, EnginePenalty> = {};
  for (const [engine, raw] of Object.entries(object(data.engines))) {
    const item = object(raw);
    const penalty: EnginePenalty = {
      level: integerOr(item.level, 'level', STALL_LADDER.length),
      lastTriggerAt: item.lastTriggerAt === null ? null : timestampOr(item.lastTriggerAt, 'lastTriggerAt'),
      needsAttention: item.needsAttention === true,
      blockedUntil: item.blockedUntil === null ? null : timestampOr(item.blockedUntil, 'blockedUntil'),
      nextProbeAt: item.nextProbeAt === undefined || item.nextProbeAt === null ? null : timestampOr(item.nextProbeAt, 'nextProbeAt'),
      probeSuccesses: item.probeSuccesses === undefined ? 0 : integerOr(item.probeSuccesses, 'probeSuccesses', PROBE_SUCCESSES - 1),
      head: typeof item.head === 'string' ? item.head : '',
    };
    engines[engine] = penalty;
  }
  if (!Array.isArray(data.history) || data.history.length > HISTORY_LIMIT) throw new Error('Invalid stall history');
  return { engines, history: data.history.map(parseRecord) };
}

/** Private, atomically replaced like the other data-dir stores. A damaged file starts the ladder over. */
export function loadStallState(path: string, log: (message: string) => void): StallState {
  if (!existsSync(path)) return emptyState();
  try {
    if (statSync(path).size > STATE_LIMIT) throw new Error('Stall store exceeds its size limit');
    return parseStallState(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    log(`Stall state ignored: ${error instanceof Error ? error.message : 'unreadable'}`);
    return emptyState();
  }
}

export function saveStallState(path: string, state: StallState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, ...state }, null, 2), { mode: 0o600, flag: 'wx' });
    const fd = openSync(temp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export interface StallMonitorOptions {
  /** Live task list, newest first, same order the RPC returns. */
  tasks: () => Task[];
  policy: () => StallPolicy;
  statePath: string;
  cpu?: CpuReader;
  /** The engine's own light greeting. Without it nothing is probed and only the user can lift a penalty. */
  probe?: RecoveryProbe;
  now?: () => number;
  /** False while the app is starting or draining: no block is written outside the ready window. */
  ready?: () => boolean;
  /** Called after a penalty block was written or lifted, so queued work re-routes. */
  onBlocksChanged?: () => void;
  log?: (message: string) => void;
}

/**
 * Watches real worker scopes, pauses an engine that stalls several of them at once, and verifies recovery with a
 * probe before lifting the pause. It never cancels or kills a task, and no penalty expires because time passed.
 */
export class StallMonitor {
  private readonly clock: () => number;
  private readonly readCpu: CpuReader;
  private readonly log: (message: string) => void;
  private state: StallState;
  private samples = new Map<string, CpuSample[]>();
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  /** A block change this tick made the routing care about. */
  private changed = false;
  /** Probes in flight, so stop() can abort them. Ticks never overlap, so one engine has at most one. */
  private readonly aborts = new Set<AbortController>();
  /** Engines this tick must not punish again: the user just unblocked them, or a probe just recovered them. */
  private held = new Set<string>();
  /** False once stop() ran: a stopped monitor only resumes when start() is called again. */
  private stopped = false;
  /** Bumped by stop(). Work that awaited past it sees a different value and writes nothing at all. */
  private fence = 0;

  constructor(private readonly options: StallMonitorOptions) {
    this.clock = options.now ?? Date.now;
    this.readCpu = options.cpu ?? systemdCpuUsage;
    this.log = options.log ?? (message => console.error(message));
    this.state = loadStallState(options.statePath, this.log);
  }

  status(): StallStatus {
    const snapshot = this.options.policy().snapshot();
    const engines: StallStatus['engines'] = {};
    const record = (engine: string, penalty: EnginePenalty): void => {
      engines[engine] = {
        level: penalty.level,
        lastTriggerAt: penalty.lastTriggerAt === null ? null : new Date(penalty.lastTriggerAt).toISOString(),
        needsAttention: penalty.needsAttention,
        blocked: snapshot.blocks.some(block => isStallBlock(block, engine)),
        blockedUntil: penalty.blockedUntil === null ? null : new Date(penalty.blockedUntil).toISOString(),
        nextProbeAt: penalty.nextProbeAt === null ? null : new Date(penalty.nextProbeAt).toISOString(),
        probeSuccesses: penalty.probeSuccesses,
        history: this.state.history.filter(item => item.engine === engine).map(item => ({ ...item, at: new Date(item.at).toISOString() })),
      };
    };
    for (const engine of Object.keys(snapshot.config.engines)) record(engine, this.state.engines[engine] ?? emptyPenalty());
    for (const [engine, penalty] of Object.entries(this.state.engines)) if (!Object.hasOwn(engines, engine)) record(engine, penalty);
    return {
      engines,
      config: { stallMinutes: STALL_MS / 60_000, quorum: STALL_QUORUM, ladder: [...STALL_LADDER], resetHours: LADDER_RESET_MS / 3_600_000 },
    };
  }

  /** The engines page and the CLI read the same silence and idle samples the monitor judged the penalty with. */
  taskHealth(task: Task): TaskHealth {
    const now = this.clock();
    const samples = this.samples.get(task.id);
    const active = cpuActive(samples);
    const silence = silenceMs(task, now);
    const stalled = isStalled(task, now, Object.fromEntries(this.samples));
    return {
      taskId: task.id,
      state: stalled ? 'stalled' : silence !== null && silence >= STALL_MS && active !== true ? 'waiting_model' : 'working',
      taskStatus: task.status,
      engine: task.dispatch?.engine ?? null,
      lastEventAt: task.events.at(-1)?.at ?? task.run?.startedAt ?? null,
      silenceMs: silence,
      cpuActive: active,
      cpuIdleMs: idleRunMs(samples),
      scopeUnit: task.run?.scopeUnit ?? null,
    };
  }

  /**
   * The user's 「恢复派发」 for exactly one engine: everything keeping that engine out of routing goes, its ladder
   * and streak start over and the record stays. Other engines and the whole config are preserved, and an unknown
   * engine is rejected before anything is written. Only this manual path clears blocks it did not write; a
   * passing recovery probe still lifts nothing but Weaver's own penalty.
   */
  unblock(engine: string): void {
    const policy = this.options.policy();
    const snapshot = policy.snapshot();
    if (!Object.hasOwn(snapshot.config.engines, engine)) throw new Error(`Unknown engine ${engine}`);
    const owned = snapshot.blocks.filter(block => block.engine === engine);
    if (owned.length > 0 && !this.saveWithRetry(policy, blocks => blocks.filter(block => block.engine !== engine))) {
      throw new Error(`Blocks for ${engine} could not be removed`);
    }
    const penalty = this.state.engines[engine];
    if (penalty) this.state.engines[engine] = emptyPenalty();
    this.held.add(engine);
    saveStallState(this.options.statePath, this.state);
    if (owned.length > 0) this.options.onBlocksChanged?.();
  }

  /** Concurrent ticks collapse into the one in flight; after stop() nothing ticks again until start(). */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.check().finally(() => { this.running = undefined; });
    return this.running;
  }

  start(everyMs = STALL_TICK_MS): void {
    this.stopped = false;
    void this.tick().catch(error => this.log(`Stall tick failed: ${error instanceof Error ? error.message : 'unknown error'}`));
    this.timer = setInterval(() => {
      void this.tick().catch(error => this.log(`Stall tick failed: ${error instanceof Error ? error.message : 'unknown error'}`));
    }, everyMs);
    this.timer.unref();
  }

  /**
   * Ends the monitoring contract on its own: whatever this monitor was about to write, from a CPU read or a
   * greeting still in flight, is fenced here whether or not the app gave it a ready callback.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.fence += 1;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.aborts) controller.abort();
    await this.running;
  }

  private active(): boolean {
    return !this.options.ready || this.options.ready();
  }

  /** May this work still write? Its own stop() counts as much as the app draining. */
  private writable(fence: number): boolean {
    return !this.stopped && fence === this.fence && this.active();
  }

  private async check(): Promise<void> {
    if (!this.active()) return;
    const fence = this.fence;
    const tasks = this.options.tasks();
    const candidates = tasks.filter(task => task.status === 'running' && task.dispatch?.execution === 'real' && task.run?.scopeUnit);
    // Prune first: a task that left the running set can never be judged again.
    const live = new Set(candidates.map(task => task.id));
    for (const id of this.samples.keys()) if (!live.has(id)) this.samples.delete(id);
    const at = this.clock();
    await Promise.all(candidates.map(async task => {
      let cpu: number | null = null;
      try { cpu = await this.readCpu(task.run!.scopeUnit!); } catch { cpu = null; }
      const history = this.samples.get(task.id) ?? [];
      history.push({ at, cpu });
      this.samples.set(task.id, history.slice(-SAMPLE_LIMIT));
    }));

    const policy = this.options.policy();
    // Sampling awaited on systemd, so the write gate is re-checked before anything is written.
    if (!this.writable(fence)) return;
    const held = this.held;
    this.held = new Set();
    this.changed = false;
    this.reconcile(policy, at, held);
    // Awaited: a due penalty is only escalated, lifted or waited on after its own probe answered.
    await this.probeDue(policy, at, held, fence);
    // The greeting awaited on a model; nothing from here on may land after a stop.
    if (!this.writable(fence)) return;

    let penalized = false;
    const snapshot = policy.snapshot();
    const samples: CpuSamples = Object.fromEntries(this.samples);
    for (const group of unhealthyEngines(tasks, at, samples)) {
      // A recovery or an unblock that just happened is the user's or the probe's answer, not a new offence.
      if (held.has(group.engine)) continue;
      if (!Object.hasOwn(snapshot.config.engines, group.engine)) continue;
      // Another block already keeps this engine out of routing; stacking a penalty on top of it would collide.
      if (activeBlocks({ version: 1, blocks: snapshot.blocks }, at).some(block => block.engine === group.engine && block.model === undefined && block.by !== STALL_BLOCK_BY)) continue;
      const penalty = nextPenalty(this.state, group.engine, at, group.tasks);
      if (!penalty || !this.writeBlock(policy, penalty.block)) continue;
      this.trigger(group, penalty, at);
      penalized = true;
    }
    if (this.dirty) {
      saveStallState(this.options.statePath, this.state);
      this.dirty = false;
    }
    if (penalized || this.changed) this.options.onBlocksChanged?.();
  }

  /** The live policy is the authority on whether a penalty is still in force, so user edits are picked up here. */
  private reconcile(policy: StallPolicy, now: number, held: Set<string>): void {
    const blocks = activeBlocks({ version: 1, blocks: policy.snapshot().blocks }, now);
    for (const [engine, penalty] of Object.entries(this.state.engines)) {
      if (!blocks.some(block => isStallBlock(block, engine))) {
        // Removing the block by hand is an explicit unblock: the ladder starts over, the record stays.
        if (pending(penalty)) {
          this.state.engines[engine] = emptyPenalty();
          held.add(engine);
          this.dirty = true;
          continue;
        }
        // Nothing is in force and the ladder has been quiet past its reset window, so the level is history now.
        if (penalty.level > 0 && penalty.lastTriggerAt !== null && now - penalty.lastTriggerAt >= LADDER_RESET_MS) {
          this.state.engines[engine] = emptyPenalty();
          this.dirty = true;
        }
        continue;
      }
      // A block that is out always has a probe to run, even if the state lost its ladder to an older or damaged file.
      const level = Math.max(penalty.level, 1);
      const armed = pending(penalty) && penalty.nextProbeAt !== null ? {} : arm(level, now);
      const wanted: EnginePenalty = { ...penalty, ...armed, level, needsAttention: penalty.needsAttention || level >= STALL_LADDER.length };
      if (JSON.stringify(wanted) !== JSON.stringify(penalty)) {
        this.state.engines[engine] = wanted;
        this.dirty = true;
      }
    }
    // A penalty the policy still holds but the state never heard of (a missing or damaged file) would otherwise
    // sit there unrecoverable and unprobed forever, so it is adopted onto the ladder's first rung.
    for (const block of blocks) {
      if (block.model !== undefined || block.by !== STALL_BLOCK_BY || this.state.engines[block.engine]) continue;
      this.state.engines[block.engine] = { ...emptyPenalty(), level: 1, ...arm(1, now) };
      this.dirty = true;
      this.log(`Adopted the stall penalty for ${block.engine} that the state file did not account for`);
    }
  }

  private async probeDue(policy: StallPolicy, now: number, held: Set<string>, fence: number): Promise<void> {
    const probe = this.options.probe;
    if (!probe) return;
    const due = Object.keys(this.state.engines).filter(engine => {
      const at = this.state.engines[engine]!.nextProbeAt;
      return at !== null && at <= now;
    });
    await Promise.all(due.map(engine => this.probeEngine(policy, engine, now, probe, held, fence)));
  }

  private async probeEngine(policy: StallPolicy, engine: string, now: number, probe: RecoveryProbe, held: Set<string>, fence: number): Promise<void> {
    const penalty = this.state.engines[engine]!;
    const ours = (blocks: Block[]) => blocks.find(block => isStallBlock(block, engine));
    const route = probeRoute(policy.snapshot().config, engine);
    /** Which penalty this probe is answering: a replacement block is not ours to act on. */
    const tested = ours(activeBlocks({ version: 1, blocks: policy.snapshot().blocks }, now))?.since;
    const controller = new AbortController();
    this.aborts.add(controller);
    let outcome: ProbeOutcome;
    try {
      outcome = route ? await probe(route, controller.signal) : { ok: false, ms: 0, error: NO_WORKER };
    } catch (error) {
      outcome = { ok: false, ms: 0, error: error instanceof Error ? error.message : 'unknown error' };
    } finally {
      this.aborts.delete(controller);
    }
    // The probe awaited on a model: nothing may be written after draining began or the monitor was stopped.
    if (!this.writable(fence)) return;
    const live = this.state.engines[engine];
    const current = ours(activeBlocks({ version: 1, blocks: policy.snapshot().blocks }, now));
    // The user unblocked or another process replaced this penalty while the probe was running: not our answer.
    if (!live || !current || tested === undefined || current.since !== tested) return;
    if (live.level !== penalty.level || live.lastTriggerAt !== penalty.lastTriggerAt) return;
    this.push({
      engine, level: live.level, at: now, tasks: [],
      probe: { ok: outcome.ok, ms: outcome.ms, ...(outcome.error ? { error: boundedProbeError(outcome.error) } : {}) },
      ...(route ? { model: route.model, effort: route.effort } : {}),
    });
    if (!outcome.ok) {
      this.escalate(policy, engine, live, now);
      return;
    }
    if (live.level >= STALL_LADDER.length) {
      if (live.probeSuccesses + 1 < PROBE_SUCCESSES) {
        this.state.engines[engine] = { ...live, probeSuccesses: live.probeSuccesses + 1, nextProbeAt: now + PROBE_MS };
        this.dirty = true;
        return;
      }
    }
    // A failed removal leaves the penalty armed exactly as it was, so the next tick probes and lifts again.
    this.lift(policy, engine, live, now, held);
  }

  /** Recovery removes only Weaver's own block; the level and its trigger time stay, so the next one escalates. */
  private lift(policy: StallPolicy, engine: string, penalty: EnginePenalty, now: number, held: Set<string>): boolean {
    if (!this.saveBlocks(policy, engine, blocks => blocks)) return false;
    this.state.engines[engine] = { ...emptyPenalty(), level: penalty.level, lastTriggerAt: penalty.lastTriggerAt, head: penalty.head };
    if (penalty.level >= STALL_LADDER.length) this.push({ engine, level: penalty.level, at: now, tasks: [], message: STALL_RECOVERY });
    this.dirty = true;
    this.changed = true;
    held.add(engine);
    return true;
  }

  /** A probe that did not pass is evidence the engine is still unhealthy: one level up, right now. */
  private escalate(policy: StallPolicy, engine: string, penalty: EnginePenalty, now: number): void {
    const level = Math.min(penalty.level + 1, STALL_LADDER.length);
    this.state.engines[engine] = { level, lastTriggerAt: penalty.lastTriggerAt, needsAttention: level >= STALL_LADDER.length, probeSuccesses: 0, head: penalty.head, ...arm(level, now) };
    // The block is still what keeps the engine out of routing, so no pump: only its reason has to stay honest.
    this.writeBlock(policy, { engine, reason: reasonFor(penalty.head || NO_HEAD, level), since: new Date(now).toISOString(), by: STALL_BLOCK_BY });
    this.dirty = true;
  }

  private trigger(group: { engine: string; tasks: Task[] }, penalty: { level: number; head: string; block: Block }, now: number): void {
    const silences = group.tasks.map(task => silenceMs(task, now) ?? 0);
    this.state.engines[group.engine] = {
      level: penalty.level,
      lastTriggerAt: now,
      needsAttention: penalty.level >= STALL_LADDER.length,
      probeSuccesses: 0,
      head: penalty.head,
      ...arm(penalty.level, now),
    };
    this.push({
      engine: group.engine, level: penalty.level, at: now,
      tasks: group.tasks.slice(0, RECORD_TASKS_MAX).map(task => task.id),
      taskCount: group.tasks.length,
      stalledMinutes: Math.floor(Math.max(...silences) / 60_000),
    });
    this.dirty = true;
  }

  /**
   * One retry with a freshly read revision. A concurrent save must lose this monitor's intent, never anything
   * another writer added in between.
   */
  private saveWithRetry(policy: StallPolicy, mutate: (blocks: Block[]) => Block[]): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = policy.snapshot();
      try {
        policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: mutate(snapshot.blocks) });
        return true;
      } catch (error) {
        this.log(`Stall policy change ${attempt === 0 ? 'will be retried' : 'was not saved'}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    return false;
  }

  /** Rewrites only this engine's own penalty; every other block in the policy is kept as it was found. */
  private saveBlocks(policy: StallPolicy, engine: string, build: (blocks: Block[], previous: Block | undefined) => Block[]): boolean {
    return this.saveWithRetry(policy, blocks => {
      const previous = blocks.find(block => isStallBlock(block, engine));
      return build(blocks.filter(block => !isStallBlock(block, engine)), previous);
    });
  }

  private writeBlock(policy: StallPolicy, block: Block): boolean {
    return this.saveBlocks(policy, block.engine, (blocks, previous) => [...blocks, { ...block, since: previous?.since ?? block.since }]);
  }

  private push(record: StallRecord): void {
    this.state.history.push(record);
    if (this.state.history.length > HISTORY_LIMIT) this.state.history.splice(0, this.state.history.length - HISTORY_LIMIT);
    this.dirty = true;
  }
}

function runSystemctl(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile('systemctl', ['--user', ...args], { timeout: 4000, windowsHide: true }, (error, stdout) => {
      const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? '' });
    });
  });
}

function cgroupUsage(controlGroup: string): number | null {
  if (!controlGroup.startsWith('/') || controlGroup.includes('..')) return null;
  let text: string;
  try { text = readFileSync(join('/sys/fs/cgroup', controlGroup, 'cpu.stat'), 'utf8'); } catch { return null; }
  const usage = /^usage_usec (\d+)$/m.exec(text);
  return usage ? Number(usage[1]) * 1000 : null;
}

/** Cumulative scope CPU via systemd, falling back to the cgroup's own counter. */
export const systemdCpuUsage: CpuReader = async scopeUnit => {
  const unit = scopeUnit.endsWith('.scope') ? scopeUnit : `${scopeUnit}.scope`;
  const direct = await runSystemctl(['show', unit, '-p', 'CPUUsageNSec', '--value']);
  const value = direct.stdout.trim();
  if (direct.code === 0 && /^\d+$/.test(value)) return Number(value);
  const group = await runSystemctl(['show', unit, '-p', 'ControlGroup', '--value']);
  if (group.code !== 0) return null;
  return cgroupUsage(group.stdout.trim());
};
