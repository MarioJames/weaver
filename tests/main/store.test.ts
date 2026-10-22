import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../../src/main/store';
import { event } from '../../src/main/domain/tasks';
import { recoverInterruptedTasks } from '../../src/main/application/tasks/recovery';
import { SCHEMA_VERSION } from '../../src/main/migrate';
import { REAL_ENGINE_KINDS } from '../../src/main/workspace';
import type { Task } from '../../src/shared/contracts/tasks';
const pkgTmp=mkdtempSync(join(tmpdir(),'wv-store-'));
after(()=>rmSync(pkgTmp,{recursive:true,force:true}));
function fixture(): Task {return {id:randomUUID(),title:'test',instruction:'test',owner:{name:'owner',transport:'herdr-visible',session:'main',pane:'1'},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'running',progress:20,events:[],artifacts:[],run:{id:randomUUID(),adapter:'mock-jsonl',status:'running',pid:123}};}
test('persists, returns isolated copies, and recovers interrupted task without PID reuse',() => {
 const dir=mkdtempSync(join(tmpdir(),'wv-store-')); try {
  const path=join(dir,'weaver.db'); const store=new TaskStore(path); const task=fixture(); store.put(task); task.title='changed';
  assert.equal(store.get(task.id).title,'test'); const copy=store.list(); copy[0].title='also changed'; assert.equal(store.get(task.id).title,'test');
  const reloaded=new TaskStore(path); recoverInterruptedTasks(reloaded); const recovered=reloaded.get(task.id); assert.equal(recovered.status,'failed'); assert.equal(recovered.run?.pid,undefined); assert.equal(recovered.run?.status,'stopped');
  assert.equal(new TaskStore(path).get(task.id).status,'failed');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('a database from a newer schema is refused',() => {
 const dir=mkdtempSync(join(tmpdir(),'wv-store-')); try {
  const db=join(dir,'weaver.db'); const store=new TaskStore(db);
  store.close();
  const raw=new DatabaseSync(db);raw.exec(`PRAGMA user_version=${SCHEMA_VERSION+1}`);raw.close();
  assert.throws(() => new TaskStore(db),/newer than this build supports/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('process records keep head and tail with one omission marker under the 500 bound',() => {const task=fixture();for(let i=0;i<510;i++)event(task,'log',String(i));assert.equal(task.events.length,451);assert.deepEqual(task.events.slice(0,50).map(e=>e.message),Array.from({length:50},(_,i)=>String(i)));assert.match(task.events[50].message,/^已省略 60 条过程记录（/);assert.deepEqual(task.events.slice(51).map(e=>e.message),Array.from({length:400},(_,i)=>String(i+110)));});
test('every real engine kind round-trips through a persisted run',() => {
  const dir=mkdtempSync(join(tmpdir(),'wv-store-'));try {
   const path=join(dir,'weaver.db');
   for(const kind of REAL_ENGINE_KINDS){
    const task={...fixture(),status:'completed' as const,run:{id:randomUUID(),adapter:kind,execution:'real' as const,status:'stopped' as const,evidence:{engine:kind,requestedModel:'m',requestedEffort:'high',workspace:dir,terminal:'success' as const,promptPath:join(dir,'prompt-1.txt'),vendorSessionId:`session-${kind}`}}};
    const writer=new TaskStore(path);writer.put(task);writer.close();
    const reader=new TaskStore(path);const run=reader.get(task.id).run;
    assert.equal(run?.adapter,kind);assert.equal(run?.evidence?.promptPath,join(dir,'prompt-1.txt'));assert.equal(run?.evidence?.vendorSessionId,`session-${kind}`);reader.close();
   }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('committed views hide pending stream records while live reads keep read-your-writes',() => {
  mkdirSync(pkgTmp,{recursive:true});const dir=mkdtempSync(join(pkgTmp,'weaver-store-committed-'));try {
   const store=new TaskStore(join(dir,'weaver.db'));
   const task=fixture();store.put(task);
   event(task,'log','pending-event');store.put(task,'stream');
   assert.equal(store.get(task.id).events.at(-1)?.message,'pending-event');
   assert.equal(store.getCommitted(task.id).events.length,0);
   assert.equal(store.listHeadsCommitted().length,1);
   const summaries=store.listSummariesCommitted();
   assert.equal(summaries.length,1);assert.equal(summaries[0]!.eventCount,0);assert.deepEqual(summaries[0]!.events,[]);
   const ghost=fixture();event(ghost,'log','ghost');store.put(ghost,'stream');
   assert.throws(()=>store.getCommitted(ghost.id),/Task not found/);
   assert.ok(store.listHeads().some(t=>t.id===ghost.id));
   assert.ok(!store.listHeadsCommitted().some(t=>t.id===ghost.id));
   assert.ok(!store.listSummariesCommitted().some(t=>t.id===ghost.id));
   store.flush();
   assert.equal(store.getCommitted(task.id).events.at(-1)?.message,'pending-event');
   assert.equal(store.getCommitted(ghost.id).events.at(-1)?.message,'ghost');
   assert.equal(store.listSummariesCommitted().find(t=>t.id===task.id)?.eventCount,1);
   store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('onCommit fires after a real COMMIT, not on rollback or nested savepoint, and flush commits fire it',t => {
  t.mock.timers.enable({apis:['setTimeout']});
  mkdirSync(pkgTmp,{recursive:true});const dir=mkdtempSync(join(pkgTmp,'weaver-store-oncommit-'));try {
   const store=new TaskStore(join(dir,'weaver.db'));
   let commits=0;const off=store.onCommit(()=>{commits++;});
   const task=fixture();store.put(task);assert.equal(commits,1);
   store.transaction(()=>{store.put(fixture());store.transaction(()=>{store.put(fixture());});});
   assert.equal(commits,2);
   assert.throws(()=>store.transaction(()=>{store.put(fixture());throw new Error('rollback');}),/rollback/);
   assert.equal(commits,2);
   assert.equal(store.listHeadsCommitted().length,3);
   const streamed=store.get(task.id);event(streamed,'log','pending');store.put(streamed,'stream');
   assert.equal(commits,2);
   t.mock.timers.tick(500);assert.equal(commits,3);
   assert.equal(store.getCommitted(task.id).events.at(-1)?.message,'pending');
   const flushed=store.get(task.id);event(flushed,'log','manual');store.put(flushed,'stream');
   store.flush();assert.equal(commits,4);
   off();store.put(fixture());assert.equal(commits,4);
   store.close();
  }finally{rmSync(dir,{recursive:true,force:true});t.mock.timers.reset();}
});
