import type { Block } from '../contracts/policy';

// The one place that names who writes a policy block and what each writer owns. Main-process writers, the
// router and the renderer all read these, so a source marker or a scope rule changes in one file.

/** Weaver's own stall penalty: one block on a whole engine, lifted only by a passing probe or by the user. */
export const STALL_BLOCK_BY = 'weaver-stall';
/** Free-channel quota ban: one worker-level block on the probed route. */
export const FREE_PROBE_BLOCK_BY = 'weaver-free-probe';
/** Vendor rate limit or exhausted quota seen by a dispatch or a probe, plus the whole-engine block that follows from them. */
export const VENDOR_BLOCK_BY = 'weaver-vendor-limit';
/** Account quota observations, one marker per quota kind: `weaver-quota:<kind>`. */
export const QUOTA_BLOCK_PREFIX = 'weaver-quota:';

export const quotaBlockBy = (kind: string): string => `${QUOTA_BLOCK_PREFIX}${kind}`;
export const isQuotaBlockBy = (by: string | undefined): boolean => by?.startsWith(QUOTA_BLOCK_PREFIX) === true;

/** Markers the free-channel probe treats as its own when it writes or lifts a route's block. */
export const PROBE_OWNED_SOURCES: readonly string[] = [STALL_BLOCK_BY, VENDOR_BLOCK_BY, FREE_PROBE_BLOCK_BY];

/** A block on a whole engine: no model, no worker. Pass the engine to also require it. */
export const isEngineBlock = (block: Block, engine?: string): boolean =>
  (engine === undefined || block.engine === engine) && block.model === undefined && block.worker === undefined;

/** A block on exactly this engine and worker with no model: the engine itself when no worker is named. */
export const isScopeBlock = (block: Block, engine: string, worker: string | undefined): boolean =>
  block.engine === engine && block.model === undefined && block.worker === worker;

/** Weaver's own penalty for an engine as a whole; a model-level block is somebody else's business. */
export const isStallEngineBlock = (block: Block, engine: string): boolean => isEngineBlock(block, engine) && block.by === STALL_BLOCK_BY;

/** One worker's saved route, as far as block scope is concerned. */
export interface BlockRoute { engine: string; worker: string; model: string }

/** Does this block reach the route's worker? A worker-level block names exactly one worker. */
export const reaches = (block: Block, route: BlockRoute): boolean =>
  block.engine === route.engine && (block.worker === undefined || block.worker === route.worker) && (block.model === undefined || block.model === route.model);

/**
 * A block the probe wrote for the route: its worker, its model and one of its markers (or the given one). A
 * pre-worker block (no worker field) on the same model is still recognised as ours.
 */
export const ownedOnRoute = (block: Block, route: BlockRoute, by?: string): boolean =>
  block.engine === route.engine && block.model === route.model && (block.worker === route.worker || block.worker === undefined) &&
  (by !== undefined ? block.by === by : block.by !== undefined && PROBE_OWNED_SOURCES.includes(block.by));

/** Is this route currently kept out by a block that the probe did not write? */
export const foreignBlockOn = (blocks: Block[], route: BlockRoute): Block | undefined =>
  blocks.find(block => reaches(block, route) && !ownedOnRoute(block, route));
