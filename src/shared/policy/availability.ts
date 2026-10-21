import type { Availability, Block, Config, Owner, State, Worker } from '../contracts/policy';
import { isQuotaBlockBy, manualResumeKind, reaches } from './blocks';

/** True while the block has no release time or its release time is still ahead. */
export const isBlockActive = (block: Block, now: number): boolean => !block.release_at || Date.parse(block.release_at) > now;
export function activeBlocks(state: State, now: number): Block[] {
  return state.blocks.filter(b => isBlockActive(b, now));
}
/** The block that keeps a role out, if any. A worker-scoped block reaches only the worker it names, never an owner or a sibling. */
export function coveringBlock(blocks: Block[], entity: Owner | Worker, workerId?: string): Block | undefined {
  return blocks.find(b => b.engine === entity.engine
    && (b.worker === undefined || b.worker === workerId)
    && (b.model === undefined || b.model === entity.model)
    && !("free_channel" in entity && entity.free_channel === true && isQuotaBlockBy(b.by)));
}
/** workerId is the policy key of a worker; omit it for owners, which no worker-scoped block can reach. */
export function availabilityOf(config: Config, blocks: Block[], entity: Owner | Worker, workerId?: string): Availability {
  if (!entity.enabled) return { status: "disabled" };
  if (!config.engines[entity.engine]?.enabled) return { status: "engine_disabled" };
  const hit = coveringBlock(blocks, entity, workerId);
  if (hit) return { status: "blocked", engine: hit.engine, ...(hit.model ? { model: hit.model } : {}), ...(hit.worker ? { worker: hit.worker } : {}), reason: hit.reason, ...(hit.release_at ? { release_at: hit.release_at } : {}) };
  return { status: "available" };
}

/**
 * The block that keeps this worker out until a person lifts it: an exhausted quota (it has no recovery time of its
 * own) or any other block without a release time. Blocks that lift themselves (a rate limit with its release time, a
 * stall penalty or a free-channel ban its probe lifts) are not reported. A free-channel worker ignores the native account
 * quota markers, exactly as routing does. A quota block wins over a plain manual one.
 */
export function manualPauseOf(config: Config, blocks: Block[], workerId: string, now: number): { kind: 'quota' | 'manual'; block: Block } | undefined {
  const worker = config.workers[workerId];
  if (!worker) return undefined;
  const route = { engine: worker.engine, worker: workerId, model: worker.model };
  const hits = blocks
    .filter(block => isBlockActive(block, now) && reaches(block, route) && !(worker.free_channel === true && isQuotaBlockBy(block.by)))
    .flatMap(block => { const kind = manualResumeKind(block); return kind ? [{ kind, block }] : []; });
  return hits.find(hit => hit.kind === 'quota') ?? hits[0];
}
