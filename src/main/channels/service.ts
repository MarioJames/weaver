import { mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseDshConfig, type ChannelBinding } from './runtime';
import { nativeCredentialsReady, officialEngines, writeNativeConfig } from './native';
import { CHANNEL_CONFIG_MAX_BYTES } from '../../shared/contracts/channels';
import { randomUUID } from 'node:crypto';
import type { ChannelsSnapshot, SaveChannelResult, SaveChannelInput, DeleteChannelInput } from '../../shared/contracts/channels';
import { object } from '../../shared/validation';
import { exact } from '../policy/input';
import { PolicyStore } from '../policy/store';
import { ChannelStore } from './store';
export class ChannelService {
 constructor(private policy: PolicyStore, private secrets: ChannelStore, private options?: {root:string}) { if(policy.connection!==secrets.connection) throw new Error('Channel stores must share one database'); }
 get(): ChannelsSnapshot { const policy=this.policy.snapshot();return {policy,configurations:Object.fromEntries(Object.keys(policy.config.channels).map(id=>{const s=this.secrets.getSecret(id);return [id,{hasApiKey:!!s?.apiKey,hasConfig:!!s?.config,hasCredentials:nativeCredentialsReady(policy.config.engines[policy.config.channels[id]!.engine]?.kind??policy.config.channels[id]!.engine,s??{}),...(!s?.apiKey&&!s?.config&&!s?.authDir?{detail:'尚未导入渠道配置或凭据'}:{})}];}))}; }
 private allocate(id:string,engine:string):{account:string;authDir:string}{
  if(!this.options)throw new Error('官方账号私有目录服务不可用');
  const account=join(this.options.root,id);let created=false;
  try{
   mkdirSync(this.options.root,{recursive:true,mode:0o700});mkdirSync(account,{mode:0o700});created=true;chmodSync(account,0o700);
   const authDir=join(account,'native');mkdirSync(authDir,{mode:0o700});writeNativeConfig(authDir,'.weaver-login-pending','pending\n');
   if(engine==='codex')writeNativeConfig(authDir,'config.toml','cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\nmodel_provider = "openai"\n');
   return {account,authDir};
  }catch{if(created)rmSync(account,{recursive:true,force:true});throw new Error('无法建立官方账号私有目录');}
 }
 /** Called only by an explicit official login, under the same DB transaction as secret initialization. */
 initializeLogin(id:string):ChannelBinding{
  let created:string|undefined;
  try{return this.policy.transaction(()=>{
   const snapshot=this.policy.snapshot(),channel=snapshot.config.channels[id];
   if(!channel)throw new Error('Unknown channel');
   const engineKind=snapshot.config.engines[channel.engine]?.kind??channel.engine;
   if(channel.kind!=='subscription'||!officialEngines.has(engineKind))throw new Error('仅官方订阅账号支持原生登录');
   const secret=this.secrets.getSecret(id)??{};
   if(!secret.authDir){const allocated=this.allocate(id,engineKind);created=allocated.account;secret.authDir=allocated.authDir;this.secrets.putSecret(id,secret);}
   return {channel,secret,engineKind};
  });}catch(error){if(created)rmSync(created,{recursive:true,force:true});throw error;}
 }
 save(input: SaveChannelInput): SaveChannelResult {
  const raw=object(input);exact(raw,['revision','id','channel','config','apiKey']);
  const snapshot=this.policy.snapshot();
  const id=input.id ?? `channel_${randomUUID().replaceAll('-','').slice(0,24)}`;
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(id)||['constructor','prototype','__proto__'].includes(id)) throw new Error('Invalid channel id');
  if(input.id!==undefined&&!Object.hasOwn(snapshot.config.channels,id)) throw new Error('Unknown channel');
  if(input.id!==undefined){const current=snapshot.config.channels[id]!;if(current.engine!==input.channel.engine||current.kind!==input.channel.kind)throw new Error('Existing channel engine and kind cannot be changed');}
  for(const field of ['config','apiKey'] as const) if(input[field]!==undefined&&(typeof input[field]!=='string'||Buffer.byteLength(input[field]!)>CHANNEL_CONFIG_MAX_BYTES))throw new Error(`Invalid channel ${field}`);
  const engine=snapshot.config.engines[input.channel.engine]?.kind??input.channel.engine;
  if(engine==='dsh'&&input.config!==undefined&&input.config!=='')parseDshConfig(input.config);
  if(input.channel.kind==='subscription'){
   if(!officialEngines.has(engine))throw new Error('该引擎仅支持 API 渠道');
   if(input.apiKey!==undefined||input.config!==undefined||input.channel.provider!==undefined||input.channel.baseUrl!==undefined||input.channel.protocol!==undefined)throw new Error('官方订阅渠道不能提交 API 或原生认证配置');
  }
  let created:string|undefined;
  const previous=this.secrets.getSecret(id);
  let authDir=previous?.authDir;
  if(input.channel.kind==='subscription'&&!authDir){
   if(!this.options)throw new Error('官方账号私有目录服务不可用');
   const allocated=this.allocate(id,engine);created=allocated.account;authDir=allocated.authDir;
  }
  snapshot.config.channels[id]=input.channel;
  try { this.policy.transaction(()=>{
   this.policy.save({revision:input.revision,config:snapshot.config,blocks:snapshot.blocks});
   const secret=this.secrets.getSecret(id)??{};
   if(authDir)secret.authDir=authDir;
   if(input.config!==undefined){if(input.config==='') delete secret.config;else secret.config=input.config;}
   if(input.apiKey) secret.apiKey=input.apiKey;
   this.secrets.putSecret(id,secret);
  }); }catch(error){if(created)rmSync(created,{recursive:true,force:true});throw error;}return {...this.get(),savedChannel:id};
 }
 delete(input: DeleteChannelInput): ChannelsSnapshot {
  exact(object(input),['revision','id']);const snapshot=this.policy.snapshot();
  if(!Object.hasOwn(snapshot.config.channels,input.id))throw new Error('Unknown channel');
  if([...Object.values(snapshot.config.owners),...Object.values(snapshot.config.workers)].some(role=>role.channel===input.id))throw new Error('Channel is referenced by a role');
  delete snapshot.config.channels[input.id];
  this.policy.transaction(()=>{this.policy.save({revision:input.revision,config:snapshot.config,blocks:snapshot.blocks.filter(b=>b.channel!==input.id)});this.secrets.deleteSecret(input.id);});return this.get();
 }
}
