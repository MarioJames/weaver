import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { object } from '../../shared/validation';
import type { PolicySnapshot, RoutePreview } from '../../shared/policy';
import { activeBlocks, availabilityOf, chatgptReviewEnabled, defaultConfig, parseReleaseAt, resolveDispatch, validateConfig, type Config, type Block, type Engine, type Owner, type RouteOptions, type Worker } from './routing';
import { migrate } from '../migrate';
const LIMIT=256*1024;
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value))>LIMIT) throw new Error('Policy exceeds 256 KiB'); }
function exact(value: Record<string, unknown>, keys: string[]): void { if (Object.keys(value).some(key=>!keys.includes(key))) throw new Error('Unknown policy field'); }
function text(value: unknown, label: string): string { if(typeof value!=='string'||!value.trim()||value.length>2000) throw new Error(`Invalid ${label}`); return value; }
function blocksOf(value: unknown, config: Config): Block[] {
 if(!Array.isArray(value)||value.length>500) throw new Error('Invalid quota blocks');
 const keys=new Set<string>();
 return value.map(raw=>{
  const b=object(raw); exact(b,['engine','model','worker','reason','since','release_at','by']);
  const engine=text(b.engine,'engine'); if(!Object.hasOwn(config.engines,engine)) throw new Error(`Unknown engine ${engine}`);
  const block: Block={engine,reason:text(b.reason,'reason'),since:parseReleaseAt(text(b.since,'since'),0)};
  if (String(b.since).startsWith('+')) throw new Error('since must be an absolute timestamp');
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
  const key=JSON.stringify([engine,block.model??null,block.worker??null]); if(keys.has(key)) throw new Error('Duplicate engine/model/worker quota block'); keys.add(key);
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
const SETTING_KEYS=['$schema','chatgpt_review','quota','free_channel_probe','display'];
const bit=(value:boolean)=>value?1:0;
const optionalText=(value:string|undefined)=>value===undefined?null:value;
/** App-owned single-writer settings in the same weaver.db as the task store. Never touches upstream config or a host home. */
export class PolicyStore {
 private db:DatabaseSync;
 private config:Config=defaultConfig();
 private blocks: Block[]=[];
 private revision=0;
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
   const engine={enabled:Number(row.enabled)===1,kind:String(row.kind)} as Engine;
   if(row.quota_refresh!==null&&row.quota_refresh!==undefined)engine.quota_refresh=Number(row.quota_refresh)===1;
   engines[String(row.id)]=engine;
  }
  const ownerWorkerRows=this.db.prepare('SELECT * FROM policy_owner_workers ORDER BY position').all() as Record<string,unknown>[];
  const owners:Config['owners']={};
  for(const row of this.db.prepare('SELECT * FROM policy_owners ORDER BY position').all() as Record<string,unknown>[]){
   const id=String(row.id);
   const links=ownerWorkerRows.filter(item=>String(item.owner_id)===id);
   const owner={enabled:Number(row.enabled)===1,engine:String(row.engine),model:String(row.model),effort:String(row.effort),workers:links.map(item=>String(item.worker_id)),max_parallel:Number(row.max_parallel)} as Owner;
   if(row.proxy!==null&&row.proxy!==undefined)owner.proxy=String(row.proxy);
   const weights:Record<string,number>={};
   for(const item of links)if(item.weight!==null&&item.weight!==undefined)weights[String(item.worker_id)]=Number(item.weight);
   if(Object.keys(weights).length)owner.worker_weights=weights;
   owners[id]=owner;
  }
  const workers:Config['workers']={};
  for(const row of this.db.prepare('SELECT * FROM policy_workers ORDER BY position').all() as Record<string,unknown>[]){
   const id=String(row.id);
   const worker={enabled:Number(row.enabled)===1,engine:String(row.engine),model:String(row.model),effort:String(row.effort)} as Worker;
   if(row.proxy!==null&&row.proxy!==undefined)worker.proxy=String(row.proxy);
   if(row.description!==null&&row.description!==undefined)worker.description=String(row.description);
   if(row.free_channel!==null&&row.free_channel!==undefined)worker.free_channel=Number(row.free_channel)===1;
   workers[id]=worker;
  }
  const settings:Record<string,unknown>={};
  for(const row of this.db.prepare('SELECT key,body FROM policy_settings').all() as Record<string,unknown>[])settings[String(row.key)]=JSON.parse(String(row.body));
  // Same key order as the saved document, so reading the policy back looks like what was saved.
  const built:Record<string,unknown>={};
  if(settings.$schema!==undefined)built.$schema=settings.$schema;
  built.version=1;
  if(settings.chatgpt_review!==undefined)built.chatgpt_review=settings.chatgpt_review;
  built.engines=engines;built.owners=owners;built.workers=workers;
  built.herdr=settings.herdr!==undefined?settings.herdr:defaultConfig().herdr;
  for(const key of ['quota','free_channel_probe','display'])if(settings[key]!==undefined)built[key]=settings[key];
  const config=built as unknown as Config;
  const blocks=(this.db.prepare('SELECT * FROM policy_blocks ORDER BY position').all() as Record<string,unknown>[]).map(row=>{
   const block:Block={engine:String(row.engine),reason:String(row.reason),since:String(row.since)};
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
  const insertBlock=this.db.prepare('INSERT INTO policy_blocks(position,engine,model,worker,reason,since,release_at,by) VALUES (?,?,?,?,?,?,?,?)');
  blocks.forEach((block,index)=>insertBlock.run(index,block.engine,optionalText(block.model),optionalText(block.worker),block.reason,block.since,optionalText(block.release_at),optionalText(block.by)));
  this.db.exec('DELETE FROM policy_engines');
  const insertEngine=this.db.prepare('INSERT INTO policy_engines(id,position,enabled,kind,quota_refresh) VALUES (?,?,?,?,?)');
  Object.entries(config.engines).forEach(([id,engine],index)=>insertEngine.run(id,index,bit(engine.enabled),engine.kind,engine.quota_refresh===undefined?null:bit(engine.quota_refresh)));
  this.db.exec('DELETE FROM policy_owner_workers');
  this.db.exec('DELETE FROM policy_owners');
  const insertOwner=this.db.prepare('INSERT INTO policy_owners(id,position,enabled,engine,model,effort,proxy,max_parallel) VALUES (?,?,?,?,?,?,?,?)');
  const insertLink=this.db.prepare('INSERT INTO policy_owner_workers(owner_id,worker_id,position,weight) VALUES (?,?,?,?)');
  Object.entries(config.owners).forEach(([id,owner],index)=>{
   insertOwner.run(id,index,bit(owner.enabled),owner.engine,owner.model,owner.effort,optionalText(owner.proxy),owner.max_parallel);
   owner.workers.forEach((workerId,position)=>insertLink.run(id,workerId,position,owner.worker_weights&&Object.hasOwn(owner.worker_weights,workerId)?owner.worker_weights[workerId]!:null));
  });
  this.db.exec('DELETE FROM policy_workers');
  const insertWorker=this.db.prepare('INSERT INTO policy_workers(id,position,enabled,engine,model,effort,proxy,description,free_channel) VALUES (?,?,?,?,?,?,?,?,?)');
  Object.entries(config.workers).forEach(([id,worker],index)=>insertWorker.run(id,index,bit(worker.enabled),worker.engine,worker.model,worker.effort,optionalText(worker.proxy),optionalText(worker.description),worker.free_channel===undefined?null:bit(worker.free_channel)));
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
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.writeAll(config,blocks);
   this.db.prepare('INSERT INTO policy_revisions(revision,saved_at,source,body) VALUES (?,?,?,?)').run(revision,savedAt,source,body);
   this.db.exec('COMMIT');
  }catch(error){try{this.db.exec('ROLLBACK');}catch{/* SQLite may already have rolled back an I/O failure. */}throw error;}
  this.config=config;this.blocks=blocks;this.revision=revision;
 }
 private parse(config: unknown, blocks: unknown): {config:Config;blocks:Block[]} {
  bounded({config,blocks}); const issues=validateConfig(config);
  if(issues.length) throw new Error(issues.map(i=>`${i.path}: ${i.message}`).join('\n'));
  return {config:structuredClone(config as Config),blocks:blocksOf(blocks,config as Config)};
 }
 snapshot(): PolicySnapshot {
  const blocks=activeBlocks({version:1,blocks:this.blocks},this.now());
  return structuredClone({revision:this.revision,config:this.config,blocks:this.blocks,activeBlocks:blocks,
   owners:Object.fromEntries(Object.entries(this.config.owners).map(([id,e])=>[id,availabilityOf(this.config,blocks,e)])),
   workers:Object.fromEntries(Object.entries(this.config.workers).map(([id,e])=>[id,availabilityOf(this.config,blocks,e,id)])),execution:'disabled'});
 }
 save(value: unknown, options?: { allowEngineEnable?: boolean }): PolicySnapshot {
  const input=object(value); exact(input,['revision','config','blocks']);
  if(input.revision!==this.revision) throw new Error('Settings changed; reload before saving');
  const parsed=this.parse(input.config,input.blocks);
  if (!options?.allowEngineEnable) {
   for (const [id, engine] of Object.entries(parsed.config.engines)) {
    if (engine.enabled && this.config.engines[id]?.enabled !== true) throw new Error(`Engine ${id} cannot be enabled by policy save; use the probe toggle`);
   }
  }
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
  const parsed=this.parse(dropRetiredFields(data.config),data.blocks);
  this.commit(parsed.config,parsed.blocks,this.revision+1,`rollback:${revision}`);
  return this.snapshot();
 }
 preview(value: unknown): RoutePreview {
  const input=object(value); exact(input,['owner','worker','runningCount','workerLoad','excludeEngines','excludeWorkers']);
  const opts: RouteOptions={owner:text(input.owner,'owner')};
  if(input.worker!==undefined) opts.worker=text(input.worker,'worker');
  if(input.excludeEngines!==undefined){
   if(!Array.isArray(input.excludeEngines)||input.excludeEngines.length>50) throw new Error('Invalid excluded engines');
   opts.excludeEngines=input.excludeEngines.map(engine=>text(engine,'excluded engine'));
  }
  if(input.excludeWorkers!==undefined){
   if(!Array.isArray(input.excludeWorkers)||input.excludeWorkers.length>200) throw new Error('Invalid excluded workers');
   opts.excludeWorkers=input.excludeWorkers.map(worker=>text(worker,'excluded worker'));
  }
  if(input.workerLoad!==undefined){
   const load=object(input.workerLoad);
   for(const n of Object.values(load)) if(!Number.isSafeInteger(n)||Number(n)<0) throw new Error('Invalid worker load');
   opts.workerLoad=load as Record<string,number>;
  }
  const count=input.runningCount??0; if(!Number.isSafeInteger(count)||Number(count)<0) throw new Error('Invalid running count');
  const route=resolveDispatch(this.config,activeBlocks({version:1,blocks:this.blocks},this.now()),opts);
  const maxParallel=this.config.owners[opts.owner].max_parallel;
  return {...route,maxParallel,capacityAvailable:Number(count)<maxParallel,chatgptReview:chatgptReviewEnabled(this.config)};
 }
}
