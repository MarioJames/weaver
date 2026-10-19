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
const route=(c:Config,cls='judgment',tag?:string,blocks:Block[]=[])=>resolveDispatch(c,blocks,{owner:'claude_owner',class:cls,...(tag?{tag}:{})});
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
 assert.throws(()=>resolveDispatch(defaultConfig(),[],{owner:'constructor',class:'judgment'}),/unknown owner/);
});
test('effort, worker references, parallel limits and unique enabled owners validated',()=>{
 for(const effort of EFFORTS.codex) {const c=defaultConfig();c.workers.codex_worker.effort=effort;assert.deepEqual(validateConfig(c),[]);}
 const c=defaultConfig(); c.workers.codex_worker.effort='invalid'; c.owners.claude_owner.workers=['missing_worker'];c.owners.claude_owner.max_parallel=0;
 assert.ok(validateConfig(c).some(i=>i.path.endsWith('max_parallel')));
 c.owners.claude_owner.max_parallel=1; const issues=validateConfig(c);assert.ok(issues.some(i=>i.path.endsWith('.effort')));assert.ok(issues.some(i=>i.message.includes('unknown worker')));
 const duplicate=defaultConfig();duplicate.owners.other={...duplicate.owners.claude_owner};assert.ok(validateConfig(duplicate).some(i=>i.message.includes('already has enabled owner')));
});
test('mutually exclusive class tags and disabled engine owners rejected',()=>{
 const c=defaultConfig();c.workers.claude_worker.tags=['mechanical','routine']; assert.ok(validateConfig(c).some(i=>i.path.endsWith('.tags')));
 c.engines.claude.enabled=false;assert.ok(validateConfig(c).some(i=>i.message.includes('disabled')));
});
test('class ordering preserved: mechanical then routine then paid',()=>{
 const c=all();assert.equal(route(c,'mechanical').worker,'opencode_worker');assert.equal(route(c,'routine').worker,'qoder_worker');assert.equal(route(c).worker,'claude_worker');
 c.workers.opencode_worker.enabled=false;assert.equal(route(c,'mechanical').worker,'qoder_worker');c.workers.qoder_worker.enabled=false;
 const r=route(c,'mechanical');assert.equal(r.worker,'claude_worker');assert.equal(r.selected_by,'order');assert.ok(r.warnings.length);
});
test('judgment domain tag prefers heterogeneous provider, then own engine',()=>{
 const c=all();assert.equal(route(c,'judgment','research').worker,'grok_worker');c.workers.grok_worker.enabled=false;
 const r=route(c,'judgment','research');assert.equal(r.worker,'claude_worker');assert.equal(r.selected_by,'native');assert.ok(r.warnings.length);
});
test('paid judgment default preserves declared order rather than inventing native priority',()=>{
 const c=all();c.owners.claude_owner.workers=['grok_worker','claude_worker'];assert.equal(route(c).worker,'grok_worker');
});
test('peer suggestion remains advisory and contains no launch instructions',()=>{
 const r=route(defaultConfig(),'judgment','backend'); assert.equal(r.peer_suggestion?.owner,'codex_owner');
 assert.equal(r.execution,'disabled');assert.equal(r.dispatch,'preview'); for(const key of ['argv','tool','params','session','pane']) assert.ok(!(key in r));
});
test('explicit worker selection warns outside pool and rejects invalid combinations',()=>{
 const c=defaultConfig(); const r=resolveDispatch(c,[],{owner:'claude_owner',worker:'codex_worker'});assert.equal(r.worker,'codex_worker');assert.ok(r.warnings.length);
 assert.throws(()=>resolveDispatch(c,[],{owner:'claude_owner',worker:'codex_worker',class:'judgment'}),/cannot be combined/);
 assert.throws(()=>resolveDispatch(c,[],{owner:'claude_owner',class:'routine',tag:'backend'}),/only valid/);
 assert.throws(()=>resolveDispatch(c,[],{owner:'claude_owner',class:'judgment',tag:'mechanical'}),/class tag/);
 assert.throws(()=>resolveDispatch(c,[],{owner:'claude_owner'}),/required/);
});
test('engine/model quota precedence, expiration and indefinite blocks',()=>{
 const blocks:Block[]=[{engine:'grok',reason:'quota',since:new Date(now).toISOString(),release_at:new Date(now+1000).toISOString()},{engine:'opencode',model:'different',reason:'quota',since:new Date(now).toISOString()}];
 const c=all();assert.equal(route(c,'judgment','research',blocks).worker,'claude_worker');assert.equal(route(c,'mechanical',undefined,blocks).worker,'opencode_worker');
 assert.equal(activeBlocks({version:1,blocks},now).length,2);assert.equal(activeBlocks({version:1,blocks},now+1000).length,1);
 assert.equal(availabilityOf(c,[{...blocks[0],engine:'claude'}],c.owners.claude_owner).status,'blocked');
 assert.throws(()=>route(c,'judgment',undefined,[{...blocks[0],engine:'claude'}]),/owner.*unavailable/);
});
test('no available worker errors include candidate diagnostics',()=>{
 const c=all(); for(const w of Object.values(c.workers)) w.enabled=false;assert.throws(()=>route(c),/no available worker/);
});
test('release times accept timezone/relative forms and reject invalid or overflow',()=>{
 assert.equal(parseReleaseAt('+2h',now),'2026-10-18T14:00:00.000Z');assert.equal(parseReleaseAt('2026-10-18T14:00:00+02:00',now),'2026-10-18T14:00:00+02:00');
 for(const value of ['tomorrow','+0m','2026-10-18T14:00:00','+999999999999999999999999d']) assert.throws(()=>parseReleaseAt(value,now));
});
function fixture(fn:(store:PolicyStore,path:string)=>void) {const root=mkdtempSync(join(tmpdir(),'weaver-policy-'));try{const path=join(root,'policy.json');fn(new PolicyStore(path,()=>now),path);}finally{rmSync(root,{recursive:true,force:true});}}
test('app settings roundtrip without reading upstream/home, stale writes fail',()=>fixture((store,path)=>{
 const s=store.snapshot();s.config.chatgpt_review=false; const next=store.save({revision:s.revision,config:s.config,blocks:[]});assert.equal(next.revision,1);
 assert.deepEqual(new PolicyStore(path,()=>now).snapshot(),next);assert.equal(store.preview({owner:'claude_owner',class:'judgment'}).chatgptReview,false);
 assert.throws(()=>store.save({revision:0,config:s.config,blocks:[]}),/reload/);assert.equal(store.snapshot().revision,1);
}));
test('block edits persist, expired blocks are ignored at preview time, deletion unblocks',()=>fixture((store)=>{
 const s=store.snapshot();const blocks=[{engine:'claude',reason:'manual',since:new Date(now).toISOString()}];
 store.save({revision:0,config:s.config,blocks});assert.throws(()=>store.preview({owner:'claude_owner',class:'judgment'}),/unavailable/);
 store.save({revision:1,config:s.config,blocks:blocks.map(b=>({...b,release_at:new Date(now).toISOString()}))});assert.equal(store.snapshot().activeBlocks.length,0);assert.equal(store.preview({owner:'claude_owner',class:'judgment'}).worker,'claude_worker');
 store.save({revision:2,config:s.config,blocks:[]});assert.equal(store.snapshot().blocks.length,0);
}));
test('invalid quota edits preserve disk and in-memory state',()=>fixture((store,path)=>{
 const s=store.snapshot();store.save({revision:0,config:s.config,blocks:[]}); const before=readFileSync(path,'utf8');
 for(const blocks of [[{engine:'unknown',reason:'x',since:new Date(now).toISOString()}],[{engine:'claude',reason:'',since:'bad'}],[{engine:'claude',reason:'x',since:'+1h'}],[{engine:'claude',reason:'x',since:new Date(now).toISOString(),release_at:'+2h'}]]) assert.throws(()=>store.save({revision:1,config:s.config,blocks}));
 assert.equal(readFileSync(path,'utf8'),before);assert.equal(store.snapshot().revision,1);
}));
test('duplicate blocks and unknown IPC fields rejected',()=>fixture((store)=>{
 const s=store.snapshot();const b={engine:'claude',reason:'x',since:new Date(now).toISOString()};assert.throws(()=>store.save({revision:0,config:s.config,blocks:[b,b]}),/Duplicate/);
 assert.throws(()=>store.preview({owner:'claude_owner',class:'judgment',argv:['unsafe']}),/Unknown/);
}));
test('capacity is hypothetical preview only, never execution permission',()=>fixture((store)=>{
 const r=store.preview({owner:'claude_owner',class:'judgment',runningCount:4});assert.equal(r.capacityAvailable,false);assert.equal(r.execution,'disabled');
 assert.equal(store.preview({owner:'claude_owner',class:'judgment',runningCount:3}).capacityAvailable,true);
 assert.throws(()=>store.preview({owner:'claude_owner',class:'judgment',runningCount:-1}),/Invalid/);
}));
test('corrupt policy file is rejected and retained',()=>fixture((_store,path)=>{
 writeFileSync(path,'{"version":2}');assert.throws(()=>new PolicyStore(path),/Unsupported/);assert.equal(readFileSync(path,'utf8'),'{"version":2}');
}));
test('disabled pi template validates without native subagents and stays out of claude routing',()=>{
 const c=defaultConfig(); assert.deepEqual(validateConfig(c),[]);
 assert.equal(c.engines.pi?.enabled,false); assert.equal(c.engines.pi?.kind,'pi'); assert.equal(c.engines.pi?.native_subagents,false);
 assert.equal(c.workers.pi_worker?.enabled,false); assert.equal(c.workers.pi_worker?.model,'glm-5.3-flash'); assert.equal(c.owners.pi_owner?.enabled,false); assert.deepEqual(EFFORTS.pi,['off','minimal','low','medium','high','xhigh','max']);
 for (const effort of EFFORTS.pi) { const sample=defaultConfig(); sample.workers.pi_worker.effort=effort; sample.owners.pi_owner.effort=effort; assert.deepEqual(validateConfig(sample),[]); }
 const badEffort=defaultConfig(); badEffort.workers.pi_worker.effort='ultra'; assert.ok(validateConfig(badEffort).some(issue=>issue.path.includes('pi_worker')&&issue.message.includes('effort')));
 assert.equal(c.owners.claude_owner.workers.includes('pi_worker'),false);
 const open=defaultConfig(); open.engines.opencode.enabled=true; open.workers.opencode_worker.enabled=true;
 open.owners.opencode_owner={enabled:true,engine:'opencode',model:'opencode/glm-5.3-flash-free',effort:'max',workers:['opencode_worker'],max_parallel:1};
 assert.equal(open.engines.opencode.native_subagents,false); assert.deepEqual(validateConfig(open),[]);
 assert.equal(route(all()).worker,'claude_worker'); assert.equal(route(all()).weight,100); assert.equal(route(all()).only_engine,undefined);
});
test('weight reorders inside a tier, keeps ties in list order, and does not cross class',()=>{
 const c=all(); c.workers.qoder_worker.tags=['mechanical']; c.owners.claude_owner.workers=['opencode_worker','qoder_worker','claude_worker'];
 c.owners.claude_owner.worker_weights={qoder_worker:100}; assert.equal(route(c,'mechanical').worker,'opencode_worker');
 c.owners.claude_owner.worker_weights={qoder_worker:200,opencode_worker:100}; const ranked=route(c,'mechanical');
 assert.equal(ranked.worker,'qoder_worker'); assert.equal(ranked.weight,200); assert.equal(ranked.selected_by,'class');
 const capped=all(); capped.owners.claude_owner.worker_weights={claude_worker:1000,opencode_worker:1};
 assert.equal(route(capped,'mechanical').worker,'opencode_worker'); assert.equal(route(capped,'mechanical').weight,1);
});
test('weight 0 and a fixed engine are hard exclusions with no cross-engine fallback',()=>{
 const c=all(); c.owners.claude_owner.worker_weights={opencode_worker:0};
 const fell=route(c,'mechanical'); assert.equal(fell.worker,'qoder_worker'); assert.ok(fell.skipped?.some(item=>item.worker==='opencode_worker'&&item.reason==='priority weight 0'));
 assert.throws(()=>resolveDispatch(c,[],{owner:'claude_owner',worker:'opencode_worker'}),/priority weight 0/);
 assert.equal(route(all(),'judgment','research').worker,'grok_worker');
 const pinned=all(); pinned.owners.claude_owner.only_engine='opencode'; pinned.owners.claude_owner.worker_weights={grok_worker:1000};
 assert.throws(()=>route(pinned,'judgment','research'),/no available worker/); assert.throws(()=>route(pinned,'judgment','research'),/fixed engine opencode/);
 assert.throws(()=>resolveDispatch(pinned,[],{owner:'claude_owner',worker:'grok_worker'}),/fixed engine opencode/);
 pinned.workers.opencode_worker.tags=['research']; const selected=route(pinned,'judgment','research');
 assert.equal(selected.worker,'opencode_worker'); assert.equal(selected.engine,'opencode'); assert.equal(selected.only_engine,'opencode'); assert.equal(selected.execution,'disabled'); assert.equal(selected.dispatch,'preview');
 const loose=defaultConfig(); const outside=resolveDispatch(loose,[],{owner:'claude_owner',worker:'codex_worker'}); assert.equal(outside.worker,'codex_worker'); assert.ok(outside.warnings.length);
});
test('invalid weights and unknown pins are rejected; all-zero and unavailable pins still save',()=>{
 const missing=defaultConfig(); missing.owners.claude_owner.worker_weights={missing_worker:10}; assert.ok(validateConfig(missing).some(issue=>issue.message.includes("not in this owner's workers")));
 const high=defaultConfig(); high.owners.claude_owner.worker_weights={claude_worker:1001}; assert.ok(validateConfig(high).some(issue=>issue.message.includes('0 to 1000')));
 const low=defaultConfig(); low.owners.claude_owner.worker_weights={claude_worker:-1}; assert.ok(validateConfig(low).length);
 const fraction=defaultConfig(); fraction.owners.claude_owner.worker_weights={claude_worker:1.5}; assert.ok(validateConfig(fraction).length);
 const unknown=defaultConfig(); unknown.owners.claude_owner.only_engine='cursor'; assert.ok(validateConfig(unknown).some(issue=>issue.message.includes('unknown engine')));
 const zero=all(); for (const id of zero.owners.claude_owner.workers) zero.owners.claude_owner.worker_weights={...zero.owners.claude_owner.worker_weights,[id]:0};
 assert.deepEqual(validateConfig(zero),[]); assert.throws(()=>route(zero),/no available worker/); assert.throws(()=>route(zero),/priority weight 0/);
 zero.owners.claude_owner.worker_weights={opencode_worker:0,qoder_worker:0,grok_worker:0}; assert.equal(route(zero).worker,'claude_worker');
 const pinnedOff=all(); pinnedOff.engines.opencode.enabled=false; pinnedOff.workers.opencode_worker.enabled=false; pinnedOff.owners.claude_owner.only_engine='opencode';
 assert.deepEqual(validateConfig(pinnedOff),[]); assert.throws(()=>route(pinnedOff),/no available worker/); assert.throws(()=>route(pinnedOff),/fixed engine opencode/);
 delete pinnedOff.owners.claude_owner.only_engine; assert.equal(route(pinnedOff).worker,'claude_worker');
});
test('saved preview uses the same weight and pin resolver',()=>fixture((store)=>{
 const config=store.snapshot().config; config.owners.claude_owner.workers=['claude_worker','codex_worker']; config.owners.claude_owner.only_engine='codex'; config.owners.claude_owner.worker_weights={codex_worker:10};
 store.save({revision:0,config,blocks:[]}); const preview=store.preview({owner:'claude_owner',class:'judgment',runningCount:0});
 assert.equal(preview.worker,'codex_worker'); assert.equal(preview.engine,'codex'); assert.equal(preview.weight,10); assert.equal(preview.only_engine,'codex');
 assert.equal(preview.execution,'disabled'); assert.equal(preview.dispatch,'preview'); assert.ok(preview.skipped?.some(item=>item.worker==='claude_worker'&&item.reason==='fixed engine codex'));
 assert.throws(()=>store.preview({owner:'claude_owner',worker:'claude_worker'}),/fixed engine codex/);
 const blocked=store.snapshot().config; blocked.owners.claude_owner.worker_weights={claude_worker:0,codex_worker:0};
 store.save({revision:1,config:blocked,blocks:[{engine:'codex',reason:'quota',since:new Date(now).toISOString()}]});
 assert.throws(()=>store.preview({owner:'claude_owner',class:'judgment'}),/no available worker/);
 delete blocked.owners.claude_owner.worker_weights; delete blocked.owners.claude_owner.only_engine;
 store.save({revision:2,config:blocked,blocks:[]}); assert.equal(store.preview({owner:'claude_owner',class:'judgment'}).worker,'claude_worker');
}));
