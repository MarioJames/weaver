import type { Block, PolicySnapshot } from '../../shared/contracts/policy';
import { withoutWorkerBlocks } from './routing';
import { sameConnection, type Transactional } from '../storage/transaction';

/** What the service needs from the policy store; the real PolicyStore satisfies it, and so does a fake with just these two. */
export interface BlockPolicy extends Transactional {
  snapshot(): PolicySnapshot;
  save(input: unknown): PolicySnapshot;
  /** Runs the work and every save inside it as one transaction on the policy's own connection. */
  transaction?<T>(work: () => T): T;
}

export interface BlockServiceHooks {
  log?: (message: string) => void;
  /** Called by notifyChanged(): queued work has to be routed again because a block appeared or went. */
  onChanged?: () => void;
}

export interface UpdateOptions {
  /** Read-modify-save attempts. A failed attempt is followed by a fresh read, so a concurrent save loses this writer's intent, never another writer's block. Default 1. */
  attempts?: number;
  /** Log prefix. With it a failed update is logged and reported as not ok; without it the last error propagates. */
  failureLabel?: string;
}

export interface UpdateResult {
  /** False only when every attempt failed and the failure was logged instead of thrown. */
  ok: boolean;
  /** True when a policy revision was written. */
  saved: boolean;
  /** The snapshot written, or the one read last when nothing was written. */
  snapshot: PolicySnapshot;
}

const message = (error: unknown): string => error instanceof Error ? error.message : 'unknown error';

/**
 * The one door through which automatic sources (stall, free-channel probe, vendor limits, quota) and the user's
 * engine unblock change policy blocks. It owns the read, the revision-checked save, the retry after a conflict and
 * the "queued work must re-route" signal. Which blocks a writer owns, and when it blocks or lifts, stays with the
 * writer: it passes a mutation that returns the whole next block list (or undefined to leave the policy alone).
 */
export class PolicyBlockService {
  constructor(private readonly policy: () => BlockPolicy, private readonly hooks: BlockServiceHooks = {}) {}

  snapshot(): PolicySnapshot {
    return this.policy().snapshot();
  }

  update(mutate: (snapshot: PolicySnapshot) => Block[] | undefined, options: UpdateOptions = {}): UpdateResult {
    const attempts = options.attempts ?? 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const policy = this.policy();
      const snapshot = policy.snapshot();
      try {
        const blocks = mutate(snapshot);
        if (blocks === undefined) return { ok: true, saved: false, snapshot };
        return { ok: true, saved: true, snapshot: policy.save({ revision: snapshot.revision, config: snapshot.config, blocks }) };
      } catch (error) {
        const last = attempt === attempts - 1;
        if (options.failureLabel === undefined) {
          if (last) throw error;
          continue;
        }
        this.hooks.log?.(`${options.failureLabel} ${last ? 'was not saved' : 'will be retried'}: ${message(error)}`);
        if (last) return { ok: false, saved: false, snapshot };
      }
    }
    // Only reachable with attempts < 1: nothing was tried, nothing changed.
    return { ok: false, saved: false, snapshot: this.snapshot() };
  }

  /**
   * The user's 「恢复派发」 for exactly one engine: every block naming it goes, whoever wrote it and at whatever
   * scope. An unknown engine is rejected before anything is written. Returns how many blocks were removed.
   */
  clearEngine(engine: string, options: UpdateOptions = {}): number {
    const snapshot = this.snapshot();
    if (!Object.hasOwn(snapshot.config.engines, engine)) throw new Error(`Unknown engine ${engine}`);
    const owned = snapshot.blocks.filter(block => block.engine === engine);
    if (owned.length > 0 && !this.update(current => current.blocks.filter(block => block.engine !== engine), options).ok) {
      throw new Error(`Blocks for ${engine} could not be removed`);
    }
    return owned.length;
  }

  /**
   * The user's 「恢复派发」 for exactly one worker: every block naming it goes, whoever wrote it and for whichever
   * model, plus the whole-engine 「全部子 Agent 均被限流」 vendor block that no longer holds without it. Other workers'
   * blocks and every other engine-level or model-level block stay. An unknown worker is rejected before anything is
   * written. Returns the worker's engine and how many blocks were removed (the derived engine block included).
   */
  clearWorker(worker: string, options: UpdateOptions = {}): { engine: string; removed: number } {
    const first = this.snapshot();
    if (!Object.hasOwn(first.config.workers, worker)) throw new Error(`Unknown worker ${worker}`);
    const engine = first.config.workers[worker]!.engine;
    let removed = 0;
    const result = this.update(current => {
      const plan = withoutWorkerBlocks(current.config, current.blocks, current.config.workers[worker]?.engine ?? engine, worker, Date.now());
      removed = plan.removed;
      return plan.removed > 0 ? plan.blocks : undefined;
    }, options);
    if (!result.ok) throw new Error(`Blocks for worker ${worker} could not be removed`);
    return { engine, removed };
  }

  /**
   * Runs one change of blocks together with the state that goes with it (a ladder, a monitor's rows) as a single
   * transaction: either both are durable or neither is, and the policy's in-memory snapshot only advances if they
   * commit. That needs the policy and every given store on one SQLite connection; otherwise (a test double, two
   * connections) the work simply runs, each part saving on its own as before. Waiting on a network or a probe
   * belongs outside the work.
   */
  atomic<T>(work: () => T, ...stores: Transactional[]): T {
    const policy = this.policy();
    return policy.transaction && sameConnection(policy, ...stores) ? policy.transaction(work) : work();
  }

  notifyChanged(): void {
    this.hooks.onChanged?.();
  }
}
