import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startRuntime } from '../src/main/runtime';
import { sendRequest } from '../src/cli/client';
import { applyCallerWorkspace } from '../src/cli/input';
import { QuotaProber } from '../src/main/quota';
import { CommandHandler } from '../src/main/commands';
import { TaskManager } from '../src/main/manager';
import { TaskStore, slotGroupCount, slotGroupFor } from '../src/main/store';
import { PolicyStore } from '../src/main/policy/store';
import type { OwnerLaunchInput, OwnerLaunchResult } from '../src/main/owner-host';

function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'weaver-task-start-'));
 const store=new TaskStore(join(dir,'weaver.db'));const policy=new PolicyStore(join(dir,'weaver.db'));
 const manager=new TaskManager(store,{id:'forbidden',start(){throw new Error('No worker process allowed');}});
 const launches:{input:OwnerLaunchInput & {signal?:AbortSignal};resolve:(host:OwnerLaunchResult)=>void;reject:(error:Error)=>void}[]=[];
 const closed:OwnerLaunchResult[]=[];
 const handler=new CommandHandler(manager,policy,()=>{throw new Error('No sync host allowed');},()=>true,undefined,{launcher:input=>new Promise((resolve,reject)=>{launches.push({input,resolve,reject});input.signal?.addEventListener('abort',()=>reject(new Error('fixture abort')),{once:true});}),closer:async host=>{closed.push(host);}});
 const raw=(command:string,args:Record<string,unknown>={},commandId:string=randomUUID())=>handler.handle({apiVersion:'weaver.v1',command,args,commandId});
 const call=(command:string,args:Record<string,unknown>={},commandId?:string):any=>{const response=raw(command,args,commandId);assert.equal(response.ok,true,JSON.stringify(response));return response.data;};
 const task=call('tasks.create',{goal:'完整原始目标'.repeat(1000),workspace:dir,ownerProfileId:'codex_owner',constraints:['保留完整约束']});
 const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));};
 const launch=async()=>{await settle();const pending=launches.at(-1)!;pending.resolve({session:'fake',workspaceId:'fake-workspace',paneId:'fake-pane',agentName:`owner-${task.id.slice(0,8)}-0`});await settle();};
 return {dir,store,policy,manager,handler,raw,call,task,launches,closed,settle,launch,async close(){await handler.drain();await manager.shutdown();rmSync(dir,{recursive:true,force:true});}};
}

test('root start returns promptly, replays once, preserves full owner goal and leaves worker slots free',async()=>{
 const f=fixture();try{
  const commandId=randomUUID();const request={apiVersion:'weaver.v1',command:'tasks.start',commandId,args:{taskId:f.task.id,expectedRevision:f.task.revision}};
  const start=Date.now();const response=await f.handler.handleAsync(request);assert.equal(response.ok,true,JSON.stringify(response));assert.ok(Date.now()-start<1000);
  await f.settle();assert.equal(f.launches.length,1);assert.equal(f.store.get(f.task.id).status,'running');assert.equal(f.store.get(f.task.id).dispatch,undefined);assert.equal(f.manager.runningCount,0);
  assert.equal(slotGroupCount(f.store.list(),slotGroupFor(f.task.ownerId,'codex_owner')),0);
  assert.deepEqual(await f.handler.handleAsync(request),response);assert.equal(f.raw('tasks.start',{taskId:f.task.id}).error?.code,'INVALID_STATE');
  const prompt=f.launches[0].input.prompt;assert.ok(prompt.includes(f.task.instruction));assert.match(prompt,/tasks describe/);assert.match(prompt,/parentTaskId/);assert.match(prompt,/tasks complete/);assert.match(prompt,/不可拆/);assert.equal(f.launches[0].input.engineKind,'codex');
  f.call('tasks.describe',{taskId:f.task.id,expectedRevision:f.store.get(f.task.id).revision,title:'完成拆分任务',acceptanceCriteria:['已核验全部结果']});
  await f.launch();assert.equal(f.store.get(f.task.id).ownerHost?.workspaceId,'fake-workspace');
  const loaded=new TaskStore(f.store.path);loaded.recover();assert.equal(loaded.get(f.task.id).executionRole,'owner');assert.equal(loaded.get(f.task.id).status,'running');
 }finally{await f.close();}
});

test('root completion requires all final children reviewed, persists relationships and cannot use workers.complete',async()=>{
 const f=fixture();try{
  f.call('tasks.start',{taskId:f.task.id});await f.launch();
  f.call('tasks.describe',{taskId:f.task.id,expectedRevision:f.store.get(f.task.id).revision,title:'Root ready',acceptanceCriteria:['Reviewed results']});
  const complete={taskId:f.task.id,outcome:'completed',summary:'Independent review passed'};
  assert.equal(f.raw('workers.complete',complete).error?.code,'INVALID_STATE');
  for(let i=0;i<2;i++){
   let child=f.call('tasks.create',{parentTaskId:f.task.id,title:`Child ${i}`,goal:'bounded work'});assert.equal(child.ownerId,f.task.ownerId);assert.equal(child.workspace,f.dir);
   f.call('packages.create',{taskId:child.id,scope:['read: fixture'],acceptanceCriteria:['verified']});
   const dispatch=f.call('workers.spawn',{taskId:child.id});assert.equal(dispatch.next.action,'run_subagent');assert.equal(f.store.get(child.id).run?.pid,undefined);
   f.call('workers.complete',{taskId:child.id,outcome:'completed',summary:'verified child'});
   assert.equal(f.raw('tasks.complete',complete).error?.code,'INVALID_STATE');
   if(i===0){const rejected=f.call('tasks.results',{taskId:child.id});f.call('reviews.submit',{taskId:child.id,expectedRevision:f.store.get(child.id).revision,manifestDigest:rejected.manifestDigest,decision:'rejected'});const retry=f.call('tasks.retry',{taskId:child.id});assert.equal(retry.parentTaskId,f.task.id);assert.equal(retry.next.action,'run_subagent');child=retry;f.call('workers.complete',{taskId:child.id,outcome:'completed',summary:'retry verified'});}
   const manifest=f.call('tasks.results',{taskId:child.id});f.call('reviews.submit',{taskId:child.id,expectedRevision:f.store.get(child.id).revision,manifestDigest:manifest.manifestDigest,decision:'accepted'});
  }
  assert.equal(f.call('tasks.list',{parentTaskId:f.task.id}).tasks.length,3);
  const loaded=new TaskStore(f.store.path);assert.equal(loaded.list().filter(t=>t.parentTaskId===f.task.id).length,3);
  assert.equal(f.call('tasks.complete',complete).status,'completed');assert.equal(f.raw('tasks.create',{parentTaskId:f.task.id,goal:'too late'}).error?.code,'INVALID_STATE');
 }finally{await f.close();}
});

test('failed launch is visible, drain aborts pending launches, and cancellation cleans late hosts',async()=>{
 for(const mode of ['failure','drain','cancel'] as const){
  const f=fixture();try{
   f.call('tasks.start',{taskId:f.task.id});await f.settle();assert.equal(f.launches.length,1);
   if(mode==='failure'){f.launches[0].reject(new Error('fixture launch rejected'));await f.settle();assert.equal(f.store.get(f.task.id).status,'failed');assert.match(f.store.get(f.task.id).failure!.message,/fixture launch rejected/);}
   if(mode==='drain'){const before=f.store.get(f.task.id);await f.handler.drain();assert.equal(f.launches[0].input.signal?.aborted,true);assert.deepEqual(f.store.get(f.task.id),before);const loaded=new TaskStore(f.store.path);loaded.recover();assert.equal(loaded.get(f.task.id).status,'failed');}
   if(mode==='cancel'){f.call('tasks.cancel',{taskId:f.task.id});await f.launch();assert.equal(f.store.get(f.task.id).status,'cancelled');assert.equal(f.store.get(f.task.id).ownerHost,undefined);assert.equal(f.closed.length,1);}
  }finally{await f.close();}
 }
});

test('HTTP startTask, tasks.start and CLI IPC acknowledge slow injected launchers within one second',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'wvts-rt-'));const inputs:(OwnerLaunchInput & {signal?:AbortSignal})[]=[];
 const quota=new QuotaProber({env:{HOME:directory}});quota.refresh=async()=>quota.get();
 const runtime=await startRuntime({dataDir:directory,port:0,open:false,quotaProber:quota,ownerHost:{launcher:input=>new Promise((_resolve,reject)=>{inputs.push(input);input.signal?.addEventListener('abort',()=>reject(new Error('fake drain')),{once:true});}),closer:async()=>{}}}).catch(error=>{rmSync(directory,{recursive:true,force:true});throw error;});
 const envelope=(command:string,args:Record<string,unknown>={})=>({apiVersion:'weaver.v1',command,args,commandId:randomUUID()});
 const rpc=async(method:string,args:unknown[])=>{const response=await fetch(`http://127.0.0.1:${runtime.port}/api/rpc`,{method:'POST',headers:{origin:`http://127.0.0.1:${runtime.port}`,'content-type':'application/json'},body:JSON.stringify({method,args})});assert.equal(response.status,200);const body:any=await response.json();assert.equal(body.error,undefined,JSON.stringify(body));return body.result;};
 try{
  for(const transport of ['http-command','http-startTask','cli'] as const){
   const created:any=await sendRequest(directory,envelope('tasks.create',{goal:'root runtime fixture',workspace:directory,ownerProfileId:transport==='cli'?'claude_owner':'codex_owner'}));assert.equal(created.ok,true);const task=created.data;
   const started=Date.now();let result:any;
   if(transport==='http-command'){const response=await rpc('command',[envelope('tasks.start',{taskId:task.id})]);assert.equal(response.ok,true);result=response.data;}
   else if(transport==='http-startTask')result=await rpc('startTask',[task.id]);
   else {const response=await promisify(execFile)(process.execPath,['--import','tsx','src/cli/main.ts','tasks','start','--task-id',task.id,'--command-id',randomUUID(),'--data-dir',directory],{timeout:5000});const parsed=JSON.parse(response.stdout);assert.equal(parsed.ok,true);result=parsed.data;}
   const elapsed=Date.now()-started;assert.ok(elapsed<1000,`${transport}: ${elapsed}ms`);assert.equal(result.status,'running');assert.equal(result.executionRole,'owner');assert.equal(result.ownerHost,undefined);t.diagnostic(`${transport}: ${elapsed}ms`);
  }
  assert.equal(inputs.length,3);assert.equal(inputs[2].engineKind,'claude');
  const childRequest={command:'tasks.create',args:{parentTaskId:randomUUID()}};applyCallerWorkspace(childRequest,'/irrelevant');assert.equal('workspace' in childRequest.args,false);
  await runtime.close();assert.ok(inputs.every(input=>input.signal?.aborted));
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true});}
});

test('launch failure retries its owner epoch; invalid root and child inputs cause no launch',async()=>{
 const f=fixture();try{
  assert.equal(f.raw('tasks.start',{taskId:f.task.id,expectedRevision:-1}).error?.code,'REVISION_CONFLICT');
  f.call('owners.switch',{taskId:f.task.id,expectedRevision:f.store.get(f.task.id).revision});assert.ok(f.store.get(f.task.id).contextPack);
  f.call('tasks.start',{taskId:f.task.id});await f.settle();f.launches[0].reject(new Error('no Herdr fixture'));await f.settle();
  f.call('tasks.start',{taskId:f.task.id});await f.settle();assert.equal(f.launches.length,2);assert.equal(f.launches[1].input.epoch,2);await f.launch();const restored=new TaskStore(f.store.path).get(f.task.id);assert.equal(restored.ownerEpoch,2);assert.equal(restored.contextPack,undefined);assert.equal(restored.continuationHistory?.length,1);
  assert.equal(f.raw('tasks.create',{parentTaskId:f.task.id,goal:'undescribed child'}).error?.code,'INVALID_STATE');
  f.call('tasks.describe',{taskId:f.task.id,expectedRevision:f.store.get(f.task.id).revision,title:'A real root',acceptanceCriteria:['verified']});
  assert.equal(f.raw('packages.create',{taskId:f.task.id,scope:['fixture'],acceptanceCriteria:['test']}).error?.code,'INVALID_STATE');
  assert.equal(f.raw('tasks.retry',{taskId:f.task.id,cancel:true}).error?.code,'INVALID_STATE');
  assert.equal(f.raw('tasks.create',{parentTaskId:f.task.id,goal:'wrong owner',ownerProfileId:'claude_owner'}).error?.code,'INVALID_REQUEST');
  const child=f.call('tasks.create',{parentTaskId:f.task.id,title:'Child',goal:'isolated'});
  assert.equal(f.raw('tasks.start',{taskId:child.id}).error?.code,'INVALID_STATE');
  assert.equal(f.raw('tasks.describe',{taskId:f.task.id,expectedRevision:f.store.get(f.task.id).revision,title:'Changed scope',acceptanceCriteria:['new']}).error?.code,'INVALID_STATE');
 }finally{await f.close();}
});


test('roots require at least one reviewed child; an indivisible goal dispatches one sub-Agent',async()=>{
 const f=fixture();try{
  f.call('tasks.start',{taskId:f.task.id});await f.launch();
  const complete={taskId:f.task.id,outcome:'completed',summary:'Verified indivisible goal'};
  f.call('tasks.describe',{taskId:f.task.id,expectedRevision:f.store.get(f.task.id).revision,title:'Indivisible goal',acceptanceCriteria:['Verified result']});
  assert.equal(f.raw('tasks.complete',complete).error?.code,'INVALID_STATE');
  const child=f.call('tasks.create',{parentTaskId:f.task.id,title:'Single bounded task',goal:'indivisible work'});
  f.call('packages.create',{taskId:child.id,scope:['read: fixture'],acceptanceCriteria:['verified']});
  f.call('workers.spawn',{taskId:child.id});
  assert.equal(f.raw('tasks.complete',complete).error?.code,'INVALID_STATE');
  f.call('workers.complete',{taskId:child.id,outcome:'completed',summary:'verified'});
  assert.equal(f.raw('tasks.complete',complete).error?.code,'INVALID_STATE');
  const manifest=f.call('tasks.results',{taskId:child.id});
  f.call('reviews.submit',{taskId:child.id,expectedRevision:f.store.get(child.id).revision,manifestDigest:manifest.manifestDigest,decision:'accepted'});
  assert.equal(f.call('tasks.complete',complete).status,'completed');
  assert.equal(f.call('tasks.get',{taskId:f.task.id}).status,'completed');
 }finally{await f.close();}
});

test('zero-child roots are refused with the parent-Agent dispatch rule',async()=>{
 const f=fixture();try{
  f.call('tasks.start',{taskId:f.task.id});await f.launch();
  f.call('tasks.describe',{taskId:f.task.id,expectedRevision:f.store.get(f.task.id).revision,title:'Indivisible goal',acceptanceCriteria:['Verified result']});
  const complete={taskId:f.task.id,outcome:'completed',summary:'Verified indivisible goal'};
  const rejection=f.raw('tasks.complete',complete);
  assert.equal(rejection.error?.code,'INVALID_STATE');
  assert.match(rejection.error?.message??'',/parent Agent must not implement itself/);
  assert.match(rejection.error?.message??'',/at least one subtask/i);
 }finally{await f.close();}
});

test('root cancel cascades only active children and closes its host asynchronously once',async()=>{
 const f=fixture();let release!:()=>void;try{
  f.call('tasks.start',{taskId:f.task.id});await f.launch();
  f.call('tasks.describe',{taskId:f.task.id,expectedRevision:f.store.get(f.task.id).revision,title:'Cancel root',acceptanceCriteria:['verified']});
  const child=(title:string)=>f.call('tasks.create',{parentTaskId:f.task.id,title,goal:'bounded'});
  const queued=child('queued');const running=child('running');const done=child('done');
  for(const task of [running,done]){
   f.call('packages.create',{taskId:task.id,scope:['read: fixture'],acceptanceCriteria:['verified']});
   f.call('workers.spawn',{taskId:task.id});
  }
  f.call('workers.complete',{taskId:done.id,outcome:'completed',summary:'retain'});
  const unrelated=f.call('tasks.create',{goal:'unrelated',workspace:f.dir,ownerId:f.task.ownerId});
  const host=f.store.get(f.task.id).ownerHost!;const closed:OwnerLaunchResult[]=[];
  // A second handler uses the same isolated state, with a deliberately blocked closer.
  const handler=new CommandHandler(f.manager,f.policy,()=>{throw new Error('No sync launch');},()=>true,undefined,{closer:async input=>{closed.push(input);await new Promise<void>(resolve=>{release=resolve;});}});
  const request={apiVersion:'weaver.v1',command:'tasks.cancel',commandId:randomUUID(),args:{taskId:f.task.id}};
  const response=await handler.handleAsync(request);assert.equal(response.ok,true);
  assert.equal(f.store.get(f.task.id).status,'cancelled');
  assert.equal(f.store.get(queued.id).status,'cancelled');assert.equal(f.store.get(running.id).status,'cancelled');
  assert.equal(f.store.get(done.id).status,'completed');assert.equal(f.store.get(unrelated.id).status,'queued');
  await f.settle();assert.equal(closed.length,1);assert.equal(closed[0].agentName,host.agentName);
  assert.deepEqual(await handler.handleAsync(request),response);assert.equal(closed.length,1);
  let drained=false;const draining=handler.drain().then(()=>{drained=true;});await f.settle();assert.equal(drained,false);
  release();await draining;assert.equal(f.store.get(f.task.id).ownerHost,undefined);
 }finally{release?.();await f.close();}
});


test('root cancel preserves host evidence and reports async cleanup failure without undoing cancellation',async()=>{
 const f=fixture();try{
  f.call('tasks.start',{taskId:f.task.id});await f.launch();
  const host=f.store.get(f.task.id).ownerHost;let calls=0;
  const handler=new CommandHandler(f.manager,f.policy,()=>{throw new Error('No sync launch');},()=>true,undefined,{closer:async()=>{calls++;throw new Error('fake host close failed');}});
  const request={apiVersion:'weaver.v1',command:'tasks.cancel',commandId:randomUUID(),args:{taskId:f.task.id}};
  assert.equal((await handler.handleAsync(request)).ok,true);await handler.drain();
  const task=f.store.get(f.task.id);assert.equal(task.status,'cancelled');assert.deepEqual(task.ownerHost,host);
  assert.ok(task.events.some(e=>e.kind==='error'&&e.message.includes('fake host close failed')));assert.equal(calls,1);
 }finally{await f.close();}
});


test('HTTP root cancellation responds while injected host closer is blocked',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'wvts-cx-'));
 const quota=new QuotaProber({env:{HOME:directory}});quota.refresh=async()=>quota.get();
 let release!:()=>void;let closing=false;
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 const runtime=await startRuntime({dataDir:directory,port:0,open:false,quotaProber:quota,ownerHost:{launcher:async()=>({session:'fake',workspaceId:'fake-workspace',paneId:'fake-pane',agentName:'fake-owner'}),closer:async()=>{closing=true;await blocked;}}}).catch(error=>{rmSync(directory,{recursive:true,force:true});throw error;});
 const envelope=(command:string,args:Record<string,unknown>={})=>({apiVersion:'weaver.v1',command,args,commandId:randomUUID()});
 try{
  const created:any=await sendRequest(directory,envelope('tasks.create',{goal:'cancel fixture',workspace:directory,ownerProfileId:'codex_owner'}));assert.equal(created.ok,true);
  const id=created.data.id;const started:any=await sendRequest(directory,envelope('tasks.start',{taskId:id}));assert.equal(started.ok,true);
  // IPC has acknowledged start; let its in-memory launcher finish before cancellation.
  await new Promise(resolve=>setImmediate(resolve));
  const before:any=await sendRequest(directory,envelope('tasks.get',{taskId:id}));assert.ok(before.data.ownerHost);
  const response=await fetch(`http://127.0.0.1:${runtime.port}/api/rpc`,{method:'POST',signal:AbortSignal.timeout(2000),headers:{origin:`http://127.0.0.1:${runtime.port}`,'content-type':'application/json'},body:JSON.stringify({method:'command',args:[envelope('tasks.cancel',{taskId:id})]})});
  assert.equal(response.status,200);const body:any=await response.json();assert.equal(body.result.ok,true);assert.equal(body.result.data.status,'cancelled');assert.equal(closing,true);
 }finally{release();await runtime.close();rmSync(directory,{recursive:true,force:true});}
});
