import { CHANNEL_CONFIG_MAX_BYTES } from '../../shared/contracts/channels';
import { randomUUID } from 'node:crypto';
import type { ChannelsSnapshot, SaveChannelInput, DeleteChannelInput } from '../../shared/contracts/channels';
import { object } from '../../shared/validation';
import { exact } from '../policy/input';
import { PolicyStore } from '../policy/store';
import { ChannelStore } from './store';
export class ChannelService {
 constructor(private policy: PolicyStore, private secrets: ChannelStore) { if(policy.connection!==secrets.connection) throw new Error('Channel stores must share one database'); }
 get(): ChannelsSnapshot { const policy=this.policy.snapshot();return {policy,configurations:Object.fromEntries(Object.keys(policy.config.channels).map(id=>{const s=this.secrets.getSecret(id);return [id,{hasApiKey:!!s?.apiKey,hasConfig:!!s?.config,hasCredentials:!!s?.authDir,...(!s?.apiKey&&!s?.config&&!s?.authDir?{detail:'尚未导入渠道配置或凭据'}:{})}];}))}; }
 save(input: SaveChannelInput): ChannelsSnapshot {
  const raw=object(input);exact(raw,['revision','id','channel','config','apiKey']);
  const snapshot=this.policy.snapshot();
  const id=input.id ?? `channel_${randomUUID().replaceAll('-','').slice(0,24)}`;
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(id)||['constructor','prototype','__proto__'].includes(id)) throw new Error('Invalid channel id');
  if(input.id!==undefined&&!Object.hasOwn(snapshot.config.channels,id)) throw new Error('Unknown channel');
  if(input.id!==undefined){const current=snapshot.config.channels[id]!;if(current.engine!==input.channel.engine||current.kind!==input.channel.kind)throw new Error('Existing channel engine and kind cannot be changed');}
  for(const field of ['config','apiKey'] as const) if(input[field]!==undefined&&(typeof input[field]!=='string'||Buffer.byteLength(input[field]!)>CHANNEL_CONFIG_MAX_BYTES))throw new Error(`Invalid channel ${field}`);
  snapshot.config.channels[id]=input.channel;
  this.policy.transaction(()=>{
   this.policy.save({revision:input.revision,config:snapshot.config,blocks:snapshot.blocks});
   const secret=this.secrets.getSecret(id)??{};
   if(input.config!==undefined){if(input.config==='') delete secret.config;else secret.config=input.config;}
   if(input.apiKey) secret.apiKey=input.apiKey;
   this.secrets.putSecret(id,secret);
  });return this.get();
 }
 delete(input: DeleteChannelInput): ChannelsSnapshot {
  exact(object(input),['revision','id']);const snapshot=this.policy.snapshot();
  if(!Object.hasOwn(snapshot.config.channels,input.id))throw new Error('Unknown channel');
  if([...Object.values(snapshot.config.owners),...Object.values(snapshot.config.workers)].some(role=>role.channel===input.id))throw new Error('Channel is referenced by a role');
  delete snapshot.config.channels[input.id];
  this.policy.transaction(()=>{this.policy.save({revision:input.revision,config:snapshot.config,blocks:snapshot.blocks.filter(b=>b.channel!==input.id)});this.secrets.deleteSecret(input.id);});return this.get();
 }
}
