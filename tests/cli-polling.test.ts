import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startLocalIPC } from '../src/main/local-ipc';
import { runCLI } from '../src/cli/main';

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
