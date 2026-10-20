import type { PolicyBlockService } from '../../policy/blocks';

/** What the unblock needs from each monitor: forget the ladder or question that the removed blocks belonged to. */
export interface EngineUnblockDeps {
  blocks: PolicyBlockService;
  stall: { resetEngine(engine: string): void };
  freeProbe?: { resetEngine(engine: string): void };
}

/**
 * The user's 「恢复派发」 for exactly one engine: everything keeping that engine out of routing goes, whichever source
 * wrote it and at whatever scope (engine, model or worker); its stall ladder and streak start over, free-channel
 * questions that lost their block reset, and the history stays. Other engines and the whole config are preserved,
 * and an unknown engine is rejected before anything is written. Only this manual path clears blocks it did not
 * write; a passing recovery probe still lifts nothing but Weaver's own penalty. Vendor failures that already
 * happened are not replayed into new blocks.
 */
export function unblockEngine(deps: EngineUnblockDeps, engine: string): void {
  const removed = deps.blocks.clearEngine(engine, { attempts: 2, failureLabel: 'Stall policy change' });
  deps.stall.resetEngine(engine);
  deps.freeProbe?.resetEngine(engine);
  if (removed > 0) deps.blocks.notifyChanged();
}
