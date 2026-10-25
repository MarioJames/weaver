import { ENGINE_ALL_BLOCKED_REASON, VENDOR_BLOCK_BY, isQuotaBlockBy } from './blocks';
import type { Channel } from '../contracts/channels';
import type { Config, Owner, Worker } from '../contracts/policy';
type RoleChannels = Pick<Owner, 'channel'> | Pick<Worker, 'channels'>;
/** Membership only: array order never selects an execution account. */
export function roleChannels(role: RoleChannels): readonly string[] {
 return 'channels' in role ? role.channels : [role.channel];
}
export function workerUsesChannel(worker: Pick<Worker, 'channels'>, id: string): boolean { return worker.channels.includes(id); }
/** Only a concrete route or owner can resolve one channel. */
export function channelOf(config: Config, role: Pick<Owner, 'channel'>): Channel {
 const channel = Object.hasOwn(config.channels, role.channel) ? config.channels[role.channel] : undefined;
 if (!channel) throw new Error(`Unknown channel ${role.channel}`);
 return channel;
}
export function roleEngine(config: Config, role: RoleChannels): string {
 const ids = roleChannels(role);
 if (!ids.length) throw new Error('Role channels must be nonempty');
 const engines = ids.map(channel => channelOf(config, {channel}).engine);
 if (engines.some(engine => engine !== engines[0])) throw new Error('Role channels must use the same engine');
 return engines[0]!;
}
/** Schema13 database upgrade only. Preserved singleton intermediate representation. */
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

/** Pure history-only normalization. Online policies must already use worker arrays. */
export function normalizeHistoricalPolicy(value: Record<string, any>, blocks: any[] = []): {config: Config; blocks: any[]} {
 const config = structuredClone(value);
 const record = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
 if (!record(config) || !record(config.engines) || !record(config.workers) || !record(config.owners) || !Array.isArray(blocks)) throw new Error('Malformed policy history');
 for (const [id, worker] of Object.entries(config.workers) as [string, any][]) {
  if (!record(worker)) throw new Error(`workers.${id}: malformed historical worker`);
  const fields = ['engine', 'channel', 'channels'].filter(key => Object.hasOwn(worker,key));
  if (fields.length !== 1) throw new Error(`workers.${id}: ambiguous or missing historical channel fields`);
  if ((!config.channels && fields[0] !== 'engine') || (config.channels && fields[0] === 'engine')) throw new Error(`workers.${id}: inconsistent historical channel schema`);
 }
 for (const owner of Object.values(config.owners) as any[]) {
  if (!record(owner) || Object.hasOwn(owner,'channels') || (Object.hasOwn(owner,'engine') === Object.hasOwn(owner,'channel'))) throw new Error('Malformed historical owner channel');
 }
 const upgraded = migrateChannelPolicy(config, structuredClone(blocks));
 for (const [id, worker] of Object.entries(upgraded.config.workers) as [string, any][]) {
  if (Object.hasOwn(worker,'channel')) {
   if (typeof worker.channel !== 'string' || !worker.channel.length) throw new Error(`workers.${id}.channel: expected channel id`);
   worker.channels = [worker.channel]; delete worker.channel;
  }
  if (!Array.isArray(worker.channels) || !worker.channels.length || worker.channels.length > 20 || worker.channels.some((v: any) => typeof v !== 'string' || !Object.hasOwn(config.channels,v)) || new Set(worker.channels).size !== worker.channels.length) throw new Error(`workers.${id}.channels: invalid historical channels`);
  roleEngine(upgraded.config,worker);
 }
 for (const owner of Object.values(upgraded.config.owners)) {
  roleEngine(upgraded.config,owner);
 }
 return upgraded;
}
