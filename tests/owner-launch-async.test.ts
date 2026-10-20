import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CommandHandler } from '../src/main/commands';
import { TaskStore, event } from '../src/main/store';
import { TaskManager } from '../src/main/manager';
import { PolicyStore } from '../src/main/policy/store';
import { MockWorkerAdapter } from '../src/main/adapters/worker';
import { OwnerLaunchError, type OwnerLaunchInput, type OwnerLaunchResult, type launchOwnerAsync } from '../src/main/owner-host';
import { startLocalIPC, readDiscovery } from '../src/main/local-ipc';
import { sendRequest } from '../src/cli/main';
import { startRuntime } from '../src/main/runtime';
import { metadataOf } from './helpers/store-metadata';

const envelope = (command:string,args:Record<string,unknown>={},commandId:string=randomUUID()) => ({apiVersion:'weaver.v1',command,args,commandId});
const blocked = ():never => {throw new Error('No real host in fixture');};
const host = (input:OwnerLaunchInput):OwnerLaunchResult => ({session:'fixture-session',workspaceId:`workspace-${input.epoch}`,paneId:`unrelated-pane-${input.epoch}`,agentName:`owner-${input.taskId.slice(0,8)}-${input.epoch}`});
function deferredLaunch() {
  const pending:{input:OwnerLaunchInput & {signal?:AbortSignal};resolve:(value:OwnerLaunchResult)=>void;reject:(error:Error)=>void}[]=[];
  const launcher:typeof launchOwnerAsync=input=>new Promise((resolve,reject)=>{pending.push({input,resolve,reject});input.signal?.addEventListener('abort',()=>reject(new OwnerLaunchError('OWNER_LAUNCH_FAILED','fixture aborted')),{once:true});});
  return {pending,launcher};
}
function fixture(options:{closeFailure?:boolean}={}) {
  const directory=mkdtempSync(join(tmpdir(),'wv-async-command-'));
  const store=new TaskStore(join(directory,'weaver.db'));const policy=new PolicyStore(join(directory,'weaver.db'));
  const manager=new TaskManager(store,new MockWorkerAdapter(process.execPath,resolve('scripts/mock-worker.mjs')));
  const launch=deferredLaunch();const closed:OwnerLaunchResult[]=[];
  const handler=new CommandHandler(manager,policy,blocked,()=>true,undefined,{launcher:launch.launcher,closer:async value=>{closed.push(value);if(options.closeFailure)throw new Error('cleanup fixture failed');}});
  const raw=(command:string,args:Record<string,unknown>={},id?:string)=>handler.handle(envelope(command,args,id));
  const call=(command:string,args:Record<string,unknown>={},id?:string):any=>{const value=raw(command,args,id);assert.equal(value.ok,true,JSON.stringify(value));return value.data;};
  const task=call('tasks.create',{title:'Async owner',goal:'fixture work',workspace:directory,ownerProfileId:'codex_owner'});
  return {directory,store,policy,manager,handler,launch,closed,raw,call,task,async close(){await handler.drain();await manager.shutdown();rmSync(directory,{recursive:true,force:true});}};
}

test('pending launch receipts, same epoch exclusion, fresh state and final restart replay',async()=>{
 const f=fixture();try{
  const request=envelope('owners.switch',{taskId:f.task.id,expectedRevision:f.task.revision,launch:true});
  const result=f.handler.handleAsync(request);assert.equal(f.launch.pending.length,1);
  assert.equal((await f.handler.handleAsync(request)).error?.code,'COMMAND_INDETERMINATE');
  const duplicate=await f.handler.handleAsync(envelope('owners.launch',{taskId:f.task.id,expectedRevision:f.store.get(f.task.id).revision}));
  assert.equal(duplicate.error?.code,'INVALID_STATE');assert.equal(f.launch.pending.length,1);
  const fresh=f.store.get(f.task.id);event(fresh,'log','concurrent worker event');fresh.summary='concurrent summary';fresh.artifacts.push({id:randomUUID(),createdAt:new Date().toISOString(),name:'concurrent.txt',mediaType:'text/plain',content:'preserved'});f.manager.update(fresh);
  f.call('owners.attach',{name:'concurrent owner',profileId:'codex_owner'});
  const count=metadataOf(f.store).owners.length;
  f.launch.pending[0].resolve(host(f.launch.pending[0].input));
  const response=await result;assert.equal(response.ok,true);assert.equal((response.data as any).launch.ok,true);
  const final=f.store.get(f.task.id);assert.equal(final.summary,'concurrent summary');assert.equal(final.artifacts[0].content,'preserved');assert.ok(final.events.some(item=>item.message==='concurrent worker event'));assert.equal(metadataOf(f.store).owners.length,count);
  assert.deepEqual(await f.handler.handleAsync(request),response);
  const loaded=new TaskStore(f.store.path);const manager=new TaskManager(loaded,new MockWorkerAdapter(process.execPath,resolve('scripts/mock-worker.mjs')));const reopened=new CommandHandler(manager,f.policy,blocked,()=>false);
  try{assert.deepEqual(await reopened.handleAsync(request),response);}finally{await reopened.drain();await manager.shutdown();}
  assert.equal(f.closed.length,0);
 }finally{await f.close();}
});

test('post-launch persistence failure cleans only an uncommitted host and preserves the original error',async()=>{
 for(const mode of ['before-save','cleanup-failure','after-save'] as const){
  const f=fixture({closeFailure:mode==='cleanup-failure'});const original=f.manager.update.bind(f.manager);
  try{
   f.manager.update=task=>{if(task.ownerHost){if(mode==='after-save')original(task);throw new Error('host persistence fixture failed');}original(task);};
   const result=f.handler.handleAsync(envelope('owners.switch',{taskId:f.task.id,expectedRevision:f.task.revision,launch:true}));const attempt=f.launch.pending[0];attempt.resolve(host(attempt.input));
   const response=await result;assert.equal(response.ok,true);
   if(mode==='after-save'){
    assert.equal((response.data as any).launch.ok,true);assert.equal(f.closed.length,0);assert.equal(f.store.get(f.task.id).ownerHost?.workspaceId,host(attempt.input).workspaceId);
   }else{
    const launch=(response.data as any).launch;assert.equal(launch.ok,false);assert.equal(launch.code,'OWNER_LAUNCH_FAILED');assert.match(launch.message,/host persistence fixture failed/);
    if(mode==='cleanup-failure')assert.match(launch.message,/cleanup fixture failed/);
    assert.deepEqual(f.closed,[host(attempt.input)]);assert.equal(f.store.get(f.task.id).ownerHost,undefined);
   }
  }finally{f.manager.update=original;await f.close();}
 }
});

test('newer epochs stay launchable and older success/failure cannot overwrite their binding or context',async()=>{
 for(const succeeds of [true,false]){
  const f=fixture();try{
   const first=f.handler.handleAsync(envelope('owners.switch',{taskId:f.task.id,expectedRevision:f.task.revision,launch:true}));
   const second=f.handler.handleAsync(envelope('owners.switch',{taskId:f.task.id,expectedRevision:f.store.get(f.task.id).revision,launch:true}));
   assert.equal(f.launch.pending.length,2);
   const latest=f.launch.pending[1];latest.resolve(host(latest.input));assert.equal((await second).ok,true);
   const before=f.store.get(f.task.id);const old=f.launch.pending[0];
   if(succeeds)old.resolve(host(old.input));else old.reject(new OwnerLaunchError('OWNER_LAUNCH_FAILED','old attempt failed'));
   const response=await first;assert.equal((response.data as any).launch.ok,false);assert.equal((response.data as any).launch.code,'OWNER_LAUNCH_FAILED');
   assert.deepEqual(f.store.get(f.task.id),before);
   assert.deepEqual(f.closed,succeeds?[host(old.input)]:[]);
  }finally{await f.close();}
 }
});

test('drain aborts and joins owned pending work without late persistence, retaining finished hosts',async()=>{
 const f=fixture();try{
  const result=f.handler.handleAsync(envelope('owners.switch',{taskId:f.task.id,expectedRevision:f.task.revision,launch:true}));
  const before=f.store.get(f.task.id);await f.handler.drain();assert.equal(f.launch.pending[0].input.signal?.aborted,true);
  assert.equal((await result).ok,true);assert.equal(((await result).data as any).launch.ok,false);assert.deepEqual(f.store.get(f.task.id),before);assert.equal(f.closed.length,0);
 }finally{await f.close();}
 const done=fixture();try{
  const result=done.handler.handleAsync(envelope('owners.switch',{taskId:done.task.id,expectedRevision:done.task.revision,launch:true}));done.launch.pending[0].resolve(host(done.launch.pending[0].input));await result;
  const before=done.store.get(done.task.id);await done.handler.drain();assert.deepEqual(done.store.get(done.task.id),before);assert.equal(done.closed.length,0);
 }finally{await done.close();}
});

test('client socket disconnect leaves accepted launch receipt settling and replayable',async()=>{
 const f=fixture();const ipc=await startLocalIPC(f.directory,value=>f.handler.handleAsync(value));
 try{
  const {discovery,token}=await readDiscovery(f.directory);const request=envelope('owners.switch',{taskId:f.task.id,expectedRevision:f.task.revision,launch:true});
  const socket=connect(discovery.socketPath);socket.on('error',()=>{});
  await new Promise<void>(resolve=>socket.once('connect',()=>{socket.write(JSON.stringify({version:1,token,request})+'\n');resolve();}));
  const deadline=Date.now()+2000;while(!f.launch.pending.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.launch.pending.length,1);
  socket.destroy();f.launch.pending[0].resolve(host(f.launch.pending[0].input));
  await new Promise(resolve=>setImmediate(resolve));
  const replay:any=await sendRequest(f.directory,request);assert.equal(replay.ok,true);assert.equal(replay.data.launch.ok,true);assert.equal(f.launch.pending.length,1);
 }finally{await ipc.close();await f.close();}
});

const exec=promisify(execFile);
async function cli(directory:string,args:string[]){
 const start=Date.now();const result=await exec(process.execPath,['--import','tsx','src/cli/main.ts',...args,'--data-dir',directory],{cwd:process.cwd(),env:process.env,timeout:25000});
 return {json:JSON.parse(result.stdout),ms:Date.now()-start};
}
async function httpCommand(port:number,request:unknown){
 const response=await fetch(`http://127.0.0.1:${port}/api/rpc`,{method:'POST',headers:{origin:`http://127.0.0.1:${port}`,'content-type':'application/json'},body:JSON.stringify({method:'command',args:[request]})});
 assert.equal(response.status,200);return (await response.json() as any).result;
}

test('real CLI and HTTP launch concurrently beyond 15s while ordinary reads remain responsive', {timeout:45000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'wv-long-owner-'));const bin=join(directory,'bin');mkdirSync(bin);const log=join(directory,'herdr.jsonl');const previous=process.env.PATH;
 // Absolute interpreter and a PATH containing only this fake prevent reaching paid engines or real Herdr.
 writeFileSync(join(bin,'herdr'),`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const action=args[3];fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({action,args,pid:process.pid})+'\\n');if(action==='create'){console.log(JSON.stringify({result:{workspace:{workspace_id:'workspace-'+process.pid},root_pane:{pane_id:'pane-'+process.pid}}}));}else if(action==='start'){setTimeout(()=>console.log('{"result":{"status":"ready"}}'),16000);}else{console.log('{"result":{"status":"ok"}}');}\n`,{mode:0o755});
 process.env.PATH=bin;let runtime:Awaited<ReturnType<typeof startRuntime>>|undefined;
 try{
  runtime=await startRuntime({dataDir:join(directory,'data'),port:0,open:false});const data=join(directory,'data');
  const createTask=async(title:string)=>{const value:any=await sendRequest(data,envelope('tasks.create',{title,goal:'safe fake launch',workspace:directory,ownerProfileId:'codex_owner'}));assert.equal(value.ok,true);return value.data;};
  const cliTask=await createTask('CLI slow owner');const httpTask=await createTask('HTTP slow owner');
  const cliId=randomUUID();const cliRequest={taskId:cliTask.id,expectedRevision:cliTask.revision,launch:true};
  const started=Date.now();const cliWork=cli(data,['owners','switch','--input',JSON.stringify(cliRequest),'--command-id',cliId]);
  const httpWork=httpCommand(runtime.port,envelope('owners.switch',{taskId:httpTask.id,expectedRevision:httpTask.revision,launch:true}));
  const both=Promise.all([cliWork,httpWork]);void both.catch(()=>{});
  const until=Date.now()+5000;while(Date.now()<until){const entries=existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];if(entries.filter(item=>item.action==='start').length===2)break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(item=>item.action==='start').length,2);
  const read=await cli(data,['capabilities']);assert.equal(read.json.ok,true);assert.ok(read.ms<3000,`concurrent read took ${read.ms}ms`);
  const readStart=Date.now();const httpRead=await httpCommand(runtime.port,envelope('tasks.list'));assert.equal(httpRead.ok,true);const httpReadMs=Date.now()-readStart;assert.ok(httpReadMs<3000);
  const [cliResult,httpResult]=await both;assert.equal(cliResult.json.ok,true);assert.equal(cliResult.json.data.launch.ok,true);assert.equal(httpResult.ok,true);assert.equal(httpResult.data.launch.ok,true);assert.ok(cliResult.ms>15000);assert.ok(Date.now()-started<24000);
  assert.notEqual(cliResult.json.data.launch.ownerHost.workspaceId,httpResult.data.launch.ownerHost.workspaceId);
  const receipt:any=await sendRequest(data,envelope('operations.get',{commandId:cliId}));assert.equal(receipt.data.state,'settled');assert.deepEqual(receipt.data.response,cliResult.json);
  t.diagnostic(`CLI launch ${cliResult.ms}ms; parallel window ${Date.now()-started}ms; concurrent CLI read ${read.ms}ms; HTTP read ${httpReadMs}ms`);
  // A further accepted launch is interrupted promptly by runtime drain, while finished visible hosts stay open.
  const drainingTask=await createTask('Drain pending owner');const drainingRequest=envelope('owners.switch',{taskId:drainingTask.id,expectedRevision:drainingTask.revision,launch:true});
  const drainingWork=sendRequest(data,drainingRequest);void drainingWork.catch(()=>{});
  const drainUntil=Date.now()+3000;
  while(Date.now()<drainUntil){const entries=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));if(entries.filter(item=>item.action==='start').length===3)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(item=>item.action==='start').length,3);
  await runtime.close();await Promise.allSettled([drainingWork]);
  const loaded=new TaskStore(join(data,'weaver.db'));const drained=metadataOf(loaded).receipts[`local-demo:${drainingRequest.commandId}`].response!;
  assert.equal(drained.ok,true);assert.equal((drained.data as any).launch.ok,false);assert.equal((drained.data as any).launch.code,'OWNER_LAUNCH_FAILED');assert.equal(loaded.get(drainingTask.id).ownerHost,undefined);
  assert.deepEqual(loaded.get(httpTask.id).ownerHost,httpResult.data.launch.ownerHost);
  const entries=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));const closes=entries.filter(item=>item.action==='close');
  const creates=entries.filter(item=>item.action==='create');assert.equal(closes.length,1);assert.equal(closes[0].args[4],`workspace-${creates[2].pid}`);

 }finally{await runtime?.close();if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;rmSync(directory,{recursive:true,force:true});}
});
