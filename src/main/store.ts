import { mkdirSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownerSession } from '../shared/policy/owner-instance';
import { type LogicalOwner } from '../shared/contracts/owners';
import { type WorkPackage } from '../shared/contracts/tasks';
import { type CommandReceipt } from '../shared/contracts/commands';
import type { Task, TaskEvent, TaskSummary } from '../shared/contracts/tasks';
import { migrate } from './migrate';
export const active = (task: Task) => task.status === 'running' || task.status === 'cancelling';
/** Slots belong to the exact owner instance a task is bound to; unbound work shares only its own profile group. */
const instanceGroup = (ownerId: string) => `instance:${ownerId}`;
const profileGroup = (profile: string) => `profile:${profile}`;
export const slotGroupOf = (task: Pick<Task, 'ownerId' | 'dispatch'>): string | undefined => task.ownerId ? instanceGroup(task.ownerId) : task.dispatch ? profileGroup(task.dispatch.owner) : undefined;
/** The group new work competes in: its own instance when bound, otherwise the profile group of unbound work. */
export const slotGroupFor = (ownerId: string | undefined, profile: string) => ownerId ? instanceGroup(ownerId) : profileGroup(profile);
/** Running and cancelling tasks already holding a slot of the same owner instance. */
export const slotGroupCount = (tasks: Task[], group: string | undefined): number => group === undefined ? 0 : tasks.reduce((held, task) => held + (active(task) && task.executionRole!=='owner' && slotGroupOf(task) === group ? 1 : 0), 0);
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
export type VendorLimit={level:number;lastTriggerAt:number};
/** Ladder key for a dispatch that names no worker: the legacy per-engine ladder. */
export const engineLadderKey=(engine:string):string=>`@engine:${engine}`;
/** SQLite is the durable authority. Only uncheckpointed stream records live in memory. */
export class TaskStore {
 readonly path:string;
 readonly db:DatabaseSync;
 private inTransaction=false;
 private pending=new Map<string,Task>();
 private sequence=0;
 private flushTimer?:NodeJS.Timeout;
 private closed=false;
 get revision():number{return this.sequence;}
 constructor(source:string, private checkpoint?:()=>void) {
  mkdirSync(dirname(source),{recursive:true});
  this.path=source;
  this.db=new DatabaseSync(this.path);
  chmodSync(this.path,0o600);
  try {
   this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
   migrate(this.db);
   this.sequence=this.getValue<number>('sequence')??0;
  } catch(error){this.db.close();throw new Error(`Could not initialize Weaver SQLite store: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
 }
 private readRecord<T>(table:string,key:string):T|undefined {const row=this.db.prepare(`SELECT body FROM ${table} WHERE ${table==='kv'||table==='receipts'?'key':'id'}=?`).get(key);return row?JSON.parse(String(row.body)) as T:undefined;}
 private readRecords<T>(table:string):T[]{return this.db.prepare(`SELECT body FROM ${table} ORDER BY rowid`).all().map(row=>JSON.parse(String(row.body)) as T);}
 private writeRecord(table:string,key:string,value:unknown):void {this.db.prepare(`INSERT INTO ${table} (${table==='kv'||table==='receipts'?'key':'id'},body) VALUES (?,?) ON CONFLICT DO UPDATE SET body=excluded.body`).run(key,JSON.stringify(value));}
 private normalizeOwner(owner:LogicalOwner):LogicalOwner{const session=ownerSession(owner);return session?{...owner,session}:owner;}
 getOwner(id:string):LogicalOwner|undefined{const owner=this.readRecord<LogicalOwner>('owners',id);return owner?this.normalizeOwner(owner):undefined;}
 listOwners():LogicalOwner[]{return this.readRecords<LogicalOwner>('owners').map(owner=>this.normalizeOwner(owner));}
 putOwner(owner:LogicalOwner):void{this.transaction(()=>this.writeRecord('owners',owner.id,owner));}
 getPackage(id:string|undefined):WorkPackage|undefined{return id?this.readRecord('packages',id):undefined;}
 putPackage(pkg:WorkPackage):void{this.transaction(()=>this.writeRecord('packages',pkg.id,pkg));}
 getReceipt(key:string):CommandReceipt|undefined{return this.readRecord('receipts',key);}
 putReceipt(key:string,value:CommandReceipt):void{this.transaction(()=>this.writeRecord('receipts',key,value));}
 getValue<T>(key:string):T|undefined{return this.readRecord('kv',key);}
 putValue(key:string,value:unknown):void{this.transaction(()=>this.writeRecord('kv',key,value));}
 /** The vendor rate-limit ladder: one row per worker (an engine-only dispatch uses its own key), kept across restarts and explicit block removal. */
 getVendorLimit(worker:string):VendorLimit|undefined{const row=this.db.prepare('SELECT level,last_trigger_at FROM vendor_worker_limits WHERE worker=?').get(worker);return row?{level:Number(row.level),lastTriggerAt:Number(row.last_trigger_at)}:undefined;}
 listVendorLimits():Record<string,VendorLimit>{return Object.fromEntries(this.db.prepare('SELECT worker,level,last_trigger_at FROM vendor_worker_limits ORDER BY worker').all().map(row=>[String(row.worker),{level:Number(row.level),lastTriggerAt:Number(row.last_trigger_at)}]));}
 putVendorLimit(worker:string,limit:VendorLimit):void{this.transaction(()=>{this.db.prepare('INSERT INTO vendor_worker_limits(worker,level,last_trigger_at) VALUES (?,?,?) ON CONFLICT(worker) DO UPDATE SET level=excluded.level,last_trigger_at=excluded.last_trigger_at').run(worker,limit.level,limit.lastTriggerAt);});}
 transaction<T>(fn:()=>T):T {
  if(this.inTransaction)return fn();
  const pending=new Map(this.pending),sequence=this.sequence;
  this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;
  try {
   const result=fn();
   for(const task of this.pending.values())this.writeTask(task);
   this.writeRecord('kv','sequence',this.sequence+1);
   this.checkpoint?.();this.db.exec('COMMIT');
   this.sequence++;this.pending.clear();clearTimeout(this.flushTimer);this.flushTimer=undefined;
   return result;
  }catch(error){try{this.db.exec('ROLLBACK');}catch{/* Preserve the original commit failure. */}this.pending=pending;this.sequence=sequence;throw error;}
  finally{this.inTransaction=false;}
 }
 private writeTask(task:Task):void {
  const {events,artifacts,...body}=task;
  this.db.prepare('INSERT INTO tasks(id,owner_id,parent_task_id,status,updated_at,body) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,parent_task_id=excluded.parent_task_id,status=excluded.status,updated_at=excluded.updated_at,body=excluded.body').run(task.id,task.ownerId??null,task.parentTaskId??null,task.status,task.updatedAt,JSON.stringify(body));
  this.db.prepare('DELETE FROM task_events WHERE task_id=?').run(task.id);
  const insertEvent=this.db.prepare('INSERT INTO task_events(task_id,id,position,body) VALUES (?,?,?,?)');
  events.forEach((value,i)=>insertEvent.run(task.id,value.id,i,JSON.stringify(value)));
  this.db.prepare('DELETE FROM artifacts WHERE task_id=?').run(task.id);
  const insertArtifact=this.db.prepare('INSERT INTO artifacts(task_id,id,position,body,content) VALUES (?,?,?,?,?)');
  artifacts.forEach(({content,...value},i)=>insertArtifact.run(task.id,value.id,i,JSON.stringify(value),content));
 }
 get(id:string):Task {
  const pending=this.pending.get(id);if(pending)return structuredClone(pending);
  const body=this.readRecord<Omit<Task,'events'|'artifacts'>>('tasks',id);if(!body)throw new Error('Task not found');
  return {...body,events:this.db.prepare('SELECT body FROM task_events WHERE task_id=? ORDER BY position').all(id).map(row=>JSON.parse(String(row.body))),artifacts:this.db.prepare('SELECT body,content FROM artifacts WHERE task_id=? ORDER BY position').all(id).map(row=>({...JSON.parse(String(row.body)),content:String(row.content)}))};
 }
 /** Control-plane scans do not read historical events or artifact contents. */
 listHeads():Task[] {
  const tasks=this.readRecords<Task>('tasks').map(task=>({...task,events:[],artifacts:[]}));
  const map=new Map(tasks.map(task=>[task.id,task]));
  for(const [id,task] of this.pending) {const {events,artifacts,...body}=task;map.set(id,structuredClone({...body,events:[],artifacts:[]}));}
  return [...map.values()].reverse();
 }
 list():Task[]{return this.listHeads().map(task=>this.get(task.id));}
 listSummaries():TaskSummary[]{return this.listHeads().map(head=>{
  const pending=this.pending.get(head.id);
  if(pending){const {events,artifacts,...body}=pending;return structuredClone({...body,events:events.slice(-3),eventCount:events.length,artifacts:artifacts.map(({content,...meta})=>meta)});}
  const events=this.db.prepare('SELECT body FROM task_events WHERE task_id=? ORDER BY position DESC LIMIT 3').all(head.id).reverse().map(row=>JSON.parse(String(row.body)));
  const count=Number(this.db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id=?').get(head.id)!.n);
  const artifacts=this.db.prepare('SELECT body FROM artifacts WHERE task_id=? ORDER BY position').all(head.id).map(row=>JSON.parse(String(row.body)));
  return {...head,events,eventCount:count,artifacts};
 });}
 put(task:Task,durability:'sync'|'stream'='sync',onError:(error:unknown)=>void=console.error):void {
  const value=structuredClone(task);
  if(durability==='stream'&&!this.inTransaction){this.pending.set(task.id,value);this.sequence++;this.scheduleFlush(onError);return;}
  this.transaction(()=>{this.pending.delete(task.id);this.writeTask(value);});
 }
 recover():void{this.transaction(()=>{for(const head of this.listHeads())if(active(head)&&(head.run?.execution!=='native'||(head.executionRole==='owner'&&!head.ownerHost))){
  const task=this.get(head.id);task.status='failed';if(task.run){task.run.status='stopped';task.run.endedAt=new Date().toISOString();delete task.run.pid;}
  event(task,'error',task.executionRole==='owner'?'Owner launch interrupted by app exit; inspect Herdr before retrying tasks start.':'Interrupted by app exit. No worker was resumed; create a new task to retry.');this.put(task);
 }});}
 flush():void{if(this.pending.size)this.transaction(()=>{});}
 close():void{if(this.closed)return;this.flush();clearTimeout(this.flushTimer);this.db.close();this.closed=true;}
 private scheduleFlush(onError:(error:unknown)=>void):void{
  if(this.flushTimer)return;
  this.flushTimer=setTimeout(()=>{this.flushTimer=undefined;try{this.flush();}catch(error){this.scheduleFlush(onError);onError(error);}},500);this.flushTimer.unref();
 }
}
