import { workerChannelCandidates, type ChannelRoutingContext } from './policy/worker-channel-routing';
import { roleEngine } from '../shared/policy/channels';
import type { Config, Block } from '../shared/contracts/policy';
import type { ProbeOutcome, RunningCommand, StallStatus, TaskHealth } from '../shared/contracts/monitoring';
import type { Task } from '../shared/contracts/tasks';
import { activeBlocks } from '../shared/policy/availability';
import { STALL_BLOCK_BY, isEngineBlock, isStallEngineBlock } from '../shared/policy/blocks';
import { LADDER_RESET_MS, PROBE_MS, PROBE_SUCCESSES, STALL_LADDER } from './domain/penalties';
import { systemdCpuUsage, type CpuReader, type CpuSample } from './monitors/cpu';
import { bootTimeMs, clockTicks, observeProcessTree, pidInScope, readProcessSnapshots, type ProcessSnapshot, type TreeObservation } from './monitors/process-tree';
import { maxCommandMinutes } from '../shared/policy/settings';
import { armStall, ladderQuiet } from './monitors/ladder';
import { MonitorLifecycle } from './monitors/lifecycle';
import { PolicyBlockService, type BlockPolicy } from './policy/blocks';
import { boundedProbeError } from './redact-context';
import { HISTORY_LIMIT, RECORD_TASKS_MAX, type EnginePenalty, type StallRecord, type StallState, type StallStateStore } from './storage/stall-state';

/** Kept as a re-export: callers that imported health from the monitor keep working after the shared type move. */
export type { TaskHealth } from '../shared/contracts/monitoring';

/** Silence plus an idle scope for this long is a stall. */
export const STALL_MS = 5 * 60_000;
/** Below this share of one core over a sample interval, the worker scope counts as idle. */
export const CPU_IDLE_SHARE = 0.05;
/** Stalled tasks from one engine needed before the engine itself is considered unhealthy. */
export const STALL_QUORUM = 2;
export const STALL_TICK_MS = 60_000;
/** What the retained record says when level 3 recovered without a human. */
export const STALL_RECOVERY = '自动恢复，请留意';
const NO_WORKER = '这台引擎没有可用的子 Agent，无法探测。';
const NO_HEAD = `${STALL_QUORUM} 个子 Agent 超过 ${STALL_MS / 60_000} 分钟无响应`;
/** 60s samples, enough to cover the stall window and the ladder's shortest penalty. */
const SAMPLE_LIMIT = 12;
const NS_PER_MS = 1_000_000;

export type CpuSamples = Record<string, CpuSample[]>;

/** The light call a penalty is lifted with: one enabled worker's own route on the penalized engine. */
export interface ProbeRoute { channel: string; engine: string; kind: string; worker: string; model: string; effort: string }
export type RecoveryProbe = (route: ProbeRoute, signal: AbortSignal) => Promise<ProbeOutcome>;

/** The main-process policy writer, narrowed to what a penalty needs. */
export type StallPolicy = BlockPolicy & {routingContext?:()=>ChannelRoutingContext|undefined};

export const emptyPenalty = (): EnginePenalty => ({ level: 0, lastTriggerAt: null, needsAttention: false, blockedUntil: null, nextProbeAt: null, probeSuccesses: 0, head: '' });

/** A penalty is in force while its block is out and something still has to happen: a probe, or the user. */
const pending = (penalty: EnginePenalty): boolean => penalty.needsAttention || penalty.nextProbeAt !== null;

function reasonFor(head: string): string {
  // Recovery timing and task evidence have their own status fields and history.
  return head.replace(/（task .*$/, '').slice(0, 120);
}

/** Silence measured from the last event, falling back to when the run started. */
export function silenceMs(task: Task, now: number): number | null {
  if (task.status !== 'running' || task.dispatch?.execution !== 'real') return null;
  const at = task.events.at(-1)?.at ?? task.run?.startedAt;
  if (at === undefined || !Number.isFinite(Date.parse(at))) return null;
  return now - Date.parse(at);
}

/** One observed interval: true busy, false idle, null unreadable. Scope and tree evidence are ORed. */
function intervalBusy(earlier: CpuSample, later: CpuSample, elapsed: number): boolean | null {
  const scope = later.cpu === null || earlier.cpu === null || later.cpu < earlier.cpu
    ? null
    : later.cpu - earlier.cpu >= CPU_IDLE_SHARE * elapsed * NS_PER_MS;
  const hasTree = earlier.treeCpu !== undefined || later.treeCpu !== undefined;
  const tree = !hasTree ? null : later.treeCpu === null || later.treeCpu === undefined || earlier.treeCpu === null || earlier.treeCpu === undefined || later.treeCpu < earlier.treeCpu
    ? null
    : later.treeCpu - earlier.treeCpu >= CPU_IDLE_SHARE * elapsed * NS_PER_MS;
  // The process tree covers descendants that left this cgroup; either reader proving work means busy.
  if (scope === true || tree === true) return true;
  // Unreadable evidence, on either reader, never proves an idle interval.
  if (scope === null || (hasTree && tree === null)) return null;
  return false;
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
    if (elapsed <= 0 || intervalBusy(earlier, later, elapsed) !== false) return from;
    from = earlier.at;
  }
  return from;
}

/**
 * A real run is stalled when it has been silent and CPU-idle for STALL_MS of observed intervals.
 * A live command suppresses the stall; a command past its configured timeout is itself the verdict.
 */
export function isStalled(task: Task, now: number, samples: CpuSamples): boolean {
  if (!task.run?.scopeUnit) return false;
  const list = samples[task.id];
  const latest = list?.at(-1);
  if (latest?.commandTimedOut === true) return true;
  if (latest?.command) return false;
  const silence = silenceMs(task, now);
  if (silence === null || silence < STALL_MS) return false;
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
  const level = Math.min((ladderQuiet(penalty.lastTriggerAt, now) ? 0 : penalty.level) + 1, STALL_LADDER.length);
  const ids = stalled.slice(0, 4).map(task => task.id.slice(0, 8));
  const head = `${stalled.length} 个子 Agent 超过 ${STALL_MS / 60_000} 分钟无响应（task ${ids.join('、')}）`;
  // No release_at: only a passing probe or the user lifts this block.
  return { level, head, block: { engine, reason: reasonFor(head), since: new Date(now).toISOString(), by: STALL_BLOCK_BY } };
}

/** The probe reuses one enabled worker's configured route, so it proves the same account path a dispatch would take. */
function probeRoute(config: Config, engine: string, context?: ChannelRoutingContext): ProbeRoute | null {
  const target = config.engines[engine];
  if (!target?.enabled) return null;
  for(const [worker,item] of Object.entries(config.workers)) {
    if(!item.enabled||roleEngine(config,item)!==engine)continue;
    const available=workerChannelCandidates(config,[],worker,context).find(candidate=>candidate.eligible);
    const channel=available?.channel??item.channels.find(id=>config.channels[id]?.enabled&&(!context?.credentialsReady||context.credentialsReady(id)));
    if(channel)return {channel,engine,kind:target.kind,worker,model:item.model,effort:item.effort};
  }
  return null;
}

/** Is the worker burning CPU in its newest observed interval? Null when nothing was observed to compare. */
function cpuActive(samples: CpuSample[] | undefined): boolean | null {
  if (!samples || samples.length < 2) return null;
  const later = samples[samples.length - 1]!, earlier = samples[samples.length - 2]!;
  const elapsed = later.at - earlier.at;
  if (elapsed <= 0) return null;
  return intervalBusy(earlier, later, elapsed);
}

/** Length of the newest idle run in observed intervals; null while nothing proves an interval was idle. */
function idleRunMs(samples: CpuSample[] | undefined): number | null {
  const active = cpuActive(samples);
  if (active === null) return null;
  if (active) return 0;
  const from = idleSince(samples);
  return from === null ? null : samples![samples!.length - 1]!.at - from;
}

export interface StallMonitorOptions {
  /** Live task list, newest first, same order the RPC returns. */
  tasks: () => Task[];
  policy: () => StallPolicy;
  /** weaver.db-backed state, so restarts keep the ladder and history. */
  stateStore: StallStateStore;
  cpu?: CpuReader;
  /** Test seam: a fixed /proc snapshot replaces a live scan, and its pids are trusted as stated. */
  processes?: () => readonly ProcessSnapshot[];
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
  private dirty = false;
  /** A block change this tick made the routing care about. */
  private changed = false;
  /** Engines this tick must not punish again: the user just unblocked them, or a probe just recovered them. */
  private held = new Set<string>();
  private readonly store: StallStateStore;
  /** Tick coalescing, the probes stop() can abort, and the stop fence; stop() ends the contract whether or not the app gave a ready callback. */
  private readonly lifecycle: MonitorLifecycle;
  private readonly blocks: PolicyBlockService;

  constructor(private readonly options: StallMonitorOptions) {
    this.clock = options.now ?? Date.now;
    this.readCpu = options.cpu ?? systemdCpuUsage;
    this.log = options.log ?? (message => console.error(message));
    this.store = options.stateStore;
    this.lifecycle = new MonitorLifecycle(options.ready);
    this.blocks = new PolicyBlockService(options.policy, { log: this.log, onChanged: options.onBlocksChanged });
    this.state = this.store.load();
  }

  status(): StallStatus {
    const snapshot = this.options.policy().snapshot();
    const engines: StallStatus['engines'] = {};
    const record = (engine: string, penalty: EnginePenalty): void => {
      engines[engine] = {
        level: penalty.level,
        lastTriggerAt: penalty.lastTriggerAt === null ? null : new Date(penalty.lastTriggerAt).toISOString(),
        needsAttention: penalty.needsAttention,
        blocked: snapshot.blocks.some(block => isStallEngineBlock(block, engine)),
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

  /** Live /proc evidence: the default scans the kernel, tests may inject a table. */
  private processTable(): readonly ProcessSnapshot[] {
    return this.options.processes ? this.options.processes() : readProcessSnapshots();
  }

  /** The root pid participates only while its own cgroup still names this worker scope; never a reused pid. */
  private treeOf(task: Task, now: number): TreeObservation | null {
    const pid = task.run?.pid;
    const unit = task.run?.scopeUnit;
    if (!pid || !unit) return null;
    if (!this.options.processes && !pidInScope(pid, unit)) return null;
    return observeProcessTree(pid, this.processTable(), now, clockTicks(), bootTimeMs());
  }

  /** The newest sample with live command evidence folded in, so health never reports a command that has exited. */
  private healthSamples(task: Task, command: RunningCommand | null, timedOut: boolean): CpuSample[] | undefined {
    const base = this.samples.get(task.id);
    if (!base?.length) return base;
    const merged = base.slice();
    const latest = merged[merged.length - 1]!;
    merged[merged.length - 1] = { ...latest, command, commandTimedOut: timedOut };
    return merged;
  }

  /** The engines page and the CLI read the same silence and idle samples the monitor judged the penalty with. */
  taskHealth(task: Task): TaskHealth {
    // An owner root has no worker process of its own and never counts as stalled: the owner host is its answer.
    if (task.executionRole === 'owner') {
      const children = this.options.tasks().filter(child => child.parentTaskId === task.id);
      const state: TaskHealth['state'] = ['completed', 'failed', 'cancelled'].includes(task.status)
        ? 'ended'
        : task.ownerHost ? 'owner_running' : 'owner_starting';
      return {
        taskId: task.id,
        state,
        taskStatus: task.status,
        engine: null,
        lastEventAt: task.ownerLastActivityAt ?? task.events.at(-1)?.at ?? task.run?.startedAt ?? null,
        silenceMs: null,
        cpuActive: null,
        cpuIdleMs: null,
        scopeUnit: null,
        children: {
          total: children.length,
          running: children.filter(child => child.status === 'running' || child.status === 'cancelling').length,
          completed: children.filter(child => child.status === 'completed').length,
        },
      };
    }
    const now = this.clock();
    const command = task.status === 'running' ? this.treeOf(task, now)?.command ?? null : null;
    const maxMs = maxCommandMinutes(this.options.policy().snapshot().config) * 60_000;
    const timedOut = command !== null && command.elapsedMs >= maxMs;
    const samples = this.healthSamples(task, command, timedOut);
    const active = cpuActive(samples);
    const silence = silenceMs(task, now);
    const stalled = timedOut || isStalled(task, now, { [task.id]: samples ?? [] });
    return {
      taskId: task.id,
      state: ['completed','failed','cancelled'].includes(task.status) ? 'ended' : timedOut ? 'stalled' : task.status==='running'&&task.dispatch?.execution==='real'&&!task.run?.firstOutputAt ? 'starting' : stalled ? 'stalled' : command ? 'running_command' : silence !== null && silence >= STALL_MS && active !== true ? 'waiting_model' : 'working',
      taskStatus: task.status,
      engine: task.dispatch?.engine ?? null,
      lastEventAt: task.events.at(-1)?.at ?? task.run?.startedAt ?? null,
      silenceMs: silence,
      cpuActive: active,
      cpuIdleMs: idleRunMs(samples),
      scopeUnit: task.run?.scopeUnit ?? null,
      ...(command ? { runningCommand: command } : {}),
      ...(timedOut ? { reason: 'command_timeout' as const } : {}),
    };
  }

  /**
   * The state half of the user's 「恢复派发」 (the blocks go through the unblock operation): this engine's ladder and
   * streak start over, the record stays, and this tick cannot punish it again. Other engines are preserved.
   * The blocks are already gone when this runs, so a failed save must not leave the memory ahead of the database
   * unnoticed: the state stays dirty and the next tick writes it.
   */
  resetEngine(engine: string): void {
    const penalty = this.state.engines[engine];
    if (penalty) this.state.engines[engine] = emptyPenalty();
    this.held.add(engine);
    this.dirty = true;
    this.store.save(this.state);
    this.dirty = false;
  }

  /**
   * The state half of the user's 「恢复派发」 for one worker. The stall ladder is kept per engine, never per worker, so
   * there is no worker row to reset: the engine's ladder starts over only when no stall block of that engine is left in
   * the policy (the unblock just removed the last one), exactly as the next tick's reconcile would do it. While any
   * stall block stays, the other workers of the engine are still under that penalty and the ladder is left alone.
   */
  resetWorker(engine: string, worker: string): void {
    const snapshot = this.options.policy().snapshot();
    if ((snapshot.config.workers[worker] ? roleEngine(snapshot.config,snapshot.config.workers[worker]!) : undefined) !== engine) return;
    const stillHeld = activeBlocks({ version: 1, blocks: snapshot.blocks }, this.clock()).some(block => block.engine === engine && block.by === STALL_BLOCK_BY);
    const penalty = this.state.engines[engine];
    if (stillHeld || !penalty || !pending(penalty)) return;
    this.state.engines[engine] = emptyPenalty();
    this.held.add(engine);
    this.dirty = true;
    this.store.save(this.state);
    this.dirty = false;
  }

  /** Concurrent ticks collapse into the one in flight; after stop() nothing ticks again until start(). */
  tick(): Promise<void> {
    if (this.lifecycle.stopped) return Promise.resolve();
    return this.lifecycle.coalesce(() => this.check());
  }

  start(everyMs = STALL_TICK_MS): void {
    this.lifecycle.start(everyMs, () => this.tick(), error => this.log(`Stall tick failed: ${error instanceof Error ? error.message : 'unknown error'}`), true);
  }

  /**
   * Ends the monitoring contract on its own: whatever this monitor was about to write, from a CPU read or a
   * greeting still in flight, is fenced here whether or not the app gave it a ready callback.
   */
  stop(): Promise<void> {
    return this.lifecycle.stop();
  }

  private async check(): Promise<void> {
    if (!this.lifecycle.active()) return;
    const fence = this.lifecycle.generation;
    const tasks = this.options.tasks();
    const candidates = tasks.filter(task => task.status === 'running' && task.dispatch?.execution === 'real' && task.run?.scopeUnit);
    // Prune first: a task that left the running set can never be judged again.
    const live = new Set(candidates.map(task => task.id));
    for (const id of this.samples.keys()) if (!live.has(id)) this.samples.delete(id);
    const at = this.clock();
    const policy = this.options.policy();
    const maxCommandMs = maxCommandMinutes(policy.snapshot().config) * 60_000;
    // One /proc scan per tick serves every worker; individual systemd reads still run concurrently.
    const processes = this.processTable();
    const trusted = !this.options.processes;
    await Promise.all(candidates.map(async task => {
      let cpu: number | null = null;
      try { cpu = await this.readCpu(task.run!.scopeUnit!); } catch { cpu = null; }
      let tree: TreeObservation | null = null;
      const pid = task.run?.pid;
      if (pid && task.run?.scopeUnit && (!trusted || pidInScope(pid, task.run.scopeUnit))) tree = observeProcessTree(pid, processes, at);
      const command = tree?.command ?? null;
      const history = this.samples.get(task.id) ?? [];
      history.push({
        at, cpu,
        ...(pid ? { treeCpu: tree?.cpuNs ?? null } : {}),
        ...(pid ? { command, commandTimedOut: command !== null && command.elapsedMs >= maxCommandMs } : {}),
      });
      this.samples.set(task.id, history.slice(-SAMPLE_LIMIT));
    }));

    // Sampling awaited on systemd, so the write gate is re-checked before anything is written.
    if (!this.lifecycle.writable(fence)) return;
    const held = this.held;
    this.held = new Set();
    this.changed = false;
    this.reconcile(policy, at, held);
    // Awaited: a due penalty is only escalated, lifted or waited on after its own probe answered.
    await this.probeDue(policy, at, held, fence);
    // The greeting awaited on a model; nothing from here on may land after a stop.
    if (!this.lifecycle.writable(fence)) return;

    let penalized = false;
    const snapshot = policy.snapshot();
    const samples: CpuSamples = Object.fromEntries(this.samples);
    for (const group of unhealthyEngines(tasks, at, samples)) {
      // A recovery or an unblock that just happened is the user's or the probe's answer, not a new offence.
      if (held.has(group.engine)) continue;
      if (!Object.hasOwn(snapshot.config.engines, group.engine)) continue;
      // Another block already keeps this engine out of routing; stacking a penalty on top of it would collide.
      if (activeBlocks({ version: 1, blocks: snapshot.blocks }, at).some(block => isEngineBlock(block, group.engine) && block.by !== STALL_BLOCK_BY)) continue;
      const penalty = nextPenalty(this.state, group.engine, at, group.tasks);
      if (!penalty) continue;
      // The block and the ladder it starts are one commit: a failure between them leaves neither behind.
      const written = this.commit(() => {
        if (!this.writeBlock(penalty.block)) return false;
        this.trigger(group, penalty, at);
        return true;
      });
      if (!written) continue;
      penalized = true;
    }
    if (this.dirty) {
      this.store.save(this.state);
      this.dirty = false;
    }
    if (penalized || this.changed) this.blocks.notifyChanged();
  }

  /** The live policy is the authority on whether a penalty is still in force, so user edits are picked up here. */
  private reconcile(policy: StallPolicy, now: number, held: Set<string>): void {
    const blocks = activeBlocks({ version: 1, blocks: policy.snapshot().blocks }, now);
    for (const [engine, penalty] of Object.entries(this.state.engines)) {
      if (!blocks.some(block => isStallEngineBlock(block, engine))) {
        // Removing the block by hand is an explicit unblock: the ladder starts over, the record stays.
        if (pending(penalty)) {
          this.state.engines[engine] = emptyPenalty();
          held.add(engine);
          this.dirty = true;
          continue;
        }
        // Nothing is in force and the ladder has been quiet past its reset window, so the level is history now.
        if (penalty.level > 0 && ladderQuiet(penalty.lastTriggerAt, now)) {
          this.state.engines[engine] = emptyPenalty();
          this.dirty = true;
        }
        continue;
      }
      // A block that is out always has a probe to run, even if the state lost its ladder to an older or damaged file.
      const level = Math.max(penalty.level, 1);
      const armed = pending(penalty) && penalty.nextProbeAt !== null ? {} : armStall(level, now);
      const wanted: EnginePenalty = { ...penalty, ...armed, level, needsAttention: penalty.needsAttention || level >= STALL_LADDER.length };
      if (JSON.stringify(wanted) !== JSON.stringify(penalty)) {
        this.state.engines[engine] = wanted;
        this.dirty = true;
      }
    }
    // A penalty the policy still holds but the state never heard of (a missing or damaged file) would otherwise
    // sit there unrecoverable and unprobed forever, so it is adopted onto the ladder's first rung.
    for (const block of blocks) {
      if (block.model !== undefined || block.worker !== undefined || block.by !== STALL_BLOCK_BY || this.state.engines[block.engine]) continue;
      this.state.engines[block.engine] = { ...emptyPenalty(), level: 1, ...armStall(1, now) };
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
    const ours = (blocks: Block[]) => blocks.find(block => isStallEngineBlock(block, engine));
    const snapshot=policy.snapshot();
    const route = probeRoute(snapshot.config, engine,policy.routingContext?.());
    const diagnosticOnly=!route || (snapshot.config.workers[route.worker]!.channels.length>1 && !workerChannelCandidates(snapshot.config,snapshot.activeBlocks.filter(block=>!isStallEngineBlock(block,engine)),route.worker,policy.routingContext?.()).some(candidate=>candidate.channel===route.channel&&candidate.eligible));
    /** Which penalty this probe is answering: a replacement block is not ours to act on. */
    const tested = ours(activeBlocks({ version: 1, blocks: policy.snapshot().blocks }, now))?.since;
    const { value: outcome } = await this.lifecycle.abortable<ProbeOutcome>(
      signal => route ? probe(route, signal) : Promise.resolve({ ok: false, ms: 0, error: NO_WORKER }),
      error => ({ ok: false, ms: 0, error: error instanceof Error ? error.message : 'unknown error' }),
    );
    // The probe awaited on a model: nothing may be written after draining began or the monitor was stopped.
    if (!this.lifecycle.writable(fence)) return;
    const live = this.state.engines[engine];
    const current = ours(activeBlocks({ version: 1, blocks: policy.snapshot().blocks }, now));
    // The user unblocked or another process replaced this penalty while the probe was running: not our answer.
    if (!live || !current || tested === undefined || current.since !== tested) return;
    if (live.level !== penalty.level || live.lastTriggerAt !== penalty.lastTriggerAt) return;
    // The answer, the ladder it moves and the block it rewrites or removes are one commit.
    const lifted = this.commit(() => {
      this.push({
        engine, level: live.level, at: now, tasks: [],
        probe: { ok: outcome.ok, ms: outcome.ms, ...(outcome.error ? { error: boundedProbeError(outcome.error) } : {}) },
        ...(route ? { model: route.model, effort: route.effort } : {}),
      });
      if (!outcome.ok) {
        if(diagnosticOnly)live.nextProbeAt=now+PROBE_MS;
        else this.escalate(engine, live, now);
        return false;
      }
      if (live.level >= STALL_LADDER.length) {
        if (live.probeSuccesses + 1 < PROBE_SUCCESSES) {
          this.state.engines[engine] = { ...live, probeSuccesses: live.probeSuccesses + 1, nextProbeAt: now + PROBE_MS };
          this.dirty = true;
          return false;
        }
      }
      // A failed removal leaves the penalty armed exactly as it was, so the next tick probes and lifts again.
      return this.lift(engine, live, now);
    });
    if (lifted) {
      this.changed = true;
      held.add(engine);
    }
  }

  /** Recovery removes only Weaver's own block; the level and its trigger time stay, so the next one escalates. */
  private lift(engine: string, penalty: EnginePenalty, now: number): boolean {
    if (!this.saveBlocks(engine, blocks => blocks)) return false;
    this.state.engines[engine] = { ...emptyPenalty(), level: penalty.level, lastTriggerAt: penalty.lastTriggerAt, head: penalty.head };
    if (penalty.level >= STALL_LADDER.length) this.push({ engine, level: penalty.level, at: now, tasks: [], message: STALL_RECOVERY });
    this.dirty = true;
    return true;
  }

  /**
   * A probe that did not pass is evidence the engine is still unhealthy: one level up, right now. Runs inside commit():
   * when the block has to change and cannot be saved this throws, so the ladder, the record and the block stay as they
   * were and the same overdue probe is answered again.
   */
  private escalate(engine: string, penalty: EnginePenalty, now: number): void {
    const level = Math.min(penalty.level + 1, STALL_LADDER.length);
    // The block is still what keeps the engine out of routing, so no pump: only its reason has to stay honest.
    const block: Block = { engine, reason: reasonFor(penalty.head || NO_HEAD), since: new Date(now).toISOString(), by: STALL_BLOCK_BY };
    const saved = this.saveBlocks(engine, (blocks, previous) => previous?.reason === block.reason ? undefined : [...blocks, { ...block, since: previous?.since ?? block.since }]);
    if (!saved) throw new Error(`Stall escalation for ${engine} was not saved`);
    this.state.engines[engine] = { level, lastTriggerAt: penalty.lastTriggerAt, needsAttention: level >= STALL_LADDER.length, probeSuccesses: 0, head: penalty.head, ...armStall(level, now) };
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
      ...armStall(penalty.level, now),
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
   * Rewrites only this engine's own penalty; every other block in the policy is kept as it was found. One retry with
   * a freshly read revision: a concurrent save must lose this monitor's intent, never anything another writer added.
   * A build that returns undefined means the policy already says what is wanted: nothing is saved.
   */
  private saveBlocks(engine: string, build: (blocks: Block[], previous: Block | undefined) => Block[] | undefined): boolean {
    return this.blocks.update(snapshot => {
      const previous = snapshot.blocks.find(block => isStallEngineBlock(block, engine));
      return build(snapshot.blocks.filter(block => !isStallEngineBlock(block, engine)), previous);
    }, { attempts: 2, failureLabel: 'Stall policy change' }).ok;
  }

  private writeBlock(block: Block): boolean {
    return this.saveBlocks(block.engine, (blocks, previous) => [...blocks, { ...block, since: previous?.since ?? block.since }]);
  }

  /**
   * One change of blocks together with the ladder state that goes with it. The work and the state write run as a single
   * transaction when the policy and the state tables share a connection; if anything throws, neither the database nor
   * this monitor's memory moves, so the same evidence is handled again as if it had just arrived, and only once.
   */
  private commit<T>(work: () => T): T {
    const state = structuredClone(this.state);
    const dirty = this.dirty;
    try {
      return this.blocks.atomic(() => {
        const result = work();
        if (this.dirty) {
          this.store.save(this.state);
          this.dirty = false;
        }
        return result;
      }, this.store);
    } catch (error) {
      this.state = state;
      this.dirty = dirty;
      throw error;
    }
  }

  private push(record: StallRecord): void {
    this.state.history.push(record);
    if (this.state.history.length > HISTORY_LIMIT) this.state.history.splice(0, this.state.history.length - HISTORY_LIMIT);
    this.dirty = true;
  }
}
