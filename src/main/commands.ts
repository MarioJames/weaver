import { createHash, randomUUID } from 'node:crypto';
import { API_VERSION, type CommandResponse, type LogicalOwner, type WorkPackage } from '../shared/commands';
import type { Task } from '../shared/types';
import { object, parseId, parseTaskInput, text } from '../shared/validation';
import { TaskManager } from './manager';
import { event } from './store';
import { ContinuationService, ContinuationError, redactContext } from './continuation';
import { MockOwnerHostAdapter, type OwnerHostEvidence, type OwnerMessage } from './adapters/logical';
import { PolicyStore } from './policy/store';
const writes=new Set(['owners.attach','owners.spawn','owners.switch','owners.continuation.configure','tasks.create','tasks.retry','tasks.cancel','packages.create','workers.spawn','results.deliver','results.ack','reviews.submit']);
class CommandError extends Error {constructor(readonly code:string,message:string){super(message);}}
const fail=(code:string,message:string):never=>{throw new CommandError(code,message);};
function canonical(value:unknown):string {if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;return JSON.stringify(value);}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const terminal=(t:Task)=>['completed','failed','cancelled'].includes(t.status);
/** A single app-owned handler shared by Electron and CLI. The local principal is deliberately
 * trusted-user demo scope, not an impersonation-resistant owner credential or real-agent grant. */
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

 pump():void {
  if(this.pumping||this.draining)return;this.pumping=true;
  try{for(const task of this.manager.store.list().reverse()){if(terminal(task)&&task.ownerId){try{this.execute('results.deliver',{taskId:task.id});}catch{/* Manual attachments have no delivery transport. */}}if(task.status!=='queued'||!task.scheduled||!task.dispatch)continue;
   try{const running=this.manager.store.list().filter(t=>(t.status==='running'||t.status==='cancelling')&&t.dispatch?.owner===task.dispatch!.owner).length;const route=this.policy.preview({owner:task.dispatch.owner,worker:task.dispatch.worker,runningCount:running});if(!route.capacityAvailable||this.manager.runningCount>=this.manager.maxParallel)continue;task.scheduled=false;this.put(task);this.manager.start(task.id);}catch{/* A changed policy keeps the persisted request queued; no unauthorized fallback. */}
  }}finally{this.pumping=false;}
 }
 private publicTask(task:Task){const {owner,run,...rest}=task;return {...rest,...(run?{run:{id:run.id,adapter:run.adapter,status:run.status,startedAt:run.startedAt,endedAt:run.endedAt,exitCode:run.exitCode}}:{})};}
 private manifest(task:Task){if(!terminal(task))fail('RESULT_NOT_READY','Execution has not reached a terminal state');const manifest={taskId:task.id,attemptId:task.run?.id??null,packageId:task.packageId??null,execution:task.status,summary:task.summary??null,artifacts:task.artifacts.map(a=>({id:a.id,name:a.name,mediaType:a.mediaType,sha256:createHash('sha256').update(a.content).digest('hex')})),exitCode:task.run?.exitCode??null};return {...manifest,manifestDigest:digest(manifest),delivery:task.acknowledged?'acknowledged':'pending',acceptance:task.reviewState??'pending'};}
 private execute(command:string,a:Record<string,unknown>):unknown {
  switch(command){
   case 'sync.snapshot':return {revision:this.manager.store.revision,tasks:this.manager.store.list().map(t=>({id:t.id,title:t.title,status:t.status,revision:t.revision??0,ownerId:t.ownerId,updatedAt:t.updatedAt,reviewState:t.reviewState??'pending'})),owners:this.manager.store.getMetadata().owners.map(o=>({id:o.id,name:o.name,profileId:o.profileId,mode:o.mode,state:o.state}))};
   case 'sync.status':return {revision:this.manager.store.revision,changed:a.after!==this.manager.store.revision,recovery:'refresh sync.snapshot; push invalidation is not a durable event stream'};
   case 'capabilities.get':return {apiVersion:API_VERSION,cliTransport:this.transportStatus,authentication:'ephemeral-local-trusted-user-demo',ownerScopedAuthorization:false,ownerSpawn:'mock-only',manualAttach:'metadata-only',workerProviders:['mock-jsonl'],realExecution:false,mcp:false,maxParallel:this.manager.maxParallel,policyAdmission:true,commands:['capabilities.get','sync.snapshot','sync.status','owners.list','owners.get','owners.continuation.get',...writes,'tasks.get','tasks.list','tasks.events','tasks.results','artifacts.read','packages.get','operations.get','observability.get','observability.export'],limits:{tasks:200,owners:200,packages:1000,receipts:5000,eventsPerPage:100},durability:'durable intent before effect; interrupted commands require reconciliation, not automatic replay'};
   case 'owners.continuation.get':return this.continuation.get(parseId(a.taskId));
   case 'owners.continuation.configure':{if(!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');return this.continuation.configure(parseId(a.taskId),a.expectedRevision as number,a.idleRotationMinutes as number|null);}
   case 'owners.switch':{if(!Number.isSafeInteger(a.expectedRevision)||(a.expectedEpoch!==undefined&&!Number.isSafeInteger(a.expectedEpoch)))fail('INVALID_REQUEST','Revision and epoch must be integers');if(a.reason!==undefined&&a.reason!=='manual'&&a.reason!=='idle')fail('INVALID_REQUEST','Invalid switch reason');const task=this.task(a);const owner=this.owner(task.ownerId);const profile=text(a.profileId??owner.profileId,'profileId',120);if(this.policy.snapshot().owners[profile]?.status!=='available')fail('POLICY_DENIED','Target owner profile unavailable');return this.continuation.rotate(task.id,Number(a.expectedRevision),a.reason==='idle'?'idle':'manual',a.expectedEpoch===undefined?undefined:Number(a.expectedEpoch),profile);}
   case 'owners.list':return {owners:this.manager.store.getMetadata().owners};
   case 'owners.get':return this.owner(a.ownerId);
   case 'owners.attach':case 'owners.spawn':{
    const mode=command==='owners.spawn'?'mock':'manual';if(a.provider!==undefined&&a.provider!=='mock')fail('CAPABILITY_UNAVAILABLE','Only the in-process mock owner host is enabled');
    const profileId=text(a.profileId,'profileId',120);const snapshot=this.policy.snapshot();if(snapshot.owners[profileId]?.status!=='available')fail('POLICY_DENIED','Owner profile is unavailable');
    const meta=this.manager.store.getMetadata();if(meta.owners.length>=200)fail('RESOURCE_LIMIT','Owner limit reached');
    const owner:LogicalOwner={id:randomUUID(),name:text(a.name,'name',120),profileId,mode,state:mode==='mock'?'ready':'attached',createdAt:new Date().toISOString()};owner.host=mode==='mock'?this.ownerHost.spawn({ownerId:owner.id,name:owner.name,profileId}):this.ownerHost.attach({ownerId:owner.id,name:owner.name,profileId,session:'manual-reference',pane:'unverified'});meta.owners.push(owner);this.manager.store.setMetadata(meta);return owner;
   }
   case 'tasks.create':return this.manager.store.transaction(()=>{
    let owner:LogicalOwner|undefined;let input;
    if(a.ownerProfileId!==undefined){parseTaskInput({...a,instruction:a.instruction??a.goal,owner:{name:'validation',transport:'herdr-visible',session:'logical',pane:'logical'}});if(this.manager.store.list().length>=200)fail('RESOURCE_LIMIT','Task limit reached');if(a.ownerId!==undefined)fail('INVALID_REQUEST','Choose ownerId or ownerProfileId');owner=this.execute('owners.spawn',{profileId:a.ownerProfileId,name:a.ownerName??'Task owner',provider:a.ownerProvider??'mock'}) as LogicalOwner;}
    if(a.ownerId!==undefined||owner){owner??=this.owner(a.ownerId);input=parseTaskInput({...a,title:a.title,instruction:a.instruction??a.goal,owner:{name:owner.name,transport:'herdr-visible',session:'logical-owner',pane:'manual-or-mock'}});}else input=parseTaskInput(a);
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
    if(a.provider!==undefined&&a.provider!=='mock-jsonl')fail('CAPABILITY_UNAVAILABLE','Real worker providers are not enabled');
    if(a.packageId!==undefined&&a.packageId!==task.packageId)fail('REVISION_CONFLICT','Package does not belong to task');
    const logical=task.ownerId?this.owner(task.ownerId):undefined;
    const owner=text(a.owner??logical?.profileId??Object.keys(this.policy.snapshot().config.owners)[0],'owner profile',120);
    if(logical&&owner!==logical.profileId)fail('POLICY_DENIED','Task owner profile cannot be changed at dispatch');
    const running=this.manager.store.list().filter(t=>(t.status==='running'||t.status==='cancelling')&&t.dispatch?.owner===owner).length;
    const route=this.policy.preview({owner,...(a.worker!==undefined?{worker:a.worker}:{class:a.class??'routine'}),...(a.tag!==undefined?{tag:a.tag}:{}),runningCount:running});
    if(task.scheduled)fail('INVALID_STATE','Task already scheduled');
    this.prepareOwnerActivity(command,a);task=this.task(a);
    if(!task.packageId){const pkg:WorkPackage={id:randomUUID(),taskId:task.id,revision:1,instruction:task.instruction,scope:[task.workspace??'Bundled mock fixture only'],acceptanceCriteria:task.acceptanceCriteria?.length?task.acceptanceCriteria:['Mock output returned for owner review'],createdAt:new Date().toISOString()};const meta=this.manager.store.getMetadata();if(meta.packages.length>=1000)fail('RESOURCE_LIMIT','Package limit reached');meta.packages.push(pkg);this.manager.store.transaction(()=>{this.manager.store.setMetadata(meta);task.packageId=pkg.id;this.put(task);});}
    task.dispatch={owner:route.owner,worker:route.worker,engine:route.engine,model:route.model,effort:route.effort,execution:'mock',maxParallel:route.maxParallel};event(task,'lifecycle',`Policy selected ${route.worker}; executing bundled mock only (no provider connection)`);if(!route.capacityAvailable||this.manager.runningCount>=this.manager.maxParallel){task.scheduled=true;event(task,'lifecycle','Dispatch admitted to queue; waiting for an execution slot');this.put(task);return this.publicTask(task);}this.put(task);return this.publicTask(this.manager.start(task.id));
   }
   case 'tasks.cancel':{const task=this.task(a);this.revise(task,a);if(terminal(task))return {task:this.publicTask(task),alreadyTerminal:true};return this.publicTask(this.manager.cancel(task.id));}
   case 'tasks.events':{
    const task=this.task(a);const limit=a.limit??50;if(!Number.isInteger(limit)||Number(limit)<1||Number(limit)>100)fail('INVALID_REQUEST','Event limit must be 1–100');let start=0;
    if(a.after!==undefined){const i=task.events.findIndex(e=>e.id===a.after);if(i<0)fail('CURSOR_EXPIRED','Cursor not retained; refresh task snapshot');start=i+1;}
    const events=task.events.slice(start,start+Number(limit));return {events,nextCursor:events.at(-1)?.id??a.after??null,hasMore:start+events.length<task.events.length};
   }
   case 'observability.get':case 'observability.export':{
    const task=this.task(a);const redact=(value:string)=>redactContext(value,40000);
    const trace={taskId:task.id,ownerId:task.ownerId??null,packageId:task.packageId??null,attemptId:task.run?.id??null,revision:task.revision??0,execution:task.status,stage:task.scheduled?'waiting_for_capacity':task.status==='completed'?(task.reviewState==='accepted'?'accepted':'awaiting_review'):task.status,lastActivityAt:task.updatedAt,retryOf:task.retryOf??null,route:task.dispatch??null,artifacts:task.artifacts.map(v=>({id:v.id,name:redact(v.name)})),events:task.events.filter(e=>a.kind===undefined||e.kind===a.kind).map(e=>({...e,message:redact(e.message)})),metrics:{tokens:null,cost:null,contextUsage:null,source:'not reported by mock provider'},redaction:'best-effort pattern redaction; inspect before sharing'};return command==='observability.export'?{mediaType:'application/json',name:`weaver-trace-${task.id}.json`,content:JSON.stringify(trace,null,2)}:trace;
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
