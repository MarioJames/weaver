import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TaskStore, event } from '../src/main/store';
import type { Task } from '../src/shared/types';
function fixture(): Task {return {id:randomUUID(),title:'test',instruction:'test',owner:{name:'owner',transport:'herdr-visible',session:'main',pane:'1'},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'running',progress:20,events:[],artifacts:[],run:{id:randomUUID(),adapter:'mock-jsonl',status:'running',pid:123}};}
test('persists, returns isolated copies, and recovers interrupted task without PID reuse',() => {
 const dir=mkdtempSync(join(tmpdir(),'weaver-store-')); try {
  const path=join(dir,'tasks.json'); const store=new TaskStore(path); const task=fixture(); store.put(task); task.title='changed';
  assert.equal(store.get(task.id).title,'test'); const copy=store.list(); copy[0].title='also changed'; assert.equal(store.get(task.id).title,'test');
  const reloaded=new TaskStore(path); reloaded.recover(); const recovered=reloaded.get(task.id); assert.equal(recovered.status,'failed'); assert.equal(recovered.run?.pid,undefined); assert.equal(recovered.run?.status,'stopped');
  assert.equal(new TaskStore(path).get(task.id).status,'failed');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('corrupted and future-schema stores are retained unchanged',() => {
 const dir=mkdtempSync(join(tmpdir(),'weaver-store-')); try {
  const path=join(dir,'tasks.json'); for (const content of ['invalid','{"version":2,"tasks":[]}','{"version":1,"tasks":[{}]}']) {writeFileSync(path,content);assert.throws(() => new TaskStore(path));assert.equal(readFileSync(path,'utf8'),content);}
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('bounds event retention to 500',() => {const task=fixture();for(let i=0;i<510;i++)event(task,'log',String(i));assert.equal(task.events.length,500);assert.equal(task.events[0].message,'10');});
test('nested persisted records are validated before renderer exposure',() => {
 const dir=mkdtempSync(join(tmpdir(),'weaver-store-'));try {
  const path=join(dir,'tasks.json');const task=fixture();
  for(const bad of [{...task,artifacts:[{id:randomUUID(),name:'../secret',mediaType:'text/plain',content:'x',createdAt:new Date().toISOString()}]},{...task,events:[{id:randomUUID(),at:'bad',kind:'log',message:'x'}]},{...task,run:{...task.run,pid:'wrong'}}]){
   const content=JSON.stringify({version:1,tasks:[bad]});writeFileSync(path,content);assert.throws(()=>new TaskStore(path));assert.equal(readFileSync(path,'utf8'),content);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
