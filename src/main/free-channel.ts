// Free-channel probe: scheduled light probes of free_channel workers to renew free quota.
// Reuses the stall recovery ladder and its probe cadence; no second ladder is defined here.
import { object } from '../shared/validation';
import type { Block, Config, PolicySnapshot } from '../shared/contracts/policy';
import type { FreeChannelStatus, FreeWorkerStatus, ProbeOutcome } from '../shared/contracts/monitoring';
import { activeBlocks } from '../shared/policy/availability';
import { FREE_PROBE_BLOCK_BY, STALL_BLOCK_BY, VENDOR_BLOCK_BY, foreignBlockOn, isQuotaBlockBy, ownedOnRoute, reaches } from '../shared/policy/blocks';
import { freeChannelProbeSettings } from '../shared/policy/settings';
import { escalateEngineBlock } from './policy/routing';
import { classifyVendorError, vendorBlockReason } from './adapters/cli/vendor-errors';
import { PROBE_MS, PROBE_SUCCESSES, STALL_LADDER } from './domain/penalties';
import { armStall, ladderLive, ladderQuiet, nextLevel, nextVendorStep } from './monitors/ladder';
import { MonitorLifecycle } from './monitors/lifecycle';
import { PolicyBlockService, type BlockPolicy } from './policy/blocks';
import { boundedProbeError, boundedReason } from './redact-context';
import type { ProbeRoute } from './stall';
import { HISTORY_LIMIT, type FreeProbeState, type FreeProbeStore, type ProbeRecord, type WorkerProbe } from './storage/free-probe-state';
import type { VendorLadderStore } from './storage/vendor-limits';

const NO_PROBER = '本进程没有装载探测执行器，无法探测。';
const PROBE_TICK_MS = 60_000;

export type FreeRecoveryProbe = (route: ProbeRoute, signal: AbortSignal) => Promise<ProbeOutcome>;

/** The main-process policy writer, narrowed to what a penalty needs. */
export type FreeProbePolicy = BlockPolicy;

export const emptyWorkerProbe = (): WorkerProbe => ({ level: 0, lastTriggerAt: null, mode: null, needsAttention: false, blockedUntil: null, nextProbeAt: null, probeSuccesses: 0, head: '' });

/** A question is open while this monitor's own block is on record and the state still owes an answer to it: attention needed, a probe deadline, or a vendor-named release outstanding. */
export function pendingQuestion(item: WorkerProbe): boolean {
  return item.mode !== null && item.blockSince !== undefined && (item.needsAttention || item.blockedUntil !== null || item.nextProbeAt !== null);
}

/** Which block marker one mode's answer belongs to: penalties reuse their existing sources. */
export function modeBlockBy(mode: NonNullable<WorkerProbe['mode']>): string {
  return mode === 'stall' ? STALL_BLOCK_BY : mode === 'rate_limit' ? VENDOR_BLOCK_BY : FREE_PROBE_BLOCK_BY;
}

/** Only free_channel workers on enabled engines: probing shares the account a dispatch would take. */
export function freeProbeEligible(config: Config, id: string): boolean {
  const worker = config.workers[id];
  if (!worker || worker.free_channel !== true || !worker.enabled) return false;
  return config.engines[worker.engine]?.enabled === true;
}

/** The saved route of one free_channel worker. */
function probeRouteOf(config: Config, worker: string): ProbeRoute | undefined {
  const profile = config.workers[worker];
  const engine = profile ? config.engines[profile.engine] : undefined;
  if (!profile || !engine) return undefined;
  return { engine: profile.engine, kind: engine.kind, worker, model: profile.model, effort: profile.effort };
}

export interface FreeProbeInput { worker?: string }

export function parseFreeProbeInput(value: unknown): FreeProbeInput {
  if (value === undefined) return {};
  const raw = object(value);
  if (Object.keys(raw).some(key => key !== 'worker')) throw new Error('Unknown free probe field');
  if (raw.worker !== undefined) {
    if (typeof raw.worker !== 'string' || !raw.worker.trim() || raw.worker.length > 120) throw new Error('Invalid free probe worker');
    return { worker: raw.worker };
  }
  return {};
}

export interface FreeChannelProbeOptions {
  /** The saved policy. Every probe answer is judged against a fresh snapshot. */
  policy: () => FreeProbePolicy;
  /** weaver.db-backed state, so restarts keep the ladder and history. */
  stateStore: FreeProbeStore;
  /** The one vendor rate-limit ladder per worker. Dispatch failures step the same rows, so the two paths see each other. */
  vendorLadder: VendorLadderStore;
  /** The worker's own light greeting. Without it failures are recorded but no block is ever written. */
  probe?: FreeRecoveryProbe;
  now?: () => number;
  /** False while the app is starting or draining: no probe runs and no block is written. */
  ready?: () => boolean;
  /** Called after a policy block was written or lifted, so queued work re-routes. */
  onBlocksChanged?: () => void;
  log?: (message: string) => void;
}

/**
 * Probes every marked free_channel worker on a fixed cadence and per ladder deadline. One answer classifies
 * the route: vendor quota exhaustion bans this worker's engine+model with the free-probe marker (with the vendor's
 * own reset time when it gives one, held open by probes otherwise), vendor rate limits walk the vendor ladder,
 * any other failure walks the stall ladder, all model-scoped so the same engine's other models are untouched.
 * A passing probe lifts only blocks this monitor wrote; manual blocks are never lifted by a probe.
 */
export class FreeChannelProbeMonitor {
  private readonly clock: () => number;
  private readonly log: (message: string) => void;
  private state: FreeProbeState;
  private dirty = false;
  private changed = false;
  /** One probe per worker at any time; rounds and manual probes share it. */
  private readonly jobs = new Map<string, Promise<void>>();
  private startedAt = 0;
  private lastRoundAt: number | null = null;
  private readonly store: FreeProbeStore;
  /** Tick coalescing, the probes stop() can abort, and the stop fence; work that awaited past a stop writes nothing at all. */
  private readonly lifecycle: MonitorLifecycle;
  private readonly blocks: PolicyBlockService;

  constructor(private readonly options: FreeChannelProbeOptions) {
    this.clock = options.now ?? Date.now;
    this.log = options.log ?? (message => console.error(message));
    this.store = options.stateStore;
    this.lifecycle = new MonitorLifecycle(options.ready);
    this.blocks = new PolicyBlockService(options.policy, { log: this.log, onChanged: options.onBlocksChanged });
    this.state = this.store.load();
  }

  status(): FreeChannelStatus {
    const snapshot = this.options.policy().snapshot();
    const config = snapshot.config;
    const settings = freeChannelProbeSettings(config);
    const now = this.clock();
    const interval = settings.interval_minutes * 60_000;
    const workers: FreeWorkerStatus[] = [];
    const describe = (worker: string, item: WorkerProbe, eligible: boolean): FreeWorkerStatus => {
      const profile = config.workers[worker]!;
      const route = probeRouteOf(config, worker);
      const standing = this.standing(worker, item);
      const availability = route && eligible ? activeBlocks({ version: 1, blocks: snapshot.blocks }, now).find(block => reaches(block, route) && !isQuotaBlockBy(block.by)) : undefined;
      return {
        worker, engine: profile.engine, model: profile.model, probed: eligible,
        level: standing.level, mode: item.mode, needsAttention: item.needsAttention,
        lastTriggerAt: standing.lastTriggerAt === null ? null : new Date(standing.lastTriggerAt).toISOString(),
        blockedUntil: item.blockedUntil === null ? null : new Date(item.blockedUntil).toISOString(),
        nextProbeAt: item.nextProbeAt === null ? null : new Date(item.nextProbeAt).toISOString(),
        probeSuccesses: item.probeSuccesses,
        availability: { status: availability ? 'blocked' : 'available', ...(availability ? { reason: availability.reason, ...(availability.release_at ? { release_at: availability.release_at } : {}) } : {}) },
        history: this.state.history.filter(entry => entry.worker === worker).map(entry => ({ ...entry, at: new Date(entry.at).toISOString() })),
      };
    };
    const eligibleIds = Object.keys(config.workers).filter(id => freeProbeEligible(config, id));
    workers.length = 0;
    for (const worker of eligibleIds) workers.push(describe(worker, this.state.workers[worker] ?? emptyWorkerProbe(), true));
    for (const [worker, item] of Object.entries(this.state.workers)) {
      if (eligibleIds.includes(worker) || config.workers[worker] === undefined) continue;
      workers.push(describe(worker, item, false));
    }
    const dueAt = (this.lastRoundAt ?? this.startedAt) + interval;
    return {
      schedule: {
        enabled: settings.enabled, interval_minutes: settings.interval_minutes,
        lastRunAt: this.lastRoundAt === null ? null : new Date(this.lastRoundAt).toISOString(),
        nextRunAt: settings.enabled && this.startedAt ? new Date(dueAt).toISOString() : null,
      },
      workers,
    };
  }

  /** Concurrent ticks collapse into the one in flight; after stop() nothing ticks again until start(). */
  tick(): Promise<void> {
    if (this.lifecycle.stopped) return Promise.resolve();
    return this.lifecycle.coalesce(() => this.check());
  }

  start(everyMs = PROBE_TICK_MS): void {
    this.startedAt = this.clock();
    this.lastRoundAt = null;
    this.lifecycle.start(everyMs, () => this.tick(), error => this.log(`Free probe tick failed: ${error instanceof Error ? error.message : 'unknown error'}`));
  }

  /** Ends the probing contract on its own: probes in flight abort and write nothing after the fence. */
  stop(): Promise<void> {
    return this.lifecycle.stop();
  }

  /**
   * One immediate probe: the named free_channel worker, or every eligible one when none is named.
   * Eligibility is checked here, not per dispatch: unknown or unmarked workers are refused outright.
   */
  async probeNow(worker?: string): Promise<FreeChannelStatus> {
    const inFlight = this.lifecycle.inFlight;
    if (inFlight) await inFlight;
    if (this.lifecycle.stopped || !this.lifecycle.active()) throw new Error('Weaver 正在停止，探测已停止');
    const snapshot = this.options.policy().snapshot();
    const config = snapshot.config;
    const fence = this.lifecycle.generation;
    const targets = worker === undefined
      ? Object.keys(config.workers).filter(id => freeProbeEligible(config, id))
      : (verify(config, worker), [worker]);
    this.changed = false;
    for (const id of targets) {
      const route = probeRouteOf(config, id);
      if (!route || this.jobs.has(id)) continue;
      await this.probeOne(route, fence);
      if (!this.lifecycle.writable(fence)) break;
    }
    // The loop's breaks and the tail flush share one fence: a probe that awaited past a stop flushes nothing.
    if (this.dirty && this.lifecycle.writable(fence)) this.flushState();
    if (this.changed && this.lifecycle.writable(fence)) { this.changed = false; this.blocks.notifyChanged(); }
    return this.status();
  }

  private async check(): Promise<void> {
    if (!this.lifecycle.active()) return;
    const fence = this.lifecycle.generation;
    const snapshot = this.options.policy().snapshot();
    const config = snapshot.config;
    const settings = freeChannelProbeSettings(config);
    const now = this.clock();
    this.reconcile(snapshot, now);
    if (this.dirty) this.flushState();
    if (!settings.enabled) return;
    this.changed = false;
    const interval = settings.interval_minutes * 60_000;
    // Rounds follow the settings interval; recovery probes run as soon as their ladder deadline is due.
    const roundDue = now >= (this.lastRoundAt ?? this.startedAt) + interval;
    const list: string[] = [];
    for (const worker of Object.keys(config.workers).filter(id => freeProbeEligible(config, id))) {
      const item = this.state.workers[worker];
      const open = item !== undefined && pendingQuestion(item) && item.nextProbeAt !== null && item.nextProbeAt <= now;
      if (open || (roundDue && !pendingQuestion(item ?? emptyWorkerProbe()))) list.push(worker);
    }
    if (roundDue) this.lastRoundAt = now;
    for (const worker of list) {
      const route = probeRouteOf(config, worker);
      if (!route || this.jobs.has(worker)) continue;
      await this.probeOne(route, fence);
      // A greeting awaited on a model: nothing from here on may land after a drain.
      if (!this.lifecycle.writable(fence)) return;
    }
    if (this.dirty && this.lifecycle.writable(fence)) this.flushState();
    if (this.changed && this.lifecycle.writable(fence)) { this.changed = false; this.blocks.notifyChanged(); }
  }

  /**
   * The state half of the user's 「恢复派发」 (the blocks go through the unblock operation): every question of this
   * engine's workers whose block is gone resets now, exactly as the next tick's reconcile would do it.
   */
  resetEngine(engine: string): void {
    const snapshot = this.options.policy().snapshot();
    this.closeOrphanedQuestions(snapshot, this.clock(), engine);
    if (this.dirty) this.flushState();
  }

  /** The state half of the user's 「恢复派发」 for one worker: only this worker's question resets, and only if its block is gone. */
  resetWorker(engine: string, worker: string): void {
    const snapshot = this.options.policy().snapshot();
    if (snapshot.config.workers[worker]?.engine !== engine) return;
    this.closeOrphanedQuestions(snapshot, this.clock(), engine, worker);
    if (this.dirty) this.flushState();
  }

  /** Removing the block by hand is an explicit unblock: the whole question resets, the record stays. */
  private closeOrphanedQuestions(snapshot: PolicySnapshot, now: number, engine?: string, only?: string): void {
    const active = activeBlocks({ version: 1, blocks: snapshot.blocks }, now);
    const config = snapshot.config;
    for (const [worker, item] of Object.entries(this.state.workers)) {
      if (!item.mode || !item.blockSince) continue;
      if (!freeProbeEligible(config, worker)) continue;
      if (engine !== undefined && config.workers[worker]?.engine !== engine) continue;
      if (only !== undefined && worker !== only) continue;
      const route = probeRouteOf(config, worker);
      if (!route) continue;
      const by = modeBlockBy(item.mode);
      const own = active.find(block => ownedOnRoute(block, route, by));
      if (own) continue;
      this.state.workers[worker] = ladderLive(item.lastTriggerAt, now)
        ? { ...emptyWorkerProbe(), level: item.level, lastTriggerAt: item.lastTriggerAt, head: item.head }
        : emptyWorkerProbe();
      this.dirty = true;
      this.log(`已移除 ${worker} 的探测处理（阻断不再由本进程持有），恢复为健康`);
    }
  }

  /** The live policy is the authority on whether a question is still open, so user edits are picked up here. */
  private reconcile(snapshot: PolicySnapshot, now: number): void {
    const active = activeBlocks({ version: 1, blocks: snapshot.blocks }, now);
    const config = snapshot.config;
    this.closeOrphanedQuestions(snapshot, now);
    // Abuse-resilience: a free-probe block the policy holds but this state file never recorded is adopted.
    for (const block of active) {
      if (block.by !== FREE_PROBE_BLOCK_BY || block.model === undefined) continue;
      const worker = Object.keys(config.workers).find(id => {
        const profile = config.workers[id]!;
        return freeProbeEligible(config, id) && (block.worker === undefined || block.worker === id) && profile.engine === block.engine && profile.model === block.model;
      });
      if (!worker) continue;
      const item = this.state.workers[worker];
      if (item && pendingQuestion(item)) continue;
      const release = block.release_at ? Date.parse(block.release_at) : NaN;
      const held = Number.isFinite(release);
      this.state.workers[worker] = {
        ...emptyWorkerProbe(), level: item?.level || 1, lastTriggerAt: item?.lastTriggerAt ?? null,
        mode: 'quota', blockSince: block.since,
        blockedUntil: held ? release : null,
        nextProbeAt: held ? null : now + freeChannelProbeSettings(config).interval_minutes * 60_000,
      };
      this.dirty = true;
      this.log(`接管 ${worker} 的免费额度封禁（状态文件没有对应记录）`);
    }
    // A ladder that has been quiet past its reset window starts over.
    for (const [worker, item] of Object.entries(this.state.workers)) {
      if (item.mode === null && item.level > 0 && ladderQuiet(item.lastTriggerAt, now)) {
        this.state.workers[worker] = emptyWorkerProbe();
        this.dirty = true;
      }
    }
  }

  /** The ladder standing of one worker: a rate-limit question reads the shared vendor ladder, every other mode its own row. */
  private standing(worker: string, item: WorkerProbe): { level: number; lastTriggerAt: number | null } {
    if (item.mode !== 'rate_limit') return item;
    const ladder = this.options.vendorLadder.get(worker);
    return { level: ladder?.level ?? 0, lastTriggerAt: ladder?.lastTriggerAt ?? null };
  }

  /** One probe at a time per worker; a manual probe during a round returns the job already running. */
  private probeOne(route: ProbeRoute, fence: number): Promise<void> {
    const existing = this.jobs.get(route.worker);
    if (existing) return existing;
    const job = this.runProbe(route, fence).finally(() => { this.jobs.delete(route.worker); });
    this.jobs.set(route.worker, job);
    return job;
  }

  private async runProbe(route: ProbeRoute, fence: number): Promise<void> {
    const probe = this.options.probe;
    const { value: outcome, aborted } = await this.lifecycle.abortable<ProbeOutcome>(
      signal => probe ? probe(route, signal) : Promise.resolve({ ok: false, ms: 0, error: NO_PROBER }),
      error => ({ ok: false, ms: 0, error: error instanceof Error ? error.message : 'unknown error' }),
    );
    // A greeting that only exists because the abort fired is not evidence either way.
    if (aborted) return;
    if (!this.lifecycle.writable(fence)) return;
    this.apply(route, outcome);
  }

  /**
   * One answer: the block it writes or lifts, the vendor ladder step, this worker's question and the history line are
   * a single commit when the policy and the state tables share a connection. A throw leaves neither the database nor
   * this monitor's memory moved, so the next probe starts from where the answer found things.
   */
  private apply(route: ProbeRoute, outcome: ProbeOutcome): void {
    this.commit(() => this.judge(route, outcome));
  }

  private commit<T>(work: () => T): T {
    const state = structuredClone(this.state);
    const { dirty, changed } = this;
    try {
      return this.blocks.atomic(() => {
        const result = work();
        if (this.dirty) this.flushState();
        return result;
      }, this.store, this.options.vendorLadder);
    } catch (error) {
      this.state = state;
      this.dirty = dirty;
      this.changed = changed;
      throw error;
    }
  }

  private judge(route: ProbeRoute, outcome: ProbeOutcome): void {
    const now = this.clock();
    const failure = outcome.ok ? undefined : classifyVendorError(route.kind, outcome.error ?? '', now);
    const item = this.state.workers[route.worker] ?? emptyWorkerProbe();
    const record: ProbeRecord = {
      worker: route.worker, engine: route.engine, level: this.standing(route.worker, item).level, at: now,
      probe: { ok: outcome.ok, ms: outcome.ms, ...(outcome.error ? { error: boundedProbeError(outcome.error) } : {}) },
      ...(failure ? { classification: failure.kind } : {}),
    };
    if (outcome.ok) { this.recover(route, item, record); return; }
    if (!this.options.probe) {
      // No prober loaded: failures are recorded but nothing is ever banned for it.
      record.message = '未装载探测执行器，仅记录失败';
      this.push(record);
      return;
    }
    if (failure?.kind === 'quota') { this.ban(route, item, record, failure, now); return; }
    if (failure?.kind === 'rate_limit') { this.vendorLimit(route, item, record, failure, now); return; }
    this.stallPenalty(route, item, record, failure?.message ?? outcome.error ?? '', now);
  }

  /** A passing probe releases this monitor's own block by the rules of the ladder it followed. */
  private recover(route: ProbeRoute, item: WorkerProbe, record: ProbeRecord): void {
    const snapshot = this.options.policy().snapshot();
    const now = this.clock();
    const by = item.mode ? modeBlockBy(item.mode) : undefined;
    const own = by ? activeBlocks({ version: 1, blocks: snapshot.blocks }, now).find(block => ownedOnRoute(block, route, by)) : undefined;
    if (!own) {
      // Healthy at the moment the probe fired, or someone else now holds the route: nothing is ours to lift.
      this.state.workers[route.worker] = item.mode && item.blockSince ? emptyWorkerProbe() : { ...emptyWorkerProbe(), level: item.level, lastTriggerAt: item.lastTriggerAt, head: item.head };
      this.dirty = true;
      this.push(record);
      return;
    }
    if (item.mode === 'stall' && item.level >= STALL_LADDER.length && item.probeSuccesses + 1 < PROBE_SUCCESSES) {
      this.state.workers[route.worker] = { ...item, probeSuccesses: item.probeSuccesses + 1, nextProbeAt: now + PROBE_MS };
      this.dirty = true;
      this.push({ ...record, message: `连续成功 ${item.probeSuccesses + 1}/${PROBE_SUCCESSES}，继续按恢复间隔探测` });
      return;
    }
    if (this.removeBlock(route, by!)) {
      this.state.workers[route.worker] = { ...emptyWorkerProbe(), level: item.level, lastTriggerAt: item.lastTriggerAt, head: item.head };
      this.dirty = true;
      this.changed = true;
      const message = item.mode === 'quota'
        ? '免费额度探测成功，解除封禁'
        : item.mode === 'stall' && item.level >= STALL_LADDER.length ? '三次连续探测成功，解除惩罚' : '探测成功，解除阻断';
      this.push({ ...record, message });
      return;
    }
    // A failed removal leaves the question armed exactly as it was; the next round probes and lifts again.
    this.dirty = true;
  }

  /** Quota exhaustion: ban this worker's engine+model until the vendor names a time, then keep probing. */
  private ban(route: ProbeRoute, item: WorkerProbe, record: ProbeRecord, failure: NonNullable<ReturnType<typeof classifyVendorError>>, now: number): void {
    const settings = freeChannelProbeSettings(this.options.policy().snapshot().config);
    const reason = vendorBlockReason({ kind: 'quota', message: failure.message });
    const release = failure.retryAt ? Date.parse(failure.retryAt) : NaN;
    const written = this.writeBlock(route, FREE_PROBE_BLOCK_BY, reason, release > now ? failure.retryAt : undefined, now);
    if (!written) {
      // Somebody else already keeps this route out; this answer is only evidence in history.
      record.message = '已有其他来源的阻断，未写入免费额度封禁';
      this.push(record);
      this.dirty = true;
      return;
    }
    const held = Number.isFinite(release) && release > now;
    this.state.workers[route.worker] = {
      ...emptyWorkerProbe(), level: Math.max(item.level, 1), lastTriggerAt: now, mode: 'quota',
      head: record.probe.error ?? '', blockSince: written.since,
      blockedUntil: held ? release : null,
      nextProbeAt: held ? null : now + settings.interval_minutes * 60_000,
    };
    this.dirty = true;
    this.changed = true;
    record.block = { by: FREE_PROBE_BLOCK_BY, reason, since: written.since, ...(written.release_at ? { release_at: written.release_at } : {}) };
    record.message = held ? '封禁至供应商给出的重置时间' : '厂商未给出时间，保持封禁并按探测间隔继续探测';
    this.push(record);
  }

  /** Rate limiting: the vendor ladder dispatch failures already use, model-scoped to this worker. */
  private vendorLimit(route: ProbeRoute, item: WorkerProbe, record: ProbeRecord, failure: NonNullable<ReturnType<typeof classifyVendorError>>, now: number): void {
    const { level, minutes } = nextVendorStep(this.options.vendorLadder.get(route.worker), now);
    const retryAt = failure.retryAt ? Date.parse(failure.retryAt) : NaN;
    const release = Number.isFinite(retryAt) ? Math.max(retryAt, now + minutes * 60_000) : now + minutes * 60_000;
    const reason = vendorBlockReason({ kind: 'rate_limit', message: failure.message });
    const written = this.writeBlock(route, VENDOR_BLOCK_BY, reason, new Date(release).toISOString(), now, true);
    if (!written) {
      record.message = '已有其他来源的阻断，未写入限流阻断';
      this.push(record);
      this.dirty = true;
      return;
    }
    // The level and the trigger time live in the shared vendor ladder; this row only keeps the probe schedule.
    this.options.vendorLadder.put(route.worker, { level, lastTriggerAt: now });
    this.state.workers[route.worker] = {
      ...emptyWorkerProbe(), mode: 'rate_limit',
      head: record.probe.error ?? '', blockSince: written.since,
      blockedUntil: release, nextProbeAt: release,
    };
    this.dirty = true;
    this.changed = true;
    record.block = { by: VENDOR_BLOCK_BY, reason, since: written.since, release_at: written.release_at! };
    record.message = `限流阶梯第 ${level} 级，${Math.round((release - now) / 60_000)} 分钟后恢复探测`;
    this.push(record);
  }

  /** Every other failure: the stall ladder on this worker's engine+model, never on a policy deadline. */
  private stallPenalty(route: ProbeRoute, item: WorkerProbe, record: ProbeRecord, message: string, now: number): void {
    const level = nextLevel(item.level, item.lastTriggerAt, now, STALL_LADDER.length);
    const armed = armStall(level, now);
    const reason = boundedReason(message);
    const written = this.writeBlock(route, STALL_BLOCK_BY, reason, undefined, now);
    if (!written) {
      record.message = '已有其他来源的阻断，未写入惩罚';
      this.push(record);
      this.dirty = true;
      return;
    }
    this.state.workers[route.worker] = {
      ...emptyWorkerProbe(), level, lastTriggerAt: now, mode: 'stall',
      needsAttention: level >= STALL_LADDER.length, probeSuccesses: 0,
      head: record.probe.error ?? '', blockSince: written.since, ...armed,
    };
    this.dirty = true;
    this.changed = true;
    record.block = { by: STALL_BLOCK_BY, reason, since: written.since };
    record.message = `惩罚升级到第 ${level} 级`;
    this.push(record);
  }

  /**
   * Writes one worker-level block (also scoped to its model) for this worker, replacing only what this monitor owned on that route.
   * A foreign block (manual, or another monitor's whole-engine statement) means the route is already kept
   * out; no second block is stacked onto the same key. A replaced block keeps its original `since`.
   */
  private writeBlock(route: ProbeRoute, by: string, reason: string, release_at: string | undefined, now: number, escalate = false): Block | undefined {
    let final: Block | undefined;
    const { ok } = this.blocks.update(snapshot => {
      final = undefined;
      const blocks = snapshot.blocks;
      if (foreignBlockOn(blocks, route)) return blocks;
      const previous = blocks.find(block => ownedOnRoute(block, route));
      final = { engine: route.engine, model: route.model, worker: route.worker, reason, since: previous?.since ?? new Date(now).toISOString(), by, ...(release_at ? { release_at } : {}) };
      const written = [...blocks.filter(block => !ownedOnRoute(block, route)), final];
      // A rate limit that leaves no enabled worker on the engine usable takes the engine out as well.
      return escalate ? escalateEngineBlock(snapshot.config, written, route.engine, now) : written;
    }, { attempts: 2, failureLabel: 'Free probe policy change' });
    return ok && final ? final : undefined;
  }

  /** Removes only the block this monitor wrote with this marker on this route; anything else stays. */
  private removeBlock(route: ProbeRoute, by: string): boolean {
    return this.blocks.update(snapshot => snapshot.blocks.filter(block => !ownedOnRoute(block, route, by)), { attempts: 2, failureLabel: 'Free probe policy change' }).ok;
  }

  private push(record: ProbeRecord): void {
    this.state.history.push(record);
    if (this.state.history.length > HISTORY_LIMIT) this.state.history.splice(0, this.state.history.length - HISTORY_LIMIT);
    this.dirty = true;
  }

  private flushState(): void {
    this.store.save(this.state);
    this.dirty = false;
  }
}

function verify(config: Config, worker: string): void {
  if (!Object.hasOwn(config.workers, worker)) throw new Error(`Unknown worker ${worker}`);
  if (!freeProbeEligible(config, worker)) throw new Error(`Worker ${worker} 不是启用且标记 free_channel 的子 Agent，无法探测`);
}
