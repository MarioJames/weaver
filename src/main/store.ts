import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, openSync, fsyncSync, closeSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LogicalOwner, WorkPackage, CommandReceipt } from '../shared/commands';
import type { Task, TaskEvent } from '../shared/types';
import { object } from '../shared/validation';
import { parseStoredTask } from './stored-task';
export const active = (task: Task) => task.status === 'running' || task.status === 'cancelling';
export function event(task: Task, kind: TaskEvent['kind'], message: string): void {
 const at = new Date().toISOString(); task.updatedAt = at;
 task.events.push({id:randomUUID(), at, kind, message});
 if (task.events.length > 500) task.events.splice(0, task.events.length - 500);
}
/** One main-process writer, atomic replace; deliberately not a concurrent database. */
export class TaskStore {
 private inTransaction=false;
 private sequence=0;
 get revision():number{return this.sequence;}
 transaction<T>(fn:()=>T):T {
  if(this.inTransaction)return fn();
  const tasks=structuredClone(this.tasks),metadata=structuredClone(this.metadata);this.inTransaction=true;
  try{const result=fn();this.inTransaction=false;this.save();return result;}catch(error){this.inTransaction=false;this.tasks=tasks;this.metadata=metadata;throw error;}
 }
 private tasks = new Map<string, Task>();
 private metadata: {owners:LogicalOwner[];packages:WorkPackage[];receipts:Record<string,CommandReceipt>}={owners:[],packages:[],receipts:{}};
 constructor(readonly path: string) {
  mkdirSync(dirname(path), {recursive:true});
  if (existsSync(path)) {
   if (statSync(path).size > 32 * 1024 * 1024) throw new Error('Store exceeds 32 MiB limit; original file retained');
   const data = object(JSON.parse(readFileSync(path,'utf8')));
   if(data.sequence!==undefined){if(!Number.isSafeInteger(data.sequence)||Number(data.sequence)<0)throw new Error('Invalid store sequence');this.sequence=Number(data.sequence);}
   if (data.version !== 1 || !Array.isArray(data.tasks) || data.tasks.length > 200) throw new Error('Unsupported or damaged Weaver store; original file retained');
   if (data.metadata !== undefined) {
    const meta=object(data.metadata);
    if(!Array.isArray(meta.owners)||!Array.isArray(meta.packages)||meta.owners.length>200||meta.packages.length>1000) throw new Error('Invalid control-plane metadata');
    object(meta.receipts); this.metadata=meta as unknown as typeof this.metadata;
   }
   for (const value of data.tasks) {
    const task = parseStoredTask(value);
    if (this.tasks.has(task.id)) throw new Error('Duplicate task ID in store');
    this.tasks.set(task.id,task);
   }
  }
 }
 recover(): void {
  let changed = false;
  for (const task of this.tasks.values()) if (active(task)) {
   task.status = 'failed'; if (task.run) { task.run.status='stopped'; task.run.endedAt=new Date().toISOString(); delete task.run.pid; }
   event(task,'error','Interrupted by app exit. No worker was resumed; create a new task to retry.'); changed = true;
  }
  if (changed) this.save();
 }
 getMetadata() { return structuredClone(this.metadata); }
 setMetadata(value: typeof this.metadata): void { const previous=this.metadata; this.metadata=structuredClone(value); try {this.save();} catch(error) {this.metadata=previous;throw error;} }
 list(): Task[] { return structuredClone([...this.tasks.values()].reverse()); }
 get(id: string): Task { const task = this.tasks.get(id); if (!task) throw new Error('Task not found'); return structuredClone(task); }
 put(task: Task): void {
  const previous = this.tasks.get(task.id); this.tasks.set(task.id, structuredClone(task));
  try { this.save(); } catch (error) { if (previous) this.tasks.set(task.id, previous); else this.tasks.delete(task.id); throw error; }
 }
 private save(): void {
  if(this.inTransaction)return;
  const temp = `${this.path}.tmp`;
  const content = JSON.stringify({version:1,sequence:this.sequence+1,tasks:[...this.tasks.values()],metadata:this.metadata},null,2);
  if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('Store exceeds 32 MiB limit');
  writeFileSync(temp, content, {mode:0o600});
  const fd = openSync(temp,'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp,this.path);this.sequence++;
 }
}
