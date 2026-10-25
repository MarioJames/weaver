import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { migrate, SCHEMA_VERSION } from '../../src/main/migrate';
import { PolicyStore } from '../../src/main/policy/store';
import { defaultConfig, validateConfig } from '../../src/main/policy/routing';
import * as channels from '../../src/shared/policy/channels';
import { availabilityOf } from '../../src/shared/policy/availability';
import { policySchema12 } from '../helpers/policy-schema12';

function multi(kind='codex') {
 const c=defaultConfig(); const w=c.workers[`${kind}_worker`]!;
 c.channels.second={...c.channels[`default_${kind}`]!};
 w.channels=[`default_${kind}`,'second'];
 return {c,w};
}
test('worker channel arrays validate every member and preserve singleton engines',()=>{
 assert.deepEqual(validateConfig(defaultConfig()),[]);
 const {c,w}=multi(); assert.deepEqual(validateConfig(c),[]);
 for(const bad of [[],['default_codex','default_codex'],['default_codex','missing'],Array.from({length:21},(_,i)=>`c${i}`)]) {
  w.channels=bad; assert.ok(validateConfig(c).some(i=>i.path.includes('channels')));
 }
 w.channels=['default_codex','default_claude'];assert.ok(validateConfig(c).some(i=>i.message.includes('same engine')));
 c.channels.alias={...c.channels.default_codex,engine:'codex_alias'};c.engines.codex_alias={enabled:true,kind:'codex'};w.channels=['default_codex','alias'];assert.ok(validateConfig(c).some(i=>i.message.includes('same engine')));
 for(let i=0;i<21;i++)c.channels[`account_${i}`]={...c.channels.default_codex};
 w.channels=Array.from({length:20},(_,i)=>`account_${i}`);assert.deepEqual(validateConfig(c),[]);w.channels.push('account_20');assert.ok(validateConfig(c).some(i=>i.message.includes('20')));
 w.channels=['default_codex'];(w as any).channel='default_codex';assert.ok(validateConfig(c).some(i=>i.path.endsWith('.channel')));
});
test('multi-account only admits quota subscription engines and OpenCode Go models',()=>{
 for(const kind of ['codex','claude','grok']) {const {c}=multi(kind);assert.deepEqual(validateConfig(c),[]);}
 for(const kind of ['qoder','pi','dsh','opencode']) {const {c}=multi(kind);assert.ok(validateConfig(c).some(i=>i.path.includes('channels')));}
 const {c,w}=multi(); c.channels.second.kind='api';assert.ok(validateConfig(c).some(i=>i.path.includes('channels[1]')));
 c.channels.second.kind='subscription';w.free_channel=true;assert.ok(validateConfig(c).some(i=>i.path.includes('channels')));
 const go=multi('opencode');go.w.free_channel=false;go.w.model='opencode-go/glm-5';assert.deepEqual(validateConfig(go.c),[]);
});
test('shared helpers describe membership and availability without selecting an account',()=>{
 const {c,w}=multi();
 assert.deepEqual(channels.roleChannels(w),w.channels);assert.equal(channels.workerUsesChannel(w,'second'),true);
 assert.equal(channels.roleEngine(c,w),'codex');
 const block={engine:'codex',channel:'default_codex',reason:'quota',since:'2026-01-01T00:00:00Z'};
 assert.equal(availabilityOf(c,[block],w,'codex_worker').status,'available');
 assert.equal(availabilityOf(c,[block,{...block,channel:'second'}],w,'codex_worker').status,'blocked');
 assert.equal(channels.channelOf(c,{channel:'second'}),c.channels.second);
 assert.throws(()=>channels.channelOf(c,w as any));
});
function schema13(db:DatabaseSync) {
 const store=new PolicyStore(db);const blocks=[{engine:'codex',channel:'default_codex',reason:'quota',since:'2026-01-01T00:00:00Z'}];store.save({revision:0,config:defaultConfig(),blocks});store.save({revision:1,config:defaultConfig(),blocks});
 db.exec('ALTER TABLE policy_workers RENAME COLUMN channels TO channel');
 for(const row of db.prepare('SELECT id,channel FROM policy_workers').all() as any[]) db.prepare('UPDATE policy_workers SET channel=? WHERE id=?').run(JSON.parse(row.channel)[0],row.id);
 for(const row of db.prepare('SELECT revision,body FROM policy_revisions').all() as any[]) {
  const b=JSON.parse(row.body);for(const w of Object.values(b.config.workers) as any[]){w.channel=w.channels[0];delete w.channels;}
  db.prepare('UPDATE policy_revisions SET body=? WHERE revision=?').run(JSON.stringify(b),row.revision);
 }
 db.exec('PRAGMA user_version=13');
}
test('empty SQLite installation, save reload rollback and repeated migration retain arrays',()=>{
 const dir=mkdtempSync(join(tmpdir(),'worker-channels-sqlite-'));
 const path=join(dir,'weaver.db');
 let db=new DatabaseSync(path);try {
  migrate(db);assert.equal(SCHEMA_VERSION,14);
  const store=new PolicyStore(db);const {c}=multi();store.save({revision:0,config:c,blocks:[]});
  migrate(db);assert.deepEqual(new PolicyStore(db).snapshot().config.workers.codex_worker.channels,c.workers.codex_worker.channels);
  store.save({revision:1,config:defaultConfig(),blocks:[]});assert.deepEqual(store.rollback(1).config.workers.codex_worker.channels,c.workers.codex_worker.channels);
  db.close();db=new DatabaseSync(path);assert.deepEqual(new PolicyStore(db).snapshot().config.workers.codex_worker.channels,c.workers.codex_worker.channels);
 }finally{try{db.close();}finally{rmSync(dir,{recursive:true,force:true});}}
});
test('schema13 upgrades every revision and preserves unrelated records and metadata',()=>{
 const db=new DatabaseSync(':memory:');try {
  schema13(db);
  const sentinels=[['tasks',"INSERT INTO tasks VALUES ('t',NULL,NULL,'done','date','{\"dispatch\":{\"channel\":\"default_codex\"}}')"],['channel_secrets',"INSERT INTO channel_secrets VALUES ('s','secret')"],['quota_records',"INSERT INTO quota_records VALUES ('codex','quota')"],['vendor_worker_limits',"INSERT INTO vendor_worker_limits VALUES ('codex_worker',2,123)"],['free_probe_history',"INSERT INTO free_probe_history(worker,engine,level,at,body) VALUES ('w','codex',1,123,'probe')"]];
  for(const [,sql] of sentinels)db.exec(sql);
  const before=sentinels.map(([table])=>db.prepare(`SELECT * FROM ${table}`).all());
  const history=db.prepare('SELECT revision,saved_at,source FROM policy_revisions').all();migrate(db);migrate(db);
  assert.deepEqual(db.prepare('SELECT revision,saved_at,source FROM policy_revisions').all(),history);
  sentinels.forEach(([table],i)=>assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(),before[i]));
  for(const row of db.prepare('SELECT body FROM policy_revisions').all() as any[]) {const b=JSON.parse(row.body);assert.deepEqual(b.config.workers.codex_worker.channels,['default_codex']);assert.equal(b.config.owners.codex_owner.channel,'default_codex');assert.equal(b.blocks[0].channel,'default_codex');}
  assert.deepEqual(new PolicyStore(db).rollback(1).config.workers.codex_worker.channels,['default_codex']);
 }finally{db.close();}
});
test('schema12 serial upgrade preserves historical worker engine input',()=>{
 const db=new DatabaseSync(':memory:');try {
  new PolicyStore(db).save({revision:0,config:defaultConfig(),blocks:[]});policySchema12(db);db.exec('PRAGMA user_version=12');migrate(db);
  assert.deepEqual(new PolicyStore(db).snapshot().config.workers.codex_worker.channels,['default_codex']);
 }finally{db.close();}
});
test('bad or ambiguous history retains original bytes while live rows upgrade and rollback rejects it',()=>{
 for(const malformed of ['invalid','ambiguous','missing-channel','bad-worker','missing-workers','missing-config','bad-blocks','bad-version','unknown-channel']) {
  const db=new DatabaseSync(':memory:');try {
   schema13(db);const row=db.prepare('SELECT body FROM policy_revisions WHERE revision=2').get() as any;
   const b=JSON.parse(row.body);
   if(malformed==='ambiguous')b.config.workers.codex_worker.channels=['default_codex'];
   if(malformed==='missing-channel')delete b.config.workers.codex_worker.channel;
   if(malformed==='bad-worker')b.config.workers.codex_worker=null;
   if(malformed==='missing-workers')delete b.config.workers;
   if(malformed==='missing-config')delete b.config;
   if(malformed==='bad-blocks')b.blocks={};
   if(malformed==='bad-version')b.version=2;
   if(malformed==='unknown-channel')b.config.workers.codex_worker.channel='missing';
   const body=malformed==='invalid'?'not json':`  ${JSON.stringify(b)} \n`;
   db.prepare('UPDATE policy_revisions SET body=? WHERE revision=2').run(body);
   const metadata=db.prepare('SELECT revision,saved_at,source FROM policy_revisions').all();
   for(let round=0;round<3;round++) {
    migrate(db);assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version,14);
    assert.equal((db.prepare('SELECT body FROM policy_revisions WHERE revision=2').get() as any).body,body);
    assert.deepEqual(db.prepare('SELECT revision,saved_at,source FROM policy_revisions').all(),metadata);
    const store=new PolicyStore(db);const before=store.snapshot();const history=store.history();
    assert.deepEqual(before.config.workers.codex_worker.channels,['default_codex']);
    assert.deepEqual(JSON.parse((db.prepare('SELECT body FROM policy_revisions WHERE revision=1').get() as any).body).config.workers.codex_worker.channels,['default_codex']);
    assert.throws(()=>store.rollback(2),malformed);assert.deepEqual(store.snapshot(),before);
    assert.deepEqual(new PolicyStore(db).snapshot(),before);assert.deepEqual(store.history(),history);
   }
   assert.deepEqual(new PolicyStore(db).rollback(1).config.workers.codex_worker.channels,['default_codex']);
  }finally{db.close();}
 }
});
test('unknown or malformed live worker bindings atomically roll schema14 back',()=>{
 for(const binding of ['missing','','["default_codex"]']) {
  const db=new DatabaseSync(':memory:');try {
   schema13(db);
   db.prepare('UPDATE policy_workers SET channel=? WHERE id=?').run(binding,'pi_worker');
   const workers=db.prepare('SELECT * FROM policy_workers').all();const revisions=db.prepare('SELECT * FROM policy_revisions').all();
   assert.throws(()=>migrate(db),/version 14 failed: Invalid historical worker channel/);
   assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version,13);
   assert.deepEqual(db.prepare('SELECT * FROM policy_workers').all(),workers);assert.deepEqual(db.prepare('SELECT * FROM policy_revisions').all(),revisions);
  }finally{db.close();}
 }
});

test('historical normalization is pure and rollback alone accepts old singleton fields',()=>{
 const config:any=defaultConfig();for(const w of Object.values(config.workers) as any[]){w.channel=w.channels[0];delete w.channels;}
 const before=JSON.stringify(config);assert.deepEqual(channels.normalizeHistoricalPolicy(config).config.workers.codex_worker.channels,['default_codex']);assert.equal(JSON.stringify(config),before);
 for(const failure of ['ambiguous','unknown']) {
  const invalid=structuredClone(config);
  if(failure==='ambiguous')invalid.workers.pi_worker.channels=['default_pi'];
  else invalid.workers.pi_worker.channel='missing';
  const blocks=[{engine:'codex',reason:'hold',since:'2026-01-01T00:00:00Z'}];const untouched=structuredClone({invalid,blocks});
  assert.throws(()=>channels.normalizeHistoricalPolicy(invalid,blocks));assert.deepEqual({invalid,blocks},untouched);
 }
 const db=new DatabaseSync(':memory:');try {
  const store=new PolicyStore(db);assert.throws(()=>store.save({revision:0,config,blocks:[]}),/channels/);
  store.save({revision:0,config:defaultConfig(),blocks:[]});
  db.prepare('UPDATE policy_revisions SET body=? WHERE revision=1').run(JSON.stringify({version:1,revision:1,config,blocks:[]}));
  assert.deepEqual(store.rollback(1).config.workers.codex_worker.channels,['default_codex']);
  config.workers.codex_worker.channels=['default_codex'];
  db.prepare('UPDATE policy_revisions SET body=? WHERE revision=1').run(JSON.stringify({version:1,revision:1,config,blocks:[]}));
  assert.throws(()=>store.rollback(1),/ambiguous/);assert.equal(store.snapshot().revision,2);
 }finally{db.close();}
});
