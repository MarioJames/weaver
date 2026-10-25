import { policySchema12 } from '../helpers/policy-schema12';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, SCHEMA_VERSION } from '../../src/main/migrate';
import { PolicyStore } from '../../src/main/policy/store';
import { defaultConfig, resolveDispatch, validateConfig } from '../../src/main/policy/routing';
import { ChannelStore } from '../../src/main/channels/store';
import { ChannelService } from '../../src/main/channels/service';
import { availabilityOf } from '../../src/shared/policy/availability';
import type { Channel } from '../../src/shared/contracts/channels';
import { roleEngine } from '../../src/shared/policy/channels';
const api:Channel={engine:'codex',kind:'api',enabled:true,label:'API',protocol:'openai-responses',baseUrl:'https://provider.example/v1'};
function setup(){const db=new DatabaseSync(':memory:');const policy=new PolicyStore(db);const secrets=new ChannelStore(db);return {db,policy,secrets,service:new ChannelService(policy,secrets)};}

test('channel metadata, native secrets and revisions are separate; empty inputs preserve key and clear config',()=>{
 const {db,policy,secrets,service}=setup();
 try{
  let result=service.save({revision:0,channel:api,apiKey:'test-private-key',config:'private-native-text'});
  const id=Object.keys(result.policy.config.channels).find(id=>id.startsWith('channel_'))!;
  assert.ok(id);assert.deepEqual(result.configurations[id],{hasApiKey:true,hasConfig:true,hasCredentials:false});
  assert.doesNotMatch(JSON.stringify(result),/test-private-key|private-native-text/);
  assert.doesNotMatch(String((db.prepare('SELECT body FROM policy_revisions').get() as any).body),/test-private-key|private-native-text/);
  result=service.save({revision:1,id,channel:{...api,label:'renamed'},apiKey:'',config:''});
  assert.deepEqual(secrets.getSecret(id),{apiKey:'test-private-key'});
  policy.save({revision:2,config:result.policy.config,blocks:[]});
  assert.deepEqual(secrets.getSecret(id),{apiKey:'test-private-key'},'normal policy rewrite cannot cascade private storage');
  assert.throws(()=>service.save({revision:1,id,channel:api,apiKey:'bad-replacement'}),/reload/);
  assert.deepEqual(secrets.getSecret(id),{apiKey:'test-private-key'});
  assert.throws(()=>service.save({revision:3,id,channel:{...api,baseUrl:'https://user:pass@provider.example'},apiKey:'bad-replacement'}),/credentials/);
  assert.deepEqual(secrets.getSecret(id),{apiKey:'test-private-key'});
  assert.throws(()=>service.save({revision:3,id:'constructor',channel:api}),/Invalid channel/);
  assert.throws(()=>service.save({revision:3,id:'unknown',channel:api}),/Unknown channel/);
  for(const change of [{...api,engine:'grok'},{...api,kind:'subscription' as const}]){assert.throws(()=>service.save({revision:3,id,channel:change,apiKey:'wrong'}),/cannot be changed/);assert.deepEqual(secrets.getSecret(id),{apiKey:'test-private-key'});}
  const cfg=policy.snapshot().config;cfg.workers.codex_worker.channels=[id];
  policy.save({revision:3,config:cfg,blocks:[]});
  assert.throws(()=>service.delete({revision:4,id}),/referenced/);
  assert.deepEqual(secrets.getSecret(id),{apiKey:'test-private-key'});
 }finally{db.close();}
});

test('policy and secret changes roll back together after a SQLite failure',()=>{
 const {db,policy,secrets,service}=setup();try{
  const result=service.save({revision:0,channel:api,apiKey:'original'});const id=Object.keys(result.policy.config.channels).find(id=>id.startsWith('channel_'))!;
  db.exec("CREATE TRIGGER reject_secret BEFORE UPDATE ON channel_secrets BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
  assert.throws(()=>service.save({revision:1,id,channel:{...api,label:'wrong'},apiKey:'replacement'}),/simulated failure/);
  assert.equal(policy.snapshot().revision,1);assert.equal(policy.snapshot().config.channels[id].label,'API');assert.deepEqual(secrets.getSecret(id),{apiKey:'original'});
  assert.equal((db.prepare('SELECT count(*) AS n FROM policy_revisions').get() as any).n,1);
  db.exec('DROP TRIGGER reject_secret');
  service.delete({revision:1,id});assert.equal(secrets.getSecret(id),undefined);
 }finally{db.close();}
});

test('same-engine channels isolate limits and retries, while global failures reach both',()=>{
 const c=defaultConfig();c.channels.api=api;c.workers.api={...c.workers.codex_worker,channels:['api']};
 c.owners.claude_owner.workers=['codex_worker','api'];
 const block={engine:'codex',channel:'default_codex',reason:'quota',since:'2026-01-01T00:00:00Z'};
 assert.equal(resolveDispatch(c,[block],{owner:'claude_owner'}).channel,'api');
 assert.equal(resolveDispatch(c,[],{owner:'claude_owner',excludeChannels:['default_codex']}).worker,'api');
 assert.throws(()=>resolveDispatch(c,[],{owner:'claude_owner',excludeChannels:['default_codex','api']}));
 assert.equal(availabilityOf(c,[{...block,channel:undefined}],c.workers.api,'api').status,'blocked');
 const dispatch=resolveDispatch(c,[],{owner:'claude_owner'});assert.equal(dispatch.engine,roleEngine(c,c.workers[dispatch.worker]));assert.ok(dispatch.channel);
 const bad=defaultConfig();bad.channels.default_pi.kind='subscription';assert.ok(validateConfig(bad).some(i=>i.message.includes('API')));
});

/** Rebuild the actual v12 table shape, then seed historical rows and JSON snapshots. */
function historical12(db:DatabaseSync){
 migrate(db);
 policySchema12(db);db.exec('PRAGMA user_version=12');
 const config:any={version:1,engines:{my_codex:{enabled:true,kind:'codex'},pi:{enabled:false,kind:'pi'}},owners:{owner:{enabled:true,engine:'my_codex',model:'gpt',effort:'high',workers:['worker'],max_parallel:3,worker_weights:{worker:8}}},workers:{worker:{enabled:true,engine:'my_codex',model:'gpt-original',effort:'high',max_parallel:2},pi_worker:{enabled:false,engine:'pi',model:'provider/model-original',effort:'high'}},herdr:{max_wait_minutes:15}};
 const blocks=[{engine:'my_codex',reason:'quota',by:'weaver-quota:codex',since:'2026-01-01T00:00:00Z'},{engine:'my_codex',worker:'worker',reason:'manual limit',since:'2026-01-02T00:00:00Z'}];
 db.prepare('INSERT INTO policy_engines VALUES (?,?,?,?,?)').run('my_codex',0,1,'codex',null);db.prepare('INSERT INTO policy_engines VALUES (?,?,?,?,?)').run('pi',1,0,'pi',null);
 db.prepare('INSERT INTO policy_owners(id,position,enabled,engine,model,effort,max_parallel) VALUES (?,?,?,?,?,?,?)').run('owner',0,1,'my_codex','gpt','high',3);
 db.prepare('INSERT INTO policy_owner_workers VALUES (?,?,?,?)').run('owner','worker',0,8);
 db.prepare('INSERT INTO policy_workers(id,position,enabled,engine,model,effort,max_parallel) VALUES (?,?,?,?,?,?,?)').run('worker',0,1,'my_codex','gpt-original','high',2);
 db.prepare('INSERT INTO policy_workers(id,position,enabled,engine,model,effort) VALUES (?,?,?,?,?,?)').run('pi_worker',1,0,'pi','provider/model-original','high');
 db.prepare('INSERT INTO policy_settings VALUES (?,?)').run('herdr',JSON.stringify(config.herdr));
 for(const [i,b] of blocks.entries())db.prepare('INSERT INTO policy_blocks(position,engine,worker,reason,since,by) VALUES (?,?,?,?,?,?)').run(i,b.engine,b.worker??null,b.reason,b.since,b.by??null);
 db.prepare('INSERT INTO policy_revisions VALUES (?,?,?,?)').run(1,'2026-01-01T00:00:00Z','save',JSON.stringify({version:1,revision:1,config,blocks}));
 db.prepare('INSERT INTO tasks(id,status,updated_at,body) VALUES (?,?,?,?)').run('old-task','completed','2026-01-01T00:00:00Z','{"dispatch":{"engine":"my_codex"},"history":"retained"}');
 db.prepare('INSERT INTO task_events VALUES (?,?,?,?)').run('old-task','e',0,'{"message":"historical"}');
 return config;
}

test('empty install and schema12 history upgrade preserve roles, weights, blocks, tasks and old rollback; repeated migrations are stable',()=>{
 const db=new DatabaseSync(':memory:');try{
  const fresh=new PolicyStore(db);assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version,SCHEMA_VERSION);assert.deepEqual(validateConfig(fresh.snapshot().config),[]);
  historical12(db);migrate(db);migrate(db);
  const store=new PolicyStore(db);const before=store.snapshot();
  assert.equal(before.config.channels.default_my_codex.engine,'my_codex');assert.equal(before.config.owners.owner.channel,'default_my_codex');assert.equal(before.config.owners.owner.worker_weights?.worker,8);
  assert.equal(before.config.workers.worker.max_parallel,2);assert.equal(before.config.workers.worker.model,'gpt-original');
  assert.equal(before.config.channels.default_pi.kind,'api');assert.equal(before.config.channels.default_pi.provider,'provider');assert.equal(before.config.workers.pi_worker.model,'provider/model-original');
  assert.equal(before.blocks[0].channel,'default_my_codex');assert.equal(before.blocks[1].worker,'worker');
  assert.equal((db.prepare('SELECT body FROM tasks').get() as any).body,'{"dispatch":{"engine":"my_codex"},"history":"retained"}');assert.equal((db.prepare('SELECT count(*) AS n FROM task_events').get() as any).n,1);
  assert.deepEqual(new PolicyStore(db).snapshot(),before);assert.deepEqual(store.rollback(1).config,before.config);migrate(db);assert.deepEqual(new PolicyStore(db).snapshot(),store.snapshot());
 }finally{db.close();}
});

test('vendor aggregate channel pause never applies to a later API account',async()=>{
 const {escalateEngineBlock,withoutWorkerBlocks,ENGINE_ALL_BLOCKED_REASON}=await import('../../src/main/policy/routing');
 const c=defaultConfig();c.channels.api=api;c.workers.api={...c.workers.codex_worker,channels:['api']};
 const workerBlock={engine:'codex',channel:'default_codex',worker:'codex_worker',reason:'limit',since:'2026-01-01T00:00:00Z',by:'weaver-vendor-limit'};
 const blocks=escalateEngineBlock(c,[workerBlock],'codex',Date.parse('2026-01-01T00:00:00Z'));
 assert.equal(blocks.length,2);assert.equal(blocks[1].channel,'default_codex');assert.equal(blocks[1].reason,ENGINE_ALL_BLOCKED_REASON);
 assert.equal(availabilityOf(c,blocks,c.workers.api,'api').status,'available');
 assert.deepEqual(withoutWorkerBlocks(c,blocks,'codex','codex_worker',Date.parse('2026-01-01T00:00:00Z')).blocks,[]);
});

test('quota records act only on their authenticated channel and migrated switches belong to channels',async()=>{
 const {applyQuotaSnapshot}=await import('../../src/main/policy/quota');
 const {db,policy}=setup();try{
  const c=policy.snapshot().config;c.channels.other={engine:'codex',kind:'subscription',label:'Other account',enabled:true};c.channels.api=api;
  policy.save({revision:0,config:c,blocks:[]});
  const record:any={engine:'codex',channel:'default_codex',status:'exhausted',source:'fixture',checkedAt:'2026-01-01T00:00:00Z',observedAt:'2026-01-01T00:00:00Z',stale:false,windows:[],detail:'fixture',retryAt:null};
  const result=applyQuotaSnapshot(policy,{records:[record]}, {},Date.parse('2026-01-01T00:00:00Z'));
  assert.deepEqual(result.snapshot.blocks.map(b=>b.channel),['default_codex']);
  assert.equal(applyQuotaSnapshot(policy,{records:[{...record,channel:undefined}]},{},Date.parse('2026-01-01T00:00:00Z')).policyChanged,false);
  assert.equal(applyQuotaSnapshot(policy,{records:[{...record,channel:'other'}]},{channel:'default_codex'},Date.parse('2026-01-01T00:00:00Z')).policyChanged,false);
  assert.equal(applyQuotaSnapshot(policy,{records:[{...record,channel:'api'}]},{},Date.parse('2026-01-01T00:00:00Z')).policyChanged,false);
 }finally{db.close();}
 for(const enabled of [false,true]) {
  const legacy=new DatabaseSync(':memory:');try{historical12(legacy);legacy.prepare('UPDATE policy_engines SET quota_refresh=? WHERE id=?').run(enabled?1:0,'my_codex');const old=JSON.parse((legacy.prepare('SELECT body FROM policy_revisions WHERE revision=1').get() as {body:string}).body);old.config.engines.my_codex.quota_refresh=enabled;legacy.prepare('UPDATE policy_revisions SET body=? WHERE revision=1').run(JSON.stringify(old));migrate(legacy);const snapshot=new PolicyStore(legacy).snapshot();assert.equal(snapshot.config.channels.default_my_codex.quota_refresh,enabled);assert.equal('quota_refresh' in snapshot.config.engines.my_codex,false);
   // Snapshot history used for rollback carries the switch from the legacy revision as well.
   const row=legacy.prepare('SELECT body FROM policy_revisions WHERE revision=1').get() as {body:string};const body=JSON.parse(row.body);assert.equal('quota_refresh' in body.config.engines.my_codex,false);assert.equal(body.config.channels.default_my_codex.quota_refresh,enabled);assert.equal(new PolicyStore(legacy).rollback(1).config.channels.default_my_codex.quota_refresh,enabled);
  }finally{legacy.close();}
 }
});


test('legacy vendor aggregate and worker limits follow their account, true engine stalls remain global',async()=>{
 const {migrateChannelPolicy}=await import('../../src/shared/policy/channels');
 const {ENGINE_ALL_BLOCKED_REASON}=await import('../../src/shared/policy/blocks');
 const common={engine:'codex',since:'2026-01-01T00:00:00Z'};
 const legacy:any={version:1,engines:{codex:{kind:'codex',enabled:true}},owners:{},workers:{w:{engine:'codex',enabled:true,model:'original',effort:'high'}}};
 const migrated=migrateChannelPolicy(legacy,[{...common,by:'weaver-vendor-limit',reason:ENGINE_ALL_BLOCKED_REASON},{...common,by:'weaver-vendor-limit',worker:'w',reason:'429'},{...common,by:'weaver-stall',reason:'silent'},{...common,by:'person',reason:ENGINE_ALL_BLOCKED_REASON}]);
 assert.deepEqual(migrated.blocks.map(b=>b.channel),['default_codex','default_codex',undefined,undefined]);
});


test('a disabled channel reports its own availability reason',()=>{
 const config=defaultConfig();config.channels.default_codex.enabled=false;
 assert.deepEqual(availabilityOf(config,[],config.workers.codex_worker,'codex_worker'),{status:'channel_disabled',channel:'default_codex'});
});

test('schema12 SQL NULL block fields migrate identically to JSON history and keep true global pauses',async()=>{
 const {ENGINE_ALL_BLOCKED_REASON}=await import('../../src/shared/policy/blocks');
 const db=new DatabaseSync(':memory:');try{
  historical12(db);
  const row=db.prepare('SELECT body FROM policy_revisions WHERE revision=1').get() as {body:string};const history=JSON.parse(row.body);
  const common={engine:'my_codex',since:'2026-01-03T00:00:00Z'};
  const additions=[{...common,reason:ENGINE_ALL_BLOCKED_REASON,by:'weaver-vendor-limit'},{...common,worker:'worker',reason:'429',by:'weaver-vendor-limit'},{...common,reason:'silent',by:'weaver-stall'},{...common,reason:ENGINE_ALL_BLOCKED_REASON,by:'person'}].map((block,index)=>({...block,model:`fixture-${index}`}));
  for(const [index,block]of additions.entries())db.prepare('INSERT INTO policy_blocks(position,engine,worker,reason,since,by,model) VALUES (?,?,?,?,?,?,?)').run(history.blocks.length+index,block.engine,'worker' in block?block.worker:null,block.reason,block.since,block.by,block.model);
  history.blocks.push(...additions);db.prepare('UPDATE policy_revisions SET body=? WHERE revision=1').run(JSON.stringify(history));
  assert.equal(db.prepare("SELECT worker FROM policy_blocks WHERE by='weaver-vendor-limit' AND reason=?").get(ENGINE_ALL_BLOCKED_REASON)!.worker,null);
  migrate(db);const store=new PolicyStore(db);const current=store.snapshot();
  const migrated=JSON.parse((db.prepare('SELECT body FROM policy_revisions WHERE revision=1').get() as {body:string}).body);
  const identity=(blocks:any[])=>blocks.map(({engine,worker,channel,by,reason,model})=>({engine,worker,channel,by,reason,model}));
  assert.deepEqual(identity(current.blocks),identity(migrated.blocks));
  assert.deepEqual(current.blocks.map(block=>block.channel),['default_my_codex',undefined,'default_my_codex','default_my_codex',undefined,undefined]);
  assert.equal(current.blocks.length,history.blocks.length);migrate(db);assert.deepEqual(new PolicyStore(db).snapshot(),current);assert.deepEqual(store.rollback(1).blocks,current.blocks);
 }finally{db.close();}
});
