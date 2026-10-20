import type { Availability, Block, Config, Owner, State, Worker } from '../contracts/policy';

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
    && !("free_channel" in entity && entity.free_channel === true && b.by?.startsWith("weaver-quota:")));
}
/** workerId is the policy key of a worker; omit it for owners, which no worker-scoped block can reach. */
export function availabilityOf(config: Config, blocks: Block[], entity: Owner | Worker, workerId?: string): Availability {
  if (!entity.enabled) return { status: "disabled" };
  if (!config.engines[entity.engine]?.enabled) return { status: "engine_disabled" };
  const hit = coveringBlock(blocks, entity, workerId);
  if (hit) return { status: "blocked", engine: hit.engine, ...(hit.model ? { model: hit.model } : {}), ...(hit.worker ? { worker: hit.worker } : {}), reason: hit.reason, ...(hit.release_at ? { release_at: hit.release_at } : {}) };
  return { status: "available" };
}
