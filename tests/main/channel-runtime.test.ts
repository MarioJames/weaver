import { parse as readToml } from 'smol-toml';
import { sayHi } from '../../src/main/engines/hello';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { QuotaProber } from '../../src/main/quota';
import { dbQuotaStore } from '../../src/main/storage/quota-snapshot';
import { parseOpenCodeSwitch } from '../../src/main/engines/opencode-accounts';
import { createNormalizer } from '../../src/main/adapters/cli/normalize';
import { prepareChannelRun,cleanupChannelRun } from '../../src/main/channels/runtime';
import { NativeChannelImporter } from '../../src/main/channels/import';
import { PolicyStore } from '../../src/main/policy/store';
import { ChannelStore } from '../../src/main/channels/store';
import { startCliAgent,prepareCliAgentInput } from '../../src/main/adapters/cli/launch';
const root=process.env.WEAVER_TEST_TEMP_ROOT ?? tmpdir();
function fixture(){mkdirSync(root,{recursive:true});return mkdtempSync(join(root,'fixture-'));}

test('two same-engine API processes consume distinct native files and never inherit subscription credentials',()=>{
 const temp=fixture();try{
  const global=join(temp,'global');mkdirSync(global);writeFileSync(join(global,'auth.json'),'{"official":"unchanged"}');const before=readFileSync(join(global,'auth.json'));
  const runs=['one','two'].map(id=>prepareCliAgentInput({engine:'codex',channel:id,channelConfig:{channel:{engine:'codex',kind:'api',enabled:true,label:id,provider:id,baseUrl:`https://${id}.example/v1`},secret:{apiKey:`fixture-private-${id}`}},model:`model-${id}`,effort:'medium',workspace:temp,stateDir:join(temp,id),instruction:'fixture'}));
  assert.notEqual(runs[0].env?.CODEX_HOME,runs[1].env?.CODEX_HOME);
  for(const [index,run] of runs.entries()){
   const output=execFileSync(process.execPath,['-e',"process.stdout.write(require('fs').readFileSync(process.env.CODEX_HOME+'/config.toml','utf8'))"],{env:run.env}).toString();
   const id=['one','two'][index];assert.match(output,new RegExp(`fixture-private-${id}`));assert.match(output,new RegExp(`https://${id}.example/v1`));assert.match(output,new RegExp(`model-${id}`));
   assert.doesNotMatch(JSON.stringify(run.argv),/fixture-private/);assert.equal(statSync(join(run.env!.CODEX_HOME!,'config.toml')).mode&0o777,0o600);
  }
  assert.deepEqual(readFileSync(join(global,'auth.json')),before);
  const isolated=prepareChannelRun({channel:{engine:'codex',kind:'api',enabled:true,label:'API'},secret:{apiKey:'fixture-only-key'},model:'m',stateDir:temp,env:{CODEX_HOME:global,ANTHROPIC_API_KEY:'wrong',OPENAI_API_KEY:'wrong',OPENCODE_AUTH_CONTENT:'wrong',PATH:process.env.PATH}});
  assert.equal(isolated.env.OPENAI_API_KEY,undefined);assert.equal(isolated.env.ANTHROPIC_API_KEY,undefined);assert.equal(isolated.env.OPENCODE_AUTH_CONTENT,undefined);assert.equal(readFileSync(join(isolated.env.CODEX_HOME!,'auth.json'),'utf8'),'{}');
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test('subscription roots stay separate and missing credentials / malformed native JSON fail recoverably',()=>{
 const temp=fixture();try{
  const roots=['a','b'].map(id=>{const dir=join(temp,id);mkdirSync(dir);writeFileSync(join(dir,'auth.json'),JSON.stringify({tokens:{account_id:id,access_token:"fixture-access"}}));return dir;});
  for(const authDir of roots){const run=prepareChannelRun({channel:{engine:'codex',kind:'subscription',enabled:true,label:'official'},secret:{authDir},model:'m',stateDir:temp,env:{OPENAI_API_KEY:'bad'}});assert.equal(run.env.CODEX_HOME,authDir);assert.equal(run.env.OPENAI_API_KEY,undefined);}
  assert.throws(()=>prepareChannelRun({channel:{engine:'codex',kind:'subscription',enabled:true,label:'missing'},secret:{},model:'m',stateDir:temp}),/认证目录/);
  assert.throws(()=>prepareChannelRun({channel:{engine:'opencode',kind:'api',enabled:true,label:'broken'},secret:{config:'{'},model:'p/m',stateDir:temp}),/JSON/);
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test('native import is idempotent, keeps renewed private credentials, rebinds provider roles and preserves source bytes',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'codex');mkdirSync(source);writeFileSync(join(source,'auth.json'),'{"tokens":{"account_id":"fixture-account-original","refresh_token":"fixture-refresh-original"}}');
  writeFileSync(join(source,'config.toml'),'model_provider="provider_a"\n[model_providers.provider_a]\nname="provider_a"\nbase_url="https://a.example/v1"\nwire_api="responses"\nenv_key="FIXTURE_API_KEY"\n');
  const before=['auth.json','config.toml'].map(file=>readFileSync(join(source,file)));
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const snapshot=policy.snapshot();snapshot.config.workers.codex_worker.model='provider_a/model';policy.save({revision:snapshot.revision,config:snapshot.config,blocks:[]});
  const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp,FIXTURE_API_KEY:'fixture-import-key'}});
  let result=await importer.import({revision:policy.snapshot().revision,engine:'codex',sourceDir:source});const ids=Object.keys(result.policy.config.channels).filter(id=>id.startsWith('import_'));assert.equal(ids.length,2);assert.deepEqual(result.importResult,{added:2,existing:0,updated:0,notFound:[],failures:[]});
  const api=ids.find(id=>result.policy.config.channels[id]!.kind==='api')!;assert.equal(result.policy.config.workers.codex_worker.channels[0],api);
  const official=ids.find(id=>id!==api)!;const authDir=secrets.getSecret(official)!.authDir!;writeFileSync(join(authDir,'auth.json'),'{"renewed":"fixture-new-refresh"}');
  const revision=result.policy.revision;result=await importer.import({revision,engine:'codex',sourceDir:source});assert.equal(result.policy.revision,revision);assert.equal(result.importResult.existing,2);assert.equal(result.importResult.added,0);assert.equal(Object.keys(result.policy.config.channels).filter(id=>id.startsWith('import_')).length,2);assert.match(readFileSync(join(authDir,'auth.json'),'utf8'),/fixture-new-refresh/);assert.equal(secrets.getSecret(api)!.apiKey,'fixture-import-key');
  assert.doesNotMatch(JSON.stringify(result),/fixture-import-key|fixture-refresh/);
  for(const [index,file] of ['auth.json','config.toml'].entries())assert.deepEqual(readFileSync(join(source,file)),before[index]);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('OpenCode imports a WAL-consistent private database and never switches the source cursor; duplicate grant org stays disabled',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');const source=join(temp,'source');mkdirSync(source);const original=new DatabaseSync(join(source,'opencode.db'));
 try{
  original.exec("PRAGMA journal_mode=WAL;CREATE TABLE account(id TEXT PRIMARY KEY,refresh_token TEXT);CREATE TABLE account_state(id INTEGER PRIMARY KEY,active_account_id TEXT,active_org_id TEXT);INSERT INTO account VALUES('a','fixture-refresh-a');INSERT INTO account_state VALUES(1,'a','org-one');");
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const switched:string[]=[];
  const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp},accountsFactory:env=>{
   assert.notEqual(env.OPENCODE_DB,join(source,'opencode.db'));
   const privateDb=new DatabaseSync(env.OPENCODE_DB!);
   assert.equal(privateDb.prepare('SELECT refresh_token FROM account').get()!.refresh_token,'fixture-refresh-a');
   const list=()=>{const state=privateDb.prepare('SELECT * FROM account_state').get()!;return {orgs:['org-one','org-two'].map(orgID=>({accountID:'a',orgID,active:state.active_org_id===orgID,accountEmail:'fixture@example.invalid',accountUrl:'https://opencode.ai/console',orgName:orgID})),consoleManagedProviders:['opencode-go'],switchableOrgCount:2,detail:''};};
   return {list:async()=>list(),switchAccount:async input=>{const selected=parseOpenCodeSwitch(input);switched.push(selected.orgID);privateDb.prepare('UPDATE account_state SET active_org_id=?').run(selected.orgID);return list();},close:async()=>privateDb.close()};
  }});
  const result=await importer.import({revision:0,engine:'opencode',sourceDir:source});const imported=Object.entries(result.policy.config.channels).filter(([id])=>id.startsWith('import_'));
  assert.equal(imported.length,2);assert.equal(imported.filter(([,channel])=>channel.enabled).length,1);assert.equal(switched.length,1);
  assert.equal(original.prepare('SELECT active_org_id FROM account_state').get()!.active_org_id,'org-one');
  for(const [id,channel]of imported){const secret=secrets.getSecret(id)!;if(channel.enabled){assert.equal(statSync(join(secret.authDir!,'opencode.db')).mode&0o777,0o600);}else{assert.equal(secret.authDir,undefined);assert.throws(()=>prepareChannelRun({channel:{...channel,enabled:true},secret,model:'opencode-go/fixture',stateDir:join(temp,'unsafe-enable')}),/认证目录/);}}
 }finally{original.close();db.close();rmSync(temp,{recursive:true,force:true});}
});

test('a concurrent policy save aborts the complete native import and reclaims only its own staged roots',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');const source=join(temp,'source');mkdirSync(source);const nativeDb=new DatabaseSync(join(source,'opencode.db'));nativeDb.exec("CREATE TABLE account(id TEXT);INSERT INTO account VALUES('a')");nativeDb.close();
 try{
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);let changed=false;
  const view={orgs:[{accountID:'a',orgID:'o',active:true,accountEmail:'fixture@example.invalid',accountUrl:'https://opencode.ai/console',orgName:'fixture'}],consoleManagedProviders:['opencode-go'],switchableOrgCount:1,detail:''};
  const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp},accountsFactory:()=>({list:async()=>{if(!changed){changed=true;const snapshot=policy.snapshot();snapshot.config.workers.codex_worker.model='concurrent-model';policy.save({revision:snapshot.revision,config:snapshot.config,blocks:[]});}return view;},switchAccount:async()=>view,close:async()=>{}})});
  await assert.rejects(importer.import({revision:0,engine:'opencode',sourceDir:source}),/reload/);
  assert.equal(policy.snapshot().config.workers.codex_worker.model,'concurrent-model');assert.equal(db.prepare('SELECT count(*) AS n FROM channel_secrets').get()!.n,0);
  const {readdirSync}=await import('node:fs');assert.deepEqual(readdirSync(join(temp,'managed')),[]);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('Qoder imports only verified native opaque authentication files without recasting settings as API',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'qoder');mkdirSync(join(source,'.auth'),{recursive:true});const opaque=Buffer.from([0,255,2,128]);writeFileSync(join(source,'.auth','user'),opaque);writeFileSync(join(source,'.auth','machine_id'),'fixture-machine');writeFileSync(join(source,'settings.json'),JSON.stringify({security:{auth:{selectedType:'qoder'}},hooks:{private:'not imported'}}));
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp},identifyAccount:async()=> 'fixture-qoder-account'});
  const result=await importer.import({revision:0,engine:'qoder',sourceDir:source});const id=Object.keys(result.policy.config.channels).find(id=>id.startsWith('import_'))!;assert.equal(result.policy.config.channels[id]!.kind,'subscription');const secret=secrets.getSecret(id)!;assert.deepEqual(readFileSync(join(secret.authDir!,'.auth','user')),opaque);assert.doesNotMatch(readFileSync(join(secret.authDir!,'settings.json'),'utf8'),/hooks/);
  const run=prepareChannelRun({channel:result.policy.config.channels[id]!,secret,model:'auto',stateDir:join(temp,'run')});assert.equal(run.env.QODER_CONFIG_DIR,secret.authDir);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('quota observations, cooldown and persisted credentials remain independent for same-engine channels',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');const policy=new PolicyStore(db);void policy;
 const roots=['a','b'].map(id=>{const dir=join(temp,id);mkdirSync(dir);writeFileSync(join(dir,'auth.json'),JSON.stringify({tokens:{account_id:id,access_token:'fixture-access'}}));return dir;});
 let requests=0;const options={root:join(temp,'probes'),snapshotStore:dbQuotaStore(db),channels:()=>Object.fromEntries(roots.map((authDir,index)=>[['a','b'][index]!,{engineKind:'codex',channel:{engine:'codex',kind:'subscription' as const,enabled:true,label:authDir},secret:{authDir}}])),credentialResolver:async(_engine:any,env:NodeJS.ProcessEnv)=>({token:env.CODEX_HOME!.endsWith('/a')?'fixture-a':'fixture-b',fingerprint:env.CODEX_HOME!,account:env.CODEX_HOME!}),fetch:async(_url:any,init?:RequestInit)=>{requests++;const authorization=new Headers(init?.headers).get('authorization');return new Response(JSON.stringify({credits:{has_credits:false,unlimited:false,balance:'0'},rate_limit:{allowed:authorization?.includes('fixture-b'),limit_reached:authorization?.includes('fixture-a'),primary_window:{used_percent:authorization?.includes('fixture-a')?100:10,reset_at:Math.floor(Date.now()/1000)+3600,limit_window_seconds:18000}}}),{status:200,headers:{'content-type':'application/json'}});}};
 const prober=new QuotaProber(options);try{
  await prober.refresh({channel:'a'});let snapshot=await prober.refresh({channel:'b'});assert.equal(snapshot.records.find(record=>record.channel==='a')!.status,'exhausted');assert.equal(snapshot.records.find(record=>record.channel==='b')!.status,'available');assert.equal(requests,2);
  await prober.close();const restored=new QuotaProber(options);try{snapshot=await restored.refresh({channel:'b'});assert.equal(requests,2,'restored channel pacing prevents a duplicate request');assert.equal(snapshot.records.find(record=>record.channel==='a')!.status,'exhausted');}finally{await restored.close();}
 }finally{await prober.close();db.close();rmSync(temp,{recursive:true,force:true});}
});

test('Claude executes through stream-json with channel settings and retains real terminal evidence',()=>{
 const temp=fixture();try{
  const prepared=prepareCliAgentInput({engine:'claude',channel:'claude_api',channelConfig:{channel:{engine:'claude',kind:'api',enabled:true,label:'Claude API',baseUrl:'https://fixture.example'},secret:{apiKey:'fixture-claude-key'}},model:'sonnet',effort:'medium',instruction:'fixture',workspace:temp,stateDir:join(temp,'state')});
  assert.ok(prepared.argv.includes('stream-json'));assert.ok(prepared.argv.includes('bypassPermissions'));assert.doesNotMatch(JSON.stringify(prepared.argv),/fixture-claude-key/);const settings=prepared.argv[prepared.argv.indexOf('--settings')+1]!;assert.match(readFileSync(settings,'utf8'),/fixture-claude-key/);
  const normalizer=createNormalizer('claude');normalizer.push(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-session'}));normalizer.push(JSON.stringify({type:'assistant',message:{model:'claude-fixture',content:[{type:'text',text:'finished'}]}}));normalizer.push(JSON.stringify({type:'result',subtype:'success',result:'finished',usage:{input_tokens:2,output_tokens:1}}));const result=normalizer.finish({exitCode:0,cancelled:false,truncated:false});assert.equal(result.evidence.terminal,'success');assert.equal(result.evidence.vendorModel,'claude-fixture');assert.equal(result.evidence.vendorSessionId,'fixture-session');cleanupChannelRun(prepared);
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test('pre-spawn persistence failures reclaim per-run secret files and keep renewable subscription roots',()=>{
 const temp=fixture();try{
  const authDir=join(temp,'auth');mkdirSync(authDir);writeFileSync(join(authDir,'auth.json'),'{"tokens":{"account_id":"fixture","access_token":"fixture-access"}}');let prepared:ReturnType<typeof prepareCliAgentInput>|undefined;
  assert.throws(()=>startCliAgent({engine:'codex',channel:'official',channelConfig:{channel:{engine:'codex',kind:'subscription',enabled:true,label:'official'},secret:{authDir,config:'model_reasoning_effort="low"'}},model:'m',effort:'low',workspace:temp,stateDir:join(temp,'run'),instruction:'fixture'},record=>{prepared=record;throw new Error('fixture-transaction-abort');}),/fixture-transaction-abort/);
  assert.equal(existsSync(prepared!.channelStateDir!),false);assert.equal(existsSync(prepared!.channelProfilePath!),false);assert.equal(existsSync(join(authDir,'auth.json')),true);
 }finally{rmSync(temp,{recursive:true,force:true});}
});
test('re-login in the same native root adds another account while token renewal keeps one stable import identity',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'codex');mkdirSync(source);const auth=join(source,'auth.json');const write=(account:string,token:string)=>writeFileSync(auth,JSON.stringify({tokens:{account_id:account,access_token:token,refresh_token:`fixture-refresh-${token}`}}));write('fixture-account-a','token-a');
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp}});
  let result=await importer.import({revision:0,engine:'codex',sourceDir:source});const original=Object.keys(result.policy.config.channels).find(id=>id.startsWith('import_'))!;const privateAuth=join(secrets.getSecret(original)!.authDir!,'auth.json');writeFileSync(privateAuth,'{"fixture":"managed-renewed-token"}');
  write('fixture-account-a','token-a-renewed');result=await importer.import({revision:result.policy.revision,engine:'codex',sourceDir:source});assert.equal(Object.keys(result.policy.config.channels).filter(id=>id.startsWith('import_')).length,1);assert.match(readFileSync(privateAuth,'utf8'),/managed-renewed-token/);
  write('fixture-account-b','token-b');const sourceBefore=readFileSync(auth);result=await importer.import({revision:result.policy.revision,engine:'codex',sourceDir:source});const imported=Object.keys(result.policy.config.channels).filter(id=>id.startsWith('import_'));assert.equal(imported.length,2);assert.equal(result.policy.config.workers.codex_worker.channels[0],original,'adding a login never changes an existing managed role binding');assert.notEqual(result.policy.config.channels[imported[0]!]!.label,result.policy.config.channels[imported[1]!]!.label);assert.deepEqual(readFileSync(auth),sourceBefore);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('explicit re-import renews the same account into a new private root and preserves active roots, metadata and role selections',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'codex');mkdirSync(source);const auth=join(source,'auth.json');writeFileSync(auth,JSON.stringify({tokens:{account_id:'fixture-account',refresh_token:'fixture-grant-one'}}));
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp}});
  let result=await importer.import({revision:0,engine:'codex',sourceDir:source});const id=Object.keys(result.policy.config.channels).find(id=>id.startsWith('import_'))!;const originalRoot=secrets.getSecret(id)!.authDir!;const originalAuth=readFileSync(join(originalRoot,'auth.json'));const config=result.policy.config;config.channels[id]!.label='custom label';config.channels[id]!.enabled=false;policy.save({revision:result.policy.revision,config,blocks:[]});
  const rolesBefore=JSON.stringify(policy.snapshot().config.workers);writeFileSync(auth,JSON.stringify({tokens:{account_id:'fixture-account',refresh_token:'fixture-grant-two'}}));
  result=await importer.import({revision:policy.snapshot().revision,engine:'codex',sourceDir:source,replaceExisting:true});assert.deepEqual(result.importResult,{added:0,existing:0,updated:1,notFound:[],failures:[]});const replacement=secrets.getSecret(id)!.authDir!;assert.notEqual(replacement,originalRoot);assert.match(readFileSync(join(replacement,'auth.json'),'utf8'),/fixture-grant-two/);assert.deepEqual(readFileSync(join(originalRoot,'auth.json')),originalAuth);assert.equal(result.policy.config.channels[id]!.label,'custom label');assert.equal(result.policy.config.channels[id]!.enabled,false);assert.equal(JSON.stringify(result.policy.config.workers),rolesBefore);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('large historical Claude metadata has a separate bound and imports only stable oauthAccount metadata',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'.claude');mkdirSync(source);writeFileSync(join(source,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fixture-claude-token',refreshToken:'fixture-refresh'}}));const metadata=join(temp,'.claude.json');writeFileSync(metadata,JSON.stringify({oauthAccount:{accountUuid:'fixture-claude-account',organizationUuid:'fixture-org'},history:'x'.repeat(700000)}));const before=readFileSync(metadata);
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp}});const result=await importer.import({revision:0,engine:'claude'});const id=Object.keys(result.policy.config.channels).find(id=>id.startsWith('import_'))!;const root=secrets.getSecret(id)!.authDir!;const imported=JSON.parse(readFileSync(join(root,'.claude.json'),'utf8'));assert.deepEqual(Object.keys(imported),['oauthAccount']);assert.equal(imported.oauthAccount.accountUuid,'fixture-claude-account');assert.deepEqual(readFileSync(metadata),before);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('API model definitions use the selected native provider and models queries do not invent a placeholder model',()=>{
 const temp=fixture();try{
  const channel={engine:'opencode',kind:'api' as const,enabled:true,label:'API',provider:'fixture_provider',protocol:'openai-responses' as const,baseUrl:'https://fixture.example/v1'};const secret={apiKey:'fixture-model-key'};
  const run=prepareChannelRun({channel,secret,model:'fixture_provider/upstream-model',stateDir:temp});const config=JSON.parse(readFileSync(run.env.OPENCODE_CONFIG!,'utf8'));assert.equal(config.provider.fixture_provider.npm,'@ai-sdk/openai');assert.deepEqual(config.provider.fixture_provider.models,{'upstream-model':{name:'upstream-model'}});cleanupChannelRun(run);
  const list=prepareChannelRun({channel,secret,model:'model-list',purpose:'models',stateDir:temp});const listConfig=JSON.parse(readFileSync(list.env.OPENCODE_CONFIG!,'utf8'));assert.equal(listConfig.provider.fixture_provider.models,undefined);cleanupChannelRun(list);
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test('Pi imports native environment templates and escapes without executing command credentials',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'pi');mkdirSync(source);writeFileSync(join(source,'models.json'),JSON.stringify({providers:{a:{apiKey:'$TEST_PROVIDER_KEY'},b:{apiKey:'${TEST_PROVIDER_KEY}'},escaped:{apiKey:'$$VALUE$!literal'}}}));
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp,TEST_PROVIDER_KEY:'fixture-native-key'}});const result=await importer.import({revision:0,engine:'pi',sourceDir:source});const imported=Object.entries(result.policy.config.channels).filter(([id])=>id.startsWith('import_'));assert.equal(imported.length,3);for(const [id,channel]of imported)assert.equal(secrets.getSecret(id)!.apiKey,channel.provider==='escaped'?'$VALUE!literal':'fixture-native-key');
  writeFileSync(join(source,'models.json'),JSON.stringify({providers:{command:{apiKey:`!touch ${join(temp,'must-not-exist')}`}}}));await assert.rejects(importer.import({revision:result.policy.revision,engine:'pi',sourceDir:source}),/命令型/);assert.equal(existsSync(join(temp,'must-not-exist')),false);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('OpenCode explicit native provider key takes priority over the provider auth cache',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'config');mkdirSync(source);const data=join(temp,'data','opencode');mkdirSync(data,{recursive:true});writeFileSync(join(source,'opencode.json'),JSON.stringify({provider:{fixture_provider:{options:{apiKey:'fixture-key-B'}}}}));writeFileSync(join(data,'auth.json'),JSON.stringify({fixture_provider:{type:'api',key:'fixture-key-A'}}));
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp,XDG_DATA_HOME:join(temp,'data')}});const result=await importer.import({revision:0,engine:'opencode',sourceDir:source});const id=Object.keys(result.policy.config.channels).find(id=>id.startsWith('import_'))!;assert.equal(secrets.getSecret(id)!.apiKey,'fixture-key-B');
  const runtime=prepareChannelRun({channel:result.policy.config.channels[id]!,secret:secrets.getSecret(id)!,model:'fixture_provider/m',stateDir:join(temp,'run')});assert.match(readFileSync(runtime.env.OPENCODE_CONFIG!,'utf8'),/fixture-key-B/);assert.doesNotMatch(readFileSync(runtime.env.OPENCODE_CONFIG!,'utf8'),/fixture-key-A/);cleanupChannelRun(runtime);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('hello requires a matched channel and redacts vendor stdout, stderr and model before returning or caching',async()=>{
 const temp=fixture();try{
  const binding={channel:{engine:'codex',kind:'api' as const,enabled:true,label:'API'},secret:{apiKey:'plain-fixture-value'}};
  let called=false;const spawn=()=>{called=true;const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});setImmediate(()=>{child.stderr.end('api_key=sk-review-fixture12345 plain-fixture-value\n');child.stdout.end();child.emit('close',1);});return child;};
  let result=await sayHi({channel:'a',engine:'grok',kind:'grok',model:'m',effort:'low',channelConfig:binding},{root:temp,spawn});assert.equal(result.ok,false);assert.equal(called,false);
  result=await sayHi({channel:'a',engine:'codex',kind:'codex',model:'m',effort:'low',channelConfig:binding},{root:temp,spawn});assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/sk-review-fixture12345|plain-fixture-value/);assert.match(result.error!,/REDACTED/);
  result=await sayHi({engine:'codex',kind:'codex',model:'m',effort:'low'},{root:temp});assert.equal(result.ok,false);assert.match(result.error!,/渠道/);
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test('native role migration preserves worker, channel quota and genuine engine blocks and disabled quota refresh',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'codex');mkdirSync(source);writeFileSync(join(source,'auth.json'),JSON.stringify({tokens:{account_id:'fixture-official'}}));writeFileSync(join(source,'config.toml'),'model_provider="fixture_api"\n[model_providers.fixture_api]\nname="fixture_api"\nenv_key="FIXTURE_KEY"\n');
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const snapshot=policy.snapshot();snapshot.config.channels.default_codex!.quota_refresh=false;snapshot.config.workers.codex_worker.model='fixture_api/m';const since='2026-01-01T00:00:00Z';policy.save({revision:0,config:snapshot.config,blocks:[{engine:'codex',channel:'default_codex',reason:'quota',since,by:'weaver-quota:codex'},{engine:'codex',channel:'default_codex',worker:'codex_worker',reason:'worker limit',since},{engine:'codex',reason:'global tool failure',since}]});
  const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp,FIXTURE_KEY:'fixture-key'}});let result=await importer.import({revision:1,engine:'codex',sourceDir:source});const api=result.policy.config.workers.codex_worker.channels[0];const official=Object.keys(result.policy.config.channels).find(id=>id.startsWith('import_')&&result.policy.config.channels[id]!.kind==='subscription')!;
  assert.equal(result.policy.config.channels[api]!.kind,'api');assert.equal(result.policy.config.channels[official]!.quota_refresh,false);assert.equal(result.policy.blocks.find(block=>block.by==='weaver-quota:codex')!.channel,official);assert.equal(result.policy.blocks.find(block=>block.worker==='codex_worker')!.channel,api);assert.equal(result.policy.blocks.find(block=>block.reason==='global tool failure')!.channel,undefined);
  const before=JSON.stringify(result.policy.blocks);result=await importer.import({revision:result.policy.revision,engine:'codex',sourceDir:source});assert.equal(JSON.stringify(result.policy.blocks),before);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('Qoder native customs import verifies API-only IDs and rejects official aliases, stale material and unverifiable output',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'qoder');mkdirSync(join(source,'.auth'),{recursive:true});mkdirSync(join(source,'.models','fixture_uid'),{recursive:true});writeFileSync(join(source,'.auth','user'),'fixture-opaque-auth');writeFileSync(join(source,'.auth','machine_id'),'fixture-machine');writeFileSync(join(source,'.models','fixture_uid','customs'),'fixture-encrypted-customs');writeFileSync(join(source,'.models','fixture_uid','catalog-v7'),'fixture-encrypted-official-catalog');writeFileSync(join(source,'settings.json'),'{}');
  const policy=new PolicyStore(db);const snapshot=policy.snapshot();snapshot.config.workers.qoder_worker.model='fixture-byok-id';policy.save({revision:0,config:snapshot.config,blocks:[]});const secrets=new ChannelStore(db);let truncated=false;
  const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp},identifyAccount:async()=> 'fixture-qoder-user',listQoderModels:async root=>`MODEL\nAuto\n${existsSync(join(root,'.models','fixture_uid','customs'))?`BYOK Name (${truncated?'fixture-truncated…':'fixture-byok-id'})\n`:''}`});
  let result=await importer.import({revision:1,engine:'qoder',sourceDir:source});const id=Object.keys(result.policy.config.channels).find(id=>id.startsWith('import_')&&result.policy.config.channels[id]!.kind==='api')!;assert.ok(id);assert.equal(result.policy.config.channels[id]!.enabled,true);assert.equal(result.policy.config.workers.qoder_worker.channels[0],id);const secret=secrets.getSecret(id)!;
  let run=prepareChannelRun({channel:result.policy.config.channels[id]!,secret,model:'fixture-byok-id',stateDir:join(temp,'run')});assert.equal(run.env.QODER_CONFIG_DIR,secret.authDir);cleanupChannelRun(run);
  assert.throws(()=>prepareChannelRun({channel:result.policy.config.channels[id]!,secret,model:'auto',stateDir:join(temp,'wrong')}),/BYOK modelID/);
  const manifestPath=join(secret.authDir!,'.weaver-byok-models.json');const manifest=readFileSync(manifestPath,'utf8');writeFileSync(manifestPath,JSON.stringify({...JSON.parse(manifest),files:[]}));assert.throws(()=>prepareChannelRun({channel:result.policy.config.channels[id]!,secret,model:'fixture-byok-id',stateDir:join(temp,'missing-customs')}),/文件清单/);writeFileSync(manifestPath,manifest);
  writeFileSync(join(secret.authDir!,'.models','fixture_uid','customs'),'mutated');assert.throws(()=>prepareChannelRun({channel:result.policy.config.channels[id]!,secret,model:'fixture-byok-id',stateDir:join(temp,'changed')}),/材料已变化/);
  truncated=true;result=await importer.import({revision:result.policy.revision,engine:'qoder',sourceDir:source,replaceExisting:true});const replacement=secrets.getSecret(id)!;assert.throws(()=>prepareChannelRun({channel:{...result.policy.config.channels[id]!,enabled:true},secret:replacement,model:'fixture-byok-id',stateDir:join(temp,'truncated')}),/尚未验证/);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('OpenCode env/file references become independent literals, and missing or escaped references fail before import',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'opencode');mkdirSync(source);writeFileSync(join(source,'key.txt'),' fixture-file-key \n');writeFileSync(join(source,'opencode.json'),JSON.stringify({provider:{env:{options:{apiKey:'{env:FIXTURE_KEY}'}},file:{options:{apiKey:'{file:key.txt}'}}}}));
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp,FIXTURE_KEY:'fixture-{env:DO_NOT_RESOLVE}'}});const result=await importer.import({revision:0,engine:'opencode',sourceDir:source});
  for(const [id,channel]of Object.entries(result.policy.config.channels).filter(([id])=>id.startsWith('import_'))){const secret=secrets.getSecret(id)!;assert.equal(secret.apiKey,channel.provider==='env'?'fixture-{env:DO_NOT_RESOLVE}':'fixture-file-key');const run=prepareChannelRun({channel,secret,model:`${channel.provider}/m`,stateDir:join(temp,'run')});const serialized=readFileSync(run.env.OPENCODE_CONFIG!,'utf8');assert.doesNotMatch(serialized,/\{env:/);assert.equal(JSON.parse(serialized).provider[channel.provider!].options.apiKey,secret.apiKey);cleanupChannelRun(run);}
  writeFileSync(join(source,'opencode.json'),JSON.stringify({provider:{bad:{options:{apiKey:'{env:MISSING_FIXTURE_KEY}'}}}}));await assert.rejects(importer.import({revision:result.policy.revision,engine:'opencode',sourceDir:source}),/环境变量不可用/);
  writeFileSync(join(source,'opencode.json'),JSON.stringify({provider:{bad:{options:{apiKey:'{file:../private.txt}'}}}}));await assert.rejects(importer.import({revision:result.policy.revision,engine:'opencode',sourceDir:source}),/来源目录内/);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('Pi and Grok preserve native Messages protocol when channel metadata does not override it',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const pi=join(temp,'pi');mkdirSync(pi);writeFileSync(join(pi,'models.json'),JSON.stringify({providers:{fixture:{api:'anthropic-messages',apiKey:'fixture-pi-key',models:[{id:'m',name:'m',api:'anthropic-messages'}]}}}));
  const grok=join(temp,'grok');mkdirSync(grok);writeFileSync(join(grok,'config.toml'),'[models]\ndefault="fixture-model"\n[model.fixture-model]\nmodel="upstream-m"\napi_backend="messages"\nenv_key="FIXTURE_GROK_KEY"\n');
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp,FIXTURE_GROK_KEY:'fixture-grok-key'}});let result=await importer.import({revision:0,engine:'pi',sourceDir:pi});result=await importer.import({revision:result.policy.revision,engine:'grok',sourceDir:grok});
  for(const [id,channel]of Object.entries(result.policy.config.channels).filter(([id])=>id.startsWith('import_'))){const run=prepareChannelRun({channel,secret:secrets.getSecret(id)!,model:channel.engine==='pi'?'fixture/m':'fixture-model',stateDir:join(temp,'run')});if(channel.engine==='pi'){const config=JSON.parse(readFileSync(join(run.env.PI_CODING_AGENT_DIR!,'models.json'),'utf8'));assert.equal(config.providers.fixture.api,'anthropic-messages');assert.equal(config.providers.fixture.models[0].api,'anthropic-messages');}else{const config=readToml(readFileSync(join(run.env.GROK_HOME!,'config.toml'),'utf8')) as any;assert.equal(config.model['fixture-model'].api_backend,'messages');}cleanupChannelRun(run);}
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('rollback recovery restores API metadata, roles and blocks without replacing managed secrets',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'pi');mkdirSync(source);const native=JSON.stringify({providers:{fixture:{apiKey:'fixture-stale-source',models:[{id:'m'}]}}});writeFileSync(join(source,'models.json'),native);
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const initial=policy.snapshot();initial.config.workers.pi_worker.model='fixture/m';policy.save({revision:0,config:initial.config,blocks:[{engine:'pi',channel:'default_pi',worker:'pi_worker',reason:'worker limit',since:'2026-01-01T00:00:00Z'}]});
  const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp}});const imported=await importer.import({revision:1,engine:'pi',sourceDir:source});const id=imported.policy.config.workers.pi_worker.channels[0];const managed={...secrets.getSecret(id)!,apiKey:'fixture-renewed-managed',config:'{"fixture":"managed configuration"}'};secrets.putSecret(id,managed);
  const rollback=policy.rollback(1);assert.equal(rollback.config.channels[id],undefined);
  const putSecret=secrets.putSecret.bind(secrets);secrets.putSecret=()=>{throw new Error('fixture transaction failure');};
  await assert.rejects(importer.import({revision:rollback.revision,engine:'pi',sourceDir:source}),/fixture transaction failure/);assert.deepEqual(policy.snapshot(),rollback);assert.deepEqual(secrets.getSecret(id),managed);secrets.putSecret=putSecret;
  const restored=await importer.import({revision:rollback.revision,engine:'pi',sourceDir:source});assert.ok(restored.policy.config.channels[id]);assert.equal(restored.policy.revision,rollback.revision+1);assert.equal(restored.policy.config.workers.pi_worker.channels[0],id);assert.equal(restored.policy.blocks[0].channel,id);assert.deepEqual(secrets.getSecret(id),managed);assert.equal(readFileSync(join(source,'models.json'),'utf8'),native);
  const unchanged=await importer.import({revision:restored.policy.revision,engine:'pi',sourceDir:source});assert.equal(unchanged.policy.revision,restored.policy.revision);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('rollback recovery preserves subscription root and renewed grant, and refuses orphan-root adoption',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'codex');mkdirSync(source);const native=JSON.stringify({tokens:{account_id:'fixture-stable-account',refresh_token:'fixture-stale-grant'}});writeFileSync(join(source,'auth.json'),native);
  const policy=new PolicyStore(db);const secrets=new ChannelStore(db);const initial=policy.snapshot();initial.config.channels.default_codex!.quota_refresh=false;policy.save({revision:0,config:initial.config,blocks:[{engine:'codex',channel:'default_codex',reason:'quota',by:'weaver-quota:codex',since:'2026-01-01T00:00:00Z'}]});
  const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp}});const imported=await importer.import({revision:1,engine:'codex',sourceDir:source});const id=imported.policy.config.workers.codex_worker.channels[0];const managed=secrets.getSecret(id)!;const authFile=join(managed.authDir!,'auth.json');const renewed='{"tokens":{"refresh_token":"fixture-renewed-grant"}}';writeFileSync(authFile,renewed);const inode=statSync(authFile).ino;
  const rollback=policy.rollback(1);const restored=await importer.import({revision:rollback.revision,engine:'codex',sourceDir:source});assert.ok(restored.policy.config.channels[id]);assert.equal(restored.policy.config.workers.codex_worker.channels[0],id);assert.equal(restored.policy.blocks[0].channel,id);assert.equal(restored.policy.config.channels[id]!.quota_refresh,false);assert.deepEqual(secrets.getSecret(id),managed);assert.equal(readFileSync(authFile,'utf8'),renewed);assert.equal(statSync(authFile).ino,inode);assert.equal(readFileSync(join(source,'auth.json'),'utf8'),native);
  const revision=restored.policy.revision;secrets.deleteSecret(id);await assert.rejects(importer.import({revision,engine:'codex',sourceDir:source}),/目标账号根已存在/);assert.equal(policy.snapshot().revision,revision);assert.equal(secrets.getSecret(id),undefined);assert.equal(readFileSync(authFile,'utf8'),renewed);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('all-source import keeps valid accounts when an unrelated source is malformed, and empty sources never claim completion',async()=>{
 const temp=fixture(),db=new DatabaseSync(':memory:');
 try{
  const policy=new PolicyStore(db),secrets=new ChannelStore(db);
  mkdirSync(join(temp,'.codex'));writeFileSync(join(temp,'.codex','auth.json'),'{');
  mkdirSync(join(temp,'.dsh'));writeFileSync(join(temp,'.dsh','.credentials.yaml'),'version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-dsh-key\n');
  const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp}});
  const result=await importer.import({revision:0});
  assert.ok(Object.entries(result.policy.config.channels).some(([id,c])=>id.startsWith('import_')&&c.engine==='dsh'));
  assert.match(result.configurations.default_codex.detail!,/codex.*来源/);
  assert.deepEqual(result.importResult,{added:1,existing:0,updated:0,notFound:['claude','grok','qoder','opencode','pi'],failures:[{engine:'codex',message:result.configurations.default_codex.detail}]});
  assert.doesNotMatch(JSON.stringify(result),/fixture-dsh-key/);assert.equal(readFileSync(join(temp,'.codex','auth.json'),'utf8'),'{');
  const revision=policy.snapshot().revision;
  await assert.rejects(importer.import({revision,engine:'codex',sourceDir:join(temp,'absent')}),/来源|可导入/);
  assert.equal(policy.snapshot().revision,revision);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('a failed isolated OpenCode account verification does not roll back a valid unrelated API import',async()=>{
 const temp=fixture(),db=new DatabaseSync(':memory:');
 try{
  const configRoot=join(temp,'.config','opencode'),dataRoot=join(temp,'data');mkdirSync(configRoot,{recursive:true});mkdirSync(dataRoot);
  const sourceDb=new DatabaseSync(join(dataRoot,'opencode.db'));sourceDb.exec('CREATE TABLE fixture(id TEXT)');sourceDb.close();
  mkdirSync(join(temp,'.dsh'));writeFileSync(join(temp,'.dsh','.credentials.yaml'),'version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-dsh-key\n');
  const policy=new PolicyStore(db),secrets=new ChannelStore(db);
  const org={accountID:'fixture-account',orgID:'fixture-org',accountEmail:'fixture@example.invalid',accountUrl:'https://opencode.ai/console',orgName:'Fixture',active:true};
  const accounts={list:async()=>({orgs:[org],consoleManagedProviders:['opencode-go'],switchableOrgCount:1,detail:''}),switchAccount:async()=>{throw new Error('native verification unavailable');},close:async()=>{}};
  const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp,OPENCODE_DB:join(dataRoot,'opencode.db')},accountsFactory:()=>accounts});
  const result=await importer.import({revision:0});
  assert.ok(Object.entries(result.policy.config.channels).some(([id,c])=>id.startsWith('import_')&&c.engine==='dsh'));
  assert.equal(Object.values(result.policy.config.channels).filter(c=>c.engine==='opencode').length,1);
  assert.match(result.configurations.default_opencode.detail!,/opencode.*复验/);
  assert.equal(result.importResult.added,1);assert.equal(result.importResult.failures[0].engine,'opencode');
  assert.doesNotMatch(JSON.stringify(result),/fixture-dsh-key|native verification unavailable/);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});


test('Claude empty OAuth cannot add or replace; renewed managed auth survives bad source without revision changes',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'.claude');mkdirSync(source);const file=join(source,'.credentials.json');
  writeFileSync(join(source,'.claude.json'),JSON.stringify({oauthAccount:{accountUuid:'fixture-claude',organizationUuid:'fixture-org'}}));
  const bad=JSON.stringify({claudeAiOauth:{accessToken:'',refreshToken:'',expiresAt:0}});writeFileSync(file,bad);
  const policy=new PolicyStore(db),secrets=new ChannelStore(db);const managed=join(temp,'managed');
  const importer=new NativeChannelImporter(policy,secrets,{root:managed,env:{HOME:temp}});
  const before=policy.snapshot();await assert.rejects(importer.import({revision:0,engine:'claude'}),/未找到可用.*OAuth.*重新登录/);
  assert.deepEqual(policy.snapshot(),before);assert.equal(db.prepare('SELECT count(*) AS n FROM channel_secrets').get()!.n,0);assert.equal(existsSync(managed),false);
  writeFileSync(file,JSON.stringify({claudeAiOauth:{accessToken:'fixture-expired',refreshToken:'fixture-renewable',expiresAt:1}}));
  const result=await importer.import({revision:0,engine:'claude',sourceDir:source});assert.equal(result.importResult.added,1);
  const id=Object.keys(result.policy.config.channels).find(id=>id.startsWith('import_'))!;const secret=secrets.getSecret(id)!;
  const privateFile=join(secret.authDir!,'.credentials.json');const renewed=JSON.stringify({claudeAiOauth:{accessToken:'fixture-newer',expiresAt:Date.now()+3600000}});writeFileSync(privateFile,renewed);
  const cfg=policy.snapshot();cfg.config.channels[id].label='keep custom';policy.save({revision:cfg.revision,config:cfg.config,blocks:cfg.blocks});
  const stable=policy.snapshot();writeFileSync(file,bad);
  const existing=await importer.import({revision:stable.revision,engine:'claude'});assert.equal(existing.importResult.existing,1);assert.equal(existing.importResult.added,0);assert.deepEqual(policy.snapshot(),stable);
  await assert.rejects(importer.import({revision:stable.revision,engine:'claude',replaceExisting:true}),/未找到可用.*OAuth/);
  assert.deepEqual(policy.snapshot(),stable);assert.deepEqual(secrets.getSecret(id),secret);assert.equal(readFileSync(privateFile,'utf8'),renewed);assert.equal(readFileSync(file,'utf8'),bad);
  writeFileSync(privateFile,bad);
  await assert.rejects(importer.import({revision:stable.revision,engine:'claude'}),/托管.*独立登录.*更新/);assert.deepEqual(policy.snapshot(),stable);assert.deepEqual(secrets.getSecret(id),secret);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('all-source import reports empty Claude as a partial failure and commits five valid sources',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  mkdirSync(join(temp,'.claude'));writeFileSync(join(temp,'.claude','.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'',refreshToken:'',expiresAt:0}}));writeFileSync(join(temp,'.claude','.claude.json'),JSON.stringify({oauthAccount:{accountUuid:'fixture-claude'}}));
  mkdirSync(join(temp,'.dsh'));writeFileSync(join(temp,'.dsh','.credentials.yaml'),'refs:\n  DEEPSEEK_API_KEY: fixture-valid-key\n');
  for(const engine of ['codex','grok']){mkdirSync(join(temp,`.${engine}`));writeFileSync(join(temp,`.${engine}`,'auth.json'),JSON.stringify({OPENAI_API_KEY:'fixture-api'}));}
  mkdirSync(join(temp,'.qoder','.auth'),{recursive:true});writeFileSync(join(temp,'.qoder','.auth','user'),Buffer.from([0,255,2,128]));writeFileSync(join(temp,'.qoder','.auth','machine_id'),'fixture-machine');
  mkdirSync(join(temp,'.config','opencode'),{recursive:true});writeFileSync(join(temp,'.config','opencode','opencode.json'),JSON.stringify({provider:{fixture:{options:{apiKey:'fixture-api'}}}}));
  const policy=new PolicyStore(db),secrets=new ChannelStore(db);const importer=new NativeChannelImporter(policy,secrets,{root:join(temp,'managed'),env:{HOME:temp},identifyAccount:async()=> 'fixture-qoder'});
  const result=await importer.import({revision:0});assert.equal(result.importResult.added,5);assert.equal(result.importResult.failures.length,1);assert.equal(result.importResult.failures[0].engine,'claude');assert.match(result.importResult.failures[0].message,/OAuth/);assert.ok(result.importResult.notFound.includes('pi'));
  assert.deepEqual(Object.entries(result.policy.config.channels).filter(([id])=>id.startsWith('import_')).map(([,c])=>c.engine).sort(),['codex','dsh','grok','opencode','qoder']);assert.equal(db.prepare('SELECT count(*) AS n FROM channel_secrets').get()!.n,5);assert.deepEqual(result.importResult.notFound,['pi']);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

test('Claude readiness uses local renewable OAuth and pins secure storage and profile selectors for API and subscription',async()=>{
 const {nativeCredentialsReady,nativeEnvironment}=await import('../../src/main/channels/native');const temp=fixture();try{
  for(const [oauth,ready,strict] of [
   [{accessToken:'',refreshToken:'',expiresAt:0},false,false],
   [{accessToken:'fixture',expiresAt:1},false,false],
   [{accessToken:'fixture',refreshToken:'renewable',expiresAt:1},true,false],
   [{accessToken:'fixture',expiresAt:Date.now()+3600000},true,true],
  ] as const){writeFileSync(join(temp,'.credentials.json'),JSON.stringify({claudeAiOauth:oauth}));assert.equal(nativeCredentialsReady('claude',{authDir:temp}),ready);assert.equal(nativeCredentialsReady('claude',{authDir:temp},true),strict);}
  for(const override of ['/global','']){
   const inherited={CLAUDE_CONFIG_DIR:override,CLAUDE_SECURESTORAGE_CONFIG_DIR:override,ANTHROPIC_CONFIG_DIR:override,ANTHROPIC_PROFILE:'global-profile',ANTHROPIC_API_KEY:'global-key',HOME:temp};
   const env=nativeEnvironment('claude',temp,inherited);assert.equal(env.CLAUDE_CONFIG_DIR,temp);assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR,temp);assert.equal(env.ANTHROPIC_CONFIG_DIR,join(temp,'anthropic'));assert.equal(env.ANTHROPIC_PROFILE,undefined);assert.equal(env.ANTHROPIC_API_KEY,undefined);assert.equal(env.HOME,temp);
   for(const kind of ['api','subscription'] as const){const run=prepareChannelRun({channel:{engine:'claude',kind,enabled:true,label:kind},secret:kind==='api'?{apiKey:'fixture'}:{authDir:temp},model:'sonnet',stateDir:join(temp,'runs'),env:inherited});assert.equal(run.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,run.env.CLAUDE_CONFIG_DIR);assert.equal(run.env.ANTHROPIC_CONFIG_DIR,join(run.env.CLAUDE_CONFIG_DIR!,'anthropic'));assert.equal(run.env.ANTHROPIC_PROFILE,undefined);cleanupChannelRun(run);}
  }
 }finally{rmSync(temp,{recursive:true,force:true});}
});


test('Claude secret write failures roll back metadata, roles, revision and newly created roots',async()=>{
 const temp=fixture();const db=new DatabaseSync(':memory:');try{
  const source=join(temp,'source'),managed=join(temp,'managed');mkdirSync(source);writeFileSync(join(source,'.claude.json'),JSON.stringify({oauthAccount:{accountUuid:'fixture-claude'}}));writeFileSync(join(source,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fixture-current',expiresAt:Date.now()+3600000}}));
  const policy=new PolicyStore(db),secrets=new ChannelStore(db);const importer=new NativeChannelImporter(policy,secrets,{root:managed,env:{HOME:temp}});const before=policy.snapshot();
  db.exec("CREATE TRIGGER reject_claude_insert BEFORE INSERT ON channel_secrets BEGIN SELECT RAISE(ABORT,'fixture secret failure'); END");
  await assert.rejects(importer.import({revision:0,engine:'claude',sourceDir:source}),/fixture secret failure/);assert.deepEqual(policy.snapshot(),before);assert.deepEqual(readdirSync(managed),[]);assert.equal(db.prepare('SELECT count(*) AS n FROM channel_secrets').get()!.n,0);
  db.exec('DROP TRIGGER reject_claude_insert');const imported=await importer.import({revision:0,engine:'claude',sourceDir:source});const id=Object.keys(imported.policy.config.channels).find(id=>id.startsWith('import_'))!;const secret=secrets.getSecret(id)!;const snapshot=policy.snapshot(),roots=readdirSync(managed);const original=readFileSync(join(secret.authDir!,'.credentials.json'));
  writeFileSync(join(source,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fixture-replacement',expiresAt:Date.now()+3600000}}));db.exec("CREATE TRIGGER reject_claude_update BEFORE UPDATE ON channel_secrets BEGIN SELECT RAISE(ABORT,'fixture secret failure'); END");
  await assert.rejects(importer.import({revision:snapshot.revision,engine:'claude',sourceDir:source,replaceExisting:true}),/fixture secret failure/);assert.deepEqual(policy.snapshot(),snapshot);assert.deepEqual(secrets.getSecret(id),secret);assert.deepEqual(readdirSync(managed),roots);assert.deepEqual(readFileSync(join(secret.authDir!,'.credentials.json')),original);
 }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});
