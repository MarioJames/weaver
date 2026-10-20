import { randomUUID } from 'node:crypto';
import type { LogicalOwner } from '../../../shared/contracts/owners';
import type { Task, WorkPackage } from '../../../shared/contracts/tasks';
import { PENDING_TASK_TITLE, object, parseId, parseTaskInput, parseWorkerRecord, text } from '../../../shared/validation';
import { event } from '../../domain/tasks';
import type { TaskManager } from '../../manager';
import { CommandError, fail } from '../commands/errors';
import type { CommandArgs } from '../commands/types';
import { publicTask, terminal, type TaskRecords } from './records';

/** Task state changes an owner or worker asks for: create, describe, freeze a package, report, complete and cancel. */
export class Mutations {
 constructor(private readonly manager:TaskManager,private readonly records:TaskRecords,
  private readonly spawnOwner:(a:CommandArgs)=>LogicalOwner,private readonly closeCancelledRoot:(task:Task)=>void){}
 /** Share native report validation between owner roots and native child workers. */
 completeReport(task:Task,a:Record<string,unknown>):unknown {
    if(task.status!=='running'||task.run?.execution!=='native')fail('INVALID_STATE','Only a running native task accepts workers complete');
    if(a.outcome!=='completed'&&a.outcome!=='failed')fail('INVALID_REQUEST','outcome must be completed or failed');
    const summary=text(a.summary,'summary',8000);
    if(a.artifacts!==undefined&&(!Array.isArray(a.artifacts)||a.artifacts.length>20))fail('INVALID_REQUEST','artifacts must be an array of at most 20 files');
    const artifacts=((a.artifacts as unknown[]|undefined)??[]).map(item=>{const record=parseWorkerRecord({...object(item),type:'artifact'});if(record.type!=='artifact')throw new CommandError('INVALID_REQUEST','Invalid artifact');return {name:record.name,mediaType:record.mediaType,content:record.content};});
    if(task.artifacts.length+artifacts.length>20)fail('RESOURCE_LIMIT','Task exceeds 20 artifacts');
    return publicTask(this.manager.completeNative(task.id,{outcome:a.outcome as 'completed'|'failed',summary,artifacts}));
 }
 create(a:CommandArgs):unknown{return this.manager.store.transaction(()=>{
    let owner:LogicalOwner|undefined;let input;let parent:Task|undefined;
    if(a.parentTaskId!==undefined){parent=this.manager.store.get(parseId(a.parentTaskId));if(parent.executionRole!=='owner'||parent.status!=='running')fail('INVALID_STATE','Parent must be a running owner root');if(parent.title===PENDING_TASK_TITLE||!parent.acceptanceCriteria?.length)fail('INVALID_STATE','Describe the root before creating children');if(a.ownerProfileId!==undefined||(a.ownerId!==undefined&&a.ownerId!==parent.ownerId))fail('INVALID_REQUEST','Child must use its root owner instance');a={...a,ownerId:parent.ownerId,workspace:a.workspace??parent.workspace,constraints:a.constraints??parent.constraints};}
    if(a.ownerProfileId!==undefined){parseTaskInput({...a,instruction:a.instruction??a.goal,owner:{name:'validation',transport:'herdr-visible',session:'unverified',pane:'unverified'}});if(a.ownerId!==undefined)fail('INVALID_REQUEST','Choose ownerId or ownerProfileId');owner=this.spawnOwner({profileId:a.ownerProfileId,name:a.ownerName??'Task owner',provider:a.ownerProvider}) as LogicalOwner;}
    if(a.ownerId!==undefined||owner){owner??=this.records.owner(a.ownerId);input=parseTaskInput({...a,title:a.title,instruction:a.instruction??a.goal,owner:{name:owner.name,transport:'herdr-visible',session:'unverified',pane:'unverified'}});}else input=parseTaskInput(a);
    const task=this.manager.create(input);if(parent)task.parentTaskId=parent.id;if(owner){task.ownerId=owner.id;task.ownerEpoch=0;task.ownerLastActivityAt=new Date().toISOString();task.continuationPolicy={idleRotationMinutes:60};this.records.put(task);}return publicTask(task);
   });}
 complete(a:CommandArgs):unknown{const task=this.records.task(a);this.records.revise(task,a);if(task.executionRole!=='owner')fail('INVALID_STATE','Only an owner root accepts tasks complete');if(a.outcome==='completed'){if(task.title===PENDING_TASK_TITLE||!task.acceptanceCriteria?.length)fail('INVALID_STATE','Describe root title and acceptance criteria before completion');const children=this.manager.store.listHeads().filter(t=>t.parentTaskId===task.id);if(children.length===0)fail('INVALID_STATE','The parent Agent must not implement itself: dispatch at least one subtask before completing the root');const leaves=children.filter(t=>!children.some(retry=>retry.retryOf===t.id));if(leaves.length===0)fail('INVALID_STATE','At least one final subtask is required; retried tasks stay history, completion reads the final leaf');if(leaves.some(t=>t.status!=='completed'||t.reviewState!=='accepted'))fail('INVALID_STATE','Every final child task must complete and pass owner review');}return this.completeReport(task,a);}
 describe(a:CommandArgs):unknown{
    const task=this.records.task(a);
    if(!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');
    this.records.revise(task,a);
    if((task.status!=='queued'&&!(task.executionRole==='owner'&&task.status==='running'))||task.packageId||task.dispatch||task.scheduled)fail('INVALID_STATE','Only an unfrozen queued task or running owner root can be described');
    if(task.executionRole==='owner'&&this.manager.store.listHeads().some(t=>t.parentTaskId===task.id))fail('INVALID_STATE','Root description is frozen after creating children');
    const title=text(a.title,'title',160).trim();
    if(title===PENDING_TASK_TITLE)fail('INVALID_REQUEST','Generate a concrete task title');
    if(!Array.isArray(a.acceptanceCriteria)||a.acceptanceCriteria.length<1||a.acceptanceCriteria.length>30)fail('INVALID_REQUEST','Provide 1–30 acceptance criteria');
    const criteria=(a.acceptanceCriteria as unknown[]).map(value=>text(value,'acceptance criterion',1000).trim());
    task.title=title;task.acceptanceCriteria=criteria;
    event(task,'lifecycle','Owner generated task title and acceptance criteria');this.records.put(task);return publicTask(task);
   }
 packagesCreate(a:CommandArgs):unknown{
    const task=this.records.task(a);if(task.executionRole==='owner')fail('INVALID_STATE','Freeze packages on child tasks, not the owner root');if(task.title===PENDING_TASK_TITLE)fail('INVALID_STATE','Owner must describe the task before freezing a package');this.records.revise(task,a);if(task.status!=='queued')fail('INVALID_STATE','Only queued tasks accept a work package');if(task.packageId)fail('INVALID_STATE','Task already has a frozen package');
    const strings=(v:unknown,label:string)=>{if(!Array.isArray(v)||v.length<1||v.length>30)fail('INVALID_REQUEST',`Provide 1–30 ${label}`);return (v as unknown[]).map(x=>text(x,label,1000));};
    const pkg:WorkPackage={id:randomUUID(),taskId:task.id,revision:1,instruction:task.instruction,scope:strings(a.scope,'scope entries'),acceptanceCriteria:a.acceptanceCriteria===undefined?strings(task.acceptanceCriteria,'acceptance criteria (set on the task, or pass acceptanceCriteria explicitly)'):strings(a.acceptanceCriteria,'acceptance criteria'),createdAt:new Date().toISOString()};
    this.manager.store.transaction(()=>{this.manager.store.putPackage(pkg);task.packageId=pkg.id;event(task,'lifecycle','Frozen work package created');this.records.put(task);});return pkg;
   }
 workersComplete(a:CommandArgs):unknown{const task=this.records.task(a);this.records.revise(task,a);if(task.executionRole==='owner')fail('INVALID_STATE','Report owner roots with tasks complete');return this.completeReport(task,a);}
 cancel(a:CommandArgs):unknown{const task=this.records.task(a);this.records.revise(task,a);if(terminal(task))return {task:publicTask(task),alreadyTerminal:true};if(task.executionRole==='owner')for(const child of this.manager.store.listHeads().filter(t=>t.parentTaskId===task.id&&!terminal(t)))this.manager.cancel(child.id);const cancelled=this.manager.cancel(task.id);if(task.executionRole==='owner'&&cancelled.ownerHost)this.closeCancelledRoot(cancelled);return publicTask(cancelled);}
}
