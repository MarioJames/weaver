import { randomUUID } from 'node:crypto';
import type { DispatchNext } from '../../../shared/contracts/commands';
import type { RoutePreview } from '../../../shared/contracts/policy';
import type { Task, WorkPackage } from '../../../shared/contracts/tasks';
import { PENDING_TASK_TITLE, text } from '../../../shared/validation';
import { workerInstruction } from '../../adapters/instruction';
import type { ContinuationService } from '../../continuation';
import type { TaskManager } from '../../manager';
import { EXCLUDED_ENGINE_REASON } from '../../policy/routing';
import type { PolicyStore } from '../../policy/store';
import { event, slotGroupCount, slotGroupFor, slotGroupName } from '../../store';
import { absoluteExistingWorkspace, isRealEngineKind, workspaceIdentity } from '../../workspace';
import { fail } from '../commands/errors';
import { publicTask, type TaskRecords } from '../tasks/records';
import { chainEngines } from './retry';

/** Running tasks per worker across every owner: the load that weighted dispatch balances. */
export function workerLoad(tasks: Task[]): Record<string, number> {
 const load: Record<string, number> = {};
 for (const task of tasks) if ((task.status === 'running' || task.status === 'cancelling') && task.dispatch?.worker) load[task.dispatch.worker] = (load[task.dispatch.worker] ?? 0) + 1;
 return load;
}
/** Routes, freezes and admits one queued task and hands the owner the single next step. */
export class Dispatcher {
 constructor(private readonly manager:TaskManager,private readonly policy:PolicyStore,private readonly records:TaskRecords,
  private readonly continuation:Pick<ContinuationService,'due'|'rotate'>){}
 private prepareOwnerActivity(command:string,args:Record<string,unknown>):void {
  if(!['workers.spawn','packages.create','results.ack','reviews.submit'].includes(command))return;
  const task=this.records.task(args);this.records.revise(task,args);
  if(!task.ownerId||task.status==='running'||task.status==='cancelling'||task.status==='failed'||task.status==='cancelled'||task.reviewState==='accepted'||task.reviewState==='rejected'||task.scheduled)return;
  const owner=this.records.owner(task.ownerId);if(owner.mode!=='mock'||!this.continuation.due(task.id))return;
  if(this.policy.snapshot().owners[owner.profileId]?.status!=='available')fail('POLICY_DENIED','Owner profile unavailable for continuation');
  this.continuation.rotate(task.id,task.revision??0,'idle',task.ownerEpoch??0);
  if(args.expectedRevision!==undefined)args.expectedRevision=this.manager.store.get(task.id).revision;
 }
 /** Capacity is per owner instance, so a waiting message names the binding whose slots are held. */
 capacityWait(profile:string, ownerId:string|undefined, limit:number):string {
  return `${slotGroupName(this.manager.store.listOwners(),ownerId,profile)} is at its current concurrency limit (${limit}).`;
 }
 /** maxWaitMinutes is frozen for the owner and the UI as their polling bound; Weaver never stops a worker with it. */
 decideExecution(engine:string,provider:unknown,task:Task,ownerEngine?:string,workerProxy?:string,ownerProxy?:string):{execution:'real'|'mock'|'native';adapter:string;maxWaitMinutes:number;workspace?:string;engineKind?:string} {
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
 /** Route one owner's work under the chain's excluded engines, keeping the refusal in the policy's own words. */
 routeOf(owner:string,running:number,excluded:string[],worker?:unknown,excludedWorkers:string[]=[]):RoutePreview {
  try {
   return this.policy.preview({owner,runningCount:running,workerLoad:workerLoad(this.manager.store.listHeads()),...(worker!==undefined?{worker}:{}),...(excluded.length?{excludeEngines:excluded}:{}),...(excludedWorkers.length?{excludeWorkers:excludedWorkers}:{})});
  } catch(error) {
   const message=error instanceof Error?error.message:String(error);
   if(message.startsWith('NO_ALTERNATIVE_ENGINE'))fail('NO_ALTERNATIVE_ENGINE',message);
   throw error;
  }
 }
 /** The single step the owner takes next, so an owner never has to understand engines. */
 nextFor(task:Task):DispatchNext|undefined {
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
  return {...publicTask(task),started:task.dispatch?.execution==='real'?!!task.run?.firstOutputAt:task.status==='running',...(next?{next}:{}),...(excluded.length?{excludedEngines:excluded}:{})};
 }
 /**
  * Route, freeze and admit one queued task, then hand the owner the single next step. workers.spawn calls it
  * directly and tasks.retry calls it for the linked child, so a retry never grows a second launcher.
  * forcedEngines names an engine the chain cannot see yet: the attempt --cancel abandoned but whose worker
  * is still cancelling.
  */
 dispatchTask(command:string,a:Record<string,unknown>,forcedEngines:string[]=[]):unknown {
  let task=this.records.task(a);this.records.revise(task,a);if(task.parentTaskId&&this.manager.store.get(task.parentTaskId).status!=='running')fail('INVALID_STATE','Parent root is no longer running');if(task.executionRole==='owner')fail('INVALID_STATE','Dispatch child tasks, not the owner root');if(task.status!=='queued')fail('INVALID_STATE','Only queued tasks may dispatch');
  if(task.title===PENDING_TASK_TITLE)fail('INVALID_STATE','Owner must generate title and acceptance criteria with tasks.describe before dispatch');
  if(a.provider!==undefined&&a.provider!=='mock-jsonl')fail('CAPABILITY_UNAVAILABLE',`Provider ${String(a.provider)} is not available`);
  if(a.packageId!==undefined&&a.packageId!==task.packageId)fail('REVISION_CONFLICT','Package does not belong to task');
  if(task.scheduled)fail('INVALID_STATE','Task already scheduled');
  const logical=task.ownerId?this.records.owner(task.ownerId):undefined;
  const owner=text(a.owner??logical?.profileId??Object.keys(this.policy.snapshot().config.owners)[0],'owner profile',120);
  if(logical&&owner!==logical.profileId)fail('POLICY_DENIED','Task owner profile cannot be changed at dispatch');
  const excluded=chainEngines(this.manager.store,task);
  for(const engine of forcedEngines)if(!excluded.includes(engine))excluded.push(engine);
  const running=slotGroupCount(this.manager.store.listHeads(),slotGroupFor(task.ownerId,owner));
  const route=this.routeOf(owner,running,excluded,a.worker);
  const decision=this.decideExecution(route.engine,a.provider,task,this.policy.snapshot().config.owners[route.owner]?.engine,route.proxy,this.policy.snapshot().config.owners[route.owner]?.proxy);
  const pendingPackage:WorkPackage=task.packageId?this.manager.store.getPackage(task.packageId!)!:{id:randomUUID(),taskId:task.id,revision:1,instruction:task.instruction,scope:[decision.workspace??task.workspace??'Explicit mock fixture'],acceptanceCriteria:task.acceptanceCriteria?.length?task.acceptanceCriteria:[decision.execution==='mock'?'Mock output returned for owner review':'Provider result returned for owner review'],createdAt:new Date().toISOString()};
  if(!pendingPackage||pendingPackage.taskId!==task.id)fail('INVALID_REQUEST','Frozen work package is missing');
  // Real launch and native handoff freeze the same instruction, so it must fit before any state changes.
  if(decision.execution!=='mock')workerInstruction({...task,workspace:decision.workspace??task.workspace},pendingPackage);
  this.prepareOwnerActivity(command,a);task=this.records.task(a);
  if(decision.workspace)task.workspace=decision.workspace;
  if(!task.packageId){this.manager.store.transaction(()=>{this.manager.store.putPackage(pendingPackage);task.packageId=pendingPackage.id;this.records.put(task);});}
  task.dispatch={owner:route.owner,worker:route.worker,engine:route.engine,model:route.model,effort:route.effort,proxy:route.proxy,execution:decision.execution,maxParallel:route.maxParallel,maxWaitMinutes:decision.maxWaitMinutes,adapter:decision.adapter,...(decision.workspace?{workspace:decision.workspace,...(decision.execution==='real'?{workspaceIdentity:workspaceIdentity(decision.workspace)}:{})}:{}),...(decision.engineKind?{engineKind:decision.engineKind}:{})};
  const selected=decision.execution==='real'?`Policy selected ${route.worker}; launching ${decision.engineKind} in ${decision.workspace}`:decision.execution==='native'?`Policy selected ${route.worker} on the owner's engine; the owner runs it with its built-in subagent tool (${route.model}, ${route.effort})`:`Policy selected ${route.worker}; explicit mock-jsonl provider`;
  event(task,'lifecycle',`${selected}${excluded.length?`; engines excluded because they ${EXCLUDED_ENGINE_REASON}: ${excluded.join(', ')}`:''}`);
  if(!route.capacityAvailable){task.scheduled=true;task.queueReason={code:'waiting_for_capacity',message:this.capacityWait(route.owner,task.ownerId,route.maxParallel)};event(task,'lifecycle','Dispatch admitted to queue; waiting for an execution slot');this.records.put(task);return this.dispatchResponse(task,excluded);}this.records.put(task);return this.dispatchResponse(this.manager.start(task.id,route.maxParallel),excluded);
 }
}
