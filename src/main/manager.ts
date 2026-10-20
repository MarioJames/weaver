import { randomUUID } from 'node:crypto';
import type { Artifact, Task, TaskInput, TaskFailure, WorkerRecord } from '../shared/contracts/tasks';
import { parseTaskInput } from '../shared/validation';
import type { ManagedProcess, WorkerAdapter } from './adapters/worker';
import { JsonlParser } from './protocol';
import { event, slotGroupCount, slotGroupName, slotGroupOf } from './domain/tasks';
import type { TaskStore } from './store';
import { classifyVendorError } from './adapters/cli/vendor-errors';
import { redact } from './adapters/cli/redact';
import { redactContext } from './redact-context';

interface Running { child: ManagedProcess; timeout?: NodeJS.Timeout; killTimer?: NodeJS.Timeout; error?: string; result?: string; cancelled: boolean; stderrBytes: number; stderrTail: string; adapterTail?: boolean; vendorError?: string; firstTimer?: NodeJS.Timeout }

/** `herdr.max_wait_minutes` is the owner's polling bound, never an execution deadline: only a direct mock test may pass the short hook. */
export function executionTimeoutMs(task: Pick<Task, 'dispatch'>, fallback?: number): number | undefined {
  if ((task.dispatch?.execution ?? 'mock') !== 'mock') return undefined;
  if (fallback !== undefined && Number.isSafeInteger(fallback) && fallback > 0) return fallback;
  return undefined;
}

export class TaskManager {
  readonly listeners = new Set<() => void>();
  notify(): void { this.changed(); for (const listener of this.listeners) listener(); }
  update(task: Task): void { this.persist(task); }
  private running = new Map<string, Running>();
  get runningCount(): number { return this.running.size; }
  get adapterId(): string { return this.adapter.id; }
  get canLaunchReal(): boolean { return this.adapter.canLaunchReal?.() === true; }
  constructor(readonly store: TaskStore, private adapter: WorkerAdapter, private changed: () => void = () => {}, private timeoutMs?: number, private fatal: (error: unknown) => void = console.error) {}
  create(input: TaskInput): Task {
    const valid = parseTaskInput(input);
    const at = new Date().toISOString();
    const task: Task = { ...valid, id: randomUUID(), createdAt: at, updatedAt: at, status: 'queued', revision: 0, reviewState: 'pending', progress: 0, events: [], artifacts: [] };
    event(task, 'lifecycle', 'Task queued. Owner reference is metadata only; no Herdr session was contacted.');
    this.persist(task); return task;
  }
  start(id: string, liveMaxParallel?: number): Task {
    const task = this.store.get(id);
    if (task.status !== 'queued') throw new Error('Only queued tasks can be started');
    if (task.dispatch) {
      const limit = liveMaxParallel ?? task.dispatch.maxParallel;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Configured max_parallel is invalid');
      const group = slotGroupOf(task);
      const running = slotGroupCount(this.store.listHeads(), group);
      if (running >= limit) throw new Error(`${slotGroupName(this.store.listOwners(), task.ownerId, task.dispatch.owner)} is at its configured concurrency limit (${limit})`);
    }
    const timeoutMs = executionTimeoutMs(task, this.timeoutMs);
    const execution = task.dispatch?.execution ?? 'mock';
    delete task.failure;
    task.scheduled = false;
    delete task.queueReason;
    task.status = 'running';
    task.run = {
      id: randomUUID(),
      adapter: task.dispatch?.adapter ?? (execution === 'mock' ? 'mock-jsonl' : this.adapter.id),
      execution,
      status: 'running',
      startedAt: new Date().toISOString(),
      ...(task.dispatch ? { engine: task.dispatch.engine, model: task.dispatch.model, effort: task.dispatch.effort, workspace: task.dispatch.workspace ?? task.workspace } : {}),
    };
    if (execution === 'native') {
      // The owner runs this worker itself and reports back through completeNative; there is no process or timer here.
      event(task, 'lifecycle', `Owner runs ${task.dispatch?.worker} with its built-in subagent tool; waiting for its report`);
      this.persist(task);
      return this.store.get(id);
    }
    event(task, 'lifecycle', execution === 'real'
      ? `Launching ${task.dispatch?.engineKind ?? task.dispatch?.engine} in ${task.dispatch?.workspace}`
      : 'Launching explicit mock-jsonl provider');
    this.persist(task);
    let child: ManagedProcess;
    try { child = this.adapter.start(task); } catch (error) {
      task.failure={kind:'early_exit',message:redact(error instanceof Error?error.message:String(error)).slice(-4000)}; task.status = 'failed'; task.run.status = 'stopped'; task.run.endedAt = new Date().toISOString(); event(task, 'error', task.failure.message); this.persist(task); return task;
    }
    const run: Running = { child, cancelled: false, stderrBytes: 0, stderrTail: '', ...(timeoutMs === undefined ? {} : { timeout: setTimeout(() => this.stop(id, 'Mock worker exceeded its test timeout'), timeoutMs) }) };
    this.running.set(id, run);
    if(execution==='real'){
      run.firstTimer=setTimeout(()=>this.failAttempt(id,{kind:'no_output',message:'Worker produced no valid vendor output within 120 seconds'}),120000);
      child.on('first-output',(at:string)=>{const current=this.store.get(id);if(run.error||run.cancelled||current.run?.firstOutputAt)return;clearTimeout(run.firstTimer);if(current.run)current.run.firstOutputAt=at;this.persist(current,'stream');});
      child.on('stderr-tail',(tail:string)=>{run.adapterTail=true;run.stderrTail=tail;});
      child.on('vendor-error',(message:string,failure?:TaskFailure)=>{run.vendorError=redact(message).slice(-2048);if(failure)this.failAttempt(id,{...failure,vendorError:run.vendorError});});
    }

    const parser = new JsonlParser(record => this.record(id, record));
    child.stdout.on('data', (chunk: Buffer) => {
      if (run.error || run.cancelled) return;
      try { parser.push(chunk); } catch (error) { this.stop(id, `Invalid worker output: ${String(error)}`); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (run.error || run.cancelled) return;
      const safe=redact(chunk.toString('utf8'));
      if(!run.adapterTail)run.stderrTail=(run.stderrTail+safe).slice(-2048);
      if(execution==='real'){
        const failure=classifyVendorError(task.dispatch?.engineKind??task.run?.adapter??'',run.stderrTail);
        if(failure){this.failAttempt(id,{...failure,stderrTail:run.stderrTail});return;}
      }
      run.stderrBytes += chunk.length;
      if (execution!=='real' && run.stderrBytes > 32768) { this.stop(id, 'Worker stderr exceeds 32 KiB limit'); return; }
      try { const current = this.store.get(id); event(current, 'log', `stderr: ${safe}`); this.persist(current, 'stream'); } catch (error) { this.stop(id, 'Unable to persist stderr'); this.fatal(error); }
    });
    child.on('error', (error: Error) => { this.failAttempt(id,{kind:task.run?.firstOutputAt?'other':'early_exit',message:redact(error.message).slice(-4000)}); });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(run.timeout); clearTimeout(run.killTimer); clearTimeout(run.firstTimer);
      if (!run.error && !run.cancelled) { try { parser.finish(); } catch (error) { run.error = `Invalid worker output: ${String(error)}`; } }
      this.running.delete(id);
      try {
        const current = this.store.get(id);
        if (current.run) { this.observe(current, child); current.run.status = 'stopped'; current.run.endedAt = new Date().toISOString(); current.run.exitCode = code; delete current.run.pid; }
        if (run.cancelled) { current.failure??={kind:'cancelled',message:'Worker cancelled',...(run.stderrTail?{stderrTail:run.stderrTail}:{})}; current.status = 'cancelled'; event(current, 'lifecycle', 'Worker stopped after cancellation'); }
        else if (run.error || code !== 0 || !run.result) {
          current.status = 'failed';
          const existing=current.failure;
          current.failure={...(existing??{kind:current.run?.firstOutputAt?'vendor':'early_exit',message:run.error||`Worker exited without successful result (code ${code}, signal ${signal??'none'})`}),...(code!==null?{exitCode:code}:{}),...(run.stderrTail?{stderrTail:run.stderrTail}:{}),...(run.vendorError?{vendorError:run.vendorError}:{})};
          if(!existing)event(current,'error',this.failureDetail(current.failure));
          else {const errorEvent=[...current.events].reverse().find(item=>item.kind==='error');if(errorEvent)errorEvent.message=this.failureDetail(current.failure);}

        } else { current.status = 'completed'; current.progress = 100; current.summary = run.result; event(current, 'lifecycle', 'Worker exited successfully; output is ready for owner review'); }
        this.persist(current);
      } catch (error) { this.fatal(error); }
    });
    task.run.pid = child.pid;
    this.observe(task, child);
    try { this.persist(task); } catch (error) { this.stop(id, 'Unable to persist worker PID'); throw error; }
    return this.store.get(id);
  }
  cancel(id: string): Task {
    const task = this.store.get(id);
    if (task.status === 'queued') { task.status = 'cancelled'; task.scheduled = false; delete task.queueReason; event(task, 'lifecycle', 'Cancelled before dispatch'); this.persist(task); return task; }
    if (task.status === 'cancelling' || task.status === 'cancelled') return task;
    if (task.status !== 'running') throw new Error('Only queued or running tasks can be cancelled');
    if (task.run?.execution === 'native') {
      task.status = 'cancelled'; task.run.status = 'stopped'; task.run.endedAt = new Date().toISOString();
      event(task, 'lifecycle', 'Cancelled; the owner should stop its built-in subagent'); this.persist(task); return task;
    }
    const run = this.running.get(id); if (!run) throw new Error('No active worker');
    task.status = 'cancelling'; if (task.run) task.run.status = 'stopping';
    event(task, 'lifecycle', 'Cancellation requested; waiting for worker exit'); this.persist(task);
    run.cancelled = true; this.terminate(run); return task;
  }
  /** The owner's report for a native run. Artifacts are already validated plain files. */
  completeNative(id: string, report: { outcome: 'completed' | 'failed'; summary: string; artifacts: Pick<Artifact, 'name' | 'mediaType' | 'content'>[] }): Task {
    const task = this.store.get(id);
    if (task.status !== 'running' || task.run?.execution !== 'native') throw new Error('Only a running native task accepts a report');
    const at = new Date().toISOString();
    for (const artifact of report.artifacts) { task.artifacts.push({ id: randomUUID(), ...artifact, createdAt: at }); event(task, 'artifact', `Received ${artifact.name}`); }
    task.run.status = 'stopped'; task.run.endedAt = at;
    if (report.outcome === 'completed') { task.status = 'completed'; task.progress = 100; task.summary = report.summary; event(task, 'result', report.summary); event(task, 'lifecycle', 'Owner reported the native run complete; output is ready for review'); }
    else { task.status = 'failed'; event(task, 'error', `Owner reported the native run failed: ${report.summary}`); }
    this.persist(task);
    return task;
  }
  async shutdown(): Promise<void> {
    const exits = [...this.running.values()].map(run => new Promise<void>(resolve => run.child.once('close', () => resolve())));
    for (const id of this.running.keys()) {
      try { this.cancel(id); } catch (error) { const run = this.running.get(id); if (run) { run.cancelled = !this.store.get(id).failure; this.terminate(run); } this.fatal(error); }
    }
    await Promise.all(exits);
    this.store.flush();
  }
  private failureDetail(failure:TaskFailure):string {
    return [failure.message,failure.exitCode!==undefined?`exit code: ${failure.exitCode}`:undefined,failure.stderrTail?`stderr tail: ${failure.stderrTail}`:undefined,failure.vendorError?`last vendor error: ${failure.vendorError}`:undefined].filter(Boolean).join('; ').slice(-8000);
  }
  private failAttempt(id:string,failure:TaskFailure):void {
    const run=this.running.get(id);if(!run||run.cancelled||run.error)return;
    const task=this.store.get(id);task.failure={...failure,...(run.stderrTail?{stderrTail:run.stderrTail}:{}),...(run.vendorError?{vendorError:run.vendorError}:{})};
    run.error=failure.message;task.status='failed';clearTimeout(run.firstTimer);event(task,'error',this.failureDetail(task.failure));this.persist(task);if(this.running.has(id))this.terminate(run);
  }
  waitForFirstOutput(id:string,waitMs=10000):Promise<boolean>{
    const ready=()=>{const task=this.store.get(id);return !!task.run?.firstOutputAt;};
    if(ready())return Promise.resolve(true);
    if(this.store.get(id).status!=='running')return Promise.resolve(false);
    return new Promise(resolve=>{const check=()=>{if(ready()||this.store.get(id).status!=='running')finish(ready());};const finish=(started:boolean)=>{clearTimeout(timer);this.listeners.delete(check);resolve(started);};const timer=setTimeout(()=>finish(ready()),waitMs);this.listeners.add(check);check();});
  }
  private stop(id: string, message: string): void {
    const run = this.running.get(id); if (!run) return;
    run.error ??= message; this.terminate(run);
  }
  private terminate(run: Running): void {
    run.killTimer ??= setTimeout(() => run.child.kill('SIGKILL'), 1500);
    run.child.kill('SIGTERM');
  }
  private record(id: string, record: WorkerRecord): void {
    const run = this.running.get(id); if (!run || run.cancelled || run.error) return;
    if (run.result) throw new Error('Records after terminal result are not allowed');
    const task = this.store.get(id);
    this.observe(task, run.child);
    switch (record.type) {
      case 'log': event(task, 'log', record.message); break;
      case 'progress': task.progress = Math.max(task.progress, record.percent); event(task, 'progress', record.message); break;
      case 'artifact':
        if (task.artifacts.length >= 20) throw new Error('Worker exceeds 20 artifact limit');
        task.artifacts.push({ id: randomUUID(), name: record.name, mediaType: record.mediaType, content: record.content, createdAt: new Date().toISOString() });
        event(task, 'artifact', `Received ${record.name}`); break;
      case 'result': run.result = record.summary; event(task, 'result', record.summary); break;
    }
    this.persist(task, 'stream');
  }
  private observe(task: Task, child: ManagedProcess): void {
    if (!task.run) return;
    if (child.scopeUnit) task.run.scopeUnit = child.scopeUnit.slice(0,200);
    if (child.evidence) {
      const source=child.evidence;
      task.run.evidence={engine:source.engine,requestedModel:source.requestedModel.slice(0,200),requestedEffort:source.requestedEffort.slice(0,120),workspace:source.workspace.slice(0,2000),terminal:source.terminal,...(source.role?{role:source.role}:{}),...(source.vendorModel?{vendorModel:redactContext(source.vendorModel,512)}:{}),...(source.vendorSessionId?{vendorSessionId:redactContext(source.vendorSessionId,512)}:{}),...(source.promptPath?{promptPath:source.promptPath.slice(0,2000)}:{}),...(source.sessionDir?{sessionDir:source.sessionDir.slice(0,2000)}:{})};
      if(source.usage){task.run.evidence.usage={};for(const key of ['inputTokens','outputTokens'] as const){const value=source.usage[key];if(Number.isSafeInteger(value)&&typeof value==='number'&&value>=0)task.run.evidence.usage[key]=value;}}
    }
  }
  private persist(task: Task, durability: 'sync' | 'stream' = 'sync'): void { task.revision = (task.revision ?? 0) + 1; this.store.put(task, durability, this.fatal); this.notify(); }
}
