import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PolicyStore } from '../../src/main/policy/store';
import { ChannelStore } from '../../src/main/channels/store';
import { ChannelService } from '../../src/main/channels/service';
import { NativeChannelImporter } from '../../src/main/channels/import';
import { remapImportedBlocks } from '../../src/main/channels/import-blocks';
import { defaultConfig } from '../../src/main/policy/routing';
const since='2026-01-01T00:00:00Z';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'ci-'));const db=new DatabaseSync(join(root,'test.sqlite'));
 const policy=new PolicyStore(db),secrets=new ChannelStore(db);
 const source=join(root,'source');mkdirSync(source);
 const native=JSON.stringify({tokens:{account_id:'synthetic-account-a',refresh_token:'synthetic-grant-a'}});
 writeFileSync(join(source,'auth.json'),native);
 const importer=new NativeChannelImporter(policy,secrets,{root:join(root,'managed'),env:{HOME:root}});
 return {root,db,policy,secrets,source,native,importer,close(){db.close();rmSync(root,{recursive:true,force:true});}};
}
test('disabled second and third worker members protect deletion until explicitly removed',()=>{
 const f=fixture();try{
  const config=f.policy.snapshot().config;
  for(const id of ['second','third'])config.channels[id]={...config.channels.default_codex,enabled:false,label:id};
  config.workers.codex_worker.channels=['default_codex','second','third'];config.workers.codex_worker.enabled=false;for(const owner of Object.values(config.owners))owner.enabled=false;
  f.policy.save({revision:0,config,blocks:[]});f.secrets.putSecret('second',{apiKey:'synthetic-secret'});
  const service=new ChannelService(f.policy,f.secrets);
  for(const id of ['second','third'])assert.throws(()=>service.delete({revision:1,id}),/referenced/);
  const updated=f.policy.snapshot();updated.config.workers.codex_worker.channels=['default_codex','third'];
  f.policy.save({revision:1,config:updated.config,blocks:[]});
  service.delete({revision:2,id:'second'});assert.equal(f.secrets.getSecret('second'),undefined);
  assert.deepEqual(f.policy.snapshot().config.workers.codex_worker.channels,['default_codex','third']);
 }finally{f.close();}
});
test('new identities and repeated imports preserve explicit worker pools and account-scoped restrictions',async()=>{
 const f=fixture();try{
  const config=f.policy.snapshot().config;config.channels.other={...config.channels.default_codex,label:'other'};
  config.workers.codex_worker.channels=['default_codex','other'];
  const blocks=[{engine:'codex',channel:'other',worker:'codex_worker',reason:'worker limit',since,by:'weaver-vendor-limit'}, {engine:'codex',channel:'other',reason:'quota',since,by:'weaver-quota:codex'}];
  f.policy.save({revision:0,config,blocks});
  let result=await f.importer.import({revision:1,engine:'codex',sourceDir:f.source});
  const id=Object.keys(result.policy.config.channels).find(id=>id.startsWith('import_'))!;
  assert.ok(id);assert.deepEqual(result.policy.config.workers.codex_worker.channels,['default_codex','other']);
  assert.deepEqual(result.policy.blocks,blocks);
  const before=result.policy;result=await f.importer.import({revision:before.revision,engine:'codex',sourceDir:f.source});
  assert.deepEqual(result.policy,before);assert.equal(readFileSync(join(f.source,'auth.json'),'utf8'),f.native);
 }finally{f.close();}
});
test('legacy singleton rebind maps its restrictions exactly without broadcasting quota to another imported identity',async()=>{
 const f=fixture();try{
  const config=f.policy.snapshot().config;
  const blocks=[{engine:'codex',channel:'default_codex',worker:'codex_worker',reason:'worker limit',since,by:'weaver-vendor-limit'},{engine:'codex',channel:'default_codex',reason:'quota',since,by:'weaver-quota:codex'}];
  f.policy.save({revision:0,config,blocks});
  let result=await f.importer.import({revision:1,engine:'codex',sourceDir:f.source});
  const [a]=result.policy.config.workers.codex_worker.channels;assert.match(a,/^import_/);
  assert.deepEqual(result.policy.blocks.map(b=>b.channel),[a,a]);
  writeFileSync(join(f.source,'auth.json'),JSON.stringify({tokens:{account_id:'synthetic-account-b'}}));
  result=await f.importer.import({revision:result.policy.revision,engine:'codex',sourceDir:f.source});
  assert.deepEqual(result.policy.config.workers.codex_worker.channels,[a]);
  assert.deepEqual(result.policy.blocks.map(b=>b.channel),[a,a]);
 }finally{f.close();}
});
test('exact block replacement preserves other pool accounts and does not invent an account for global worker limits',()=>{
 const config=defaultConfig();for(const id of ['a','b','new_a'])config.channels[id]={...config.channels.default_codex,label:id};
 config.workers.codex_worker.channels=['new_a','b'];
 const blocks=[{engine:'codex',channel:'a',worker:'codex_worker',reason:'a limit',since},{engine:'codex',channel:'b',worker:'codex_worker',reason:'b limit',since},{engine:'codex',worker:'codex_worker',reason:'all accounts',since}];
 const result=remapImportedBlocks(config,blocks,[{before:'a',after:'new_a'}],new Map([['codex',new Set(['new_a','b'])]]));
 assert.deepEqual(result.map(b=>b.channel),['new_a','b',undefined]);
});
test('failed replacement preserves full pool, restrictions, managed secret and source authentication',async()=>{
 const f=fixture();try{
  let result=await f.importer.import({revision:0,engine:'codex',sourceDir:f.source});const id=Object.keys(result.policy.config.channels).find(id=>id.startsWith('import_'))!;
  const config=result.policy.config;config.channels.other={...config.channels[id],label:'other'};config.workers.codex_worker.channels=[id,'other'];
  f.policy.save({revision:result.policy.revision,config,blocks:[{engine:'codex',channel:id,reason:'limit',since}]});
  const before=f.policy.snapshot(),secret=f.secrets.getSecret(id)!;const grant=readFileSync(join(secret.authDir!,'auth.json'),'utf8');
  f.db.exec("CREATE TRIGGER reject_secret BEFORE UPDATE ON channel_secrets BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  await assert.rejects(f.importer.import({revision:before.revision,engine:'codex',sourceDir:f.source,replaceExisting:true}),/synthetic failure/);
  assert.deepEqual(f.policy.snapshot(),before);assert.deepEqual(f.secrets.getSecret(id),secret);
  assert.equal(readFileSync(join(secret.authDir!,'auth.json'),'utf8'),grant);assert.equal(readFileSync(join(f.source,'auth.json'),'utf8'),f.native);
 }finally{f.close();}
});
test('unrebound placeholder quota never spreads across imported subscriptions',()=>{
 const config=defaultConfig();for(const id of ['a','b'])config.channels[id]={...config.channels.default_codex,label:id};
 config.workers.codex_worker.channels=['a','b'];
 const blocks=[{engine:'codex',channel:'default_codex',reason:'quota',since,by:'weaver-quota:codex'}];
 assert.deepEqual(remapImportedBlocks(config,blocks,[],new Map([['codex',new Set(['a','b'])]])),blocks);
});
test('split legacy roles keep worker API limits separate from official quota',async()=>{
 const f=fixture();try{
  writeFileSync(join(f.source,'config.toml'),'model_provider="synthetic_api"\n[model_providers.synthetic_api]\nname="Synthetic API"\nexperimental_bearer_token="synthetic-key"\n');
  const config=f.policy.snapshot().config;config.workers.codex_worker.model='synthetic_api/model';
  f.policy.save({revision:0,config,blocks:[{engine:'codex',channel:'default_codex',worker:'codex_worker',reason:'worker limit',since,by:'weaver-vendor-limit'},{engine:'codex',channel:'default_codex',reason:'quota',since,by:'weaver-quota:codex'},{engine:'codex',reason:'global failure',since}]});
  const result=await f.importer.import({revision:1,engine:'codex',sourceDir:f.source});
  const [api]=result.policy.config.workers.codex_worker.channels;const official=Object.keys(result.policy.config.channels).find(id=>id.startsWith('import_')&&result.policy.config.channels[id].kind==='subscription')!;
  assert.equal(result.policy.config.channels[api].kind,'api');assert.equal(result.policy.config.channels[official].kind,'subscription');
  assert.deepEqual(result.policy.blocks.map(b=>b.channel),[api,official,undefined]);
 }finally{f.close();}
});
