import { randomUUID } from 'node:crypto';
import { API_VERSION, type CommandResponse } from '../../../shared/contracts/commands';
import type { LogicalOwner, OwnerInstance } from '../../../shared/contracts/owners';
import type { Task, TaskOwnerHost } from '../../../shared/contracts/tasks';
import { sameOwnerInstance } from '../../../shared/policy/owner-instance';
import { parseId, text } from '../../../shared/validation';
import type { MockOwnerHostAdapter } from '../../adapters/logical';
import { ContinuationService, handoffPrompt, redactContext, rootOwnerPrompt } from '../../continuation';
import type { TaskManager } from '../../manager';
import { OwnerLaunchError, type OwnerLaunchResult } from '../../owner-host';
import type { PolicyStore } from '../../policy/store';
import { event, slotGroupCount, slotGroupFor } from '../../store';
import { absoluteExistingWorkspace } from '../../workspace';
import { fail } from '../commands/errors';
import type { CommandArgs, CommandFlow } from '../commands/types';
import type { EffectRunner } from '../commands/gateway';
import { canonical, publicTask, terminal, type TaskRecords } from '../tasks/records';

/** Owner instances and the Herdr hosts behind them: registration, handoff launches, root owner start and exact cleanup. */
export class OwnerLifecycle {
 private readonly launchingEpochs = new Set<string>();
 constructor(private readonly manager:TaskManager,private readonly policy:PolicyStore,private readonly records:TaskRecords,
  private readonly continuation:ContinuationService,private readonly ownerHost:MockOwnerHostAdapter,
  private readonly runner:Pick<EffectRunner,'runDeferred'>,private readonly isDraining:()=>boolean){}
 /** Work holding this instance's own slots: running plus cancelling. Queued and terminal tasks hold none. */
 runningOn(owner:LogicalOwner):number {return slotGroupCount(this.manager.store.listHeads(),slotGroupFor(owner.id,owner.profileId));}
 /** Every registered instance, its profile, its caller session label and how much of it is busy. */
 ownerInstances():OwnerInstance[]{const tasks=this.manager.store.listHeads();return this.manager.store.listOwners().map(owner=>({...owner,runningTaskCount:slotGroupCount(tasks,slotGroupFor(owner.id,owner.profileId))}));}
 list(a:CommandArgs):unknown{return {owners:this.ownerInstances()};}
 get(a:CommandArgs):unknown{const owner=this.records.owner(a.ownerId);return {...owner,runningTaskCount:this.runningOn(owner)};}
 continuationGet(a:CommandArgs):unknown{return this.continuation.get(parseId(a.taskId));}
 continuationConfigure(a:CommandArgs):unknown{if(!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');return this.continuation.configure(parseId(a.taskId),a.expectedRevision as number,a.idleRotationMinutes as number|null);}
 register(command:'owners.attach'|'owners.spawn',a:CommandArgs):LogicalOwner{
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
 *switchOwner(a:CommandArgs):CommandFlow<unknown>{if(!Number.isSafeInteger(a.expectedRevision)||(a.expectedEpoch!==undefined&&!Number.isSafeInteger(a.expectedEpoch)))fail('INVALID_REQUEST','Revision and epoch must be integers');if(a.reason!==undefined&&a.reason!=='manual'&&a.reason!=='idle')fail('INVALID_REQUEST','Invalid switch reason');if(a.launch!==undefined&&typeof a.launch!=='boolean')fail('INVALID_REQUEST','launch must be a boolean');const task=this.records.task(a);const owner=this.records.owner(task.ownerId);const profile=text(a.profileId??owner.profileId,'profileId',120);if(this.policy.snapshot().owners[profile]?.status!=='available')fail('POLICY_DENIED','Target owner profile unavailable');const result=this.continuation.rotate(task.id,Number(a.expectedRevision),a.reason==='idle'?'idle':'manual',a.expectedEpoch===undefined?undefined:Number(a.expectedEpoch),profile);if(a.launch!==true)return result;const launched=yield* this.startOwnerHost(this.manager.store.get(task.id),profile,typeof result.prompt==='string'?result.prompt:'');(result as {launch?:unknown}).launch=launched.ownerHost?{ok:true,ownerHost:launched.ownerHost}:{ok:false,code:launched.failure!.code,message:launched.failure!.message};return result;}
 *launchOwner(a:CommandArgs):CommandFlow<unknown>{if(!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');const task=this.records.task(a);this.records.revise(task,a);if(!task.contextPack)return fail('INVALID_STATE','No context pack to launch the owner from');const owner=task.ownerId?this.records.owner(task.ownerId):undefined;if(!owner)return fail('INVALID_STATE','Task has no logical owner');const profile=owner.profileId;if(this.policy.snapshot().owners[profile]?.status!=='available')fail('POLICY_DENIED','Owner profile is unavailable');const prompt=handoffPrompt(task,task.contextPack);const launched=yield* this.startOwnerHost(this.manager.store.get(task.id),profile,prompt);return {taskId:task.id,prompt,...launched.ownerHost?{launch:{ok:true,ownerHost:launched.ownerHost}}:{launch:{ok:false,code:launched.failure!.code,message:launched.failure!.message}},task:publicTask(this.manager.store.get(task.id))};}
  private *startOwnerHost(task:Task,profile:string,prompt:string):CommandFlow<{ownerHost?:TaskOwnerHost;failure?:{code:string;message:string}}> {
   const epoch=task.ownerEpoch??0;const ownerId=task.ownerId;const key=`${task.id}:${epoch}`;
   if(this.launchingEpochs.has(key))fail('INVALID_STATE','An owner launch is already pending for this task and epoch');
   this.launchingEpochs.add(key);
   let launched:OwnerLaunchResult|undefined;let ownerHost:TaskOwnerHost|undefined;let cleanupAttempted=false;
   const current=()=>{const fresh=this.manager.store.get(task.id);return !this.isDraining()&&!(fresh.executionRole==='owner'&&terminal(fresh))&&fresh.ownerId===ownerId&&(fresh.ownerEpoch??0)===epoch?fresh:undefined;};
   try {
    const workspace=task.dispatch?.workspace??task.workspace;
    if(!workspace)throw new OwnerLaunchError('OWNER_LAUNCH_FAILED','Task has no workspace to launch the owner in');
    const config=this.policy.snapshot().config;const ownerConfig=config.owners[profile];
    if(!ownerConfig)throw new OwnerLaunchError('OWNER_LAUNCH_FAILED',`Owner profile ${profile} is missing from the policy`);
    launched=(yield {kind:'launch',input:{taskId:task.id,epoch,title:task.title,workspace,engineKind:config.engines[ownerConfig.engine]?.kind??'',model:ownerConfig.model,effort:ownerConfig.effort,prompt}})!;
    const fresh=current();
    if(!fresh){
     // A newer binding or shutdown owns the task now. Only this attempt's successful host is disposable.
     cleanupAttempted=true;try{yield {kind:'close',host:launched};}catch(error){throw new OwnerLaunchError('OWNER_LAUNCH_FAILED',`Owner launch superseded; host cleanup failed: ${error instanceof Error?error.message:String(error)}`);}
     throw new OwnerLaunchError('OWNER_LAUNCH_FAILED','Owner launch superseded by a newer binding or app shutdown');
    }
    ownerHost={kind:'herdr',session:launched.session,workspaceId:launched.workspaceId,paneId:launched.paneId,agentName:launched.agentName,launchedAt:new Date().toISOString()};
    fresh.ownerHost=ownerHost;event(fresh,'lifecycle',`Started ${profile} in Herdr (${ownerHost.agentName})`);this.records.put(fresh);
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
     try{event(fresh,'error',`Owner launch failed (${code}): ${message}`);this.records.put(fresh);}
     catch(report){message+=`; failure could not be persisted: ${report instanceof Error?report.message:String(report)}`;}
    }
    return {failure:{code,message}};
   }finally{this.launchingEpochs.delete(key);}
  }
 /** Cancellation acknowledges durable task state before attempting external host cleanup. */
 closeCancelledRoot(task:Task):void {
  const host=task.ownerHost!;
  this.runner.runDeferred(()=>this.closeCancelledHost(task.id,host));
 }
 private *closeCancelledHost(taskId:string,host:TaskOwnerHost):CommandFlow<CommandResponse> {
  try {
   yield {kind:'close',host};
   const fresh=this.manager.store.get(taskId);
   // Retain a newer host binding if ownership changed while the close was pending.
   if(fresh.ownerHost&&canonical(fresh.ownerHost)===canonical(host)){
    delete fresh.ownerHost;event(fresh,'lifecycle','Cancelled parent Agent host closed');this.records.put(fresh);
   }
   return {apiVersion:API_VERSION,ok:true};
  }catch(error){
   const fresh=this.manager.store.get(taskId);
   event(fresh,'error',`Cancelled parent Agent host cleanup failed: ${redactContext(error instanceof Error?error.message:String(error),8000)}`);this.records.put(fresh);
   return {apiVersion:API_VERSION,ok:false};
  }
 }
 /** A root is supervised by its visible owner, with no worker process and no worker admission slot. */
 startRoot(a:Record<string,unknown>):unknown {
  const task=this.records.task(a);this.records.revise(task,a);
  const restart=task.executionRole==='owner'&&task.status==='failed'&&!task.ownerHost;
  if((task.status!=='queued'&&!restart)||task.parentTaskId||task.dispatch||task.packageId||task.scheduled)fail('INVALID_STATE','Only an unfrozen queued root task may start its owner');
  if(!task.ownerId)fail('INVALID_STATE','Root task must be bound to an owner profile');
  const owner=this.records.owner(task.ownerId);const snapshot=this.policy.snapshot();const profile=snapshot.config.owners[owner.profileId];
  if(snapshot.owners[owner.profileId]?.status!=='available'||!profile)fail('POLICY_DENIED','Owner profile is unavailable');
  const engineKind=snapshot.config.engines[profile.engine]?.kind;
  if(engineKind!=='claude'&&engineKind!=='codex')fail('OWNER_LAUNCH_UNSUPPORTED','Root owner requires a claude or codex profile');
  task.workspace=absoluteExistingWorkspace(task.workspace);
  // A fresh launch uses the full task briefing; the old context pack targets the previous epoch.
  if(restart){task.ownerEpoch=(task.ownerEpoch??0)+1;delete task.contextPack;}delete task.failure;
  task.executionRole='owner';task.status='running';task.ownerLastActivityAt=new Date().toISOString();
  task.run={id:randomUUID(),adapter:'native',execution:'native',status:'running',startedAt:new Date().toISOString(),engine:profile.engine,model:profile.model,effort:profile.effort,workspace:task.workspace};
  event(task,'lifecycle','Starting root owner in Herdr; the owner will describe, split, dispatch and review child tasks');this.records.put(task);
  // Defer the external effect until after the command has persisted its immediate receipt.
  this.runner.runDeferred(()=>this.launchRoot(task,owner.profileId));
  return publicTask(task);
 }
 private *launchRoot(task:Task,profile:string):CommandFlow<CommandResponse> {
  if(this.isDraining()||terminal(this.manager.store.get(task.id)))return {apiVersion:API_VERSION,ok:true};
  const result=yield* this.startOwnerHost(task,profile,rootOwnerPrompt(task));
  const fresh=this.manager.store.get(task.id);
  if(result.failure&&!this.isDraining()&&fresh.ownerId===task.ownerId&&(fresh.ownerEpoch??0)===(task.ownerEpoch??0)&&fresh.status==='running'){
   fresh.status='failed';fresh.failure={kind:'other',message:redactContext(`${result.failure.code}: ${result.failure.message}`,8000)};
   if(fresh.run){fresh.run.status='stopped';fresh.run.endedAt=new Date().toISOString();}this.records.put(fresh);
  }
  return {apiVersion:API_VERSION,ok:!result.failure,data:result};
 }
}
