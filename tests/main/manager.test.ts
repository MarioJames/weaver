import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { TaskStore } from '../../src/main/store';
import { executionTimeoutMs, TaskManager } from '../../src/main/manager';
import { MockWorkerAdapter, type WorkerAdapter } from '../../src/main/adapters/worker';
import type { TaskInput } from '../../src/shared/contracts/tasks';
const input: TaskInput={title:'Demo',instruction:'Safe local fixture only',owner:{name:'owner',transport:'herdr-visible',session:'main',pane:'1'}};
const fixture=(code: string): WorkerAdapter => ({id:'mock-jsonl',start:() => {const child=spawn(process.execPath,['-e',code],{stdio:['pipe','pipe','pipe'],shell:false});child.stdin.end();return child;}});
async function terminal(store: TaskStore,id: string) { const deadline=Date.now()+5000; while (Date.now()<deadline) {const task=store.get(id); if (['completed','failed','cancelled'].includes(task.status)) return task; await new Promise(resolve => setTimeout(resolve,15));} throw new Error('Timed out waiting for task'); }
async function harness(adapter: WorkerAdapter,fn:(manager:TaskManager,store:TaskStore)=>Promise<void>,timeout=3000) {
 const dir=mkdtempSync(join(tmpdir(),'weaver-manager-')); const store=new TaskStore(join(dir,'weaver.db')); const manager=new TaskManager(store,adapter,()=>{},timeout,error=>{throw error;});
 try {await fn(manager,store);} finally {await manager.shutdown();rmSync(dir,{recursive:true,force:true});}
}
test('bundled mock worker completes a task and persists artifact',async () => {
 await harness(new MockWorkerAdapter(process.execPath,resolve('scripts/mock-worker.mjs')),async (manager,store) => {
  const task=manager.create(input); const running=manager.start(task.id); assert.equal(running.status,'running'); assert.ok(running.run?.pid);
  assert.throws(()=>manager.start(task.id),/queued/);
  const done=await terminal(store,task.id);assert.equal(done.status,'completed');assert.equal(done.progress,100);assert.equal(done.artifacts[0].name,'mock-result.md');assert.match(done.summary!,/Mock task/);assert.equal(done.run?.pid,undefined);
 });
});
test('queued cancellation never launches; running cancellation waits for child exit',async () => {
 await harness(fixture('setInterval(()=>{},1000)'),async (manager,store) => {
  const queued=manager.create(input); assert.equal(manager.cancel(queued.id).status,'cancelled'); assert.equal(store.get(queued.id).run,undefined);
  const task=manager.create(input);manager.start(task.id);assert.equal(manager.cancel(task.id).status,'cancelling');assert.equal(manager.cancel(task.id).status,'cancelling');assert.equal((await terminal(store,task.id)).status,'cancelled');
 });
});
test('malformed JSON, missing result, nonzero exit, and trailing record fail',async () => {
 for (const code of ["console.log('oops')","console.log(JSON.stringify({type:'log',message:'done?'}))","console.log(JSON.stringify({type:'result',summary:'false success'}));process.exitCode=2","console.log(JSON.stringify({type:'result',summary:'done'}));console.log(JSON.stringify({type:'log',message:'late'}))"]) {
  await harness(fixture(code),async(manager,store)=>{const task=manager.create(input);manager.start(task.id);assert.equal((await terminal(store,task.id)).status,'failed');});
 }
});
test('spawn failure yields failed task rather than stuck running',async () => {
 await harness(new MockWorkerAdapter('/nonexistent-weaver-executable','unused'),async(manager,store)=>{const task=manager.create(input);manager.start(task.id);assert.equal((await terminal(store,task.id)).status,'failed');});
});
test('configured owner concurrency replaces the old global cap of two',async () => {
 await harness(fixture('setInterval(()=>{},1000)'),async(manager,store)=>{
  const tasks=[manager.create(input),manager.create(input),manager.create(input)];
  for (const task of tasks) { task.dispatch={owner:'owner',worker:'worker',engine:'codex',model:'m',effort:'high',execution:'mock',maxParallel:2}; manager.update(task); }
  manager.start(tasks[0].id);manager.start(tasks[1].id);assert.throws(()=>manager.start(tasks[2].id),/configured concurrency limit \(2\)/);assert.equal(store.get(tasks[2].id).status,'queued');
  const done=await terminal(store,tasks[0].id);assert.equal(done.status,'failed');assert.match(done.events.at(-1)!.message,/test timeout/);
  assert.equal('timeoutMs' in done.run!,false);
 },100);
});
test('only a mock run may take the test-hook timer; real and native never do',() => {
 const route=(execution:'real'|'mock'|'native')=>({dispatch:{owner:'o',worker:'w',engine:'codex',model:'m',effort:'high',execution,maxParallel:1,maxWaitMinutes:15}});
 assert.equal(executionTimeoutMs(route('real'),60_000),undefined);
 assert.equal(executionTimeoutMs(route('native'),60_000),undefined);
 assert.equal(executionTimeoutMs(route('mock'),100),100);
 assert.equal(executionTimeoutMs(route('mock')),undefined);
 assert.equal(executionTimeoutMs({},100),100);
});
test('shutdown terminates active workers and persists cancelled states',async () => {
 await harness(fixture('setInterval(()=>{},1000)'),async(manager,store)=>{const task=manager.create(input);manager.start(task.id);await manager.shutdown();assert.equal(store.get(task.id).status,'cancelled');});
});
test('result without exit is still running, then timeout fails it',async () => {
 await harness(fixture("console.log(JSON.stringify({type:'result',summary:'not finished'}));setInterval(()=>{},1000)"),async(manager,store)=>{
  const task=manager.create(input); manager.start(task.id);
  const deadline=Date.now()+1500; while(!store.get(task.id).events.some(event=>event.kind==='result') && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(store.get(task.id).status,'running'); assert.ok(store.get(task.id).events.some(event=>event.kind==='result'));
  const done=await terminal(store,task.id); assert.equal(done.status,'failed');assert.match(done.events.at(-1)!.message,/timeout/);
 },2000);
});
test('truncated JSON fails, but oversized stderr is clipped into bounded records instead of failing',async () => {
  await harness(fixture("process.stdout.write('{\\\"type\\\":')"),async(manager,store)=>{const task=manager.create(input);manager.start(task.id);assert.equal((await terminal(store,task.id)).status,'failed');});
  await harness(fixture("process.stderr.write('x'.repeat(40000));console.log(JSON.stringify({type:'result',summary:'stderr ok'}))"),async(manager,store)=>{
   const task=manager.create(input);manager.start(task.id);const done=await terminal(store,task.id);
   assert.equal(done.status,'completed');assert.equal(done.summary,'stderr ok');
   const logged=done.events.find(e=>e.kind==='log'&&e.message.startsWith('stderr: '));
   assert.ok(logged,'stderr is kept as a timeline record');assert.ok(logged!.message.length<=8100,'stderr record is clipped');
  });
});
test('artifact overflow keeps the first 20 and the result instead of failing the run',async () => {
  await harness(fixture("for(let i=0;i<21;i++)console.log(JSON.stringify({type:'artifact',name:'x.txt',mediaType:'text/plain',content:'x'}));console.log(JSON.stringify({type:'result',summary:'artifacts ok'}))"),async(manager,store)=>{const task=manager.create(input);manager.start(task.id);const done=await terminal(store,task.id);assert.equal(done.status,'completed');assert.equal(done.artifacts.length,20);assert.equal(done.summary,'artifacts ok');assert.ok(done.events.some(e=>e.kind==='log'&&/Artifact limit reached/.test(e.message)));});
});

test('escaped-scope cleanup is recorded on the task timeline',async()=>{
 const adapter:WorkerAdapter={id:'real-fixture',start:()=>{
  const child=spawn(process.execPath,['-e',"process.stdout.write(JSON.stringify({type:'result',summary:'ready'})+'\\n');setInterval(()=>{},1000)"],{stdio:['pipe','pipe','pipe'],shell:false});
  child.stdin.end();
  setTimeout(()=>child.emit('cleanup',{units:['escape-1234.scope'],pids:[4321,4322]}),25);
  return child;
 }};
 await harness(adapter,async(manager,store)=>{
  const task=manager.create(input);
  task.dispatch={owner:'owner',worker:'worker',engine:'codex',model:'m',effort:'high',execution:'real',maxParallel:1};
  manager.update(task);
  manager.start(task.id);
  const deadline=Date.now()+5000;
  while(Date.now()<deadline&&!store.get(task.id).events.some(item=>/Cleaned escaped worker processes/.test(item.message)))await new Promise(resolve=>setTimeout(resolve,10));
  const record=store.get(task.id).events.find(item=>/Cleaned escaped worker processes/.test(item.message));
  assert.ok(record,JSON.stringify(store.get(task.id).events));
  assert.match(record!.message,/escape-1234\.scope/);
  assert.match(record!.message,/4321, 4322/);
  manager.cancel(task.id);
  assert.equal((await terminal(store,task.id)).status,'cancelled');
 },3000);
});
