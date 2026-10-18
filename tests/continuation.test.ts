import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/main/store';
import { MockOwnerHostAdapter } from '../src/main/adapters/logical';
import { ContinuationService, idleContinuationDue, redactContext, MAX_CONTEXT_PACK_BYTES, type ContinuationTask } from '../src/main/continuation';
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), 'weaver-continuation-'));
 const store = new TaskStore(join(dir, 'tasks.json'));
 const host = new MockOwnerHostAdapter();
 let now = Date.parse('2026-01-01T00:00:00Z');
 const evidence = host.spawn({ownerId:'22222222-2222-4222-8222-222222222222',name:'Owner',profileId:'profile'});
 store.setMetadata({owners:[{id:'22222222-2222-4222-8222-222222222222',name:'Owner',profileId:'profile',mode:'mock',state:'ready',createdAt:new Date(now).toISOString(),host:evidence}],packages:[],receipts:{}});
 const task: ContinuationTask = {id:'11111111-1111-4111-8111-111111111111',title:'Task',instruction:'Build the requested fixture',owner:{name:'Owner',transport:'herdr-visible',session:'mock',pane:'mock'},ownerId:'22222222-2222-4222-8222-222222222222',ownerEpoch:0,revision:0,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),ownerLastActivityAt:new Date(now).toISOString(),status:'queued',progress:0,events:[],artifacts:[]};
 store.put(task);
 const service = new ContinuationService(store, host, () => now);
 return {store,host,service,advance:(ms:number)=>{now+=ms;},close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('idle policy has exact boundary, disabled TTL and no timer-created owners', () => {
 const f=fixture();try {
  f.advance(60*60_000-1); assert.equal(f.service.due('11111111-1111-4111-8111-111111111111'),false);
  f.advance(1); assert.equal(f.service.due('11111111-1111-4111-8111-111111111111'),true);
  assert.equal(f.store.getMetadata().owners.length,1);
  const result=f.service.rotate('11111111-1111-4111-8111-111111111111',0,'idle',0);
  assert.equal(result.ownerEpoch,1);assert.equal(result.history[0].reason,'idle');assert.equal(result.due,false);
  f.advance(100*60_000);f.service.configure('11111111-1111-4111-8111-111111111111',1,null);assert.equal(f.service.due('11111111-1111-4111-8111-111111111111'),false);
  f.advance(999*60_000);assert.equal(f.service.due('11111111-1111-4111-8111-111111111111'),false);
  assert.throws(()=>f.service.rotate('11111111-1111-4111-8111-111111111111',2,'idle',1),/not due/);
 } finally {f.close();}
});
test('worker activity cannot reset idle policy and backwards clock does not expire',()=>{
 const f=fixture();try {const task=f.store.get('11111111-1111-4111-8111-111111111111') as ContinuationTask;
  task.updatedAt='2026-02-01T00:00:00Z';
  assert.equal(idleContinuationDue(task,Date.parse(task.createdAt)-1),false);
  assert.equal(idleContinuationDue(task,Date.parse(task.createdAt)+60*60_000),true);
 }finally{f.close();}
});
test('manual same-profile and changed-profile transfers preserve immutable old history',()=>{
 const f=fixture();try {
  const old=f.store.getMetadata().owners[0];
  const one=f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual',0);assert.notEqual(one.ownerId,'22222222-2222-4222-8222-222222222222');assert.equal(one.history[0].toProfileId,'profile');
  const first=structuredClone(one.history[0]);
  const two=f.service.rotate('11111111-1111-4111-8111-111111111111',1,'manual',1,'other');assert.equal(two.history.length,2);assert.deepEqual(two.history[0],first);
  assert.equal(two.contextPack?.baseReferences.previousPackId,one.contextPack?.id);
  assert.deepEqual(f.store.getMetadata().owners[0],old);
  assert.throws(()=>f.service.rotate('11111111-1111-4111-8111-111111111111',2,'manual',0),/epoch changed/);
  assert.equal(f.store.getMetadata().owners.length,3);
 }finally{f.close();}
});
test('active and scheduled workers prevent replacement creation',()=>{
 const f=fixture();try {
  for(const state of ['running','cancelling','scheduled'] as const) {
   const t=f.store.get('11111111-1111-4111-8111-111111111111');t.status=state==='scheduled'?'queued':state;t.scheduled=state==='scheduled';f.store.put(t);
   assert.throws(()=>f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual',0),/requires all workers/);
   assert.equal(f.store.getMetadata().owners.length,1);
  }
 }finally{f.close();}
});
test('ack failure preserves binding and cleans up only the new mock',()=>{
 const f=fixture();try {
  const spawned:string[]=[];const spawn=f.host.spawn.bind(f.host);f.host.spawn=(input)=>{spawned.push(input.ownerId);return spawn(input);};
  f.host.acknowledge=()=>{throw new Error('ack failed');};
  assert.throws(()=>f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual'),/ack failed/);
  assert.equal(f.store.get('11111111-1111-4111-8111-111111111111').ownerId,'22222222-2222-4222-8222-222222222222');assert.equal(f.store.getMetadata().owners.length,1);
  assert.equal(f.host.inspect(spawned[0]).host.state,'closed');assert.equal(f.host.inspect('22222222-2222-4222-8222-222222222222').host.state,'ready');
 }finally{f.close();}
});
test('worker or stale epoch introduced during handshake blocks commit and cleans replacement',()=>{
 for(const race of ['worker','epoch'] as const){const f=fixture();try {
  const ack=f.host.acknowledge.bind(f.host);let replacement='';
  f.host.acknowledge=(id,message)=>{replacement=id;const result=ack(id,message);const t=f.store.get('11111111-1111-4111-8111-111111111111') as ContinuationTask;if(race==='worker')t.status='running';else t.ownerEpoch=1;f.store.put(t);return result;};
  assert.throws(()=>f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual'),race==='worker'?/requires all workers/:/Owner changed/);
  assert.equal(f.store.get('11111111-1111-4111-8111-111111111111').ownerId,'22222222-2222-4222-8222-222222222222');assert.equal(f.store.getMetadata().owners.length,1);assert.equal(f.host.inspect(replacement).host.state,'closed');
 }finally{f.close();}}
});
test('persistence failure rolls back new owner, binding and history',()=>{
 const f=fixture();try {
  const originalPut=f.store.put.bind(f.store);f.store.put=(task)=>{if(task.ownerId!=='22222222-2222-4222-8222-222222222222')throw new Error('disk failure');originalPut(task);};
  assert.throws(()=>f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual'),/disk failure/);
  assert.equal(f.store.get('11111111-1111-4111-8111-111111111111').ownerId,'22222222-2222-4222-8222-222222222222');assert.equal(f.store.getMetadata().owners.length,1);
 }finally{f.close();}
});
test('pack is bounded, redacted, references accepted artifacts and never invents decisions',()=>{
 const f=fixture();try {
  const t=f.store.get('11111111-1111-4111-8111-111111111111') as ContinuationTask;t.instruction='password=hunter2 api_key="secretvalue" Bearer abcdef12345 '+ 'x'.repeat(12000);
  t.constraints=Array(100).fill('token=hidden '+ 'x'.repeat(3000));
  t.events=Array.from({length:100},(_,i)=>({id:String(i),at:t.createdAt,kind:'lifecycle' as const,message:'secret=verysecret '+ 'x'.repeat(3000)}));
  t.artifacts=[{id:'artifact',name:'Output',mediaType:'text/plain',content:'SECRET ARTIFACT BODY',createdAt:t.createdAt}];f.store.put(t);
  const pack=f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual').contextPack!;const json=JSON.stringify(pack);
  assert.ok(Buffer.byteLength(json)<=MAX_CONTEXT_PACK_BYTES);for(const secret of ['hunter2','secretvalue','abcdef12345','hidden','verysecret','SECRET ARTIFACT BODY'])assert.ok(!json.includes(secret),secret);
  assert.deepEqual(pack.decisions,[]);assert.deepEqual(pack.plan,[]);assert.deepEqual(pack.acceptedArtifacts,[]);assert.equal(pack.recentMessages.length,8);
  const accepted=f.store.get('11111111-1111-4111-8111-111111111111');accepted.status='completed';accepted.reviewState='accepted';f.store.put(accepted);
  const next=f.service.rotate('11111111-1111-4111-8111-111111111111',1,'manual').contextPack!;assert.equal(next.acceptedArtifacts[0].id,'artifact');assert.equal(next.acceptedArtifacts[0].sha256.length,64);
  assert.ok(!redactContext('access_token=hidden refresh_token=hidden client_secret=hidden').includes('hidden'));
  assert.match(redactContext('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'),/REDACTED/);
 }finally{f.close();}
});
test('persisted continuation roundtrips and rejects malformed policy, history and packs',async()=>{
 const {validateContinuationFields}=await import('../src/main/continuation');
 const f=fixture();try {
  f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual');const saved=f.store.get('11111111-1111-4111-8111-111111111111');
  assert.deepEqual(validateContinuationFields(saved as unknown as Record<string,unknown>).contextPack,(saved as ContinuationTask).contextPack);
  const reopened=new TaskStore(f.store.path);assert.equal((reopened.get('11111111-1111-4111-8111-111111111111') as ContinuationTask).ownerEpoch,1);
  for(const patch of [{ownerEpoch:-1},{ownerLastActivityAt:'invalid'},{continuationPolicy:{idleRotationMinutes:0}},{continuationHistory:[{epoch:2}]},{contextPack:{version:2}}]) {
   assert.throws(()=>validateContinuationFields({...saved,...patch}),/Invalid stored owner continuation/);
  }
 }finally{f.close();}
});
