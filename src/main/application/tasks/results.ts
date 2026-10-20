import { createHash } from 'node:crypto';
import type { Task } from '../../../shared/contracts/tasks';
import { text } from '../../../shared/validation';
import type { MockOwnerHostAdapter } from '../../adapters/logical';
import type { TaskManager } from '../../manager';
import { event } from '../../store';
import { fail } from '../commands/errors';
import type { CommandArgs } from '../commands/types';
import { digest, terminal, type TaskRecords } from './records';

/** The result a finished attempt hands back: its manifest, its delivery to a mock owner, and the owner's receipt and review. */
export class Results {
 constructor(private readonly manager:TaskManager,private readonly records:TaskRecords,
  private readonly ownerHost:Pick<MockOwnerHostAdapter,'deliverResult'|'acknowledge'>){}
 manifest(task:Task){if(!terminal(task))fail('RESULT_NOT_READY','Execution has not reached a terminal state');const manifest={taskId:task.id,attemptId:task.run?.id??null,packageId:task.packageId??null,execution:task.status,summary:task.summary??null,artifacts:task.artifacts.map(a=>({id:a.id,name:a.name,mediaType:a.mediaType,sha256:createHash('sha256').update(a.content).digest('hex')})),exitCode:task.run?.exitCode??null,...(task.failure?{failure:task.failure}:{})};return {...manifest,manifestDigest:digest(manifest),delivery:task.acknowledged?'acknowledged':'pending',acceptance:task.reviewState??'pending'};}
 results(a:CommandArgs):unknown{return this.manifest(this.records.task(a));}
 deliver(a:CommandArgs):unknown{
    const task=this.records.task(a);const manifest=this.manifest(task);if(!task.ownerId)fail('CAPABILITY_UNAVAILABLE','Task has no logical owner');const owner=this.records.owner(task.ownerId);if(owner.mode!=='mock')fail('CAPABILITY_UNAVAILABLE','Manual owner delivery is not connected');
    const existing=(owner.messages??[]).find(m=>m.taskId===task.id&&m.manifestDigest===manifest.manifestDigest);if(existing)return existing;
    const message=this.ownerHost.deliverResult(owner.id,{taskId:task.id,manifestDigest:manifest.manifestDigest});owner.messages=[...(owner.messages??[]),message];this.manager.store.putOwner(owner);return message;
   }
 settle(command:'results.ack'|'reviews.submit',a:CommandArgs):unknown{
    const task=this.records.task(a);if(a.expectedRevision===undefined)fail('INVALID_REQUEST','expectedRevision is required');this.records.revise(task,a);const manifest=this.manifest(task);if(a.manifestDigest!==manifest.manifestDigest)fail('MANIFEST_MISMATCH','Review must reference the current result digest');
    if(command==='results.ack'){if(task.ownerId){const owner=this.manager.store.getOwner(task.ownerId)!;const message=owner.messages?.find(m=>m.taskId===task.id&&m.manifestDigest===manifest.manifestDigest);if(message){const ack=this.ownerHost.acknowledge(owner.id,message.id);owner.messages=owner.messages!.map(m=>m.id===ack.id?ack:m);this.manager.store.putOwner(owner);}}task.acknowledged=true;event(task,'lifecycle','Result receipt acknowledged; acceptance unchanged');}
    else {if(task.status!=='completed')fail('INVALID_STATE','Only successful executions can be reviewed');if(!['accepted','rejected'].includes(String(a.decision)))fail('INVALID_REQUEST','Decision must be accepted or rejected');task.reviewState=a.decision as 'accepted'|'rejected';task.reviewComment=text(a.comment??'','comment',4000,true);event(task,'lifecycle',`Owner review: ${task.reviewState}`);}
    task.ownerLastActivityAt=new Date().toISOString();this.records.put(task);return this.manifest(task);
   }
}
