import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import type { WorkerAdapter } from '../../src/main/adapters/worker';
import { CommandHandler } from '../../src/main/commands';
import { PolicyStore } from '../../src/main/policy/store';
import { event, isOmissionMarker, PROCESS_HEAD_RETAINED, PROCESS_TAIL_RETAINED } from '../../src/main/domain/tasks';
import { isTimelineNoise } from '../../src/renderer/features/tasks/log-view';
import type { Task, TaskInput } from '../../src/shared/contracts/tasks';

const input: TaskInput={title:'Long run',instruction:'Safe local fixture only',owner:{name:'owner',transport:'herdr-visible',session:'main',pane:'1'}};
const fixture=(code: string): WorkerAdapter => ({id:'mock-jsonl',start:() => {const child=spawn(process.execPath,['-e',code],{stdio:['pipe','pipe','pipe'],shell:false});child.stdin.end();return child;}});
async function terminal(store: TaskStore,id: string) { const deadline=Date.now()+15000; while (Date.now()<deadline) {const task=store.get(id); if (['completed','failed','cancelled'].includes(task.status)) return task; await new Promise(resolve => setTimeout(resolve,15));} throw new Error('Timed out waiting for task'); }

/** 5000 process records (~500 B each, >2 MiB cumulative) plus one artifact and the terminal result. */
const LONG_RUN=`for(let i=0;i<5000;i++)console.log(JSON.stringify({type:'log',message:'log '+i+' '+'x'.repeat(480)}));console.log(JSON.stringify({type:'artifact',name:'report.md',mediaType:'text/markdown',content:'# done'}));console.log(JSON.stringify({type:'result',summary:'long run ok'}))`;

test('a 5000-record worker run completes with result, summary, artifacts and bounded retention',async () => {
  const dir=mkdtempSync(join(tmpdir(),'weaver-record-retention-')); const store=new TaskStore(join(dir,'weaver.db')); const manager=new TaskManager(store,fixture(LONG_RUN),()=>{},undefined,error=>{throw error;});
  try {
    const task=manager.create(input); manager.start(task.id);
    const done=await terminal(store,task.id);
    assert.equal(done.status,'completed');
    assert.equal(done.summary,'long run ok');
    assert.equal(done.progress,100);
    assert.equal(done.artifacts.length,1); assert.equal(done.artifacts[0].name,'report.md'); assert.equal(done.artifacts[0].content,'# done');
    assert.ok(done.events.length<=500,`timeline stays bounded, saw ${done.events.length}`);
    const markers=done.events.filter(isOmissionMarker);
    assert.equal(markers.length,1,'exactly one omission marker');
    assert.match(markers[0].message,new RegExp(`^已省略 ${5000-PROCESS_HEAD_RETAINED-PROCESS_TAIL_RETAINED} 条过程记录（`));
    const logs=done.events.filter(e=>e.kind==='log'&&!isOmissionMarker(e)&&!e.message.startsWith('stderr: '));
    assert.equal(logs.length,PROCESS_HEAD_RETAINED+PROCESS_TAIL_RETAINED);
    assert.ok(logs[0].message.startsWith('log 0 '),'head of the run is retained');
    assert.ok(logs[PROCESS_HEAD_RETAINED-1].message.startsWith(`log ${PROCESS_HEAD_RETAINED-1} `));
    assert.ok(logs[PROCESS_HEAD_RETAINED].message.startsWith(`log ${5000-PROCESS_TAIL_RETAINED} `),'tail follows the marker');
    assert.ok(logs.at(-1)!.message.startsWith('log 4999 '));
    assert.ok(done.events.some(e=>e.kind==='result'&&e.message==='long run ok'),'terminal result is retained');
    assert.ok(done.events.some(e=>e.kind==='artifact'),'artifact receipt is retained');
    // Durability: the bounded timeline with its marker survives a store reload.
    const reopened=new TaskStore(join(dir,'weaver.db'));
    try {
      const loaded=reopened.get(task.id);
      assert.equal(loaded.status,'completed'); assert.equal(loaded.summary,'long run ok');
      assert.equal(loaded.events.length,done.events.length);
      assert.equal(loaded.events.filter(isOmissionMarker).length,1);
    } finally { reopened.close(); }
  } finally { await manager.shutdown(); rmSync(dir,{recursive:true,force:true}); }
});

test('tasks.events pagination walks the retained timeline including the marker; evicted cursors expire',async () => {
  const dir=mkdtempSync(join(tmpdir(),'weaver-record-pages-')); const store=new TaskStore(join(dir,'weaver.db'));
  const manager=new TaskManager(store,fixture(LONG_RUN),()=>{},undefined,error=>{throw error;});
  const handler=new CommandHandler(manager,new PolicyStore(join(dir,'weaver.db')));
  const call=(command:string,args:Record<string,unknown>):any=>{const r=handler.handle({apiVersion:'weaver.v1',commandId:randomUUID(),command,args});assert.equal(r.ok,true,JSON.stringify(r));return (r as {data:any}).data;};
  try {
    const task=manager.create(input); manager.start(task.id);
    assert.equal((await terminal(store,task.id)).status,'completed');
    const seen: string[]=[]; let after: string|undefined; let hasMore=true; let pages=0;
    while(hasMore){
      const page=call('tasks.events',{taskId:task.id,limit:100,...(after?{after}:{})});
      assert.ok(page.events.length<=100); pages++;
      for(const e of page.events) seen.push(e.message);
      hasMore=page.hasMore; after=page.nextCursor;
      if(pages>10) throw new Error('pagination did not terminate');
    }
    assert.ok(pages>1,'a long run spans several pages');
    const markers=seen.filter(m=>/^已省略 \d+ 条过程记录（/.test(m));
    assert.equal(markers.length,1,'the marker is reachable through pagination');
    assert.ok(seen.includes('long run ok'),'the terminal result page is reachable');
    assert.ok(seen[0].includes('Task queued'),'pagination starts at the retained head');
    assert.equal(call('tasks.events',{taskId:task.id,limit:100,after}).events.length,0,'the final cursor has nothing after it');
    const expired=handler.handle({apiVersion:'weaver.v1',commandId:randomUUID(),command:'tasks.events',args:{taskId:task.id,after:'00000000-0000-0000-0000-000000000000'}});
    assert.equal(expired.ok,false); assert.equal((expired as {error:{code:string}}).error.code,'CURSOR_EXPIRED');
  } finally { handler.draining=true; await manager.shutdown(); rmSync(dir,{recursive:true,force:true}); }
});

test('decisive records survive process-record eviction and the marker is not timeline noise',() => {
  const at=new Date().toISOString();
  const task: Task={id:randomUUID(),title:'t',instruction:'i',owner:{name:'o',transport:'herdr-visible',session:'s',pane:'1'} as const,createdAt:at,updatedAt:at,status:'running' as const,progress:0,events:[],artifacts:[]};
  event(task,'lifecycle','Task queued');
  for(let i=0;i<600;i++)event(task,'log',`p${i}`);
  event(task,'result','final');
  assert.ok(task.events.length<=500);
  assert.ok(task.events.some(e=>e.kind==='lifecycle'&&e.message==='Task queued'));
  assert.ok(task.events.some(e=>e.kind==='result'&&e.message==='final'));
  const markers=task.events.filter(isOmissionMarker);
  assert.equal(markers.length,1);
  for(const marker of markers) assert.equal(isTimelineNoise(marker),false,'the omission marker renders as its own timeline item');
});

test('an oversized single line still fails the run instead of being retained',async () => {
  const dir=mkdtempSync(join(tmpdir(),'weaver-record-line-')); const store=new TaskStore(join(dir,'weaver.db')); const manager=new TaskManager(store,fixture(`console.log(JSON.stringify({type:'log',message:'x'.repeat(129*1024)}))`),()=>{},undefined,error=>{throw error;});
  try {
    const task=manager.create(input); manager.start(task.id);
    const done=await terminal(store,task.id);
    assert.equal(done.status,'failed'); assert.match(done.failure?.message??'',/128 KiB/);
  } finally { await manager.shutdown(); rmSync(dir,{recursive:true,force:true}); }
});
