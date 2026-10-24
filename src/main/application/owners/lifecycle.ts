import { roleEngine } from '../../../shared/policy/channels';
import { randomUUID } from 'node:crypto';
import { API_VERSION, type CommandResponse } from '../../../shared/contracts/commands';
import type { LogicalOwner, OwnerInstance } from '../../../shared/contracts/owners';
import type { Task, TaskOwnerHost } from '../../../shared/contracts/tasks';
import { ownerSession, sameOwnerInstance } from '../../../shared/policy/owner-instance';
import { parseId, text } from '../../../shared/validation';
import type { MockOwnerHostAdapter } from '../../adapters/logical';
import { ContinuationService } from '../../continuation';
import type { TaskManager } from '../../manager';
import { deliverOwnerFollowup, OwnerFollowupError, OwnerLaunchError, type OwnerFollowupOptions, type OwnerLaunchResult } from '../../owner-host';
import { OwnerIdentity } from '../../owners/identity';
import { handoffPrompt, rootOwnerPrompt } from '../../owners/prompts';
import type { PolicyStore } from '../../policy/store';
import { redactContext } from '../../redact-context';
import { event, slotGroupCount, slotGroupFor } from '../../domain/tasks';
import { absoluteExistingWorkspace } from '../../workspace';
import { fail } from '../commands/errors';
import type { CommandArgs, CommandFlow } from '../commands/types';
import type { EffectRunner } from '../commands/gateway';
import { canonical, publicTask, terminal, type TaskRecords } from '../tasks/records';

const hostEvidence=(owner:LogicalOwner):Record<string,unknown>|undefined=>owner.host&&typeof owner.host==='object'&&!Array.isArray(owner.host)?owner.host as Record<string,unknown>:undefined;
const claimedHostPane=(owner:LogicalOwner):string|undefined=>{const pane=hostEvidence(owner)?.pane;return typeof pane==='string'&&pane?pane:undefined;};
/** The claimed row keeps its host evidence shape while name, profile and caller labels move to the claiming caller. */
function claimedHost(owner:LogicalOwner,name:string,profileId:string,session:string,pane:string):unknown {
 const current=hostEvidence(owner)??{};const {closedAt,...rest}=current;
 return {...rest,ownerId:owner.id,name,profileId,adapter:typeof rest.adapter==='string'?rest.adapter:'mock-owner',mode:'manual',state:'attached',
  visibility:'external-unverified',verified:false,ownsHost:false,session,pane,createdAt:typeof rest.createdAt==='string'?rest.createdAt:owner.createdAt};
}

/** Owner instances and the Herdr hosts behind them: registration, handoff launches, root owner start and exact cleanup. */
export class OwnerLifecycle {
 private readonly launchingEpochs = new Set<string>();
 private readonly identity:OwnerIdentity;
 constructor(private readonly manager:TaskManager,private readonly policy:PolicyStore,private readonly records:TaskRecords,
  private readonly continuation:ContinuationService,private readonly ownerHost:MockOwnerHostAdapter,
  private readonly runner:Pick<EffectRunner,'runDeferred'>,private readonly isDraining:()=>boolean,
  private readonly followupOptions:OwnerFollowupOptions={}){this.identity=new OwnerIdentity(manager.store);}
 /** Work holding this instance's own slots: running plus cancelling. Queued and terminal tasks hold none. */
 runningOn(owner:LogicalOwner):number {return slotGroupCount(this.manager.store.listHeads(),slotGroupFor(owner.id,owner.profileId));}
 /** Every registered instance, its profile, its caller session label and how much of it is busy. */
 ownerInstances():OwnerInstance[]{const tasks=this.manager.store.listHeads();return this.manager.store.listOwners().map(owner=>({...owner,runningTaskCount:slotGroupCount(tasks,slotGroupFor(owner.id,owner.profileId))}));}
 list(a:CommandArgs):unknown{return {owners:this.ownerInstances()};}
 get(a:CommandArgs):unknown{const owner=this.records.owner(a.ownerId);return {...owner,runningTaskCount:this.runningOn(owner)};}
 continuationGet(a:CommandArgs):unknown{return this.continuation.get(parseId(a.taskId,'task ID'));}
 /** Renames one instance for the web board; only the title moves, host, session and state stay as registered. */
 describe(a:CommandArgs):unknown{
  const title=text(a.title,'title',120).trim();
  const owner=this.records.owner(a.ownerId);
  owner.title=title;this.manager.store.putOwner(owner);
  return {...owner,runningTaskCount:this.runningOn(owner)};
 }
 continuationConfigure(a:CommandArgs):unknown{if(!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');return this.continuation.configure(parseId(a.taskId,'task ID'),a.expectedRevision as number,a.idleRotationMinutes as number|null);}
  register(command:'owners.attach'|'owners.spawn',a:CommandArgs):LogicalOwner&{credentialPath?:string}{
     const mode=command==='owners.spawn'&&a.provider==='mock'?'mock':'manual';if(a.provider!==undefined&&a.provider!=='mock')fail('CAPABILITY_UNAVAILABLE','This process does not spawn an owner model');
     // Inputs are validated before the registry is read, so a malformed request can never reach an existing instance.
     const profileId=text(a.profileId,'profileId',120);const name=text(a.name,'name',120);
     const title=a.title===undefined?undefined:text(a.title,'title',120).trim();
     const session=a.session===undefined?'external-cli':text(a.session,'session',120);
     const pane=a.pane===undefined?'unverified':text(a.pane,'pane',120);
     const owners=this.manager.store.listOwners();
     // An explicit ownerId claims that durable row instead of creating another one; profile, host and task bindings stay with it.
     if(command==='owners.attach'&&mode==='manual'&&a.ownerId!==undefined){
      const ownerId=parseId(a.ownerId,'owner ID');const found=owners.find(owner=>owner.id===ownerId);
      if(!found)fail('NOT_FOUND','Owner not found');
      const claimed=found!;
      if(claimed.profileId!==profileId)fail('INVALID_REQUEST','ownerId belongs to a different owner profile');
      if(claimed.mode!=='manual')fail('INVALID_STATE','Only an attached owner can be claimed');
      const nextSession=a.session===undefined?ownerSession(claimed)??'external-cli':session;
      const nextPane=a.pane===undefined?claimedHostPane(claimed)??'unverified':pane;
      const credentialPath=this.ensureCredential(claimed.id);
      claimed.name=name;claimed.session=nextSession;if(title!==undefined)claimed.title=title;
      claimed.host=claimedHost(claimed,name,profileId,nextSession,nextPane);
      this.manager.store.putOwner(claimed);return {...claimed,credentialPath};
     }
     // The profile is the policy role; this caller's profile + name + session is one instance of it. A repeat attach is that same durable registration.
     if(command==='owners.attach'&&mode==='manual'){
      const attached=owners.find(owner=>sameOwnerInstance(owner,{profileId,name,session}));
      if(attached){const credentialPath=this.ensureCredential(attached.id);if(title!==undefined){attached.title=title;this.manager.store.putOwner(attached);}return {...attached,credentialPath};}
     }
     // Admission and limits decide whether a new instance may be created; a duplicate has nothing to admit.
     if(this.policy.snapshot().owners[profileId]?.status!=='available')fail('POLICY_DENIED','Owner profile is unavailable');
     const owner:LogicalOwner={id:randomUUID(),name,profileId,mode,state:mode==='mock'?'ready':'attached',createdAt:new Date().toISOString(),...(mode==='manual'?{session}:{})};
     if(title!==undefined)owner.title=title;
     const credentialPath=command==='owners.attach'?this.ensureCredential(owner.id):undefined;
     if(mode==='mock'){if(a.session!==undefined||a.pane!==undefined)fail('INVALID_REQUEST','Logical registration has no session or pane');owner.host=this.ownerHost.spawn({ownerId:owner.id,name:owner.name,profileId});}
     else owner.host=this.ownerHost.attach({ownerId:owner.id,name:owner.name,profileId,session,pane});
     this.manager.store.putOwner(owner);return credentialPath?{...owner,credentialPath}:owner;
   }
  private ensureCredential(ownerId:string):string{
   try{return this.identity.ensure(ownerId).credentialPath;}
   catch(error){return fail('PERSISTENCE_ERROR',`Could not prepare the owner credential file: ${error instanceof Error?error.message:String(error)}`);}
  }
 *switchOwner(a:CommandArgs):CommandFlow<unknown>{if(!Number.isSafeInteger(a.expectedRevision)||(a.expectedEpoch!==undefined&&!Number.isSafeInteger(a.expectedEpoch)))fail('INVALID_REQUEST','Revision and epoch must be integers');if(a.reason!==undefined&&a.reason!=='manual'&&a.reason!=='idle')fail('INVALID_REQUEST','Invalid switch reason');if(a.launch!==undefined&&typeof a.launch!=='boolean')fail('INVALID_REQUEST','launch must be a boolean');const task=this.records.task(a);const owner=this.records.owner(task.ownerId);const profile=text(a.profileId??owner.profileId,'profileId',120);if(this.policy.snapshot().owners[profile]?.status!=='available')fail('POLICY_DENIED','Target owner profile unavailable');const result=this.continuation.rotate(task.id,Number(a.expectedRevision),a.reason==='idle'?'idle':'manual',a.expectedEpoch===undefined?undefined:Number(a.expectedEpoch),profile);if(a.launch!==true)return result;const launched=yield* this.startOwnerHost(this.manager.store.get(task.id),profile,typeof result.prompt==='string'?result.prompt:'');(result as {launch?:unknown}).launch=launched.ownerHost?{ok:true,ownerHost:launched.ownerHost}:{ok:false,code:launched.failure!.code,message:launched.failure!.message};return result;}
 *launchOwner(a:CommandArgs):CommandFlow<unknown>{if(!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');const task=this.records.task(a);this.records.revise(task,a);if(!task.contextPack)return fail('INVALID_STATE','No context pack to launch the owner from');const owner=task.ownerId?this.records.owner(task.ownerId):undefined;if(!owner)return fail('INVALID_STATE','Task has no logical owner');const profile=owner.profileId;if(this.policy.snapshot().owners[profile]?.status!=='available')fail('POLICY_DENIED','Owner profile is unavailable');const prompt=handoffPrompt(task,task.contextPack,this.continuation.dataDir);const launched=yield* this.startOwnerHost(this.manager.store.get(task.id),profile,prompt);return {taskId:task.id,prompt,...launched.ownerHost?{launch:{ok:true,ownerHost:launched.ownerHost}}:{launch:{ok:false,code:launched.failure!.code,message:launched.failure!.message}},task:publicTask(this.manager.store.get(task.id))};}
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
    launched=(yield {kind:'launch',input:{taskId:task.id,epoch,title:task.title,workspace,channel:ownerConfig.channel,channelConfig:this.followupOptions.channelConfig?.(ownerConfig.channel),channelStateDir:this.followupOptions.channelStateDir,engineKind:config.engines[roleEngine(config,ownerConfig)]?.kind??'',model:ownerConfig.model,effort:ownerConfig.effort,prompt}})!;
    const fresh=current();
    if(!fresh){
     // A newer binding or shutdown owns the task now. Only this attempt's successful host is disposable.
     cleanupAttempted=true;try{yield {kind:'close',host:launched};}catch(error){throw new OwnerLaunchError('OWNER_LAUNCH_FAILED',`Owner launch superseded; host cleanup failed: ${error instanceof Error?error.message:String(error)}`);}
     throw new OwnerLaunchError('OWNER_LAUNCH_FAILED','Owner launch superseded by a newer binding or app shutdown');
    }
    ownerHost={...(launched.channelStateDir?{channelStateDir:launched.channelStateDir}:{}),...(launched.channelProfilePath?{channelProfilePath:launched.channelProfilePath}:{}),...(launched.channelEnvironmentPath?{channelEnvironmentPath:launched.channelEnvironmentPath}:{}),kind:'herdr',session:launched.session,workspaceId:launched.workspaceId,paneId:launched.paneId,...(launched.tabId?{tabId:launched.tabId}:{}),...(launched.terminalId?{terminalId:launched.terminalId}:{}),...(launched.createdWorkspace===undefined?{}:{createdWorkspace:launched.createdWorkspace}),agentName:launched.agentName,launchedAt:new Date().toISOString()};
    fresh.ownerHost=ownerHost;event(fresh,'lifecycle',`Started ${profile} in Herdr (${ownerHost.agentName})`);this.records.put(fresh);
    return {ownerHost};
   }catch(error){
    // update() also notifies listeners after its atomic store write. A listener failure must not dispose a durably visible host.
    const saved=this.manager.store.get(task.id);
    if(ownerHost&&saved.ownerId===ownerId&&(saved.ownerEpoch??0)===epoch&&saved.ownerHost&&
      saved.ownerHost.session===ownerHost.session&&saved.ownerHost.workspaceId===ownerHost.workspaceId&&saved.ownerHost.paneId===ownerHost.paneId&&saved.ownerHost.tabId===ownerHost.tabId&&saved.ownerHost.terminalId===ownerHost.terminalId&&saved.ownerHost.createdWorkspace===ownerHost.createdWorkspace&&saved.ownerHost.agentName===ownerHost.agentName&&saved.ownerHost.launchedAt===ownerHost.launchedAt)return {ownerHost:saved.ownerHost};
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
 /** Delivers one user follow-up synchronously to the running root owner host and leaves an event trail. */
 followup(a:Record<string,unknown>):unknown {
  const task=this.records.task(a);
  const message=typeof a.message==='string'?a.message.trim():'';
  if(!message||Array.from(message).length>8000)fail('INVALID_REQUEST','message must be 1–8000 characters after trimming');
  let source='cli';
  if(a.source!==undefined){
   const rawSource=a.source;
   if(typeof rawSource!=='string')fail('INVALID_REQUEST','source must be a string');
   const trimmed=(rawSource as string).trim();
   if(!trimmed||Array.from(trimmed).length>40)fail('INVALID_REQUEST','source must be 1–40 characters after trimming');
   source=trimmed;
  }
  if(task.parentTaskId)fail('INVALID_STATE','Only a root owner task can receive a follow-up instruction');
  if(task.status!=='running')fail('INVALID_STATE',task.status==='queued'?'Root task has not started; run tasks start first':`Root task is not running (${task.status})`);
  if(task.executionRole!=='owner')fail('INVALID_STATE','Only a root owner task can receive a follow-up instruction');
  if(!task.ownerHost)fail('INVALID_STATE','Root task has no Herdr owner host; start the owner first');
  const host=task.ownerHost!;
  if(host.kind!=='herdr')fail('INVALID_STATE','Root task owner host is not a Herdr host');
  const snapshot=this.policy.snapshot();
  const owner=task.ownerId?this.manager.store.getOwner(task.ownerId):undefined;
  const profile=owner?snapshot.config.owners[owner.profileId]:undefined;
  const engineKind=profile?snapshot.config.engines[roleEngine(snapshot.config,profile)]?.kind:undefined;
  try{
   const delivered=deliverOwnerFollowup({host,taskId:task.id,message,source,engineKind:String(engineKind??'')},this.followupOptions);
   const fresh=this.manager.store.get(task.id);
   event(fresh,'log',`追加目标（来源：${source}）：\n${redactContext(message,8000)}`);this.records.put(fresh);
   return {taskId:task.id,delivered:true,deliveredAt:delivered.deliveredAt,ownerHost:{session:host.session,paneId:host.paneId}};
  }catch(error){
   if(!(error instanceof OwnerFollowupError))throw error;
   const fresh=this.manager.store.get(task.id);
   // The failure trail names the source and code only; the user's original text is never recorded here.
   event(fresh,'error',`追加目标投递失败（来源：${source}，${error.code}）：未投递用户原文；失败详情见本次命令响应。`);this.records.put(fresh);
   fail(error.code,error.message);
  }
 }
 /** A root is supervised by its visible owner, with no worker process and no worker admission slot. */
 startRoot(a:Record<string,unknown>):unknown {
  const task=this.records.task(a);this.records.revise(task,a);
  const restart=task.executionRole==='owner'&&task.status==='failed'&&!task.ownerHost;
  if((task.status!=='queued'&&!restart)||task.parentTaskId||task.dispatch||task.packageId||task.scheduled)fail('INVALID_STATE','Only an unfrozen queued root task may start its owner');
  if(!task.workspace)fail('INVALID_STATE','Set a workspace before starting the root task');
  if(!task.ownerId)fail('INVALID_STATE','Root task must be bound to an owner profile');
  const owner=this.records.owner(task.ownerId);const snapshot=this.policy.snapshot();const profile=snapshot.config.owners[owner.profileId];
  if(snapshot.owners[owner.profileId]?.status!=='available'||!profile)fail('POLICY_DENIED','Owner profile is unavailable');
  const engineKind=snapshot.config.engines[roleEngine(snapshot.config,profile)]?.kind;
  if(engineKind!=='claude'&&engineKind!=='codex')fail('OWNER_LAUNCH_UNSUPPORTED','Root owner requires a claude or codex profile');
  task.workspace=absoluteExistingWorkspace(task.workspace);
  // A fresh launch uses the full task briefing; the old context pack targets the previous epoch.
  if(restart){task.ownerEpoch=(task.ownerEpoch??0)+1;delete task.contextPack;}delete task.failure;
  task.executionRole='owner';task.status='running';task.ownerLastActivityAt=new Date().toISOString();
  task.run={policyRevision:snapshot.revision,id:randomUUID(),adapter:'native',execution:'native',status:'running',startedAt:new Date().toISOString(),channel:profile.channel,channelLabel:snapshot.config.channels[profile.channel]?.label,engine:roleEngine(snapshot.config,profile),model:profile.model,effort:profile.effort,workspace:task.workspace};
  event(task,'lifecycle','Starting root owner in Herdr; the owner will describe, split, dispatch and review child tasks');this.records.put(task);
  // Defer the external effect until after the command has persisted its immediate receipt.
  this.runner.runDeferred(()=>this.launchRoot(task,owner.profileId));
  return publicTask(task);
 }
 private *launchRoot(task:Task,profile:string):CommandFlow<CommandResponse> {
  if(this.isDraining()||terminal(this.manager.store.get(task.id)))return {apiVersion:API_VERSION,ok:true};
  const result=yield* this.startOwnerHost(task,profile,rootOwnerPrompt(task,this.continuation.dataDir));
  const fresh=this.manager.store.get(task.id);
  if(result.failure&&!this.isDraining()&&fresh.ownerId===task.ownerId&&(fresh.ownerEpoch??0)===(task.ownerEpoch??0)&&fresh.status==='running'){
   fresh.status='failed';fresh.failure={kind:'other',message:redactContext(`${result.failure.code}: ${result.failure.message}`,8000)};
   if(fresh.run){fresh.run.status='stopped';fresh.run.endedAt=new Date().toISOString();}this.records.put(fresh);
  }
  return {apiVersion:API_VERSION,ok:!result.failure,data:result};
 }
}
