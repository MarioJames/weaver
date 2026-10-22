import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,existsSync,writeFileSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter,join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../../src/main/store';
import { PolicyStore } from '../../src/main/policy/store';
import { TaskManager } from '../../src/main/manager';
import { MockWorkerAdapter } from '../../src/main/adapters/worker';
import { CommandHandler } from '../../src/main/commands';
import { nextRun,timing } from '../../src/main/schedules/input';
import { OUTPUT_BYTES } from '../../src/main/schedules/process';
import { ScheduleService } from '../../src/main/schedules/service';
import { recoverOwnedScope } from '../../src/main/adapters/cli/scope';
import type { ScheduleDefinition,ScheduleRun } from '../../src/shared/contracts/schedules';
import type { CommandResponse } from '../../src/shared/contracts/commands';
import type { EngineQuotaRecord,QuotaEngine } from '../../src/shared/contracts/quota';

const ROOT=process.env.ACCEPTANCE_TMPDIR??tmpdir();
const AT=Date.parse('2030-01-01T00:00:00Z');
function setup(){
 const dir=mkdtempSync(join(ROOT,'wv-sch-')),store=new TaskStore(join(dir,'weaver.db')),policy=new PolicyStore(store.db);
 let clock=AT;
 const manager=new TaskManager(store,new MockWorkerAdapter(process.execPath,resolve('scripts/mock-worker.mjs')));
 const launches:string[]=[];
 const handler=new CommandHandler(manager,policy,undefined,()=>false,undefined,{launcher:async a=>{launches.push(a.taskId);return {session:'test',workspaceId:'test',paneId:'test:p1',agentName:'fixture'};}},{now:()=>clock});
 const raw=(command:string,args:Record<string,unknown>={},commandId:string=randomUUID())=>handler.handle({apiVersion:'weaver.v1',command,args,commandId});
 const call=<T=any>(command:string,args:Record<string,unknown>={},commandId?:string):T=>{const r=raw(command,args,commandId);assert.equal(r.ok,true,JSON.stringify(r));return r.data as T;};
 const create=(extra:Record<string,unknown>={})=>call<ScheduleDefinition>('schedules.create',{name:'fixture',kind:'script',enabled:false,timing:{mode:'interval',seconds:5},workspace:dir,script:{command:'printf hello',timeoutSeconds:10},...extra});
 const settled=async(d:ScheduleDefinition,id:string)=>{for(let i=0;i<500;i++){handler.schedules.tick();const r=call<{runs:ScheduleRun[]}>('schedules.runs',{scheduleId:d.id,runId:id}).runs[0];if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,20));}throw new Error('Run did not settle');};
 return {dir,store,policy,manager,handler,launches,call,raw,create,settled,clock:(value:number)=>{clock=value;},close:async()=>{await handler.drain();await manager.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}};
}

const waitFor=async(predicate:()=>boolean,{timeout=10000,step=20}={}):Promise<void>=>{const started=Date.now();while(!predicate()){if(Date.now()-started>timeout)throw new Error('waitFor timeout');await new Promise(r=>setTimeout(r,step));}};

test('cron validates shape/timezone, computes actual DST behavior without timers',()=>{
 assert.equal(nextRun(timing({mode:'cron',expression:'0 9 * * *',timezone:'Asia/Shanghai'}),AT),'2030-01-01T01:00:00.000Z');
 assert.equal(nextRun(timing({mode:'cron',expression:'0 2 * * *',timezone:'America/New_York'}),Date.parse('2030-03-10T05:00:00Z')),'2030-03-10T07:00:00.000Z');
 for(const value of [{mode:'interval',seconds:0},{mode:'interval',seconds:1.1},{mode:'cron',expression:'2030-01-01',timezone:'UTC'},{mode:'cron',expression:'0 9 * * *',timezone:'bogus'},{mode:'cron',expression:'0 90 * * *',timezone:'UTC'}])assert.throws(()=>timing(value));
});

test('definitions survive reopen, validate strictly, protect revisions and builtin ownership',async()=>{
 const f=setup();try{
  const d=f.create();const other=new TaskStore(f.store.path);try{assert.equal(other.getValue<any>('schedules.v1').definitions.find((v:any)=>v.id===d.id).name,'fixture');}finally{other.close();}
  assert.equal(f.raw('schedules.create',{...d,builtin:'quota.refresh'}).ok,false);
  assert.equal(f.raw('schedules.update',{scheduleId:d.id,expectedRevision:d.revision+1,patch:{name:'x'}}).error?.code,'REVISION_CONFLICT');
  assert.equal(f.raw('schedules.create',{name:'bad',kind:'script',timing:d.timing,workspace:'relative',script:d.script}).ok,false);
  const builtin=f.call<{schedules:ScheduleDefinition[]}>('schedules.list').schedules.find(v=>v.builtin)!;
  assert.match(builtin.id,/^[0-9a-f-]{36}$/);
  assert.equal(f.raw('schedules.delete',{scheduleId:builtin.id,expectedRevision:builtin.revision}).ok,false);
  assert.equal(f.raw('schedules.update',{scheduleId:builtin.id,expectedRevision:builtin.revision,patch:{script:{command:'evil',timeoutSeconds:1}}}).ok,false);
 }finally{await f.close();}
});

test('real script claims are exclusive, receipt replay after completion does not spawn again, manual keeps cadence',async()=>{
 const f=setup();try{
  const path=join(f.dir,'effects'),d=f.create({enabled:true,script:{command:`printf x >> '${path}'; sleep 0.05; printf hello`,timeoutSeconds:5}}),commandId=randomUUID();
  const run=f.call<ScheduleRun>('schedules.run',{scheduleId:d.id},commandId);
  assert.equal(run.status,'running');assert.equal(f.raw('schedules.run',{scheduleId:d.id}).error?.code,'INVALID_STATE');
  assert.equal(f.raw('schedules.update',{scheduleId:d.id,expectedRevision:d.revision,patch:{name:'edit'}}).ok,false);
  assert.equal(f.call<ScheduleDefinition>('schedules.get',{scheduleId:d.id}).nextRunAt,d.nextRunAt);
  const result=await f.settled(d,run.id);assert.equal(result.status,'succeeded');assert.match(result.output,/hello/);
  assert.equal(f.call<ScheduleRun>('schedules.run',{scheduleId:d.id},commandId).id,run.id);
  await new Promise(r=>setTimeout(r,30));assert.equal(readFileSync(path,'utf8'),'x');
  assert.equal(f.call<ScheduleDefinition>('schedules.get',{scheduleId:d.id}).revision,d.revision);
  const disabled=f.call<ScheduleDefinition>('schedules.disable',{scheduleId:d.id,expectedRevision:d.revision});assert.equal(disabled.nextRunAt,null);
 }finally{await f.close();}
});

test('real scripts record failures, timeout, targeted cancellation, descendant cleanup and exact output overflow',async()=>{
 const f=setup();try{
  for(const [script,status,error] of [
   [{command:'printf failed >&2; exit 7',timeoutSeconds:5},'failed',undefined],
   [{command:'sleep 20',timeoutSeconds:1},'failed','timed out'],
  ] as const){const d=f.create({script}),run=f.call<ScheduleRun>('schedules.run',{scheduleId:d.id}),result=await f.settled(d,run.id);assert.equal(result.status,status);if(error)assert.match(result.error!,new RegExp(error));else{assert.equal(result.exitCode,7);assert.match(result.output,/failed/);}}
  const d=f.create({script:{command:`sleep 20 & printf $! > '${join(f.dir,'child')}'; wait`,timeoutSeconds:30}}),run=f.call<ScheduleRun>('schedules.run',{scheduleId:d.id});
  for(let i=0;i<100&&!existsSync(join(f.dir,'child'));i++)await new Promise(r=>setTimeout(r,20));
  const pid=Number(readFileSync(join(f.dir,'child'),'utf8'));
  assert.equal(f.raw('schedules.cancel',{scheduleId:d.id,runId:randomUUID()}).ok,false);
  f.call('schedules.cancel',{scheduleId:d.id,runId:run.id});assert.equal((await f.settled(d,run.id)).status,'cancelled');
  assert.throws(()=>process.kill(pid,0));
  const output=f.create({script:{command:`head -c ${OUTPUT_BYTES} /dev/zero; sleep 0.05; printf x`,timeoutSeconds:5}}),r=f.call<ScheduleRun>('schedules.run',{scheduleId:output.id}),result=await f.settled(output,r.id);
  assert.equal(Buffer.byteLength(result.output),OUTPUT_BYTES);assert.equal(result.truncated,true);
  const page=f.call('schedules.runs',{scheduleId:output.id});assert.ok(Buffer.byteLength(JSON.stringify(page))<4096);assert.equal(page.runs[0].truncated,true);
 }finally{await f.close();}
});

test('tick merges missed triggers, skips busy intervals and does not serialize independent schedules',async()=>{
 const f=setup();try{
  const a=f.create({enabled:true,script:{command:'sleep 0.2',timeoutSeconds:5}}),b=f.create({enabled:true});
  f.clock(AT+3600_000);f.handler.schedules.tick();
  const ar=f.call<ScheduleDefinition>('schedules.get',{scheduleId:a.id}),br=f.call<ScheduleDefinition>('schedules.get',{scheduleId:b.id});assert.ok(ar.activeRunId);assert.ok(br.activeRunId);
  f.clock(AT+7200_000);f.handler.schedules.tick();assert.equal(f.call('schedules.runs',{scheduleId:a.id}).total,1);assert.equal(f.call<ScheduleDefinition>('schedules.get',{scheduleId:a.id}).nextRunAt,new Date(AT+7200_000+5000).toISOString());
  await f.settled(a,ar.activeRunId!);await f.settled(b,br.activeRunId!);
  assert.equal(f.call('schedules.runs',{scheduleId:a.id}).total,1);
 }finally{await f.close();}
});

test('agent root is atomically associated, launched through tasks.start and settles from task terminal state',async()=>{
 const f=setup();try{
  const d=f.create({kind:'agent',script:undefined,agent:{goal:'fixture',ownerProfileId:'codex_owner',acceptanceCriteria:['fixture']}}),run=f.call<ScheduleRun>('schedules.run',{scheduleId:d.id});
  assert.ok(run.taskId);assert.equal(f.store.get(run.taskId!).status,'queued');assert.equal(f.store.list().length,1);
  await new Promise(r=>setTimeout(r,20));assert.equal(f.launches.length,1);assert.equal(f.store.get(run.taskId!).status,'running');
  f.handler.schedules.tick();assert.equal(f.call('schedules.runs',{scheduleId:d.id,runId:run.id}).runs[0].status,'running');
  const task=f.store.get(run.taskId!);task.status='completed';task.summary='finished';task.reviewState='pending';f.store.put(task);
  assert.equal((await f.settled(d,run.id)).status,'succeeded');assert.equal(f.store.list().length,1);
 }finally{await f.close();}
});

test('agent claim rolls back creation on failure and queued durable start intent is never replayed',async()=>{
 const f=setup();let service:ScheduleService|undefined;try{
  const d=f.create({kind:'agent',script:undefined,agent:{goal:'fixture',ownerProfileId:'codex_owner'}});
  const serviceOptions={store:f.store,policy:f.policy,notify:()=>{},command:()=>({apiVersion:'weaver.v1' as const,ok:true}),now:()=>AT};
  const bad=new ScheduleService({...serviceOptions,createTask:()=>{f.manager.create({title:'rollback',instruction:'x',owner:{name:'fixture',transport:'herdr-visible',session:'x',pane:'x'}});throw new Error('injected');}});
  assert.throws(()=>bad.run({scheduleId:d.id}));assert.equal(f.store.list().length,0);assert.equal(f.call('schedules.runs',{scheduleId:d.id}).total,0);
  const run=f.call<ScheduleRun>('schedules.run',{scheduleId:d.id});
  // Crash after claim+binding but before deferred launch: install the durable incomplete intent.
  f.store.putReceipt(`local-demo:schedule-start-${run.id}`,{hash:'fixture'});
  service=new ScheduleService({...serviceOptions,createTask:()=>{throw new Error('must not create again');},command:(command,args,commandId)=>f.handler.handle({apiVersion:'weaver.v1',command,args,commandId})});
  await service.start(60000);assert.equal(f.store.get(run.taskId!).status,'cancelled');assert.equal(f.call('schedules.runs',{scheduleId:d.id,runId:run.id}).runs[0].status,'interrupted');assert.equal(f.launches.length,0);assert.equal(f.store.list().length,1);
 }finally{await service?.stop();await f.close();}
});

test('builtin projects policy save/rollback, block changes preserve cadence, outcomes distinguish exhausted/stale/no targets',async()=>{
 const f=setup();let service:ScheduleService|undefined;try{
  const calls:string[]=[];let stale=false;
  const fresh=(engine:QuotaEngine):EngineQuotaRecord=>({engine,status:'exhausted',source:'fixture',checkedAt:new Date(AT).toISOString(),observedAt:new Date(AT).toISOString(),stale,windows:[],detail:'fixture',retryAt:null});
  service=new ScheduleService({store:f.store,policy:f.policy,now:()=>AT,notify:()=>{},createTask:()=>{},command:()=>({apiVersion:'weaver.v1',ok:true}),refreshQuota:async engine=>{calls.push(engine);return {records:[fresh(engine)],snapshot:f.policy.snapshot(),policyChanged:false};}});
  const builtin=service.list({}).schedules.find(d=>d.builtin)!;const next=builtin.nextRunAt;
  let snap=f.policy.snapshot();f.policy.save({revision:snap.revision,config:snap.config,blocks:[]});const original=f.policy.snapshot().revision;
  assert.equal(service.quotaStatus().nextRunAt,next);
  snap=f.policy.snapshot();snap.config.quota={auto_refresh:false,interval_minutes:30};f.policy.save({revision:snap.revision,config:snap.config,blocks:[]});assert.equal(service.quotaStatus().nextRunAt,null);
  f.policy.rollback(original);assert.equal(service.quotaStatus().enabled,true);assert.equal(service.quotaStatus().intervalMinutes,15);
  const run=service.run({scheduleId:builtin.id});await new Promise(r=>setTimeout(r,20));assert.equal(service.runs({scheduleId:builtin.id,runId:run.id}).runs[0].status,'succeeded');assert.deepEqual(calls,['codex','claude']);
  stale=true;const bad=service.run({scheduleId:builtin.id});await new Promise(r=>setTimeout(r,20));assert.equal(service.runs({scheduleId:builtin.id,runId:bad.id}).runs[0].status,'succeeded');
  snap=f.policy.snapshot();for(const e of Object.values(snap.config.engines))e.quota_refresh=false;f.policy.save({revision:snap.revision,config:snap.config,blocks:snap.blocks});
  const empty=service.run({scheduleId:builtin.id});await new Promise(r=>setTimeout(r,20));assert.equal(service.runs({scheduleId:builtin.id,runId:empty.id}).runs[0].status,'skipped');
 }finally{await service?.stop();await f.close();}
});

test('builtin quota run refreshes an explicitly enabled OpenCode target through the same refresh path',async()=>{
 const f=setup();let service:ScheduleService|undefined;try{
  const calls:string[]=[];
  const record=(engine:QuotaEngine):EngineQuotaRecord=>({engine,status:engine==='opencode'?'unsupported':'exhausted',source:'fixture',checkedAt:new Date(AT).toISOString(),observedAt:engine==='opencode'?null:new Date(AT).toISOString(),stale:engine==='opencode',windows:[],detail:'fixture',retryAt:null});
  service=new ScheduleService({store:f.store,policy:f.policy,now:()=>AT,notify:()=>{},createTask:()=>{},command:()=>({apiVersion:'weaver.v1',ok:true}),refreshQuota:async engine=>{calls.push(engine);return {records:[record(engine)],snapshot:f.policy.snapshot(),policyChanged:false};}});
  let snap=f.policy.snapshot();snap.config.engines.opencode.enabled=true;snap.config.engines.opencode.quota_refresh=true;f.policy.save({revision:snap.revision,config:snap.config,blocks:snap.blocks},{allowEngineEnable:true});
  const builtin=service.list({}).schedules.find(d=>d.builtin)!;const run=service.run({scheduleId:builtin.id});await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(calls,['codex','claude','opencode']);
  assert.equal(service.runs({scheduleId:builtin.id,runId:run.id}).runs[0].status,'succeeded','an unsupported Go observation stays observable in output without failing the run');
  }finally{await service?.stop();await f.close();}
});

test('quota.refresh probe miss stays succeeded with per-engine output and a summary line (partial stale)',async()=>{
 const f=setup();let service:ScheduleService|undefined;try{
  const at=new Date(AT).toISOString();
  const fresh=(engine:QuotaEngine):EngineQuotaRecord=>({engine,status:'available',source:'fixture',checkedAt:at,observedAt:at,stale:false,windows:[],detail:'fixture',retryAt:null});
  const staleUnknown=(engine:QuotaEngine):EngineQuotaRecord=>({engine,status:'unknown',source:'fixture',checkedAt:at,observedAt:null,stale:true,windows:[],detail:'Go 套餐窗口缺失',retryAt:new Date(AT+60000).toISOString()});
  service=new ScheduleService({store:f.store,policy:f.policy,now:()=>AT,notify:()=>{},createTask:()=>{},command:()=>({apiVersion:'weaver.v1',ok:true}),refreshQuota:async engine=>engine==='codex'?{records:[fresh(engine)],snapshot:f.policy.snapshot(),policyChanged:false}:{records:[staleUnknown(engine)],snapshot:f.policy.snapshot(),policyChanged:false}});
  const builtin=service.list({}).schedules.find(d=>d.builtin)!,run=service.run({scheduleId:builtin.id});
  for(let i=0;i<100&&service.runs({scheduleId:builtin.id,runId:run.id}).runs[0].status==='running';i++)await new Promise(r=>setTimeout(r,10));
  const detail=service.runs({scheduleId:builtin.id,runId:run.id}).runs[0];
  assert.equal(detail.status,'succeeded','a partially stale probe must not fail the quota.refresh run');
  assert.ok(!detail.error,`expected empty error, got: ${detail.error}`);
  assert.match(detail.output,/codex/);assert.match(detail.output,/claude/);
  assert.match(detail.output,/Go 套餐窗口缺失/);assert.match(detail.output,/cooldown/);assert.match(detail.output,/stale/);
  assert.match(detail.output,/未获得新鲜额度观测/);assert.match(detail.output,/1 个成功/);
 }finally{await service?.stop();await f.close();}
});

test('quota.refresh probe miss stays succeeded with per-engine output and a summary line (all stale)',async()=>{
 const f=setup();let service:ScheduleService|undefined;try{
  const at=new Date(AT).toISOString();
  const staleRecord=(engine:QuotaEngine):EngineQuotaRecord=>({engine,status:'unknown',source:'fixture',checkedAt:at,observedAt:null,stale:true,windows:[],detail:'no observation',retryAt:null});
  service=new ScheduleService({store:f.store,policy:f.policy,now:()=>AT,notify:()=>{},createTask:()=>{},command:()=>({apiVersion:'weaver.v1',ok:true}),refreshQuota:async engine=>({records:[staleRecord(engine)],snapshot:f.policy.snapshot(),policyChanged:false})});
  const builtin=service.list({}).schedules.find(d=>d.builtin)!,run=service.run({scheduleId:builtin.id});
  for(let i=0;i<100&&service.runs({scheduleId:builtin.id,runId:run.id}).runs[0].status==='running';i++)await new Promise(r=>setTimeout(r,10));
  const detail=service.runs({scheduleId:builtin.id,runId:run.id}).runs[0];
  assert.equal(detail.status,'succeeded','an all-stale probe must not fail the quota.refresh run');
  assert.ok(!detail.error,`expected empty error, got: ${detail.error}`);
  assert.match(detail.output,/codex/);assert.match(detail.output,/claude/);
  assert.match(detail.output,/未获得新鲜额度观测/);assert.match(detail.output,/0 个成功/);
 }finally{await service?.stop();await f.close();}
});

test('quota.refresh probe miss stays succeeded with per-engine output and a summary line (single engine throws)',async()=>{
 const f=setup();let service:ScheduleService|undefined;try{
  const at=new Date(AT).toISOString();
  service=new ScheduleService({store:f.store,policy:f.policy,now:()=>AT,notify:()=>{},createTask:()=>{},command:()=>({apiVersion:'weaver.v1',ok:true}),refreshQuota:async engine=>{
   if(engine==='codex')throw new Error('probe boom');
   return {records:[{engine,status:'available',source:'fixture',checkedAt:at,observedAt:at,stale:false,windows:[],detail:'fixture',retryAt:null}],snapshot:f.policy.snapshot(),policyChanged:false};
  }});
  const builtin=service.list({}).schedules.find(d=>d.builtin)!,run=service.run({scheduleId:builtin.id});
  for(let i=0;i<100&&service.runs({scheduleId:builtin.id,runId:run.id}).runs[0].status==='running';i++)await new Promise(r=>setTimeout(r,10));
  const detail=service.runs({scheduleId:builtin.id,runId:run.id}).runs[0];
  assert.equal(detail.status,'succeeded','a throwing engine probe must not fail the quota.refresh run');
  assert.ok(!detail.error,`expected empty error, got: ${detail.error}`);
  assert.match(detail.output,/codex/);assert.match(detail.output,/probe boom/);assert.match(detail.output,/claude/);
  assert.match(detail.output,/未获得新鲜额度观测/);assert.match(detail.output,/1 个成功/);
 }finally{await service?.stop();await f.close();}
});

test('quota.refresh without a refresh service still fails with its real cause',async()=>{
 const f=setup();let service:ScheduleService|undefined;try{
  service=new ScheduleService({store:f.store,policy:f.policy,now:()=>AT,notify:()=>{},createTask:()=>{},command:()=>({apiVersion:'weaver.v1',ok:true})});
  const builtin=service.list({}).schedules.find(d=>d.builtin)!,run=service.run({scheduleId:builtin.id});
  for(let i=0;i<100&&service.runs({scheduleId:builtin.id,runId:run.id}).runs[0].status==='running';i++)await new Promise(r=>setTimeout(r,10));
  const detail=service.runs({scheduleId:builtin.id,runId:run.id}).runs[0];
  assert.equal(detail.status,'failed');
  assert.equal(detail.error,'Quota refresh service unavailable');
 }finally{await service?.stop();await f.close();}
});

test('Agent recovery starts a bound queued root once and retains a live root across scheduler restart',async()=>{
 const f=setup();let recovered:ScheduleService|undefined;try{
  const d=f.create({kind:'agent',script:undefined,agent:{goal:'fixture',ownerProfileId:'codex_owner'}});
  // Persist claim and task binding without dispatching the post-commit callback (crash boundary).
  const run=(f.handler.schedules as any).claim(d.id,'manual') as ScheduleRun;
  assert.equal(f.store.get(run.taskId!).status,'queued');
  const opts={store:f.store,policy:f.policy,notify:()=>{},now:()=>AT,createTask:()=>{throw new Error('duplicate root');},command:(command:'tasks.start'|'tasks.cancel',args:Record<string,unknown>,commandId:string)=>f.handler.handle({apiVersion:'weaver.v1',command,args,commandId})};
  recovered=new ScheduleService(opts);await recovered.start(60000);await new Promise(r=>setTimeout(r,20));
  assert.equal(f.launches.length,1);assert.ok(f.store.get(run.taskId!).ownerHost);await recovered.stop();
  recovered=new ScheduleService(opts);await recovered.start(60000);await new Promise(r=>setTimeout(r,20));
  assert.equal(f.launches.length,1);assert.equal(f.store.list().length,1);assert.equal(recovered.get({scheduleId:d.id}).activeRunId,run.id);
  recovered.cancel({scheduleId:d.id,runId:run.id});assert.equal(recovered.runs({scheduleId:d.id,runId:run.id}).runs[0].status,'cancelled');
 }finally{await recovered?.stop();await f.close();}
});

test('builtin cancellation keeps the claim until the in-flight target settles, skips remaining targets',async()=>{
 const f=setup();let service:ScheduleService|undefined;try{
  let release:()=>void=()=>{};const hold=new Promise<void>(r=>{release=r;});const calls:string[]=[];
  service=new ScheduleService({store:f.store,policy:f.policy,now:()=>AT,notify:()=>{},createTask:()=>{},command:()=>({apiVersion:'weaver.v1',ok:true}),refreshQuota:async engine=>{calls.push(engine);await hold;return {records:[],snapshot:f.policy.snapshot(),policyChanged:false};}});
  const d=service.list({}).schedules.find(d=>d.builtin)!,r=service.run({scheduleId:d.id});await new Promise(r=>setTimeout(r,0));
  assert.equal(service.cancel({scheduleId:d.id,runId:r.id}).status,'running');assert.equal(service.get({scheduleId:d.id}).activeRunId,r.id);assert.throws(()=>service!.run({scheduleId:d.id}));
  release();await new Promise(r=>setTimeout(r,10));assert.equal(service.runs({scheduleId:d.id,runId:r.id}).runs[0].status,'cancelled');assert.deepEqual(calls,['codex']);
 }finally{await service?.stop();await f.close();}
});

test('100 escaped 64KiB histories and per-run details fit the real authenticated IPC frame',async()=>{
 const {startLocalIPC}=await import('../../src/main/local-ipc');
 const {sendRequest}=await import('../../src/cli/client');
 const f=setup();let ipc:Awaited<ReturnType<typeof startLocalIPC>>|undefined;
 try{
  const d=f.create();
  f.handler.schedules.storage.transaction(s=>{
   s.runs[d.id]=Array.from({length:100},(_,i)=>({id:randomUUID(),scheduleId:d.id,trigger:'manual' as const,status:'succeeded' as const,startedAt:new Date(AT).toISOString(),finishedAt:new Date(AT).toISOString(),output:'\0'.repeat(OUTPUT_BYTES),outputSlot:i,definition:d}));
  });
  ipc=await startLocalIPC(f.dir,r=>f.handler.handleAsync(r));
  const request=(args:Record<string,unknown>)=>sendRequest(f.dir,{apiVersion:'weaver.v1',command:'schedules.runs',args:{scheduleId:d.id,...args}}) as Promise<any>;
  const page=await request({limit:100});assert.equal(page.ok,true,JSON.stringify(page));assert.equal(page.data.total,100);assert.equal(page.data.runs[0].output.length,256);assert.equal(page.data.runs[0].truncated,true);
  const detail=await request({runId:page.data.runs[0].id});assert.equal(detail.ok,true);assert.equal(detail.data.runs[0].output.length,OUTPUT_BYTES);assert.equal(detail.data.runs[0].truncated,false);
  const newest=f.handler.schedules.storage.read().runs[d.id][0];assert.ok(newest.output.length<=256);
 }finally{await ipc?.close();await f.close();}
});

test('normal shell exit cleans background pipe holders; shutdown interrupts owned runs; inherited credential output is redacted',async()=>{
 const f=setup();const previous=process.env.WEAVER_SCHEDULE_TEST_TOKEN;process.env.WEAVER_SCHEDULE_TEST_TOKEN=`sensitive-${randomUUID()}`;
 try{
  const bg=join(f.dir,'background'),d=f.create({script:{command:`sleep 60 & printf $! > '${bg}'; printf "$WEAVER_SCHEDULE_TEST_TOKEN"`,timeoutSeconds:10}}),run=f.call<ScheduleRun>('schedules.run',{scheduleId:d.id}),result=await f.settled(d,run.id);
  assert.equal(result.status,'succeeded');assert.doesNotMatch(result.output,/sensitive-/);assert.match(result.output,/REDACTED/);
  assert.throws(()=>process.kill(Number(readFileSync(bg,'utf8')),0));
  const pid=join(f.dir,'shutdown'),long=f.create({script:{command:`printf $$ > '${pid}'; sleep 60`,timeoutSeconds:90}}),active=f.call<ScheduleRun>('schedules.run',{scheduleId:long.id});
  for(let i=0;i<100&&!existsSync(pid);i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(existsSync(pid));await f.handler.schedules.stop();assert.equal(f.call('schedules.runs',{scheduleId:long.id,runId:active.id}).runs[0].status,'interrupted');assert.throws(()=>process.kill(Number(readFileSync(pid,'utf8')),0));
 }finally{if(previous===undefined)delete process.env.WEAVER_SCHEDULE_TEST_TOKEN;else process.env.WEAVER_SCHEDULE_TEST_TOKEN=previous;await f.close();}
});


test('save rejects impossible calendar cron dates and retains a valid future leap day',async()=>{
 const f=setup();try{
  for(const expression of ['0 0 31 2 *','0 0 30 2 *']){
   const result=f.raw('schedules.create',{name:'impossible',kind:'script',enabled:true,timing:{mode:'cron',expression,timezone:'UTC'},workspace:f.dir,script:{command:'true',timeoutSeconds:10}});
   assert.equal(result.error?.code,'INVALID_REQUEST');assert.match(result.error!.message,/no future trigger/);
  }
  const valid=f.create({enabled:true,timing:{mode:'cron',expression:'0 0 29 2 *',timezone:'UTC'}});
  assert.equal(valid.nextRunAt,'2032-02-29T00:00:00.000Z');
  const update=f.raw('schedules.update',{scheduleId:valid.id,expectedRevision:valid.revision,patch:{timing:{mode:'cron',expression:'0 0 31 2 *',timezone:'UTC'}}});
  assert.equal(update.error?.code,'INVALID_REQUEST');assert.match(update.error!.message,/no future trigger/);
  assert.deepEqual(f.call<ScheduleDefinition>('schedules.get',{scheduleId:valid.id}),valid);
 }finally{await f.close();}
});

test('a capture-cut stream of a long inherited secret is fully redacted instead of leaking its tail prefix',async()=>{
 const f=setup();const previous=process.env.WEAVER_SCHEDULE_TEST_SECRET;
 const token='abcdefghijklmnopqrstuvwxyz'.repeat(5).slice(0,123);
 process.env.WEAVER_SCHEDULE_TEST_SECRET=token;
 try{
  const d=f.create({script:{command:'for i in $(seq 1 600); do printf %s "$WEAVER_SCHEDULE_TEST_SECRET"; done',timeoutSeconds:10}}),run=f.call<ScheduleRun>('schedules.run',{scheduleId:d.id}),result=await f.settled(d,run.id);
  assert.equal(result.status,'succeeded');assert.equal(result.truncated,true);
  assert.ok(Buffer.byteLength(result.output)<=OUTPUT_BYTES);
  assert.equal(result.output.includes('abcdefghijklmnopqrstuvwxyz'),false);
  assert.match(result.output,/\[REDACTED\]$/);
 }finally{if(previous===undefined)delete process.env.WEAVER_SCHEDULE_TEST_SECRET;else process.env.WEAVER_SCHEDULE_TEST_SECRET=previous;await f.close();}
});

test('a capture boundary inside a chunk-split inherited secret leaks nothing and keeps the byte cap',async()=>{
 const f=setup();const previous=process.env.WEAVER_SCHEDULE_TEST_SECRET,previousHead=process.env.WEAVER_CHUNK_HEAD,previousTail=process.env.WEAVER_CHUNK_TAIL;
 const token='abcdefghijklmnopqrstuvwxyz'.repeat(5).slice(0,123);
 process.env.WEAVER_SCHEDULE_TEST_SECRET=token;process.env.WEAVER_CHUNK_HEAD=token.slice(0,61);process.env.WEAVER_CHUNK_TAIL=token.slice(61);
 try{
  const d=f.create({script:{command:`for i in $(seq 1 533); do printf %s "$WEAVER_SCHEDULE_TEST_SECRET"; done; printf %s "$WEAVER_CHUNK_HEAD"; sleep 0.03; printf %s "$WEAVER_CHUNK_TAIL"`,timeoutSeconds:10}}),run=f.call<ScheduleRun>('schedules.run',{scheduleId:d.id}),result=await f.settled(d,run.id);
  assert.equal(result.status,'succeeded');assert.equal(result.truncated,true);
  assert.ok(Buffer.byteLength(result.output)<=OUTPUT_BYTES);
  assert.equal(result.output.includes('abcdefghijklmnopqrstuvwxyz'),false);
  assert.doesNotMatch(result.output,/^[a-z]{61,}/);
 }finally{
  for(const [name,old] of [['WEAVER_SCHEDULE_TEST_SECRET',previous],['WEAVER_CHUNK_HEAD',previousHead],['WEAVER_CHUNK_TAIL',previousTail]] as const){
   if(old===undefined)delete process.env[name];else process.env[name]=old;
  }
  await f.close();
 }
});

test('a finished script claim is released only after the owned scope cleanup is strictly confirmed',async()=>{
 const f=setup();let service:ScheduleService|undefined;
 try{
  let attempts=0,releaseFirst:(ok:boolean)=>void=()=>{};
  const firstGate=new Promise<void>((resolve,reject)=>{releaseFirst=ok=>ok?resolve():reject(new Error('Cannot inspect schedule scope; systemd user session is unavailable'));});
  service=new ScheduleService({store:f.store,policy:f.policy,notify:()=>{},createTask:()=>{},
   command:()=>({apiVersion:'weaver.v1',ok:true}),
   recoverScope:unit=>{attempts+=1;return attempts===1?firstGate:recoverOwnedScope(unit);}});
  const d=service.create({name:'strict confirm',kind:'script',enabled:false,timing:{mode:'interval',seconds:60},workspace:f.dir,script:{command:'printf done',timeoutSeconds:10}});
  const run=service.run({scheduleId:d.id});
  await waitFor(()=>attempts>0);
  assert.equal(service.runs({scheduleId:d.id,runId:run.id}).runs[0].status,'running');
  assert.equal(service.get({scheduleId:d.id}).activeRunId,run.id);
  assert.throws(()=>service!.run({scheduleId:d.id}),/active run/);
  releaseFirst(false);
  await waitFor(()=>!!service!.storage.read().runs[d.id][0].recoveryError);
  let r=service.storage.read().runs[d.id][0];
  assert.equal(r.status,'running');assert.equal(service.get({scheduleId:d.id}).activeRunId,run.id);
  assert.match(r.recoveryError!,/systemd user session is unavailable/);assert.match(r.output,/done/);
  service.tick();
  await waitFor(()=>service!.storage.read().runs[d.id][0].status==='interrupted');
  r=service.storage.read().runs[d.id][0];
  assert.equal(r.output,'done');
  assert.equal(service.get({scheduleId:d.id}).activeRunId,undefined);
  assert.equal(service.runs({scheduleId:d.id,runId:run.id}).runs[0].error,'Previous service execution ended; owned process cleanup confirmed');
 }finally{await service?.stop();await f.close();}
});

test('an indeterminate agent start never replays the intent; only a verifiably terminal task releases the claim',async()=>{
 const f=setup();let service:ScheduleService|undefined;try{
  const d=f.create({kind:'agent',script:undefined,agent:{goal:'fixture',ownerProfileId:'codex_owner'}});
  const run=(f.handler.schedules as any).claim(d.id,'manual') as ScheduleRun;
  assert.equal(f.store.get(run.taskId!).status,'queued');
  const calls:string[]=[];
  const indeterminate:CommandResponse={apiVersion:'weaver.v1',ok:false,error:{code:'COMMAND_INDETERMINATE',message:'start receipt incomplete',retryable:false}};
  service=new ScheduleService({store:f.store,policy:f.policy,notify:()=>{},createTask:()=>{throw new Error('must not create again');},
   command:(command:'tasks.start'|'tasks.cancel',args:Record<string,unknown>,commandId:string):CommandResponse=>{
    calls.push(`${command} ${commandId}`);
    if(command==='tasks.start'){const task=f.store.get(String(args.taskId));task.status='running';f.store.put(task);}
    return indeterminate;
   }});
  await service.start(60000);
  assert.deepEqual(calls,[`tasks.start schedule-start-${run.id}`,`tasks.cancel schedule-abort-${run.id}`]);
  assert.equal(f.store.get(run.taskId!).status,'running');
  let detail=service.runs({scheduleId:d.id,runId:run.id}).runs[0];
  assert.equal(detail.status,'running');
  assert.match(detail.error!,/Agent cancel not confirmed; task remains running \(cancel responded COMMAND_INDETERMINATE\)/);
  assert.equal(service.get({scheduleId:d.id}).activeRunId,run.id);
  assert.throws(()=>service!.run({scheduleId:d.id}),/active run/);
  service.tick();await new Promise(r=>setTimeout(r,10));service.tick();await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(calls,[`tasks.start schedule-start-${run.id}`,`tasks.cancel schedule-abort-${run.id}`]);
  assert.equal(service.runs({scheduleId:d.id,runId:run.id}).runs[0].status,'running');
  const task=f.store.get(run.taskId!);task.status='cancelled';task.reviewState='pending';f.store.put(task);
  service.tick();await new Promise(r=>setTimeout(r,10));
  detail=service.runs({scheduleId:d.id,runId:run.id}).runs[0];
  assert.equal(detail.status,'cancelled');
  assert.equal(service.get({scheduleId:d.id}).activeRunId,undefined);
 }finally{await service?.stop();await f.close();}
});

test('an incomplete queued start and abort receipt keep the claim until the Task actually becomes terminal',async()=>{
 const f=setup();let service:ScheduleService|undefined;try{
  const d=f.create({kind:'agent',script:undefined,agent:{goal:'fixture',ownerProfileId:'codex_owner'}});
  const run=(f.handler.schedules as any).claim(d.id,'manual') as ScheduleRun;
  f.store.putReceipt(`local-demo:schedule-start-${run.id}`,{hash:'fixture'});
  const { digest }=await import('../../src/main/application/tasks/records');
  f.store.putReceipt(`local-demo:schedule-abort-${run.id}`,{hash:digest({command:'tasks.cancel',args:{taskId:run.taskId}})});
  const calls:string[]=[];
  service=new ScheduleService({store:f.store,policy:f.policy,notify:()=>{},createTask:()=>{throw new Error('must not create again');},
   command:(command,args,commandId)=>{
    calls.push(command);
    return f.handler.handle({apiVersion:'weaver.v1',command,args,commandId});
   }});
  await service.start(60000);service.tick();
  const detail=service.runs({scheduleId:d.id,runId:run.id}).runs[0];
  assert.equal(detail.status,'running');assert.equal(f.store.get(run.taskId!).status,'queued');
  assert.match(detail.error!,/Agent cancel not confirmed; task remains queued \(cancel responded COMMAND_INDETERMINATE\)/);
  assert.equal(service.get({scheduleId:d.id}).activeRunId,run.id);
  assert.throws(()=>service!.run({scheduleId:d.id}),/active run/);
  assert.ok(calls.length>0);assert.ok(calls.every(command=>command==='tasks.cancel'));assert.equal(f.launches.length,0);
  const task=f.store.get(run.taskId!);task.status='cancelled';task.reviewState='pending';f.store.put(task);
  service.tick();assert.equal(service.runs({scheduleId:d.id,runId:run.id}).runs[0].status,'cancelled');
  assert.equal(service.get({scheduleId:d.id}).activeRunId,undefined);
 }finally{await service?.stop();await f.close();}
});

for(const cleanupSucceeds of [true,false])test(`two distinct cancellation receipts cannot release a pending recovery claim (cleanup ${cleanupSucceeds?'succeeds':'fails'})`,async()=>{
 const f=setup();let release:()=>void=()=>{};
 const gate=new Promise<void>((resolve,reject)=>{release=()=>cleanupSucceeds?resolve():reject(new Error('Injected strict cleanup failure'));});
 try{
  const service=f.handler.schedules;
  (service as any).options.recoverScope=()=>gate;
  const d=f.create(),run=(service as any).claim(d.id,'manual') as ScheduleRun;
  const starting=service.start(60000);
  for(const commandId of ['cancel-recovery-first','cancel-recovery-second']){
   const result=f.call<ScheduleRun>('schedules.cancel',{scheduleId:d.id,runId:run.id},commandId);
   assert.equal(result.status,'running');assert.ok(f.store.getReceipt(`local-demo:${commandId}`)?.response);
   assert.equal(f.raw('schedules.run',{scheduleId:d.id}).error?.code,'INVALID_STATE');
  }
  release();await starting;
  const result=f.call<{runs:ScheduleRun[]}>('schedules.runs',{scheduleId:d.id,runId:run.id}).runs[0];
  assert.equal(result.status,cleanupSucceeds?'cancelled':'running');
  assert.equal(service.get({scheduleId:d.id}).activeRunId,cleanupSucceeds?undefined:run.id);
  if(!cleanupSucceeds){assert.match(result.error!,/Injected strict cleanup failure/);assert.equal(f.raw('schedules.run',{scheduleId:d.id}).error?.code,'INVALID_STATE');}
 }finally{release();await f.close();}
});

for(const [name,token,count] of [
 ['UTF-8 half-codepoint',('测🙂边🔐界').repeat(7),700],
 ['secret beyond generic text limit','q'.repeat(90000)+'z',4],
 ['overlapping complete secrets','ababa',40000],
] as const)test(`real script redacts repeated ${name} before capture decoding`,async()=>{
 const f=setup(),old=process.env.WEAVER_SCHEDULE_TEST_SECRET;
 process.env.WEAVER_SCHEDULE_TEST_SECRET=token;
 try{
  const d=f.create({script:{command:`for i in $(seq 1 ${count}); do printf ${name==='overlapping complete secrets'?'%.2s':'%s'} "$WEAVER_SCHEDULE_TEST_SECRET"; done`,timeoutSeconds:10}});
  const run=f.call<ScheduleRun>('schedules.run',{scheduleId:d.id}),result=await f.settled(d,run.id);
  assert.equal(result.status,'succeeded');assert.equal(result.truncated,true);
  assert.ok(Buffer.byteLength(result.output)<=OUTPUT_BYTES);
  assert.match(result.output,/REDACTED/);assert.doesNotMatch(result.output,/[测🙂边🔐界qzabc]/u);
  assert.doesNotMatch(result.output,/�/);
 }finally{if(old===undefined)delete process.env.WEAVER_SCHEDULE_TEST_SECRET;else process.env.WEAVER_SCHEDULE_TEST_SECRET=old;await f.close();}
});

test('normal shell close with redirected descendants fails closed while scope queries are unavailable',async()=>{
 const f=setup(),originalPath=process.env.PATH;
 const realSystemctl=(originalPath??'').split(delimiter).map(dir=>join(dir,'systemctl')).find(path=>existsSync(path));
 assert.ok(realSystemctl);
 const shim=join(f.dir,'systemctl'),block=join(f.dir,'block-query'),pidFile=join(f.dir,'redirected-pid');
 let unit:string|undefined;
 try{
  // Controlled query failure in this task-local PATH shim, not a real systemd outage.
  writeFileSync(shim,`#!/bin/sh
if [ "$2" = show ] && [ -f '${block}' ]; then echo 'injected query unavailable' >&2; exit 1; fi
exec '${realSystemctl}' "$@"
`,{mode:0o755});
  process.env.PATH=`${f.dir}${delimiter}${originalPath??''}`;
  const d=f.create({script:{command:`sleep 60 >/dev/null 2>&1 & printf $! > '${pidFile}'; printf done; touch '${block}'`,timeoutSeconds:10}});
  const run=f.call<ScheduleRun>('schedules.run',{scheduleId:d.id});unit=f.handler.schedules.storage.read().runs[d.id][0].process!.unit;
  await waitFor(()=>!!f.handler.schedules.storage.read().runs[d.id][0].recoveryError);
  const pid=Number(readFileSync(pidFile,'utf8'));process.kill(pid,0);
  let result=f.call<{runs:ScheduleRun[]}>('schedules.runs',{scheduleId:d.id,runId:run.id}).runs[0];
  assert.equal(result.status,'running');assert.match(result.error!,/Cannot inspect schedule scope/);
  assert.equal(result.output,'done');assert.ok(Buffer.byteLength(result.output)<=OUTPUT_BYTES);
  assert.equal(f.raw('schedules.run',{scheduleId:d.id}).error?.code,'INVALID_STATE');
  unlinkSync(block);process.env.PATH=originalPath;
  f.handler.schedules.tick();
  await waitFor(()=>f.handler.schedules.get({scheduleId:d.id}).activeRunId===undefined);
  result=f.call<{runs:ScheduleRun[]}>('schedules.runs',{scheduleId:d.id,runId:run.id}).runs[0];
  assert.equal(result.status,'interrupted');assert.throws(()=>process.kill(pid,0));
 }finally{
  process.env.PATH=originalPath;if(existsSync(block))unlinkSync(block);
  if(unit)await recoverOwnedScope(unit);
  await f.close();
 }
});

test('an unavailable associated Task identity keeps the schedule claim until terminal state is verified',async()=>{
 const f=setup();let service:ScheduleService|undefined;
 const originalGet=f.store.get.bind(f.store);
 try{
  const d=f.create({kind:'agent',script:undefined,agent:{goal:'fixture',ownerProfileId:'codex_owner'}});
  const run=(f.handler.schedules as any).claim(d.id,'manual') as ScheduleRun;
  f.store.get=id=>{if(id===run.taskId)throw new Error('Task identity unavailable');return originalGet(id);};
  service=new ScheduleService({store:f.store,policy:f.policy,notify:()=>{},createTask:()=>{throw new Error('duplicate');},command:()=>{throw new Error('must not start or cancel an unknown identity');}});
  await service.start(60000);service.tick();
  assert.equal(service.get({scheduleId:d.id}).activeRunId,run.id);
  assert.match(service.runs({scheduleId:d.id,runId:run.id}).runs[0].error!,/task is missing; ownership inspection required/);
  assert.throws(()=>service!.run({scheduleId:d.id}),/active run/);
  f.store.get=originalGet;
  const task=f.store.get(run.taskId!);task.status='completed';task.summary='verified terminal';f.store.put(task);
  service.tick();assert.equal(service.get({scheduleId:d.id}).activeRunId,undefined);
  assert.equal(service.runs({scheduleId:d.id,runId:run.id}).runs[0].status,'succeeded');
 }finally{f.store.get=originalGet;await service?.stop();await f.close();}
});
