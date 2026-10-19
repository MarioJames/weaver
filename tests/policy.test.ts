import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activeBlocks, availabilityOf, chatgptReviewEnabled, defaultConfig, EFFORTS, parseReleaseAt, resolveDispatch, validateConfig, type Config, type Block } from '../src/main/policy/routing';
import { lintSchema, validate } from '../src/main/policy/json-schema';
import { PolicyStore } from '../src/main/policy/store';
const now=Date.parse('2026-10-18T12:00:00Z');
const all=()=>{const c=defaultConfig(); for(const e of Object.values(c.engines)) e.enabled=true; for(const w of Object.values(c.workers)) w.enabled=true; return c;};
const route=(c:Config,blocks:Block[]=[])=>resolveDispatch(c,blocks,{owner:'claude_owner'});
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
 const c=defaultConfig(); c.owners.claude_owner.engine='constructor'; assert.ok(validateConfig(c).some(i=>i.message.includes('unknown engine')));
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
function fixture(fn:(store:PolicyStore,path:string)=>void) {const root=mkdtempSync(join(tmpdir(),'weaver-policy-'));try{const path=join(root,'policy.json');fn(new PolicyStore(path,()=>now),path);}finally{rmSync(root,{recursive:true,force:true});}}
/** The thrown message, so a caller can assert on its exact prefix. */
function grab(fn:()=>unknown):string {try{fn();}catch(error){return error instanceof Error?error.message:'thrown';}throw new Error('expected a throw');}
test('app settings roundtrip without reading upstream/home, stale writes fail',()=>fixture((store,path)=>{
 const s=store.snapshot();s.config.chatgpt_review=false; const next=store.save({revision:s.revision,config:s.config,blocks:[]});assert.equal(next.revision,1);
 assert.deepEqual(new PolicyStore(path,()=>now).snapshot(),next);assert.equal(store.preview({owner:'claude_owner'}).chatgptReview,false);
 assert.throws(()=>store.save({revision:0,config:s.config,blocks:[]}),/reload/);assert.equal(store.snapshot().revision,1);
}));
test('block edits persist, expired blocks are ignored at preview time, deletion unblocks',()=>fixture((store)=>{
 const s=store.snapshot();const blocks=[{engine:'claude',reason:'manual',since:new Date(now).toISOString()}];
 store.save({revision:0,config:s.config,blocks});assert.throws(()=>store.preview({owner:'claude_owner'}),/unavailable/);
 store.save({revision:1,config:s.config,blocks:blocks.map(b=>({...b,release_at:new Date(now).toISOString()}))});assert.equal(store.snapshot().activeBlocks.length,0);assert.equal(store.preview({owner:'claude_owner'}).worker,'claude_worker');
 store.save({revision:2,config:s.config,blocks:[]});assert.equal(store.snapshot().blocks.length,0);
}));
test('invalid quota edits preserve disk and in-memory state',()=>fixture((store,path)=>{
 const s=store.snapshot();store.save({revision:0,config:s.config,blocks:[]}); const before=readFileSync(path,'utf8');
 for(const blocks of [[{engine:'unknown',reason:'x',since:new Date(now).toISOString()}],[{engine:'claude',reason:'',since:'bad'}],[{engine:'claude',reason:'x',since:'+1h'}],[{engine:'claude',reason:'x',since:new Date(now).toISOString(),release_at:'+2h'}]]) assert.throws(()=>store.save({revision:1,config:s.config,blocks}));
 assert.equal(readFileSync(path,'utf8'),before);assert.equal(store.snapshot().revision,1);
}));
test('duplicate blocks and unknown IPC fields rejected',()=>fixture((store)=>{
 const s=store.snapshot();const b={engine:'claude',reason:'x',since:new Date(now).toISOString()};assert.throws(()=>store.save({revision:0,config:s.config,blocks:[b,b]}),/Duplicate/);
 assert.throws(()=>store.preview({owner:'claude_owner',argv:['unsafe']}),/Unknown/);
}));
test('capacity is hypothetical preview only, never execution permission',()=>fixture((store)=>{
 const r=store.preview({owner:'claude_owner',runningCount:4});assert.equal(r.capacityAvailable,false);assert.equal(r.execution,'disabled');
 assert.equal(store.preview({owner:'claude_owner',runningCount:3}).capacityAvailable,true);
 assert.throws(()=>store.preview({owner:'claude_owner',runningCount:-1}),/Invalid/);
}));
test('corrupt policy file is rejected and retained',()=>fixture((_store,path)=>{
 writeFileSync(path,'{"version":2}');assert.throws(()=>new PolicyStore(path),/Unsupported/);assert.equal(readFileSync(path,'utf8'),'{"version":2}');
}));
test('a saved policy with a gemini engine fails with the ordinary schema error',()=>fixture((_store,path)=>{
 const config=defaultConfig() as any; config.engines.gemini={enabled:true,kind:'gemini'};
 assert.deepEqual(validateConfig(config).map(i=>i.path),['$.engines.gemini.kind']);
 writeFileSync(path,JSON.stringify({version:1,revision:0,config,blocks:[]}));
 assert.throws(()=>new PolicyStore(path),/\$\.engines\.gemini\.kind: must be one of/);
}));
test('disabled pi template validates and stays out of claude routing',()=>{
 const c=defaultConfig(); assert.deepEqual(validateConfig(c),[]);
 assert.equal(c.engines.pi?.enabled,false); assert.equal(c.engines.pi?.kind,'pi');
 assert.equal(c.workers.pi_worker?.enabled,false); assert.equal(c.workers.pi_worker?.model,'glm-5.3-flash'); assert.equal(c.owners.pi_owner?.enabled,false); assert.deepEqual(EFFORTS.pi,['off','minimal','low','medium','high','xhigh','max']);
 for (const effort of EFFORTS.pi) { const sample=defaultConfig(); sample.workers.pi_worker.effort=effort; sample.owners.pi_owner.effort=effort; assert.deepEqual(validateConfig(sample),[]); }
 const badEffort=defaultConfig(); badEffort.workers.pi_worker.effort='ultra'; assert.ok(validateConfig(badEffort).some(issue=>issue.path.includes('pi_worker')&&issue.message.includes('effort')));
 assert.equal(c.owners.claude_owner.workers.includes('pi_worker'),false);
 const open=defaultConfig(); open.engines.opencode.enabled=true; open.workers.opencode_worker.enabled=true;
 open.owners.opencode_owner={enabled:true,engine:'opencode',model:'opencode/glm-5.3-flash-free',effort:'max',workers:['opencode_worker'],max_parallel:1};
 assert.deepEqual(validateConfig(open),[]);
 assert.equal(route(all()).worker,'claude_worker'); assert.equal(route(all()).weight,100);
});
test('the highest-weight available worker wins; equal weights keep list order',()=>{
 const c=all(); assert.equal(route(c).worker,'claude_worker');
 c.owners.claude_owner.worker_weights={grok_worker:300,opencode_worker:200};
 const r=route(c); assert.equal(r.worker,'grok_worker'); assert.equal(r.weight,300); assert.equal(r.selected_by,'weight');
 c.workers.grok_worker.enabled=false; const next=route(c);
 assert.equal(next.worker,'opencode_worker'); assert.deepEqual(next.skipped,[{worker:'grok_worker',reason:'disabled'}]);
 c.owners.claude_owner.worker_weights={claude_worker:0,qoder_worker:100,opencode_worker:100,grok_worker:100};
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
 const high=defaultConfig(); high.owners.claude_owner.worker_weights={claude_worker:1001}; assert.ok(validateConfig(high).some(issue=>issue.message.includes('0 to 1000')));
 const fraction=defaultConfig(); fraction.owners.claude_owner.worker_weights={claude_worker:1.5}; assert.ok(validateConfig(fraction).length);
});
test('a saved policy with retired tags and engine pins still loads without them',()=>fixture((store,path)=>{
 const s=store.snapshot(); store.save({revision:0,config:s.config,blocks:[]});
 const raw=JSON.parse(readFileSync(path,'utf8')); raw.config.workers.claude_worker.tags=['frontend']; raw.config.owners.claude_owner.only_engine='codex'; writeFileSync(path,JSON.stringify(raw));
 const loaded=new PolicyStore(path,()=>now).snapshot();
 assert.equal('tags' in loaded.config.workers.claude_worker,false); assert.equal('only_engine' in loaded.config.owners.claude_owner,false);
 assert.equal(loaded.revision,1);
}));
test('weights balance load: the lowest (running + 1) / weight wins, ties go to the higher weight then list order',()=>{
 const c=all(); c.owners.claude_owner.worker_weights={claude_worker:0,qoder_worker:50,opencode_worker:100,grok_worker:0};
 const pick=(load:Record<string,number>)=>resolveDispatch(c,[],{owner:'claude_owner',workerLoad:load}).worker;
 assert.equal(pick({}),'opencode_worker');
 // 2/100 ties 1/50: the higher weight takes it.
 assert.equal(pick({opencode_worker:1}),'opencode_worker');
 assert.equal(pick({opencode_worker:2}),'qoder_worker');
 assert.equal(pick({opencode_worker:3,qoder_worker:1}),'opencode_worker');
 assert.equal(pick({opencode_worker:4,qoder_worker:1}),'qoder_worker');
 // Six dispatches in a row split 2:1 by weight.
 const load:Record<string,number>={};
 for(let i=0;i<6;i++){const w=pick(load);load[w]=(load[w]??0)+1;}
 assert.deepEqual(load,{opencode_worker:4,qoder_worker:2});
 // Equal weights spread one by one in list order.
 c.owners.claude_owner.worker_weights={claude_worker:0,qoder_worker:100,opencode_worker:100,grok_worker:0};
 assert.equal(pick({}),'qoder_worker'); assert.equal(pick({qoder_worker:1}),'opencode_worker');
 // An explicit worker ignores load; weight 0 still never dispatches.
 assert.equal(resolveDispatch(c,[],{owner:'claude_owner',worker:'opencode_worker',workerLoad:{opencode_worker:9}}).worker,'opencode_worker');
 assert.equal(pick({qoder_worker:50,opencode_worker:50}),'qoder_worker');
});
test('preview reports each candidate load and score',()=>{
 const c=all(); c.owners.claude_owner.worker_weights={claude_worker:0,qoder_worker:50,opencode_worker:100,grok_worker:0};
 const r=resolveDispatch(c,[],{owner:'claude_owner',workerLoad:{opencode_worker:2}});
 assert.equal(r.worker,'qoder_worker');
 assert.deepEqual(r.candidates,[{worker:'qoder_worker',weight:50,running:0},{worker:'opencode_worker',weight:100,running:2}]);
 assert.deepEqual(r.skipped,[{worker:'claude_worker',reason:'priority weight 0'},{worker:'grok_worker',reason:'priority weight 0'}]);
});
test('excluded engines are skipped with their reason and load balancing still works',()=>{
 const c=all(); const pick=(excludeEngines:string[])=>resolveDispatch(c,[],{owner:'claude_owner',excludeEngines});
 assert.equal(pick([]).worker,'claude_worker'); assert.equal(pick(['pi']).worker,'claude_worker');
 const moved=pick(['claude']);
 assert.equal(moved.worker,'qoder_worker');
 assert.deepEqual(moved.skipped,[{worker:'claude_worker',reason:'failed earlier in this retry chain'}]);
 assert.deepEqual(moved.candidates,[{worker:'qoder_worker',weight:100,running:0},{worker:'opencode_worker',weight:100,running:0},{worker:'grok_worker',weight:100,running:0}]);
 // The excluded engine is out of the balancing, the rest keeps its weighted order.
 assert.equal(resolveDispatch(c,[],{owner:'claude_owner',excludeEngines:['claude'],workerLoad:{qoder_worker:5}}).worker,'opencode_worker');
 // Weight 0 is reported before exclusion: it was never a candidate at all.
 const weighted=all(); weighted.owners.claude_owner.worker_weights={claude_worker:0,qoder_worker:100,opencode_worker:100,grok_worker:100};
 assert.deepEqual(resolveDispatch(weighted,[],{owner:'claude_owner',excludeEngines:['claude']}).skipped,[{worker:'claude_worker',reason:'priority weight 0'}]);
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
 assert.equal(store.preview({owner:'claude_owner'}).worker,'claude_worker');
 assert.equal(store.preview({owner:'claude_owner',excludeEngines:['claude']}).worker,'opencode_worker');
 assert.ok(grab(()=>store.preview({owner:'claude_owner',excludeEngines:['claude','opencode']})).startsWith('NO_ALTERNATIVE_ENGINE'));
 for(const bad of ['claude',[1],Array(51).fill('claude'),['']]) assert.throws(()=>store.preview({owner:'claude_owner',excludeEngines:bad}),/excluded engine/);
 assert.equal(store.preview({owner:'claude_owner',excludeEngines:[]}).worker,'claude_worker');
 assert.throws(()=>store.preview({owner:'claude_owner',excludeEngines:['claude'],argv:['unsafe']}),/Unknown/);
}));
