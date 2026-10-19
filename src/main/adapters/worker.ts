import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Task } from '../../shared/types';

/** Structural child used by mock processes and by startCliAgent. */
export interface ManagedProcess {
  pid?: number;
  readonly scopeUnit?: string;
  readonly evidence?: import('./cli/types').CliAgentEvidence;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
}
export interface WorkerAdapter {
  readonly id: string;
  start(task: Task): ManagedProcess;
  canLaunchReal?(): boolean;
}
/** Explicit deterministic fixture provider. No shell or user-supplied argv. */
export class MockWorkerAdapter implements WorkerAdapter {
 readonly id = 'mock-jsonl' as const;
 constructor(private executable: string, private script: string) {}
 start(task: Task): ManagedProcess {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(this.executable, [this.script], {shell:false, windowsHide:true, env, stdio:['pipe','pipe','pipe']});
  child.stdin.on('error', () => { /* close/error event owns final status */ });
  child.stdin.end(JSON.stringify({taskId:task.id,title:task.title,instruction:task.instruction})+'\n');
  return child;
 }
}
