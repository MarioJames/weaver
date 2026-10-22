import { randomUUID } from 'node:crypto';
import type { LogicalOwner } from '../../../shared/contracts/owners';
import type { Task, WorkPackage } from '../../../shared/contracts/tasks';
import { PENDING_TASK_TITLE, object, parseId, parseTaskInput, parseWorkerRecord, text } from '../../../shared/validation';
import { event } from '../../domain/tasks';
import type { TaskManager } from '../../manager';
import type { PolicyStore } from '../../policy/store';
import { CommandError, fail } from '../commands/errors';
import type { CommandArgs } from '../commands/types';
import { publicTask, terminal, type TaskRecords } from './records';

/** Task state changes an owner or worker asks for: create, describe, freeze a package, report, complete and cancel. */
export class Mutations {
 constructor(private readonly manager:TaskManager,private readonly records:TaskRecords,private readonly policy:PolicyStore,
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
    if(a.parentTaskId!==undefined){parent=this.manager.store.get(parseId(a.parentTaskId,'parent task ID'));if(parent.executionRole!=='owner'||parent.status!=='running')fail('INVALID_STATE','Parent must be a running owner root');if(parent.title===PENDING_TASK_TITLE||!parent.acceptanceCriteria?.length)fail('INVALID_STATE','Describe the root before creating children');if(a.ownerProfileId!==undefined||(a.ownerId!==undefined&&a.ownerId!==parent.ownerId))fail('INVALID_REQUEST','Child must use its root owner instance');a={...a,ownerId:parent.ownerId,workspace:a.workspace??parent.workspace,constraints:a.constraints??parent.constraints};}
    if(a.ownerProfileId!==undefined){parseTaskInput({...a,instruction:a.instruction??a.goal,owner:{name:'validation',transport:'herdr-visible',session:'unverified',pane:'unverified'}});if(a.ownerId!==undefined)fail('INVALID_REQUEST','Choose ownerId or ownerProfileId');owner=this.spawnOwner({profileId:a.ownerProfileId,name:a.ownerName??'Task owner',provider:a.ownerProvider}) as LogicalOwner;}
    if(a.ownerId!==undefined||owner){owner??=this.records.owner(a.ownerId);input=parseTaskInput({...a,title:a.title,instruction:a.instruction??a.goal,owner:{name:owner.name,transport:'herdr-visible',session:'unverified',pane:'unverified'}});}else input=parseTaskInput(a);
    const task=this.manager.create(input);if(parent)task.parentTaskId=parent.id;if(owner){task.ownerId=owner.id;task.ownerEpoch=0;task.ownerLastActivityAt=new Date().toISOString();task.continuationPolicy={idleRotationMinutes:60};this.records.put(task);}return publicTask(task);
   });}
  complete(a:CommandArgs):unknown{const task=this.records.task(a);this.records.revise(task,a);if(task.executionRole!=='owner')fail('INVALID_STATE','Only an owner root accepts tasks complete');if(a.outcome==='completed'){if(task.title===PENDING_TASK_TITLE||!task.acceptanceCriteria?.length)fail('INVALID_STATE','Describe root title and acceptance criteria before completion');const children=this.manager.store.listHeads().filter(t=>t.parentTaskId===task.id);if(children.length===0)fail('INVALID_STATE','The parent Agent must not implement itself: dispatch at least one subtask before completing the root');const leaves=children.filter(t=>!children.some(retry=>retry.retryOf===t.id));if(leaves.length===0)fail('INVALID_STATE','At least one final subtask is required; retried tasks stay history, completion reads the final leaf');const superseded=(leaf:Task)=>leaf.status==='cancelled'&&typeof leaf.supersededBy==='string'&&children.some(sibling=>sibling.id===leaf.supersededBy);const remaining=leaves.filter(leaf=>!superseded(leaf));if(remaining.length===0)fail('INVALID_STATE',`All ${leaves.length} final subtask(s) were superseded by a design change (${leaves.map(t=>t.id.slice(0,8)).join(', ')}); at least one non-superseded final subtask is required`);const blockers=remaining.filter(t=>t.status!=='completed'||t.reviewState!=='accepted');if(blockers.length>0){const describe=(t:Task)=>t.status==='cancelled'?'cancelled without a recorded supersede target':t.status!=='completed'?`not completed (status ${t.status})`:`not accepted (review ${t.reviewState??'pending'})`;fail('INVALID_STATE',`Blocked final subtasks: ${blockers.map(t=>`${t.id.slice(0,8)}: ${describe(t)}`).join('; ')}`);}}return this.completeReport(task,a);}
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
 update(a:CommandArgs):unknown{return this.manager.store.transaction(()=>{
    const task=this.records.task(a);
    if(!Number.isSafeInteger(a.expectedRevision))fail('INVALID_REQUEST','expectedRevision must be an integer');
    if(task.parentTaskId||task.status!=='queued'||task.executionRole==='owner'||task.scheduled||task.packageId||task.dispatch||task.ownerHost)fail('INVALID_STATE','Only an unstarted root task draft can be edited');
    this.records.revise(task,a);
    const instruction=a.instruction??a.goal;
    if(instruction!==undefined)task.instruction=text(instruction,'instruction',16000);
    if(a.workspace===null)delete task.workspace;
    else if(a.workspace!==undefined){const workspace=text(a.workspace,'workspace',2000);if(!workspace.startsWith('/'))fail('INVALID_REQUEST','workspace must be an absolute path');task.workspace=workspace;}
    if(a.acceptanceCriteria!==undefined){if(!Array.isArray(a.acceptanceCriteria)||a.acceptanceCriteria.length>30)fail('INVALID_REQUEST','acceptanceCriteria must be an array of at most 30 items');task.acceptanceCriteria=(a.acceptanceCriteria as unknown[]).length?(a.acceptanceCriteria as unknown[]).map(value=>text(value,'acceptance criterion',1000).trim()):undefined;}
    if(a.ownerProfileId!==undefined){
     const profileId=text(a.ownerProfileId,'ownerProfileId',120);
     if(!this.policy.snapshot().config.owners[profileId])fail('INVALID_REQUEST',`Owner profile ${profileId} is missing from the policy`);
     if(this.records.owner(task.ownerId).profileId!==profileId){const spawned=this.spawnOwner({profileId,name:'Task owner'}) as LogicalOwner;task.ownerId=spawned.id;task.ownerEpoch=0;task.ownerLastActivityAt=new Date().toISOString();}
    }
    event(task,'lifecycle','Draft edited before start');this.records.put(task);return publicTask(task);
   });}
 packagesCreate(a:CommandArgs):unknown{
    const task=this.records.task(a);if(task.executionRole==='owner')fail('INVALID_STATE','Freeze packages on child tasks, not the owner root');if(task.title===PENDING_TASK_TITLE)fail('INVALID_STATE','Owner must describe the task before freezing a package');this.records.revise(task,a);if(task.status!=='queued')fail('INVALID_STATE','Only queued tasks accept a work package');if(task.packageId)fail('INVALID_STATE','Task already has a frozen package');
    const strings=(v:unknown,label:string)=>{if(!Array.isArray(v)||v.length<1||v.length>30)fail('INVALID_REQUEST',`Provide 1–30 ${label}`);return (v as unknown[]).map(x=>text(x,label,1000));};
    const pkg:WorkPackage={id:randomUUID(),taskId:task.id,revision:1,instruction:task.instruction,scope:strings(a.scope,'scope entries'),acceptanceCriteria:a.acceptanceCriteria===undefined?strings(task.acceptanceCriteria,'acceptance criteria (set on the task, or pass acceptanceCriteria explicitly)'):strings(a.acceptanceCriteria,'acceptance criteria'),createdAt:new Date().toISOString()};
    this.manager.store.transaction(()=>{this.manager.store.putPackage(pkg);task.packageId=pkg.id;event(task,'lifecycle','Frozen work package created');this.records.put(task);});return pkg;
   }
 workersComplete(a:CommandArgs):unknown{const task=this.records.task(a);this.records.revise(task,a);if(task.executionRole==='owner')fail('INVALID_STATE','Report owner roots with tasks complete');return this.completeReport(task,a);}
  cancel(a:CommandArgs):unknown{
   const task=this.records.task(a);this.records.revise(task,a);
   if(a.supersededBy===undefined){if(terminal(task))return {task:publicTask(task),alreadyTerminal:true};if(task.executionRole==='owner')for(const child of this.manager.store.listHeads().filter(t=>t.parentTaskId===task.id&&!terminal(t)))this.manager.cancel(child.id);const cancelled=this.manager.cancel(task.id);if(task.executionRole==='owner'&&cancelled.ownerHost)this.closeCancelledRoot(cancelled);return publicTask(cancelled);}
   // Design-change replacement: every refusal happens before any state changes.
   if(a.reason===undefined)fail('INVALID_REQUEST','reason (1–500 characters) is required when supersededBy is provided');
   const reason=text(a.reason,'reason',500);
   const targetId=parseId(a.supersededBy,'supersededBy task ID');
   let target:Task;
   try{target=this.manager.store.get(targetId);}catch{return fail('INVALID_REQUEST','Superseded task not found');}
   if(task.status==='completed'||task.status==='failed')fail('INVALID_STATE','Completed or failed tasks cannot record supersededBy; only in-flight or already-cancelled tasks accept a replacement');
   if(!task.parentTaskId)fail('INVALID_STATE','Only a child task of a running owner root can record supersededBy');
   if(target.id===task.id)fail('INVALID_REQUEST','A task cannot be superseded by itself');
   if(target.parentTaskId!==task.parentTaskId)fail('INVALID_REQUEST','The superseding task must be another child of the same parent');
   let cursor:Task|undefined=target;const seen=new Set<string>();
   while(cursor?.retryOf&&!seen.has(cursor.id)){seen.add(cursor.id);if(cursor.retryOf===task.id)fail('INVALID_STATE','A task cannot be superseded by its own retry descendant');try{cursor=this.manager.store.get(cursor.retryOf);}catch{break;}}
   const mark=(current:Task)=>{current.supersededBy=target.id;current.supersededReason=reason;event(current,'lifecycle',`Superseded by ${target.id.slice(0,8)}: ${reason}`);this.records.put(current);return publicTask(current);};
   if(terminal(task))return mark(task);
   return mark(this.manager.cancel(task.id));
  }
}
