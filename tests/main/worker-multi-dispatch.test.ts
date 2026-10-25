import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../../src/shared/contracts/policy';
import { resolveDispatch } from '../../src/main/policy/routing';
import { previewRoute } from '../../src/main/policy/preview';
import type { ChannelRoutingContext } from '../../src/main/policy/worker-channel-routing';
const now = Date.parse('2026-10-25T12:00:00Z');
function fixture(): {config:Config;context:ChannelRoutingContext} {
 const config:Config={version:1,engines:{codex:{enabled:true,kind:'codex'}},channels:Object.fromEntries(['a','b','single'].map(id=>[id,{enabled:true,kind:'subscription',engine:'codex',label:id}])),owners:{o:{enabled:true,channel:'single',model:'gpt-5',effort:'high',workers:['pool','single'],worker_weights:{pool:2,single:1},max_parallel:2}},workers:{pool:{enabled:true,channels:['a','b'],model:'gpt-5',effort:'high',max_parallel:1},single:{enabled:true,channels:['single'],model:'gpt-5',effort:'high'}},herdr:{max_wait_minutes:1}};
 const context:ChannelRoutingContext={now,credentialsReady:()=>true,quotas:['a','b'].map(channel=>({channel,engine:'codex',source:'codex_usage',status:'available',stale:false,checkedAt:new Date(now).toISOString(),observedAt:new Date(now).toISOString(),windows:[],detail:'',retryAt:null}))};
 return {config,context};
}
test('worker weights and caps apply before exactly one account draw, each eligible account reachable',()=>{
 const {config,context}=fixture();
 for(const index of [0,1]){let calls=0;const route=resolveDispatch(config,[],{owner:'o'},{...context,pickIndex:n=>{calls++;assert.equal(n,2);return index;}});assert.equal(route.worker,'pool');assert.equal(route.channel,['a','b'][index]);assert.equal(calls,1);}
 const route=resolveDispatch(config,[],{owner:'o',workerLoad:{pool:1}},{...context,pickIndex:()=>{throw Error('must not draw for rejected worker');}});assert.equal(route.worker,'single');
});
test('frozen preview never draws or substitutes sibling when frozen quota is lost',()=>{
 const {config,context}=fixture();const ctx={...context,pickIndex:()=>{throw Error('pump redrew');}};
 for(let i=0;i<3;i++)assert.equal(previewRoute(config,[],now,{owner:'o',worker:'pool'},ctx,'b').channel,'b');
 context.quotas[1]!.windows=[{id:'weekly',label:'private vendor label',scope:'account',model:null,usedPercent:100,remainingPercent:0,resetsAt:new Date(now+60_000).toISOString(),durationMinutes:10080,used:null,total:null,remaining:null,unit:'percent'}];assert.throws(()=>previewRoute(config,[],now,{owner:'o',worker:'pool'},ctx,'b'));
});
test('exclude channels and specific vendor blocks leave sibling selectable; RPC cannot supply trusted context',()=>{
 const {config,context}=fixture();
 assert.equal(resolveDispatch(config,[],{owner:'o',worker:'pool',excludeChannels:['a']},context).channel,'b');
 assert.equal(resolveDispatch(config,[{engine:'codex',channel:'a',worker:'pool',reason:'limit',since:new Date(now).toISOString()}],{owner:'o',worker:'pool'},context).channel,'b');
 assert.throws(()=>previewRoute(config,[],now,{owner:'o',context},context));
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { PolicyStore } from '../../src/main/policy/store';
import { RoutingWorkerAdapter } from '../../src/main/adapters/routing';
import { prepareCliAgentInput, type PreparedCliAgent } from '../../src/main/adapters/cli/launch';
import type { CliAgentInput, ManagedAgentProcess } from '../../src/main/adapters/cli/types';
import { CommandHandler } from '../../src/main/commands';
import { ChannelStore } from '../../src/main/channels/store';
import { nativeCredentialsReady } from '../../src/main/channels/native';
import { dbQuotaStore } from '../../src/main/storage/quota-snapshot';
import { Dispatcher } from '../../src/main/application/scheduling/dispatch';
import { TaskRecords } from '../../src/main/application/tasks/records';
import { ScheduleService } from '../../src/main/schedules/service';
import { chainChannels, chainWorkers } from '../../src/main/application/scheduling/retry';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function integrationFixture() {
 const dir=mkdtempSync(join(tmpdir(),'m-'));
 const store=new TaskStore(join(dir,'weaver.db')),policy=new PolicyStore(store.db),secrets=new ChannelStore(store.db);
 const saved=policy.snapshot();const c=saved.config;
 c.channels.account_b={...c.channels.default_codex!,label:'B'};
 c.workers.codex_worker!.channels=['default_codex','account_b'];
 c.owners.claude_owner!.workers=['codex_worker'];
 policy.save({revision:saved.revision,config:c,blocks:[]});
 for(const id of ['default_codex','account_b']){
  const root=join(dir,id);mkdirSync(root);writeFileSync(join(root,'auth.json'),JSON.stringify({tokens:{account_id:id,access_token:'synthetic-access'}}));writeFileSync(join(root,'marker'),id);
  secrets.putSecret(id,{authDir:root});
  const quotaStore=dbQuotaStore(store.db).scope!(id);
  const record={...fixture().context.quotas[0]!,channel:id,checkedAt:new Date().toISOString(),observedAt:new Date().toISOString()};
  quotaStore.save({records:{codex:record},fingerprints:{},lastAccounts:{},nextRequests:{}});
 }
 let index=0,draws=0;const reads:Array<{channel:string;root:string;marker:string}>=[];
 policy.setRoutingContextProvider(config=>({now:Date.now(),quotas:dbQuotaStore(store.db).channelRecords!(),credentialsReady:id=>nativeCredentialsReady(config.engines[config.channels[id]!.engine]!.kind,secrets.getSecret(id)??{}),pickIndex:n=>{draws++;assert.equal(n,2);return index;}}));
 const binding=(id:string)=>({channel:policy.snapshot().config.channels[id]!,secret:secrets.getSecret(id)!,engineKind:'codex'});
 const launcher=(input:CliAgentInput,beforeSpawn?:(prepared:PreparedCliAgent)=>void):ManagedAgentProcess=>{
  const prepared=prepareCliAgentInput(input);beforeSpawn?.(prepared);
  const read=JSON.parse(execFileSync(process.execPath,['-e',"const fs=require('node:fs');process.stdout.write(JSON.stringify({root:process.env.CODEX_HOME,marker:fs.readFileSync(process.env.CODEX_HOME+'/marker','utf8')}))"],{env:prepared.env}).toString());
  reads.push({channel:input.channel!,...read});
  const proc=Object.assign(new EventEmitter(),{pid:4242,stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true,scopeUnit:prepared.unit,evidence:{engine:'codex',requestedModel:input.model,requestedEffort:input.effort,workspace:input.workspace,role:input.role,terminal:'success'}}) as unknown as ManagedAgentProcess;
  setImmediate(()=>{(proc.stdout as PassThrough).end(JSON.stringify({type:'result',summary:read.marker})+'\n');proc.emit('close',0,null);});
  return proc;
 };
 const adapter=new RoutingWorkerAdapter({id:'mock-jsonl',start:()=>{throw Error('unexpected mock');}},launcher,join(dir,'state'),id=>store.getPackage(id),undefined,binding);
 const manager=new TaskManager(store,adapter,()=>{},undefined,error=>{throw error;});
 const handler=new CommandHandler(manager,policy);
 const raw=(command:string,args:Record<string,unknown>={}):any=>handler.handle({apiVersion:'weaver.v1',commandId:randomUUID(),command,args});
 const create=()=>{const r=raw('tasks.create',{title:'synthetic',goal:'read private marker',workspace:dir,ownerProfileId:'claude_owner'});assert.equal(r.ok,true,JSON.stringify(r));return r.data;};
 return {dir,store,policy,manager,handler,raw,create,reads,launcher,binding,draws:()=>draws,pick:(value:number)=>{index=value;},close:async()=>{await handler.drain();await manager.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('dispatch launcher consumes both selected private roots; repeated capacity pumps retain frozen account',async()=>{
 const f=integrationFixture();try{
  for(const [index,channel] of ['default_codex','account_b'].entries()){
   f.pick(index);const created=f.create();const admitted=f.raw('workers.spawn',{taskId:created.id});assert.equal(admitted.ok,true,JSON.stringify(admitted));assert.equal(admitted.data.dispatch.channel,channel);
   for(let i=0;i<5&&f.store.get(created.id).status!=='completed';i++)await tick();
   assert.equal(f.store.get(created.id).run?.channel,channel);
   assert.equal(f.reads.at(-1)?.marker,channel);assert.equal(f.reads.at(-1)?.root,join(f.dir,channel));
  }
  assert.equal(f.draws(),2);
  // Occupy the selected Worker's capacity without launching a real engine.
  const snapshot=f.policy.snapshot();snapshot.config.workers.codex_worker!.max_parallel=1;f.policy.save({revision:snapshot.revision,config:snapshot.config,blocks:snapshot.blocks});
  const blocker=f.manager.create({title:'capacity',instruction:'synthetic',owner:{name:'capacity',transport:'herdr-visible',session:'fixture',pane:'fixture'}});blocker.status='running';blocker.dispatch={owner:'claude_owner',worker:'codex_worker',channel:'default_codex',engine:'codex',model:'gpt-6.1-sol',effort:'high',execution:'mock',maxParallel:1};f.store.put(blocker);
  f.pick(1);const queued=f.create();assert.equal(f.raw('workers.spawn',{taskId:queued.id}).ok,true);
  for(let i=0;i<3;i++){f.handler.pump();await tick();}
  assert.equal(f.draws(),3);assert.equal(f.store.get(queued.id).dispatch?.channel,'account_b');assert.equal(f.store.get(queued.id).run,undefined);
  const persisted=dbQuotaStore(f.store.db).scope!('account_b').load()!;persisted.records.codex!.windows=[{id:'five_hour',label:'private vendor label',scope:'account',model:null,usedPercent:100,remainingPercent:0,resetsAt:new Date(Date.now()+60_000).toISOString(),durationMinutes:300,used:null,total:null,remaining:null,unit:'percent'}];dbQuotaStore(f.store.db).scope!('account_b').save(persisted);
  f.handler.pump();await tick();assert.equal(f.draws(),3);assert.equal(f.store.get(queued.id).dispatch?.channel,'account_b');assert.equal(f.store.get(queued.id).queueReason?.code,'policy_blocked');
  assert.equal(f.policy.snapshot().workers.codex_worker!.status,'available','sibling A remains eligible');
  const sibling=dbQuotaStore(f.store.db).scope!('default_codex').load()!;
  sibling.records.codex!.windows=persisted.records.codex!.windows;
  dbQuotaStore(f.store.db).scope!('default_codex').save(sibling);
  const unavailable=f.policy.snapshot().workers.codex_worker!;
  assert.equal(unavailable.status,'blocked');
  assert.match('reason' in unavailable ? unavailable.reason ?? '' : '', /5小时窗口已耗尽/);
  assert.doesNotMatch(JSON.stringify(unavailable),/NO_ELIGIBLE_CHANNEL|QUOTA_|private vendor/);

  await f.handler.drain();
  const reopened=new PolicyStore(f.store.db);reopened.setRoutingContextProvider(()=>({...f.policy.routingContext()!,pickIndex:()=>{throw Error('restart redrew frozen channel');}}));
  const restored=new CommandHandler(f.manager,reopened);restored.pump();await tick();
  assert.equal(f.store.get(queued.id).dispatch?.channel,'account_b');assert.equal(f.store.get(queued.id).run,undefined);await restored.drain();
 }finally{await f.close();}
});

test('quota retry retains Worker, excludes all historical failed channels, and vendor A block does not cover B',async()=>{
 const f=integrationFixture();try{
  const original=f.manager.create({title:'failed',instruction:'retry fixture',workspace:f.dir,owner:{name:'retry',transport:'herdr-visible',session:'fixture',pane:'fixture'}});
  original.status='failed';original.dispatch={owner:'claude_owner',worker:'codex_worker',channel:'default_codex',engine:'codex',model:'gpt-6.1-sol',effort:'high',execution:'real',adapter:'codex',engineKind:'codex',maxParallel:2};original.failure={kind:'quota',message:'quota exhausted'};f.store.put(original);
  const retried=f.raw('tasks.retry',{taskId:original.id});assert.equal(retried.ok,true,JSON.stringify(retried));assert.equal(retried.data.dispatch.worker,'codex_worker');assert.equal(retried.data.dispatch.channel,'account_b');
  const blocks=f.policy.snapshot().activeBlocks;assert.ok(blocks.some(block=>block.channel==='default_codex'));assert.ok(!blocks.some(block=>block.channel==='account_b'));
  const second=f.store.get(retried.data.id);second.status='failed';second.failure={kind:'rate_limit',message:'429'};f.store.put(second);
  const refused=f.raw('tasks.retry',{taskId:second.id});assert.equal(refused.ok,false,'A and B cannot loop');
  assert.deepEqual(chainChannels(f.store,second,true),['account_b','default_codex']);assert.deepEqual(chainWorkers(f.store,second),[]);
  const cancellation={...second,id:'cancelled-attempt',retryOf:original.id,status:'cancelled' as const,failure:undefined};f.store.put(cancellation);const future={...second,retryOf:cancellation.id};assert.deepEqual(chainWorkers(f.store,future),['codex_worker']);
 }finally{await f.close();}
});

test('direct schedule draws only at claim, persists account and actual launcher reads its root; second member cannot inherit owner',async()=>{
 const f=integrationFixture();let service:ScheduleService|undefined;try{
  f.pick(1);service=new ScheduleService({store:f.store,policy:f.policy,notify:()=>{},dataDir:f.dir,channelConfig:f.binding,startCli:f.launcher,recoverScope:async()=>{},createTask:()=>{throw Error('direct worker created root');},command:()=>{throw Error('direct worker command');}});
  const d=service.create({name:'multi direct',kind:'agent',timing:{mode:'interval',seconds:60},agent:{goal:'read marker',executor:{role:'worker',profileId:'codex_worker'}}});assert.equal(f.draws(),0);
  const run=service.run({scheduleId:d.id});assert.equal(f.store.getValue<Array<{id:string;channel?:string}>>(`schedules.runs.${d.id}`)!.find(stored=>stored.id===run.id)!.channel,'account_b');
  for(let i=0;i<8&&service.runs({scheduleId:d.id,runId:run.id}).runs[0]!.status==='running';i++)await tick();
  assert.equal(service.runs({scheduleId:d.id,runId:run.id}).runs[0]!.status,'succeeded');assert.equal(f.draws(),1);assert.equal(f.reads[0]!.marker,'account_b');
  const root=f.manager.create({title:'parent',instruction:'fixture',owner:{name:'native',transport:'herdr-visible',session:'fixture',pane:'fixture'}});root.status='running';root.run={id:'root-run',adapter:'native',engine:'codex',channel:'default_codex',policyRevision:f.policy.snapshot().revision,status:'running'};f.store.put(root);
  const child={...root,id:'child',parentTaskId:root.id,workspace:f.dir};
  const dispatcher=new Dispatcher(f.manager,f.policy,new TaskRecords(f.manager),{due:()=>false,rotate:()=>{throw Error('unexpected rotate');}});
  assert.equal(dispatcher.decideExecution('codex',undefined,child,'default_codex','default_codex').execution,'native');
  assert.equal(dispatcher.decideExecution('codex',undefined,child,'default_codex','account_b').execution,'real');
 }finally{await service?.stop();await f.close();}
});

import { QuotaProber } from '../../src/main/quota';
test('auth failure invalidates only its persisted observation and late HTTP cannot restore available',async()=>{
 const f=integrationFixture();let prober:QuotaProber|undefined;let finishFetch:((response:Response)=>void)|undefined;try{
  let timestamp=Date.now();let respondImmediately=false;
  const response=()=>new Response(JSON.stringify({rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:1,reset_at:Math.floor(timestamp/1000)+3600,limit_window_seconds:18000}},credits:{has_credits:false,unlimited:false,balance:'0'}}),{status:200,headers:{'content-type':'application/json'}});
  let requested!:()=>void;const entered=new Promise<void>(resolve=>{requested=resolve;});
  prober=new QuotaProber({channels:()=>({default_codex:f.binding('default_codex'),account_b:f.binding('account_b')}),root:join(f.dir,'quota'),env:{HOME:f.dir},now:()=>new Date(timestamp),snapshotStore:dbQuotaStore(f.store.db),credentialResolver:async(_engine,env)=>({token:'synthetic-token',fingerprint:env.CODEX_HOME!,account:env.CODEX_HOME!}),fetch:async()=>{if(respondImmediately)return response();requested();return await new Promise<Response>(resolve=>{finishFetch=resolve;});}});
  f.policy.setChannelQuotaInvalidator(id=>prober!.invalidateChannel(id));
  const pending=prober.refresh({channel:'default_codex'});await entered;
  const failed=f.manager.create({title:'auth fail',instruction:'synthetic',owner:{name:'auth',transport:'herdr-visible',session:'fixture',pane:'fixture'}});failed.status='failed';failed.dispatch={owner:'claude_owner',worker:'codex_worker',channel:'default_codex',engine:'codex',model:'gpt-6.1-sol',effort:'high',execution:'real',maxParallel:2};failed.failure={kind:'auth',message:'401 unauthorized'};f.store.put(failed);
  f.handler.pump();await tick();await pending;
  assert.equal(dbQuotaStore(f.store.db).channelRecords!().find(record=>record.channel==='default_codex')!.status,'error');
  assert.match(prober.get().records.find(record=>record.channel==='default_codex')!.detail,/账号认证失败/);
  assert.equal(f.policy.snapshot().workers.codex_worker!.status,'available','B is unaffected');
  finishFetch!(new Response(JSON.stringify({rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:1,reset_at:Math.floor(timestamp/1000)+3600,limit_window_seconds:18000}},credits:{has_credits:false,unlimited:false,balance:'0'}}),{status:200,headers:{'content-type':'application/json'}}));await tick();await tick();
  assert.equal(dbQuotaStore(f.store.db).channelRecords!().find(record=>record.channel==='default_codex')!.status,'error');
  assert.equal(prober.get().records.find(record=>record.channel==='default_codex')!.stale,true);
  // A fresh successful request is allowed to recover; invalidation is not a permanent fence.
  timestamp+=61_000;respondImmediately=true;
  const refreshed=await prober.refresh({channel:'default_codex'});assert.equal(refreshed.records.find(record=>record.channel==='default_codex')!.status,'available');
 }finally{await prober?.close();await f.close();}
});

test('a queued record with run evidence never vendor-reroutes its frozen account',async()=>{
 const f=integrationFixture();try{
  f.pick(0);const task=f.create();assert.equal(f.raw('workers.spawn',{taskId:task.id}).ok,true);
  const claimed=f.store.get(task.id);claimed.run={id:'already-claimed',adapter:'codex',status:'running',channel:'default_codex',engine:'codex'};f.store.put(claimed);
  const snapshot=f.policy.snapshot();f.policy.save({revision:snapshot.revision,config:snapshot.config,blocks:[{engine:'codex',worker:'codex_worker',channel:'default_codex',since:new Date().toISOString(),reason:'429',by:'weaver-vendor-limit'}]});
  f.handler.pump();await tick();assert.equal(f.draws(),1);assert.equal(f.store.get(task.id).dispatch?.channel,'default_codex');assert.equal(f.store.get(task.id).run?.id,'already-claimed');assert.equal(f.reads.length,0);
 }finally{await f.close();}
});

import { DatabaseSync } from 'node:sqlite';
test('selected OpenCode subscriptions launch with independent database and all XDG roots',()=>{
 const dir=mkdtempSync(join(tmpdir(),'oc-'));try{
  const {config,context}=fixture();config.engines.codex!.kind='opencode';config.workers.pool!.model='opencode-go/fixture';
  context.quotas=context.quotas.map(record=>({...record,engine:'opencode',source:'opencode_go_usage'}));
  const roots=['a','b'].map(id=>{const root=join(dir,id);mkdirSync(root);const db=new DatabaseSync(join(root,'opencode.db'));db.exec('CREATE TABLE account_state(id INTEGER PRIMARY KEY,active_account_id TEXT,active_org_id TEXT)');db.prepare('INSERT INTO account_state VALUES (1,?,?)').run(id,`org-${id}`);db.close();writeFileSync(join(root,'marker'),id);return root;});
  for(const index of [0,1]){
   const route=resolveDispatch(config,[],{owner:'o',worker:'pool'},{...context,pickIndex:()=>index});const root=roots[index]!;
   const prepared=prepareCliAgentInput({engine:'opencode',channel:route.channel,channelConfig:{channel:config.channels[route.channel]!,engineKind:'opencode',secret:{authDir:root}},model:route.model,effort:'high',workspace:dir,stateDir:join(dir,`run-${index}`),instruction:'synthetic'});
   const evidence=JSON.parse(execFileSync(process.execPath,['-e',"const fs=require('node:fs'),path=require('node:path');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.OPENCODE_DB,{readOnly:true});process.stdout.write(JSON.stringify({account:db.prepare('SELECT active_account_id FROM account_state WHERE id=1').get().active_account_id,marker:fs.readFileSync(path.join(path.dirname(process.env.OPENCODE_DB),'marker'),'utf8'),env:Object.fromEntries(['OPENCODE_DB','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME'].map(k=>[k,process.env[k]]))}));db.close();"],{env:prepared.env}).toString());
   assert.equal(evidence.account,['a','b'][index]);assert.equal(evidence.marker,['a','b'][index]);assert.deepEqual(evidence.env,{OPENCODE_DB:join(root,'opencode.db'),XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache')});
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

import type { EngineQuotaRecord, QuotaEngine } from '../../src/shared/contracts/quota';

test('routing explains rejected pool members in Chinese without exposing vendor detail or internal reason codes',()=>{
 for(const mode of ['credentials','stale','exhausted'] as const){
  const {config,context}=fixture();
  for(const record of context.quotas){
   record.detail='private vendor account token';
   if(mode==='stale')record.stale=true;
   if(mode==='exhausted')record.windows=[{id:'weekly',label:'private vendor label',scope:'account',model:null,usedPercent:100,remainingPercent:0,resetsAt:new Date(now+60_000).toISOString(),durationMinutes:10080,used:null,total:null,remaining:null,unit:'percent'}];
  }
  if(mode==='credentials')context.credentialsReady=()=>false;
  const text={credentials:'账号认证未就绪',stale:'额度已过期，请刷新',exhausted:'周窗口已耗尽'}[mode];
  const route=resolveDispatch(config,[],{owner:'o'},context);
  assert.match(route.skipped!.find(item=>item.worker==='pool')!.reason,new RegExp(text));
  assert.doesNotMatch(JSON.stringify(route.skipped),/CREDENTIALS_|QUOTA_|private vendor/);
  config.owners.o!.workers=['pool'];
  assert.throws(()=>resolveDispatch(config,[],{owner:'o'},context),error=>{
   assert.ok(error instanceof Error);assert.match(error.message,new RegExp(text));
   assert.doesNotMatch(error.message,/CREDENTIALS_|QUOTA_|private vendor/);return true;
  });
  assert.throws(()=>resolveDispatch(config,[],{owner:'o',worker:'pool'},context),error=>{
   assert.ok(error instanceof Error);assert.equal((error as Error & {code:string}).code,'NO_ELIGIBLE_CHANNEL');
   assert.match(error.message,new RegExp(text));assert.doesNotMatch(error.message,/NO_ELIGIBLE_CHANNEL|CREDENTIALS_|QUOTA_|private vendor/);return true;
  });
 }
});

for(const engine of ['opencode','grok'] as const){
 for(const observation of ['missing','older','equal','newer'] as const){
  test(`handler reconstruction checks the ${engine} observation alone (${observation})`,async()=>{
   const dir=mkdtempSync(join(tmpdir(),'h-'));
   const store=new TaskStore(join(dir,'weaver.db'));
   const manager=new TaskManager(store,{id:'synthetic',start(){throw Error('must not launch');}});
   let handler:CommandHandler|undefined;
   try{
    const policy=new PolicyStore(store.db);const quotas=dbQuotaStore(store.db);
    const failedAt=Date.now()-60_000;
    const observedAt=observation==='missing'?null:new Date(failedAt+({older:-1,equal:0,newer:1}[observation])).toISOString();
    for(const channel of ['failed-account','sibling']){
     const records:Partial<Record<QuotaEngine,EngineQuotaRecord>>={};
     for(const kind of ['codex','claude','grok','opencode'] as const){
      const actual=kind===engine;
      // Every namespace has all four prober rows. Other engines must neither
      // invalidate a recovered account nor conceal an unrecovered observation.
      const time=channel==='sibling'?new Date(failedAt+1).toISOString():actual?observedAt:observation==='newer'?null:new Date(failedAt+1).toISOString();
      records[kind]={engine:kind,source:{codex:'codex_usage',claude:'claude_oauth_usage',grok:'grok_cli_billing',opencode:'opencode_go_usage'}[kind],status:time?'available':'unknown',stale:!time,checkedAt:time,observedAt:time,windows:[],detail:'',retryAt:null};
     }
     quotas.scope!(channel).save({records,fingerprints:{},lastAccounts:{},nextRequests:{}});
    }
    const sibling=quotas.scope!('sibling').load();
    const failed=manager.create({title:'historical auth failure',instruction:'synthetic only',workspace:dir,owner:{name:'fixture',transport:'herdr-visible',session:'fixture',pane:'fixture'}});
    failed.status='failed';
    failed.dispatch={owner:'claude_owner',worker:'codex_worker',channel:'failed-account',engine:'historical-engine-id',engineKind:engine==='opencode'?'codex':engine,model:'synthetic',effort:'high',execution:'real',maxParallel:1};
    failed.run={id:'historical-run',adapter:engine,engine:'historical-engine-id',channel:'failed-account',status:'stopped',endedAt:new Date(failedAt).toISOString(),...(engine==='opencode'?{evidence:{engine,requestedModel:'synthetic',requestedEffort:'high',workspace:dir,terminal:'error' as const}}:{})};
    failed.failure={kind:'auth',message:'401 unauthorized'};store.put(failed);
    for(let reconstruction=0;reconstruction<2;reconstruction++){
     handler=new CommandHandler(manager,new PolicyStore(store.db));
     const record=quotas.scope!('failed-account').load()!.records[engine]!;
     assert.equal(record.status,observation==='newer'?'available':'error');
     assert.equal(record.stale,observation!=='newer');
     assert.equal(record.observedAt,observedAt);
     assert.deepEqual(quotas.scope!('sibling').load(),sibling,'another account is untouched');
     await handler.drain();handler=undefined;
    }
   }finally{
    try{await handler?.drain();await manager.shutdown();}finally{store.close();rmSync(dir,{recursive:true,force:true});}
   }
  });
 }
}
