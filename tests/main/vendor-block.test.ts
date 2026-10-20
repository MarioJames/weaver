import test from 'node:test';
import { stallStoreAt } from '../helpers/state-db';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TaskManager } from '../../src/main/manager';
import { TaskStore } from '../../src/main/store';
import { PolicyStore } from '../../src/main/policy/store';
import { CommandHandler } from '../../src/main/commands';
import { StallMonitor } from '../../src/main/stall';
import { classifyVendorError } from '../../src/main/adapters/cli/vendor-errors';

const RAW = 'timestamp=2026-10-19T14:24:00Z level=ERROR run=123 error.error="AI_RetryError: AI_APICallError: Rate limit exceeded. Please try again later."';
function fixture(onStart = () => {}) {
 const dir=mkdtempSync(join(tmpdir(),'weaver-test-'));
 const children: ReturnType<typeof child>[]=[];
 function child() { return Object.assign(new EventEmitter(), {stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true}); }
 let store=new TaskStore(join(dir,'weaver.db'));
 let manager=new TaskManager(store,{id:'routing',canLaunchReal:()=>true,start:()=>{onStart();const c=child();children.push(c);return c;}});
 const policy=new PolicyStore(join(dir,'weaver.db'));
 const snapshot=policy.snapshot();snapshot.config.owners.claude_owner.workers=['codex_worker'];policy.save({revision:snapshot.revision,config:snapshot.config,blocks:[]});
 let handler=new CommandHandler(manager,policy);
 const create=()=>manager.create({title:'fixture',instruction:'fake only',workspace:dir,owner:{name:'o',transport:'herdr-visible',session:'s',pane:'p'}});
 const request=(command:string,args:Record<string,unknown>)=>({apiVersion:'weaver.v1',commandId:randomUUID(),command,args});
 const trigger=async()=>{const task=create(); task.status='failed';task.dispatch={engine:'codex',execution:'real',owner:'claude_owner',worker:'codex_worker',model:'fake',effort:'high',maxParallel:2};task.failure={...classifyVendorError('opencode',RAW)!,vendorError:RAW};store.put(task);handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));return task;};
 return {dir,get store(){return store;},get manager(){return manager;},policy,create,request,children,trigger,get handler(){return handler;},restart(){handler.draining=true;store=new TaskStore(store.path);manager=new TaskManager(store,{id:'unused',start:()=>{throw Error('unused');}});handler=new CommandHandler(manager,policy);},close(){handler.draining=true;for(const c of children)c.emit('close',42,null);rmSync(dir,{recursive:true,force:true});}};
}
test('vendor failure extracts a readable bounded message and keeps raw evidence separately',async()=>{
 assert.equal(classifyVendorError('opencode',RAW)?.message,'Rate limit exceeded. Please try again later.');
 const f=fixture();try{const task=await f.trigger();const b=f.policy.snapshot().blocks[0];assert.equal(b.reason,'限流：Rate limit exceeded. Please try again later.');assert.equal(f.store.get(task.id).failure?.vendorError,RAW);}finally{f.close();}
});
test('rate limit ladder persists across restart, caps at 60 min, resets after 2h and isolates engines',async t=>{
 const now=Date.parse('2030-01-01T00:00:00Z');t.mock.timers.enable({apis:['Date'],now});const f=fixture();try{
 for(const minutes of [10,30,60,60]){await f.trigger();const b=f.policy.snapshot().blocks[0];assert.equal(Date.parse(b.release_at!)-Date.now(),minutes*60000);f.restart();t.mock.timers.tick(1000);}
 assert.ok(Object.keys(f.store.listVendorLimits()).length>=1,'the ladder is in the vendor_limits table, not in a blob');
 t.mock.timers.tick(2*60*60000);await f.trigger();assert.equal(Date.parse(f.policy.snapshot().blocks[0].release_at!)-Date.now(),600000);
 const task=f.create();task.status='failed';task.dispatch={engine:'claude',owner:'x',worker:'x',model:'x',effort:'high',maxParallel:2,execution:'real'};task.failure={kind:'rate_limit',message:'429'};f.handler.manager.store.put(task);f.handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(Date.parse(f.policy.snapshot().blocks.find(b=>b.engine==='claude')!.release_at!)-Date.now(),600000);
 }finally{f.close();t.mock.timers.reset();}
});
test('quota without retry time stays manual and reasons never exceed 120 characters',async()=>{
 const f=fixture();try{for(const message of ['FreeUsageLimitError','usage limit '+ 'detail '.repeat(100)]){const task=f.create();task.status='failed';task.dispatch={engine:'codex',owner:'x',worker:'x',model:'x',effort:'high',maxParallel:2,execution:'real'};task.failure=classifyVendorError('opencode',message);f.store.put(task);f.handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));const b=f.policy.snapshot().blocks[0];assert.match(b.reason,/^额度耗尽：/);assert.ok(b.reason.length<=120);assert.equal(b.release_at,undefined);}}finally{f.close();}
});
test('a vendor retry time longer than the ladder step wins for rate limits and quota',async t=>{
 const now=Date.parse('2030-01-01T00:00:00Z');t.mock.timers.enable({apis:['Date'],now});const f=fixture();try{
 for(const kind of ['rate_limit','quota'] as const){const task=f.create();task.status='failed';task.dispatch={engine:'codex',owner:'x',worker:'x',model:'x',effort:'high',maxParallel:2,execution:'real'};task.failure={kind,message:kind==='quota'?'FreeUsageLimitError':'429',retryAt:new Date(now+3*60*60000).toISOString()};f.store.put(task);f.handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(Date.parse(f.policy.snapshot().blocks[0].release_at!)-now,3*60*60000);}
 }finally{f.close();t.mock.timers.reset();}
});
test('terminal task health reports ended with its final status',()=>{
 const f=fixture();try{const monitor=new StallMonitor({tasks:()=>f.store.list(),policy:()=>f.policy,stateStore:stallStoreAt(join(f.dir,'state.db'))});for(const status of ['failed','completed','cancelled'] as const){const task=f.create();task.status=status;assert.equal(monitor.taskHealth(task).state,'ended');assert.equal(monitor.taskHealth(task).taskStatus,status);}}finally{f.close();}
});
for(const command of ['workers.spawn','tasks.retry'])test(`${command} subtracts slow launcher time from first-output IPC budget`,async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2030-01-01T00:00:00Z')});const f=fixture(()=>t.mock.timers.tick(3000));try{
 const task=f.create();if(command==='tasks.retry'){task.status='failed';f.store.put(task);}
 const response=f.handler.handleAsync(f.request(command,{taskId:task.id,owner:'claude_owner',...(command==='workers.spawn'?{worker:'codex_worker'}:{})}));let result:any;response.then(value=>result=value);await Promise.resolve();assert.equal(result,undefined);
 t.mock.timers.tick(4999);await Promise.resolve();assert.equal(result,undefined);
 t.mock.timers.tick(1);await new Promise(resolve=>setImmediate(resolve));assert.ok(result,'response settled within the 8 second budget');const final:any=await response;assert.equal(final.ok,true,JSON.stringify(final));assert.equal(final.data.started,false);assert.equal(final.data.status,'running');assert.equal(final.data.next.action,'wait');
 }finally{f.close();t.mock.timers.reset();}
});
