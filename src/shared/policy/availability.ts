import { roleChannels, roleEngine } from './channels';
import type { Availability, Block, Config, Owner, State, Worker } from '../contracts/policy';
import { isQuotaBlockBy, manualResumeKind, reaches } from './blocks';

/** True while the block has no release time or its release time is still ahead. */
export const isBlockActive = (block: Block, now: number): boolean => !block.release_at || Date.parse(block.release_at) > now;
export function activeBlocks(state: State, now: number): Block[] {
  return state.blocks.filter(b => isBlockActive(b, now));
}
/** A concrete account route retains the single-channel block semantics. */
export type ChannelRole = Pick<Owner, 'channel' | 'model' | 'enabled'> & {free_channel?: boolean};
export function coveringChannelBlock(blocks: Block[], entity: ChannelRole, workerId: string | undefined, config: Config): Block | undefined {
 return blocks.find(b => b.engine === roleEngine(config, entity)
  && (b.channel === undefined || b.channel === entity.channel)
  && (b.worker === undefined || b.worker === workerId)
  && (b.model === undefined || b.model === entity.model)
  && !(entity.free_channel === true && isQuotaBlockBy(b.by)));
}
/** A worker is covered only when every account is covered. This does not choose an account. */
export function coveringBlock(blocks: Block[], entity: Owner | Worker | ChannelRole, workerId: string | undefined, config: Config): Block | undefined {
 const hits = roleChannels(entity).map(channel => coveringChannelBlock(blocks,{...entity,channel},workerId,config));
 return hits.every(Boolean) ? hits[0] : undefined;
}
export function channelAvailabilityOf(config: Config, blocks: Block[], entity: ChannelRole, workerId?: string): Availability {
 if (!entity.enabled) return {status:'disabled'};
 if (!config.channels[entity.channel]?.enabled) return {status:'channel_disabled',channel:entity.channel};
 const hit = coveringChannelBlock(blocks,entity,workerId,config);
 if (hit) return {status:'blocked',engine:hit.engine,...(hit.channel?{channel:hit.channel}:{}),...(hit.model?{model:hit.model}:{}),...(hit.worker?{worker:hit.worker}:{}),reason:hit.reason,...(hit.release_at?{release_at:hit.release_at}:{})};
 return {status:'available'};
}
/** At least one account must be enabled and free of existing blocks; no quota context or account selection here. */
export function availabilityOf(config: Config, blocks: Block[], entity: Owner | Worker | ChannelRole, workerId?: string): Availability {
 const results = roleChannels(entity).map(channel=>channelAvailabilityOf(config,blocks,{...entity,channel},workerId));
 return results.find(a=>a.status==='available') ?? results.find(a=>a.status==='blocked') ?? results[0] ?? {status:'channel_disabled'};
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
  const perChannel = worker.channels.filter(channel=>config.channels[channel]?.enabled).map(channel => {
  const route = { channel, engine: roleEngine(config, worker), worker: workerId, model: worker.model };
  return blocks
    .filter(block => isBlockActive(block, now) && reaches(block, route) && !(worker.free_channel === true && isQuotaBlockBy(block.by)))
    .flatMap(block => { const kind = manualResumeKind(block); return kind ? [{ kind, block }] : []; });
  });
  if (!perChannel.length || perChannel.some(hits=>!hits.length)) return undefined;
  const hits=perChannel.flat();
  return hits.find(hit => hit.kind === 'quota') ?? hits[0];
}
