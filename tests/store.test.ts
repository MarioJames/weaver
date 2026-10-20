import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/main/store';
import { event } from '../src/main/domain/tasks';
import { recoverInterruptedTasks } from '../src/main/application/tasks/recovery';
import { SCHEMA_VERSION } from '../src/main/migrate';
import { REAL_ENGINE_KINDS } from '../src/main/workspace';
import type { Task } from '../src/shared/contracts/tasks';
function fixture(): Task {return {id:randomUUID(),title:'test',instruction:'test',owner:{name:'owner',transport:'herdr-visible',session:'main',pane:'1'},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'running',progress:20,events:[],artifacts:[],run:{id:randomUUID(),adapter:'mock-jsonl',status:'running',pid:123}};}
test('persists, returns isolated copies, and recovers interrupted task without PID reuse',() => {
 const dir=mkdtempSync(join(tmpdir(),'weaver-store-')); try {
  const path=join(dir,'weaver.db'); const store=new TaskStore(path); const task=fixture(); store.put(task); task.title='changed';
  assert.equal(store.get(task.id).title,'test'); const copy=store.list(); copy[0].title='also changed'; assert.equal(store.get(task.id).title,'test');
  const reloaded=new TaskStore(path); recoverInterruptedTasks(reloaded); const recovered=reloaded.get(task.id); assert.equal(recovered.status,'failed'); assert.equal(recovered.run?.pid,undefined); assert.equal(recovered.run?.status,'stopped');
  assert.equal(new TaskStore(path).get(task.id).status,'failed');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('a database from a newer schema is refused',() => {
 const dir=mkdtempSync(join(tmpdir(),'weaver-store-')); try {
  const db=join(dir,'weaver.db'); const store=new TaskStore(db);
  store.close();
  const raw=new DatabaseSync(db);raw.exec(`PRAGMA user_version=${SCHEMA_VERSION+1}`);raw.close();
  assert.throws(() => new TaskStore(db),/newer than this build supports/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('bounds event retention to 500',() => {const task=fixture();for(let i=0;i<510;i++)event(task,'log',String(i));assert.equal(task.events.length,500);assert.equal(task.events[0].message,'10');});
test('every real engine kind round-trips through a persisted run',() => {
 const dir=mkdtempSync(join(tmpdir(),'weaver-store-'));try {
  const path=join(dir,'weaver.db');
  for(const kind of REAL_ENGINE_KINDS){
   const task={...fixture(),status:'completed' as const,run:{id:randomUUID(),adapter:kind,execution:'real' as const,status:'stopped' as const,evidence:{engine:kind,requestedModel:'m',requestedEffort:'high',workspace:dir,terminal:'success' as const,promptPath:join(dir,'prompt-1.txt'),vendorSessionId:`session-${kind}`}}};
   const writer=new TaskStore(path);writer.put(task);writer.close();
   const reader=new TaskStore(path);const run=reader.get(task.id).run;
   assert.equal(run?.adapter,kind);assert.equal(run?.evidence?.promptPath,join(dir,'prompt-1.txt'));assert.equal(run?.evidence?.vendorSessionId,`session-${kind}`);reader.close();
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
