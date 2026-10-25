import { dbQuotaStore } from '../storage/quota-snapshot';
import { channelRoutingReason, workerChannelCandidates, type ChannelRoutingContext } from './worker-channel-routing';
import { ENGINE_CATALOG } from '../../shared/engines';
import { normalizeHistoricalPolicy, roleEngine } from '../../shared/policy/channels';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { object } from '../../shared/validation';
import type { PolicySnapshot } from '../../shared/contracts/policy';
import { activeBlocks, availabilityOf } from '../../shared/policy/availability';
import { defaultConfig, parseReleaseAt, validateConfig } from './routing';
import { exact, text } from './input';
import { type Config, type Block, type Engine, type Owner, type Worker } from '../../shared/contracts/policy';
import { migrate } from '../migrate';
import { onRollback, transact } from '../storage/transaction';
const LIMIT=256*1024;
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value))>LIMIT) throw new Error('Policy exceeds 256 KiB'); }
function blocksOf(value: unknown, config: Config): Block[] {
 if(!Array.isArray(value)||value.length>500) throw new Error('Invalid quota blocks');
 const keys=new Set<string>();
 return value.map(raw=>{
  const b=object(raw); exact(b,['engine','channel','model','worker','reason','since','release_at','by']);
  const engine=text(b.engine,'engine'); if(!Object.hasOwn(config.engines,engine)) throw new Error(`Unknown engine ${engine}`);
  const block: Block={engine,reason:text(b.reason,'reason'),since:parseReleaseAt(text(b.since,'since'),0)};
  if (String(b.since).startsWith('+')) throw new Error('since must be an absolute timestamp');
  if(b.channel!==undefined){block.channel=text(b.channel,'channel');if(!Object.hasOwn(config.channels,block.channel)||config.channels[block.channel]!.engine!==engine) throw new Error('Unknown channel or engine mismatch');}
  if(b.model!==undefined) block.model=text(b.model,'model');
  if(b.worker!==undefined){
   block.worker=text(b.worker,'worker');
   // A worker that left the config takes its blocks with it; otherwise they could never be saved away.
   if(!Object.hasOwn(config.workers,block.worker)) return undefined;
  }
  if(b.by!==undefined) block.by=text(b.by,'by');
  if(b.release_at!==undefined) {
   if(String(b.release_at).startsWith('+')) throw new Error('Stored release_at must be an absolute timestamp');
   block.release_at=parseReleaseAt(text(b.release_at,'release_at'),0);
  }
  const key=JSON.stringify([engine,block.channel??null,block.model??null,block.worker??null]); if(keys.has(key)) throw new Error('Duplicate engine/model/worker quota block'); keys.add(key);
  return block;
 }).filter((block):block is Block=>block!==undefined);
}
/** Task classes, worker tags, owner engine pins and the engine native-subagent flag were removed; revision snapshots already stored in the database may still carry them, so a rollback drops them. */
function dropRetiredFields(value: unknown): unknown {
 const config=object(value);
 for(const owner of Object.values(object(config.owners))) if(owner&&typeof owner==='object') delete (owner as Record<string,unknown>).only_engine;
 for(const worker of Object.values(object(config.workers))) if(worker&&typeof worker==='object') delete (worker as Record<string,unknown>).tags;
 for(const engine of Object.values(object(config.engines))) if(engine&&typeof engine==='object') delete (engine as Record<string,unknown>).native_subagents;
 return config;
}
/** Top-level config sections kept as one settings row each (engines, owners and workers have their own tables). */
const SETTING_KEYS=['$schema','chatgpt_review','quota','free_channel_probe','janitor','display'];
const bit=(value:boolean)=>value?1:0;
const optionalText=(value:string|undefined)=>value===undefined?null:value;
/** App-owned single-writer settings in the same weaver.db as the task store. Never touches upstream config or a host home. */
export class PolicyStore {
 private db:DatabaseSync;
 private config:Config=defaultConfig();
 private blocks: Block[]=[];
 private revision=0;
 private quotaInvalidator?: (channel:string) => void;
 setChannelQuotaInvalidator(invalidate:(channel:string)=>void):void { this.quotaInvalidator=invalidate; }
 invalidateChannelQuota(channel:string):void { dbQuotaStore(this.db).invalidateChannel!(channel);this.quotaInvalidator?.(channel); }
 private contextProvider?: (config: Config) => ChannelRoutingContext;
 setRoutingContextProvider(provider: (config: Config) => ChannelRoutingContext): void { this.contextProvider=provider; }
 routingContext(): ChannelRoutingContext | undefined { return this.contextProvider?.(this.config); }
 readonly path: string;
 constructor(source: string|DatabaseSync, private now: ()=>number=Date.now) {
  if(typeof source==='string'){
   this.path=source;
   mkdirSync(dirname(this.path),{recursive:true});
   this.db=new DatabaseSync(this.path);
   try{this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');migrate(this.db);}catch(error){this.db.close();throw error;}
  }else{
   this.db=source;
   this.path=(this.db as unknown as {location?:string}).location??':memory:';
   migrate(this.db);
  }
  this.load();
 }
 /** The normalized tables are the state; the newest revision row carries the same snapshot for history reads. */
 private load():void {
  const saved=this.db.prepare('SELECT max(revision) AS r FROM policy_revisions').get() as {r:number|null};
  if(saved.r===null){this.config=defaultConfig();this.blocks=[];this.revision=0;return;}
  const engines:Config['engines']={};
  for(const row of this.db.prepare('SELECT * FROM policy_engines ORDER BY position').all() as Record<string,unknown>[]){
   const engine={enabled:true,kind:String(row.kind)} as Engine;
   engines[String(row.id)]=engine;
  }
  const ownerWorkerRows=this.db.prepare('SELECT * FROM policy_owner_workers ORDER BY position').all() as Record<string,unknown>[];
  const owners:Config['owners']={};
  for(const row of this.db.prepare('SELECT * FROM policy_owners ORDER BY position').all() as Record<string,unknown>[]){
   const id=String(row.id);
   const links=ownerWorkerRows.filter(item=>String(item.owner_id)===id);
   const owner={enabled:Number(row.enabled)===1,channel:String(row.channel),model:String(row.model),effort:String(row.effort),workers:links.map(item=>String(item.worker_id)),max_parallel:Number(row.max_parallel)} as Owner;
   const weights:Record<string,number>={};
   for(const item of links)if(item.weight!==null&&item.weight!==undefined)weights[String(item.worker_id)]=Number(item.weight);
   if(Object.keys(weights).length)owner.worker_weights=weights;
   owners[id]=owner;
  }
  const workers:Config['workers']={};
  for(const row of this.db.prepare('SELECT * FROM policy_workers ORDER BY position').all() as Record<string,unknown>[]){
   const id=String(row.id);
   const worker={enabled:Number(row.enabled)===1,channels:JSON.parse(String(row.channels)),model:String(row.model),effort:String(row.effort)} as Worker;
   if(row.description!==null&&row.description!==undefined)worker.description=String(row.description);
   if(row.free_channel!==null&&row.free_channel!==undefined)worker.free_channel=Number(row.free_channel)===1;
   if(row.max_parallel!==null&&row.max_parallel!==undefined)worker.max_parallel=Number(row.max_parallel);
   workers[id]=worker;
  }
  const settings:Record<string,unknown>={};
  for(const row of this.db.prepare('SELECT key,body FROM policy_settings').all() as Record<string,unknown>[])settings[String(row.key)]=JSON.parse(String(row.body));
  // Same key order as the saved document, so reading the policy back looks like what was saved.
  const built:Record<string,unknown>={};
  if(settings.$schema!==undefined)built.$schema=settings.$schema;
  built.version=1;
  if(settings.chatgpt_review!==undefined)built.chatgpt_review=settings.chatgpt_review;
  built.channels=Object.fromEntries((this.db.prepare('SELECT id,body FROM policy_channels ORDER BY position').all() as {id:string;body:string}[]).map(row=>[row.id,JSON.parse(row.body)]));
  built.engines=engines;built.owners=owners;built.workers=workers;
  // Older policies carry no max_command_minutes; the snapshot exposes the effective default without rewriting the row.
  built.herdr={...defaultConfig().herdr,...(settings.herdr!==null&&typeof settings.herdr==='object'&&!Array.isArray(settings.herdr)?settings.herdr:{})};
  for(const key of ['quota','free_channel_probe','janitor','display'])if(settings[key]!==undefined)built[key]=settings[key];
  const config=built as unknown as Config;
  const blocks=(this.db.prepare('SELECT * FROM policy_blocks ORDER BY position').all() as Record<string,unknown>[]).map(row=>{
   const block:Block={engine:String(row.engine),reason:String(row.reason),since:String(row.since)};
   if(row.channel!==null&&row.channel!==undefined)block.channel=String(row.channel);
   if(row.model!==null&&row.model!==undefined)block.model=String(row.model);
   if(row.worker!==null&&row.worker!==undefined)block.worker=String(row.worker);
   if(row.release_at!==null&&row.release_at!==undefined)block.release_at=String(row.release_at);
   if(row.by!==null&&row.by!==undefined)block.by=String(row.by);
   return block;
  });
  const parsed=this.parse(config,blocks);
  this.config=parsed.config;this.blocks=parsed.blocks;
  this.revision=Number(saved.r);
 }
 private writeAll(config:Config,blocks:Block[]):void {
  this.db.exec('DELETE FROM policy_blocks');
  const insertBlock=this.db.prepare('INSERT INTO policy_blocks(position,engine,channel,model,worker,reason,since,release_at,by) VALUES (?,?,?,?,?,?,?,?,?)');
  blocks.forEach((block,index)=>insertBlock.run(index,block.engine,optionalText(block.channel),optionalText(block.model),optionalText(block.worker),block.reason,block.since,optionalText(block.release_at),optionalText(block.by)));
  this.db.exec('DELETE FROM policy_channels');
  const insertChannel=this.db.prepare('INSERT INTO policy_channels(id,position,body) VALUES (?,?,?)');
  Object.entries(config.channels).forEach(([id,channel],index)=>insertChannel.run(id,index,JSON.stringify(channel)));
  this.db.exec('DELETE FROM policy_engines');
  const insertEngine=this.db.prepare('INSERT INTO policy_engines(id,position,enabled,kind,quota_refresh) VALUES (?,?,?,?,?)');
  Object.entries(config.engines).forEach(([id,engine],index)=>insertEngine.run(id,index,1,engine.kind,null));
  this.db.exec('DELETE FROM policy_owner_workers');
  this.db.exec('DELETE FROM policy_owners');
  const insertOwner=this.db.prepare('INSERT INTO policy_owners(id,position,enabled,channel,model,effort,max_parallel) VALUES (?,?,?,?,?,?,?)');
  const insertLink=this.db.prepare('INSERT INTO policy_owner_workers(owner_id,worker_id,position,weight) VALUES (?,?,?,?)');
  Object.entries(config.owners).forEach(([id,owner],index)=>{
   insertOwner.run(id,index,bit(owner.enabled),owner.channel,owner.model,owner.effort,owner.max_parallel);
   owner.workers.forEach((workerId,position)=>insertLink.run(id,workerId,position,owner.worker_weights&&Object.hasOwn(owner.worker_weights,workerId)?owner.worker_weights[workerId]!:null));
  });
  this.db.exec('DELETE FROM policy_workers');
  const insertWorker=this.db.prepare('INSERT INTO policy_workers(id,position,enabled,channels,model,effort,description,free_channel,max_parallel) VALUES (?,?,?,?,?,?,?,?,?)');
  Object.entries(config.workers).forEach(([id,worker],index)=>insertWorker.run(id,index,bit(worker.enabled),JSON.stringify(worker.channels),worker.model,worker.effort,optionalText(worker.description),worker.free_channel===undefined?null:bit(worker.free_channel),worker.max_parallel===undefined?null:worker.max_parallel));
  this.db.exec('DELETE FROM policy_settings');
  const insertSetting=this.db.prepare('INSERT INTO policy_settings(key,body) VALUES (?,?)');
  insertSetting.run('herdr',JSON.stringify(config.herdr));
  const extra=config as unknown as Record<string,unknown>;
  for(const key of SETTING_KEYS)if(extra[key]!==undefined)insertSetting.run(key,JSON.stringify(extra[key]));
 }
 /** Replace every row and stamp the snapshot as one revision, all or nothing. */
 private commit(config:Config,blocks:Block[],revision:number,source:string):void {
  const savedAt=new Date(this.now()).toISOString();
  const body=JSON.stringify({version:1,revision,config,blocks});
  const previous={config:this.config,blocks:this.blocks,revision:this.revision};
  transact(this.db,()=>{
   this.writeAll(config,blocks);
   this.db.prepare('INSERT INTO policy_revisions(revision,saved_at,source,body) VALUES (?,?,?,?)').run(revision,savedAt,source,body);
  });
  this.config=config;this.blocks=blocks;this.revision=revision;
  // Inside a caller's unit of work the snapshot only stands if that unit commits.
  onRollback(this.db,()=>{this.config=previous.config;this.blocks=previous.blocks;this.revision=previous.revision;});
 }
 /** Which SQLite connection the policy lives on; a unit of work is atomic across stores only when they share it. */
 get connection():unknown{return this.db;}
 /** Runs the work, and every policy save inside it, in one transaction that commits or rolls back together with the other stores on this connection. */
 transaction<T>(work:()=>T):T {return transact(this.db,work);}
 private parse(config: unknown, blocks: unknown, saving=false): {config:Config;blocks:Block[]} {
  bounded({config,blocks});
  // The schema-13 column remains for existing databases; engine switches no longer control execution.
  const candidate=structuredClone(object(config));
  const engines=object(candidate.engines);
  for(const [id,raw] of Object.entries(engines)) {
   if(raw && typeof raw==='object' && !Array.isArray(raw)) {
    const engine=raw as Record<string,unknown>;
    if(saving && engine.enabled===false) throw new Error(`Engines are always available; disable channel accounts or roles instead (${id})`);
    if(typeof engine.enabled==='boolean') engine.enabled=true;
   }
  }
  for(const entry of ENGINE_CATALOG) if(!Object.hasOwn(engines,entry.id)) engines[entry.id]={enabled:true,kind:entry.kind};
  const issues=validateConfig(candidate);
  if(issues.length) throw new Error(issues.map(i=>`${i.path}: ${i.message}`).join('\n'));
  const saved=candidate as unknown as Config;
  // Truthful reads: an older policy without max_command_minutes reports the default its runtime uses.
  const normalized:Config={...saved,herdr:{...defaultConfig().herdr,...saved.herdr}};
  return {config:normalized,blocks:blocksOf(blocks,normalized)};
 }
 snapshot(): PolicySnapshot {
  const blocks=activeBlocks({version:1,blocks:this.blocks},this.now());
  const context=this.routingContext();
  return structuredClone({revision:this.revision,config:this.config,blocks:this.blocks,activeBlocks:blocks,
   owners:Object.fromEntries(Object.entries(this.config.owners).map(([id,e])=>[id,availabilityOf(this.config,blocks,e)])),
   workers:Object.fromEntries(Object.entries(this.config.workers).map(([id,worker])=>{
    const candidates=workerChannelCandidates(this.config,blocks,id,context);
    const eligible=candidates.some(candidate=>candidate.eligible);
    const base=availabilityOf(this.config,blocks,worker,id);
    return [id,eligible?{status:'available'}:base.status!=='available'?base:{status:'blocked',engine:roleEngine(this.config,worker),worker:id,reason:[...new Set(candidates.map(candidate=>channelRoutingReason(candidate.reason)))].join('；')||'暂无可用账号'}];
   })),execution:'disabled'});
 }
 save(value: unknown, _options?: { allowEngineEnable?: boolean }): PolicySnapshot {
  const input=object(value); exact(input,['revision','config','blocks']);
  if(input.revision!==this.revision) throw new Error('Settings changed; reload before saving');
  const parsed=this.parse(input.config,input.blocks,true);
  this.commit(parsed.config,parsed.blocks,this.revision+1,'save');
  return this.snapshot();
 }
 /** Every retained revision, newest first: one entry per save, import or rollback. */
 history(): {revision:number;savedAt:string;source:string}[] {
  return (this.db.prepare('SELECT revision,saved_at,source FROM policy_revisions ORDER BY revision DESC').all() as Record<string,unknown>[])
   .map(row=>({revision:Number(row.revision),savedAt:String(row.saved_at),source:String(row.source)}));
 }
 /** The retained snapshot of one revision becomes a new revision; nothing is rewritten in place. */
 rollback(revision:number): PolicySnapshot {
  if(!Number.isSafeInteger(revision)||revision<1) throw new Error('Invalid policy revision');
  const row=this.db.prepare('SELECT body FROM policy_revisions WHERE revision=?').get(revision) as {body:string}|undefined;
  if(!row) throw new Error(`Policy revision ${revision} not found`);
  const data=object(JSON.parse(row.body)); exact(data,['version','revision','config','blocks']);
  if(data.version!==1) throw new Error('Unsupported policy snapshot');
  const upgraded=normalizeHistoricalPolicy(dropRetiredFields(data.config) as Record<string,any>,data.blocks as any[]);
  const parsed=this.parse(upgraded.config,upgraded.blocks);
  this.commit(parsed.config,parsed.blocks,this.revision+1,`rollback:${revision}`);
  return this.snapshot();
 }
}
