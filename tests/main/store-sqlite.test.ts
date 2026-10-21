import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../../src/main/store';
import { event } from '../../src/main/domain/tasks';
import { SCHEMA_VERSION, migrate } from '../../src/main/migrate';
import { TaskManager } from '../../src/main/manager';
import { CommandHandler } from '../../src/main/commands';
import { PolicyStore } from '../../src/main/policy/store';
import type { Task } from '../../src/shared/contracts/tasks';
import type { LogicalOwner } from '../../src/shared/contracts/owners';
import type { WorkPackage } from '../../src/shared/contracts/tasks';
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

test('schema changes are versioned steps: an empty database climbs from 0, a current one is untouched, vendor ladders and a legacy v1 database upgrade in place',()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-migrate-'));
 try{
  const path=join(dir,'weaver.db');const raw=new DatabaseSync(path);
  assert.equal(Number(raw.prepare('PRAGMA user_version').get()!.user_version),0);
  migrate(raw);assert.equal(Number(raw.prepare('PRAGMA user_version').get()!.user_version),SCHEMA_VERSION);
  const tables=(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
  for(const name of ['tasks','policy_engines','policy_owners','policy_owner_workers','policy_workers','policy_settings','policy_blocks','policy_revisions','stall_penalties','stall_history','free_probe_workers','free_probe_history','quota_records','quota_state','vendor_worker_limits'])assert.ok(tables.includes(name),name);
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

test('upgrading a version 6 database keeps its blocks, adds the worker column and the per-worker ladder, and repeats cleanly',()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-migrate7-'));const path=join(dir,'weaver.db');
 try{
  // Build the shape step 6 left behind: no worker column, the per-engine ladder table.
  const seeded=new PolicyStore(path);
  const base=seeded.snapshot();
  seeded.save({revision:base.revision,config:base.config,blocks:[{engine:'codex',reason:'manual hold',since:'2026-10-19T00:00:00.000Z',by:'manual'},{engine:'qoder',model:'m1',reason:'model hold',since:'2026-10-19T00:00:00.000Z',release_at:'2030-01-01T00:00:00.000Z',by:'weaver-free-probe'}]});
  const before=seeded.snapshot().blocks;
  const raw=new DatabaseSync(path);
  raw.exec('ALTER TABLE policy_workers DROP COLUMN max_parallel; ALTER TABLE policy_owners ADD COLUMN proxy TEXT; ALTER TABLE policy_workers ADD COLUMN proxy TEXT; ALTER TABLE policy_blocks DROP COLUMN worker; DROP TABLE vendor_worker_limits; CREATE TABLE vendor_limits(engine TEXT PRIMARY KEY, level INTEGER NOT NULL, last_trigger_at INTEGER NOT NULL); INSERT INTO vendor_limits VALUES (\'codex\',2,123); PRAGMA user_version=6');
  assert.deepEqual((raw.prepare('PRAGMA table_info(policy_blocks)').all() as {name:string}[]).map(column=>column.name).includes('worker'),false);
  raw.close();
  for(let round=0;round<3;round++){
   const upgraded=new DatabaseSync(path);migrate(upgraded);
   assert.equal(Number(upgraded.prepare('PRAGMA user_version').get()!.user_version),SCHEMA_VERSION);
   const columns=(upgraded.prepare('PRAGMA table_info(policy_blocks)').all() as {name:string}[]).map(column=>column.name);
   assert.ok(columns.includes('worker'));
   const tables=(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name);
   assert.ok(tables.includes('vendor_worker_limits'));assert.ok(!tables.includes('vendor_limits'));
   upgraded.close();
   const reopened=new PolicyStore(path);assert.deepEqual(reopened.snapshot().blocks,before,`round ${round}: existing blocks survive the upgrade`);
  }
  const store=new PolicyStore(path);const snapshot=store.snapshot();
  store.save({revision:snapshot.revision,config:snapshot.config,blocks:[...snapshot.blocks,{engine:'codex',worker:'codex_worker',reason:'worker hold',since:'2026-10-19T00:00:00.000Z',by:'weaver-vendor-limit'}]});
  assert.equal(new PolicyStore(path).snapshot().blocks.at(-1)?.worker,'codex_worker','the worker field round-trips through policy_blocks');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('upgrading a version 7 database drops the role proxy columns and strips proxy from saved policy snapshots, so a rollback still works',()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-migrate8-'));const path=join(dir,'weaver.db');
 try{
  const seeded=new PolicyStore(path);
  const base=seeded.snapshot();
  const changed=structuredClone(base.config);const ownerId=Object.keys(changed.owners)[0]!;const workerId=Object.keys(changed.workers)[0]!;
  changed.owners[ownerId]!.max_parallel=3;
  const first=seeded.save({revision:base.revision,config:changed,blocks:[]});
  const later=structuredClone(first.config);later.owners[ownerId]!.max_parallel=4;
  seeded.save({revision:first.revision,config:later,blocks:[]});
  const expected=seeded.snapshot().config;
  const raw=new DatabaseSync(path);
  // Rebuild the shape version 7 left behind: proxy columns with values, and snapshots that carry the field.
  raw.exec('ALTER TABLE policy_workers DROP COLUMN max_parallel; ALTER TABLE policy_owners ADD COLUMN proxy TEXT; ALTER TABLE policy_workers ADD COLUMN proxy TEXT');
  raw.prepare('UPDATE policy_owners SET proxy=?').run('direct');raw.prepare('UPDATE policy_workers SET proxy=?').run('http://127.0.0.1:7890');
  const revisions=raw.prepare('SELECT revision,body FROM policy_revisions ORDER BY revision').all() as {revision:number;body:string}[];
  assert.ok(revisions.length>=2);
  const withProxy=(body:string)=>{const data=JSON.parse(body);for(const owner of Object.values(data.config.owners))(owner as Record<string,unknown>).proxy='inherit';for(const worker of Object.values(data.config.workers))(worker as Record<string,unknown>).proxy='http://127.0.0.1:7890';return JSON.stringify(data);};
  const originals=new Map<number,string>();
  for(const row of revisions){originals.set(row.revision,row.body);raw.prepare('UPDATE policy_revisions SET body=? WHERE revision=?').run(withProxy(row.body),row.revision);}
  // Snapshots with no owners or workers, or without a config section, must come through unchanged.
  const empty=JSON.stringify({version:1,revision:90,config:{version:1,owners:{},workers:{}},blocks:[]});
  const bare=JSON.stringify({version:1,revision:91,config:{version:1},blocks:[]});
  const odd=JSON.stringify({version:1,revision:92,config:{owners:{a:'text',b:{proxy:'direct',keep:1}},workers:[]},blocks:[]});
  const broken='not json';
  for(const [revision,body] of [[90,empty],[91,bare],[92,odd],[93,broken]] as const)raw.prepare("INSERT INTO policy_revisions(revision,saved_at,source,body) VALUES (?,?,'test',?)").run(revision,'2026-10-19T00:00:00.000Z',body);
  raw.exec('PRAGMA user_version=7');
  raw.close();
  for(let round=0;round<3;round++){
   const upgraded=new DatabaseSync(path);migrate(upgraded);
   assert.equal(Number(upgraded.prepare('PRAGMA user_version').get()!.user_version),SCHEMA_VERSION);
   for(const table of ['policy_owners','policy_workers'])assert.equal((upgraded.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).some(column=>column.name==='proxy'),false,`${table}.proxy is gone`);
   assert.equal(Number(upgraded.prepare('SELECT count(*) n FROM policy_owners').get()!.n),Object.keys(expected.owners).length,'role rows survive');
   const bodies=new Map((upgraded.prepare('SELECT revision,body FROM policy_revisions').all() as {revision:number;body:string}[]).map(row=>[row.revision,row.body]));
   for(const [revision,body] of originals)assert.equal(bodies.get(revision),body,`round ${round}: revision ${revision} is back to its pre-proxy snapshot, every other field intact`);
   assert.equal(bodies.get(93),broken);assert.equal(bodies.get(90),empty);assert.equal(bodies.get(91),bare);
   assert.deepEqual(JSON.parse(bodies.get(92)!),{version:1,revision:92,config:{owners:{a:'text',b:{keep:1}},workers:[]},blocks:[]});
   upgraded.close();
  }
  const store=new PolicyStore(path);
  assert.deepEqual(store.snapshot().config,expected,'live config reads without the proxy columns');
  const rolled=store.rollback(Math.min(...originals.keys()));
  assert.equal(rolled.config.owners[ownerId]!.max_parallel,3,'the oldest snapshot is restored');
  assert.equal('proxy' in rolled.config.owners[ownerId]!,false);assert.equal('proxy' in rolled.config.workers[workerId]!,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
