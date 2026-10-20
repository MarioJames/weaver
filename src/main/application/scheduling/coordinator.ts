import type { Task } from '../../../shared/contracts/tasks';
import { event, slotGroupCount, slotGroupFor } from '../../domain/tasks';
import type { TaskManager } from '../../manager';
import { VENDOR_BLOCK_SOURCE } from '../../policy/routing';
import { previewRoute } from '../../policy/preview';
import type { PolicyStore } from '../../policy/store';
import { redactContext } from '../../redact-context';
import { assertFrozenWorkspace, workspaceIdentity } from '../../workspace';
import { terminal, type TaskRecords } from '../tasks/records';
import type { Dispatcher } from './dispatch';

/** Admits queued work as capacity and policy allow: the one place that starts scheduled tasks. */
export class Coordinator {
 private pumping=false;
 private pumpDirty=false;
 private pumpScheduled?:NodeJS.Immediate;
 private delivered=new Map<string,string>();
 constructor(private readonly manager:TaskManager,private readonly policy:PolicyStore,private readonly records:TaskRecords,
  private readonly dispatch:Pick<Dispatcher,'routeOf'|'decideExecution'|'capacityWait'>,private readonly applyVendorBlocks:()=>void,
  private readonly deliver:(taskId:string)=>void,private readonly isDraining:()=>boolean){}
 private queueBlocked(task:Task, code:NonNullable<Task['queueReason']>['code'], message:string):void {
  const bounded=redactContext(message,700);
  if(task.queueReason?.code===code&&task.queueReason.message===bounded)return;
  task.queueReason={code,message:bounded};this.records.put(task);
 }
 pump():void {
  if(this.isDraining())return;
  this.pumpDirty=true;
  if(this.pumping||this.pumpScheduled)return;
  this.pumpScheduled=setImmediate(()=>{this.pumpScheduled=undefined;if(this.isDraining())return;this.pumpDirty=false;this.runPump();});
 }
 /** Cancels the scheduled pump; drain calls it so no new admission starts during shutdown. */
 stop():void {clearImmediate(this.pumpScheduled);this.pumpScheduled=undefined;}
 private runPump():void {
  this.pumping=true;
  try{this.applyVendorBlocks();for(const head of this.manager.store.listHeads().reverse()){
   const task=head.status==='queued'&&head.scheduled?this.manager.store.get(head.id):head;
   if(terminal(task)&&task.ownerId&&this.manager.store.getOwner(task.ownerId)?.mode==='mock'&&this.delivered.get(task.id)!==task.updatedAt){
    try{this.deliver(task.id);this.delivered.set(task.id,task.updatedAt);}catch{/* An unavailable host may recover on a later notification. */}
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
      const reroute=this.dispatch.routeOf(frozen.owner,slotGroupCount(this.manager.store.listHeads(),slotGroupFor(task.ownerId,frozen.owner)),engineBlocked?[frozen.engine]:[],undefined,workerBlocked?[frozen.worker]:[]);
      const decision=this.dispatch.decideExecution(reroute.engine,undefined,{...task,workspace:frozen.workspace??task.workspace},this.policy.snapshot().config.owners[reroute.owner]?.engine);
      task.dispatch={...frozen,worker:reroute.worker,engine:reroute.engine,model:reroute.model,effort:reroute.effort,execution:decision.execution,adapter:decision.adapter,engineKind:decision.engineKind,maxParallel:reroute.maxParallel,...(decision.workspace?{workspace:decision.workspace,workspaceIdentity:workspaceIdentity(decision.workspace)}:{})};
      event(task,'lifecycle',`Vendor limit rerouted queued worker to ${reroute.engine} (${reroute.worker})`);this.records.put(task);this.pump();continue;
    }

    const running=slotGroupCount(this.manager.store.listHeads(),slotGroupFor(task.ownerId,frozen.owner));
    const live=this.policy.snapshot();
    const route=previewRoute(live.config,live.blocks,Date.now(),{owner:frozen.owner,worker:frozen.worker,runningCount:running});
    const kind=live.config.engines[route.engine]?.kind;
    if(route.worker!==frozen.worker||route.engine!==frozen.engine||route.model!==frozen.model||route.effort!==frozen.effort||(frozen.engineKind!==undefined&&kind!==frozen.engineKind)){
     this.queueBlocked(task,'frozen_route_changed','Current worker engine, kind, model or effort no longer matches the frozen dispatch; restore the route or cancel and create a new task.');continue;
    }
    if(!route.capacityAvailable){this.queueBlocked(task,'waiting_for_capacity',this.dispatch.capacityWait(frozen.owner,task.ownerId,route.maxParallel));continue;}
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
}
