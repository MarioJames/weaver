import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { object } from '../shared/validation';
import type { PolicySnapshot } from '../shared/policy';
import type { Task } from '../shared/types';
import { activeBlocks, type Block } from './policy/routing';

/** Silence plus an idle scope for this long is a stall. */
export const STALL_MS = 5 * 60_000;
/** Below this share of one core over a sample interval, the worker scope counts as idle. */
export const CPU_IDLE_SHARE = 0.05;
/** Stalled tasks from one engine needed before the engine itself is considered unhealthy. */
export const STALL_QUORUM = 2;
/** Penalty minutes per level; null means "blocked until a human says otherwise". */
export const STALL_LADDER: (number | null)[] = [5, 10, null];
export const LADDER_RESET_MS = 2 * 60 * 60_000;
export const STALL_TICK_MS = 60_000;
export const STALL_BLOCK_BY = 'weaver-stall';
export const STALL_FILE = 'stall.v1.json';
const HISTORY_LIMIT = 50;
const STATE_LIMIT = 256 * 1024;
/** 60s samples, enough to cover the stall window and the ladder's shortest penalty. */
const SAMPLE_LIMIT = 12;
const NS_PER_MS = 1_000_000;

export interface CpuSample { at: number; cpu: number | null }
/** Cumulative CPU of one worker scope in nanoseconds, or null when it cannot be read. */
export type CpuReader = (scopeUnit: string) => Promise<number | null>;
export type CpuSamples = Record<string, CpuSample[]>;

export interface StallTrigger { engine: string; level: number; at: number; tasks: string[]; minutes: number }
export interface EnginePenalty { level: number; lastTriggerAt: number | null; needsAttention: boolean; blockedUntil: number | null }
export interface StallState { engines: Record<string, EnginePenalty>; history: StallTrigger[] }

export interface StallStatus {
  engines: Record<string, { level: number; lastTriggerAt: string | null; needsAttention: boolean; history: (Omit<StallTrigger, 'at'> & { at: string })[] }>;
  config: { stallMinutes: number; quorum: number; ladder: (number | null)[]; resetHours: number };
}

/** The main-process policy writer, narrowed to what a penalty needs. */
export interface StallPolicy {
  snapshot(): PolicySnapshot;
  save(input: unknown): PolicySnapshot;
}

export const emptyPenalty = (): EnginePenalty => ({ level: 0, lastTriggerAt: null, needsAttention: false, blockedUntil: null });
export const emptyState = (): StallState => ({ engines: {}, history: [] });

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

/** null means no new penalty: the engine is still serving one, or is already waiting for the user. */
export function nextPenalty(state: StallState, engine: string, now: number, stalled: Task[]): { level: number; block: Block } | null {
  const penalty = state.engines[engine] ?? emptyPenalty();
  if (penalty.needsAttention) return null;
  if (penalty.blockedUntil !== null && penalty.blockedUntil > now) return null;
  const level = Math.min((penalty.lastTriggerAt !== null && now - penalty.lastTriggerAt >= LADDER_RESET_MS ? 0 : penalty.level) + 1, STALL_LADDER.length);
  const minutes = STALL_LADDER[level - 1] ?? null;
  const ids = stalled.slice(0, 4).map(task => task.id.slice(0, 8));
  const head = `${stalled.length} 个工作代理超过 ${STALL_MS / 60_000} 分钟无响应（task ${ids.join('、')}）`;
  const reason = minutes === null
    ? `${head}，连续第 ${level} 次出现，已停止自动恢复，需要人工查看`
    : `${head}，第 ${level} 次惩罚性暂停 ${minutes} 分钟`;
  const block: Block = { engine, reason, since: new Date(now).toISOString(), by: STALL_BLOCK_BY };
  if (minutes !== null) block.release_at = new Date(now + minutes * 60_000).toISOString();
  return { level, block };
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

function numberOr(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid stall ${name}`);
  return value;
}

export function parseStallState(value: unknown): StallState {
  const data = object(value);
  if (data.version !== 1 || !data.engines || typeof data.engines !== 'object' || Array.isArray(data.engines)) throw new Error('Unsupported stall store');
  const engines: Record<string, EnginePenalty> = {};
  for (const [engine, raw] of Object.entries(object(data.engines))) {
    const item = object(raw);
    const penalty: EnginePenalty = {
      level: numberOr(item.level, 'level'),
      lastTriggerAt: item.lastTriggerAt === null ? null : numberOr(item.lastTriggerAt, 'lastTriggerAt'),
      needsAttention: item.needsAttention === true,
      blockedUntil: item.blockedUntil === null ? null : numberOr(item.blockedUntil, 'blockedUntil'),
    };
    if (penalty.level < 0 || penalty.level > STALL_LADDER.length) throw new Error('Invalid stall level');
    engines[engine] = penalty;
  }
  if (!Array.isArray(data.history) || data.history.length > HISTORY_LIMIT) throw new Error('Invalid stall history');
  const history = data.history.map(raw => {
    const item = object(raw);
    if (typeof item.engine !== 'string' || !item.engine) throw new Error('Invalid stall history engine');
    if (!Array.isArray(item.tasks) || item.tasks.length > 50 || item.tasks.some(id => typeof id !== 'string')) throw new Error('Invalid stall history tasks');
    return { engine: item.engine, level: numberOr(item.level, 'history level'), at: numberOr(item.at, 'history at'), tasks: item.tasks as string[], minutes: numberOr(item.minutes, 'history minutes') };
  });
  return { engines, history };
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
  now?: () => number;
  /** False while the app is starting or draining: no block is written outside the ready window. */
  ready?: () => boolean;
  /** Called after a penalty block was written, so queued work re-routes. */
  onBlocksChanged?: () => void;
  log?: (message: string) => void;
}

/** Watches real worker scopes and pauses an engine that stalls several of them at once. It never cancels or kills a task. */
export class StallMonitor {
  private readonly clock: () => number;
  private readonly readCpu: CpuReader;
  private readonly log: (message: string) => void;
  private state: StallState;
  private samples = new Map<string, CpuSample[]>();
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;

  constructor(private readonly options: StallMonitorOptions) {
    this.clock = options.now ?? Date.now;
    this.readCpu = options.cpu ?? systemdCpuUsage;
    this.log = options.log ?? (message => console.error(message));
    this.state = loadStallState(options.statePath, this.log);
  }

  status(): StallStatus {
    const engines: StallStatus['engines'] = {};
    for (const [engine, penalty] of Object.entries(this.state.engines)) {
      engines[engine] = {
        level: penalty.level,
        lastTriggerAt: penalty.lastTriggerAt === null ? null : new Date(penalty.lastTriggerAt).toISOString(),
        needsAttention: penalty.needsAttention,
        history: this.state.history.filter(item => item.engine === engine).map(({ at, ...rest }) => ({ ...rest, at: new Date(at).toISOString() })),
      };
    }
    return {
      engines,
      config: { stallMinutes: STALL_MS / 60_000, quorum: STALL_QUORUM, ladder: [...STALL_LADDER], resetHours: LADDER_RESET_MS / 3_600_000 },
    };
  }

  /** Concurrent ticks collapse into the one in flight. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.check().finally(() => { this.running = undefined; });
    return this.running;
  }

  start(everyMs = STALL_TICK_MS): void {
    void this.tick().catch(error => this.log(`Stall tick failed: ${error instanceof Error ? error.message : 'unknown error'}`));
    this.timer = setInterval(() => {
      void this.tick().catch(error => this.log(`Stall tick failed: ${error instanceof Error ? error.message : 'unknown error'}`));
    }, everyMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  private active(): boolean {
    return !this.options.ready || this.options.ready();
  }

  private async check(): Promise<void> {
    if (!this.active()) return;
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
    // Sampling awaited on systemd, so the ready window is re-checked before anything is written.
    if (!this.active()) return;
    this.reconcile(policy, at);
    const snapshot = policy.snapshot();
    const samples: CpuSamples = Object.fromEntries(this.samples);
    let penalized = false;
    for (const group of unhealthyEngines(tasks, at, samples)) {
      if (!Object.hasOwn(snapshot.config.engines, group.engine)) continue;
      // Another block already keeps this engine out of routing; stacking a penalty on top of it would collide.
      if (activeBlocks({ version: 1, blocks: snapshot.blocks }, at).some(block => block.engine === group.engine && block.model === undefined && block.by !== STALL_BLOCK_BY)) continue;
      const penalty = nextPenalty(this.state, group.engine, at, group.tasks);
      if (!penalty || !this.writeBlock(policy, penalty.block)) continue;
      this.record(group, penalty, at);
      penalized = true;
    }
    if (this.dirty || penalized) {
      saveStallState(this.options.statePath, this.state);
      this.dirty = false;
    }
    if (penalized) this.options.onBlocksChanged?.();
  }

  /** The live policy is the authority on whether a penalty is still in force, so user edits are picked up here. */
  private reconcile(policy: StallPolicy, now: number): void {
    const blocks = activeBlocks({ version: 1, blocks: policy.snapshot().blocks }, now).filter(block => block.by === STALL_BLOCK_BY);
    for (const [engine, penalty] of Object.entries(this.state.engines)) {
      const block = blocks.find(item => item.engine === engine);
      // A removed or expired block releases the ladder; clearing an attention block resets the level too,
      // which is how "恢复派发" tells the monitor it may start over.
      const wanted: EnginePenalty = !block
        ? { ...penalty, blockedUntil: null, ...(penalty.needsAttention ? { needsAttention: false, level: 0, lastTriggerAt: null } : {}) }
        : { ...penalty, needsAttention: block.release_at === undefined, blockedUntil: block.release_at === undefined ? null : Date.parse(block.release_at) };
      if (JSON.stringify(wanted) !== JSON.stringify(penalty)) {
        this.state.engines[engine] = wanted;
        this.dirty = true;
      }
    }
  }

  /** One retry with a freshly read revision; a concurrent policy save must not lose the penalty. */
  private writeBlock(policy: StallPolicy, block: Block): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = policy.snapshot();
      const blocks = [...snapshot.blocks.filter(item => !(item.engine === block.engine && item.model === undefined && item.by === STALL_BLOCK_BY)), block];
      try {
        policy.save({ revision: snapshot.revision, config: snapshot.config, blocks });
        return true;
      } catch (error) {
        this.log(`Stall penalty for ${block.engine} ${attempt === 0 ? 'will be retried' : 'was not saved'}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    return false;
  }

  private record(group: { engine: string; tasks: Task[] }, penalty: { level: number; block: Block }, now: number): void {
    const minutes = penalty.block.release_at === undefined ? null : Math.round((Date.parse(penalty.block.release_at) - now) / 60_000);
    const stalled = group.tasks.map(task => silenceMs(task, now) ?? 0);
    this.state.engines[group.engine] = {
      level: penalty.level,
      lastTriggerAt: now,
      needsAttention: minutes === null,
      blockedUntil: minutes === null ? null : now + minutes * 60_000,
    };
    this.state.history.push({ engine: group.engine, level: penalty.level, at: now, tasks: group.tasks.map(task => task.id), minutes: Math.floor(Math.max(...stalled) / 60_000) });
    if (this.state.history.length > HISTORY_LIMIT) this.state.history.splice(0, this.state.history.length - HISTORY_LIMIT);
  }
}
