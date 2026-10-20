// Free-channel probe: scheduled light probes of free_channel workers to renew free quota.
// Reuses the stall recovery ladder and its probe cadence; no second ladder is defined here.
import { object } from '../shared/validation';
import type { Block, Config, PolicySnapshot } from '../shared/contracts/policy';
import type { FreeChannelStatus, FreeWorkerStatus, ProbeOutcome } from '../shared/contracts/monitoring';
import { activeBlocks } from '../shared/policy/availability';
import { freeChannelProbeSettings } from '../shared/policy/settings';
import { escalateEngineBlock } from './policy/routing';
import { classifyVendorError, vendorBlockReason } from './adapters/cli/vendor-errors';
import { LADDER_RESET_MS, PROBE_MS, PROBE_SUCCESSES, STALL_LADDER, VENDOR_LADDER_MINUTES } from './domain/penalties';
import { boundedProbeError, boundedReason } from './redact-context';
import { STALL_BLOCK_BY, type ProbeRoute } from './stall';
import { HISTORY_LIMIT, type FreeProbeState, type FreeProbeStore, type ProbeRecord, type WorkerProbe } from './storage/free-probe-state';

/** Quota bans written by this monitor. It releases only what it wrote; manual blocks stay. */
export const FREE_PROBE_BLOCK_BY = 'weaver-free-probe';
export const VENDOR_BLOCK_BY = 'weaver-vendor-limit';
const NO_PROBER = '本进程没有装载探测执行器，无法探测。';
const PROBE_TICK_MS = 60_000;

export type FreeRecoveryProbe = (route: ProbeRoute, signal: AbortSignal) => Promise<ProbeOutcome>;

/** The main-process policy writer, narrowed to what a penalty needs. */
export interface FreeProbePolicy {
  snapshot(): PolicySnapshot;
  save(input: unknown): PolicySnapshot;
}

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

/** Rate-limit escalation: quiet for LADDER_RESET_MS restarts the ladder, the trigger time stays. */
function nextLevel(item: WorkerProbe, now: number, cap: number): number {
  const base = item.lastTriggerAt !== null && now - item.lastTriggerAt < LADDER_RESET_MS ? item.level : 0;
  return Math.min(base + 1, cap);
}

/** Deadline and first recovery probe for one ladder stage; level null waits on pass alone. */
function armStall(level: number, now: number): Pick<WorkerProbe, 'blockedUntil' | 'nextProbeAt'> {
  const minutes = STALL_LADDER[level - 1];
  if (minutes === null) return { blockedUntil: null, nextProbeAt: now + PROBE_MS };
  const at = now + minutes * 60_000;
  return { blockedUntil: at, nextProbeAt: at };
}

/** The saved route of one free_channel worker. */
function probeRouteOf(config: Config, worker: string): ProbeRoute | undefined {
  const profile = config.workers[worker];
  const engine = profile ? config.engines[profile.engine] : undefined;
  if (!profile || !engine) return undefined;
  return { engine: profile.engine, kind: engine.kind, worker, model: profile.model, effort: profile.effort };
}

/** Does this block reach the route's worker? A worker-level block names exactly one worker. */
function reaches(block: Block, route: ProbeRoute): boolean {
  return block.engine === route.engine && (block.worker === undefined || block.worker === route.worker) && (block.model === undefined || block.model === route.model);
}

/** A block this monitor wrote for the route: its worker, its model and one of its markers. A pre-worker block (no worker field) on the same model is still recognised as ours. */
function owned(block: Block, route: ProbeRoute, by?: string): boolean {
  return block.engine === route.engine && block.model === route.model && (block.worker === route.worker || block.worker === undefined) &&
    (by !== undefined ? block.by === by : block.by === STALL_BLOCK_BY || block.by === VENDOR_BLOCK_BY || block.by === FREE_PROBE_BLOCK_BY);
}

/** Is this route currently kept out by a block that this monitor did not write? */
function foreignBlock(blocks: Block[], route: ProbeRoute): Block | undefined {
  return blocks.find(block => reaches(block, route) && !owned(block, route));
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
 * the route: vendor quota exhaustion bans this worker's engine+model via `weaver-free-probe` (with the vendor's
 * own reset time when it gives one, held open by probes otherwise), vendor rate limits walk the vendor ladder,
 * any other failure walks the stall ladder, all model-scoped so the same engine's other models are untouched.
 * A passing probe lifts only blocks this monitor wrote; manual blocks are never lifted by a probe.
 */
export class FreeChannelProbeMonitor {
  private readonly clock: () => number;
  private readonly log: (message: string) => void;
  private state: FreeProbeState;
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private changed = false;
  /** One probe per worker at any time; rounds and manual probes share it. */
  private readonly jobs = new Map<string, Promise<void>>();
  /** Probes in flight, so stop() can abort them. */
  private readonly aborts = new Set<AbortController>();
  /** Bumped by stop(); work that awaited past it writes nothing at all. */
  private fence = 0;
  private stopped = false;
  private startedAt = 0;
  private lastRoundAt: number | null = null;
  private readonly store: FreeProbeStore;

  constructor(private readonly options: FreeChannelProbeOptions) {
    this.clock = options.now ?? Date.now;
    this.log = options.log ?? (message => console.error(message));
    this.store = options.stateStore;
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
      const availability = route && eligible ? activeBlocks({ version: 1, blocks: snapshot.blocks }, now).find(block => reaches(block, route) && !block.by?.startsWith('weaver-quota:')) : undefined;
      return {
        worker, engine: profile.engine, model: profile.model, probed: eligible,
        level: item.level, mode: item.mode, needsAttention: item.needsAttention,
        lastTriggerAt: item.lastTriggerAt === null ? null : new Date(item.lastTriggerAt).toISOString(),
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
    if (this.running) return this.running;
    this.running = this.check().finally(() => { this.running = undefined; });
    return this.running;
  }

  start(everyMs = PROBE_TICK_MS): void {
    this.stopped = false;
    this.startedAt = this.clock();
    this.lastRoundAt = null;
    this.timer = setInterval(() => {
      void this.tick().catch(error => this.log(`Free probe tick failed: ${error instanceof Error ? error.message : 'unknown error'}`));
    }, everyMs);
    this.timer.unref();
  }

  /** Ends the probing contract on its own: probes in flight abort and write nothing after the fence. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.fence += 1;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    for (const controller of this.aborts) controller.abort();
    await this.running;
  }

  /**
   * One immediate probe: the named free_channel worker, or every eligible one when none is named.
   * Eligibility is checked here, not per dispatch: unknown or unmarked workers are refused outright.
   */
  async probeNow(worker?: string): Promise<FreeChannelStatus> {
    if (this.running) await this.running;
    if (!this.active()) throw new Error('Weaver 正在停止，探测已停止');
    const snapshot = this.options.policy().snapshot();
    const config = snapshot.config;
    const fence = this.fence;
    const targets = worker === undefined
      ? Object.keys(config.workers).filter(id => freeProbeEligible(config, id))
      : (verify(config, worker), [worker]);
    this.changed = false;
    for (const id of targets) {
      const route = probeRouteOf(config, id);
      if (!route || this.jobs.has(id)) continue;
      await this.probeOne(route, fence);
      if (!this.writable(fence)) break;
    }
    if (this.dirty) this.flushState();
    if (this.changed && this.writable(fence)) { this.changed = false; this.options.onBlocksChanged?.(); }
    return this.status();
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
      if (!this.writable(fence)) return;
    }
    if (this.dirty) this.flushState();
    if (this.changed && this.writable(fence)) { this.changed = false; this.options.onBlocksChanged?.(); }
  }

  /** The live policy is the authority on whether a question is still open, so user edits are picked up here. */
  private reconcile(snapshot: PolicySnapshot, now: number): void {
    const active = activeBlocks({ version: 1, blocks: snapshot.blocks }, now);
    const config = snapshot.config;
    for (const [worker, item] of Object.entries(this.state.workers)) {
      if (!item.mode || !item.blockSince) continue;
      if (!freeProbeEligible(config, worker)) continue;
      const route = probeRouteOf(config, worker);
      if (!route) continue;
      const by = modeBlockBy(item.mode);
      const own = active.find(block => owned(block, route, by));
      if (own) continue;
      // Removing the block by hand is an explicit unblock: the whole question resets, the record stays.
      this.state.workers[worker] = item.lastTriggerAt !== null && now - item.lastTriggerAt < LADDER_RESET_MS
        ? { ...emptyWorkerProbe(), level: item.level, lastTriggerAt: item.lastTriggerAt, head: item.head }
        : emptyWorkerProbe();
      this.dirty = true;
      this.log(`已移除 ${worker} 的探测处理（阻断不再由本进程持有），恢复为健康`);
    }
    // Abuse-resilience: a weaver-free-probe block the policy holds but this state file never recorded is adopted.
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
      if (item.mode === null && item.level > 0 && item.lastTriggerAt !== null && now - item.lastTriggerAt >= LADDER_RESET_MS) {
        this.state.workers[worker] = emptyWorkerProbe();
        this.dirty = true;
      }
    }
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
    const controller = new AbortController();
    this.aborts.add(controller);
    let outcome: ProbeOutcome;
    try {
      outcome = this.options.probe ? await this.options.probe(route, controller.signal) : { ok: false, ms: 0, error: NO_PROBER };
    } catch (error) {
      outcome = { ok: false, ms: 0, error: error instanceof Error ? error.message : 'unknown error' };
    } finally {
      this.aborts.delete(controller);
    }
    // A greeting that only exists because the abort fired is not evidence either way.
    if (controller.signal.aborted) return;
    if (!this.writable(fence)) return;
    this.apply(route, outcome);
  }

  private apply(route: ProbeRoute, outcome: ProbeOutcome): void {
    const now = this.clock();
    const failure = outcome.ok ? undefined : classifyVendorError(route.kind, outcome.error ?? '', now);
    const item = this.state.workers[route.worker] ?? emptyWorkerProbe();
    const record: ProbeRecord = {
      worker: route.worker, engine: route.engine, level: item.level, at: now,
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
    const own = by ? activeBlocks({ version: 1, blocks: snapshot.blocks }, now).find(block => owned(block, route, by)) : undefined;
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
    const level = nextLevel(item, now, VENDOR_LADDER_MINUTES.length);
    const minutes = VENDOR_LADDER_MINUTES[level - 1]!;
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
    this.state.workers[route.worker] = {
      ...emptyWorkerProbe(), level, lastTriggerAt: now, mode: 'rate_limit',
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
    const level = nextLevel(item, now, STALL_LADDER.length);
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

  /** One retry with a freshly read revision; a concurrent save must lose this monitor's intent. */
  private saveWithRetry(mutate: (blocks: Block[]) => Block[]): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = this.options.policy().snapshot();
      try {
        this.options.policy().save({ revision: snapshot.revision, config: snapshot.config, blocks: mutate(snapshot.blocks) });
        return true;
      } catch (error) {
        this.log(`Free probe policy change ${attempt === 0 ? 'will be retried' : 'was not saved'}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    return false;
  }

  /**
   * Writes one worker-level block (also scoped to its model) for this worker, replacing only what this monitor owned on that route.
   * A foreign block (manual, or another monitor's whole-engine statement) means the route is already kept
   * out; no second block is stacked onto the same key. A replaced block keeps its original `since`.
   */
  private writeBlock(route: ProbeRoute, by: string, reason: string, release_at: string | undefined, now: number, escalate = false): Block | undefined {
    let final: Block | undefined;
    const ok = this.saveWithRetry(blocks => {
      final = undefined;
      if (foreignBlock(blocks, route)) return blocks;
      const previous = blocks.find(block => owned(block, route));
      final = { engine: route.engine, model: route.model, worker: route.worker, reason, since: previous?.since ?? new Date(now).toISOString(), by, ...(release_at ? { release_at } : {}) };
      const written = [...blocks.filter(block => !owned(block, route)), final];
      // A rate limit that leaves no enabled worker on the engine usable takes the engine out as well.
      return escalate ? escalateEngineBlock(this.options.policy().snapshot().config, written, route.engine, now) : written;
    });
    return ok && final ? final : undefined;
  }

  /** Removes only the block this monitor wrote with this marker on this route; anything else stays. */
  private removeBlock(route: ProbeRoute, by: string): boolean {
    return this.saveWithRetry(blocks => blocks.filter(block => !owned(block, route, by)));
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
