import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, openSync, fsyncSync, closeSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownerSession, type LogicalOwner, type WorkPackage, type CommandReceipt } from '../shared/commands';
import type { Task, TaskEvent, TaskSummary } from '../shared/types';
import { object } from '../shared/validation';
import { parseStoredTask } from './stored-task';
export const active = (task: Task) => task.status === 'running' || task.status === 'cancelling';
/** Slots belong to the exact owner instance a task is bound to; unbound work shares only its own profile group. */
const instanceGroup = (ownerId: string) => `instance:${ownerId}`;
const profileGroup = (profile: string) => `profile:${profile}`;
export const slotGroupOf = (task: Pick<Task, 'ownerId' | 'dispatch'>): string | undefined => task.ownerId ? instanceGroup(task.ownerId) : task.dispatch ? profileGroup(task.dispatch.owner) : undefined;
/** The group new work competes in: its own instance when bound, otherwise the profile group of unbound work. */
export const slotGroupFor = (ownerId: string | undefined, profile: string) => ownerId ? instanceGroup(ownerId) : profileGroup(profile);
/** Running and cancelling tasks already holding a slot of the same owner instance. */
export const slotGroupCount = (tasks: Task[], group: string | undefined): number => group === undefined ? 0 : tasks.reduce((held, task) => held + (active(task) && slotGroupOf(task) === group ? 1 : 0), 0);
/** Whose slots these are, in the words an owner reads when a dispatch has to wait. */
export const slotGroupName = (owners: LogicalOwner[], ownerId: string | undefined, profile: string): string => {
 const instance = ownerId ? owners.find(owner => owner.id === ownerId) : undefined;
 return instance ? `Owner instance ${instance.name} of profile ${profile}` : `Owner ${profile}`;
};
export function event(task: Task, kind: TaskEvent['kind'], message: string): void {
 const at = new Date().toISOString(); task.updatedAt = at;
 task.events.push({id:randomUUID(), at, kind, message});
 if (task.events.length > 500) task.events.splice(0, task.events.length - 500);
}
/** One main-process writer, atomic replace; deliberately not a concurrent database. */
export class TaskStore {
 private inTransaction=false;
 private sequence=0;
 private dirty=false;
 private flushTimer?: NodeJS.Timeout;
 get revision():number{return this.sequence;}
 transaction<T>(fn:()=>T):T {
  if(this.inTransaction)return fn();
  const tasks=structuredClone(this.tasks),metadata=structuredClone(this.metadata);this.inTransaction=true;
  try{const result=fn();this.inTransaction=false;this.save();return result;}catch(error){this.inTransaction=false;this.tasks=tasks;this.metadata=metadata;throw error;}
 }
 private tasks = new Map<string, Task>();
 private metadata: {owners:LogicalOwner[];packages:WorkPackage[];receipts:Record<string,CommandReceipt>}={owners:[],packages:[],receipts:{}};
 constructor(readonly path: string, private write: (path: string, content: string) => void = (path, content) => writeFileSync(path, content, {mode:0o600})) {
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
    // A manual instance registered before the session label was a durable field keeps it in its own host evidence.
    this.metadata.owners=this.metadata.owners.map(owner=>{
     const session=ownerSession(owner);
     return session&&owner.session!==session ?{...owner,session}:owner;
    });
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
  // A native run lives in the owner, not this process, so the owner can still report it after a restart.
 for (const task of this.tasks.values()) if (active(task) && task.run?.execution !== 'native') {
   task.status = 'failed'; if (task.run) { task.run.status='stopped'; task.run.endedAt=new Date().toISOString(); delete task.run.pid; }
   event(task,'error','Interrupted by app exit. No worker was resumed; create a new task to retry.'); changed = true;
  }
  if (changed) this.save();
 }
 getMetadata() { return structuredClone(this.metadata); }
 setMetadata(value: typeof this.metadata): void { const previous=this.metadata; this.metadata=structuredClone(value); try {this.save();} catch(error) {this.metadata=previous;throw error;} }
 list(): Task[] { return structuredClone([...this.tasks.values()].reverse()); }
 /** Project before cloning: list reads must not traverse historical events or artifact bodies. */
 listSummaries(): TaskSummary[] {
  return structuredClone([...this.tasks.values()].reverse().map(task => ({
   ...task, events: task.events.slice(-3), eventCount: task.events.length,
   artifacts: task.artifacts.map(({content, ...metadata}) => metadata),
  })));
 }
 get(id: string): Task { const task = this.tasks.get(id); if (!task) throw new Error('Task not found'); return structuredClone(task); }
 put(task: Task, durability: 'sync' | 'stream' = 'sync', onError: (error: unknown) => void = console.error): void {
  const previous = this.tasks.get(task.id); this.tasks.set(task.id, structuredClone(task));
  if (durability === 'stream' && !this.inTransaction) {
   // Readers and sync.status observe stream activity before its next disk checkpoint.
   this.sequence++; this.dirty=true; this.scheduleFlush(onError); return;
  }
  try { this.save(); } catch (error) { if (previous) this.tasks.set(task.id, previous); else this.tasks.delete(task.id); throw error; }
 }
 /** Flush only pending stream changes; ordinary writes also checkpoint them atomically. */
 flush(): void { if (this.dirty) this.save(); }
 close(): void { this.flush(); }
 private scheduleFlush(onError: (error: unknown) => void): void {
  if (this.flushTimer) return;
  this.flushTimer=setTimeout(() => {
   this.flushTimer=undefined;
   try { this.flush(); } catch (error) {
    // Keep the in-memory events and retry; a failed command must not discard them either.
    this.scheduleFlush(onError); onError(error);
   }
  },500);
  this.flushTimer.unref();
 }
 private save(): void {
  if(this.inTransaction)return;
  const temp = `${this.path}.tmp`;
  const content = JSON.stringify({version:1,sequence:this.sequence+1,tasks:[...this.tasks.values()],metadata:this.metadata});
  if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('Store exceeds 32 MiB limit');
  this.write(temp, content);
  const fd = openSync(temp,'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp,this.path);this.sequence++;
  this.dirty=false; clearTimeout(this.flushTimer); this.flushTimer=undefined;
 }
}
