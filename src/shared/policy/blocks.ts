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

/** What a block's reason says when the vendor reports an exhausted quota or balance: Weaver's own `额度耗尽：` prefix, a payment-required status or the free/go plan limit errors. */
const QUOTA_REASON = /额度耗尽|余额|^quota|FreeUsageLimitError|GoUsageLimitError|\b402\b/i;
/** Does this block pause the route because the quota or balance ran out? Quota markers say so, and so do vendor and hand-written blocks that name it in their reason. Stall penalties are about silence, never quota. */
export const isQuotaBlock = (block: Pick<Block, 'by' | 'reason'>): boolean =>
  block.by !== STALL_BLOCK_BY && (isQuotaBlockBy(block.by) || QUOTA_REASON.test(block.reason));
/**
 * Which blocks only a person lifts: an exhausted quota (it names no recovery of its own, and the probes cannot refill it)
 * and any block without a release time. The stall penalty and the free-channel probe lift their own blocks with a
 * passing probe, so they are never manual; a block that carries a release time (a rate limit) lifts itself.
 */
export function manualResumeKind(block: Pick<Block, 'by' | 'reason' | 'release_at'>): 'quota' | 'manual' | undefined {
  if (block.by === STALL_BLOCK_BY || block.by === FREE_PROBE_BLOCK_BY) return undefined;
  if (isQuotaBlock(block)) return 'quota';
  return block.release_at ? undefined : 'manual';
}

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
