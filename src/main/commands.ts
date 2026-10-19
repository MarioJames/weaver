import { createHash, randomUUID } from 'node:crypto';
import { API_VERSION, type CommandResponse, type LogicalOwner, type WorkPackage } from '../shared/commands';
import type { Task } from '../shared/types';
import { object, parseId, parseTaskInput, parseWorkerRecord, text } from '../shared/validation';
import { TaskManager } from './manager';
import { event } from './store';
import { ContinuationService, ContinuationError, redactContext } from './continuation';
import { MockOwnerHostAdapter, type OwnerHostEvidence, type OwnerMessage } from './adapters/logical';
import { PolicyStore } from './policy/store';
import { QUOTA_CAPABILITIES } from './policy/quota';
import { absoluteExistingWorkspace, assertFrozenWorkspace, workspaceIdentity, isRealEngineKind, REAL_ENGINE_KINDS } from './workspace';
import { workerInstruction } from './adapters/instruction';
export const WRITE_COMMANDS = ['owners.attach','owners.spawn','owners.switch','owners.continuation.configure','tasks.create','tasks.retry','tasks.cancel','packages.create','workers.spawn','workers.complete','results.deliver','results.ack','reviews.submit'] as const;
export const READ_COMMANDS = ['capabilities.get','sync.snapshot','sync.status','owners.list','owners.get','owners.continuation.get','tasks.get','tasks.list','tasks.events','tasks.results','artifacts.read','packages.get','operations.get','observability.get','observability.export'] as const;
const writes=new Set<string>(WRITE_COMMANDS);
export function configuredParallel(policy: PolicyStore): number {
 return Object.values(policy.snapshot().config.owners).filter(owner => owner.enabled).reduce((sum, owner) => sum + owner.max_parallel, 0);
}
class CommandError extends Error {constructor(readonly code:string,message:string){super(message);}}
const fail=(code:string,message:string):never=>{throw new CommandError(code,message);};
function canonical(value:unknown):string {if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;return JSON.stringify(value);}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const terminal=(t:Task)=>['completed','failed','cancelled'].includes(t.status);
/** A single app-owned handler shared by the loopback UI and CLI. The local principal is deliberately
 * trusted-local-machine scope, not an OS-user login or a real-agent grant. */
export class CommandHandler {
 draining=false;
 transportStatus:'ready'|'unavailable'|'not-started'='not-started';
 private ownerHost=new MockOwnerHostAdapter();
 private continuation:ContinuationService;
 constructor(readonly manager:TaskManager,readonly policy:PolicyStore){
  this.continuation=new ContinuationService(manager.store,this.ownerHost);
  manager.listeners.add(()=>queueMicrotask(()=>this.pump()));
  for(const owner of manager.store.getMetadata().owners) if(owner.host)this.ownerHost.restore(owner.host as OwnerHostEvidence,(owner.messages??[]) as OwnerMessage[]);
  queueMicrotask(()=>this.pump());
 }
 handle(value:unknown):CommandResponse {
  let commandId:string|undefined; let receiptKey:string|undefined; let effected=false;
  try {
   if(Buffer.byteLength(JSON.stringify(value))>128*1024)fail('INVALID_REQUEST','Request exceeds 128 KiB');
   const r=object(value); if(r.apiVersion!==API_VERSION)fail('VERSION_UNSUPPORTED','Expected weaver.v1');
   const command=text(r.command,'command',80); const args=structuredClone(object(r.args??{}));
   if(r.commandId!==undefined)commandId=text(r.commandId,'commandId',120);
   if(this.draining)fail('APP_DRAINING','App is shutting down');
   if(writes.has(command)) {
    if(!commandId)fail('INVALID_REQUEST','Mutation requires commandId');
    receiptKey=`local-demo:${commandId}`;const hash=digest({command,args});const meta=this.manager.store.getMetadata();const old=meta.receipts[receiptKey];
    if(old) {if(old.hash!==hash)fail('IDEMPOTENCY_CONFLICT','commandId already used for different arguments');if(old.response)return old.response;fail('COMMAND_INDETERMINATE','Previous command was interrupted. Inspect tasks/owners before issuing a new command; no automatic replay was performed.');}
    if(Object.keys(meta.receipts).length>=5000)fail('RESOURCE_LIMIT','Command receipt limit reached');
    // Durable intent first: a crash can block a retry, but cannot silently repeat a spawn.
    meta.receipts[receiptKey]={hash};this.manager.store.setMetadata(meta);
   }
   const response:CommandResponse={apiVersion:API_VERSION,commandId,ok:true,data:this.execute(command,args)};
   effected=true;if(writes.has(command))this.manager.notify();if(receiptKey)this.finish(receiptKey,response);return response;
  }catch(error){
   if(effected)return {apiVersion:API_VERSION,commandId,ok:false,error:{code:'COMMAND_INDETERMINATE',message:'Command applied but receipt persistence failed; inspect current state before retrying',retryable:false}};
   const response:CommandResponse={apiVersion:API_VERSION,commandId,ok:false,error:{code:error instanceof CommandError||error instanceof ContinuationError?error.code:'INVALID_REQUEST',message:error instanceof Error?error.message:'Command failed',retryable:false}};
   // Never replace a prior receipt on conflict or overwrite an incomplete durable intent.
   if(receiptKey && !['IDEMPOTENCY_CONFLICT','COMMAND_INDETERMINATE'].includes(response.error!.code)) {
    const receipt=this.manager.store.getMetadata().receipts[receiptKey];
    if(receipt&&!receipt.response)try{this.finish(receiptKey,response);}catch{return {...response,error:{code:'PERSISTENCE_ERROR',message:'Could not persist receipt; inspect current state before retrying',retryable:false}};}
   }
   return response;
  }
 }
 private finish(key:string,response:CommandResponse){const meta=this.manager.store.getMetadata();meta.receipts[key].response=response;this.manager.store.setMetadata(meta);}
 private owner(id:unknown):LogicalOwner {const owner=this.manager.store.getMetadata().owners.find(o=>o.id===parseId(id));if(!owner)fail('NOT_FOUND','Owner not found');return owner!;}
 private task(a:Record<string,unknown>):Task {try{return this.manager.store.get(parseId(a.taskId));}catch{ return fail('NOT_FOUND','Task not found');}}
 private revise(task:Task,a:Record<string,unknown>){if(a.expectedRevision!==undefined && a.expectedRevision!==(task.revision??0))fail('REVISION_CONFLICT',`Current revision is ${task.revision??0}`);}
 private put(task:Task){this.manager.update(task);}
 private pumping=false;
 checkIdleOwners():string[] {return this.manager.store.list().filter(task=>task.ownerId&&this.continuation.due(task.id)).map(task=>task.id);}
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
 pump():void {
  if(this.pumping||this.draining)return;this.pumping=true;
  try{for(const task of this.manager.store.list().reverse()){
   if(terminal(task)&&task.ownerId){try{this.execute('results.deliver',{taskId:task.id});}catch{/* Manual owners pull results. */}}
   if(task.status!=='queued'||!task.scheduled||!task.dispatch)continue;
   let phase:NonNullable<Task['queueReason']>['code']='policy_blocked';
   try{
    const frozen=task.dispatch;
    const running=this.manager.store.list().filter(t=>(t.status==='running'||t.status==='cancelling')&&t.dispatch?.owner===frozen.owner).length;
    const route=this.policy.preview({owner:frozen.owner,worker:frozen.worker,runningCount:running});
    const kind=this.policy.snapshot().config.engines[route.engine]?.kind;
    if(route.worker!==frozen.worker||route.engine!==frozen.engine||route.model!==frozen.model||route.effort!==frozen.effort||(frozen.engineKind!==undefined&&kind!==frozen.engineKind)){
     this.queueBlocked(task,'frozen_route_changed','Current worker engine, kind, model or effort no longer matches the frozen dispatch; restore the route or cancel and create a new task.');continue;
    }
    if(!route.capacityAvailable){this.queueBlocked(task,'waiting_for_capacity',`Owner ${frozen.owner} is at its current concurrency limit (${route.maxParallel}).`);continue;}
    phase='workspace_changed';if(frozen.execution==='real')assertFrozenWorkspace(frozen);
    phase='launch_blocked';this.manager.start(task.id,route.maxParallel);
   }catch(error){
    // start may have created/stopped a process before a persistence error. Never overwrite
    // its current state with the stale queued snapshot or make that attempt runnable again.
    const current=this.manager.store.get(task.id);
    if(current.status==='queued'&&current.scheduled)this.queueBlocked(current,phase,error instanceof Error?error.message:'Queued dispatch blocked');
   }
  }}finally{this.pumping=false;}
 }
 private publicTask(task:Task){const {owner,run,...rest}=task;if(!run)return rest;const visible={...run};delete visible.pid;return {...rest,run:visible};}
 private manifest(task:Task){if(!terminal(task))fail('RESULT_NOT_READY','Execution has not reached a terminal state');const manifest={taskId:task.id,attemptId:task.run?.id??null,packageId:task.packageId??null,execution:task.status,summary:task.summary??null,artifacts:task.artifacts.map(a=>({id:a.id,name:a.name,mediaType:a.mediaType,sha256:createHash('sha256').update(a.content).digest('hex')})),exitCode:task.run?.exitCode??null};return {...manifest,manifestDigest:digest(manifest),delivery:task.acknowledged?'acknowledged':'pending',acceptance:task.reviewState??'pending'};}
 private decideExecution(engine:string,provider:unknown,task:Task,ownerEngine?:string):{execution:'real'|'mock'|'native';adapter:string;maxWaitMinutes:number;workspace?:string;engineKind?:string} {
  const minutes=this.policy.snapshot().config.herdr.max_wait_minutes;
  if(!Number.isSafeInteger(minutes)||minutes<1||minutes>1440)fail('INVALID_REQUEST','Configured max_wait_minutes is invalid');
  if(provider==='mock-jsonl'||this.manager.adapterId==='mock-jsonl') return {execution:'mock',adapter:'mock-jsonl',maxWaitMinutes:minutes};
  // A worker on the owner's own engine runs inside the owner with its built-in subagent tool; Weaver launches nothing.
  if(ownerEngine!==undefined&&engine===ownerEngine) return {execution:'native',adapter:'native',maxWaitMinutes:minutes,...(task.workspace?{workspace:task.workspace}:{})};
  const kind=this.policy.snapshot().config.engines[engine]?.kind??'';
  if(kind==='claude')fail('CAPABILITY_UNAVAILABLE','Claude Code real execution is deferred. No mock provider was substituted.');
  if(!isRealEngineKind(kind))fail('CAPABILITY_UNAVAILABLE',`Engine ${engine} (${kind||'unknown kind'}) cannot be launched. No mock provider was substituted.`);
  if(!this.manager.canLaunchReal)fail('CAPABILITY_UNAVAILABLE',`Real launcher for ${kind} is not loaded. No mock provider was substituted.`);
  return {execution:'real',adapter:kind,engineKind:kind,workspace:absoluteExistingWorkspace(task.workspace),maxWaitMinutes:minutes};
 }
 private execute(command:string,a:Record<string,unknown>):unknown {
  switch(command){
   case 'sync.snapshot':return {revision:this.manager.store.revision,tasks:this.manager.store.list().map(t=>({id:t.id,title:t.title,status:t.status,revision:t.revision??0,ownerId:t.ownerId,updatedAt:t.updatedAt,reviewState:t.reviewState??'pending'})),owners:this.manager.store.getMetadata().owners.map(o=>({id:o.id,name:o.name,profileId:o.profileId,mode:o.mode,state:o.state}))};
   case 'sync.status':return {revision:this.manager.store.revision,changed:a.after!==this.manager.store.revision,recovery:'refresh sync.snapshot; push invalidation is not a durable event stream'};
   case 'capabilities.get':return {apiVersion:API_VERSION,cliTransport:this.transportStatus,authentication:'ephemeral-local-trusted-user-demo',ownerScopedAuthorization:false,ownerSpawn:'logical-registration',manualAttach:'metadata-only',ownerModelSpawned:false,attachmentVerified:false,authenticated:false,modelUsable:false,workerProviders:this.manager.canLaunchReal?['mock-jsonl',...REAL_ENGINE_KINDS]:['mock-jsonl'],realExecution:this.manager.canLaunchReal,mcp:false,maxParallel:configuredParallel(this.policy),policyAdmission:true,quota:QUOTA_CAPABILITIES,commands:[...READ_COMMANDS,...WRITE_COMMANDS],limits:{tasks:200,owners:200,packages:1000,receipts:5000,eventsPerPage:100},durability:'durable intent before effect; interrupted commands require reconciliation, not automatic replay'};
   case 'owners.continuation.get':return this.continuation.get(parseId(a.taskId));
   case 'owners.continuation.configure':{if(!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');return this.continuation.configure(parseId(a.taskId),a.expectedRevision as number,a.idleRotationMinutes as number|null);}
   case 'owners.switch':{if(!Number.isSafeInteger(a.expectedRevision)||(a.expectedEpoch!==undefined&&!Number.isSafeInteger(a.expectedEpoch)))fail('INVALID_REQUEST','Revision and epoch must be integers');if(a.reason!==undefined&&a.reason!=='manual'&&a.reason!=='idle')fail('INVALID_REQUEST','Invalid switch reason');const task=this.task(a);const owner=this.owner(task.ownerId);const profile=text(a.profileId??owner.profileId,'profileId',120);if(this.policy.snapshot().owners[profile]?.status!=='available')fail('POLICY_DENIED','Target owner profile unavailable');return this.continuation.rotate(task.id,Number(a.expectedRevision),a.reason==='idle'?'idle':'manual',a.expectedEpoch===undefined?undefined:Number(a.expectedEpoch),profile);}
   case 'owners.list':return {owners:this.manager.store.getMetadata().owners};
   case 'owners.get':return this.owner(a.ownerId);
   case 'owners.attach':case 'owners.spawn':{
    const mode=command==='owners.spawn'&&a.provider==='mock'?'mock':'manual';if(a.provider!==undefined&&a.provider!=='mock')fail('CAPABILITY_UNAVAILABLE','This process does not spawn an owner model');
    const profileId=text(a.profileId,'profileId',120);const snapshot=this.policy.snapshot();if(snapshot.owners[profileId]?.status!=='available')fail('POLICY_DENIED','Owner profile is unavailable');
    const meta=this.manager.store.getMetadata();if(meta.owners.length>=200)fail('RESOURCE_LIMIT','Owner limit reached');
    const owner:LogicalOwner={id:randomUUID(),name:text(a.name,'name',120),profileId,mode,state:mode==='mock'?'ready':'attached',createdAt:new Date().toISOString()};
    if(mode==='mock'){if(a.session!==undefined||a.pane!==undefined)fail('INVALID_REQUEST','Logical registration has no session or pane');owner.host=this.ownerHost.spawn({ownerId:owner.id,name:owner.name,profileId});}
    else owner.host=this.ownerHost.attach({ownerId:owner.id,name:owner.name,profileId,session:a.session===undefined?'external-cli':text(a.session,'session',120),pane:a.pane===undefined?'unverified':text(a.pane,'pane',120)});
    meta.owners.push(owner);this.manager.store.setMetadata(meta);return owner;
   }
   case 'tasks.create':return this.manager.store.transaction(()=>{
    let owner:LogicalOwner|undefined;let input;
    if(a.ownerProfileId!==undefined){parseTaskInput({...a,instruction:a.instruction??a.goal,owner:{name:'validation',transport:'herdr-visible',session:'unverified',pane:'unverified'}});if(this.manager.store.list().length>=200)fail('RESOURCE_LIMIT','Task limit reached');if(a.ownerId!==undefined)fail('INVALID_REQUEST','Choose ownerId or ownerProfileId');owner=this.execute('owners.spawn',{profileId:a.ownerProfileId,name:a.ownerName??'Task owner',provider:a.ownerProvider}) as LogicalOwner;}
    if(a.ownerId!==undefined||owner){owner??=this.owner(a.ownerId);input=parseTaskInput({...a,title:a.title,instruction:a.instruction??a.goal,owner:{name:owner.name,transport:'herdr-visible',session:'unverified',pane:'unverified'}});}else input=parseTaskInput(a);
    const task=this.manager.create(input);if(owner){task.ownerId=owner.id;task.ownerEpoch=0;task.ownerLastActivityAt=new Date().toISOString();task.continuationPolicy={idleRotationMinutes:60};this.put(task);}return this.publicTask(task);
   });
   case 'tasks.retry':{const previous=this.task(a);if(!terminal(previous))fail('INVALID_STATE','Retry requires terminal execution');const task=this.manager.create({title:previous.title,instruction:previous.instruction,owner:previous.owner,workspace:previous.workspace,acceptanceCriteria:previous.acceptanceCriteria,constraints:previous.constraints});task.ownerId=previous.ownerId;task.retryOf=previous.id;this.put(task);return this.publicTask(task);}
   case 'tasks.get':return this.publicTask(this.task(a));
   case 'tasks.list':{
    const offset=a.offset??0;const limit=a.limit??25;if(!Number.isSafeInteger(offset)||Number(offset)<0||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>100)fail('INVALID_REQUEST','Invalid pagination');
    const all=this.manager.store.list().filter(t=>a.ownerId===undefined||t.ownerId===a.ownerId);const tasks=all.slice(Number(offset),Number(offset)+Number(limit)).map(t=>{const {events,artifacts,...summary}=this.publicTask(t);return {...summary,artifactCount:artifacts.length};});return {tasks,nextOffset:Number(offset)+tasks.length<all.length?Number(offset)+tasks.length:null};
   }
   case 'packages.create':{
    const task=this.task(a);this.revise(task,a);if(task.status!=='queued')fail('INVALID_STATE','Only queued tasks accept a work package');if(task.packageId)fail('INVALID_STATE','Task already has a frozen package');
    const strings=(v:unknown,label:string)=>{if(!Array.isArray(v)||v.length<1||v.length>30)fail('INVALID_REQUEST',`Provide 1–30 ${label}`);return (v as unknown[]).map(x=>text(x,label,1000));};
    const pkg:WorkPackage={id:randomUUID(),taskId:task.id,revision:1,instruction:task.instruction,scope:strings(a.scope,'scope entries'),acceptanceCriteria:strings(a.acceptanceCriteria,'acceptance criteria'),createdAt:new Date().toISOString()};
    const meta=this.manager.store.getMetadata();if(meta.packages.length>=1000)fail('RESOURCE_LIMIT','Package limit reached');meta.packages.push(pkg);this.manager.store.transaction(()=>{this.manager.store.setMetadata(meta);task.packageId=pkg.id;event(task,'lifecycle','Frozen work package created');this.put(task);});return pkg;
   }
   case 'packages.get':{const pkg=this.manager.store.getMetadata().packages.find(p=>p.id===parseId(a.packageId));if(!pkg)fail('NOT_FOUND','Package not found');return pkg;}
   case 'workers.spawn':{
    let task=this.task(a);this.revise(task,a);if(task.status!=='queued')fail('INVALID_STATE','Only queued tasks may dispatch');
    if(a.provider!==undefined&&a.provider!=='mock-jsonl')fail('CAPABILITY_UNAVAILABLE',`Provider ${String(a.provider)} is not available`);
    if(a.packageId!==undefined&&a.packageId!==task.packageId)fail('REVISION_CONFLICT','Package does not belong to task');
    if(task.scheduled)fail('INVALID_STATE','Task already scheduled');
    const logical=task.ownerId?this.owner(task.ownerId):undefined;
    const owner=text(a.owner??logical?.profileId??Object.keys(this.policy.snapshot().config.owners)[0],'owner profile',120);
    if(logical&&owner!==logical.profileId)fail('POLICY_DENIED','Task owner profile cannot be changed at dispatch');
    const running=this.manager.store.list().filter(t=>(t.status==='running'||t.status==='cancelling')&&t.dispatch?.owner===owner).length;
    const route=this.policy.preview({owner,...(a.worker!==undefined?{worker:a.worker}:{}),runningCount:running});
    const decision=this.decideExecution(route.engine,a.provider,task,this.policy.snapshot().config.owners[route.owner]?.engine);
    const pendingPackage:WorkPackage=task.packageId?this.manager.store.getMetadata().packages.find(p=>p.id===task.packageId&&p.taskId===task.id)!:{id:randomUUID(),taskId:task.id,revision:1,instruction:task.instruction,scope:[decision.workspace??task.workspace??'Explicit mock fixture'],acceptanceCriteria:task.acceptanceCriteria?.length?task.acceptanceCriteria:[decision.execution==='mock'?'Mock output returned for owner review':'Provider result returned for owner review'],createdAt:new Date().toISOString()};
    if(!pendingPackage)fail('INVALID_REQUEST','Frozen work package is missing');
    if(decision.execution==='real')workerInstruction({...task,workspace:decision.workspace},pendingPackage);
    this.prepareOwnerActivity(command,a);task=this.task(a);
    if(decision.workspace)task.workspace=decision.workspace;
    if(!task.packageId){const meta=this.manager.store.getMetadata();if(meta.packages.length>=1000)fail('RESOURCE_LIMIT','Package limit reached');meta.packages.push(pendingPackage);this.manager.store.transaction(()=>{this.manager.store.setMetadata(meta);task.packageId=pendingPackage.id;this.put(task);});}
    task.dispatch={owner:route.owner,worker:route.worker,engine:route.engine,model:route.model,effort:route.effort,execution:decision.execution,maxParallel:route.maxParallel,maxWaitMinutes:decision.maxWaitMinutes,adapter:decision.adapter,...(decision.workspace?{workspace:decision.workspace,...(decision.execution==='real'?{workspaceIdentity:workspaceIdentity(decision.workspace)}:{})}:{}),...(decision.engineKind?{engineKind:decision.engineKind}:{})};
    event(task,'lifecycle',decision.execution==='real'?`Policy selected ${route.worker}; launching ${decision.engineKind} in ${decision.workspace}`:decision.execution==='native'?`Policy selected ${route.worker} on the owner's engine; the owner runs it with its built-in subagent tool (${route.model}, ${route.effort})`:`Policy selected ${route.worker}; explicit mock-jsonl provider`);
    if(!route.capacityAvailable){task.scheduled=true;task.queueReason={code:'waiting_for_capacity',message:`Owner ${route.owner} is at its current concurrency limit (${route.maxParallel}).`};event(task,'lifecycle','Dispatch admitted to queue; waiting for an execution slot');this.put(task);return this.publicTask(task);}this.put(task);return this.publicTask(this.manager.start(task.id,route.maxParallel));
   }
   case 'workers.complete':{
    const task=this.task(a);this.revise(task,a);
    if(task.status!=='running'||task.run?.execution!=='native')fail('INVALID_STATE','Only a running native task accepts workers complete');
    if(a.outcome!=='completed'&&a.outcome!=='failed')fail('INVALID_REQUEST','outcome must be completed or failed');
    const summary=text(a.summary,'summary',8000);
    if(a.artifacts!==undefined&&(!Array.isArray(a.artifacts)||a.artifacts.length>20))fail('INVALID_REQUEST','artifacts must be an array of at most 20 files');
    const artifacts=((a.artifacts as unknown[]|undefined)??[]).map(item=>{const record=parseWorkerRecord({...object(item),type:'artifact'});if(record.type!=='artifact')throw new CommandError('INVALID_REQUEST','Invalid artifact');return {name:record.name,mediaType:record.mediaType,content:record.content};});
    if(task.artifacts.length+artifacts.length>20)fail('RESOURCE_LIMIT','Task exceeds 20 artifacts');
    return this.publicTask(this.manager.completeNative(task.id,{outcome:a.outcome as 'completed'|'failed',summary,artifacts}));
   }
   case 'tasks.cancel':{const task=this.task(a);this.revise(task,a);if(terminal(task))return {task:this.publicTask(task),alreadyTerminal:true};return this.publicTask(this.manager.cancel(task.id));}
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
   case 'artifacts.read':{const task=this.task(a);const artifact=task.artifacts.find(v=>v.id===parseId(a.artifactId));if(!artifact)fail('NOT_FOUND','Artifact not found');return artifact;}
   case 'results.deliver':{
    const task=this.task(a);const manifest=this.manifest(task);if(!task.ownerId)fail('CAPABILITY_UNAVAILABLE','Task has no logical owner');const owner=this.owner(task.ownerId);if(owner.mode!=='mock')fail('CAPABILITY_UNAVAILABLE','Manual owner delivery is not connected');
    const existing=(owner.messages??[]).find(m=>m.taskId===task.id&&m.manifestDigest===manifest.manifestDigest);if(existing)return existing;
    const message=this.ownerHost.deliverResult(owner.id,{taskId:task.id,manifestDigest:manifest.manifestDigest});const meta=this.manager.store.getMetadata();const target=meta.owners.find(o=>o.id===owner.id)!;target.messages=[...(target.messages??[]),message];this.manager.store.setMetadata(meta);return message;
   }
   case 'results.ack':case 'reviews.submit':{
    const task=this.task(a);if(a.expectedRevision===undefined)fail('INVALID_REQUEST','expectedRevision is required');this.revise(task,a);const manifest=this.manifest(task);if(a.manifestDigest!==manifest.manifestDigest)fail('MANIFEST_MISMATCH','Review must reference the current result digest');
    if(command==='results.ack'){if(task.ownerId){const meta=this.manager.store.getMetadata();const owner=meta.owners.find(o=>o.id===task.ownerId)!;const message=owner.messages?.find(m=>m.taskId===task.id&&m.manifestDigest===manifest.manifestDigest);if(message){const ack=this.ownerHost.acknowledge(owner.id,message.id);owner.messages=owner.messages!.map(m=>m.id===ack.id?ack:m);this.manager.store.setMetadata(meta);}}task.acknowledged=true;event(task,'lifecycle','Result receipt acknowledged; acceptance unchanged');}
    else {if(task.status!=='completed')fail('INVALID_STATE','Only successful executions can be reviewed');if(!['accepted','rejected'].includes(String(a.decision)))fail('INVALID_REQUEST','Decision must be accepted or rejected');task.reviewState=a.decision as 'accepted'|'rejected';task.reviewComment=text(a.comment??'','comment',4000,true);event(task,'lifecycle',`Owner review: ${task.reviewState}`);}
    task.ownerLastActivityAt=new Date().toISOString();this.put(task);return this.manifest(task);
   }
   case 'operations.get':{const id=text(a.commandId,'commandId',120);const receipt=this.manager.store.getMetadata().receipts[`local-demo:${id}`];if(!receipt)fail('NOT_FOUND','Command receipt not found');return {commandId:id,state:receipt!.response?'settled':'indeterminate',response:receipt!.response};}
   default:return fail('COMMAND_UNKNOWN','Unknown logical command');
  }
 }
}
