import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startLocalIPC } from '../../src/main/local-ipc';
import { runCLI } from '../../src/cli/run';
import { parseCLI } from '../../src/cli/parse';
import { defaultForSeconds } from '../../src/cli/poll-task';

const exec = promisify(execFile);
const ok = (data: unknown) => ({apiVersion:'weaver.v1',ok:true,data});

test('watch drains all retained event pages before returning terminal snapshot in jsonl and text',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wv-poll-'));
 const records=Array.from({length:237},(_,index)=>({id:`event-${index}`,kind:index===236?'result':'log',message:index===236?'actual-terminal-result':`record-${index}`}));
 let pageRequests=0;
 const app=await startLocalIPC(directory,(request:any)=>{
  if(request.command==='tasks.get')return ok({id:'task',title:'Fixture',status:'completed'});
  assert.equal(request.command,'tasks.events');pageRequests++;
  const after=request.args.after;const start=after?records.findIndex(event=>event.id===after)+1:0;
  const events=records.slice(start,start+100);
  return ok({events,nextCursor:events.at(-1)?.id,hasMore:start+events.length<records.length});
 });
 try{
  for(const format of ['jsonl','text']){
   const result=await exec(process.execPath,['--import','tsx','src/cli/main.ts','tasks','watch','--task-id','task','--for','5','--output',format,'--data-dir',directory],{encoding:'utf8'});
   const lines=result.stdout.trim().split('\n');assert.equal(lines.length,238);assert.match(result.stdout,/actual-terminal-result/);
   if(format==='jsonl'){const envelopes=lines.map(line=>JSON.parse(line));assert.equal(envelopes[236].data.id,'event-236');assert.equal(envelopes[237].data.status,'completed');}
   else assert.equal(lines[236],'result: actual-terminal-result');
  }
  assert.equal(pageRequests,6);
 }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});

test('watch reports cursor expiry instead of silently skipping retained events',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wv-poll-'));
 const app=await startLocalIPC(directory,(request:any)=>request.command==='tasks.get'?ok({status:'completed'}):{apiVersion:'weaver.v1',ok:false,error:{code:'CURSOR_EXPIRED',message:'Cursor not retained; refresh task snapshot',retryable:false}});
 try{
  const result=await exec(process.execPath,['--import','tsx','src/cli/main.ts','tasks','watch','--task-id','task','--output','jsonl','--data-dir',directory],{encoding:'utf8'}).catch(error=>error as {stdout:string;code:number});
  assert.equal(JSON.parse(result.stdout).error.code,'CURSOR_EXPIRED');assert.match(result.stdout,/refresh task snapshot/);
 }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});

test('bounded wait uses its remaining deadline for an unresponsive transport',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'wv-poll-'));
 let receive:()=>void=()=>{};
 const received=new Promise<void>(resolve=>{receive=resolve;});
 const app=await startLocalIPC(directory,()=>{receive();return new Promise(()=>{});});
 const original=process.stdout.write;
 let output='';
 try{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  process.stdout.write=((chunk:unknown)=>{output+=String(chunk);return true;}) as typeof process.stdout.write;
  let settled=false;
  const command=runCLI(['tasks','wait','--task-id','task','--for','1','--output','json','--data-dir',directory]).then(code=>{settled=true;return code;});
  await received;
  t.mock.timers.tick(999);await Promise.resolve();assert.equal(settled,false);
  t.mock.timers.tick(1);
  assert.equal(await command,1);assert.equal(JSON.parse(output).error.code,'TIMEOUT');
 }finally{
  process.stdout.write=original;t.mock.timers.reset();await app.close();await rm(directory,{recursive:true,force:true});
 }
});

test('tasks wait without --for reads the policy before its first poll',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wv-poll-'));
 const calls:string[]=[];
 const app=await startLocalIPC(directory,(request:any)=>{
  if(request.method==='getPolicy'){calls.push('getPolicy');return ok({config:{herdr:{max_wait_minutes:4}}});}
  calls.push('tasks.get');return ok({id:'task',title:'Fixture',status:'completed'});
 });
 const original=process.stdout.write;
 let output='';
 try{
  process.stdout.write=((chunk:unknown)=>{output+=String(chunk);return true;}) as typeof process.stdout.write;
  assert.equal(await runCLI(['tasks','wait','--task-id','task','--output','json','--data-dir',directory]),0);
  assert.equal(JSON.parse(output).data.status,'completed');
  assert.deepEqual(calls,['getPolicy','tasks.get'],'the omitted --for consults the policy before polling');
 }finally{
  process.stdout.write=original;await app.close();await rm(directory,{recursive:true,force:true});
 }
});

test('the omitted --for is max_wait_minutes×60 with 30 as the fallback and no cap',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wv-poll-'));
 const app=await startLocalIPC(directory,(request:any)=>request.method==='getPolicy'
  ?ok({config:{herdr:{max_wait_minutes:4}}}):ok({status:'ignored'}));
 try{
  assert.equal(await defaultForSeconds(directory),240);
  assert.equal(await defaultForSeconds(justDataDir()),30,'an unreachable endpoint falls back to 30');
  await app.close();
  for(const [minutes,seconds] of [[11,660],[15,900],[40,2400],[1440,86400]] as const){
   const policy=await startLocalIPC(directory,()=>ok({config:{herdr:{max_wait_minutes:minutes}}}));
   try{assert.equal(await defaultForSeconds(directory),seconds,`${minutes} minutes waits ${seconds} with no cap`);}finally{await policy.close();}
  }
  const err=await startLocalIPC(directory,()=>({apiVersion:'weaver.v1',ok:false,error:{code:'PERSISTENCE_ERROR',message:'Policy',retryable:false}}));
  try{assert.equal(await defaultForSeconds(directory),30);}finally{await err.close();}
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('the omitted --for falls back to 30 when getPolicy never answers',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'wv-poll-'));
 const app=await startLocalIPC(directory,()=>new Promise(()=>{}));
 try{
  t.mock.timers.enable({apis:['setTimeout'],now:0});
  const pending=defaultForSeconds(directory);
  for(let i=0;i<50;i++)await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(2_500);
  assert.equal(await pending,30,'the 2s policy read times out and falls back to 30');
 }finally{
  t.mock.timers.reset();await app.close();await rm(directory,{recursive:true,force:true});
 }
});

function justDataDir(): string { return join(tmpdir(), 'wv-poll-gone', 'absent'); }

test('an explicit --for is honoured without a policy read and accepts any positive whole number',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wv-poll-'));
 const calls:string[]=[];
 const app=await startLocalIPC(directory,(request:any)=>{
  if(request.method==='getPolicy'){calls.push('getPolicy');return ok({config:{herdr:{max_wait_minutes:4}}});}
  calls.push('tasks.get');return ok({id:'task',title:'Fixture',status:'completed'});
 });
 const original=process.stdout.write;
 let output='';
 try{
  process.stdout.write=((chunk:unknown)=>{output+=String(chunk);return true;}) as typeof process.stdout.write;
  assert.equal(await runCLI(['tasks','wait','--task-id','task','--for','1','--output','json','--data-dir',directory]),0);
  assert.equal(JSON.parse(output).data.status,'completed');
  output='';
  assert.equal(await runCLI(['tasks','wait','--task-id','task','--for','100000','--output','json','--data-dir',directory]),0);
  assert.equal(JSON.parse(output).data.status,'completed');
  assert.deepEqual(calls,['tasks.get','tasks.get'],'an explicit --for never reads the policy');
  assert.equal(parseCLI(['tasks','wait','--task-id','task','--for','1']).forSeconds,1);
  assert.equal(parseCLI(['tasks','wait','--task-id','task','--for','600']).forSeconds,600);
  assert.equal(parseCLI(['tasks','wait','--task-id','task','--for','86400']).forSeconds,86400);
  assert.equal(parseCLI(['tasks','wait','--task-id','task','--for','100000']).forSeconds,100000,'there is no upper bound');
  for(const invalid of ['0','x'])assert.throws(()=>parseCLI(['tasks','wait','--task-id','task','--for',invalid]),(error:{code:string})=>error.code==='INVALID_ARGUMENT');
 }finally{
  process.stdout.write=original;await app.close();await rm(directory,{recursive:true,force:true});
 }
});
