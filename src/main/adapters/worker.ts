import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Task } from '../../shared/types';
export interface WorkerAdapter { readonly id: 'mock-jsonl'; start(task: Task): ChildProcessWithoutNullStreams }
/** Only a bundled deterministic Node script is executable in the MVP. No shell or user-supplied argv. */
export class MockWorkerAdapter implements WorkerAdapter {
 readonly id = 'mock-jsonl' as const;
 constructor(private executable: string, private script: string) {}
 start(task: Task): ChildProcessWithoutNullStreams {
  const child = spawn(this.executable, [this.script], {shell:false, windowsHide:true, env:{...process.env, ELECTRON_RUN_AS_NODE:'1'}, stdio:['pipe','pipe','pipe']});
  child.stdin.on('error', () => { /* close/error event owns final status */ });
  child.stdin.end(JSON.stringify({taskId:task.id,title:task.title,instruction:task.instruction})+'\n');
  return child;
 }
}
/** Extension boundary only. Each vendor needs a version-verified argv + event normalizer + permission policy. */
export class WorkerCliAdapter {
 readonly available = false;
 start(): never { throw new Error('Real worker CLI integration is not implemented. Only mock-jsonl is enabled.'); }
}
