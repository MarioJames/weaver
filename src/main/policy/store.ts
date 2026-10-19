import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { object } from '../../shared/validation';
import type { PolicySnapshot, RoutePreview } from '../../shared/policy';
import { WEIGHT_MAX, activeBlocks, availabilityOf, chatgptReviewEnabled, defaultConfig, parseReleaseAt, resolveDispatch, validateConfig, type Config, type Block, type RouteOptions } from './routing';
const LIMIT=256*1024;
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value))>LIMIT) throw new Error('Policy exceeds 256 KiB'); }
function exact(value: Record<string, unknown>, keys: string[]): void { if (Object.keys(value).some(key=>!keys.includes(key))) throw new Error('Unknown policy field'); }
function text(value: unknown, label: string): string { if(typeof value!=='string'||!value.trim()||value.length>2000) throw new Error(`Invalid ${label}`); return value; }
function blocksOf(value: unknown, config: Config): Block[] {
 if(!Array.isArray(value)||value.length>500) throw new Error('Invalid quota blocks');
 const keys=new Set<string>();
 return value.map(raw=>{
  const b=object(raw); exact(b,['engine','model','reason','since','release_at','by']);
  const engine=text(b.engine,'engine'); if(!Object.hasOwn(config.engines,engine)) throw new Error(`Unknown engine ${engine}`);
  const block: Block={engine,reason:text(b.reason,'reason'),since:parseReleaseAt(text(b.since,'since'),0)};
  if (String(b.since).startsWith('+')) throw new Error('since must be an absolute timestamp');
  if(b.model!==undefined) block.model=text(b.model,'model');
  if(b.by!==undefined) block.by=text(b.by,'by');
  if(b.release_at!==undefined) {
   if(String(b.release_at).startsWith('+')) throw new Error('Stored release_at must be an absolute timestamp');
   block.release_at=parseReleaseAt(text(b.release_at,'release_at'),0);
  }
  const key=JSON.stringify([engine,block.model??null]); if(keys.has(key)) throw new Error('Duplicate engine/model quota block'); keys.add(key);
  return block;
 });
}
/** Task classes, worker tags, owner engine pins and the engine native-subagent flag were removed; saved policies keep loading without them. */
function dropRetiredFields(value: unknown): unknown {
 const config=object(value);
 for(const owner of Object.values(object(config.owners))) if(owner&&typeof owner==='object') delete (owner as Record<string,unknown>).only_engine;
 for(const worker of Object.values(object(config.workers))) if(worker&&typeof worker==='object') delete (worker as Record<string,unknown>).tags;
 for(const engine of Object.values(object(config.engines))) if(engine&&typeof engine==='object') delete (engine as Record<string,unknown>).native_subagents;
 return config;
}
/** Store-level marker: weights in this file are on the 0..10 scale. */
const WEIGHT_SCALE=10;
/** Pre-marker files used 0..100 with an omitted weight meaning 100: convert every owner once, omitted listed workers become an explicit 10. */
function migrateWeights(value: unknown): void {
 for(const owner of Object.values(object(object(value).owners))){
  if(!owner||typeof owner!=='object') continue;
  const o=owner as Record<string,unknown>;
  const map: Record<string,unknown>=o.worker_weights&&typeof o.worker_weights==='object'?o.worker_weights as Record<string,unknown>:{};
  for(const [k,w] of Object.entries(map)) if(typeof w==='number') map[k]=w===0?0:Math.min(WEIGHT_MAX,Math.max(1,Math.round(w/10)));
  if(Array.isArray(o.workers)) for(const id of o.workers) if(typeof id==='string'&&!Object.hasOwn(map,id)) map[id]=WEIGHT_MAX;
  if(Object.keys(map).length) o.worker_weights=map;
 }
}
function writeAtomic(path: string, data: string): void {
 const temp=`${path}.${randomUUID()}.tmp`;
 try {
  writeFileSync(temp,data,{mode:0o600,flag:'wx'}); const fd=openSync(temp,'r'); try {fsyncSync(fd);} finally {closeSync(fd);}
  renameSync(temp,path);
 } finally { if(existsSync(temp)) unlinkSync(temp); }
}
/** App-owned single-writer settings. Never reads or changes upstream config/SQLite or a host home. */
export class PolicyStore {
 private config=defaultConfig(); private blocks: Block[]=[]; private revision=0;
 constructor(readonly path: string, private now: ()=>number=Date.now) {
  if(!existsSync(path)) return;
  if(statSync(path).size>LIMIT) throw new Error('Policy exceeds 256 KiB; file retained');
  const data=object(JSON.parse(readFileSync(path,'utf8'))); exact(data,['version','revision','weightScale','config','blocks']);
  if(data.version!==1||!Number.isSafeInteger(data.revision)||Number(data.revision)<0) throw new Error('Unsupported policy store');
  if(data.weightScale!==undefined&&data.weightScale!==WEIGHT_SCALE) throw new Error('Unsupported policy weight scale');
  const migrated=data.weightScale===undefined; if(migrated) migrateWeights(data.config);
  const parsed=this.parse(dropRetiredFields(data.config),data.blocks); this.config=parsed.config; this.blocks=parsed.blocks; this.revision=Number(data.revision);
  if(migrated){
   // One-time 0..100 -> 0..10 migration (marker absent): keep the previous file, then replace atomically. Never runs again once weights fit.
   copyFileSync(path,`${path}.pre-weight10-${new Date(this.now()).toISOString().replace(/[:.]/g,'-')}`);
   writeAtomic(path,JSON.stringify({version:1,revision:this.revision,weightScale:WEIGHT_SCALE,...parsed},null,2));
  }
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
   workers:Object.fromEntries(Object.entries(this.config.workers).map(([id,e])=>[id,availabilityOf(this.config,blocks,e)])),execution:'disabled'});
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
  const data=JSON.stringify({version:1,revision:this.revision+1,weightScale:WEIGHT_SCALE,...parsed},null,2); bounded(JSON.parse(data));
  mkdirSync(dirname(this.path),{recursive:true}); writeAtomic(this.path,data);
  this.config=parsed.config; this.blocks=parsed.blocks; this.revision++; return this.snapshot();
 }
 preview(value: unknown): RoutePreview {
  const input=object(value); exact(input,['owner','worker','runningCount','workerLoad','excludeEngines']);
  const opts: RouteOptions={owner:text(input.owner,'owner')};
  if(input.worker!==undefined) opts.worker=text(input.worker,'worker');
  if(input.excludeEngines!==undefined){
   if(!Array.isArray(input.excludeEngines)||input.excludeEngines.length>50) throw new Error('Invalid excluded engines');
   opts.excludeEngines=input.excludeEngines.map(engine=>text(engine,'excluded engine'));
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
