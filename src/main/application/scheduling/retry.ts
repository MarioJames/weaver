import { randomUUID } from 'node:crypto';
import type { Task, WorkPackage } from '../../../shared/contracts/tasks';
import { workerInstruction } from '../../adapters/instruction';
import type { TaskManager } from '../../manager';
import type { PolicyStore } from '../../policy/store';
import { event, slotGroupCount, slotGroupFor } from '../../store';
import { fail } from '../commands/errors';
import { terminal, vendorLimited, type TaskRecords } from '../tasks/records';
import type { Dispatcher } from './dispatch';

 /** Engines of every earlier attempt in this task's retry chain that failed, cancelled or is still cancelling: a retry never returns to one. */
export function chainEngines(store:TaskManager['store'],task:Task):string[] {
  const engines:string[]=[];const seen=new Set<string>([task.id]);let id=task.retryOf;
  while(id&&!seen.has(id)){
   seen.add(id);
   let previous:Task;
   try{previous=store.get(id);}catch{break;}
   const engine=previous.dispatch?.engine;
   // A rate-limited attempt is already out through its worker's block; only the other failures put the engine in doubt.
   if(engine&&!vendorLimited(previous)&&(previous.status==='failed'||previous.status==='cancelled'||previous.status==='cancelling')&&!engines.includes(engine))engines.push(engine);
   id=previous.retryOf;
  }
  return engines;
 }
/** The dispatch steps a retry reuses, so a retry never grows a second launcher. */
type RetryDispatch = Pick<Dispatcher,'routeOf'|'decideExecution'|'dispatchTask'>;
export class Retries {
 constructor(private readonly manager:TaskManager,private readonly policy:PolicyStore,private readonly records:TaskRecords,
  private readonly dispatch:RetryDispatch,private readonly applyVendorBlocks:()=>void){}
 /** What a retry may not route back to: the chain's failures, and the engine of the attempt --cancel abandons
  * even while its worker is still cancelling and holding the slot that made it. */
 private retryEngines(original:Task,cancel:boolean):string[] {
  const excluded=chainEngines(this.manager.store,original);
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
 /**
  * One owner action that runs a finished attempt again elsewhere and dispatches the linked child in the same call.
  * Every refusal happens before the original is touched, so a retry known to fail leaves the chain exactly as it was;
  * only after that does the original optionally cancel, the child and its frozen copy commit together, and the
  * launch itself happen outside the transaction, where a rollback could not take a started process back.
  */
 retry(a:Record<string,unknown>):unknown {
  if(a.cancel!==undefined&&typeof a.cancel!=='boolean')fail('INVALID_REQUEST','cancel must be a boolean');
  if(a.expectedRevision!==undefined&&!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');
  const original=this.records.task(a);this.records.revise(original,a);
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
  const logical=original.ownerId?this.records.owner(original.ownerId):undefined;
  const owner=logical?.profileId??Object.keys(this.policy.snapshot().config.owners)[0];
  const route=this.dispatch.routeOf(owner,slotGroupCount(this.manager.store.listHeads(),slotGroupFor(original.ownerId,owner)),excluded);
  // An explicit mock attempt stays a mock; a real one never falls back to a fixture because it failed.
  const provider=original.dispatch?.execution==='mock'?'mock-jsonl':undefined;
  const decision=this.dispatch.decideExecution(route.engine,provider,original,this.policy.snapshot().config.owners[route.owner]?.engine);
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
   this.records.put(task);
   return this.manager.store.get(task.id);
  });
  const linkedFrom=this.manager.store.get(original.id);
  event(linkedFrom,'lifecycle',`Retried as task ${created.id.slice(0,8)}; engines excluded for the chain: ${excluded.length?excluded.join(', '):'none'}`);
  this.records.put(linkedFrom);
  return this.dispatch.dispatchTask('workers.spawn',{taskId:created.id,...(provider?{provider}:{})},excluded);
 }
}
