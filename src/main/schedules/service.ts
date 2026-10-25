import type { ChannelBinding } from '../channels/runtime';
import { quotaRefreshEnabled } from '../../shared/policy/settings';
import { randomUUID } from 'node:crypto';
import type { ScheduleDefinition, ScheduleInput, ScheduleRun, ScheduleRunStatus } from '../../shared/contracts/schedules';
import type { CommandResponse } from '../../shared/contracts/commands';
import type { Task } from '../../shared/contracts/tasks';
import type { QuotaEngine, QuotaRefreshResult, QuotaSchedule } from '../../shared/contracts/quota';
import { quotaSettings, QUOTA_INTERVAL_RANGE, QUOTA_KINDS } from '../../shared/policy/settings';
import { object, parseId } from '../../shared/validation';
import { fail } from '../application/commands/errors';
import { recoverOwnedScope, startOwnedScope } from '../adapters/cli/scope';
import { startCliAgent } from '../adapters/cli/launch';
import type { CliAgentInput, ManagedAgentProcess } from '../adapters/cli/types';
import type { PreparedCliAgent } from '../adapters/cli/launch';
import { guardPiLaunch } from '../adapters/cli/pi-guard';
import type { PiModelCheck } from '../engines/pi-model-check';
import { createParentAgent, ConfirmedParentCancellation, ParentTurnNotSubmitted, ParentAgentError, type ParentAgentFactory, type ParentAgentInternals } from '../im/parent-agent';
import type { PolicyStore } from '../policy/store';
import { quotaRefreshTargets } from '../policy/quota';
import type { TaskStore } from '../store';
import { redactContext } from '../redact-context';
import { exact, input, INPUT_KEYS, integer, nextRun, timing } from './input';
import { executeScript, type ScriptExecution, type ScriptResult } from './process';
import { ScheduleStore, publicDefinition, publicRun, type ScheduleState, type StoredRun } from './store';
import { buildDirectPrompt, classifyScheduleAgent, cleanupStateDir, directStateDir, resolveEffectiveWorkspace, resolveScheduleProfile, scheduleDataDir, truncateDirectOutput } from './agent';
import type { RealEngineKind } from '../../shared/contracts/tasks';

export interface ScheduleOptions {
 store:TaskStore; policy:PolicyStore;
 createTask:(args:Record<string,unknown>)=>unknown;
 command:(command:'tasks.start'|'tasks.cancel',args:Record<string,unknown>,commandId:string)=>CommandResponse;
 notify:()=>void;
 refreshQuota?:(channel:string)=>Promise<QuotaRefreshResult>;
 now?:()=>number;
 /** Strict scope cleanup confirmation; tests pause/fail this boundary without touching IM/CLI semantics. */
 recoverScope?:(unit:string,invocation?:string)=>Promise<void>;
 /** Direct execution wiring; all optional for legacy/script-only consumers. */
 dataDir?:string;
 channelConfig?:(id:string)=>ChannelBinding;
 startCli?:(input:CliAgentInput,beforeSpawn?:(prepared:PreparedCliAgent)=>void)=>ManagedAgentProcess;
 parentFactory?:ParentAgentFactory;
 checkPiModel?:PiModelCheck;
}
function boundDefinitions(s:ScheduleState):void {
 const config=s.definitions.map(({lastRun,activeRunId,...d})=>d);
 if(Buffer.byteLength(JSON.stringify(config))>384*1024)fail('RESOURCE_LIMIT','Schedule definitions exceed 384 KiB');
}
const startId=(runId:string)=>`schedule-start-${runId}`;
/** Only a natively confirmed cancellation (or an abort-shaped error) counts as cancelled.
 * Auth/protocol/engine failures are never misreported as user cancellation. */
function isParentCancelEvidence(error:unknown):boolean {
 if(error instanceof ConfirmedParentCancellation||error instanceof ParentTurnNotSubmitted)return true;
 if(error instanceof ParentAgentError)return error.reason==='aborted';
 if(error instanceof Error&&error.name==='AbortError')return true;
 return false;
}
function definition(state:ScheduleState,id:unknown):ScheduleDefinition {
 const key=parseId(id,'schedule ID'),found=state.definitions.find(d=>d.id===key);
 return found??fail('NOT_FOUND','Schedule not found');
}
function revision(def:ScheduleDefinition,value:unknown,optional=false):void {
 if(optional&&value===undefined)return;
 integer(value,'expectedRevision',1,Number.MAX_SAFE_INTEGER);
 if(def.revision!==value)fail('REVISION_CONFLICT','Schedule changed; reload before saving');
}
/** A single app-owned poller. SQLite claims freeze execution parameters before any external effect. */
export class ScheduleService {
 referencesChannel(id:string):boolean {const state=this.storage.read();return state.definitions.some(def=>state.runs[def.id]?.some(run=>run.channel===id&&run.status==='running'));}
 readonly storage:ScheduleStore;
 private readonly clock:()=>number;
 private timer?:NodeJS.Timeout;
 private stopped=false;
  private jobs=new Map<string,Promise<unknown>>();
  private recovering=new Set<string>();
  private scripts=new Map<string,ScriptExecution>();
  private directs=new Map<string,{cancel:()=>void}>();
 constructor(private readonly options:ScheduleOptions){this.storage=new ScheduleStore(options.store);this.clock=options.now??Date.now;this.syncBuiltin();}
 private now():string{return new Date(this.clock()).toISOString();}
  private changed():void{this.options.notify();}
  private dataDir():string {return scheduleDataDir(this.options.store.path,this.options.dataDir);}
  private scopeConfirm(unit:string,invocation?:string):Promise<void> {
   if(this.options.recoverScope)return this.options.recoverScope(unit,invocation);
   return recoverOwnedScope(unit,invocation);
  }
 private syncBuiltin():void {
  const settings=quotaSettings(this.options.policy.snapshot().config),state=this.storage.read();
  const def=state.definitions.find(d=>d.builtin==='quota.refresh');
  const seconds=settings.interval_minutes*60;
  if(def&&def.enabled===settings.auto_refresh&&def.timing.mode==='interval'&&def.timing.seconds===seconds)return;
  this.storage.transaction(s=>{
   const current=s.definitions.find(d=>d.builtin==='quota.refresh');
   if(current){current.enabled=settings.auto_refresh;current.timing={mode:'interval',seconds};current.revision++;current.updatedAt=this.now();current.nextRunAt=current.enabled?nextRun(current.timing,this.clock()):null;}
   else s.definitions.push({id:randomUUID(),name:'额度自动刷新',kind:'script',builtin:'quota.refresh',enabled:settings.auto_refresh,timing:{mode:'interval',seconds},revision:1,createdAt:this.now(),updatedAt:this.now(),nextRunAt:settings.auto_refresh?nextRun({mode:'interval',seconds},this.clock()):null,lastRunAt:null});
  });
  this.changed();
 }
 quotaStatus():QuotaSchedule {
  this.syncBuiltin();const d=this.storage.read().definitions.find(d=>d.builtin)!;
  return {enabled:d.enabled,intervalMinutes:d.timing.mode==='interval'?d.timing.seconds/60:15,lastRunAt:d.lastRunAt,nextRunAt:d.nextRunAt};
 }
 list(a:Record<string,unknown>):{schedules:ScheduleDefinition[]} {
  exact(a,['kind','enabled']);if(a.kind!==undefined&&!['script','agent'].includes(String(a.kind)))fail('INVALID_REQUEST','Invalid kind');
  if(a.enabled!==undefined&&typeof a.enabled!=='boolean')fail('INVALID_REQUEST','enabled must be boolean');
  this.syncBuiltin();return {schedules:this.storage.read().definitions.filter(d=>(a.kind===undefined||a.kind===d.kind)&&(a.enabled===undefined||a.enabled===d.enabled)).map(publicDefinition)};
 }
 get(a:Record<string,unknown>):ScheduleDefinition {exact(a,['scheduleId']);this.syncBuiltin();return publicDefinition(definition(this.storage.read(),a.scheduleId));}
 create(a:Record<string,unknown>):ScheduleDefinition {
  const parsed=input(a,this.options.policy);
  const result=this.storage.transaction(s=>{
   if(s.definitions.length>=100)fail('RESOURCE_LIMIT','At most 100 schedules are supported');
   const def:ScheduleDefinition={...parsed,id:randomUUID(),revision:1,createdAt:this.now(),updatedAt:this.now(),nextRunAt:parsed.enabled?nextRun(parsed.timing,this.clock()):null,lastRunAt:null};s.definitions.push(def);boundDefinitions(s);return publicDefinition(def);
  });this.changed();return result;
 }
 update(a:Record<string,unknown>):ScheduleDefinition {
  exact(a,['scheduleId','expectedRevision','patch']);this.syncBuiltin();const patch=object(a.patch);exact(patch,INPUT_KEYS);
  const result=this.storage.transaction(s=>{
   const d=definition(s,a.scheduleId);revision(d,a.expectedRevision);
   if(patch.kind!==undefined&&patch.kind!==d.kind)fail('INVALID_REQUEST','Schedule kind cannot change');
   if(d.activeRunId&&Object.keys(patch).some(k=>k!=='enabled'))fail('INVALID_STATE','Active schedule execution fields cannot be edited');
   if(d.builtin){
    exact(patch,['enabled','timing']);if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')fail('INVALID_REQUEST','enabled must be boolean');
    const t=patch.timing===undefined?d.timing:timing(patch.timing);
    if(t.mode!=='interval')return fail('INVALID_REQUEST','Quota timing must use interval');
    if(t.seconds%60!==0||t.seconds<QUOTA_INTERVAL_RANGE.min*60||t.seconds>QUOTA_INTERVAL_RANGE.max*60)fail('INVALID_REQUEST','Quota interval must be 5–1440 whole minutes');
    const snapshot=this.options.policy.snapshot();snapshot.config.quota={auto_refresh:patch.enabled===undefined?d.enabled:patch.enabled as boolean,interval_minutes:t.seconds/60};
    this.options.policy.save({revision:snapshot.revision,config:snapshot.config,blocks:snapshot.blocks});
    const enabled=snapshot.config.quota.auto_refresh,changed=d.enabled!==enabled||d.timing.mode!=='interval'||d.timing.seconds!==t.seconds;
    if(changed){d.enabled=enabled;d.timing=t;d.nextRunAt=d.enabled?nextRun(t,this.clock()):null;d.revision++;d.updatedAt=this.now();}
   }else{
    // Enabling/disabling never revalidates or changes a frozen active run.
    const enabledOnly=Object.keys(patch).every(k=>k==='enabled');
    let parsed:ScheduleInput;
    if(enabledOnly){if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')fail('INVALID_REQUEST','enabled must be boolean');parsed={name:d.name,kind:d.kind,timing:d.timing,workspace:d.workspace,script:d.script,agent:d.agent,enabled:patch.enabled===undefined?d.enabled:patch.enabled as boolean};}
    else parsed=input({name:d.name,kind:d.kind,enabled:d.enabled,timing:d.timing,workspace:d.workspace,...(d.script?{script:d.script}:{}),...(d.agent?{agent:d.agent}:{}),...patch},this.options.policy);
    const reschedule=d.enabled!==parsed.enabled||JSON.stringify(d.timing)!==JSON.stringify(parsed.timing);
    Object.assign(d,parsed);d.revision++;d.updatedAt=this.now();if(reschedule)d.nextRunAt=d.enabled?nextRun(d.timing,this.clock()):null;
   }
   boundDefinitions(s);return publicDefinition(d);
  });this.changed();return result;
 }
 enable(a:Record<string,unknown>,enabled:boolean):ScheduleDefinition {exact(a,['scheduleId','expectedRevision']);return this.update({...a,patch:{enabled}});}
 delete(a:Record<string,unknown>):{deleted:true;scheduleId:string} {
  exact(a,['scheduleId','expectedRevision']);const result=this.storage.transaction(s=>{const d=definition(s,a.scheduleId);revision(d,a.expectedRevision);if(d.builtin||d.activeRunId)fail('INVALID_STATE','Builtin or active schedule cannot be deleted');s.definitions=s.definitions.filter(v=>v.id!==d.id);delete s.runs[d.id];return {deleted:true as const,scheduleId:d.id};});this.changed();return result;
 }
 runs(a:Record<string,unknown>):{runs:ScheduleRun[];total:number} {
  exact(a,['scheduleId','runId','offset','limit']);const state=this.storage.read(),d=definition(state,a.scheduleId),runs=state.runs[d.id]??[];
  if(a.runId!==undefined){const id=parseId(a.runId,'run ID'),r=runs.find(r=>r.id===id);if(!r)fail('NOT_FOUND','Run not found');return {runs:[this.storage.detail(r!)],total:1};}
  const offset=a.offset===undefined?0:integer(a.offset,'offset',0,100),limit=a.limit===undefined?20:integer(a.limit,'limit',1,100);
  return {runs:runs.slice(offset,offset+limit).map(r=>publicRun(r)),total:runs.length};
 }
 run(a:Record<string,unknown>):ScheduleRun {
  exact(a,['scheduleId','expectedRevision']);if(this.stopped)fail('APP_DRAINING','Scheduler stopped');this.syncBuiltin();
  const run=this.claim(a.scheduleId,'manual',a.expectedRevision);this.launch(run);return publicRun(run,true);
 }
 private claim(id:unknown,trigger:'manual'|'scheduled',expected?:unknown):StoredRun {
  const run=this.storage.transaction(s=>{
   const d=definition(s,id);revision(d,expected,true);if(d.activeRunId)fail('INVALID_STATE','Schedule already has an active run');
   // Revalidate profile/workspace immediately before claiming an agent or script.
   if(!d.builtin)input({name:d.name,kind:d.kind,enabled:d.enabled,timing:d.timing,workspace:d.workspace,...(d.script?{script:d.script}:{}),...(d.agent?{agent:d.agent}:{})},this.options.policy);
   const history=s.runs[d.id];
   const slots=new Set(history.slice(0,99).map(r=>r.outputSlot));
   const outputSlot=Array.from({length:100},(_,i)=>i).find(i=>!slots.has(i))!;
   const run:StoredRun={id:randomUUID(),scheduleId:d.id,outputSlot,trigger,status:'running',startedAt:this.now(),finishedAt:null,output:'',definition:structuredClone(d)};
   if(trigger==='scheduled'){run.scheduledFor=d.nextRunAt??this.now();d.nextRunAt=nextRun(d.timing,this.clock());}
   if(d.kind==='agent'){
    const executor=(d.agent as unknown as {executor?:{role:string;profileId:string}})?.executor;
    if(!executor||(executor.role!=='owner'&&executor.role!=='worker')||typeof executor.profileId!=='string'||!executor.profileId){
     // Old history rows keep taskId recovery; new definitions always carry executor via input().
     const legacy=(d.agent as unknown as {ownerProfileId?:string})?.ownerProfileId;
     if(typeof legacy==='string'&&legacy){
      const dataDir=this.dataDir();
      const {path:effective}=resolveEffectiveWorkspace(d.workspace,dataDir,d.id);
      const task=this.options.createTask({title:d.name,goal:d.agent!.goal,ownerProfileId:legacy,workspace:effective}) as {id:string};run.taskId=task.id;
     }else fail('INVALID_REQUEST','Agent schedule has no executor');
    }else{
     const snapshot=this.options.policy.snapshot();
     const profile=resolveScheduleProfile(snapshot,executor.role as 'owner'|'worker',executor.profileId);
     const kind=classifyScheduleAgent(executor.role as 'owner'|'worker',profile.kind);
     if(kind==='legacy-root'){
      const dataDir=this.dataDir();
      const {path:effective}=resolveEffectiveWorkspace(d.workspace,dataDir,d.id);
      const task=this.options.createTask({title:d.name,goal:d.agent!.goal,ownerProfileId:executor.profileId,workspace:effective}) as {id:string};run.taskId=task.id;
     }
     // Direct kinds persist the precise unit in the launch hook before any external effect.
    }
   }else if(!d.builtin)run.process={unit:`weaver-schedule-${run.id}`};
   d.activeRunId=run.id;d.lastRunAt=run.startedAt;d.lastRun=publicRun(run);s.runs[d.id]=[run,...s.runs[d.id]??[]].slice(0,100);return run;
  });this.changed();return run;
 }
 private track(id:string,job:Promise<unknown>):void {this.jobs.set(id,job);const clear=()=>{this.jobs.delete(id);};job.then(clear,clear);}
 private launch(run:StoredRun):void {
  // Normal path: the microtask starts once the durable command intent is committed. An
  // indeterminate start receipt reconciles against TaskStore instead of being replayed.
  const job=Promise.resolve().then(async()=>{
   if(this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id)?.status!=='running')return;
   if(this.stopped){this.finish(run,'interrupted',{error:'Scheduler stopped before execution'});return;}
   if(run.taskId){this.startAgent(run);return;}
   if(run.definition.builtin){await this.runQuota(run);return;}
   if(run.definition.kind==='script'){
    const dataDir=this.dataDir();
    const {path:effective}=resolveEffectiveWorkspace(run.definition.workspace,dataDir,run.scheduleId);
    const execution=executeScript(run.definition,run.process!.unit,invocation=>{
     this.storage.transaction(s=>{const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id);if(r?.status==='running'&&r.process)r.process.invocation=invocation;});
    },effective);this.scripts.set(run.id,execution);
    try{const result=await execution.done;await this.settleScript(run,result);}finally{this.scripts.delete(run.id);}
    return;
   }
   await this.executeDirectAgent(run);
  }).catch(error=>{this.finish(run,'failed',{error:redactContext(error instanceof Error?error.message:String(error),2000)});});
  this.track(run.id,job);
 }
 /** Strictly confirms the owned scope of a finished script before anything releases its claim.
  * A failed confirmation keeps the claim and the script result; the recover loop settles cleanup later. */
 private async settleScript(run:StoredRun,result:ScriptResult):Promise<void> {
  try{
   const persisted=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id);
   if(!persisted?.process)throw new Error('Missing persisted process identity; ownership inspection required');
   await this.scopeConfirm(persisted.process.unit,persisted.process.invocation);
  }
  catch(error){
   const message=redactContext(error instanceof Error?error.message:String(error),2000);
   this.storage.transaction(s=>{
    const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id);
    if(r?.status!=='running'||s.definitions.find(d=>d.id===run.scheduleId)?.activeRunId!==run.id)return;
    r.output=result.output;r.exitCode=result.exitCode;r.truncated=result.truncated;
    r.error=message;r.recoveryError=message;const d=s.definitions.find(d=>d.id===run.scheduleId);if(d)d.lastRun=publicRun(r);
   });this.changed();
   return;
  }
  this.finish(run,result.status,result);
 }
 /** Direct agent runs never start an owner root: CLI kinds stream a worker/owner CLI, claude workers use native send-once. */
 private async executeDirectAgent(run:StoredRun):Promise<void> {
  const frozen=run.definition;
  if(!frozen.agent)throw new Error('Agent schedule has no frozen goal; ownership inspection required');
  const executor=(frozen.agent as unknown as {executor?:{role:'owner'|'worker';profileId:string}}).executor;
  if(!executor)throw new Error('Agent schedule has no frozen executor; ownership inspection required');
  const dataDir=this.dataDir();
  let effective:string,unspecified:boolean;
  try{
   const resolved=resolveEffectiveWorkspace(frozen.workspace,dataDir,run.scheduleId);
   effective=resolved.path;unspecified=resolved.unspecified;
  }catch(error){this.finish(run,'failed',{error:redactContext(error instanceof Error?error.message:String(error),2000)});return;}
  let profile:ReturnType<typeof resolveScheduleProfile>;
  try{profile=resolveScheduleProfile(this.options.policy.snapshot(),executor.role,executor.profileId);}
  catch(error){this.finish(run,'failed',{error:redactContext(error instanceof Error?error.message:String(error),2000)});return;}
  let kind:ReturnType<typeof classifyScheduleAgent>;
  try{kind=classifyScheduleAgent(executor.role,profile.kind);}
  catch(error){this.finish(run,'failed',{error:redactContext(error instanceof Error?error.message:String(error),2000)});return;}
  if(kind==='legacy-root'){this.finish(run,'failed',{error:'Agent profile changed to legacy root after claim; cancel and retry'});return;}
  let prompt:string;
  try{prompt=buildDirectPrompt({role:executor.role,profileId:executor.profileId,goal:frozen.agent.goal,workspace:effective,unspecified,dataDir});}
  catch(error){this.finish(run,'failed',{error:redactContext(error instanceof Error?error.message:String(error),2000)});return;}
  this.storage.transaction(state=>{const stored=state.runs[run.scheduleId]?.find(item=>item.id===run.id);if(stored)stored.channel=profile.channel;});
  if(kind==='cli')await this.runDirectCli(run,{channel:profile.channel,engine:profile.kind as RealEngineKind,model:profile.model,effort:profile.effort,workspace:effective,prompt,role:executor.role});
  else await this.runDirectClaude(run,{channel:profile.channel,model:profile.model,effort:profile.effort,workspace:effective,prompt});
 }
 private observeDirectCli(proc:ManagedAgentProcess,cancelled:()=>boolean):Promise<{status:'succeeded'|'failed'|'cancelled';output:string;error?:string;exitCode:number|null;truncated:boolean}> {
  return new Promise(resolve=>{
   let resultSummary:string|undefined;
   let modelMismatch:string|undefined;
   let vendorError:string|undefined;
   let settled=false;
   const settle=(value:{status:'succeeded'|'failed'|'cancelled';output:string;error?:string;exitCode:number|null;truncated:boolean})=>{if(!settled){settled=true;resolve(value);}};
   let buffer='';
   proc.stdout.on('data',(chunk:Buffer)=>{
    buffer+=chunk.toString('utf8');
    let index:number;
    while((index=buffer.indexOf('\n'))>=0){
     const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
     if(!line.trim())continue;
     try{const record=JSON.parse(line) as {type?:string;summary?:string};if(record.type==='result'&&typeof record.summary==='string')resultSummary=record.summary;}catch{/* transport framing only; malformed lines never become public output */}
    }
   });
   proc.on('engine-model',(report:{actual:string;expected:string;match:boolean})=>{
    if(!report.match){modelMismatch=`${report.actual} 与配置 ${report.expected} 不一致；结果不可信，已终止`;try{proc.kill('SIGTERM');}catch{/* close owns the outcome */}}
   });
   proc.on('vendor-error',(message:string)=>{vendorError=String(message).slice(0,2048);});
   proc.on('error',(error:Error)=>{vendorError=vendorError??String(error instanceof Error?error.message:String(error)).slice(0,2000);});
   proc.on('close',(code:number|null)=>{
    if(buffer.trim()){
     try{const record=JSON.parse(buffer.trim()) as {type?:string;summary?:string};if(record.type==='result'&&typeof record.summary==='string')resultSummary=record.summary;}catch{/* ignore */}
    }
    const terminal=(proc.evidence as {terminal?:string})?.terminal??'missing';
    if(cancelled()){settle({status:'cancelled',output:resultSummary?truncateDirectOutput(resultSummary).output:'',exitCode:code,truncated:resultSummary?truncateDirectOutput(resultSummary).truncated:false});return;}
    if(modelMismatch){settle({status:'failed',output:'',error:redactContext(modelMismatch,2000),exitCode:code,truncated:false});return;}
    if(terminal!=='success'||code!==0||!resultSummary){
     const base=code===0&&terminal==='success'&&!resultSummary?'Worker exited without successful result':`Worker failed (terminal ${terminal}, code ${code})`;
     settle({status:'failed',output:'',error:redactContext(vendorError?`${base}; ${vendorError}`:base,2000),exitCode:code,truncated:false});return;
    }
    const {output,truncated}=truncateDirectOutput(resultSummary);
    settle({status:'succeeded',output,exitCode:code,truncated});
   });
  });
 }
 private async runDirectCli(run:StoredRun,opts:{channel:string;engine:RealEngineKind;model:string;effort:string;workspace:string;prompt:string;role:'owner'|'worker'}):Promise<void> {
  const dataDir=this.dataDir();
  const stateDir=directStateDir(dataDir,run.id);
  let capturedUnit:string|undefined;
  const rawStart=this.options.startCli??startCliAgent;
  const beforeSpawn=(prepared:PreparedCliAgent)=>{
   this.storage.transaction(s=>{
    const current=s.runs[run.scheduleId]?.find(r=>r.id===run.id);
    if(!current||current.status!=='running'||s.definitions.find(d=>d.id===run.scheduleId)?.activeRunId!==run.id)throw new Error('Schedule claim released before CLI launch');
    current.process={unit:prepared.unit};
   });capturedUnit=prepared.unit;this.changed();
  };
  const base=(input:CliAgentInput)=>rawStart(input,beforeSpawn);
  const launch=this.options.checkPiModel?guardPiLaunch(base as (input:CliAgentInput)=>ManagedAgentProcess,this.options.checkPiModel):base;
  let proc:ManagedAgentProcess|undefined;
  try{proc=launch({channel:opts.channel,channelConfig:this.options.channelConfig?.(opts.channel),engine:opts.engine,model:opts.model,effort:opts.effort,workspace:opts.workspace,instruction:opts.prompt,stateDir,role:opts.role}) as ManagedAgentProcess;}
  catch(error){
   if(!capturedUnit){
    const persisted=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id);
    if(!persisted?.process)cleanupStateDir(dataDir,run.id);
   }
   const persisted=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id);
   if(persisted?.process?.unit){
    const unit=persisted.process.unit,invocation=persisted.process.invocation;
    try{await this.scopeConfirm(unit,invocation);}catch(confirmError){
     const message=redactContext(confirmError instanceof Error?confirmError.message:String(confirmError),2000);
     this.storage.transaction(s=>{const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id);if(r?.status==='running'){r.error=message;r.recoveryError=message;const d=s.definitions.find(d=>d.id===run.scheduleId);if(d)d.lastRun=publicRun(r);}});this.changed();return;
    }
    cleanupStateDir(dataDir,run.id);
   }
   this.finish(run,'failed',{error:redactContext(error instanceof Error?error.message:String(error),2000)});
   return;
  }
  proc.on('identity',(invocation:string)=>this.persistCliInvocation(run,capturedUnit,invocation));
  let cancelRequested=false;
  this.directs.set(run.id,{cancel:()=>{cancelRequested=true;try{proc?.kill('SIGTERM');}catch{/* close owns the outcome */}}});
  try{
   const result=await this.observeDirectCli(proc,()=>cancelRequested||this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id)?.cancelRequested===true);
   const persisted=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id);
   const unit=persisted?.process?.unit??capturedUnit;
   if(!unit){
    // Nothing was ever launched (e.g. pi model missing): no scope to confirm.
    // A stop without user intent is an interruption, not a user cancellation.
    const intent=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id)?.cancelRequested===true;
    const status=result.status==='cancelled'?(intent?'cancelled':this.stopped?'interrupted':'cancelled'):'failed';
    this.finish(run,status,{output:result.output,error:result.error,exitCode:result.exitCode,truncated:result.truncated});
    cleanupStateDir(dataDir,run.id);
    return;
   }
   await this.settleDirect(run,result);
  }finally{this.directs.delete(run.id);}
 }
  /** Persist only the exact invocation observed for this run's persisted unit. */
  private persistCliInvocation(run:StoredRun,unit:string|undefined,invocation:string):void {
   if(!unit||typeof invocation!=='string'||!/^[0-9a-f]{32}$/.test(invocation))return;
   this.storage.transaction(s=>{
    const current=s.runs[run.scheduleId]?.find(r=>r.id===run.id);
    if(!current||current.status!=='running'||s.definitions.find(d=>d.id===run.scheduleId)?.activeRunId!==run.id||current.process?.unit!==unit)return;
    if(current.process.invocation&&current.process.invocation!==invocation){current.error='CLI schedule scope identity changed; manual ownership inspection required';current.recoveryError=current.error;return;}
    current.process.invocation=invocation;
   });this.changed();
  }
 /** Strictly confirms the owned CLI scope before anything releases a direct claim. */
 private async settleDirect(run:StoredRun,result:{status:'succeeded'|'failed'|'cancelled'|'interrupted';output:string;error?:string;exitCode:number|null;truncated:boolean}):Promise<void> {
  try{
   const persisted=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id);
   if(!persisted?.process)throw new Error('Missing persisted process identity; ownership inspection required');
   await this.scopeConfirm(persisted.process.unit,persisted.process.invocation);
  }catch(error){
   const message=redactContext(error instanceof Error?error.message:String(error),2000);
   this.storage.transaction(s=>{
    const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id);
    if(r?.status!=='running'||s.definitions.find(d=>d.id===run.scheduleId)?.activeRunId!==run.id)return;
    r.output=result.output;r.exitCode=result.exitCode??null;r.truncated=result.truncated;
    r.error=message;r.recoveryError=message;const d=s.definitions.find(d=>d.id===run.scheduleId);if(d)d.lastRun=publicRun(r);
   });this.changed();
   return;
  }
   cleanupStateDir(this.dataDir(),run.id);
   const intent=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id)?.cancelRequested===true;
   if(intent&&result.status!=='failed')this.finish(run,'cancelled',{output:result.output,error:result.error,exitCode:result.exitCode,truncated:result.truncated});
   // A service stop without user intent interrupts the direct execution; user cancel wins.
   else if(result.status==='cancelled'&&!intent&&this.stopped)this.finish(run,'interrupted',{output:result.output,error:result.error??'Scheduler stopped',exitCode:result.exitCode,truncated:result.truncated});
   else this.finish(run,result.status,{output:result.output,error:result.error,exitCode:result.exitCode,truncated:result.truncated});
 }
 /** Claude workers reuse the native parent session once: one send of the frozen goal prompt, then close.
  * The lifecycle control is registered before the factory resolves so a cancel/stop during
  * initialization only records intent: a late factory must never send the goal, and the claim
  * is held until the owned scope is exactly confirmed. Initialization alone is not work. */
 private async runDirectClaude(run:StoredRun,opts:{channel:string;model:string;effort:string;workspace:string;prompt:string}):Promise<void> {
  const unit=`weaver-schedule-${run.id}`;
  try{
   this.storage.transaction(s=>{
    const current=s.runs[run.scheduleId]?.find(r=>r.id===run.id);
    if(!current||current.status!=='running'||s.definitions.find(d=>d.id===run.scheduleId)?.activeRunId!==run.id)throw new Error('Schedule claim released before Claude launch');
    current.process={unit};
   });this.changed();
  }catch(error){this.finish(run,'failed',{error:redactContext(error instanceof Error?error.message:String(error),2000)});return;}
  const factory=this.options.parentFactory??createParentAgent;
  const launcher=((command:readonly string[],workspace:string,env?:Readonly<Record<string,string>>)=>startOwnedScope({command,cwd:workspace,env:(env ?? {}) as NodeJS.ProcessEnv,stdin:null,keepStdinOpen:true,unit})) as NonNullable<ParentAgentInternals['launch']>;
  // Registered synchronously before any await: cancel/stop during factory init only records
  // intent and precisely kills this run's known scope so a bounded startup rejects quickly.
  const pending:{session?:Awaited<ReturnType<ParentAgentFactory>>;abort?:AbortController;stopNotified:boolean}={stopNotified:false};
  const noteInitCancel=()=>{
   const intent=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id)?.cancelRequested===true;
   if(!intent)pending.stopNotified=true;
   if(pending.session){
    try{pending.abort?.abort();}catch{/* close owns the outcome */}
    void pending.session.close().catch(()=>{/* close failure keeps the claim */});
   }else{
    void this.scopeConfirm(unit,undefined).catch(()=>{/* late arrival still checks intent below */});
   }
  };
  this.directs.set(run.id,{cancel:noteInitCancel});
  let session:Awaited<ReturnType<ParentAgentFactory>>|undefined;
  try{
   session=await factory({channel:opts.channel,channelConfig:this.options.channelConfig?.(opts.channel),channelStateDir:directStateDir(this.options.dataDir??'',run.id),engineKind:'claude',model:opts.model,effort:opts.effort,workspace:opts.workspace,instructions:opts.prompt},{launch:launcher});
   pending.session=session;
  }catch(error){
   this.directs.delete(run.id);
   try{await this.scopeConfirm(unit,undefined);}
   catch(confirmError){
    const message=redactContext(confirmError instanceof Error?confirmError.message:String(confirmError),2000);
    this.storage.transaction(s=>{const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id);if(r?.status==='running'){r.error=message;r.recoveryError=message;const d=s.definitions.find(d=>d.id===run.scheduleId);if(d)d.lastRun=publicRun(r);}});this.changed();return;
   }
   const intent=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id)?.cancelRequested===true;
   if(intent)this.finish(run,'cancelled',{error:'Cancelled during initialization'});
   else if(pending.stopNotified||this.stopped)this.finish(run,'interrupted',{error:'Scheduler stopped during initialization'});
   else this.finish(run,'failed',{error:redactContext(error instanceof Error?error.message:String(error),2000)});
   return;
  }
  // Late arrival after cancel/stop/finish must never send the goal, replace, or replay.
  const fresh=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id);
  const lateIntent=fresh?.cancelRequested===true;
  const lateStop=pending.stopNotified||this.stopped;
  const released=!fresh||fresh.status!=='running'||this.storage.read().definitions.find(d=>d.id===run.scheduleId)?.activeRunId!==run.id;
  if(released||lateIntent||lateStop){
   try{await session.close();}
   catch(error){
    this.directs.delete(run.id);
    const message=redactContext(error instanceof Error?error.message:String(error),2000);
    this.storage.transaction(s=>{
     const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id);
     if(r?.status==='running'){r.error=message;r.recoveryError=message;const d=s.definitions.find(d=>d.id===run.scheduleId);if(d)d.lastRun=publicRun(r);}
    });this.changed();
    try{await this.scopeConfirm(unit,undefined);}catch{/* precise record already kept */}
    return;
   }
   this.directs.delete(run.id);
   try{await this.scopeConfirm(unit,undefined);}
   catch(error){
    const message=redactContext(error instanceof Error?error.message:String(error),2000);
    this.storage.transaction(s=>{
     const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id);
     if(r?.status==='running'){r.error=message;r.recoveryError=message;const d=s.definitions.find(d=>d.id===run.scheduleId);if(d)d.lastRun=publicRun(r);}
    });this.changed();return;
   }
   const current=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id);
   if(!current||current.status!=='running')return;
   const currentIntent=current.cancelRequested===true;
   if(currentIntent)this.finish(run,'cancelled',{error:'Cancelled during initialization'});
   else if(pending.stopNotified||this.stopped)this.finish(run,'interrupted',{error:'Scheduler stopped during initialization'});
   else this.finish(run,'cancelled',{error:'Cancelled during initialization'});
   return;
  }
  const abort=new AbortController();
  pending.abort=abort;
  this.directs.set(run.id,{cancel:()=>{
   const intent=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id)?.cancelRequested===true;
   if(!intent)pending.stopNotified=true;
   try{abort.abort();}catch{/* close owns the outcome */}
   void session!.close().catch(()=>{/* close failure keeps the claim */});
  }});
  let text:string|undefined;
  let sendError:unknown;
  try{text=await session.send(opts.prompt,abort.signal);}
  catch(error){sendError=error;}
  try{await session.close();}
  catch(error){
   const message=redactContext(error instanceof Error?error.message:String(error),2000);
   this.storage.transaction(s=>{
    const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id);
    if(r?.status==='running'){r.error=message;r.recoveryError=message;const d=s.definitions.find(d=>d.id===run.scheduleId);if(d)d.lastRun=publicRun(r);}
   });this.changed();
   try{await this.scopeConfirm(unit,undefined);}catch{/* precise record already kept */}
   finally{this.directs.delete(run.id);}
   return;
  }
  this.directs.delete(run.id);
  try{await this.scopeConfirm(unit,undefined);}
  catch(error){
   const message=redactContext(error instanceof Error?error.message:String(error),2000);
   this.storage.transaction(s=>{
    const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id);
    if(r?.status==='running'){if(text){r.output=truncateDirectOutput(text).output;r.truncated=truncateDirectOutput(text).truncated;}r.error=message;r.recoveryError=message;const d=s.definitions.find(d=>d.id===run.scheduleId);if(d)d.lastRun=publicRun(r);}
   });this.changed();return;
  }
  // User cancel wins; a stop without user intent interrupts; only genuine native
  // cancellation evidence stays cancelled, every other send failure is failed.
  const intent=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id)?.cancelRequested===true;
  const stopped=pending.stopNotified||this.stopped;
  if(intent){
   const message=sendError instanceof Error?sendError.message:String(sendError ?? 'cancelled');
   this.finish(run,'cancelled',{error:redactContext(message,2000)});
   return;
  }
  if(stopped){
   const message=sendError instanceof Error?sendError.message:String(sendError ?? 'Scheduler stopped');
   this.finish(run,'interrupted',{error:redactContext(message,2000)});
   return;
  }
  if(sendError){
   const message=sendError instanceof Error?sendError.message:String(sendError);
   this.finish(run,isParentCancelEvidence(sendError)?'cancelled':'failed',{error:redactContext(message,2000)});
   return;
  }
  if(abort.signal.aborted){
   this.finish(run,'cancelled',{error:'cancelled'});
   return;
  }
  if(!text||!text.trim()){this.finish(run,'failed',{error:'Claude worker exited without successful result'});return;}
  const {output,truncated}=truncateDirectOutput(text);
  this.finish(run,'succeeded',{output,truncated});
 }
 private startAgent(run:StoredRun):void {
  const response=this.options.command('tasks.start',{taskId:run.taskId},startId(run.id));
  if(response.ok){this.reconcileAgent(run);return;}
  this.abortAgent(run,response.error?redactContext(response.error.message,2000):'Agent start rejected');
 }
 private reconcileAgent(run:StoredRun):void {
  let task:Task;
  try{task=this.options.store.get(run.taskId!);}catch{this.agentPending(run,'Associated Agent task is missing; ownership inspection required');return;}
  if(['completed','failed','cancelled'].includes(task.status)){this.finish(run,task.status==='completed'?'succeeded':task.status==='cancelled'?'cancelled':'failed',{output:redactContext(task.summary??'',65536),error:task.failure?redactContext(task.failure.message,2000):undefined});return;}
  if(task.status!=='queued')return;
  const receipt=this.options.store.getReceipt(`local-demo:${startId(run.id)}`);
  if(!receipt){this.startAgent(run);return;}
  this.abortAgent(run,'Agent start intent was interrupted; queued draft cancelled without replay');
 }
 /** Cancels an uncertain agent start, then releases the claim only when the Task is verifiably terminal. */
 private abortAgent(run:StoredRun,message:string):void {
  const cancel=this.options.command('tasks.cancel',{taskId:run.taskId},`schedule-abort-${run.id}`);
  let task:Task|undefined;
  try{task=this.options.store.get(run.taskId!);}catch{task=undefined;}
  if(task&&['completed','failed','cancelled'].includes(task.status)){this.finish(run,'interrupted',{error:message});return;}
  const detail=task?`Agent cancel not confirmed; task remains ${task.status}`:'Associated Agent task is missing';
  const reason=cancel.ok?detail:`${detail} (cancel responded ${cancel.error?.code??'without an error code'})`;
  this.agentPending(run,reason);
 }
 private agentPending(run:StoredRun,reason:string):void {
  this.storage.transaction(s=>{
   const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id);
   if(r?.status!=='running'||s.definitions.find(d=>d.id===run.scheduleId)?.activeRunId!==run.id)return;
   r.error=reason;r.recoveryError=reason;const d=s.definitions.find(d=>d.id===run.scheduleId);if(d)d.lastRun=publicRun(r);
  });this.changed();
 }

 private finish(run:StoredRun,status:ScheduleRunStatus,patch:Partial<ScheduleRun>={}):void {
  this.storage.transaction(s=>{
   const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id),d=s.definitions.find(d=>d.id===run.scheduleId);
   if(!r||r.status!=='running'||!d||d.activeRunId!==r.id)return;
    Object.assign(r,patch,{status,finishedAt:this.now()});delete r.recoveryError;delete r.cancelRequested;d.lastRun=publicRun(r);delete d.activeRunId;
  });this.changed();
 }
 private async runQuota(run:StoredRun):Promise<void> {
  if(!this.options.refreshQuota){this.finish(run,'failed',{error:'Quota refresh service unavailable'});return;}
  const config=this.options.policy.snapshot().config;
  const targets=Object.entries(config.channels).filter(([,channel])=>channel.enabled&&quotaRefreshEnabled(channel,config.engines[channel.engine]?.kind)).sort(([,a],[,b])=>QUOTA_KINDS.indexOf(config.engines[a.engine].kind as typeof QUOTA_KINDS[number])-QUOTA_KINDS.indexOf(config.engines[b.engine].kind as typeof QUOTA_KINDS[number])).map(([id])=>id),output:string[]=[];let failures=0,observations=0;
  const cancelled=()=>this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id)?.cancelRequested;
  for(const engine of targets){
   if(cancelled()){this.finish(run,'cancelled',{output:redactContext(output.join('\n'),65536)});return;}
   if(this.stopped){this.finish(run,'interrupted',{output:output.join('\n'),error:'Scheduler stopped'});return;}
   try {
    const result=await this.options.refreshQuota(engine),record=result.records.find(r=>r.channel===engine);
    const fresh=record&&!record.stale&&record.checkedAt&&record.observedAt&&Date.parse(record.observedAt)>=Date.parse(run.startedAt)&&['available','exhausted'].includes(record.status);
    if(fresh){observations++;output.push(`${engine}: ${record.status} (fresh observation)`);}
    else{failures++;output.push(`${engine}: ${record?.status??'missing'} (${record?.retryAt?'cooldown; ':''}${record?.stale?'stale; ':''}${record?.detail??'no observation'})`);}
   }catch(error){failures++;output.push(`${engine}: ${error instanceof Error?error.message:String(error)}`);}
  }
  if(cancelled()){this.finish(run,'cancelled',{output:redactContext(output.join('\n'),65536)});return;}
  if(!targets.length){this.finish(run,'skipped',{output:redactContext('No enabled quota refresh targets',65536)});return;}
  // Probe misses (stale/unknown/cooldown records or a throwing engine probe) stay observable
  // in the per-engine output plus a summary line, but never fail the run itself. Only a real
  // execution failure (missing refresh service, scheduler exception, cancel/interrupt) fails it.
  if(failures)output.push(`${failures} 个目标未获得新鲜额度观测，${observations} 个成功`);
  this.finish(run,'succeeded',{output:redactContext(output.join('\n'),65536)});
 }
 cancel(a:Record<string,unknown>):ScheduleRun {
  exact(a,['scheduleId','runId']);const state=this.storage.read(),d=definition(state,a.scheduleId),id=parseId(a.runId,'run ID'),run=state.runs[d.id]?.find(r=>r.id===id);
  if(!run)fail('NOT_FOUND','Run not found');
  if(run!.status!=='running')return publicRun(run!,true);
  if(d.activeRunId!==id)fail('INVALID_STATE','Run is not the current active run');
  if(run!.taskId){const response=this.options.command('tasks.cancel',{taskId:run!.taskId},`schedule-cancel-${id}`);if(!response.ok)fail(response.error!.code,response.error!.message);this.reconcileAgent(run!);}
  else if(this.scripts.has(id))this.scripts.get(id)!.cancel();
  else if(this.directs.has(id)){this.storage.transaction(s=>{const r=s.runs[d.id]?.find(r=>r.id===id);if(r&&r.status==='running')r.cancelRequested=true;});this.changed();this.directs.get(id)!.cancel();}
  else if(run!.definition.builtin)this.storage.transaction(s=>{const r=s.runs[d.id].find(r=>r.id===id)!;r.cancelRequested=true;});
  else if(this.jobs.has(id)){
   // Recovery in progress only records the intent; the claim is released once cleanup confirms.
   // A queued launch is still pre-execution and finishes immediately.
   if(this.recovering.has(id))this.storage.transaction(s=>{const r=s.runs[d.id]?.find(r=>r.id===id);if(r&&r.status==='running')r.cancelRequested=true;});
   else this.finish(run!,'cancelled',{error:'Cancelled before execution'});
  }
  else{
   this.storage.transaction(s=>{const r=s.runs[d.id]?.find(r=>r.id===id);if(r&&r.status==='running')r.cancelRequested=true;});
   this.recover(run!,'cancelled');
  }
  return this.storage.detail(this.storage.read().runs[d.id].find(r=>r.id===id)!);
 }
 private recover(run:StoredRun,status:'interrupted'|'cancelled'='interrupted'):void {
  if(this.jobs.has(run.id))return;
  this.recovering.add(run.id);
  const job=(async()=>{
    try{
     const fresh=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id);
     if(fresh?.process)await this.scopeConfirm(fresh.process.unit,fresh.process.invocation);
     else if(!fresh||!fresh.definition.builtin)throw new Error('Missing persisted process identity; ownership inspection required');
     // The owned scope is confirmed closed: recycle only this run's private agent state.
     // Business workspaces and outputs live outside schedule-agent-state and are never touched.
     if(fresh?.process)cleanupStateDir(this.dataDir(),run.id);
     const intent=this.storage.read().runs[run.scheduleId]?.find(r=>r.id===run.id)?.cancelRequested===true;
     this.finish(run,intent?'cancelled':status,{error:'Previous service execution ended; owned process cleanup confirmed'});
    }
   catch(error){const message=redactContext(error instanceof Error?error.message:String(error),2000);this.storage.transaction(s=>{const r=s.runs[run.scheduleId]?.find(r=>r.id===run.id);if(r?.status==='running'){r.recoveryError=message;r.error=message;const d=s.definitions.find(d=>d.id===run.scheduleId);if(d)d.lastRun=publicRun(r);}});this.changed();}
   finally{this.recovering.delete(run.id);}
  })();this.track(run.id,job);
 }
 tick():void {
  if(this.stopped)return;this.syncBuiltin();
  const snapshot=this.storage.read();
  for(const d of snapshot.definitions){
   let reconciled=false;
   if(d.activeRunId){const run=snapshot.runs[d.id]?.find(r=>r.id===d.activeRunId);if(run?.taskId){this.reconcileAgent(run);reconciled=true;}else if(run&&!this.jobs.has(run.id))this.recover(run);}
   const current=reconciled?definition(this.storage.read(),d.id):d;
   if(!current.enabled||!current.nextRunAt||Date.parse(current.nextRunAt)>this.clock())continue;
   if(current.activeRunId){this.storage.transaction(s=>{const d=definition(s,current.id);d.nextRunAt=nextRun(d.timing,this.clock());});this.changed();continue;}
   try{this.launch(this.claim(current.id,'scheduled'));}catch(error){
    this.storage.transaction(s=>{const d=definition(s,current.id),run:StoredRun={id:randomUUID(),scheduleId:d.id,trigger:'scheduled',status:'failed',startedAt:this.now(),finishedAt:this.now(),scheduledFor:d.nextRunAt??undefined,output:'',error:redactContext(error instanceof Error?error.message:String(error),2000),definition:structuredClone(d)};s.runs[d.id]=[run,...s.runs[d.id]??[]].slice(0,100);d.lastRun=publicRun(run);d.lastRunAt=run.startedAt;d.nextRunAt=nextRun(d.timing,this.clock());});this.changed();
   }
  }
 }
 async start(everyMs=1000):Promise<void> {
  if(this.timer)return;this.stopped=false;
  const snapshot=this.storage.read();
  for(const d of snapshot.definitions){
   const r=d.activeRunId&&snapshot.runs[d.id]?.find(r=>r.id===d.activeRunId);if(!r)continue;
   // Time elapsed while the previous run owned the claim is busy time, including
   // service downtime. Skip those deadlines before releasing a recovered claim.
   if(d.enabled&&d.nextRunAt&&Date.parse(d.nextRunAt)<=this.clock()){
    this.storage.transaction(s=>{const current=definition(s,d.id);current.nextRunAt=nextRun(current.timing,this.clock());});this.changed();
   }
   if(r.taskId)this.reconcileAgent(r);else this.recover(r);
  }
  await Promise.allSettled([...this.jobs.values()]);
  const tick=()=>{try{this.tick();}catch(error){console.error(`Schedule tick failed: ${redactContext(error instanceof Error?error.message:String(error),500)}`);}};
  tick();this.timer=setInterval(tick,everyMs);this.timer.unref();
 }
 async stop():Promise<void> {
  this.stopped=true;clearInterval(this.timer);this.timer=undefined;
  for(const execution of this.scripts.values())execution.cancel('interrupted');
  for(const direct of this.directs.values()){try{direct.cancel();}catch{/* close owns the outcome */}}
  await Promise.allSettled([...this.jobs.values()]);
 }
}
