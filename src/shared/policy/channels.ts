import { ENGINE_ALL_BLOCKED_REASON, VENDOR_BLOCK_BY, isQuotaBlockBy } from './blocks';
import type { Channel } from '../contracts/channels';
import type { Config, Owner, Worker } from '../contracts/policy';
export function channelOf(config: Config, role: Pick<Owner | Worker, 'channel'>): Channel {
 const channel = Object.hasOwn(config.channels, role.channel) ? config.channels[role.channel] : undefined;
 if (!channel) throw new Error(`Unknown channel ${role.channel}`);
 return channel;
}
export function roleEngine(config: Config, role: Pick<Owner | Worker, 'channel'>): string { return channelOf(config, role).engine; }
/** Database policy upgrade only. Runtime roles always carry channel. */
export function migrateChannelPolicy(config: Record<string, any>, blocks: any[] = []): { config: Config; blocks: any[] } {
 if (config.channels) return { config: config as Config, blocks };
 const channels: Record<string, Channel> = {};
 const mapping: Record<string, string> = {};
 for (const [id, entry] of Object.entries(config.engines) as [string, any][]) {
  const channelId = `default_${id}`; mapping[id] = channelId;
  const api = entry.kind === 'pi' || entry.kind === 'dsh';
  const engine = id;
  const models = [...Object.values(config.owners), ...Object.values(config.workers)].filter((r: any) => r.engine === id).map((r: any) => r.model as string);
  const providers = [...new Set(models.filter(m => m.includes('/')).map(m => m.split('/')[0]))];
  channels[channelId] = { engine, label: `${id} ${api ? 'API（待导入）' : '官方订阅'}`, enabled: true, kind: api ? 'api' : 'subscription', ...(entry.quota_refresh !== undefined ? {quota_refresh:entry.quota_refresh} : {}), ...(api && providers.length === 1 ? { provider: providers[0] } : {}) };
  delete entry.quota_refresh;
 }
 config.channels = channels;
 for (const role of [...Object.values(config.owners), ...Object.values(config.workers)] as any[]) { role.channel = mapping[role.engine]; delete role.engine; }
 const next = blocks.map(block => {
  if (block.channel) return block;
  const channel = mapping[block.engine];
  if (isQuotaBlockBy(block.by) && channels[channel]?.kind === 'subscription') return { ...block, channel };
  if (block.by === VENDOR_BLOCK_BY) {
   if (block.worker && config.workers[block.worker]?.channel) return { ...block, channel: config.workers[block.worker].channel };
   if (block.worker === undefined && block.reason === ENGINE_ALL_BLOCKED_REASON && channel) return { ...block, channel };
  }
  return block;
 });
 return { config: config as Config, blocks: next };
}
