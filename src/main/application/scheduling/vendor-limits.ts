import type { OpenCodeAccountAdmission } from './opencode-accounts';
import type { Block } from '../../../shared/contracts/policy';
import { VENDOR_BLOCK_BY, isEngineBlock, isScopeBlock } from '../../../shared/policy/blocks';
import { vendorBlockReason } from '../../adapters/cli/vendor-errors';
import { VENDOR_LADDER_MINUTES } from '../../domain/penalties';
import type { TaskManager } from '../../manager';
import { nextVendorStep } from '../../monitors/ladder';
import { PolicyBlockService } from '../../policy/blocks';
import { escalateEngineBlock } from '../../policy/routing';
import type { PolicyStore } from '../../policy/store';
import { dbVendorLadder, engineLadderKey, type VendorLadderStore } from '../../storage/vendor-limits';

export class VendorLimits {
  private readonly vendorBlockedAttempts = new Set<string>();
  private readonly blocks: PolicyBlockService;
  private readonly ladder: VendorLadderStore;

  constructor(private readonly manager: TaskManager, policy: PolicyStore, private readonly accounts?: OpenCodeAccountAdmission) {
    this.blocks = new PolicyBlockService(() => policy);
    this.ladder = dbVendorLadder(manager.store.db);
    // Historical failures must not recreate a block after an explicit unblock or restart.
    for (const task of manager.store.listHeads()) if (task.failure) { this.accounts?.recordFailure(task); this.vendorBlockedAttempts.add(task.run?.id ?? task.id); }
  }

  /**
   * A rate limit or exhausted quota blocks the dispatched worker first (ladder per worker). Once every enabled worker
   * of its engine is out, the engine is blocked too. A dispatch that names no known worker blocks the whole engine.
   */
  applyVendorBlocks(): void {
    for (const task of this.manager.store.listHeads()) {
      const failure = task.failure;
      const engine = task.dispatch?.engine;
      const key = task.run?.id ?? task.id;
      if (!engine || !failure || !['rate_limit', 'quota', 'auth'].includes(failure.kind) || this.vendorBlockedAttempts.has(key)) continue;
      if (this.accounts?.recordFailure(task)) { this.vendorBlockedAttempts.add(key); continue; }
      if (failure.kind === 'auth') continue;
      // The ladder step and the block it earns are one commit: a save that fails leaves the ladder where it was, so the retry steps it once.
      this.blocks.atomic(() => this.blocks.update(snapshot => {
        const now = Date.now();
        const dispatched = task.dispatch?.worker;
        const worker = dispatched && Object.hasOwn(snapshot.config.workers, dispatched) && snapshot.config.workers[dispatched]!.engine === engine ? dispatched : undefined;
        const existing = snapshot.blocks.find(block => isScopeBlock(block, engine, worker));
        if (existing && existing.by !== VENDOR_BLOCK_BY) return undefined;
        // Another source already keeps the whole engine out of routing; a worker block would only stack on it.
        if (worker && snapshot.blocks.some(block => isEngineBlock(block, engine) && block.by !== VENDOR_BLOCK_BY && (!block.release_at || Date.parse(block.release_at) > now))) return undefined;
        // The one durable ladder per worker (or per engine when no worker is known), shared with the free-channel probe and kept after explicit block removal.
        let minutes: number = VENDOR_LADDER_MINUTES[0];
        if (failure.kind === 'rate_limit') {
          const key = worker ?? engineLadderKey(engine);
          const step = nextVendorStep(this.ladder.get(key), now);
          minutes = step.minutes;
          this.ladder.put(key, { level: step.level, lastTriggerAt: now });
        }
        const retryAt = failure.retryAt ? Date.parse(failure.retryAt) : NaN;
        const release = failure.kind === 'rate_limit' ? Math.max(now + minutes * 60_000, Number.isFinite(retryAt) ? retryAt : 0) : retryAt;
        const release_at = Number.isFinite(release) && release > now ? new Date(release).toISOString() : undefined;
        const block: Block = { engine, ...(worker ? { worker } : {}), reason: vendorBlockReason(failure), since: new Date(now).toISOString(), by: VENDOR_BLOCK_BY, ...(release_at ? { release_at } : {}) };
        const written = existing ? snapshot.blocks.map(item => item === existing ? block : item) : [...snapshot.blocks, block];
        return worker ? escalateEngineBlock(snapshot.config, written, engine, now) : written;
      }), this.ladder);
      // Skipped or written, this attempt is settled; a thrown save leaves it unmarked so the next pump tries again.
      this.vendorBlockedAttempts.add(key);
    }
  }
}
