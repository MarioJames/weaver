import { createHash, randomUUID } from 'node:crypto';
import { API_VERSION, ownerSession, sameOwnerInstance, type CommandResponse, type DispatchNext, type LogicalOwner, type OwnerInstance, type WorkPackage } from '../shared/commands';
import type { Task } from '../shared/types';
import { object, parseId, parseTaskInput, parseWorkerRecord, text, PENDING_TASK_TITLE } from '../shared/validation';
import { TaskManager } from './manager';
import { engineLadderKey, event, slotGroupCount, slotGroupFor, slotGroupName } from './store';
import { ContinuationService, ContinuationError, handoffPrompt, rootOwnerPrompt, redactContext } from './continuation';
import { MockOwnerHostAdapter, type OwnerHostEvidence, type OwnerMessage } from './adapters/logical';
import { launchOwner, launchOwnerAsync, closeOwnerHost, closeOwnerHostAsync, herdrOnPath, OwnerLaunchError, type OwnerLaunchInput, type OwnerLaunchResult } from './owner-host';
import type { TaskOwnerHost } from '../shared/types';
import type { StallMonitor, StallStatus } from './stall';
import { PolicyStore } from './policy/store';
import type { RoutePreview } from '../shared/policy';
import { QUOTA_CAPABILITIES } from './policy/quota';
import { EXCLUDED_ENGINE_REASON, VENDOR_BLOCK_SOURCE, escalateEngineBlock, type Block } from './policy/routing';
import { absoluteExistingWorkspace, assertFrozenWorkspace, workspaceIdentity, listWorkspaceDirectories, isRealEngineKind, REAL_ENGINE_KINDS } from './workspace';
import { vendorBlockReason } from './adapters/cli/vendor-errors';
import { workerInstruction } from './adapters/instruction';
/** Vendor rate limit ladder in minutes, level 1..3; shared with the free-channel probe monitor. */
export const VENDOR_LADDER_MINUTES = [10, 30, 60] as const;
export const WRITE_COMMANDS = ['owners.attach','owners.spawn','owners.switch','owners.launch','owners.continuation.configure','tasks.create','tasks.start','tasks.complete','tasks.describe','tasks.retry','tasks.cancel','packages.create','workers.spawn','workers.complete','results.deliver','results.ack','reviews.submit','engines.unblock'] as const;
export const READ_COMMANDS = ['workspaces.list','capabilities.get','sync.snapshot','sync.status','owners.list','owners.get','owners.continuation.get','tasks.get','tasks.list','tasks.events','tasks.results','tasks.health','artifacts.read','packages.get','operations.get','observability.get','observability.export','engines.health','engines.penalty'] as const;
const writes=new Set<string>(WRITE_COMMANDS);
/** Running tasks per worker across every owner: the load that weighted dispatch balances. */
export function workerLoad(tasks: Task[]): Record<string, number> {
 const load: Record<string, number> = {};
 for (const task of tasks) if ((task.status === 'running' || task.status === 'cancelling') && task.dispatch?.worker) load[task.dispatch.worker] = (load[task.dispatch.worker] ?? 0) + 1;
 return load;
}
/** Scale hint, not an admission rule: admission is per owner instance, so this sum over enabled profiles caps nothing by itself. */
export function configuredParallel(policy: PolicyStore): number {
 return Object.values(policy.snapshot().config.owners).filter(owner => owner.enabled).reduce((sum, owner) => sum + owner.max_parallel, 0);
}
class CommandError extends Error {constructor(readonly code:string,message:string){super(message);}}
const fail=(code:string,message:string):never=>{throw new CommandError(code,message);};
/** The stall monitor is the only judge of silence, idle CPU and penalties, so the command face reads it
 * through the narrowest view that answers: one task's health, the engine status, one explicit unblock. */
export type TaskDiagnostics = Pick<StallMonitor, 'taskHealth' | 'status' | 'unblock'>;
/** What an owner sees per engine without the retained history: the same numbers the monitor armed its penalty with. */
const engineSummary=(item: StallStatus['engines'][string]) => ({level:item.level,lastTriggerAt:item.lastTriggerAt,needsAttention:item.needsAttention,blocked:item.blocked,blockedUntil:item.blockedUntil,nextProbeAt:item.nextProbeAt,probeSuccesses:item.probeSuccesses});
function canonical(value:unknown):string {if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;return JSON.stringify(value);}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const terminal=(t:Task)=>['completed','failed','cancelled'].includes(t.status);
/** The attempt ended on a vendor rate limit or exhausted quota. */
const vendorLimited=(t:Task)=>t.status==='failed'&&(t.failure?.kind==='rate_limit'||t.failure?.kind==='quota');
/** A single app-owned handler shared by the loopback UI and CLI. The local principal is deliberately
 * trusted-local-machine scope, not an OS-user login or a real-agent grant. */
type OwnerEffect = { kind:'launch'; input:OwnerLaunchInput } | { kind:'close'; host:OwnerLaunchResult } | {kind:'first-output';taskId:string};
type CommandFlow<T> = Generator<OwnerEffect,T,OwnerLaunchResult | undefined>;
export interface AsyncOwnerHost { launcher?:typeof launchOwnerAsync; closer?:typeof closeOwnerHostAsync }
export class CommandHandler {
 draining=false;
 transportStatus:'ready'|'unavailable'|'not-started'='not-started';
 private ownerHost=new MockOwnerHostAdapter();
 private continuation:ContinuationService;
  constructor(readonly manager:TaskManager,readonly policy:PolicyStore,
   private readonly hostLauncher: typeof launchOwner = launchOwner, private readonly herdrPresent: () => boolean = () => herdrOnPath(),
   private readonly diagnostics?: TaskDiagnostics, private readonly asyncHost:AsyncOwnerHost = {}){
   this.continuation=new ContinuationService(manager.store,this.ownerHost);
   // Historical failures must not recreate a block after an explicit unblock or restart.
   for(const task of manager.store.listHeads())if(task.failure)this.vendorBlockedAttempts.add(task.run?.id??task.id);
  manager.listeners.add(()=>this.pump());
  for(const owner of manager.store.listOwners()) if(owner.host)this.ownerHost.restore(owner.host as OwnerHostEvidence,(owner.messages??[]) as OwnerMessage[]);
  this.pump();
 }
 private readonly pending = new Set<Promise<CommandResponse>>();
 private readonly launches = new Set<AbortController>();
 private readonly launchingEpochs = new Set<string>();
 handle(value:unknown):CommandResponse {
  const flow=this.handleFlow(value);let step=flow.next();
  while(!step.done){
   let host:OwnerLaunchResult|undefined;
   try {
    if(step.value.kind==='first-output'){ /* Synchronous internal callers receive the current snapshot. RPC uses handleAsync. */ }
    else if(step.value.kind==='close')closeOwnerHost(step.value.host);
    else host=this.hostLauncher(step.value.input);
   }catch(error){step=flow.throw(error);continue;}
   step=flow.next(host);
  }
  return step.value;
 }
 handleAsync(value:unknown):Promise<CommandResponse> {
  const controller=new AbortController();this.launches.add(controller);
  const job=this.driveAsync(this.handleFlow(value),controller.signal);
  this.pending.add(job);
  const settled=()=>{this.pending.delete(job);this.launches.delete(controller);};
  job.then(settled,settled);return job;
 }
 private async driveAsync(flow:CommandFlow<CommandResponse>,signal:AbortSignal):Promise<CommandResponse>{
  const deadline=Date.now()+8000;
  let step=flow.next();
  while(!step.done){
   let host:OwnerLaunchResult|undefined;
   try {
    const effect=step.value;
    if(effect.kind==='first-output')await this.manager.waitForFirstOutput(effect.taskId,Math.max(0,deadline-Date.now()));
    else if(effect.kind==='close')await (this.asyncHost.closer??closeOwnerHostAsync)(effect.host);
    else host=await (this.asyncHost.launcher??(this.hostLauncher===launchOwner?launchOwnerAsync:async input=>this.hostLauncher(input)))({...effect.input,signal});
   }catch(error){step=flow.throw(error);continue;}
   step=flow.next(host);
  }
  return step.value;
 }
 async drain():Promise<void>{
  this.draining=true;clearImmediate(this.pumpScheduled);this.pumpScheduled=undefined;for(const controller of this.launches)controller.abort();
  await Promise.allSettled([...this.pending]);
 }
 private *handleFlow(value:unknown):CommandFlow<CommandResponse> {
  let commandId:string|undefined; let receiptKey:string|undefined; let effected=false;
  try {
   if(Buffer.byteLength(JSON.stringify(value))>128*1024)fail('INVALID_REQUEST','Request exceeds 128 KiB');
   const r=object(value); if(r.apiVersion!==API_VERSION)fail('VERSION_UNSUPPORTED','Expected weaver.v1');
   const command=text(r.command,'command',80); const args=structuredClone(object(r.args??{}));
   if(r.commandId!==undefined)commandId=text(r.commandId,'commandId',120);
   if(this.draining)fail('APP_DRAINING','App is shutting down');
   if(writes.has(command)) {
    if(!commandId)fail('INVALID_REQUEST','Mutation requires commandId');
    receiptKey=`local-demo:${commandId}`;const hash=digest({command,args});const old=this.manager.store.getReceipt(receiptKey);
    if(old) {if(old.hash!==hash)fail('IDEMPOTENCY_CONFLICT','commandId already used for different arguments');if(old.response)return old.response;fail('COMMAND_INDETERMINATE','Previous command was interrupted. Inspect tasks/owners before issuing a new command; no automatic replay was performed.');}
    // Durable intent first: a crash can block a retry, but cannot silently repeat a spawn.
    this.manager.store.putReceipt(receiptKey,{hash});
   }
   let data=command==='owners.launch'||command==='owners.switch'?yield* this.executeOwner(command,args):this.execute(command,args);
   if((command==='workers.spawn'||command==='tasks.retry') && data && typeof data==='object' && 'id' in data){
    const snapshot=data as Task; if(snapshot.dispatch?.execution==='real'&&snapshot.status==='running'){
     yield {kind:'first-output',taskId:snapshot.id};
     data={...data,...this.publicTask(this.manager.store.get(snapshot.id)),started:!!this.manager.store.get(snapshot.id).run?.firstOutputAt};
    }
   }
   const response:CommandResponse={apiVersion:API_VERSION,commandId,ok:true,data};
   effected=true;if(writes.has(command))this.manager.notify();if(receiptKey)this.finish(receiptKey,response);return response;
  }catch(error){
   if(effected)return {apiVersion:API_VERSION,commandId,ok:false,error:{code:'COMMAND_INDETERMINATE',message:'Command applied but receipt persistence failed; inspect current state before retrying',retryable:false}};
   const response:CommandResponse={apiVersion:API_VERSION,commandId,ok:false,error:{code:error instanceof CommandError||error instanceof ContinuationError?error.code:'INVALID_REQUEST',message:error instanceof Error?error.message:'Command failed',retryable:false}};
   // Never replace a prior receipt on conflict or overwrite an incomplete durable intent.
   if(receiptKey && !['IDEMPOTENCY_CONFLICT','COMMAND_INDETERMINATE'].includes(response.error!.code)) {
    const receipt=this.manager.store.getReceipt(receiptKey);
    if(receipt&&!receipt.response)try{this.finish(receiptKey,response);}catch{return {...response,error:{code:'PERSISTENCE_ERROR',message:'Could not persist receipt; inspect current state before retrying',retryable:false}};}
   }
   return response;
  }
 }
 private finish(key:string,response:CommandResponse){const receipt=this.manager.store.getReceipt(key);if(!receipt)throw new Error('Command intent missing');this.manager.store.putReceipt(key,{...receipt,response});}
 private owner(id:unknown):LogicalOwner {const owner=this.manager.store.getOwner(parseId(id));if(!owner)fail('NOT_FOUND','Owner not found');return owner!;}
 /** Work holding this instance's own slots: running plus cancelling. Queued and terminal tasks hold none. */
 private runningOn(owner:LogicalOwner):number {return slotGroupCount(this.manager.store.listHeads(),slotGroupFor(owner.id,owner.profileId));}
 /** Every registered instance, its profile, its caller session label and how much of it is busy. */
 private ownerInstances():OwnerInstance[]{const tasks=this.manager.store.listHeads();return this.manager.store.listOwners().map(owner=>({...owner,runningTaskCount:slotGroupCount(tasks,slotGroupFor(owner.id,owner.profileId))}));}
 private task(a:Record<string,unknown>):Task {try{return this.manager.store.get(parseId(a.taskId));}catch{ return fail('NOT_FOUND','Task not found');}}
  private revise(task:Task,a:Record<string,unknown>){if(a.expectedRevision!==undefined && a.expectedRevision!==(task.revision??0))fail('REVISION_CONFLICT',`Current revision is ${task.revision??0}`);}
  private put(task:Task){this.manager.update(task);}
  /** Health and penalties are the monitor's own answers; a process without one has nothing to invent them from. */
  private monitor():TaskDiagnostics {if(!this.diagnostics)fail('CAPABILITY_UNAVAILABLE','No stall monitor runs in this process, so health and penalty state cannot be read');return this.diagnostics!;}
  private *startOwnerHost(task:Task,profile:string,prompt:string):CommandFlow<{ownerHost?:TaskOwnerHost;failure?:{code:string;message:string}}> {
   const epoch=task.ownerEpoch??0;const ownerId=task.ownerId;const key=`${task.id}:${epoch}`;
   if(this.launchingEpochs.has(key))fail('INVALID_STATE','An owner launch is already pending for this task and epoch');
   this.launchingEpochs.add(key);
   let launched:OwnerLaunchResult|undefined;let ownerHost:TaskOwnerHost|undefined;let cleanupAttempted=false;
   const current=()=>{const fresh=this.manager.store.get(task.id);return !this.draining&&!(fresh.executionRole==='owner'&&terminal(fresh))&&fresh.ownerId===ownerId&&(fresh.ownerEpoch??0)===epoch?fresh:undefined;};
   try {
    const workspace=task.dispatch?.workspace??task.workspace;
    if(!workspace)throw new OwnerLaunchError('OWNER_LAUNCH_FAILED','Task has no workspace to launch the owner in');
    const config=this.policy.snapshot().config;const ownerConfig=config.owners[profile];
    if(!ownerConfig)throw new OwnerLaunchError('OWNER_LAUNCH_FAILED',`Owner profile ${profile} is missing from the policy`);
    launched=(yield {kind:'launch',input:{taskId:task.id,epoch,title:task.title,workspace,engineKind:config.engines[ownerConfig.engine]?.kind??'',model:ownerConfig.model,effort:ownerConfig.effort,proxy:ownerConfig.proxy,prompt}})!;
    const fresh=current();
    if(!fresh){
     // A newer binding or shutdown owns the task now. Only this attempt's successful host is disposable.
     cleanupAttempted=true;try{yield {kind:'close',host:launched};}catch(error){throw new OwnerLaunchError('OWNER_LAUNCH_FAILED',`Owner launch superseded; host cleanup failed: ${error instanceof Error?error.message:String(error)}`);}
     throw new OwnerLaunchError('OWNER_LAUNCH_FAILED','Owner launch superseded by a newer binding or app shutdown');
    }
    ownerHost={kind:'herdr',session:launched.session,workspaceId:launched.workspaceId,paneId:launched.paneId,agentName:launched.agentName,launchedAt:new Date().toISOString()};
    fresh.ownerHost=ownerHost;event(fresh,'lifecycle',`Started ${profile} in Herdr (${ownerHost.agentName})`);this.put(fresh);
    return {ownerHost};
   }catch(error){
    // update() also notifies listeners after its atomic store write. A listener failure must not dispose a durably visible host.
    const saved=this.manager.store.get(task.id);
    if(ownerHost&&saved.ownerId===ownerId&&(saved.ownerEpoch??0)===epoch&&saved.ownerHost&&
      saved.ownerHost.session===ownerHost.session&&saved.ownerHost.workspaceId===ownerHost.workspaceId&&saved.ownerHost.paneId===ownerHost.paneId&&saved.ownerHost.agentName===ownerHost.agentName&&saved.ownerHost.launchedAt===ownerHost.launchedAt)return {ownerHost:saved.ownerHost};
    const code=error instanceof OwnerLaunchError?error.code:'OWNER_LAUNCH_FAILED';let message=error instanceof Error?error.message:String(error);
    if(launched&&!cleanupAttempted){
     cleanupAttempted=true;
     try{yield {kind:'close',host:launched};}catch(cleanup){message+=`; owner host cleanup failed: ${cleanup instanceof Error?cleanup.message:String(cleanup)}`;}
    }
    const fresh=current();if(fresh){
     try{event(fresh,'error',`Owner launch failed (${code}): ${message}`);this.put(fresh);}
     catch(report){message+=`; failure could not be persisted: ${report instanceof Error?report.message:String(report)}`;}
    }
    return {failure:{code,message}};
   }finally{this.launchingEpochs.delete(key);}
  }
 /** Cancellation acknowledges durable task state before attempting external host cleanup. */
 private closeCancelledRoot(task:Task):void {
  const host=task.ownerHost!;
  const controller=new AbortController();this.launches.add(controller);
  const job=Promise.resolve().then(()=>this.driveAsync(this.closeCancelledHost(task.id,host),controller.signal));
  this.pending.add(job);const settled=()=>{this.pending.delete(job);this.launches.delete(controller);};job.then(settled,settled);
 }
 private *closeCancelledHost(taskId:string,host:TaskOwnerHost):CommandFlow<CommandResponse> {
  try {
   yield {kind:'close',host};
   const fresh=this.manager.store.get(taskId);
   // Retain a newer host binding if ownership changed while the close was pending.
   if(fresh.ownerHost&&canonical(fresh.ownerHost)===canonical(host)){
    delete fresh.ownerHost;event(fresh,'lifecycle','Cancelled parent Agent host closed');this.put(fresh);
   }
   return {apiVersion:API_VERSION,ok:true};
  }catch(error){
   const fresh=this.manager.store.get(taskId);
   event(fresh,'error',`Cancelled parent Agent host cleanup failed: ${redactContext(error instanceof Error?error.message:String(error),8000)}`);this.put(fresh);
   return {apiVersion:API_VERSION,ok:false};
  }
 }
 /** Share native report validation between owner roots and native child workers. */
 private completeReport(task:Task,a:Record<string,unknown>):unknown {
    if(task.status!=='running'||task.run?.execution!=='native')fail('INVALID_STATE','Only a running native task accepts workers complete');
    if(a.outcome!=='completed'&&a.outcome!=='failed')fail('INVALID_REQUEST','outcome must be completed or failed');
    const summary=text(a.summary,'summary',8000);
    if(a.artifacts!==undefined&&(!Array.isArray(a.artifacts)||a.artifacts.length>20))fail('INVALID_REQUEST','artifacts must be an array of at most 20 files');
    const artifacts=((a.artifacts as unknown[]|undefined)??[]).map(item=>{const record=parseWorkerRecord({...object(item),type:'artifact'});if(record.type!=='artifact')throw new CommandError('INVALID_REQUEST','Invalid artifact');return {name:record.name,mediaType:record.mediaType,content:record.content};});
    if(task.artifacts.length+artifacts.length>20)fail('RESOURCE_LIMIT','Task exceeds 20 artifacts');
    return this.publicTask(this.manager.completeNative(task.id,{outcome:a.outcome as 'completed'|'failed',summary,artifacts}));
 }
 /** A root is supervised by its visible owner, with no worker process and no worker admission slot. */
 private startRoot(a:Record<string,unknown>):unknown {
  const task=this.task(a);this.revise(task,a);
  const restart=task.executionRole==='owner'&&task.status==='failed'&&!task.ownerHost;
  if((task.status!=='queued'&&!restart)||task.parentTaskId||task.dispatch||task.packageId||task.scheduled)fail('INVALID_STATE','Only an unfrozen queued root task may start its owner');
  if(!task.ownerId)fail('INVALID_STATE','Root task must be bound to an owner profile');
  const owner=this.owner(task.ownerId);const snapshot=this.policy.snapshot();const profile=snapshot.config.owners[owner.profileId];
  if(snapshot.owners[owner.profileId]?.status!=='available'||!profile)fail('POLICY_DENIED','Owner profile is unavailable');
  const engineKind=snapshot.config.engines[profile.engine]?.kind;
  if(engineKind!=='claude'&&engineKind!=='codex')fail('OWNER_LAUNCH_UNSUPPORTED','Root owner requires a claude or codex profile');
  task.workspace=absoluteExistingWorkspace(task.workspace);
  // A fresh launch uses the full task briefing; the old context pack targets the previous epoch.
  if(restart){task.ownerEpoch=(task.ownerEpoch??0)+1;delete task.contextPack;}delete task.failure;
  task.executionRole='owner';task.status='running';task.ownerLastActivityAt=new Date().toISOString();
  task.run={id:randomUUID(),adapter:'native',execution:'native',status:'running',startedAt:new Date().toISOString(),engine:profile.engine,model:profile.model,effort:profile.effort,workspace:task.workspace};
  event(task,'lifecycle','Starting root owner in Herdr; the owner will describe, split, dispatch and review child tasks');this.put(task);
  const controller=new AbortController();this.launches.add(controller);
  // Defer the external effect until after the command has persisted its immediate receipt.
  const job=Promise.resolve().then(()=>this.driveAsync(this.launchRoot(task,owner.profileId),controller.signal));
  this.pending.add(job);const settled=()=>{this.pending.delete(job);this.launches.delete(controller);};job.then(settled,settled);
  return this.publicTask(task);
 }
 private *launchRoot(task:Task,profile:string):CommandFlow<CommandResponse> {
  if(this.draining||terminal(this.manager.store.get(task.id)))return {apiVersion:API_VERSION,ok:true};
  const result=yield* this.startOwnerHost(task,profile,rootOwnerPrompt(task));
  const fresh=this.manager.store.get(task.id);
  if(result.failure&&!this.draining&&fresh.ownerId===task.ownerId&&(fresh.ownerEpoch??0)===(task.ownerEpoch??0)&&fresh.status==='running'){
   fresh.status='failed';fresh.failure={kind:'other',message:redactContext(`${result.failure.code}: ${result.failure.message}`,8000)};
   if(fresh.run){fresh.run.status='stopped';fresh.run.endedAt=new Date().toISOString();}this.put(fresh);
  }
  return {apiVersion:API_VERSION,ok:!result.failure,data:result};
 }
 private readonly vendorBlockedAttempts=new Set<string>();
 /**
  * A rate limit or exhausted quota blocks the dispatched worker first (ladder per worker). Once every enabled worker
  * of its engine is out, the engine is blocked too. A dispatch that names no known worker blocks the whole engine.
  */
 private applyVendorBlocks():void {
  for(const task of this.manager.store.listHeads()){
   const f=task.failure;const engine=task.dispatch?.engine;const key=task.run?.id??task.id;
   if(!engine||!f||!['rate_limit','quota'].includes(f.kind)||this.vendorBlockedAttempts.has(key))continue;
   const snapshot=this.policy.snapshot();
   const now=Date.now();
   const dispatched=task.dispatch?.worker;
   const worker=dispatched&&Object.hasOwn(snapshot.config.workers,dispatched)&&snapshot.config.workers[dispatched]!.engine===engine?dispatched:undefined;
   const existing=snapshot.blocks.find(block=>block.engine===engine&&block.model===undefined&&block.worker===worker);
   if(existing&&existing.by!==VENDOR_BLOCK_SOURCE){this.vendorBlockedAttempts.add(key);continue;}
   // Another source already keeps the whole engine out of routing; a worker block would only stack on it.
   if(worker&&snapshot.blocks.some(block=>block.engine===engine&&block.model===undefined&&block.worker===undefined&&block.by!==VENDOR_BLOCK_SOURCE&&(!block.release_at||Date.parse(block.release_at)>now))){this.vendorBlockedAttempts.add(key);continue;}
   // Keep the ladder in the existing durable task metadata, including after explicit block removal.
   let minutes: number = VENDOR_LADDER_MINUTES[0];
   if(f.kind==='rate_limit'){
    const ladder=worker??engineLadderKey(engine);
    const previous=this.manager.store.getVendorLimit(ladder);
    const level=previous&&now-previous.lastTriggerAt<2*60*60_000?Math.min(previous.level+1,3):1;
    minutes=VENDOR_LADDER_MINUTES[level-1]!;
    this.manager.store.putVendorLimit(ladder,{level,lastTriggerAt:now});
   }
   const retryAt=f.retryAt?Date.parse(f.retryAt):NaN;
   const release=f.kind==='rate_limit'?Math.max(now+minutes*60_000,Number.isFinite(retryAt)?retryAt:0):retryAt;
   const release_at=Number.isFinite(release)&&release>now?new Date(release).toISOString():undefined;
   const block:Block={engine,...(worker?{worker}:{}),reason:vendorBlockReason(f),since:new Date(now).toISOString(),by:VENDOR_BLOCK_SOURCE,...(release_at?{release_at}:{})};
   const written=existing?snapshot.blocks.map(item=>item===existing?block:item):[...snapshot.blocks,block];
   this.policy.save({revision:snapshot.revision,config:snapshot.config,blocks:worker?escalateEngineBlock(snapshot.config,written,engine,now):written});
   this.vendorBlockedAttempts.add(key);
  }
 }
 private pumping=false;
 private pumpDirty=false;
 private pumpScheduled?:NodeJS.Immediate;
 private delivered=new Map<string,string>();
 checkIdleOwners():string[] {return this.manager.store.listHeads().filter(task=>task.ownerId&&this.continuation.due(task.id)).map(task=>task.id);}
 private prepareOwnerActivity(command:string,args:Record<string,unknown>):void {
  if(!['workers.spawn','packages.create','results.ack','reviews.submit'].includes(command))return;
  const task=this.task(args);this.revise(task,args);
  if(!task.ownerId||task.status==='running'||task.status==='cancelling'||task.status==='failed'||task.status==='cancelled'||task.reviewState==='accepted'||task.reviewState==='rejected'||task.scheduled)return;
  const owner=this.owner(task.ownerId);if(owner.mode!=='mock'||!this.continuation.due(task.id))return;
  if(this.policy.snapshot().owners[owner.profileId]?.status!=='available')fail('POLICY_DENIED','Owner profile unavailable for continuation');
  this.continuation.rotate(task.id,task.revision??0,'idle',task.ownerEpoch??0);
  if(args.expectedRevision!==undefined)args.expectedRevision=this.manager.store.get(task.id).revision;
 }

 private queueBlocked(task:Task, code:NonNullable<Task['queueReason']>['code'], message:string):void {
  const bounded=redactContext(message,700);
  if(task.queueReason?.code===code&&task.queueReason.message===bounded)return;
  task.queueReason={code,message:bounded};this.put(task);
 }
 /** Capacity is per owner instance, so a waiting message names the binding whose slots are held. */
 private capacityWait(profile:string, ownerId:string|undefined, limit:number):string {
  return `${slotGroupName(this.manager.store.listOwners(),ownerId,profile)} is at its current concurrency limit (${limit}).`;
 }
 pump():void {
  if(this.draining)return;
  this.pumpDirty=true;
  if(this.pumping||this.pumpScheduled)return;
  this.pumpScheduled=setImmediate(()=>{this.pumpScheduled=undefined;if(this.draining)return;this.pumpDirty=false;this.runPump();});
 }
 private runPump():void {
  this.pumping=true;
  try{this.applyVendorBlocks();for(const head of this.manager.store.listHeads().reverse()){
   const task=head.status==='queued'&&head.scheduled?this.manager.store.get(head.id):head;
   if(terminal(task)&&task.ownerId&&this.manager.store.getOwner(task.ownerId)?.mode==='mock'&&this.delivered.get(task.id)!==task.updatedAt){
    try{this.execute('results.deliver',{taskId:task.id});this.delivered.set(task.id,task.updatedAt);}catch{/* An unavailable host may recover on a later notification. */}
   }
   if(task.status!=='queued'||!task.scheduled||!task.dispatch)continue;
   let phase:NonNullable<Task['queueReason']>['code']='policy_blocked';
   try{
    const frozen=task.dispatch;
    // A whole-engine vendor block sends the task to another engine; a worker-level one only takes that worker out.
    const vendorBlocks=this.policy.snapshot().blocks.filter(block=>block.engine===frozen.engine&&block.by===VENDOR_BLOCK_SOURCE&&(!block.release_at||Date.parse(block.release_at)>Date.now()));
    const engineBlocked=vendorBlocks.some(block=>block.worker===undefined);
    const workerBlocked=!engineBlocked&&vendorBlocks.some(block=>block.worker===frozen.worker);
    if(engineBlocked||workerBlocked){
      if(frozen.execution==='real'){phase='workspace_changed';assertFrozenWorkspace(frozen);phase='policy_blocked';}
      const reroute=this.routeOf(frozen.owner,slotGroupCount(this.manager.store.listHeads(),slotGroupFor(task.ownerId,frozen.owner)),engineBlocked?[frozen.engine]:[],undefined,workerBlocked?[frozen.worker]:[]);
      const decision=this.decideExecution(reroute.engine,undefined,{...task,workspace:frozen.workspace??task.workspace},this.policy.snapshot().config.owners[reroute.owner]?.engine,reroute.proxy,this.policy.snapshot().config.owners[reroute.owner]?.proxy);
      task.dispatch={...frozen,worker:reroute.worker,engine:reroute.engine,model:reroute.model,effort:reroute.effort,proxy:reroute.proxy,execution:decision.execution,adapter:decision.adapter,engineKind:decision.engineKind,maxParallel:reroute.maxParallel,...(decision.workspace?{workspace:decision.workspace,workspaceIdentity:workspaceIdentity(decision.workspace)}:{})};
      event(task,'lifecycle',`Vendor limit rerouted queued worker to ${reroute.engine} (${reroute.worker})`);this.put(task);this.pump();continue;
    }

    const running=slotGroupCount(this.manager.store.listHeads(),slotGroupFor(task.ownerId,frozen.owner));
    const route=this.policy.preview({owner:frozen.owner,worker:frozen.worker,runningCount:running});
    const kind=this.policy.snapshot().config.engines[route.engine]?.kind;
    if(route.worker!==frozen.worker||route.engine!==frozen.engine||route.model!==frozen.model||route.effort!==frozen.effort||route.proxy!==frozen.proxy||(frozen.engineKind!==undefined&&kind!==frozen.engineKind)){
     this.queueBlocked(task,'frozen_route_changed','Current worker engine, kind, model or effort no longer matches the frozen dispatch; restore the route or cancel and create a new task.');continue;
    }
    if(!route.capacityAvailable){this.queueBlocked(task,'waiting_for_capacity',this.capacityWait(frozen.owner,task.ownerId,route.maxParallel));continue;}
    phase='workspace_changed';if(frozen.execution==='real')assertFrozenWorkspace(frozen);
    phase='launch_blocked';this.manager.start(task.id,route.maxParallel);
   }catch(error){
    // start may have created/stopped a process before a persistence error. Never overwrite
    // its current state with the stale queued snapshot or make that attempt runnable again.
    const current=this.manager.store.get(task.id);
    if(current.status==='queued'&&current.scheduled)this.queueBlocked(current,phase,error instanceof Error?error.message:'Queued dispatch blocked');
   }
  }}finally{this.pumping=false;if(this.pumpDirty)this.pump();}
 }
 private publicTask<T extends Pick<Task,'owner'|'run'>>(task:T){const {owner,run,...rest}=task;if(!run)return rest;const visible={...run};delete visible.pid;return {...rest,run:visible};}
 private manifest(task:Task){if(!terminal(task))fail('RESULT_NOT_READY','Execution has not reached a terminal state');const manifest={taskId:task.id,attemptId:task.run?.id??null,packageId:task.packageId??null,execution:task.status,summary:task.summary??null,artifacts:task.artifacts.map(a=>({id:a.id,name:a.name,mediaType:a.mediaType,sha256:createHash('sha256').update(a.content).digest('hex')})),exitCode:task.run?.exitCode??null,...(task.failure?{failure:task.failure}:{})};return {...manifest,manifestDigest:digest(manifest),delivery:task.acknowledged?'acknowledged':'pending',acceptance:task.reviewState??'pending'};}
 /** maxWaitMinutes is frozen for the owner and the UI as their polling bound; Weaver never stops a worker with it. */
 private decideExecution(engine:string,provider:unknown,task:Task,ownerEngine?:string,workerProxy?:string,ownerProxy?:string):{execution:'real'|'mock'|'native';adapter:string;maxWaitMinutes:number;workspace?:string;engineKind?:string} {
  const minutes=this.policy.snapshot().config.herdr.max_wait_minutes;
  if(!Number.isSafeInteger(minutes)||minutes<1||minutes>1440)fail('INVALID_REQUEST','Configured max_wait_minutes is invalid');
  if(provider==='mock-jsonl'||this.manager.adapterId==='mock-jsonl') return {execution:'mock',adapter:'mock-jsonl',maxWaitMinutes:minutes};
  // A worker on the owner's own engine runs inside the owner with its built-in subagent tool; Weaver launches nothing.
  if(ownerEngine!==undefined&&engine===ownerEngine&&(workerProxy??'inherit')===(ownerProxy??'inherit')) return {execution:'native',adapter:'native',maxWaitMinutes:minutes,...(task.workspace?{workspace:task.workspace}:{})};
  const kind=this.policy.snapshot().config.engines[engine]?.kind??'';
  if(kind==='claude')fail('CAPABILITY_UNAVAILABLE','Claude Code real execution is deferred. No mock provider was substituted.');
  if(!isRealEngineKind(kind))fail('CAPABILITY_UNAVAILABLE',`Engine ${engine} (${kind||'unknown kind'}) cannot be launched. No mock provider was substituted.`);
  if(!this.manager.canLaunchReal)fail('CAPABILITY_UNAVAILABLE',`Real launcher for ${kind} is not loaded. No mock provider was substituted.`);
  return {execution:'real',adapter:kind,engineKind:kind,workspace:absoluteExistingWorkspace(task.workspace),maxWaitMinutes:minutes};
 }
 /** Engines of every earlier attempt in this task's retry chain that failed, cancelled or is still cancelling: a retry never returns to one. */
 private chainEngines(task:Task):string[] {
  const engines:string[]=[];const seen=new Set<string>([task.id]);let id=task.retryOf;
  while(id&&!seen.has(id)){
   seen.add(id);
   let previous:Task;
   try{previous=this.manager.store.get(id);}catch{break;}
   const engine=previous.dispatch?.engine;
   // A rate-limited attempt is already out through its worker's block; only the other failures put the engine in doubt.
   if(engine&&!vendorLimited(previous)&&(previous.status==='failed'||previous.status==='cancelled'||previous.status==='cancelling')&&!engines.includes(engine))engines.push(engine);
   id=previous.retryOf;
  }
  return engines;
 }
 /** What a retry may not route back to: the chain's failures, and the engine of the attempt --cancel abandons
  * even while its worker is still cancelling and holding the slot that made it. */
 private retryEngines(original:Task,cancel:boolean):string[] {
  const excluded=this.chainEngines(original);
  const engine=original.dispatch?.engine;
  const abandoned=(cancel&&!terminal(original))||(!vendorLimited(original)&&(original.status==='failed'||original.status==='cancelled'));
  if(engine&&abandoned&&!excluded.includes(engine))excluded.push(engine);
  return excluded;
 }
 /** The goal as its owner first wrote it. Walking to the chain root is what keeps one continuation note per
  * retry instead of prepending another to every generation of the same instruction. */
 private chainRoot(task:Task):Task {
  let current=task;const seen=new Set<string>([task.id]);
  while(current.retryOf&&!seen.has(current.retryOf)){
   seen.add(current.retryOf);
   let parent:Task;
   try{parent=this.manager.store.get(current.retryOf);}catch{break;}
   current=parent;
  }
  return current;
 }
 /** The bounded note a retried attempt carries: what ran, how it ended, and to read the workspace back first. */
 private retryNote(previous:Task):string {
  return `[Weaver retry] The previous attempt (task ${previous.id.slice(0,8)}) ran on ${previous.dispatch?.engine??'no engine'} and ended ${previous.status}. Before changing anything, inspect the current git diff and any partial output already in the workspace, then continue from what is there rather than repeating finished work. The goal below is the original instruction, unchanged.`;
 }
 /** Route one owner's work under the chain's excluded engines, keeping the refusal in the policy's own words. */
 private routeOf(owner:string,running:number,excluded:string[],worker?:unknown,excludedWorkers:string[]=[]):RoutePreview {
  try {
   return this.policy.preview({owner,runningCount:running,workerLoad:workerLoad(this.manager.store.listHeads()),...(worker!==undefined?{worker}:{}),...(excluded.length?{excludeEngines:excluded}:{}),...(excludedWorkers.length?{excludeWorkers:excludedWorkers}:{})});
  } catch(error) {
   const message=error instanceof Error?error.message:String(error);
   if(message.startsWith('NO_ALTERNATIVE_ENGINE'))fail('NO_ALTERNATIVE_ENGINE',message);
   throw error;
  }
 }
 /** The single step the owner takes next, so an owner never has to understand engines. */
 private nextFor(task:Task):DispatchNext|undefined {
  const dispatch=task.dispatch;
  if(!dispatch)return undefined;
  if(dispatch.execution!=='native'||task.scheduled)return {action:'wait',command:`weaver tasks wait --task-id ${task.id}`};
  const pkg=this.manager.store.getPackage(task.packageId!);
  // Dispatch freezes the package before a native run starts; without one there is no instruction to hand over.
  if(!pkg||pkg.taskId!==task.id)return undefined;
  // Identical to the instruction a real worker is launched with, so heterogeneous workers get the same contract.
  return {action:'run_subagent',model:dispatch.model,effort:dispatch.effort,prompt:workerInstruction(task,pkg),then:`weaver workers complete --task-id ${task.id} --input report.json`};
 }
 /** Dispatch response: the task snapshot, the owner's next step, and the engines this retry chain excluded. */
 private dispatchResponse(task:Task,excluded:string[]) {
  const next=this.nextFor(task);
  return {...this.publicTask(task),started:task.dispatch?.execution==='real'?!!task.run?.firstOutputAt:task.status==='running',...(next?{next}:{}),...(excluded.length?{excludedEngines:excluded}:{})};
 }
 /**
  * Route, freeze and admit one queued task, then hand the owner the single next step. workers.spawn calls it
  * directly and tasks.retry calls it for the linked child, so a retry never grows a second launcher.
  * forcedEngines names an engine the chain cannot see yet: the attempt --cancel abandoned but whose worker
  * is still cancelling.
  */
 private dispatchTask(command:string,a:Record<string,unknown>,forcedEngines:string[]=[]):unknown {
  let task=this.task(a);this.revise(task,a);if(task.parentTaskId&&this.manager.store.get(task.parentTaskId).status!=='running')fail('INVALID_STATE','Parent root is no longer running');if(task.executionRole==='owner')fail('INVALID_STATE','Dispatch child tasks, not the owner root');if(task.status!=='queued')fail('INVALID_STATE','Only queued tasks may dispatch');
  if(task.title===PENDING_TASK_TITLE)fail('INVALID_STATE','Owner must generate title and acceptance criteria with tasks.describe before dispatch');
  if(a.provider!==undefined&&a.provider!=='mock-jsonl')fail('CAPABILITY_UNAVAILABLE',`Provider ${String(a.provider)} is not available`);
  if(a.packageId!==undefined&&a.packageId!==task.packageId)fail('REVISION_CONFLICT','Package does not belong to task');
  if(task.scheduled)fail('INVALID_STATE','Task already scheduled');
  const logical=task.ownerId?this.owner(task.ownerId):undefined;
  const owner=text(a.owner??logical?.profileId??Object.keys(this.policy.snapshot().config.owners)[0],'owner profile',120);
  if(logical&&owner!==logical.profileId)fail('POLICY_DENIED','Task owner profile cannot be changed at dispatch');
  const excluded=this.chainEngines(task);
  for(const engine of forcedEngines)if(!excluded.includes(engine))excluded.push(engine);
  const running=slotGroupCount(this.manager.store.listHeads(),slotGroupFor(task.ownerId,owner));
  const route=this.routeOf(owner,running,excluded,a.worker);
  const decision=this.decideExecution(route.engine,a.provider,task,this.policy.snapshot().config.owners[route.owner]?.engine,route.proxy,this.policy.snapshot().config.owners[route.owner]?.proxy);
  const pendingPackage:WorkPackage=task.packageId?this.manager.store.getPackage(task.packageId!)!:{id:randomUUID(),taskId:task.id,revision:1,instruction:task.instruction,scope:[decision.workspace??task.workspace??'Explicit mock fixture'],acceptanceCriteria:task.acceptanceCriteria?.length?task.acceptanceCriteria:[decision.execution==='mock'?'Mock output returned for owner review':'Provider result returned for owner review'],createdAt:new Date().toISOString()};
  if(!pendingPackage||pendingPackage.taskId!==task.id)fail('INVALID_REQUEST','Frozen work package is missing');
  // Real launch and native handoff freeze the same instruction, so it must fit before any state changes.
  if(decision.execution!=='mock')workerInstruction({...task,workspace:decision.workspace??task.workspace},pendingPackage);
  this.prepareOwnerActivity(command,a);task=this.task(a);
  if(decision.workspace)task.workspace=decision.workspace;
  if(!task.packageId){this.manager.store.transaction(()=>{this.manager.store.putPackage(pendingPackage);task.packageId=pendingPackage.id;this.put(task);});}
  task.dispatch={owner:route.owner,worker:route.worker,engine:route.engine,model:route.model,effort:route.effort,proxy:route.proxy,execution:decision.execution,maxParallel:route.maxParallel,maxWaitMinutes:decision.maxWaitMinutes,adapter:decision.adapter,...(decision.workspace?{workspace:decision.workspace,...(decision.execution==='real'?{workspaceIdentity:workspaceIdentity(decision.workspace)}:{})}:{}),...(decision.engineKind?{engineKind:decision.engineKind}:{})};
  const selected=decision.execution==='real'?`Policy selected ${route.worker}; launching ${decision.engineKind} in ${decision.workspace}`:decision.execution==='native'?`Policy selected ${route.worker} on the owner's engine; the owner runs it with its built-in subagent tool (${route.model}, ${route.effort})`:`Policy selected ${route.worker}; explicit mock-jsonl provider`;
  event(task,'lifecycle',`${selected}${excluded.length?`; engines excluded because they ${EXCLUDED_ENGINE_REASON}: ${excluded.join(', ')}`:''}`);
  if(!route.capacityAvailable){task.scheduled=true;task.queueReason={code:'waiting_for_capacity',message:this.capacityWait(route.owner,task.ownerId,route.maxParallel)};event(task,'lifecycle','Dispatch admitted to queue; waiting for an execution slot');this.put(task);return this.dispatchResponse(task,excluded);}this.put(task);return this.dispatchResponse(this.manager.start(task.id,route.maxParallel),excluded);
 }
 /**
  * One owner action that runs a finished attempt again elsewhere and dispatches the linked child in the same call.
  * Every refusal happens before the original is touched, so a retry known to fail leaves the chain exactly as it was;
  * only after that does the original optionally cancel, the child and its frozen copy commit together, and the
  * launch itself happen outside the transaction, where a rollback could not take a started process back.
  */
 private retry(a:Record<string,unknown>):unknown {
  if(a.cancel!==undefined&&typeof a.cancel!=='boolean')fail('INVALID_REQUEST','cancel must be a boolean');
  if(a.expectedRevision!==undefined&&!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');
  const original=this.task(a);this.revise(original,a);
  if(original.executionRole==='owner')fail('INVALID_STATE','Use tasks start to retry a failed owner launch; retry child worker tasks separately');
  if(original.parentTaskId&&this.manager.store.get(original.parentTaskId).status!=='running')fail('INVALID_STATE','Parent root is no longer running');
  // cancel:false is the caller's claim that nothing is in flight, which a non-terminal task directly refutes.
  const cancel=a.cancel===true;
  if(!terminal(original)&&!cancel)fail('INVALID_STATE','Retry requires terminal execution, or cancel:true to abandon the attempt still in flight');
  const willCancel=cancel&&!terminal(original);
  const frozen=original.packageId?this.manager.store.getPackage(original.packageId!):undefined;
  if(original.packageId&&!frozen)fail('NOT_FOUND','The original task names a frozen work package this store no longer retains');
  // The failure that ended the original may not have been turned into its worker block yet; the route must see it.
  this.applyVendorBlocks();
  const excluded=this.retryEngines(original,cancel);
  const logical=original.ownerId?this.owner(original.ownerId):undefined;
  const owner=logical?.profileId??Object.keys(this.policy.snapshot().config.owners)[0];
  const route=this.routeOf(owner,slotGroupCount(this.manager.store.listHeads(),slotGroupFor(original.ownerId,owner)),excluded);
  // An explicit mock attempt stays a mock; a real one never falls back to a fixture because it failed.
  const provider=original.dispatch?.execution==='mock'?'mock-jsonl':undefined;
  const decision=this.decideExecution(route.engine,provider,original,this.policy.snapshot().config.owners[route.owner]?.engine,route.proxy,this.policy.snapshot().config.owners[route.owner]?.proxy);
  const instruction=`${this.retryNote(original)}\n\n${this.chainRoot(original).instruction}`;
  if(instruction.length>16000)fail('INVALID_REQUEST',`The retried instruction would be ${instruction.length} characters, over the 16000 task limit; shorten the original goal before retrying. Nothing was cancelled or created.`);
  // The package is only a value here, so the child is frozen under the original scope and criteria before any write.
  const probeId=randomUUID();
  const pkg:WorkPackage={id:randomUUID(),taskId:probeId,revision:1,instruction,createdAt:new Date().toISOString(),
   scope:frozen?[...frozen.scope]:[decision.workspace??original.workspace??'Explicit mock fixture'],
   acceptanceCriteria:frozen?[...frozen.acceptanceCriteria]:(original.acceptanceCriteria?.length?original.acceptanceCriteria:[decision.execution==='mock'?'Mock output returned for owner review':'Provider result returned for owner review'])};
  if(decision.execution!=='mock')workerInstruction({...original,id:probeId,instruction,dispatch:undefined,workspace:decision.workspace??original.workspace},pkg);
  if(willCancel)this.manager.cancel(original.id);
  const created=this.manager.store.transaction(()=>{
   const task=this.manager.create({title:original.title,instruction,owner:original.owner,workspace:original.workspace,acceptanceCriteria:original.acceptanceCriteria,constraints:original.constraints});
   const linked={...pkg,taskId:task.id};
   this.manager.store.putPackage(linked);
   task.ownerId=original.ownerId;if(original.parentTaskId)task.parentTaskId=original.parentTaskId;task.retryOf=original.id;task.packageId=linked.id;
   event(task,'lifecycle',`Linked as a retry of task ${original.id.slice(0,8)} and frozen with its package`);
   this.put(task);
   return this.manager.store.get(task.id);
  });
  const linkedFrom=this.manager.store.get(original.id);
  event(linkedFrom,'lifecycle',`Retried as task ${created.id.slice(0,8)}; engines excluded for the chain: ${excluded.length?excluded.join(', '):'none'}`);
  this.put(linkedFrom);
  return this.dispatchTask('workers.spawn',{taskId:created.id,...(provider?{provider}:{})},excluded);
 }
 private *executeOwner(command:string,a:Record<string,unknown>):CommandFlow<unknown> {
  switch(command){
   case 'owners.switch':{if(!Number.isSafeInteger(a.expectedRevision)||(a.expectedEpoch!==undefined&&!Number.isSafeInteger(a.expectedEpoch)))fail('INVALID_REQUEST','Revision and epoch must be integers');if(a.reason!==undefined&&a.reason!=='manual'&&a.reason!=='idle')fail('INVALID_REQUEST','Invalid switch reason');if(a.launch!==undefined&&typeof a.launch!=='boolean')fail('INVALID_REQUEST','launch must be a boolean');const task=this.task(a);const owner=this.owner(task.ownerId);const profile=text(a.profileId??owner.profileId,'profileId',120);if(this.policy.snapshot().owners[profile]?.status!=='available')fail('POLICY_DENIED','Target owner profile unavailable');const result=this.continuation.rotate(task.id,Number(a.expectedRevision),a.reason==='idle'?'idle':'manual',a.expectedEpoch===undefined?undefined:Number(a.expectedEpoch),profile);if(a.launch!==true)return result;const launched=yield* this.startOwnerHost(this.manager.store.get(task.id),profile,typeof result.prompt==='string'?result.prompt:'');(result as {launch?:unknown}).launch=launched.ownerHost?{ok:true,ownerHost:launched.ownerHost}:{ok:false,code:launched.failure!.code,message:launched.failure!.message};return result;}
   case 'owners.launch':{if(!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');const task=this.task(a);this.revise(task,a);if(!task.contextPack)return fail('INVALID_STATE','No context pack to launch the owner from');const owner=task.ownerId?this.owner(task.ownerId):undefined;if(!owner)return fail('INVALID_STATE','Task has no logical owner');const profile=owner.profileId;if(this.policy.snapshot().owners[profile]?.status!=='available')fail('POLICY_DENIED','Owner profile is unavailable');const prompt=handoffPrompt(task,task.contextPack);const launched=yield* this.startOwnerHost(this.manager.store.get(task.id),profile,prompt);return {taskId:task.id,prompt,...launched.ownerHost?{launch:{ok:true,ownerHost:launched.ownerHost}}:{launch:{ok:false,code:launched.failure!.code,message:launched.failure!.message}},task:this.publicTask(this.manager.store.get(task.id))};}
   default:return fail('COMMAND_UNKNOWN','Unknown owner command');
  }
 }
 private execute(command:string,a:Record<string,unknown>):unknown {
  switch(command){
   case 'sync.snapshot':return {revision:this.manager.store.revision,tasks:this.manager.store.listHeads().map(t=>({id:t.id,title:t.title,status:t.status,revision:t.revision??0,ownerId:t.ownerId,updatedAt:t.updatedAt,reviewState:t.reviewState??'pending'})),owners:this.manager.store.listOwners().map(o=>({id:o.id,name:o.name,profileId:o.profileId,session:ownerSession(o),mode:o.mode,state:o.state}))};
   case 'sync.status':return {revision:this.manager.store.revision,changed:a.after!==this.manager.store.revision,recovery:'refresh sync.snapshot; push invalidation is not a durable event stream'};
   case 'capabilities.get':return {apiVersion:API_VERSION,cliTransport:this.transportStatus,authentication:'ephemeral-local-trusted-user-demo',ownerScopedAuthorization:false,ownerSpawn:this.herdrPresent()?'herdr':'logical-registration',manualAttach:'metadata-only',ownerModelSpawned:false,attachmentVerified:false,authenticated:false,modelUsable:false,workerProviders:this.manager.canLaunchReal?['mock-jsonl',...REAL_ENGINE_KINDS]:['mock-jsonl'],realExecution:this.manager.canLaunchReal,mcp:false,maxParallel:configuredParallel(this.policy),capacity:{unit:'owner-instance',aggregate:'sum of enabled owner profile max_parallel',admission:'Each attached owner instance holds its own profile max_parallel slots, so maxParallel is a scale hint, not a profile-wide or global cap.'},policyAdmission:true,quota:QUOTA_CAPABILITIES,commands:[...READ_COMMANDS,...WRITE_COMMANDS],limits:{eventsPerPage:100},durability:'durable intent before effect; interrupted commands require reconciliation, not automatic replay'};
   case 'owners.continuation.get':return this.continuation.get(parseId(a.taskId));
   case 'owners.continuation.configure':{if(!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');return this.continuation.configure(parseId(a.taskId),a.expectedRevision as number,a.idleRotationMinutes as number|null);}
   case 'owners.list':return {owners:this.ownerInstances()};
   case 'owners.get':{const owner=this.owner(a.ownerId);return {...owner,runningTaskCount:this.runningOn(owner)};}
   case 'owners.attach':case 'owners.spawn':{
    const mode=command==='owners.spawn'&&a.provider==='mock'?'mock':'manual';if(a.provider!==undefined&&a.provider!=='mock')fail('CAPABILITY_UNAVAILABLE','This process does not spawn an owner model');
    // Inputs are validated before the registry is read, so a malformed request can never reach an existing instance.
    const profileId=text(a.profileId,'profileId',120);const name=text(a.name,'name',120);
    const session=a.session===undefined?'external-cli':text(a.session,'session',120);
    const pane=a.pane===undefined?'unverified':text(a.pane,'pane',120);
    const owners=this.manager.store.listOwners();
    // The profile is the policy role; this caller's profile + name + session is one instance of it. A repeat attach is that same durable registration.
    if(command==='owners.attach'&&mode==='manual'){
     const attached=owners.find(owner=>sameOwnerInstance(owner,{profileId,name,session}));
     if(attached)return attached;
    }
    // Admission and limits decide whether a new instance may be created; a duplicate has nothing to admit.
    if(this.policy.snapshot().owners[profileId]?.status!=='available')fail('POLICY_DENIED','Owner profile is unavailable');
    const owner:LogicalOwner={id:randomUUID(),name,profileId,mode,state:mode==='mock'?'ready':'attached',createdAt:new Date().toISOString(),...(mode==='manual'?{session}:{})};
    if(mode==='mock'){if(a.session!==undefined||a.pane!==undefined)fail('INVALID_REQUEST','Logical registration has no session or pane');owner.host=this.ownerHost.spawn({ownerId:owner.id,name:owner.name,profileId});}
    else owner.host=this.ownerHost.attach({ownerId:owner.id,name:owner.name,profileId,session,pane});
    this.manager.store.putOwner(owner);return owner;
   }
   case 'tasks.create':return this.manager.store.transaction(()=>{
    let owner:LogicalOwner|undefined;let input;let parent:Task|undefined;
    if(a.parentTaskId!==undefined){parent=this.manager.store.get(parseId(a.parentTaskId));if(parent.executionRole!=='owner'||parent.status!=='running')fail('INVALID_STATE','Parent must be a running owner root');if(parent.title===PENDING_TASK_TITLE||!parent.acceptanceCriteria?.length)fail('INVALID_STATE','Describe the root before creating children');if(a.ownerProfileId!==undefined||(a.ownerId!==undefined&&a.ownerId!==parent.ownerId))fail('INVALID_REQUEST','Child must use its root owner instance');a={...a,ownerId:parent.ownerId,workspace:a.workspace??parent.workspace,constraints:a.constraints??parent.constraints};}
    if(a.ownerProfileId!==undefined){parseTaskInput({...a,instruction:a.instruction??a.goal,owner:{name:'validation',transport:'herdr-visible',session:'unverified',pane:'unverified'}});if(a.ownerId!==undefined)fail('INVALID_REQUEST','Choose ownerId or ownerProfileId');owner=this.execute('owners.spawn',{profileId:a.ownerProfileId,name:a.ownerName??'Task owner',provider:a.ownerProvider}) as LogicalOwner;}
    if(a.ownerId!==undefined||owner){owner??=this.owner(a.ownerId);input=parseTaskInput({...a,title:a.title,instruction:a.instruction??a.goal,owner:{name:owner.name,transport:'herdr-visible',session:'unverified',pane:'unverified'}});}else input=parseTaskInput(a);
    const task=this.manager.create(input);if(parent)task.parentTaskId=parent.id;if(owner){task.ownerId=owner.id;task.ownerEpoch=0;task.ownerLastActivityAt=new Date().toISOString();task.continuationPolicy={idleRotationMinutes:60};this.put(task);}return this.publicTask(task);
   });
   case 'tasks.start':return this.startRoot(a);
   case 'tasks.complete':{const task=this.task(a);this.revise(task,a);if(task.executionRole!=='owner')fail('INVALID_STATE','Only an owner root accepts tasks complete');if(a.outcome==='completed'){if(task.title===PENDING_TASK_TITLE||!task.acceptanceCriteria?.length)fail('INVALID_STATE','Describe root title and acceptance criteria before completion');const children=this.manager.store.listHeads().filter(t=>t.parentTaskId===task.id);if(children.length===0)fail('INVALID_STATE','The parent Agent must not implement itself: dispatch at least one subtask before completing the root');const leaves=children.filter(t=>!children.some(retry=>retry.retryOf===t.id));if(leaves.length===0)fail('INVALID_STATE','At least one final subtask is required; retried tasks stay history, completion reads the final leaf');if(leaves.some(t=>t.status!=='completed'||t.reviewState!=='accepted'))fail('INVALID_STATE','Every final child task must complete and pass owner review');}return this.completeReport(task,a);}
   case 'tasks.describe':{
    const task=this.task(a);
    if(!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');
    this.revise(task,a);
    if((task.status!=='queued'&&!(task.executionRole==='owner'&&task.status==='running'))||task.packageId||task.dispatch||task.scheduled)fail('INVALID_STATE','Only an unfrozen queued task or running owner root can be described');
    if(task.executionRole==='owner'&&this.manager.store.listHeads().some(t=>t.parentTaskId===task.id))fail('INVALID_STATE','Root description is frozen after creating children');
    const title=text(a.title,'title',160).trim();
    if(title===PENDING_TASK_TITLE)fail('INVALID_REQUEST','Generate a concrete task title');
    if(!Array.isArray(a.acceptanceCriteria)||a.acceptanceCriteria.length<1||a.acceptanceCriteria.length>30)fail('INVALID_REQUEST','Provide 1–30 acceptance criteria');
    const criteria=(a.acceptanceCriteria as unknown[]).map(value=>text(value,'acceptance criterion',1000).trim());
    task.title=title;task.acceptanceCriteria=criteria;
    event(task,'lifecycle','Owner generated task title and acceptance criteria');this.put(task);return this.publicTask(task);
   }
   case 'workspaces.list':return listWorkspaceDirectories(a.path);
   case 'tasks.retry':return this.retry(a);
   case 'tasks.get':{
    const task=this.task(a);
    // A running native task is the owner's own subagent, so its instruction is recoverable here even if the spawn response was lost.
    const next=task.status==='running'&&task.dispatch?.execution==='native'?this.nextFor(task):undefined;
    return {...this.publicTask(task),...(next?{next}:{})};
   }
   case 'tasks.list':{
    const offset=a.offset??0;const limit=a.limit??25;if(!Number.isSafeInteger(offset)||Number(offset)<0||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>100)fail('INVALID_REQUEST','Invalid pagination');
    if(a.parentTaskId!==undefined)parseId(a.parentTaskId);
    const all=this.manager.store.listSummaries().filter(t=>(a.ownerId===undefined||t.ownerId===a.ownerId)&&(a.parentTaskId===undefined||t.parentTaskId===a.parentTaskId));const tasks=all.slice(Number(offset),Number(offset)+Number(limit)).map(t=>{const {events,artifacts,...summary}=this.publicTask(t);return {...summary,artifactCount:artifacts.length};});return {tasks,nextOffset:Number(offset)+tasks.length<all.length?Number(offset)+tasks.length:null};
   }
   case 'packages.create':{
    const task=this.task(a);if(task.executionRole==='owner')fail('INVALID_STATE','Freeze packages on child tasks, not the owner root');if(task.title===PENDING_TASK_TITLE)fail('INVALID_STATE','Owner must describe the task before freezing a package');this.revise(task,a);if(task.status!=='queued')fail('INVALID_STATE','Only queued tasks accept a work package');if(task.packageId)fail('INVALID_STATE','Task already has a frozen package');
    const strings=(v:unknown,label:string)=>{if(!Array.isArray(v)||v.length<1||v.length>30)fail('INVALID_REQUEST',`Provide 1–30 ${label}`);return (v as unknown[]).map(x=>text(x,label,1000));};
    const pkg:WorkPackage={id:randomUUID(),taskId:task.id,revision:1,instruction:task.instruction,scope:strings(a.scope,'scope entries'),acceptanceCriteria:a.acceptanceCriteria===undefined?strings(task.acceptanceCriteria,'acceptance criteria (set on the task, or pass acceptanceCriteria explicitly)'):strings(a.acceptanceCriteria,'acceptance criteria'),createdAt:new Date().toISOString()};
    this.manager.store.transaction(()=>{this.manager.store.putPackage(pkg);task.packageId=pkg.id;event(task,'lifecycle','Frozen work package created');this.put(task);});return pkg;
   }
   case 'packages.get':{const pkg=this.manager.store.getPackage(parseId(a.packageId));if(!pkg)fail('NOT_FOUND','Package not found');return pkg;}
   case 'workers.spawn':return this.dispatchTask(command,a);
   case 'workers.complete':{const task=this.task(a);this.revise(task,a);if(task.executionRole==='owner')fail('INVALID_STATE','Report owner roots with tasks complete');return this.completeReport(task,a);}
   case 'tasks.cancel':{const task=this.task(a);this.revise(task,a);if(terminal(task))return {task:this.publicTask(task),alreadyTerminal:true};if(task.executionRole==='owner')for(const child of this.manager.store.listHeads().filter(t=>t.parentTaskId===task.id&&!terminal(t)))this.manager.cancel(child.id);const cancelled=this.manager.cancel(task.id);if(task.executionRole==='owner'&&cancelled.ownerHost)this.closeCancelledRoot(cancelled);return this.publicTask(cancelled);}
   case 'tasks.events':{
    const task=this.task(a);const limit=a.limit??50;if(!Number.isInteger(limit)||Number(limit)<1||Number(limit)>100)fail('INVALID_REQUEST','Event limit must be 1–100');let start=0;
    if(a.after!==undefined){const i=task.events.findIndex(e=>e.id===a.after);if(i<0)fail('CURSOR_EXPIRED','Cursor not retained; refresh task snapshot');start=i+1;}
    const events=task.events.slice(start,start+Number(limit));return {events,nextCursor:events.at(-1)?.id??a.after??null,hasMore:start+events.length<task.events.length};
   }
   case 'observability.get':case 'observability.export':{
    const task=this.task(a);const redact=(value:string)=>redactContext(value,40000);
    const trace={taskId:task.id,ownerId:task.ownerId??null,packageId:task.packageId??null,attemptId:task.run?.id??null,revision:task.revision??0,execution:task.status,stage:task.scheduled?(task.queueReason?.code??'waiting_for_capacity'):task.status==='completed'?(task.reviewState==='accepted'?'accepted':'awaiting_review'):task.status,lastActivityAt:task.updatedAt,retryOf:task.retryOf??null,route:task.dispatch??null,queueReason:task.queueReason??null,run:task.run?{scopeUnit:task.run.scopeUnit??null,evidence:task.run.evidence??null}:null,artifacts:task.artifacts.map(v=>({id:v.id,name:redact(v.name)})),events:task.events.filter(e=>a.kind===undefined||e.kind===a.kind).map(e=>({...e,message:redact(e.message)})),metrics:{tokens:null,cost:null,contextUsage:null,source:task.dispatch?.execution==='real'?'not reported unless the provider emits evidence':'not reported by mock provider'},redaction:'best-effort pattern redaction; inspect before sharing'};return command==='observability.export'?{mediaType:'application/json',name:`weaver-trace-${task.id}.json`,content:JSON.stringify(trace,null,2)}:trace;
   }
   case 'tasks.results':return this.manifest(this.task(a));
   /** The monitor's own reading of one task, never a second classifier and never a guess about CPU. */
   case 'tasks.health':{const task=this.task(a);return this.monitor().taskHealth(task);}
   /** Every configured engine as the monitor armed it, minus the retained history: that stays one call away. */
   case 'engines.health':{
    const status=this.monitor().status();
    return {engines:Object.fromEntries(Object.entries(status.engines).map(([engine,item])=>[engine,engineSummary(item)])),config:status.config};
   }
   case 'engines.penalty':{
    const engine=text(a.engine,'engine',120);
    const engines=this.monitor().status().engines;
    if(!Object.hasOwn(engines,engine))fail('NOT_FOUND',`Engine ${engine} is not configured and has no penalty record`);
    // The ladder is per worker; the engine view reports the most recently triggered step among its workers.
    const config=this.policy.snapshot().config;const ladders=this.manager.store.listVendorLimits();
    const keys=[...Object.keys(config.workers).filter(id=>config.workers[id]!.engine===engine),engineLadderKey(engine)].filter(key=>ladders[key]);
    const latest=keys.sort((a,b)=>ladders[b]!.lastTriggerAt-ladders[a]!.lastTriggerAt)[0];
    return {engine,...engines[engine],vendorLimit:latest?{level:ladders[latest]!.level,lastTriggerAt:new Date(ladders[latest]!.lastTriggerAt).toISOString()}:null};
   }
   case 'engines.unblock':{
    // The engine table is checked before the monitor is asked, so a typo never reaches a policy write.
    const engine=text(a.engine,'engine',120);
    if(!Object.hasOwn(this.policy.snapshot().config.engines,engine))fail('NOT_FOUND',`Engine ${engine} is not configured`);
    const monitor=this.monitor();
    const wasBlocked=monitor.status().engines[engine]?.blocked===true;
    monitor.unblock(engine);
    const status=monitor.status();
    const after=status.engines[engine]!;
    return {engine,wasBlocked,cleared:engineSummary(after),retainedHistory:after.history,otherEngines:Object.fromEntries(Object.entries(status.engines).filter(([name])=>name!==engine).map(([name,item])=>[name,engineSummary(item)]))};
   }
   case 'artifacts.read':{const task=this.task(a);const artifact=task.artifacts.find(v=>v.id===parseId(a.artifactId));if(!artifact)fail('NOT_FOUND','Artifact not found');return artifact;}
   case 'results.deliver':{
    const task=this.task(a);const manifest=this.manifest(task);if(!task.ownerId)fail('CAPABILITY_UNAVAILABLE','Task has no logical owner');const owner=this.owner(task.ownerId);if(owner.mode!=='mock')fail('CAPABILITY_UNAVAILABLE','Manual owner delivery is not connected');
    const existing=(owner.messages??[]).find(m=>m.taskId===task.id&&m.manifestDigest===manifest.manifestDigest);if(existing)return existing;
    const message=this.ownerHost.deliverResult(owner.id,{taskId:task.id,manifestDigest:manifest.manifestDigest});owner.messages=[...(owner.messages??[]),message];this.manager.store.putOwner(owner);return message;
   }
   case 'results.ack':case 'reviews.submit':{
    const task=this.task(a);if(a.expectedRevision===undefined)fail('INVALID_REQUEST','expectedRevision is required');this.revise(task,a);const manifest=this.manifest(task);if(a.manifestDigest!==manifest.manifestDigest)fail('MANIFEST_MISMATCH','Review must reference the current result digest');
    if(command==='results.ack'){if(task.ownerId){const owner=this.manager.store.getOwner(task.ownerId)!;const message=owner.messages?.find(m=>m.taskId===task.id&&m.manifestDigest===manifest.manifestDigest);if(message){const ack=this.ownerHost.acknowledge(owner.id,message.id);owner.messages=owner.messages!.map(m=>m.id===ack.id?ack:m);this.manager.store.putOwner(owner);}}task.acknowledged=true;event(task,'lifecycle','Result receipt acknowledged; acceptance unchanged');}
    else {if(task.status!=='completed')fail('INVALID_STATE','Only successful executions can be reviewed');if(!['accepted','rejected'].includes(String(a.decision)))fail('INVALID_REQUEST','Decision must be accepted or rejected');task.reviewState=a.decision as 'accepted'|'rejected';task.reviewComment=text(a.comment??'','comment',4000,true);event(task,'lifecycle',`Owner review: ${task.reviewState}`);}
    task.ownerLastActivityAt=new Date().toISOString();this.put(task);return this.manifest(task);
   }
   case 'operations.get':{const id=text(a.commandId,'commandId',120);const receipt=this.manager.store.getReceipt(`local-demo:${id}`);if(!receipt)fail('NOT_FOUND','Command receipt not found');return {commandId:id,state:receipt!.response?'settled':'indeterminate',response:receipt!.response};}
   default:return fail('COMMAND_UNKNOWN','Unknown logical command');
  }
 }
}
