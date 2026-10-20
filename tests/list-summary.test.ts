import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../src/main/store';
import type { Task } from '../src/shared/contracts/tasks';

const at='2026-10-19T00:00:00Z';
function fixture(i:number):Task {
 return {id:`task-${i}`,title:`Task ${i}`,instruction:'Synthetic prompt',owner:{name:'fixture',transport:'herdr-visible',session:'test',pane:'1'},createdAt:at,updatedAt:at,status:'running',progress:50,revision:1,
  events:Array.from({length:300},(_,j)=>({id:`e${j}`,at,kind:'log',message:'stream output'})),
  artifacts:[{id:'artifact',name:'result.md',mediaType:'text/markdown',createdAt:at,content:'x'.repeat(4096)}]};
}
test('300-task list stays below 300 KB while single-task reads retain full history and artifact bodies',()=>{
 const root=mkdtempSync(join(tmpdir(),'weaver-list-summary-'));
 const store=new TaskStore(join(root,'weaver.db'));
 try {
  store.transaction(()=>{for(let i=0;i<300;i++)store.put(fixture(i));});
  const summaries=store.listSummaries();
  assert.equal(summaries.length,300);
  assert.ok(Buffer.byteLength(JSON.stringify(summaries))<300_000);
  assert.deepEqual(summaries[0].events.map(event=>event.id),['e297','e298','e299']);
  assert.equal(summaries[0].eventCount,300);
  assert.deepEqual(summaries[0].artifacts,[{id:'artifact',name:'result.md',mediaType:'text/markdown',createdAt:at}]);
  assert.equal('content' in summaries[0].artifacts[0],false);
  const detail=store.get(summaries[0].id);
  assert.equal(detail.events.length,300);
  assert.equal(detail.events[0].id,'e0');
  assert.equal(detail.artifacts[0].content,'x'.repeat(4096));
  summaries[0].events[0].message='mutated';summaries[0].owner.name='mutated';
  assert.equal(store.get(detail.id).events[297].message,'stream output');
  assert.equal(store.get(detail.id).owner.name,'fixture');
 } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
