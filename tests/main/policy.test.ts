import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activeBlocks, availabilityOf } from '../../src/shared/policy/availability';
import { chatgptReviewEnabled, EFFORTS } from '../../src/shared/policy/settings';
import { defaultConfig, parseReleaseAt, resolveDispatch, validateConfig } from '../../src/main/policy/routing';
import { ENGINE_CATALOG } from '../../src/shared/engines';
import { effectiveWeight } from '../../src/shared/policy/weights';
import { type Config, type Block } from '../../src/shared/contracts/policy';
import { lintSchema, validate } from '../../src/main/policy/json-schema';
import { PolicyStore } from '../../src/main/policy/store';
import { DatabaseSync } from 'node:sqlite';
import { previewOn } from '../helpers/policy-preview';
const now=Date.parse('2026-10-18T12:00:00Z');
const preview=(store:PolicyStore,value:unknown)=>previewOn(store,value,now);
const all=()=>{const c=defaultConfig(); for(const e of Object.values(c.engines)) e.enabled=true; for(const w of Object.values(c.workers)) w.enabled=true; return c;};
const route=(c:Config,blocks:Block[]=[])=>resolveDispatch(c,blocks,{owner:'claude_owner'},{now,quotas:[]});
test('migrated defaults validate, clone, and default review stays true',()=>{
 const c=defaultConfig(); assert.deepEqual(validateConfig(c),[]); c.workers.claude_worker.model='changed'; assert.notEqual(defaultConfig().workers.claude_worker.model,'changed');
 assert.equal(chatgptReviewEnabled({}),true); assert.equal(chatgptReviewEnabled({chatgpt_review:false}),false);
});
test('schema rejects unsupported keywords and returns exact nested paths',()=>{
 assert.throws(()=>lintSchema({oneOf:[]}),/unsupported/);
 const c=defaultConfig() as any; c.engines.claude.extra=1; assert.deepEqual(validateConfig(c).map(i=>i.path),['$.engines.claude.extra']);
 assert.deepEqual(validate({type:'array',uniqueItems:true,items:{type:'integer',minimum:1}},[0,0]).map(i=>i.path),['$[1]','$[0]','$[1]']);
});
test('schema uses own keys and rejects prototype reference attacks',()=>{
 for(const key of ['constructor','toString','__proto__']) {
  const c={...defaultConfig(),...JSON.parse(`{"${key}":1}`)}; assert.ok(validateConfig(c).some(i=>i.path===`$.${key}`));
  assert.throws(()=>validate({$ref:`#/$defs/${key}`,$defs:{}},'x'),/unresolved/);
 }
 const c=defaultConfig(); c.owners.claude_owner.channel='constructor'; assert.ok(validateConfig(c).some(i=>i.message.includes('Unknown channel')));
 assert.throws(()=>resolveDispatch(defaultConfig(),[],{owner:'constructor'}),/unknown owner/);
});
test('effort, worker references, parallel limits and unique enabled owners validated',()=>{
 for(const effort of EFFORTS.codex) {const c=defaultConfig();c.workers.codex_worker.effort=effort;assert.deepEqual(validateConfig(c),[]);}
 const c=defaultConfig(); c.workers.codex_worker.effort='invalid'; c.owners.claude_owner.workers=['missing_worker'];c.owners.claude_owner.max_parallel=0;
 assert.ok(validateConfig(c).some(i=>i.path.endsWith('max_parallel')));
 c.owners.claude_owner.max_parallel=1; const issues=validateConfig(c);assert.ok(issues.some(i=>i.path.endsWith('.effort')));assert.ok(issues.some(i=>i.message.includes('unknown worker')));
 const duplicate=defaultConfig();duplicate.owners.other={...duplicate.owners.claude_owner};assert.ok(validateConfig(duplicate).some(i=>i.message.includes('already has enabled owner')));
});
test('engine/model quota precedence, expiration and indefinite blocks',()=>{
 const blocks:Block[]=[{engine:'grok',reason:'quota',since:new Date(now).toISOString(),release_at:new Date(now+1000).toISOString()},{engine:'opencode',model:'different',reason:'quota',since:new Date(now).toISOString()}];
 const c=all();c.owners.claude_owner.workers=['grok_worker','opencode_worker'];assert.equal(route(c,blocks).worker,'opencode_worker');
 assert.equal(activeBlocks({version:1,blocks},now).length,2);assert.equal(activeBlocks({version:1,blocks},now+1000).length,1);
 assert.equal(availabilityOf(c,[{...blocks[0],engine:'claude'}],c.owners.claude_owner).status,'blocked');
 assert.throws(()=>route(c,[{...blocks[0],engine:'claude'}]),/owner.*unavailable/);
});
test('no available worker errors include candidate diagnostics',()=>{
 const c=all(); for(const w of Object.values(c.workers)) w.enabled=false;assert.throws(()=>route(c),/no available worker/);
});
test('release times accept timezone/relative forms and reject invalid or overflow',()=>{
 assert.equal(parseReleaseAt('+2h',now),'2026-10-18T14:00:00.000Z');assert.equal(parseReleaseAt('2026-10-18T14:00:00+02:00',now),'2026-10-18T14:00:00+02:00');
 for(const value of ['tomorrow','+0m','2026-10-18T14:00:00','+999999999999999999999999d']) assert.throws(()=>parseReleaseAt(value,now));
});
function fixture(fn:(store:PolicyStore,path:string)=>void) {const root=mkdtempSync(join(tmpdir(),'weaver-policy-'));try{const path=join(root,'weaver.db');fn(new PolicyStore(path,()=>now),path);}finally{rmSync(root,{recursive:true,force:true});}}
/** The thrown message, so a caller can assert on its exact prefix. */
function grab(fn:()=>unknown):string {try{fn();}catch(error){return error instanceof Error?error.message:'thrown';}throw new Error('expected a throw');}
test('app settings roundtrip without reading upstream/home, stale writes fail',()=>fixture((store,path)=>{
 const s=store.snapshot();s.config.chatgpt_review=false; const next=store.save({revision:s.revision,config:s.config,blocks:[]});assert.equal(next.revision,1);
 assert.deepEqual(new PolicyStore(path,()=>now).snapshot(),next);assert.equal(preview(store,{owner:'claude_owner'}).chatgptReview,false);
 assert.throws(()=>store.save({revision:0,config:s.config,blocks:[]}),/reload/);assert.equal(store.snapshot().revision,1);
}));
test('block edits persist, expired blocks are ignored at preview time, deletion unblocks',()=>fixture((store)=>{
 const s=store.snapshot();const blocks=[{engine:'claude',reason:'manual',since:new Date(now).toISOString()}];
 store.save({revision:0,config:s.config,blocks});assert.throws(()=>preview(store,{owner:'claude_owner'}),/unavailable/);
 store.save({revision:1,config:s.config,blocks:blocks.map(b=>({...b,release_at:new Date(now).toISOString()}))});assert.equal(store.snapshot().activeBlocks.length,0);assert.equal(preview(store,{owner:'claude_owner'}).worker,'claude_worker');
 store.save({revision:2,config:s.config,blocks:[]});assert.equal(store.snapshot().blocks.length,0);
}));
test('invalid quota edits preserve stored and in-memory state',()=>fixture((store)=>{
 const s=store.snapshot();store.save({revision:0,config:s.config,blocks:[]}); const before=JSON.stringify(store.history());
 for(const blocks of [[{engine:'unknown',reason:'x',since:new Date(now).toISOString()}],[{engine:'claude',reason:'',since:'bad'}],[{engine:'claude',reason:'x',since:'+1h'}],[{engine:'claude',reason:'x',since:new Date(now).toISOString(),release_at:'+2h'}]]) assert.throws(()=>store.save({revision:1,config:s.config,blocks}));
 assert.equal(JSON.stringify(store.history()),before,'a refused save leaves no revision row');assert.equal(store.snapshot().revision,1);
}));
test('duplicate blocks and unknown IPC fields rejected',()=>fixture((store)=>{
 const s=store.snapshot();const b={engine:'claude',reason:'x',since:new Date(now).toISOString()};assert.throws(()=>store.save({revision:0,config:s.config,blocks:[b,b]}),/Duplicate/);
 assert.throws(()=>preview(store,{owner:'claude_owner',argv:['unsafe']}),/Unknown/);
}));
test('capacity is hypothetical preview only, never execution permission',()=>fixture((store)=>{
 const r=preview(store,{owner:'claude_owner',runningCount:4});assert.equal(r.capacityAvailable,false);assert.equal(r.execution,'disabled');
 assert.equal(preview(store,{owner:'claude_owner',runningCount:3}).capacityAvailable,true);
 assert.throws(()=>preview(store,{owner:'claude_owner',runningCount:-1}),/Invalid/);
}));
test('a saved policy with a gemini engine fails with the ordinary schema error',()=>fixture((store)=>{
 const config=defaultConfig() as any; config.engines.gemini={enabled:true,kind:'gemini'};
 assert.deepEqual(validateConfig(config).map(i=>i.path),['$.engines.gemini.kind']);
 assert.throws(()=>store.save({revision:0,config,blocks:[]}),/\$\.engines\.gemini\.kind: must be one of/);
 assert.deepEqual(store.history(),[]);
}));
test('disabled pi template validates and stays out of claude routing',()=>{
 const c=defaultConfig(); assert.deepEqual(validateConfig(c),[]);
 assert.equal(c.engines.pi?.enabled,true); assert.equal(c.engines.pi?.kind,'pi');
 assert.equal(c.workers.pi_worker?.enabled,false); assert.equal(c.workers.pi_worker?.model,'glm-5.3-flash'); assert.equal(c.owners.pi_owner?.enabled,false); assert.deepEqual(EFFORTS.pi,['off','minimal','low','medium','high','xhigh','max']);
 for (const effort of EFFORTS.pi) { const sample=defaultConfig(); sample.workers.pi_worker.effort=effort; sample.owners.pi_owner.effort=effort; assert.deepEqual(validateConfig(sample),[]); }
 const badEffort=defaultConfig(); badEffort.workers.pi_worker.effort='ultra'; assert.ok(validateConfig(badEffort).some(issue=>issue.path.includes('pi_worker')&&issue.message.includes('effort')));
 assert.equal(c.owners.claude_owner.workers.includes('pi_worker'),false);
 const open=defaultConfig(); open.engines.opencode.enabled=true; open.workers.opencode_worker.enabled=true;
 open.owners.opencode_owner={enabled:true,channel:'default_opencode',model:'opencode/glm-5.3-flash-free',effort:'max',workers:['opencode_worker'],max_parallel:1};
 assert.deepEqual(validateConfig(open),[]);
 assert.equal(route(all()).worker,'claude_worker'); assert.equal(route(all()).weight,5);
});
test('the highest-weight available worker wins; equal weights keep list order',()=>{
 const c=all(); assert.equal(route(c).worker,'claude_worker');
 c.owners.claude_owner.worker_weights={grok_worker:9,opencode_worker:6};
 const r=route(c); assert.equal(r.worker,'grok_worker'); assert.equal(r.weight,9); assert.equal(r.selected_by,'weight');
 c.workers.grok_worker.enabled=false; const next=route(c);
 assert.equal(next.worker,'opencode_worker'); assert.deepEqual(next.skipped,[{worker:'grok_worker',reason:'disabled'}]);
 c.owners.claude_owner.worker_weights={claude_worker:0,qoder_worker:10,opencode_worker:10,grok_worker:10};
 assert.equal(route(c).worker,'qoder_worker');
});
test('weight 0 never dispatches, even when named explicitly; an explicit worker may sit outside the list',()=>{
 const c=all(); c.owners.claude_owner.worker_weights={claude_worker:0,qoder_worker:0,opencode_worker:0,grok_worker:0};
 assert.deepEqual(validateConfig(c),[]); assert.throws(()=>route(c),/no available worker/); assert.throws(()=>route(c),/priority weight 0/);
 assert.throws(()=>resolveDispatch(c,[],{owner:'claude_owner',worker:'claude_worker'}),/priority weight 0/);
 const outside=resolveDispatch(defaultConfig(),[],{owner:'claude_owner',worker:'codex_worker'}); assert.equal(outside.worker,'codex_worker'); assert.equal(outside.selected_by,'worker'); assert.ok(outside.warnings.length);
});
test('invalid weights are rejected',()=>{
 const missing=defaultConfig(); missing.owners.claude_owner.worker_weights={missing_worker:10}; assert.ok(validateConfig(missing).some(issue=>issue.message.includes("not in this owner's workers")));
 const high=defaultConfig(); high.owners.claude_owner.worker_weights={claude_worker:11}; assert.ok(validateConfig(high).some(issue=>issue.message.includes('0 to 10')));
 const fraction=defaultConfig(); fraction.owners.claude_owner.worker_weights={claude_worker:1.5}; assert.ok(validateConfig(fraction).length);
});
test('rolling back to a stored revision that still carries retired tags and engine pins drops them',()=>fixture((store)=>{
 const saved=store.save({revision:0,config:defaultConfig(),blocks:[]});assert.equal(saved.revision,1);
 // Revision bodies written by older versions are database content: put the retired fields back into the stored snapshot.
 const row=(store as any).db.prepare('SELECT body FROM policy_revisions WHERE revision=1').get() as {body:string};
 const body=JSON.parse(row.body); body.config.workers.claude_worker.tags=['frontend']; body.config.owners.claude_owner.only_engine='codex'; body.config.engines.claude.native_subagents=true;
 (store as any).db.prepare('UPDATE policy_revisions SET body=? WHERE revision=1').run(JSON.stringify(body));
 const loaded=store.rollback(1);
 assert.equal('tags' in loaded.config.workers.claude_worker,false); assert.equal('only_engine' in loaded.config.owners.claude_owner,false); assert.equal('native_subagents' in loaded.config.engines.claude,false);
 assert.equal(loaded.revision,2);
}));
test('weights balance load: the lowest (running + 1) / weight wins, ties go to the higher weight then list order',()=>{
 const c=all(); c.owners.claude_owner.worker_weights={claude_worker:0,qoder_worker:5,opencode_worker:10,grok_worker:0};
 const pick=(load:Record<string,number>)=>resolveDispatch(c,[],{owner:'claude_owner',workerLoad:load}).worker;
 assert.equal(pick({}),'opencode_worker');
 // 2/10 ties 1/5: the higher weight takes it.
 assert.equal(pick({opencode_worker:1}),'opencode_worker');
 assert.equal(pick({opencode_worker:2}),'qoder_worker');
 assert.equal(pick({opencode_worker:3,qoder_worker:1}),'opencode_worker');
 assert.equal(pick({opencode_worker:4,qoder_worker:1}),'qoder_worker');
 // Six dispatches in a row split 2:1 by weight.
 const load:Record<string,number>={};
 for(let i=0;i<6;i++){const w=pick(load);load[w]=(load[w]??0)+1;}
 assert.deepEqual(load,{opencode_worker:4,qoder_worker:2});
 // Equal weights spread one by one in list order.
 c.owners.claude_owner.worker_weights={claude_worker:0,qoder_worker:10,opencode_worker:10,grok_worker:0};
 assert.equal(pick({}),'qoder_worker'); assert.equal(pick({qoder_worker:1}),'opencode_worker');
 // An explicit worker ignores load; weight 0 still never dispatches.
 assert.equal(resolveDispatch(c,[],{owner:'claude_owner',worker:'opencode_worker',workerLoad:{opencode_worker:9}}).worker,'opencode_worker');
 assert.equal(pick({qoder_worker:5,opencode_worker:5}),'qoder_worker');
});
test('preview reports each candidate load and score',()=>{
 const c=all(); c.owners.claude_owner.worker_weights={claude_worker:0,qoder_worker:5,opencode_worker:10,grok_worker:0};
 const r=resolveDispatch(c,[],{owner:'claude_owner',workerLoad:{opencode_worker:2}});
 assert.equal(r.worker,'qoder_worker');
 assert.deepEqual(r.candidates,[{worker:'qoder_worker',weight:5,running:0},{worker:'opencode_worker',weight:10,running:2}]);
 assert.deepEqual(r.skipped,[{worker:'claude_worker',reason:'priority weight 0'},{worker:'grok_worker',reason:'priority weight 0'}]);
});
test('excluded engines are skipped with their reason and load balancing still works',()=>{
 const c=all(); const pick=(excludeEngines:string[])=>resolveDispatch(c,[],{owner:'claude_owner',excludeEngines});
 assert.equal(pick([]).worker,'claude_worker'); assert.equal(pick(['pi']).worker,'claude_worker');
 const moved=pick(['claude']);
 assert.equal(moved.worker,'qoder_worker');
 assert.deepEqual(moved.skipped,[{worker:'claude_worker',reason:'failed earlier in this retry chain'}]);
 assert.deepEqual(moved.candidates,[{worker:'qoder_worker',weight:5,running:0},{worker:'opencode_worker',weight:5,running:0},{worker:'grok_worker',weight:5,running:0}]);
 // The excluded engine is out of the balancing, the rest keeps its weighted order.
 assert.equal(resolveDispatch(c,[],{owner:'claude_owner',excludeEngines:['claude'],workerLoad:{qoder_worker:5}}).worker,'opencode_worker');
 // Weight 0 is reported before exclusion: it was never a candidate at all.
 const weighted=all(); weighted.owners.claude_owner.worker_weights={claude_worker:0,qoder_worker:10,opencode_worker:10,grok_worker:10};
 assert.deepEqual(resolveDispatch(weighted,[],{owner:'claude_owner',excludeEngines:['claude']}).skipped,[{worker:'claude_worker',reason:'priority weight 0'}]);
});
test('excluded workers are skipped by ID and a sibling on the same engine can take over',()=>{
 const c=all(); c.owners.claude_owner.worker_weights={claude_worker:10,qoder_worker:8,opencode_worker:6,grok_worker:4};
 const moved=resolveDispatch(c,[],{owner:'claude_owner',excludeWorkers:['claude_worker']});
 assert.equal(moved.worker,'qoder_worker');
 assert.deepEqual(moved.skipped![0],{worker:'claude_worker',reason:'excluded for this dispatch'});
 const same=structuredClone(c);
 same.workers.claude_alt_worker={enabled:true,channels:['default_claude'],model:'sonnet',effort:'high'};
 same.owners.claude_owner.workers=['claude_worker','claude_alt_worker'];
 same.owners.claude_owner.worker_weights={claude_worker:10,claude_alt_worker:8};
 const sibling=resolveDispatch(same,[],{owner:'claude_owner',excludeWorkers:['claude_worker']});
 assert.equal(sibling.worker,'claude_alt_worker');
 assert.equal(sibling.engine,'claude','excluding a worker does not exclude its engine');
 const named=grab(()=>resolveDispatch(c,[],{owner:'claude_owner',worker:'claude_worker',excludeWorkers:['claude_worker']}));
 assert.ok(named.startsWith('NO_ALTERNATIVE_WORKER'),named);
 assert.match(named,/claude_worker/);
 const closed=grab(()=>resolveDispatch(c,[],{owner:'claude_owner',excludeWorkers:['claude_worker','qoder_worker','opencode_worker','grok_worker']}));
 assert.ok(closed.startsWith('NO_ALTERNATIVE_WORKER'),closed);
 for(const worker of ['claude_worker','qoder_worker','opencode_worker','grok_worker'])assert.ok(closed.includes(worker),worker);
});
test('an explicit worker on an excluded engine and an exhausted chain both refuse to dispatch',()=>{
 const c=all();
 const named=grab(()=>resolveDispatch(c,[],{owner:'claude_owner',worker:'claude_worker',excludeEngines:['claude']}));
 assert.ok(named.startsWith('NO_ALTERNATIVE_ENGINE'),named);
 assert.match(named,/failed earlier in this retry chain/); assert.match(named,/claude_worker/); assert.match(named,/claude/);
 const closed=grab(()=>resolveDispatch(c,[],{owner:'claude_owner',excludeEngines:['claude','qoder','opencode','grok']}));
 assert.ok(closed.startsWith('NO_ALTERNATIVE_ENGINE'),closed);
 assert.match(closed,/failed earlier in this retry chain/);
 for(const engine of ['claude','qoder','opencode','grok'])assert.ok(closed.includes(engine),engine);
 // Nothing available is still the ordinary availability error, not an engine exclusion.
 const none=all(); for(const w of Object.values(none.workers)) w.enabled=false;
 assert.throws(()=>resolveDispatch(none,[],{owner:'claude_owner',excludeEngines:['claude']}),/no available worker/);
});
test('preview takes excluded engines and rejects a malformed list',()=>fixture((store)=>{
 const s=store.snapshot(); s.config.engines.opencode.enabled=true; s.config.workers.opencode_worker.enabled=true;
 store.save({revision:s.revision,config:s.config,blocks:[]},{allowEngineEnable:true});
 assert.equal(preview(store,{owner:'claude_owner'}).worker,'claude_worker');
 assert.equal(preview(store,{owner:'claude_owner',excludeEngines:['claude']}).worker,'opencode_worker');
 assert.ok(grab(()=>preview(store,{owner:'claude_owner',excludeEngines:['claude','opencode']})).startsWith('NO_ALTERNATIVE_ENGINE'));
 for(const bad of ['claude',[1],Array(51).fill('claude'),['']]) assert.throws(()=>preview(store,{owner:'claude_owner',excludeEngines:bad}),/excluded engine/);
 assert.equal(preview(store,{owner:'claude_owner',excludeEngines:[]}).worker,'claude_worker');
 assert.equal(preview(store,{owner:'claude_owner',excludeWorkers:['claude_worker']}).worker,'opencode_worker');
 assert.ok(grab(()=>preview(store,{owner:'claude_owner',excludeWorkers:['claude_worker','opencode_worker']})).startsWith('NO_ALTERNATIVE_WORKER'));
 for(const bad of ['claude_worker',[1],Array(201).fill('claude_worker'),['']]) assert.throws(()=>preview(store,{owner:'claude_owner',excludeWorkers:bad}),/excluded worker/);
 assert.equal(preview(store,{owner:'claude_owner',excludeWorkers:[]}).worker,'claude_worker');
 assert.throws(()=>preview(store,{owner:'claude_owner',excludeEngines:['claude'],argv:['unsafe']}),/Unknown/);
}));
test('omitted weight is 5 and weights above 10 are rejected',()=>{
 const c=all(); const owner=c.owners.claude_owner; owner.worker_weights={claude_worker:0};
 assert.equal(effectiveWeight(owner,'qoder_worker'),5); assert.equal(effectiveWeight(owner,'claude_worker'),0);
 owner.worker_weights={claude_worker:10}; assert.deepEqual(validateConfig(c),[]);
 owner.worker_weights={claude_worker:11}; assert.ok(validateConfig(c).some(i=>i.message==='weight must be an integer from 0 to 10'));
 owner.worker_weights={claude_worker:-1}; assert.ok(validateConfig(c).length);
});
test('policy keeps per-table rows: engines, owners, ordered worker links with weights, workers, settings and blocks',()=>{
 const db=new DatabaseSync(':memory:');const store=new PolicyStore(db,()=>now);
 const s=store.snapshot();const config=structuredClone(s.config);config.owners.claude_owner.worker_weights={qoder_worker:3,claude_worker:7};config.display={timezone:'Asia/Shanghai'};
 const blocks=[{engine:'claude',model:'m',reason:'manual',since:new Date(now).toISOString(),by:'tester'}];
 store.save({revision:0,config,blocks});
 const count=(table:string)=>Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n);
 assert.equal(count('policy_engines'),Object.keys(config.engines).length);assert.equal(count('policy_owners'),Object.keys(config.owners).length);assert.equal(count('policy_workers'),Object.keys(config.workers).length);
 assert.equal(count('policy_blocks'),1);assert.equal(count('policy_revisions'),1);
 const links=db.prepare("SELECT worker_id,position,weight FROM policy_owner_workers WHERE owner_id='claude_owner' ORDER BY position").all() as {worker_id:string;position:number;weight:number|null}[];
 assert.deepEqual(links.map(row=>row.worker_id),config.owners.claude_owner.workers,'list order is the position column');
 assert.deepEqual(Object.fromEntries(links.filter(row=>row.weight!==null).map(row=>[row.worker_id,row.weight])),{qoder_worker:3,claude_worker:7});
 const settings=(db.prepare('SELECT key FROM policy_settings ORDER BY key').all() as {key:string}[]).map(row=>row.key);
 assert.ok(settings.includes('herdr')&&settings.includes('display'));
 assert.deepEqual(new PolicyStore(db,()=>now).snapshot().config,store.snapshot().config,'a reopen reads the same document back');
 assert.deepEqual(new PolicyStore(db,()=>now).snapshot().blocks,blocks);
});
test('role order is written as position and survives reopening the database',()=>{
 const db=new DatabaseSync(':memory:');const store=new PolicyStore(db,()=>now);
 const before=store.snapshot();const config=structuredClone(before.config);
 const reverse=<T>(record:Record<string,T>):Record<string,T>=>Object.fromEntries(Object.entries(record).reverse());
 config.owners=reverse(config.owners);config.workers=reverse(config.workers);
 store.save({revision:before.revision,config,blocks:[]});
 const reopened=new PolicyStore(db,()=>now).snapshot().config;
 assert.deepEqual(Object.keys(reopened.owners),Object.keys(config.owners));
 assert.deepEqual(Object.keys(reopened.workers),Object.keys(config.workers));
 assert.deepEqual(reopened.owners.claude_owner.workers,before.config.owners.claude_owner.workers);
 assert.deepEqual(reopened.owners.claude_owner.worker_weights,before.config.owners.claude_owner.worker_weights);
 assert.deepEqual(reopened.workers,config.workers);
 const ownerPositions=(db.prepare('SELECT id FROM policy_owners ORDER BY position').all() as {id:string}[]).map(row=>row.id);
 const workerPositions=(db.prepare('SELECT id FROM policy_workers ORDER BY position').all() as {id:string}[]).map(row=>row.id);
 assert.deepEqual(ownerPositions,Object.keys(config.owners));
 assert.deepEqual(workerPositions,Object.keys(config.workers));
});
test('worker ids use the shared id rule: suffix optional, characters and length still checked',()=>{
 const accepted=defaultConfig();
 accepted.workers.research={...accepted.workers.claude_worker!};
 accepted.workers['a'.repeat(40)]={...accepted.workers.claude_worker!};
 accepted.owners.research={...accepted.owners.claude_owner!,enabled:false};
 accepted.owners.claude_owner.workers=[...accepted.owners.claude_owner.workers,'research'];
 accepted.owners.claude_owner.worker_weights={research:8};
 assert.deepEqual(validateConfig(accepted),[]);
 for(const id of ['Research','research-worker','a'.repeat(41)]){
  const bad=defaultConfig();bad.workers[id]={...bad.workers.claude_worker!};
  const issues=validateConfig(bad);
  assert.ok(issues.some(issue=>issue.path.includes('workers')&&issue.message.includes('property name')),id);
 }
});
test('every save records a revision and rollback restores one as a new revision; conflicts still refuse',()=>{
 let clock=now;const store=new PolicyStore(new DatabaseSync(':memory:'),()=>clock);
 const base=store.snapshot();assert.equal(base.revision,0);assert.deepEqual(store.history(),[]);
 const first=structuredClone(base.config);first.chatgpt_review=false;
 clock=now+1000;const one=store.save({revision:0,config:first,blocks:[]});
 const second=structuredClone(one.config);second.herdr.max_wait_minutes=7;
 clock=now+2000;const two=store.save({revision:1,config:second,blocks:[{engine:'claude',reason:'manual',since:new Date(now).toISOString()}]});
 assert.deepEqual(store.history(),[{revision:2,savedAt:new Date(now+2000).toISOString(),source:'save'},{revision:1,savedAt:new Date(now+1000).toISOString(),source:'save'}]);
 assert.throws(()=>store.save({revision:1,config:second,blocks:[]}),/reload/,'a stale revision conflicts');
 assert.throws(()=>store.rollback(9),/not found/);assert.throws(()=>store.rollback(0),/Invalid/);
 clock=now+3000;const back=store.rollback(1);
 assert.equal(back.revision,3);assert.equal(back.config.herdr.max_wait_minutes,one.config.herdr.max_wait_minutes);assert.equal(back.config.chatgpt_review,false);assert.deepEqual(back.blocks,[]);
 assert.deepEqual(store.history().map(item=>[item.revision,item.source]),[[3,'rollback:1'],[2,'save'],[1,'save']],'the rollback is itself a new revision and nothing was rewritten');
 assert.equal(two.revision,2);
});
test('display.timezone accepts an IANA name or nothing, and a bad name is a field-level error',()=>fixture((store)=>{
 assert.equal(defaultConfig().display,undefined,'the default is unset: follow the browser');
 const s=store.snapshot();const config=structuredClone(s.config);
 config.display={timezone:'Asia/Shanghai'};assert.deepEqual(validateConfig(config),[]);
 assert.equal(store.save({revision:0,config,blocks:[]}).config.display?.timezone,'Asia/Shanghai');
 for(const bad of ['Mars/Olympus','not a zone','UTC+8 ']){config.display={timezone:bad};assert.deepEqual(validateConfig(config).map(i=>i.path),['$.display.timezone'],bad);assert.throws(()=>store.save({revision:1,config,blocks:[]}),/\$\.display\.timezone/);}
 config.display={timezone:7} as any;assert.ok(validateConfig(config).some(i=>i.path==='$.display.timezone'));
 config.display={timezone:''};assert.deepEqual(validateConfig(config),[],'an empty value follows the browser');
 config.display={zone:'x'} as any;assert.ok(validateConfig(config).some(i=>i.path==='$.display.zone'));
 assert.equal(store.snapshot().config.display?.timezone,'Asia/Shanghai','refused saves changed nothing');
}));
test('policy save rejects weights above 10',()=>fixture((store)=>{
 const s=store.snapshot(); s.config.owners.claude_owner.worker_weights={claude_worker:100};
 assert.throws(()=>store.save({revision:s.revision,config:s.config,blocks:[]}),/0 to 10/);
}));


test('max_command_minutes: default 30, optional for older policies, and bounded 1–1440',()=>fixture((store)=>{
 assert.equal(defaultConfig().herdr.max_command_minutes,30);
 const config=defaultConfig();
 assert.deepEqual(validateConfig(config),[]);
 delete (config.herdr as {max_command_minutes?:number}).max_command_minutes;
 assert.deepEqual(validateConfig(config),[],'older policy without the key stays valid');
 const saved=store.save({revision:0,config,blocks:[]});
 assert.equal(saved.config.herdr.max_command_minutes,30,'the snapshot reports the effective default');
 for(const value of [1,1440]){const c=defaultConfig();c.herdr.max_command_minutes=value;assert.deepEqual(validateConfig(c),[],String(value));}
 for(const value of [0,1441,1.5]){const c=defaultConfig();c.herdr.max_command_minutes=value;assert.ok(validateConfig(c).some(issue=>issue.path==='$.herdr.max_command_minutes'),String(value));}
}));


test('historical SQL engine flags never gate routes, while accounts, roles and blocks still do',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  const initial=new PolicyStore(db,()=>now);
  const seed=initial.snapshot();
  const blocks:Block[]=[{engine:'codex',reason:'quota exhausted',since:new Date(now).toISOString(),by:'weaver-quota-codex'},
   {engine:'grok',reason:'stall penalty',since:new Date(now).toISOString(),by:'weaver-stall',release_at:new Date(now+60_000).toISOString()}];
  initial.save({revision:0,config:seed.config,blocks});
  db.exec("UPDATE policy_engines SET enabled=0; DELETE FROM policy_engines WHERE id='qoder'; INSERT INTO policy_engines(id,position,enabled,kind) VALUES ('personal',99,0,'codex')");
  const store=new PolicyStore(db,()=>now);
  const loaded=store.snapshot();
  assert.ok(Object.values(loaded.config.engines).every(engine=>engine.enabled));
  assert.equal(route(loaded.config,loaded.activeBlocks).worker,'claude_worker');
  assert.deepEqual(loaded.config.engines.personal,{enabled:true,kind:'codex'});
  assert.equal(loaded.config.engines.qoder.kind,ENGINE_CATALOG.find(entry=>entry.id==='qoder')!.kind);
  assert.deepEqual(loaded.blocks,blocks);
  assert.throws(()=>resolveDispatch(loaded.config,loaded.activeBlocks,{owner:'codex_owner'}),/blocked.*quota exhausted/);
  loaded.config.workers.grok_worker.enabled=true;
  assert.equal(availabilityOf(loaded.config,loaded.activeBlocks,loaded.config.workers.grok_worker,'grok_worker').status,'blocked');
  loaded.config.channels.default_claude.enabled=false;
  assert.throws(()=>route(loaded.config,loaded.activeBlocks),/channel_disabled/);
  loaded.config.channels.default_claude.enabled=true;
  loaded.config.owners.claude_owner.enabled=false;
  assert.throws(()=>route(loaded.config,loaded.activeBlocks),/unavailable: disabled/);
  assert.ok((db.prepare('SELECT enabled FROM policy_engines').all() as {enabled:number}[]).every(row=>row.enabled===0),'reads do not rewrite historical storage');
 } finally { db.close(); }
});

test('historical rollback normalizes the catalog, preserves aliases and keeps account and block restrictions',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  const store=new PolicyStore(db,()=>now);
  const snapshot=store.save({revision:0,config:defaultConfig(),blocks:[]});
  const historic=structuredClone(snapshot);
  for(const engine of Object.values(historic.config.engines))engine.enabled=false;
  historic.config.engines.personal={enabled:false,kind:'codex'};
  delete historic.config.engines.qoder;
  historic.config.channels.default_codex.enabled=false;
  const blocks=[{engine:'grok',reason:'stall',since:new Date(now).toISOString(),by:'weaver-stall'}];
  db.prepare('UPDATE policy_revisions SET body=? WHERE revision=1').run(JSON.stringify({version:1,revision:1,config:historic.config,blocks}));
  const restored=store.rollback(1);
  assert.equal(route(restored.config,restored.activeBlocks).worker,'claude_worker');
  assert.deepEqual(restored.config.engines.personal,{enabled:true,kind:'codex'});
  for(const entry of ENGINE_CATALOG)assert.ok(restored.config.engines[entry.id]?.enabled,entry.id);
  assert.equal(restored.config.channels.default_codex.enabled,false);
  assert.deepEqual(restored.blocks,blocks);
  assert.throws(()=>resolveDispatch(restored.config,restored.activeBlocks,{owner:'codex_owner'}),/channel_disabled/);
  const next=store.save({revision:restored.revision,config:restored.config,blocks:restored.blocks});
  assert.deepEqual(new PolicyStore(db,()=>now).snapshot(),next);
  assert.ok((db.prepare('SELECT enabled FROM policy_engines').all() as {enabled:number}[]).every(row=>row.enabled===1));
 } finally { db.close(); }
});

test('fresh defaults cover the catalog and new saves report attempts to disable engines',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  const store=new PolicyStore(db,()=>now);
  const fresh=store.snapshot();
  for(const entry of ENGINE_CATALOG)assert.deepEqual(fresh.config.engines[entry.id],{enabled:true,kind:entry.kind});
  fresh.config.engines.claude.enabled=false;
  assert.throws(()=>store.save({revision:0,config:fresh.config,blocks:[]}),/Engines are always available.*channel/i);
  assert.equal(store.snapshot().revision,0);
  const sparse=store.snapshot().config;
  delete sparse.engines.qoder;
  const saved=store.save({revision:0,config:sparse,blocks:[]});
  assert.equal(saved.config.engines.qoder.kind,ENGINE_CATALOG.find(entry=>entry.id==='qoder')!.kind);
 } finally { db.close(); }
});


test('pre-channel JSON history restores through the same catalog normalization without reviving engine switches',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  const store=new PolicyStore(db,()=>now);
  const current=store.save({revision:0,config:defaultConfig(),blocks:[]});
  const legacy:Record<string,any>=structuredClone(current.config);
  for(const engine of Object.values(legacy.engines) as any[])engine.enabled=false;
  for(const worker of Object.values(legacy.workers) as any[]) {worker.channel=worker.channels[0];delete worker.channels;}
  for(const role of [...Object.values(legacy.owners),...Object.values(legacy.workers)] as any[]) {
   role.engine=legacy.channels[role.channel].engine;delete role.channel;
  }
  delete legacy.channels;
  const blocks=[{engine:'codex',reason:'manual quota',since:new Date(now).toISOString(),by:'person'}];
  db.prepare('UPDATE policy_revisions SET body=? WHERE revision=1').run(JSON.stringify({version:1,revision:1,config:legacy,blocks}));
  const restored=store.rollback(1);
  assert.equal(route(restored.config,restored.activeBlocks).worker,'claude_worker');
  assert.ok(Object.values(restored.config.engines).every(engine=>engine.enabled));
  assert.equal(restored.config.workers.pi_worker.enabled,false);
  assert.equal(restored.config.owners.pi_owner.enabled,false);
  assert.deepEqual(restored.blocks,blocks);
  assert.throws(()=>resolveDispatch(restored.config,restored.activeBlocks,{owner:'codex_owner'}),/blocked/);
 } finally { db.close(); }
});
