import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/main/store';
import { MockOwnerHostAdapter } from '../../src/main/adapters/logical';
import { ContinuationService, idleContinuationDue, MAX_CONTEXT_PACK_BYTES, type ContinuationTask } from '../../src/main/continuation';
import { handoffPrompt, rootOwnerPrompt, MAX_HANDOFF_PROMPT_CHARS } from '../../src/main/owners/prompts';
import { redactContext } from '../../src/main/redact-context';
import type { ContextPack } from '../../src/shared/contracts/continuation';
import { metadataOf, setMetadataOf } from '../helpers/store-metadata';
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), 'weaver-continuation-'));
 const store = new TaskStore(join(dir,'weaver.db'));
 const host = new MockOwnerHostAdapter();
 let now = Date.parse('2026-01-01T00:00:00Z');
 const evidence = host.spawn({ownerId:'22222222-2222-4222-8222-222222222222',name:'Owner',profileId:'profile'});
 setMetadataOf(store, {owners:[{id:'22222222-2222-4222-8222-222222222222',name:'Owner',profileId:'profile',mode:'mock',state:'ready',createdAt:new Date(now).toISOString(),host:evidence}],packages:[],receipts:{}});
 const task: ContinuationTask = {id:'11111111-1111-4111-8111-111111111111',title:'Task',instruction:'Build the requested fixture',owner:{name:'Owner',transport:'herdr-visible',session:'mock',pane:'mock'},ownerId:'22222222-2222-4222-8222-222222222222',ownerEpoch:0,revision:0,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),ownerLastActivityAt:new Date(now).toISOString(),status:'queued',progress:0,events:[],artifacts:[]};
 store.put(task);
 const service = new ContinuationService(store, host, () => now);
 return {store,host,service,advance:(ms:number)=>{now+=ms;},close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('idle policy has exact boundary, disabled TTL and no timer-created owners', () => {
 const f=fixture();try {
  f.advance(60*60_000-1); assert.equal(f.service.due('11111111-1111-4111-8111-111111111111'),false);
  f.advance(1); assert.equal(f.service.due('11111111-1111-4111-8111-111111111111'),true);
  assert.equal(metadataOf(f.store).owners.length,1);
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
  const old=metadataOf(f.store).owners[0];
  const one=f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual',0);assert.notEqual(one.ownerId,'22222222-2222-4222-8222-222222222222');assert.equal(one.history[0].toProfileId,'profile');
  const first=structuredClone(one.history[0]);
  const two=f.service.rotate('11111111-1111-4111-8111-111111111111',1,'manual',1,'other');assert.equal(two.history.length,2);assert.deepEqual(two.history[0],first);
  assert.equal(two.contextPack?.baseReferences.previousPackId,one.contextPack?.id);
  assert.deepEqual(metadataOf(f.store).owners[0],old);
  assert.throws(()=>f.service.rotate('11111111-1111-4111-8111-111111111111',2,'manual',0),/epoch changed/);
  assert.equal(metadataOf(f.store).owners.length,3);
 }finally{f.close();}
});
test('active and scheduled workers prevent replacement creation',()=>{
 const f=fixture();try {
  for(const state of ['running','cancelling','scheduled'] as const) {
   const t=f.store.get('11111111-1111-4111-8111-111111111111');t.status=state==='scheduled'?'queued':state;t.scheduled=state==='scheduled';f.store.put(t);
   assert.throws(()=>f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual',0),/requires all workers/);
   assert.equal(metadataOf(f.store).owners.length,1);
  }
 }finally{f.close();}
});
test('ack failure preserves binding and cleans up only the new mock',()=>{
 const f=fixture();try {
  const spawned:string[]=[];const spawn=f.host.spawn.bind(f.host);f.host.spawn=(input)=>{spawned.push(input.ownerId);return spawn(input);};
  f.host.acknowledge=()=>{throw new Error('ack failed');};
  assert.throws(()=>f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual'),/ack failed/);
  assert.equal(f.store.get('11111111-1111-4111-8111-111111111111').ownerId,'22222222-2222-4222-8222-222222222222');assert.equal(metadataOf(f.store).owners.length,1);
  assert.equal(f.host.inspect(spawned[0]).host.state,'closed');assert.equal(f.host.inspect('22222222-2222-4222-8222-222222222222').host.state,'ready');
 }finally{f.close();}
});
test('worker or stale epoch introduced during handshake blocks commit and cleans replacement',()=>{
 for(const race of ['worker','epoch'] as const){const f=fixture();try {
  const ack=f.host.acknowledge.bind(f.host);let replacement='';
  f.host.acknowledge=(id,message)=>{replacement=id;const result=ack(id,message);const t=f.store.get('11111111-1111-4111-8111-111111111111') as ContinuationTask;if(race==='worker')t.status='running';else t.ownerEpoch=1;f.store.put(t);return result;};
  assert.throws(()=>f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual'),race==='worker'?/requires all workers/:/Owner changed/);
  assert.equal(f.store.get('11111111-1111-4111-8111-111111111111').ownerId,'22222222-2222-4222-8222-222222222222');assert.equal(metadataOf(f.store).owners.length,1);assert.equal(f.host.inspect(replacement).host.state,'closed');
 }finally{f.close();}}
});
test('persistence failure rolls back new owner, binding and history',()=>{
 const f=fixture();try {
  const originalPut=f.store.put.bind(f.store);f.store.put=(task)=>{if(task.ownerId!=='22222222-2222-4222-8222-222222222222')throw new Error('disk failure');originalPut(task);};
  assert.throws(()=>f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual'),/disk failure/);
  assert.equal(f.store.get('11111111-1111-4111-8111-111111111111').ownerId,'22222222-2222-4222-8222-222222222222');assert.equal(metadataOf(f.store).owners.length,1);
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
test('persisted continuation roundtrips through the store',()=>{
 const f=fixture();try {
  f.service.rotate('11111111-1111-4111-8111-111111111111',0,'manual');const saved=f.store.get('11111111-1111-4111-8111-111111111111') as ContinuationTask;
  const reopened=new TaskStore(f.store.path);try{const loaded=reopened.get('11111111-1111-4111-8111-111111111111') as ContinuationTask;assert.equal(loaded.ownerEpoch,1);assert.deepEqual(loaded.contextPack,saved.contextPack);assert.deepEqual(loaded.continuationHistory,saved.continuationHistory);}finally{reopened.close();}
 }finally{f.close();}
});
const TASK_ID='11111111-1111-4111-8111-111111111111';
const SECRETS=['sk-liveabcdef12','hunter2','abcdef123456','topsecretvalue'];
test('handoffPrompt briefs the incoming owner with ordered sections from the pack and the task',()=>{
 const f=fixture();try {
  const t=f.store.get(TASK_ID) as ContinuationTask;
  t.title='Payment retry';t.workspace='/srv/pay';t.constraints=['Write only inside src/pay'];t.acceptanceCriteria=['Retry stays idempotent'];
  t.summary='Worker landed the retry patch';t.status='completed';t.reviewState='accepted';
  t.artifacts=[{id:'a1',name:'retry.ts',mediaType:'text/plain',content:'body',createdAt:t.createdAt}];
  t.events=[
   {id:'e0',at:t.createdAt,kind:'log',message:'NOISE-LOG'},
   {id:'e1',at:t.createdAt,kind:'progress',message:'NOISE-PROGRESS'},
   {id:'e2',at:'2026-01-01T00:00:01Z',kind:'lifecycle',message:'DROP-ME-EVENT'},
   {id:'e3',at:'2026-01-01T00:00:02Z',kind:'result',message:'Worker reported done'},
   {id:'e4',at:'2026-01-01T00:00:03Z',kind:'artifact',message:'retry.ts written'},
   {id:'e5',at:'2026-01-01T00:00:04Z',kind:'error',message:'Transient failure kept'},
   {id:'e6',at:'2026-01-01T00:00:05Z',kind:'lifecycle',message:'Owner review accepted'},
   {id:'e7',at:'2026-01-01T00:00:06Z',kind:'result',message:'Second result kept'},
   {id:'e8',at:'2026-01-01T00:00:07Z',kind:'lifecycle',message:'Latest lifecycle kept'}];
  f.store.put(t);
  const pack={...f.service.rotate(TASK_ID,0,'manual').contextPack!,pendingApprovals:['Completed result awaits owner acceptance review']} as ContextPack;
  const prompt=handoffPrompt(t,pack);
  assert.equal(prompt.split('\n')[0],'你将作为父 Agent 接手 Weaver 任务「Payment retry」（'+TASK_ID+'）。在遵循全局与项目指令的前提下，读取 agents-weaver 技能（没有安装时运行 `weaver --skill`），按其中的流程继续。');
 assert.ok(!prompt.includes('先读取 agents-weaver'));
  const found=['工作目录：','目标：','约束：','验收标准：','当前状态：','已有产物：','最近进展：','待批准：','下一步：'].map(label=>prompt.indexOf(label));
  assert.ok(found.every(index=>index>=0),prompt);
  assert.deepEqual(found,[...found].sort((a,b)=>a-b));
  assert.ok(prompt.includes('工作目录：/srv/pay'));
  assert.ok(prompt.includes('目标：Build the requested fixture'));
  assert.ok(prompt.includes('约束：\n- Write only inside src/pay'));
  assert.ok(prompt.includes('验收标准：\n- Retry stays idempotent'));
  assert.ok(prompt.includes('当前状态：\n状态：completed\n最新摘要：Worker landed the retry patch'));
  assert.ok(prompt.includes('已有产物：\n- retry.ts'));
  assert.ok(prompt.includes('待批准：\n- Completed result awaits owner acceptance review'));
  assert.ok(prompt.includes('[2026-01-01T00:00:07Z] (lifecycle) Latest lifecycle kept'));
  assert.ok(!prompt.includes('DROP-ME-EVENT'),'only the six most recent progress events belong to a handoff');
  assert.ok(!prompt.includes('NOISE-LOG')&&!prompt.includes('NOISE-PROGRESS'),'chatty log and progress events are not owner context');
  assert.equal(prompt.match(/^- \[2026/gm)?.length,6);
  assert.match(prompt,/先运行 `weaver owners continuation get --task-id 11111111[\s\S]*` 和 `weaver tasks get --task-id 11111111[\s\S]*` \/ `weaver tasks results --task-id 11111111[\s\S]*` 核对现状/);
  assert.ok(prompt.trimEnd().endsWith('不要重复已完成的工作。'));
 }finally{f.close();}
});
test('rootOwnerPrompt leads with the host-instruction preamble on its first line',()=>{
 const task={id:TASK_ID,ownerId:'owner-root',instruction:'Ship the thing',constraints:['Stay scoped'],acceptanceCriteria:['Done']};
 const prompt=rootOwnerPrompt(task as Parameters<typeof rootOwnerPrompt>[0]);
 assert.equal(prompt.split('\n')[0],'你是 Weaver 根任务的父 Agent（owner），不是执行单个工作包的 worker。在遵循全局与项目指令的前提下，读取 agents-weaver 技能（未安装时运行 `weaver --skill`）并按以下流程执行。');
 assert.ok(!prompt.includes('先读取 agents-weaver'));
 assert.ok(!prompt.includes('herdr'));
 assert.ok(prompt.includes('每个子任务结果一回来，立即读取并按其工作包自己的验收标准独立核验文件和必要测试，同一轮内 results ack、reviews submit，不等其他子任务、根任务整体核验、浏览器验收或外部审查；跨子任务的集成问题另开修正子任务。'));
});
test('handoffPrompt tells a root owner to review each child as soon as its result arrives',()=>{
 const f=fixture();try {
  const t=f.store.get(TASK_ID) as ContinuationTask;
  t.executionRole='owner';
  f.store.put(t);
  const prompt=handoffPrompt(t,f.service.rotate(TASK_ID,0,'manual').contextPack!);
  assert.equal(prompt.split('\n')[0].includes('在遵循全局与项目指令的前提下，读取 agents-weaver 技能'),true);
  assert.ok(prompt.includes('每个子任务结果一回来即按其验收标准核验并 results ack、reviews submit，不等其他子任务或整体核验，集成问题另开修正子任务；根任务整体验收后再用 tasks complete 完成'));
  assert.ok(!prompt.includes('逐项 reviews submit'));
 }finally{f.close();}
});
test('handoffPrompt omits every section the pack and the task leave empty',()=>{
 const f=fixture();try {
  const prompt=f.service.rotate(TASK_ID,0,'manual').prompt!;
  for(const label of ['工作目录：','约束：','验收标准：','已有产物：','最近进展：','待批准：','最新摘要'])assert.ok(!prompt.includes(label),label);
  assert.ok(prompt.includes('当前状态：\n状态：queued'));
  assert.ok(prompt.includes('目标：Build the requested fixture'));
  assert.ok(prompt.includes('下一步：\n先运行'));
  assert.equal(prompt.split('\n\n').length,4);
 }finally{f.close();}
});
test('handoffPrompt shrinks each section instead of dropping one and stays inside its cap',()=>{
 const f=fixture();try {
  const t=f.store.get(TASK_ID) as ContinuationTask;
  t.instruction='g'.repeat(4000);t.workspace='/srv/'+'u'.repeat(400);t.summary='s'.repeat(1500);
  t.constraints=Array.from({length:30},(_,i)=>`constraint ${i} ${'z'.repeat(900)}`);
  t.acceptanceCriteria=Array.from({length:30},(_,i)=>`criterion ${i} ${'y'.repeat(900)}`);
  t.artifacts=Array.from({length:20},(_,i)=>({id:`a${i}`,name:`artifact ${i} ${'v'.repeat(400)}`,mediaType:'text/plain' as const,content:'body',createdAt:t.createdAt}));
  t.events=Array.from({length:12},(_,i)=>({id:`e${i}`,at:t.createdAt,kind:'lifecycle' as const,message:`event ${i} ${'w'.repeat(4000)}`}));
  t.status='completed';t.reviewState='accepted';f.store.put(t);
  const prompt=handoffPrompt(t,{...f.service.rotate(TASK_ID,0,'manual').contextPack!,pendingApprovals:Array.from({length:10},(_,i)=>`approval ${i} ${'q'.repeat(450)}`)} as ContextPack);
  const chars=Array.from(prompt).length;
  assert.ok(chars<=MAX_HANDOFF_PROMPT_CHARS,`prompt is ${chars} characters`);
  for(const label of ['目标：','约束：','验收标准：','当前状态：','已有产物：','最近进展：','待批准：','下一步：'])assert.ok(prompt.includes(label),label);
  assert.ok(prompt.trimEnd().endsWith('不要重复已完成的工作。'));
 }finally{f.close();}
});
test('handoffPrompt redacts credentials held by the task rather than the pack',()=>{
 const f=fixture();try {
  const t=f.store.get(TASK_ID) as ContinuationTask;
  t.title='Login flow api_key=sk-liveabcdef12';
  t.acceptanceCriteria=['Rotate password=hunter2 before ship'];
  t.events=[{id:'e1',at:t.createdAt,kind:'error',message:'Bearer abcdef123456 rejected and client_secret=topsecretvalue'}];
  f.store.put(t);
  const prompt=f.service.rotate(TASK_ID,0,'manual').prompt!;
  for(const secret of SECRETS)assert.ok(!prompt.includes(secret),secret);
  assert.match(prompt,/REDACTED/);
 }finally{f.close();}
});
test('continuation get and rotate expose the prompt only while a pack exists',()=>{
 const f=fixture();try {
  assert.equal(f.service.get(TASK_ID).prompt,undefined);
  const rotated=f.service.rotate(TASK_ID,0,'manual');
  assert.equal(rotated.prompt,handoffPrompt(f.store.get(TASK_ID) as ContinuationTask,rotated.contextPack!));
  assert.equal(f.service.get(TASK_ID).prompt,rotated.prompt);
 }finally{f.close();}
});
