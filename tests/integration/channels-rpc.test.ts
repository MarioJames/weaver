import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startRuntime } from '../../src/main/runtime';
import { PolicyStore } from '../../src/main/policy/store';
import { ChannelStore } from '../../src/main/channels/store';
import { QuotaProber } from '../../src/main/quota';
import { TaskStore } from '../../src/main/store';
import type { Task } from '../../src/shared/contracts/tasks';

test('channel RPC reads locally, refreshes one real identity, isolates API and guards in-flight task references',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'r-'));const db=new DatabaseSync(join(dir,'weaver.db'));const policy=new PolicyStore(db);const secrets=new ChannelStore(db);
 const auth=join(dir,'auth');mkdirSync(auth);const payload=Buffer.from(JSON.stringify({exp:Date.parse('2100-01-01')/1000})).toString('base64url');
 const access=`e30.${payload}.fixture-private-token`;writeFileSync(join(auth,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:access,account_id:'fixture-a'}}));
 const config=policy.snapshot().config;
 config.channels.second={engine:'codex',kind:'subscription',label:'Other account',enabled:true};config.channels.api={engine:'codex',kind:'api',label:'API account',enabled:true};
 policy.save({revision:0,config,blocks:[]});secrets.putSecret('default_codex',{authDir:auth});secrets.putSecret('second',{authDir:auth});secrets.putSecret('api',{apiKey:'private-api-fixture'});
 const channels=Object.fromEntries(['default_codex','second','api'].map(id=>[id,{channel:config.channels[id],engineKind:'codex',secret:secrets.getSecret(id)!}]));
 let requests=0;
 const prober=new QuotaProber({channels:()=>channels,root:join(dir,'quota'),env:{HOME:dir},fetch:async(_url,options)=>{requests++;assert.equal(new Headers(options?.headers).get('authorization'),`Bearer ${access}`);return Response.json({rate_limit:{allowed:false,limit_reached:true,primary_window:{used_percent:100,reset_at:Date.now()/1000+3600,limit_window_seconds:3600}},credits:{has_credits:false,unlimited:false,balance:'0'}});}});
 const runtime=await startRuntime({dataDir:dir,port:0,channels:{autoImport:false,env:{HOME:dir}},quotaProber:prober});
 const rpc=async(method:string,input?:unknown)=>{const response=await fetch(`${runtime.url}/api/rpc`,{method:'POST',headers:{origin:runtime.url,'content-type':'application/json'},body:JSON.stringify({method,args:input===undefined?[]:[input]})});return {status:response.status,body:await response.json() as any};};
 try{
  const initial=await rpc('getChannels');assert.equal(initial.status,200);assert.equal(requests,0);assert.equal(initial.body.result.configurations.default_codex.hasCredentials,true);
  assert.doesNotMatch(JSON.stringify(initial.body),/private-api-fixture|fixture-private-token/);
  const exhausted=await rpc('refreshChannelQuota',{channel:'default_codex'});assert.equal(exhausted.status,200);assert.equal(requests,1);
  assert.deepEqual(exhausted.body.result.policy.blocks.map((b:any)=>b.channel),['default_codex']);assert.equal(exhausted.body.result.configurations.default_codex.quota.status,'exhausted');assert.equal(exhausted.body.result.configurations.second.quota.status,'unknown');
  assert.equal((await rpc('refreshChannelQuota',{channel:'api'})).status,400);assert.equal(requests,1);
  const before=(await rpc('getChannels')).body.result;
  const invalid=await rpc('saveChannel',{revision:before.policy.revision,id:'api',channel:{...config.channels.api,engine:'grok'},apiKey:'must-not-replace'});assert.equal(invalid.status,400);assert.equal(secrets.getSecret('api')!.apiKey,'private-api-fixture');
  // No policy role references second; the active historical route still owns its account.
  const tasks=new TaskStore(join(dir,'weaver.db'));
  const task:Task={id:'channel-reference',title:'active',instruction:'fixture',owner:{name:'fixture',transport:'herdr-visible',session:'s',pane:'p'},status:'queued',progress:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:[],artifacts:[],dispatch:{owner:'claude_owner',worker:'removed-worker',engine:'codex',channel:'second',model:'gpt',effort:'high',execution:'real',maxParallel:1}};
  tasks.put(task);assert.equal((await rpc('deleteChannel',{revision:before.policy.revision,id:'second'})).body.error.code,'CHANNEL_IN_USE');
  task.status='completed';tasks.put(task);assert.equal((await rpc('deleteChannel',{revision:before.policy.revision,id:'second'})).status,200);tasks.close();
 }finally{await runtime.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('actual HTTP task reads hide private channel paths while preserving durable owner and host data',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'r-'));
 const runtime=await startRuntime({dataDir:dir,port:0,channels:{autoImport:false,env:{HOME:dir}}});
 const store=new TaskStore(join(dir,'weaver.db'));
 const task:Task={id:'11111111-1111-4111-8111-111111111111',title:'Fixture',instruction:'Fixture',owner:{name:'fixture',transport:'herdr-visible',session:'s',pane:'p'},status:'completed',progress:100,createdAt:'2026-10-24T00:00:00Z',updatedAt:'2026-10-24T00:00:00Z',events:[],artifacts:[],ownerHost:{kind:'herdr',session:'s',workspaceId:'w',paneId:'p',tabId:'t',agentName:'fixture',launchedAt:'2026-10-24T00:00:00Z',channelStateDir:'/private/host-state',channelProfilePath:'/private/host-profile',channelEnvironmentPath:'/private/host-env'},run:{id:'run',adapter:'codex',status:'stopped',channel:'default_codex',channelStateDir:'/private/run-state',channelProfilePath:'/private/run-profile'}};
 store.put(task);const before=store.get(task.id);
 try{
  for(const [method,args] of [['getTask',[task.id]],['listTasks',[]]] as const){
   const response=await fetch(`${runtime.url}/api/rpc`,{method:'POST',headers:{origin:runtime.url,'content-type':'application/json'},body:JSON.stringify({method,args})});
   assert.equal(response.status,200);const body=await response.json() as any;const result=Array.isArray(body.result)?body.result.find((item:Task)=>item.id===task.id):body.result;
   assert.ok(result);assert.doesNotMatch(JSON.stringify(result),/\/private\//);
   assert.deepEqual(result.owner,task.owner);assert.equal(result.ownerHost.paneId,'p');assert.equal(result.run.channel,'default_codex');
  }
  assert.deepEqual(store.get(task.id),before);
 }finally{store.close();await runtime.close();rmSync(dir,{recursive:true,force:true});}
});

test('official account RPC creates private roots, exposes bounded jobs and refuses API and cross-channel references',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'r-'));
 // Runtime's Unix socket needs the same short temporary root as the adjacent RPC tests.
 const runtime=await startRuntime({dataDir:dir,port:0,channels:{autoImport:false,env:{HOME:dir,PATH:join(dir,'missing-bin')}}});
 const rpc=async(method:string,input?:unknown)=>{
  const response=await fetch(`${runtime.url}/api/rpc`,{method:'POST',headers:{origin:runtime.url,'content-type':'application/json'},body:JSON.stringify({method,args:input===undefined?[]:[input]})});
  return {status:response.status,body:await response.json() as any};
 };
 try{
  const initial=(await rpc('getChannels')).body.result;
  const channel={engine:'codex',kind:'subscription',enabled:true,label:'New official'};
  const first=await rpc('saveChannel',{revision:initial.policy.revision,channel});assert.equal(first.status,200);
  const id=first.body.result.savedChannel;assert.equal(typeof id,'string');assert.equal(first.body.result.configurations[id].hasCredentials,false);
  const second=await rpc('saveChannel',{revision:first.body.result.policy.revision,channel});assert.equal(second.status,200);
  const other=second.body.result.savedChannel;
  const job=await rpc('startChannelLogin',{channel:id});assert.equal(job.status,200);
  assert.equal(job.body.result.channel,id);assert.equal(typeof job.body.result.id,'string');
  assert.equal((await rpc('getChannelLogin',{channel:other,id:job.body.result.id})).status,404);
  assert.equal((await rpc('cancelChannelLogin',{channel:other,id:job.body.result.id})).status,404);
  let state=await rpc('getChannelLogin',{channel:id,id:job.body.result.id});
  for(let attempt=0;state.body.result.status==='starting'&&attempt<100;attempt++){await new Promise(resolve=>setTimeout(resolve,10));state=await rpc('getChannelLogin',{channel:id,id:job.body.result.id});}
  assert.equal(state.status,200);assert.equal(state.body.result.status,'failed');assert.equal(state.body.result.error.code,'ENGINE_NOT_INSTALLED');
  const legacy=await rpc('startChannelLogin',{channel:'default_codex'});assert.equal(legacy.status,200);
  let legacyState=await rpc('getChannelLogin',{channel:'default_codex',id:legacy.body.result.id});
  for(let attempt=0;legacyState.body.result.status==='starting'&&attempt<100;attempt++){await new Promise(resolve=>setTimeout(resolve,10));legacyState=await rpc('getChannelLogin',{channel:'default_codex',id:legacy.body.result.id});}
  assert.equal(legacyState.body.result.error.code,'ENGINE_NOT_INSTALLED');
  for(const reference of [{channel:other,id:job.body.result.id},{channel:id,id:job.body.result.id}]){
   const denied=await rpc('submitChannelLoginCode',{...reference,code:'fixture-private-code#fixture-state'});assert.equal(denied.status,reference.channel===other?404:400);assert.doesNotMatch(JSON.stringify(denied.body),/fixture-private-code|fixture-state/);
  }
  const api=await rpc('saveChannel',{revision:second.body.result.policy.revision,channel:{...channel,kind:'api'},apiKey:'rpc-private-key'});assert.equal(api.status,200);
  assert.equal((await rpc('startChannelLogin',{channel:api.body.result.savedChannel})).status,400);
  assert.doesNotMatch(JSON.stringify([first.body,second.body,job.body,state.body,api.body]),/rpc-private-key|\/tmp\/|authDir|CODEX_HOME/);
 }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});


test('import RPC returns the actual operation receipt without persisting it on getChannels',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'r-')),source=join(dir,'source');mkdirSync(source);writeFileSync(join(source,'auth.json'),JSON.stringify({OPENAI_API_KEY:'fixture-private'}));
 const runtime=await startRuntime({dataDir:dir,port:0,channels:{autoImport:false,env:{HOME:dir}}});
 const rpc=async(method:string,input?:unknown)=>{
  const response=await fetch(`${runtime.url}/api/rpc`,{method:'POST',headers:{origin:runtime.url,'content-type':'application/json'},body:JSON.stringify({method,args:input===undefined?[]:[input]})});
  assert.equal(response.status,200);return (await response.json() as any).result;
 };
 try{
  const result=await rpc('importChannels',{revision:0,engine:'codex',sourceDir:source});
  assert.deepEqual(result.importResult,{added:1,existing:0,updated:0,notFound:[],failures:[]});
  assert.equal((await rpc('getChannels')).importResult,undefined);
  assert.equal((await rpc('importChannels',{revision:result.policy.revision,engine:'codex',sourceDir:source})).importResult.existing,1);
  assert.doesNotMatch(JSON.stringify(result),/fixture-private/);
 }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
