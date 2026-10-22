import { mkdirSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { ownerSession } from '../shared/policy/owner-instance';
import { type LogicalOwner } from '../shared/contracts/owners';
import { type WorkPackage } from '../shared/contracts/tasks';
import { type CommandReceipt } from '../shared/contracts/commands';
import type { Task, TaskSummary } from '../shared/contracts/tasks';
import { migrate } from './migrate';
import { transact } from './storage/transaction';
import { dbVendorLadder, type VendorLimit } from './storage/vendor-limits';
/** SQLite is the durable authority. Only uncheckpointed stream records live in memory. */
export class TaskStore {
 readonly path:string;
 readonly db:DatabaseSync;
 private inTransaction=false;
 private pending=new Map<string,Task>();
 private sequence=0;
 private flushTimer?:NodeJS.Timeout;
 private commitListeners=new Set<() => void>();
 private closed=false;
 get revision():number{return this.sequence;}
 /** Runs after a real COMMIT succeeds: never on rollback, never for a nested savepoint, including timer-driven flush commits. */
 onCommit(listener:() => void):() => void {this.commitListeners.add(listener);return ()=>{this.commitListeners.delete(listener);};}
 private emitCommit():void {for(const listener of [...this.commitListeners])listener();}
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
 /** The vendor rate-limit ladder (read side): one row per worker, written by the dispatch-failure path and the free-channel probe through the ladder store. */
 getVendorLimit(worker:string):VendorLimit|undefined{return dbVendorLadder(this.db).get(worker);}
 listVendorLimits():Record<string,VendorLimit>{return dbVendorLadder(this.db).list();}
 transaction<T>(fn:()=>T):T {
  if(this.inTransaction)return fn();
  const pending=new Map(this.pending),sequence=this.sequence;
  // The stream records and the sequence are memory: they come back if this transaction fails, or if one it ran inside of does.
  const restore=()=>{this.pending=pending;this.sequence=sequence;};
  const result=transact(this.db,()=>{
   this.inTransaction=true;
   try {
    const value=fn();
    for(const task of this.pending.values())this.writeTask(task);
    this.writeRecord('kv','sequence',this.sequence+1);
    this.checkpoint?.();
    return value;
   }finally{this.inTransaction=false;}
  },restore);
  this.sequence++;this.pending.clear();clearTimeout(this.flushTimer);this.flushTimer=undefined;
  this.emitCommit();
  return result;
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
  return this.getCommitted(id);
 }
 /** The durable row only: pending stream records are invisible here, so this is what external readers may see. */
 getCommitted(id:string):Task {
  const body=this.readRecord<Omit<Task,'events'|'artifacts'>>('tasks',id);if(!body)throw new Error('Task not found');
  return {...body,events:this.db.prepare('SELECT body FROM task_events WHERE task_id=? ORDER BY position').all(id).map(row=>JSON.parse(String(row.body))),artifacts:this.db.prepare('SELECT body,content FROM artifacts WHERE task_id=? ORDER BY position').all(id).map(row=>({...JSON.parse(String(row.body)),content:String(row.content)}))};
 }
 /** Control-plane scans do not read historical events or artifact contents. */
 listHeads():Task[] {
  const tasks=[...this.listHeadsCommitted()].reverse();
  const map=new Map(tasks.map(task=>[task.id,task]));
  for(const [id,task] of this.pending) {const {events,artifacts,...body}=task;map.set(id,structuredClone({...body,events:[],artifacts:[]}));}
  return [...map.values()].reverse();
 }
 /** Durable heads only: no pending merge, so this is what external readers may see. */
 listHeadsCommitted():Task[] {
  return this.readRecords<Task>('tasks').map(task=>({...task,events:[],artifacts:[]})).reverse();
 }
 list():Task[]{return this.listHeads().map(task=>this.get(task.id));}
 listSummaries():TaskSummary[]{return this.listHeads().map(head=>{
  const pending=this.pending.get(head.id);
  if(pending){const {events,artifacts,...body}=pending;return structuredClone({...body,events:events.slice(-3),eventCount:events.length,artifacts:artifacts.map(({content,...meta})=>meta)});}
  return this.summarizeCommitted(head);
 });}
 /** Durable summaries only: no pending merge, so this is what external readers may see. */
 listSummariesCommitted():TaskSummary[]{return this.listHeadsCommitted().map(head=>this.summarizeCommitted(head));}
 private summarizeCommitted(head:Task):TaskSummary{
  const events=this.db.prepare('SELECT body FROM task_events WHERE task_id=? ORDER BY position DESC LIMIT 3').all(head.id).reverse().map(row=>JSON.parse(String(row.body)));
  const count=Number(this.db.prepare('SELECT count(*) AS n FROM task_events WHERE task_id=?').get(head.id)!.n);
  const artifacts=this.db.prepare('SELECT body FROM artifacts WHERE task_id=? ORDER BY position').all(head.id).map(row=>JSON.parse(String(row.body)));
  return {...head,events,eventCount:count,artifacts};
 }
 put(task:Task,durability:'sync'|'stream'='sync',onError:(error:unknown)=>void=console.error):void {
  const value=structuredClone(task);
  if(durability==='stream'&&!this.inTransaction){this.pending.set(task.id,value);this.sequence++;this.scheduleFlush(onError);return;}
  this.transaction(()=>{this.pending.delete(task.id);this.writeTask(value);});
 }
 flush():void{if(this.pending.size)this.transaction(()=>{});}
 close():void{if(this.closed)return;this.flush();clearTimeout(this.flushTimer);this.db.close();this.closed=true;}
 private scheduleFlush(onError:(error:unknown)=>void):void{
  if(this.flushTimer)return;
  this.flushTimer=setTimeout(()=>{this.flushTimer=undefined;try{this.flush();}catch(error){this.scheduleFlush(onError);onError(error);}},500);this.flushTimer.unref();
 }
}
