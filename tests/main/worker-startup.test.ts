import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../../src/main/manager';
import { TaskStore } from '../../src/main/store';
import { classifyVendorError } from '../../src/main/adapters/cli/vendor-errors';

function harness() {
 const dir=mkdtempSync(join(tmpdir(),'weaver-test-'));
 const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
 const store=new TaskStore(join(dir,'weaver.db'));
 const manager=new TaskManager(store,{id:'pi',start:()=>child});
 const task=manager.create({title:'fixture',instruction:'fake only',owner:{name:'o',transport:'herdr-visible',session:'s',pane:'p'}});
 task.dispatch={execution:'real',adapter:'pi',engineKind:'pi',engine:'pi',model:'fake',effort:'high',owner:'o',worker:'w',maxParallel:2};store.put(task);
 manager.start(task.id);
 return {dir,child,manager,store,id:task.id,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test('first output excludes launcher records and persists vendor timestamp',()=>{
 const h=harness();try {
 h.child.stdout.write(JSON.stringify({type:'log',message:'owned scope started'})+'\n');
 assert.equal(h.store.get(h.id).run?.firstOutputAt,undefined);
 h.child.emit('first-output',new Date().toISOString());
 assert.ok(h.store.get(h.id).run?.firstOutputAt);
 h.child.emit('close',42,null);
 }finally{h.cleanup();}
});
test('early exit retains redacted stderr and round trips failure',()=>{
 const h=harness();try {
 h.child.stderr.write('No input provided via stdin\n');h.child.emit('close',42,null);
 const task=h.store.get(h.id);assert.equal(task.failure?.kind,'early_exit');assert.equal(task.failure?.exitCode,42);assert.match(task.failure?.stderrTail??'',/No input/);
 assert.deepEqual(new TaskStore(join(h.dir,'weaver.db')).get(h.id).failure,task.failure);
 }finally{h.cleanup();}
});
test('vendor classifier handles limits, quota and retry-after',()=>{
 assert.equal(classifyVendorError('opencode','AI_APICallError: Rate limit exceeded; retry-after: 60',0)?.retryAt,'1970-01-01T00:01:00.000Z');
 assert.equal(classifyVendorError('grok','HTTP 402: insufficient balance')?.kind,'quota');
 assert.equal(classifyVendorError('pi','normal assistant text'),undefined);
 assert.equal(classifyVendorError('opencode','FreeUsageLimitError: retryAfter: 60',0)?.kind,'quota');
 assert.equal(classifyVendorError('codex','usage limit reset_at: 2030-01-01T00:00:00Z',0)?.retryAt,'2030-01-01T00:00:00.000Z');
});
test('no-output deadline fails immediately and requests process termination',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=harness();let killed=0;h.child.kill=()=>{killed++;return true;};try{
 t.mock.timers.tick(120000);
 assert.equal(h.store.get(h.id).failure?.kind,'no_output');assert.equal(h.store.get(h.id).status,'failed');assert.equal(killed,1);
 h.child.emit('close',null,'SIGTERM');assert.equal(h.store.get(h.id).events.filter(e=>e.kind==='error').length,1);
 }finally{h.cleanup();t.mock.timers.reset();}
});
test('vendor limit fails before exit and preserves diagnostic on close',()=>{
 const h=harness();try{
 h.child.emit('vendor-error','Rate limit exceeded',classifyVendorError('pi','Rate limit exceeded'));
 assert.equal(h.store.get(h.id).status,'failed');assert.equal(h.store.get(h.id).failure?.kind,'rate_limit');
 h.child.emit('close',42,null);
 assert.equal(h.store.get(h.id).failure?.vendorError,'Rate limit exceeded');assert.equal(h.store.get(h.id).failure?.exitCode,42);
 assert.equal(h.store.get(h.id).events.filter(e=>e.kind==='error').length,1);
 }finally{h.cleanup();}
});
test('first-output wait resolves false at its bounded wait, true on valid output',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=harness();try{
 const waiting=h.manager.waitForFirstOutput(h.id);t.mock.timers.tick(10000);assert.equal(await waiting,false);
 const started=h.manager.waitForFirstOutput(h.id);h.child.emit('first-output',new Date().toISOString());assert.equal(await started,true);
 h.child.emit('close',42,null);
 }finally{h.cleanup();t.mock.timers.reset();}
});

test('commands wait for actual output, retain next and publish failure results',async()=>{
 const {CommandHandler}=await import('../../src/main/commands');const {PolicyStore}=await import('../../src/main/policy/store');const {randomUUID}=await import('node:crypto');
 const h=harness();h.child.emit('close',42,null);
 const children:ReturnType<typeof harness>['child'][]=[];
 const manager=new TaskManager(h.store,{id:'routing',canLaunchReal:()=>true,start:()=>{const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});children.push(child);return child;}});
 const policy=new PolicyStore(join(h.dir,'weaver.db'));const handler=new CommandHandler(manager,policy);
 const request=(command:string,args:Record<string,unknown>)=>({apiVersion:'weaver.v1',commandId:randomUUID(),command,args});
 try{
 const task=manager.create({title:'async',instruction:'fake',workspace:h.dir,owner:{name:'o',transport:'herdr-visible',session:'s',pane:'p'}});
 const response=handler.handleAsync(request('workers.spawn',{taskId:task.id,owner:'claude_owner',worker:'codex_worker'}));
 let settled=false;response.then(()=>settled=true);await Promise.resolve();assert.equal(settled,false);assert.equal(children.length,1);
 children[0].emit('first-output',new Date().toISOString());
 const result=await response;assert.equal(result.ok,true,JSON.stringify(result));assert.equal((result.data as any).started,true);assert.equal((result.data as any).next.action,'wait');
 children[0].stderr.write('No input provided via stdin\n');children[0].emit('close',42,null);
 const manifest=handler.handle(request('tasks.results',{taskId:task.id}));assert.equal((manifest.data as any).failure.kind,'vendor');assert.equal((manifest.data as any).failure.exitCode,42);
 }finally{handler.draining=true;h.cleanup();}
});

test('vendor blocks use policy and reroute queued work to another enabled engine',async()=>{
 const {CommandHandler}=await import('../../src/main/commands');const {PolicyStore}=await import('../../src/main/policy/store');
 const h=harness();const policy=new PolicyStore(join(h.dir,'weaver.db'));const starts:string[]=[];
 const manager=new TaskManager(h.store,{id:'routing',canLaunchReal:()=>true,start:task=>{starts.push(task.dispatch!.engine);return Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});}});
 const handler=new CommandHandler(manager,policy);
 try{
 const task=h.store.get(h.id);task.dispatch!.engine='codex';task.dispatch!.engineKind='codex';h.store.put(task);
 const queued=manager.create({title:'queued',instruction:'fake',workspace:h.dir,owner:{name:'o',transport:'herdr-visible',session:'s',pane:'p'}});
 queued.scheduled=true;queued.dispatch={owner:'claude_owner',worker:'codex_worker',engine:'codex',engineKind:'codex',model:'gpt-6.1-sol',effort:'high',execution:'real',adapter:'codex',maxParallel:2,workspace:h.dir};h.store.put(queued);
 h.child.emit('vendor-error','Rate limit exceeded',classifyVendorError('codex','Rate limit exceeded'));
 handler.pump();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 const block=policy.snapshot().blocks.find(b=>b.engine==='codex');assert.equal(block?.by,'weaver-vendor-limit');assert.match(block?.reason??'',/Rate limit/);assert.ok(block?.release_at);
 assert.notEqual(h.store.get(queued.id).dispatch?.engine,'codex');assert.equal(h.store.get(queued.id).status,'running');
 h.child.emit('close',42,null);
 }finally{handler.draining=true;h.cleanup();}
});

test('quota blocks have no invented reset and are not restored after unblock and restart',async()=>{
 const {CommandHandler}=await import('../../src/main/commands');const {PolicyStore}=await import('../../src/main/policy/store');
 const h=harness();const policy=new PolicyStore(join(h.dir,'weaver.db'));const handler=new CommandHandler(h.manager,policy);let restarted:InstanceType<typeof CommandHandler>|undefined;
 try{
 const task=h.store.get(h.id);task.dispatch!.engine='codex';h.store.put(task);
 h.child.emit('vendor-error','FreeUsageLimitError',classifyVendorError('opencode','FreeUsageLimitError'));handler.pump();await new Promise(resolve=>setImmediate(resolve));
 const block=policy.snapshot().blocks.find(b=>b.engine==='codex');assert.equal(block?.by,'weaver-vendor-limit');assert.equal(block?.release_at,undefined);
 h.child.emit('close',42,null);handler.draining=true;
 const snapshot=policy.snapshot();policy.save({revision:snapshot.revision,config:snapshot.config,blocks:[]});
 restarted=new CommandHandler(h.manager,policy);restarted.pump();await new Promise(resolve=>setImmediate(resolve));assert.equal(policy.snapshot().blocks.length,0);
 }finally{handler.draining=true;if(restarted)restarted.draining=true;h.cleanup();}
});
