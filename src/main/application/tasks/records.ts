import { createHash } from 'node:crypto';
import type { LogicalOwner } from '../../../shared/contracts/owners';
import type { Task } from '../../../shared/contracts/tasks';
import { parseId } from '../../../shared/validation';
import type { TaskManager } from '../../manager';
import { fail } from '../commands/errors';
export function canonical(value:unknown):string {if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;return JSON.stringify(value);}
export const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export const terminal=(t:Task)=>['completed','failed','cancelled'].includes(t.status);
/** The attempt ended on a vendor rate limit or exhausted quota. */
export const vendorLimited=(t:Task)=>t.status==='failed'&&(t.failure?.kind==='rate_limit'||t.failure?.kind==='quota');
export function publicTask<T extends Pick<Task,'owner'|'run'>>(task:T){const {owner,run,...rest}=task;const withReport={...rest,ownerReport:(rest as Record<string,unknown>).ownerReport ?? null};if(!run)return withReport;const visible={...run};delete visible.pid;delete visible.stateDir;delete visible.logs;delete visible.nonce;delete visible.logIdentity;return {...withReport,run:visible};}
/** Looks tasks and owners up for the command units that share one manager; every miss is the same NOT_FOUND answer. */
export class TaskRecords {
 constructor(readonly manager:TaskManager){}
 owner(id:unknown):LogicalOwner {const owner=this.manager.store.getOwner(parseId(id,'owner ID'));if(!owner)fail('NOT_FOUND','Owner not found');return owner!;}
 task(a:Record<string,unknown>):Task {try{return this.manager.store.get(parseId(a.taskId,'task ID'));}catch{ return fail('NOT_FOUND','Task not found');}}
 /** The durable row only: external query and result faces must use this, never the pending-merged read. */
 committedTask(a:Record<string,unknown>):Task {try{return this.manager.store.getCommitted(parseId(a.taskId,'task ID'));}catch{ return fail('NOT_FOUND','Task not found');}}
  revise(task:Task,a:Record<string,unknown>){if(a.expectedRevision!==undefined && a.expectedRevision!==(task.revision??0))fail('REVISION_CONFLICT',`Current revision is ${task.revision??0}`);}
  put(task:Task){this.manager.update(task);}
}
