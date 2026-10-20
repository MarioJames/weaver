import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore, event } from '../src/main/store';
import { SCHEMA_VERSION, migrate } from '../src/main/migrate';
import { TaskManager } from '../src/main/manager';
import { CommandHandler } from '../src/main/commands';
import { PolicyStore } from '../src/main/policy/store';
import type { Task } from '../src/shared/types';
import type { LogicalOwner, WorkPackage } from '../src/shared/commands';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
const input={title:'SQLite fixture',instruction:'local only',owner:{name:'fixture',transport:'herdr-visible' as const,session:'test',pane:'1'}};
function fixture():Task{const at=new Date().toISOString();return {...input,id:randomUUID(),status:'queued',progress:0,events:[],artifacts:[],createdAt:at,updatedAt:at};}
const adapter={id:'mock-jsonl',start:()=>{throw Error('no process expected');}};

test('empty database uses WAL, split rows, isolated narrow reads and rollback across every table',()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-sqlite-'));const store=new TaskStore(join(dir,'weaver.db'));
 try {
  assert.deepEqual(store.list(),[]);assert.equal(store.revision,0);
  const task=fixture();event(task,'log','durable');task.artifacts=[{id:randomUUID(),name:'proof.txt',mediaType:'text/plain',content:'body',createdAt:task.createdAt}];
  const owner:LogicalOwner={id:randomUUID(),name:'manual',profileId:'codex_owner',session:'test',mode:'manual',state:'attached',createdAt:task.createdAt};
  const pkg:WorkPackage={id:randomUUID(),taskId:task.id,revision:1,instruction:'frozen',scope:['local'],acceptanceCriteria:['pass'],createdAt:task.createdAt};
  store.transaction(()=>{store.put(task);store.putOwner(owner);store.putPackage(pkg);store.putReceipt('receipt',{hash:'a',response:{apiVersion:'weaver.v1',ok:true,data:{kept:1}}});store.putValue('probe',{a:1});});
  const before=store.revision;
  store.getOwner(owner.id)!.name='mutated';store.listOwners()[0].name='mutated';store.getPackage(pkg.id)!.scope.push('mutated');(store.getReceipt('receipt')!.response!.data as {kept:number}).kept=2;
  assert.equal(store.getOwner(owner.id)!.name,'manual');assert.deepEqual(store.getPackage(pkg.id)!.scope,['local']);assert.deepEqual(store.getReceipt('receipt')!.response!.data,{kept:1});
  assert.throws(()=>store.transaction(()=>{store.put({...task,title:'rollback'});store.putOwner({...owner,name:'rollback'});store.putPackage({...pkg,scope:[]});store.putReceipt('receipt',{hash:'rollback'});store.putValue('probe',{});throw Error('rollback');}),/rollback/);
  assert.throws(()=>store.put({...task,events:[task.events[0],task.events[0]]}),/UNIQUE constraint/);
  assert.equal(store.revision,before);assert.deepEqual(store.get(task.id),task);assert.deepEqual(store.getOwner(owner.id),owner);assert.deepEqual(store.getPackage(pkg.id),pkg);assert.equal(store.getReceipt('receipt')!.hash,'a');assert.deepEqual(store.getValue('probe'),{a:1});
  const db=new DatabaseSync(store.path);try{
   assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode,'wal');
   const body=JSON.parse(String(db.prepare('SELECT body FROM tasks').get()!.body));assert.equal('events' in body,false);assert.equal('artifacts' in body,false);
   assert.equal(db.prepare('SELECT content FROM artifacts').get()!.content,'body');assert.equal(db.prepare('SELECT count(*) n FROM task_events').get()!.n,1);
  }finally{db.close();}
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('startup never reads a legacy tasks.v1.json; the explicit import (used by the migration script) loads tasks, receipts, sequence and vendor limits',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-import-'));const source=new TaskStore(join(dir,'source.db'));
 const manager=new TaskManager(source,adapter);const handler=new CommandHandler(manager,new PolicyStore(source.db));
 try {
  const request={apiVersion:'weaver.v1',commandId:'import-replay',command:'tasks.create',args:input};const response=handler.handle(request);assert.equal(response.ok,true);
  const task=source.list()[0];event(task,'log','history');task.artifacts=[{id:randomUUID(),name:'result.txt',mediaType:'text/plain',content:'imported content',createdAt:task.createdAt}];source.put(task);
  const owner:LogicalOwner={id:randomUUID(),name:'registered',mode:'manual',profileId:'codex_owner',state:'attached',session:'test',createdAt:task.createdAt};source.putOwner(owner);
  const pkg:WorkPackage={id:randomUUID(),taskId:task.id,revision:1,instruction:task.instruction,scope:['local'],acceptanceCriteria:['pass'],createdAt:task.createdAt};source.putPackage(pkg);
  const content=JSON.stringify({version:1,sequence:41,tasks:source.list(),metadata:{...source.getMetadata(),vendorRateLimits:{codex:{level:2,lastTriggerAt:123}}}});const legacy=join(dir,'tasks.v1.json');writeFileSync(legacy,content);
  const first=new TaskStore(join(dir,'weaver.db'));
  assert.equal(first.list().length,0,'opening the store ignores tasks.v1.json');assert.equal(first.revision,0);assert.equal(readFileSync(legacy,'utf8'),content);
  first.importTasksJson(legacy);
  assert.equal(first.revision,41);assert.deepEqual(first.get(task.id),task);assert.deepEqual(first.getOwner(owner.id),owner);assert.deepEqual(first.getPackage(pkg.id),pkg);assert.deepEqual(first.getVendorLimit('codex'),{level:2,lastTriggerAt:123});
  assert.equal(first.getValue('legacyImport'),undefined,'no import marker is kept');assert.equal(first.getValue('vendorRateLimits'),undefined,'the ladder lives in its own table');
  const imported=new CommandHandler(new TaskManager(first,adapter),new PolicyStore(first.db));
  assert.deepEqual(imported.handle(request),response);assert.equal(first.list().length,1);
  await imported.drain();first.close();
  const second=new TaskStore(join(dir,'weaver.db'));try{assert.equal(second.revision,41);assert.deepEqual(second.get(task.id),task);assert.equal(second.list().length,1);assert.deepEqual(second.listVendorLimits(),{codex:{level:2,lastTriggerAt:123}});}finally{second.close();}
  assert.equal(readFileSync(legacy,'utf8'),content);
 }finally{await handler.drain();source.close();rmSync(dir,{recursive:true,force:true});}
});

test('an import error rolls back every row and keeps the JSON intact',()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-import-failure-'));const path=join(dir,'tasks.v1.json');const task=fixture();
 const content=JSON.stringify({version:1,tasks:[task,{}]});writeFileSync(path,content);
 const store=new TaskStore(join(dir,'weaver.db'));
 try{
  assert.throws(()=>store.importTasksJson(path));
  assert.equal(readFileSync(path,'utf8'),content);
  for(const table of ['tasks','task_events','artifacts','owners','packages','receipts','kv','vendor_limits'])assert.equal(store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0);
  writeFileSync(path,JSON.stringify({version:1,tasks:[task]}));store.importTasksJson(path);assert.equal(store.get(task.id).id,task.id);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('schema changes are versioned steps: an empty database climbs from 0, a current one is untouched, vendor ladders and a legacy v1 database upgrade in place',()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-migrate-'));
 try{
  const path=join(dir,'weaver.db');const raw=new DatabaseSync(path);
  assert.equal(Number(raw.prepare('PRAGMA user_version').get()!.user_version),0);
  migrate(raw);assert.equal(Number(raw.prepare('PRAGMA user_version').get()!.user_version),SCHEMA_VERSION);
  const tables=(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
  for(const name of ['tasks','policy_engines','policy_owners','policy_owner_workers','policy_workers','policy_settings','policy_blocks','policy_revisions','stall_penalties','stall_history','free_probe_workers','free_probe_history','quota_records','quota_state','vendor_limits'])assert.ok(tables.includes(name),name);
  raw.prepare("INSERT INTO kv(key,body) VALUES ('sequence','7')").run();migrate(raw);assert.equal(raw.prepare('SELECT body FROM kv').get()!.body,'7','running again changes nothing');raw.close();
  // A database stopped at an older version gets only the missing steps and keeps its rows.
  const old=new DatabaseSync(join(dir,'old.db'));
  old.exec("CREATE TABLE kv(key TEXT PRIMARY KEY, body TEXT NOT NULL); INSERT INTO kv VALUES ('sequence','3'); PRAGMA user_version=0");
  migrate(old);assert.equal(old.prepare('SELECT body FROM kv').get()!.body,'3');assert.equal(Number(old.prepare('PRAGMA user_version').get()!.user_version),SCHEMA_VERSION);old.close();
  const newer=new DatabaseSync(join(dir,'newer.db'));newer.exec(`PRAGMA user_version=${SCHEMA_VERSION+1}`);assert.throws(()=>migrate(newer),/newer than this build supports/);newer.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('opening the product stores never creates or reads a *.v1.json',()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-nojson-'));
 try{
  writeFileSync(join(dir,'tasks.v1.json'),'not even json');writeFileSync(join(dir,'policy.v1.json'),'not even json');writeFileSync(join(dir,'stall.v1.json'),'not even json');
  const store=new TaskStore(join(dir,'weaver.db'));const policy=new PolicyStore(store.db);
  assert.equal(policy.snapshot().revision,0);assert.equal(store.list().length,0);store.close();
  assert.deepEqual(readdirSync(dir).filter(name=>/\.v1\.json/.test(name)).sort(),['policy.v1.json','stall.v1.json','tasks.v1.json'],'only the files the test put there');
  for(const name of ['tasks.v1.json','policy.v1.json','stall.v1.json'])assert.equal(readFileSync(join(dir,name),'utf8'),'not even json');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('notify bursts coalesce; changes during a pump schedule another turn; manual historical results are not delivered',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-pump-'));const store=new TaskStore(join(dir,'weaver.db'));const manager=new TaskManager(store,adapter);
 const owner:LogicalOwner={id:randomUUID(),name:'manual',profileId:'codex_owner',mode:'manual',state:'attached',createdAt:new Date().toISOString()};store.putOwner(owner);
 const task={...fixture(),status:'completed' as const,ownerId:owner.id};store.put(task);
 const handler=new CommandHandler(manager,new PolicyStore(join(dir,'weaver.db')));
 try{
  await turn();let scans=0,reads=0;const list=store.listHeads.bind(store),get=store.get.bind(store);
  store.listHeads=()=>{scans++;if(scans===1)manager.notify();return list();};store.get=id=>{reads++;return get(id);};
  for(let i=0;i<100;i++)manager.notify();assert.equal(scans,0);
  await turn();assert.equal(scans,2);await turn();assert.equal(scans,4);await turn();assert.equal(scans,4);assert.equal(reads,0);
 }finally{await handler.drain();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('durable command intent and running state are visible to a second connection before a spawn effect',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-intent-'));const store=new TaskStore(join(dir,'weaver.db'));let inspected=false;
 const manager=new TaskManager(store,{id:'mock-jsonl',start:task=>{
  const observer=new TaskStore(store.path);try{assert.ok(observer.getReceipt('local-demo:spawn-proof')?.hash);assert.equal(observer.getReceipt('local-demo:spawn-proof')?.response,undefined);assert.equal(observer.get(task.id).status,'running');assert.equal(observer.get(task.id).run?.pid,undefined);inspected=true;}finally{observer.close();}
  throw Error('fixture spawn failure');
 }});
 const handler=new CommandHandler(manager,new PolicyStore(join(dir,'weaver.db')));
 try {
  const task=manager.create(input);
  const result=handler.handle({apiVersion:'weaver.v1',commandId:'spawn-proof',command:'workers.spawn',args:{taskId:task.id,provider:'mock-jsonl'}});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(inspected,true);assert.equal(store.get(task.id).status,'failed');assert.deepEqual(store.getReceipt('local-demo:spawn-proof')?.response,JSON.parse(JSON.stringify(result)));
 }finally{await handler.drain();store.close();rmSync(dir,{recursive:true,force:true});}
});
