import type { TaskStore } from '../../src/main/store';
/** A running parent whose child really inherits this account; independent top-level tasks have no such proof. */
export function inheritedChannel(store:TaskStore,taskId:string,channel='default_claude'):void {
 const task=store.get(taskId);const id=`parent-${task.ownerId??task.id}`;
 if(!store.listHeads().some(item=>item.id===id))store.put({...task,id,executionRole:'owner',status:'running',dispatch:undefined,scheduled:false,run:{id:`run-${id}`,execution:'native',adapter:'native',status:'running',channel,policyRevision:Number((store.db.prepare('SELECT max(revision) AS revision FROM policy_revisions').get() as {revision:number|null}).revision??0)},acceptanceCriteria:['Fixture parent owns the inherited account']});
 task.parentTaskId=id;store.put(task);
}
