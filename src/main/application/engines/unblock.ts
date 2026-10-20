import type { PolicyBlockService } from '../../policy/blocks';

/** What the unblock needs from each monitor: forget the ladder or question that the removed blocks belonged to. */
export interface EngineUnblockDeps {
  blocks: PolicyBlockService;
  stall: { resetEngine(engine: string): void };
  freeProbe?: { resetEngine(engine: string): void };
}

const message = (error: unknown): string => error instanceof Error ? error.message : 'unknown error';

/**
 * The user's 「恢复派发」 for exactly one engine: everything keeping that engine out of routing goes, whichever source
 * wrote it and at whatever scope (engine, model or worker); its stall ladder and streak start over, free-channel
 * questions that lost their block reset, and the history stays. Other engines and the whole config are preserved,
 * and an unknown engine is rejected before anything is written. Only this manual path clears blocks it did not
 * write; a passing recovery probe still lifts nothing but Weaver's own penalty. Vendor failures that already
 * happened are not replayed into new blocks.
 *
 * The three steps cannot share one transaction. Once the blocks are gone they stay gone: a later step that fails
 * does not stop the next one, the queued work is still told to route again, and the failure is then reported with
 * what had already been applied. The monitors converge on their next tick (the stall state stays dirty until it is
 * saved), and repeating the unblock is safe.
 */
export function unblockEngine(deps: EngineUnblockDeps, engine: string): void {
  const removed = deps.blocks.clearEngine(engine, { attempts: 2, failureLabel: 'Stall policy change' });
  const failures: string[] = [];
  const step = (label: string, run: () => void): void => {
    try { run(); } catch (error) { failures.push(`${label}: ${message(error)}`); }
  };
  step('stall reset', () => deps.stall.resetEngine(engine));
  step('free probe reset', () => deps.freeProbe?.resetEngine(engine));
  if (removed > 0) step('route notification', () => deps.blocks.notifyChanged());
  if (failures.length > 0) {
    const applied = removed > 0 ? `The ${removed} block(s) of ${engine} were already cleared; ` : `${engine} had no blocks; `;
    throw new Error(`Engine ${engine} was only partly unblocked. ${applied}${failures.join('; ')}. Retry the unblock or wait for the next monitor tick.`);
  }
}
