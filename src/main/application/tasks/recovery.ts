import { active, event } from '../../domain/tasks';
import type { TaskStore } from '../../store';

/** Startup decision for runs the file-mode reattach phase does not own: active runs that cannot be re-attached fail with an explanatory event; native runs and attached owner hosts are left alone. */
export function recoverInterruptedTasks(store: TaskStore, skip: ReadonlySet<string> = new Set()): string[] {
 const recovered:string[]=[];
 store.transaction(() => {for(const head of store.listHeads())if(!skip.has(head.id)&&active(head)&&(head.run?.execution!=='native'||(head.executionRole==='owner'&&!head.ownerHost))){
  const task=store.get(head.id);task.status='failed';if(task.run){task.run.status='stopped';task.run.endedAt=new Date().toISOString();delete task.run.pid;}
  event(task,'error',task.executionRole==='owner'?'Owner launch interrupted by app exit; inspect Herdr before retrying tasks start.':'Interrupted by app exit. No worker was resumed; create a new task to retry.');store.put(task);recovered.push(task.id);
 }});
 return recovered;
}
