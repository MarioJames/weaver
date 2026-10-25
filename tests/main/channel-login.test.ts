import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { PolicyStore } from '../../src/main/policy/store';
import { ChannelStore } from '../../src/main/channels/store';
import { ChannelService } from '../../src/main/channels/service';

test('new official accounts own different private roots and stay unavailable before native credentials exist', () => {
 const root=mkdtempSync(join(process.env.WEAVER_TEST_TEMP_ROOT??tmpdir(),'accounts-'));const db=new DatabaseSync(':memory:');
 try {
  const policy=new PolicyStore(db), secrets=new ChannelStore(db), service=new ChannelService(policy,secrets,{root});
  const channel={engine:'codex',kind:'subscription' as const,label:'Official',enabled:true};
  const a=service.save({revision:0,channel}), b=service.save({revision:a.policy.revision,channel});
  const first=secrets.getSecret(a.savedChannel)!.authDir!, second=secrets.getSecret(b.savedChannel)!.authDir!;
  assert.notEqual(first,second);assert.equal(statSync(first).mode&0o777,0o700);
  assert.equal(b.configurations[a.savedChannel].hasCredentials,false);
  writeFileSync(join(first,'auth.json'),'{}');assert.equal(service.get().configurations[a.savedChannel].hasCredentials,false);
  assert.doesNotMatch(JSON.stringify(b),new RegExp(root));
  assert.throws(()=>service.save({revision:b.policy.revision,channel,apiKey:'secret'}),/官方/);
 } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { ChannelLogins, channelVerificationUrl } from '../../src/main/channels/login';
import type { OwnedScope } from '../../src/main/adapters/cli/scope';
import { nativeCredentialsReady } from '../../src/main/channels/native';
import { prepareCliAgentInput } from '../../src/main/adapters/cli/launch';
import { prepareChannelRun, cleanupChannelRun } from '../../src/main/channels/runtime';

function loginFixture() {
 const root=mkdtempSync(join(process.env.WEAVER_TEST_TEMP_ROOT??tmpdir(),'login-'));
 const channel={engine:'codex',kind:'subscription' as const,label:'Official',enabled:true};
 const calls:{env:NodeJS.ProcessEnv;command:string[];unit:string}[]=[];
 const scopes:OwnedScope[]=[];const confirmed:string[]=[];
 const options={
  env:{PATH:'/fixture',HOME:root,OPENAI_API_KEY:'inherited-secret',ANTHROPIC_AUTH_TOKEN:'other-secret',GROK_API_KEY:'grok-secret'},
  find:async()=>'/fixture/codex',
  start:(input:Parameters<typeof import('../../src/main/adapters/cli/scope').startOwnedScope>[0])=>{
   calls.push({env:input.env,command:[...input.command],unit:input.unit});
   const scope=Object.assign(new EventEmitter(),{unit:input.unit,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill:()=>{setImmediate(()=>scope.emit('close',null));return true;},detach:()=>{}}) as OwnedScope;
   scopes.push(scope);return scope;
  },
  confirmAbsent:async(unit:string)=>{confirmed.push(unit);return true;},
  capture:async()=>({code:0,stdout:'Logged in using ChatGPT',stderr:'',timedOut:false,overflow:false}),
 };
 const binding=(id:string)=>({channel:id==='api'?{...channel,kind:'api' as const}:channel,secret:{authDir:root},engineKind:'codex'});
 return {root,channel,calls,scopes,confirmed,options,binding};
}

test('login is bound to channel plus job, reuses active work and cancel closes only its owned scope',async()=>{
 const f=loginFixture(),logins=new ChannelLogins(f.binding,f.options);
 try{
  const job=await logins.start({channel:'first'});await tick();
  assert.deepEqual(await logins.start({channel:'first'}),job);assert.equal(f.calls.length,1);
  assert.throws(()=>logins.get({channel:'second',id:job.id}),/不存在/);
  await assert.rejects(logins.cancel({channel:'second',id:job.id}),/不存在/);
  await assert.rejects(logins.start({channel:'api'}),/仅官方/);
  assert.equal(f.calls[0].env.CODEX_HOME,f.root);assert.equal(f.calls[0].env.OPENAI_API_KEY,undefined);assert.equal(f.calls[0].env.ANTHROPIC_AUTH_TOKEN,undefined);assert.equal(f.calls[0].env.GROK_API_KEY,undefined);
  assert.deepEqual(f.calls[0].command,['/fixture/codex','login','--device-auth']);
  (f.scopes[0].stdout as PassThrough).write('https://auth.openai.com/codex/device\nEnter code: ABCD-EFGH\naccess_token=do-not-publish\n');
  const shown=logins.get({channel:'first',id:job.id});assert.equal(shown.status,'authorizing');assert.equal(shown.userCode,'ABCD-EFGH');assert.doesNotMatch(JSON.stringify(shown),/do-not-publish|inherited-secret|login-/);
  assert.equal((await logins.cancel({channel:'first',id:job.id})).status,'cancelled');assert.deepEqual(f.confirmed,[f.scopes[0].unit]);
 }finally{await logins.close();rmSync(f.root,{recursive:true,force:true});}
});

test('native success text and exit zero without credentials fail safely; timeout closes owned login',async()=>{
 for(const timeout of [false,true]){
  const f=loginFixture(),logins=new ChannelLogins(f.binding,{...f.options,...(timeout?{loginTimeoutMs:1}:{})});
  try{
   const job=await logins.start({channel:'first'});await tick();
   if(!timeout){(f.scopes[0].stdout as PassThrough).write('Successfully logged in with access_token=private-output');f.scopes[0].emit('close',0);}
   // close waits for the native process and verification; no duration threshold is asserted.
   if(timeout)await new Promise(resolve=>setTimeout(resolve,10));else {await tick();await tick();}
   const result=logins.get({channel:'first',id:job.id});assert.equal(result.status,'failed');assert.equal(result.error?.code,timeout?'LOGIN_TIMEOUT':'LOGIN_NOT_READY');assert.doesNotMatch(JSON.stringify(result),/private-output|login-/);assert.equal(f.confirmed.length,1);
  }finally{await logins.close();rmSync(f.root,{recursive:true,force:true});}
 }
});

test('credentials written before verification remain gated, then the actual launcher adopts the same root and profile',async()=>{
 const f=loginFixture();let release!:()=>void;
 const logins=new ChannelLogins(f.binding,{...f.options,capture:async(_exe,_args,_timeout,_limit,env)=>{
  assert.equal(env.CODEX_HOME,f.root);await new Promise<void>(resolve=>{release=resolve;});return f.options.capture();
 }});
 try{
  const job=await logins.start({channel:'first'});await tick();
  writeFileSync(join(f.root,'auth.json'),JSON.stringify({tokens:{account_id:'fixture',access_token:'fixture-private'}}));
  assert.equal(nativeCredentialsReady('codex',{authDir:f.root}),false);
  f.scopes[0].emit('close',0);await tick();assert.equal(logins.get({channel:'first',id:job.id}).status,'verifying');assert.equal(nativeCredentialsReady('codex',{authDir:f.root}),false);
  release();await tick();assert.equal(logins.get({channel:'first',id:job.id}).status,'succeeded');assert.equal(nativeCredentialsReady('codex',{authDir:f.root}),true);
  await assert.rejects(logins.start({channel:'first'}),/新建独立账号/);
  const run=prepareCliAgentInput({engine:'codex',channel:'first',channelConfig:f.binding('first'),model:'fixture',effort:'low',instruction:'fixture',workspace:f.root,stateDir:join(f.root,'state')});
  try{assert.equal(run.env!.CODEX_HOME,f.root);assert.ok(run.argv.includes('--profile'));assert.doesNotMatch(JSON.stringify(run.argv),/fixture-private/);}finally{cleanupChannelRun(run);}
 }finally{release?.();await logins.close();rmSync(f.root,{recursive:true,force:true});}
});

test('authorization links discard nonofficial hosts and credential-bearing callback URLs',()=>{
 assert.equal(channelVerificationUrl('codex','https://auth.openai.com/codex/device'),'https://auth.openai.com/codex/device');
 for(const value of ['https://auth.openai.com.evil.test/a','https://user:password@auth.openai.com/a','https://auth.openai.com/a?access_token=secret','https://auth.openai.com/a#refresh_token=secret','https://auth.openai.com/a?code=oauth-callback-private'])assert.equal(channelVerificationUrl('codex',value),undefined);
});

test('unconfirmed native cleanup prevents a second login and is reported on service close',async()=>{
 const f=loginFixture(),logins=new ChannelLogins(f.binding,{...f.options,confirmAbsent:async()=>false});
 try{
  const job=await logins.start({channel:'first'});await tick();
  const cancelled=await logins.cancel({channel:'first',id:job.id});assert.equal(cancelled.status,'failed');assert.equal(cancelled.error?.code,'LOGIN_CLEANUP');
  await assert.rejects(logins.start({channel:'first'}),/未确认停止/);
  await assert.rejects(logins.close(),/无法确认/);assert.equal(f.calls.length,1);
 }finally{await logins.close().catch(()=>{});rmSync(f.root,{recursive:true,force:true});}
});


test('refreshable imported materials are locally ready while strict new login rejects expired access',()=>{
 const f=loginFixture();
 try{
  const token=`e30.${Buffer.from(JSON.stringify({sub:'fixture',iss:'https://auth.x.ai',exp:1})).toString('base64url')}.fixture`;
  writeFileSync(join(f.root,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:token,expiresAt:1,refreshToken:'fixture-refresh'}}));
  writeFileSync(join(f.root,'auth.json'),JSON.stringify({'https://auth.x.ai::fixture':{auth_mode:'oidc',key:token,refresh_token:'fixture-refresh',oidc_issuer:'https://auth.x.ai',client_id:'fixture'}}));
  for(const engine of ['claude','grok']){
   assert.equal(nativeCredentialsReady(engine,{authDir:f.root}),true);
   for(const purpose of [undefined,'models','quota'] as const){
    const run=prepareChannelRun({channel:{...f.channel,engine},secret:{authDir:f.root},model:'fixture',purpose,stateDir:join(f.root,'state')});
    try{if(engine==='grok')assert.deepEqual(run.argv,['--leader-socket',join(f.root,'leader.sock')]);}finally{cleanupChannelRun(run);}
   }
   assert.equal(nativeCredentialsReady(engine,{authDir:f.root},true),false);
  }
  writeFileSync(join(f.root,'.weaver-login-pending'),'pending');
  assert.equal(nativeCredentialsReady('claude',{authDir:f.root}),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('large live SQLite account state is read from WAL without treating the database as a config file',()=>{
 const f=loginFixture(),db=new DatabaseSync(join(f.root,'opencode.db'));
 try{
  db.exec("CREATE TABLE padding(data BLOB);INSERT INTO padding VALUES(zeroblob(600000));PRAGMA journal_mode=WAL;CREATE TABLE account_state(id INTEGER PRIMARY KEY,active_account_id TEXT,active_org_id TEXT);INSERT INTO account_state VALUES(1,'fixture-account','fixture-org');");
  assert.ok(statSync(join(f.root,'opencode.db')).size>512*1024);
  assert.equal(nativeCredentialsReady('opencode',{authDir:f.root}),true);
  db.exec('UPDATE account_state SET active_account_id=NULL');assert.equal(nativeCredentialsReady('opencode',{authDir:f.root}),false);
 }finally{db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('Grok actual launcher keeps one account socket and its no-leader permission posture',()=>{
 const f=loginFixture();
 try{
  const run=prepareCliAgentInput({engine:'grok',channel:'fixture',channelConfig:{channel:{...f.channel,engine:'grok',kind:'api'},secret:{apiKey:'fixture'}},model:'grok-4',effort:'low',instruction:'fixture',workspace:f.root,stateDir:join(f.root,'state')});
  try{
   assert.equal(run.argv.filter(x=>x==='--leader-socket').length,1);
   assert.equal(run.argv[run.argv.indexOf('--leader-socket')+1],join(run.env!.GROK_HOME!,'leader.sock'));
   assert.ok(run.argv.includes('--no-leader'));
  }finally{cleanupChannelRun(run);}
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('legacy official login allocates its own root and missing CLI gives a recoverable installation error',async()=>{
 const f=loginFixture(),db=new DatabaseSync(':memory:');
 const policy=new PolicyStore(db),secrets=new ChannelStore(db),service=new ChannelService(policy,secrets,{root:join(f.root,'accounts')});
 const binding=(id:string)=>({channel:policy.snapshot().config.channels[id]!,secret:secrets.getSecret(id)??{},engineKind:'codex'});
 const logins=new ChannelLogins(binding,{...f.options,find:async()=>undefined,initialize:channel=>service.initializeLogin(channel)});
 try{
  const job=await logins.start({channel:'default_codex'});await tick();
  const result=logins.get({channel:job.channel,id:job.id});
  assert.equal(result.error?.code,'ENGINE_NOT_INSTALLED');
  const root=secrets.getSecret(job.channel)!.authDir!;assert.ok(root.startsWith(join(f.root,'accounts',job.channel)));
  assert.equal(service.get().configurations[job.channel].hasCredentials,false);
  const retry=await logins.start({channel:job.channel});assert.notEqual(retry.id,job.id);await tick();
 }finally{await logins.close();db.close();rmSync(f.root,{recursive:true,force:true});}
});


test('SQLite readiness rejects empty, corrupt and symlinked account databases',()=>{
 const f=loginFixture();
 try{
  const file=join(f.root,'opencode.db');
  for(const data of ['', 'invalid sqlite database']){writeFileSync(file,data);assert.equal(nativeCredentialsReady('opencode',{authDir:f.root}),false);}
  rmSync(file);const target=join(f.root,'source.db'),db=new DatabaseSync(target);
  db.exec("CREATE TABLE account_state(id INTEGER PRIMARY KEY,active_account_id TEXT,active_org_id TEXT);INSERT INTO account_state VALUES(1,'fixture','org')");db.close();
  symlinkSync(target,file);assert.equal(nativeCredentialsReady('opencode',{authDir:f.root}),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('private login initialization refuses deleted and API identities without creating secrets',()=>{
 const f=loginFixture(),db=new DatabaseSync(':memory:');
 try{
  const policy=new PolicyStore(db),secrets=new ChannelStore(db),service=new ChannelService(policy,secrets,{root:join(f.root,'accounts')});
  const config=policy.snapshot().config;
  config.channels.api={...f.channel,kind:'api'};
  policy.save({revision:0,config,blocks:[]});
  for(const id of ['deleted','api','default_pi']){assert.throws(()=>service.initializeLogin(id));assert.equal(secrets.getSecret(id),undefined);}
  const before=service.initializeLogin('default_codex').secret;
  assert.deepEqual(service.initializeLogin('default_codex').secret,before);
  // Metadata deletion cannot resurrect a private secret or adopt a retained directory.
  const snapshot=policy.snapshot();delete snapshot.config.channels.default_codex;
  for(const role of Object.values(snapshot.config.owners))if(role.channel==='default_codex')role.channel='api';
  for(const role of Object.values(snapshot.config.workers))role.channels=role.channels.map(id=>id==='default_codex'?'api':id);
  policy.save({revision:snapshot.revision,config:snapshot.config,blocks:[]});
  assert.throws(()=>service.initializeLogin('default_codex'));assert.deepEqual(secrets.getSecret('default_codex'),before);
 }finally{db.close();rmSync(f.root,{recursive:true,force:true});}
});


test('failed private secret transaction removes only its newly allocated account root',()=>{
 const f=loginFixture(),db=new DatabaseSync(':memory:');
 try{
  const policy=new PolicyStore(db),secrets=new ChannelStore(db),service=new ChannelService(policy,secrets,{root:join(f.root,'accounts')});
  db.exec("CREATE TRIGGER fail_account BEFORE INSERT ON channel_secrets BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END");
  assert.throws(()=>service.initializeLogin('default_codex'),/fixture transaction failure/);
  assert.equal(secrets.getSecret('default_codex'),undefined);assert.equal(existsSync(join(f.root,'accounts','default_codex')),false);
  db.exec('DROP TRIGGER fail_account');assert.ok(service.initializeLogin('default_codex').secret.authDir);
 }finally{db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('failed native identity verification leaves credentials gated and permits retry in the same account root',async()=>{
 const f=loginFixture(),logins=new ChannelLogins(f.binding,{...f.options,capture:async()=>({code:1,stdout:'',stderr:'',timedOut:false,overflow:false})});
 try{
  const job=await logins.start({channel:'first'});await tick();
  writeFileSync(join(f.root,'auth.json'),JSON.stringify({tokens:{account_id:'fixture',access_token:'fixture'}}));
  f.scopes[0].emit('close',0);await tick();await tick();
  assert.equal(logins.get({channel:'first',id:job.id}).error?.code,'LOGIN_NOT_READY');
  assert.equal(nativeCredentialsReady('codex',{authDir:f.root}),false);
  const retry=await logins.start({channel:'first'});assert.notEqual(retry.id,job.id);await tick();assert.equal(f.calls.length,2);
  assert.equal(f.calls[1].env.CODEX_HOME,f.root);await logins.cancel({channel:'first',id:retry.id});
 }finally{await logins.close();rmSync(f.root,{recursive:true,force:true});}
});

test('verified first-party OAuth shapes keep engine/path-specific query permissions',()=>{
 assert.ok(channelVerificationUrl('claude','https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback'));
 for(const engine of ['qoder','qodercli'])assert.ok(channelVerificationUrl(engine,'https://qoder.com/device/selectAccounts?challenge=fixture&challenge_method=S256&nonce=fixture&machine_id=fixture&client_id=fixture&machine_token=fixture'));
 for(const [engine,value] of [
  ['claude','https://claude.com/other?code=true'],['codex','https://auth.openai.com/codex/device?nonce=fixture'],['qoder','https://qoder.com/other?machine_token=fixture'],
  ...['access_token','refresh_token','device_code','unknown'].map(key=>['qoder',`https://qoder.com/device/selectAccounts?${key}=fixture`]),
  ['qoder','http://qoder.com/device/selectAccounts'],['qoder','https://qoder.com:444/device/selectAccounts'],['qoder','https://user@qoder.com/device/selectAccounts'],['qoder','https://qoder.com/device/selectAccounts#fragment'],
 ])assert.equal(channelVerificationUrl(engine,value),undefined);
});

test('native Codex multiline one-time code and verified Grok URL survive chunk splits without exposing tokens',async()=>{
 for(const engine of ['codex','grok']){
  const f=loginFixture(),logins=new ChannelLogins(id=>({...f.binding(id),engineKind:engine}),f.options);
  try{
   const job=await logins.start({channel:'first'});await tick();const ref={channel:job.channel,id:job.id};
   const text=engine==='codex'?'Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-EFGHJ\n\nContinue only if you started this login in Codex.':'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH\nConfirm this code in your browser:\n ABCD-EFGH\n';
   for(const c of text)(f.scopes[0].stdout as PassThrough).write(c);
   assert.equal(logins.get(ref).userCode,engine==='codex'?'ABCD-EFGHJ':'ABCD-EFGH');
   (f.scopes[0].stderr as PassThrough).write('\naccess_token: PRIVATE-TOKEN\n');assert.doesNotMatch(JSON.stringify(logins.get(ref)),/PRIVATE-TOKEN/);
  }finally{await logins.close();rmSync(f.root,{recursive:true,force:true});}
 }
});

test('dsh explicit native config is validated before writes; omission and blank keys preserve actual secrets',()=>{
 const db=new DatabaseSync(':memory:'),policy=new PolicyStore(db),secrets=new ChannelStore(db),service=new ChannelService(policy,secrets);
 try{
  const channel={engine:'dsh',kind:'api' as const,label:'dsh',enabled:true,provider:'deepseek-official',protocol:'anthropic' as const};
  const saved=service.save({revision:0,channel,config:'[]',apiKey:'fixture-private'}),id=saved.savedChannel;
  const before=policy.snapshot(),secret=secrets.getSecret(id);
  for(const config of ['{}','[broken','key: value','null']){
   assert.throws(()=>service.save({revision:before.revision,id,channel:{...channel,label:'must not save'},config,apiKey:'must-not-save'}),/patch|YAML/);
   assert.deepEqual(policy.snapshot(),before);assert.deepEqual(secrets.getSecret(id),secret);
  }
  let next=service.save({revision:before.revision,id,channel:{...channel,label:'renamed'},apiKey:''});assert.deepEqual(secrets.getSecret(id),secret);
  next=service.save({revision:next.policy.revision,id,channel,config:''});assert.equal(secrets.getSecret(id)?.config,undefined);assert.equal(secrets.getSecret(id)?.apiKey,'fixture-private');
  secrets.putSecret(id,{...secret,config:'{}'});service.save({revision:next.policy.revision,id,channel:{...channel,enabled:false}});assert.equal(secrets.getSecret(id)?.config,'{}');
 }finally{db.close();}
});

test('Claude manual return accepts only the exact prompted active job and writes one private stdin line',async()=>{
 const f=loginFixture(),logins=new ChannelLogins(id=>({...f.binding(id),engineKind:id==='other'?'codex':'claude'}),f.options);
 try{
  const job=await logins.start({channel:'first'});await tick();const ref={channel:job.channel,id:job.id};
  const input={...ref,code:'fixtureCode#fixtureState'};
  await assert.rejects(logins.submitCode(input),/不接受/);
  let written='';f.scopes[0].stdin!.on('data',x=>written+=x.toString());
  const native='https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback\nPaste code here if prompted > ';
  for(const part of [native.slice(0,40),native.slice(40)])(f.scopes[0].stdout as PassThrough).write(part);
  assert.equal(logins.get(ref).acceptsCode,true);
  await assert.rejects(logins.submitCode({...input,channel:'wrong'}),/不存在/);
  await assert.rejects(logins.submitCode({...input,id:'00000000-0000-0000-0000-000000000000'}),/不存在/);
  for(const code of ['', 'x'.repeat(4097),'code\n#state','code\r#state','code\u0000#state','code\u001b#state','code without state'])await assert.rejects(logins.submitCode({...ref,code}),/授权码/);
  assert.equal(written,'');
  const submitting=logins.submitCode(input);await assert.rejects(logins.submitCode(input),/不接受/);
  const result=await submitting;assert.equal(written,input.code+'\n');assert.equal(result.status,'authorizing');assert.equal(result.acceptsCode,false);
  assert.doesNotMatch(JSON.stringify(result),/fixtureCode|fixtureState/);assert.equal(nativeCredentialsReady('claude',{authDir:f.root}),false);
  (f.scopes[0].stdout as PassThrough).write('\n');assert.equal(logins.get(ref).acceptsCode,false);await assert.rejects(logins.submitCode(input),/不接受/);
  await logins.cancel(ref);await assert.rejects(logins.submitCode(input),/不接受/);
  const other=await logins.start({channel:'other'});await tick();await assert.rejects(logins.submitCode({channel:other.channel,id:other.id,code:input.code}),/不接受/);
 }finally{await logins.close();rmSync(f.root,{recursive:true,force:true});}
});

test('OpenCode native console log prefix keeps its required device code visible',async()=>{
 const f=loginFixture(),logins=new ChannelLogins(id=>({...f.binding(id),engineKind:'opencode'}),f.options);
 try{
  const job=await logins.start({channel:'first'});await tick();
  (f.scopes[0].stdout as PassThrough).write('│  Go to: https://opencode.ai/console/device\n│  Enter code: ABCD-EFGH\n');
  assert.equal(logins.get({channel:job.channel,id:job.id}).userCode,'ABCD-EFGH');
 }finally{await logins.close();rmSync(f.root,{recursive:true,force:true});}
});

test('an explicit default TLS port is rejected as well as nondefault ports',()=>{
 assert.equal(channelVerificationUrl('qoder','https://qoder.com:443/device/selectAccounts'),undefined);
});

test('manual stdin failures preserve acceptance for retry and do not persist submitted material',async()=>{
 const f=loginFixture(),db=new DatabaseSync(':memory:'),policy=new PolicyStore(db),secrets=new ChannelStore(db),service=new ChannelService(policy,secrets,{root:join(f.root,'accounts')});
 const saved=service.save({revision:0,channel:{engine:'claude',kind:'subscription',label:'Manual',enabled:true}}),id=saved.savedChannel;
 const binding=(key:string)=>({channel:policy.snapshot().config.channels[key]!,secret:secrets.getSecret(key)!,engineKind:'claude'});
 const logins=new ChannelLogins(binding,f.options);
 try{
  const before=policy.snapshot(),secret=secrets.getSecret(id),job=await logins.start({channel:id});await tick();const ref={channel:id,id:job.id};
  (f.scopes[0].stdout as PassThrough).write('https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback\nPaste code here if prompted > ');
  const originalWrite=f.scopes[0].stdin!.write.bind(f.scopes[0].stdin!);
  f.scopes[0].stdin!.write=((_line:any,callback:any)=>{callback(new Error('must not echo private input'));return false;}) as any;
  await assert.rejects(logins.submitCode({...ref,code:'private.fixture#state.fixture'}),/未能发送/);
  assert.equal(logins.get(ref).acceptsCode,true);assert.deepEqual(policy.snapshot(),before);assert.deepEqual(secrets.getSecret(id),secret);
  f.scopes[0].stdin!.write=originalWrite;await logins.submitCode({...ref,code:'private.fixture#state.fixture'});
  assert.deepEqual(policy.snapshot(),before);assert.deepEqual(secrets.getSecret(id),secret);
  assert.doesNotMatch(JSON.stringify(logins.get(ref)),/private\.fixture|state\.fixture/);
  f.scopes[0].emit('close',1);await tick();await tick();await assert.rejects(logins.submitCode({...ref,code:'private.fixture#state.fixture'}),/不接受/);
 }finally{await logins.close();db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('a malformed Grok URL code cannot retain a valid-looking chunk prefix as its device code',async()=>{
 const f=loginFixture(),logins=new ChannelLogins(id=>({...f.binding(id),engineKind:'grok'}),f.options);
 try{
  const job=await logins.start({channel:'first'});await tick();
  for(const c of 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH_private_token\n')(f.scopes[0].stdout as PassThrough).write(c);
  assert.equal(logins.get({channel:job.channel,id:job.id}).userCode,undefined);
 }finally{await logins.close();rmSync(f.root,{recursive:true,force:true});}
});
