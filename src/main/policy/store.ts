import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { object } from '../../shared/validation';
import type { PolicySnapshot, RoutePreview } from '../../shared/policy';
import { activeBlocks, availabilityOf, chatgptReviewEnabled, defaultConfig, parseReleaseAt, resolveDispatch, validateConfig, type Config, type Block, type RouteOptions } from './routing';
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
/** App-owned single-writer settings. Never reads or changes upstream config/SQLite or a host home. */
export class PolicyStore {
 private config=defaultConfig(); private blocks: Block[]=[]; private revision=0;
 constructor(readonly path: string, private now: ()=>number=Date.now) {
  if(!existsSync(path)) return;
  if(statSync(path).size>LIMIT) throw new Error('Policy exceeds 256 KiB; file retained');
  const data=object(JSON.parse(readFileSync(path,'utf8'))); exact(data,['version','revision','config','blocks']);
  if(data.version!==1||!Number.isSafeInteger(data.revision)||Number(data.revision)<0) throw new Error('Unsupported policy store');
  const parsed=this.parse(data.config,data.blocks); this.config=parsed.config; this.blocks=parsed.blocks; this.revision=Number(data.revision);
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
  const data=JSON.stringify({version:1,revision:this.revision+1,...parsed},null,2); bounded(JSON.parse(data));
  mkdirSync(dirname(this.path),{recursive:true}); const temp=`${this.path}.${randomUUID()}.tmp`;
  try {
   writeFileSync(temp,data,{mode:0o600,flag:'wx'}); const fd=openSync(temp,'r'); try {fsyncSync(fd);} finally {closeSync(fd);}
   renameSync(temp,this.path);
  } finally { if(existsSync(temp)) unlinkSync(temp); }
  this.config=parsed.config; this.blocks=parsed.blocks; this.revision++; return this.snapshot();
 }
 preview(value: unknown): RoutePreview {
  const input=object(value); exact(input,['owner','worker','class','tag','runningCount']);
  const opts: RouteOptions={owner:text(input.owner,'owner')};
  for(const key of ['worker','class','tag'] as const) if(input[key]!==undefined) opts[key]=text(input[key],key);
  const count=input.runningCount??0; if(!Number.isSafeInteger(count)||Number(count)<0) throw new Error('Invalid running count');
  const route=resolveDispatch(this.config,activeBlocks({version:1,blocks:this.blocks},this.now()),opts);
  const maxParallel=this.config.owners[opts.owner].max_parallel;
  return {...route,maxParallel,capacityAvailable:Number(count)<maxParallel,chatgptReview:chatgptReviewEnabled(this.config)};
 }
}
