import type { PolicyBlockService } from '../../policy/blocks';

/** What the unblock needs from each monitor: forget the question or ladder that the removed blocks belonged to. */
export interface WorkerUnblockDeps {
  blocks: PolicyBlockService;
  stall: { resetWorker(engine: string, worker: string): void };
  freeProbe?: { resetWorker(engine: string, worker: string): void };
}

/** What the user is told: which worker, its engine, how many blocks went (a dependent whole-engine vendor block counts) and whether any existed. */
export interface WorkerUnblockResult { worker: string; engine: string; removed: number; wasBlocked: boolean }

const message = (error: unknown): string => error instanceof Error ? error.message : 'unknown error';

/**
 * The user's 「恢复派发」 for exactly one worker, the narrower sibling of unblockEngine: every block that names the
 * worker goes whichever source wrote it (plus the whole-engine 「全部子 Agent 均被限流」 vendor block that no longer
 * holds), other workers, other engines and every manual or foreign engine-level block stay, the worker's stall and
 * free-channel probe state start over where the monitors keep any, and the vendor rate-limit ladder is kept (it zeroes
 * itself after two quiet hours). An unknown worker is rejected before anything is written.
 *
 * Like the engine unblock, the steps cannot share one transaction: once the blocks are gone they stay gone, a failing
 * later step does not stop the next one, queued work is still told to route again, and the failure is then reported
 * with what had been applied. Repeating the unblock is safe.
 */
export function unblockWorker(deps: WorkerUnblockDeps, worker: string): WorkerUnblockResult {
  const { engine, removed } = deps.blocks.clearWorker(worker, { attempts: 2, failureLabel: 'Worker unblock' });
  const failures: string[] = [];
  const step = (label: string, run: () => void): void => {
    try { run(); } catch (error) { failures.push(`${label}: ${message(error)}`); }
  };
  step('stall reset', () => deps.stall.resetWorker(engine, worker));
  step('free probe reset', () => deps.freeProbe?.resetWorker(engine, worker));
  if (removed > 0) step('route notification', () => deps.blocks.notifyChanged());
  if (failures.length > 0) {
    const applied = removed > 0 ? `The ${removed} block(s) of ${worker} were already cleared; ` : `${worker} had no blocks; `;
    throw new Error(`Worker ${worker} was only partly unblocked. ${applied}${failures.join('; ')}. Retry the unblock or wait for the next monitor tick.`);
  }
  return { worker, engine, removed, wasBlocked: removed > 0 };
}
