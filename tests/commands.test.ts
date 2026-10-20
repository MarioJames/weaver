import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {TaskStore} from '../src/main/store';
import {TaskManager} from '../src/main/manager';
import {MockWorkerAdapter} from '../src/main/adapters/worker';
import {CommandHandler} from '../src/main/commands';
import {PolicyStore} from '../src/main/policy/store';
import {OwnerLaunchError, type OwnerLaunchInput, type OwnerLaunchResult} from '../src/main/owner-host';
import {parseStoredTask} from '../src/main/stored-task';
/** Real Herdr is never reachable from tests: a handler without an injected launcher refuses to launch. */
const blockedLaunch=(input:OwnerLaunchInput):OwnerLaunchResult=>{throw new OwnerLaunchError('OWNER_LAUNCH_FAILED',`Test did not inject an owner launcher for ${input.taskId}`);};
function setup(options:{herdr?:boolean;launcher?:(input:OwnerLaunchInput)=>OwnerLaunchResult}={}){const dir=mkdtempSync(join(tmpdir(),'weaver-command-'));const store=new TaskStore(join(dir,'weaver.db'));const manager=new TaskManager(store,new MockWorkerAdapter(process.execPath,resolve('scripts/mock-worker.mjs')));const policy=new PolicyStore(join(dir,'weaver.db'));const handler=new CommandHandler(manager,policy,options.launcher??blockedLaunch,()=>options.herdr===true);const raw=(command:string,args:Record<string,unknown>={},commandId:string=randomUUID())=>handler.handle({apiVersion:'weaver.v1',commandId,command,args});const call=(command:string,args:Record<string,unknown>={},commandId?:string):any=>{const r=raw(command,args,commandId);assert.equal(r.ok,true,JSON.stringify(r));return r.data;};return {dir,store,manager,policy,handler,call,raw,close:async()=>{handler.draining=true;await manager.shutdown();rmSync(dir,{recursive:true,force:true});}};}
async function done(f:ReturnType<typeof setup>,id:string){const until=Date.now()+8000;while(Date.now()<until){const t=f.store.get(id);if(['completed','failed','cancelled'].includes(t.status))return t;await new Promise(r=>setTimeout(r,15));}throw new Error('timeout');}
const legacy={title:'Command test',instruction:'Bundled safe mock',owner:{name:'demo',transport:'herdr-visible' as const,session:'reference',pane:'reference'}};
test('manual attach keeps caller labels unverified and does not register a session on spawn',async()=>{const f=setup();try{const profileId=Object.keys(f.policy.snapshot().config.owners)[0];const attached=f.call('owners.attach',{name:'note',profileId,session:'caller-label',pane:'caller-pane'});assert.equal(attached.mode,'manual');assert.equal(attached.host.verified,false);assert.equal(attached.host.visibility,'external-unverified');assert.equal(attached.host.ownsHost,false);assert.equal(attached.host.session,'caller-label');assert.equal(attached.host.pane,'caller-pane');const plain=f.call('owners.attach',{name:'plain',profileId});assert.equal(plain.host.session,'external-cli');assert.equal(plain.host.pane,'unverified');assert.equal(plain.host.verified,false);const registered=f.call('owners.spawn',{name:'external',profileId,session:'claimed'});assert.equal(registered.mode,'manual');assert.equal(registered.host.session,'claimed');assert.equal(registered.host.verified,false);assert.equal(f.raw('owners.spawn',{name:'mock',profileId,provider:'mock',session:'claimed'}).error?.code,'INVALID_REQUEST');assert.equal(f.raw('owners.attach',{name:'model',profileId,provider:'codex'}).error?.code,'CAPABILITY_UNAVAILABLE');const caps=f.call('capabilities.get');assert.equal(caps.ownerSpawn,'logical-registration');assert.equal(caps.manualAttach,'metadata-only');assert.equal(caps.ownerModelSpawned,false);assert.equal(caps.attachmentVerified,false);assert.equal(caps.authenticated,false);assert.equal(caps.modelUsable,false);assert.equal(caps.commands.length,37);assert.ok(caps.commands.includes('owners.launch'));const task=f.call('tasks.create',{title:'Bound',instruction:'fixture',ownerId:attached.id});assert.equal(f.store.get(task.id).owner.session,'unverified');assert.equal(f.store.get(task.id).owner.pane,'unverified');}finally{await f.close();}});
test('owners.list reports every registered instance with its metadata and slot use, and a replayed attach registers nothing',async()=>{const f=setup();try{
 const profileId=Object.keys(f.policy.snapshot().config.owners)[0];const mock=f.call('owners.spawn',{name:'owner',profileId,provider:'mock'});
 const args={name:'caller',profileId,session:'mine',pane:'pane-1'};const commandId=randomUUID();const manual=f.call('owners.attach',args,commandId);
 assert.deepEqual(f.call('owners.attach',args,commandId),manual,'the same command ID replays its receipt instead of registering a second instance');
 const listed=f.call('owners.list').owners as any[];
 assert.deepEqual(listed.map(o=>[o.id,o.name,o.profileId,o.mode,o.state,o.session,o.runningTaskCount]),[[mock.id,'owner',profileId,'mock','ready',undefined,0],[manual.id,'caller',profileId,'manual','attached','mine',0]]);
 assert.equal(listed[1].host.ownerId,manual.id,'the instance is reported with the host registration it was created with');
 const task=f.call('tasks.create',{title:'Bound',instruction:'safe mock',ownerId:manual.id});f.call('workers.spawn',{taskId:task.id});
 assert.equal((await done(f,task.id)).status,'completed');
 assert.equal(f.call('owners.list').owners.find((o:any)=>o.id===manual.id).runningTaskCount,0,'completed work releases its instance slot');
 assert.equal(f.call('owners.get',{ownerId:manual.id}).runningTaskCount,0);assert.equal(f.call('owners.get',{ownerId:manual.id}).session,'mine');
}finally{await f.close();}});
test('logical mock owner, frozen package, dispatch, delivery, ack, review and restart',async()=>{const f=setup();try{
 const profileId=Object.keys(f.policy.snapshot().config.owners)[0];const owner=f.call('owners.spawn',{name:'owner',profileId,provider:'mock'});assert.equal(owner.mode,'mock');assert.equal(owner.host.visibility,'logical-demo');
 const task=f.call('tasks.create',{title:'Demo',instruction:'safe mock',ownerId:owner.id});const pkg=f.call('packages.create',{taskId:task.id,scope:['fixture only'],acceptanceCriteria:['mock output'],expectedRevision:task.revision});
 assert.equal(pkg.revision,1);f.call('workers.spawn',{taskId:task.id,packageId:pkg.id});await done(f,task.id);
 const result=f.call('tasks.results',{taskId:task.id});assert.equal(result.execution,'completed');assert.equal(result.acceptance,'pending');
 const artifact=f.call('artifacts.read',{taskId:task.id,artifactId:result.artifacts[0].id});assert.match(artifact.content,/mock/i);
 const delivery=f.call('results.deliver',{taskId:task.id});assert.equal(delivery.transport,'mock-memory');
 assert.equal(f.raw('reviews.submit',{taskId:task.id,manifestDigest:'wrong',decision:'accepted',expectedRevision:f.store.get(task.id).revision}).error?.code,'MANIFEST_MISMATCH');
 const ack=f.call('results.ack',{taskId:task.id,manifestDigest:result.manifestDigest,expectedRevision:f.store.get(task.id).revision});assert.equal(ack.acceptance,'pending');assert.equal(ack.delivery,'acknowledged');
 const review=f.call('reviews.submit',{taskId:task.id,manifestDigest:result.manifestDigest,decision:'accepted',expectedRevision:f.store.get(task.id).revision});assert.equal(review.acceptance,'accepted');
 const loaded=new TaskStore(join(f.dir,'weaver.db'));assert.equal(loaded.get(task.id).reviewState,'accepted');const reopened=new CommandHandler(new TaskManager(loaded,new MockWorkerAdapter(process.execPath,resolve('scripts/mock-worker.mjs'))),f.policy,blockedLaunch,()=>false);assert.equal(reopened.handle({apiVersion:'weaver.v1',command:'owners.get',args:{ownerId:owner.id}}).ok,true);
}finally{await f.close();}});
test('durable idempotency, conflicts, bounded events and unknown execution fail closed',async()=>{const f=setup();try{const id=randomUUID();const one=f.call('tasks.create',legacy,id);assert.deepEqual(f.call('tasks.create',legacy,id),one);assert.equal(f.store.list().length,1);assert.equal(f.raw('tasks.create',{...legacy,title:'different'},id).error?.code,'IDEMPOTENCY_CONFLICT');assert.equal(f.raw('workers.spawn',{taskId:one.id,provider:'real-cli'}).error?.code,'CAPABILITY_UNAVAILABLE');assert.equal(f.raw('tasks.events',{taskId:one.id,after:'expired'}).error?.code,'CURSOR_EXPIRED');assert.equal(f.raw('tasks.events',{taskId:one.id,limit:101}).ok,false);assert.equal(f.call('tasks.events',{taskId:one.id,limit:1}).events.length,1);const fresh=new CommandHandler(new TaskManager(new TaskStore(join(f.dir,'weaver.db')),new MockWorkerAdapter(process.execPath,resolve('scripts/mock-worker.mjs'))),f.policy,blockedLaunch,()=>false);assert.deepEqual(fresh.handle({apiVersion:'weaver.v1',commandId:id,command:'tasks.create',args:legacy}).data,one);}finally{await f.close();}});
test('policy governs actual admission and scheduler runs waiting work after slot release',async()=>{const f=setup();try{const snapshot=f.policy.snapshot();const owner=Object.keys(snapshot.config.owners)[0];snapshot.config.owners[owner].max_parallel=1;f.policy.save({revision:snapshot.revision,config:snapshot.config,blocks:[]});const a=f.call('tasks.create',legacy);const b=f.call('tasks.create',legacy);f.call('workers.spawn',{taskId:a.id,owner});const queued=f.call('workers.spawn',{taskId:b.id,owner});assert.equal(queued.status,'queued');assert.equal(queued.scheduled,true);assert.equal((await done(f,a.id)).status,'completed');assert.equal((await done(f,b.id)).status,'completed');const retry=f.call('tasks.retry',{taskId:a.id});assert.equal(retry.retryOf,a.id);assert.equal(retry.status,'running');assert.equal(retry.dispatch.execution,'mock');assert.deepEqual(retry.next,{action:'wait',command:`weaver tasks wait --task-id ${retry.id}`});assert.equal((await done(f,retry.id)).status,'completed');assert.equal(f.store.get(a.id).status,'completed');const changed=f.policy.snapshot();changed.config.owners[owner].enabled=false;f.policy.save({revision:changed.revision,config:changed.config,blocks:[]});const waiting=f.call('tasks.create',legacy);assert.equal(f.raw('workers.spawn',{taskId:waiting.id,owner}).ok,false);assert.equal(f.store.get(waiting.id).status,'queued');}finally{await f.close();}});
test('cancel is domain operation, terminal cancellation idempotent and review revision protected',async()=>{const f=setup();try{const t=f.call('tasks.create',legacy);f.call('workers.spawn',{taskId:t.id});f.call('tasks.cancel',{taskId:t.id});assert.equal((await done(f,t.id)).status,'cancelled');assert.equal(f.call('tasks.cancel',{taskId:t.id}).alreadyTerminal,true);const manifest=f.call('tasks.results',{taskId:t.id});assert.equal(f.raw('results.ack',{taskId:t.id,manifestDigest:manifest.manifestDigest,expectedRevision:0}).error?.code,'REVISION_CONFLICT');}finally{await f.close();}});
test('one create command owns mock owner creation and preserves task context',async()=>{const f=setup();try{const ownerProfileId=Object.keys(f.policy.snapshot().config.owners)[0];const task=f.call('tasks.create',{title:'Panel flow',goal:'Do safe mock work',workspace:'/demo/project',ownerProfileId,ownerProvider:'mock',acceptanceCriteria:['Check output']});assert.ok(task.ownerId);assert.equal(task.workspace,'/demo/project');assert.deepEqual(task.acceptanceCriteria,['Check output']);assert.equal(f.call('owners.get',{ownerId:task.ownerId}).mode,'mock');const before=f.store.getMetadata().owners.length;assert.equal(f.raw('tasks.create',{title:'Bad',goal:'',ownerProfileId}).ok,false);assert.equal(f.store.getMetadata().owners.length,before);f.call('workers.spawn',{taskId:task.id});const completed=await done(f,task.id);assert.ok(completed.packageId);const trace=f.call('observability.get',{taskId:task.id});assert.equal(trace.metrics.tokens,null);assert.equal(trace.execution,'completed');assert.match(f.call('observability.export',{taskId:task.id}).content,/not reported/);}finally{await f.close();}});
test('pending receipt is never replayed after restart and transaction rollback preserves state',async()=>{const f=setup();try{const t=f.call('tasks.create',legacy);assert.throws(()=>f.store.transaction(()=>{f.manager.create(legacy);throw new Error('rollback');}));assert.equal(f.store.list().length,1);const id=randomUUID();const response=f.raw('tasks.cancel',{taskId:t.id},id);assert.equal(response.ok,true);const meta=f.store.getMetadata();delete meta.receipts[`local-demo:${id}`].response;f.store.setMetadata(meta);assert.equal(f.raw('tasks.cancel',{taskId:t.id},id).error?.code,'COMMAND_INDETERMINATE');assert.equal(f.store.get(t.id).status,'cancelled');}finally{await f.close();}});
test('continuation commands validate revision, survive restart and idle rotation does not churn',async()=>{const f=setup();try{const profile=Object.keys(f.policy.snapshot().config.owners)[0];const task=f.call('tasks.create',{title:'Continuation',goal:'safe fixture',ownerProfileId:profile,ownerProvider:'mock'});assert.equal(f.raw('owners.continuation.configure',{taskId:task.id,expectedRevision:String(task.revision),idleRotationMinutes:60}).error?.code,'INVALID_REQUEST');assert.equal(f.raw('owners.switch',{taskId:task.id,expectedRevision:task.revision,reason:'bad'}).error?.code,'INVALID_REQUEST');f.call('owners.continuation.configure',{taskId:task.id,expectedRevision:task.revision,idleRotationMinutes:1});const idle=f.store.get(task.id);idle.ownerLastActivityAt=new Date(Date.now()-120000).toISOString();f.store.put(idle);assert.deepEqual(f.handler.checkIdleOwners(),[task.id]);assert.equal(f.store.get(task.id).ownerEpoch,0);f.call('workers.spawn',{taskId:task.id});const rotated=f.store.get(task.id);assert.equal(rotated.ownerEpoch,1);assert.equal(rotated.continuationHistory?.[0].reason,'idle');f.handler.checkIdleOwners();assert.equal(f.store.get(task.id).ownerEpoch,1);const loaded=new TaskStore(join(f.dir,'weaver.db'));assert.equal(loaded.get(task.id).contextPack?.version,1);assert.equal(loaded.get(task.id).ownerEpoch,1);assert.equal(loaded.get(task.id).continuationHistory?.length,1);}finally{await f.close();}});
test('sync snapshots have monotonic persisted revision and catch missed invalidation',async()=>{const f=setup();try{const initial=f.call('sync.snapshot');let notifications=0;f.manager.listeners.add(()=>notifications++);const task=f.call('tasks.create',legacy);const after=f.call('sync.snapshot');assert.ok(after.revision>initial.revision);assert.equal(after.tasks[0].id,task.id);assert.ok(notifications>0);assert.equal(f.call('sync.status',{after:initial.revision}).changed,true);assert.equal(f.call('sync.status',{after:after.revision}).changed,false);assert.equal(new TaskStore(join(f.dir,'weaver.db')).revision,after.revision);}finally{await f.close();}});
test('trace export redacts quoted JSON credentials and hashes artifact content bytes',async()=>{const f=setup();try{const task=f.call('tasks.create',legacy);const stored=f.store.get(task.id);stored.status='completed';stored.events.push({id:randomUUID(),at:new Date().toISOString(),kind:'log',message:'{"token":"secret-value","password":"hidden"} Bearer abc123'});stored.artifacts.push({id:randomUUID(),createdAt:new Date().toISOString(),name:'result.txt',mediaType:'text/plain',content:'hello'});f.store.put(stored);const output=f.call('observability.export',{taskId:task.id});assert.doesNotMatch(output.content,/secret-value|hidden|abc123/);assert.match(output.content,/REDACTED/);const result=f.call('tasks.results',{taskId:task.id});assert.equal(result.artifacts[0].sha256,'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');}finally{await f.close();}});


test('default external owner pulls, acknowledges and reviews results; idle due never auto-rotates it',async()=>{
 const f=setup();try{
  const task=f.call('tasks.create',{title:'Manual owner',goal:'fixture',ownerProfileId:'codex_owner'});
  const registered=f.call('owners.get',{ownerId:task.ownerId});assert.equal(registered.mode,'manual');assert.equal(registered.host.ownsHost,false);assert.equal(registered.host.verified,false);assert.equal(registered.host.session,'external-cli');
  const idle=f.store.get(task.id);idle.ownerLastActivityAt=new Date(Date.now()-61*60_000).toISOString();f.store.put(idle);
  assert.ok(f.handler.checkIdleOwners().includes(task.id));f.call('workers.spawn',{taskId:task.id,provider:'mock-jsonl'});await done(f,task.id);
  assert.equal(f.store.get(task.id).ownerEpoch,0);assert.equal(f.store.get(task.id).continuationHistory,undefined);
  assert.equal(f.raw('results.deliver',{taskId:task.id}).error?.code,'CAPABILITY_UNAVAILABLE');
  const manifest=f.call('tasks.results',{taskId:task.id});const artifact=f.call('artifacts.read',{taskId:task.id,artifactId:manifest.artifacts[0].id});assert.match(artifact.content,/mock/i);
  const received=f.call('results.ack',{taskId:task.id,expectedRevision:f.store.get(task.id).revision,manifestDigest:manifest.manifestDigest});assert.equal(received.delivery,'acknowledged');assert.equal(received.acceptance,'pending');
  f.call('reviews.submit',{taskId:task.id,expectedRevision:f.store.get(task.id).revision,manifestDigest:manifest.manifestDigest,decision:'accepted'});
  const switched=f.call('owners.switch',{taskId:task.id,expectedRevision:f.store.get(task.id).revision,expectedEpoch:0});
  assert.equal(switched.history[0].acknowledgementId,null);assert.equal(switched.ownerEpoch,1);assert.match(switched.contextPack.limitations.join(' '),/External owner must read/);assert.match(switched.contextPack.limitations.join(' '),/No automatic delivery/);
  const replacement=f.call('owners.get',{ownerId:switched.ownerId});assert.equal(replacement.mode,'manual');assert.equal(replacement.host.ownsHost,false);assert.equal(replacement.host.verified,false);assert.equal(replacement.messages,undefined);
  const loaded=new TaskStore(f.store.path);assert.equal(loaded.get(task.id).continuationHistory?.[0].acknowledgementId,null);
  const handler=new CommandHandler(new TaskManager(loaded,new MockWorkerAdapter(process.execPath,resolve('scripts/mock-worker.mjs'))),f.policy,blockedLaunch,()=>false);assert.equal(handler.handle({apiVersion:'weaver.v1',command:'owners.continuation.get',args:{taskId:task.id}}).ok,true);handler.draining=true;
  assert.equal(f.raw('owners.switch',{taskId:task.id,expectedRevision:f.store.get(task.id).revision,expectedEpoch:0}).error?.code,'OWNER_EPOCH_CONFLICT');
 }finally{await f.close();}
});
const hostOf=(input:OwnerLaunchInput):OwnerLaunchResult=>({session:'default',workspaceId:'w7',paneId:'w7:p1',agentName:`owner-${input.taskId.slice(0,8)}-${input.epoch}`});
test('owners.switch with launch starts the replacement owner in Herdr and records its host',async()=>{
 const calls:OwnerLaunchInput[]=[];
 const f=setup({herdr:true,launcher:input=>{calls.push(input);return hostOf(input);}});
 try{
  const task=f.call('tasks.create',{title:'Owner host',goal:'fixture',workspace:'/demo/project',ownerProfileId:'codex_owner'});
  const caps=f.call('capabilities.get');assert.equal(caps.ownerSpawn,'herdr');assert.equal(caps.ownerModelSpawned,false);
  assert.equal(f.raw('owners.switch',{taskId:task.id,expectedRevision:task.revision,launch:'yes'}).error?.code,'INVALID_REQUEST');
  const switched=f.call('owners.switch',{taskId:task.id,expectedRevision:task.revision,launch:true});
  assert.equal(switched.ownerEpoch,1);assert.equal(switched.launch.ok,true);
  assert.equal(calls.length,1);const input=calls[0]!;
  assert.equal(input.taskId,task.id);assert.equal(input.epoch,1);assert.equal(input.engineKind,'codex');
  assert.equal(input.model,'gpt-6-astra');assert.equal(input.effort,'high');assert.equal(input.workspace,'/demo/project');
  assert.equal(input.session,undefined,'the launcher owns the default session name');
  assert.equal(input.prompt,switched.prompt);assert.match(input.prompt,/^你将作为父 Agent 接手 Weaver 任务「Owner host」/);
  const stored=f.store.get(task.id);const host=stored.ownerHost!;
  assert.equal(host.kind,'herdr');assert.equal(host.session,'default');assert.equal(host.workspaceId,'w7');assert.equal(host.paneId,'w7:p1');
  assert.equal(host.agentName,`owner-${task.id.slice(0,8)}-1`);assert.ok(Number.isFinite(Date.parse(host.launchedAt)));
  assert.ok(stored.events.some(e=>e.kind==='lifecycle'&&e.message===`Started codex_owner in Herdr (${host.agentName})`),JSON.stringify(stored.events.at(-1)));
  assert.deepEqual(new TaskStore(f.store.path).get(task.id).ownerHost,host);
 }finally{await f.close();}
});
test('owners.switch keeps its rotation when the owner host cannot be launched and offers a retry',async()=>{
 const f=setup({launcher:()=>{throw new OwnerLaunchError('OWNER_LAUNCH_UNSUPPORTED','only claude and codex can host an owner');}});
 try{
  const task=f.call('tasks.create',{title:'Host fail',goal:'fixture',workspace:'/demo/project',ownerProfileId:'codex_owner'});
  const switched=f.call('owners.switch',{taskId:task.id,expectedRevision:task.revision,launch:true});
  assert.equal(switched.ownerEpoch,1);assert.equal(switched.history.length,1);
  assert.deepEqual(switched.launch,{ok:false,code:'OWNER_LAUNCH_UNSUPPORTED',message:'only claude and codex can host an owner'});
  assert.equal(typeof switched.prompt,'string');
  const stored=f.store.get(task.id);assert.equal(stored.ownerHost,undefined);
  assert.equal(stored.events.at(-1)!.kind,'error');assert.match(stored.events.at(-1)!.message,/OWNER_LAUNCH_UNSUPPORTED/);
  const retry=f.call('owners.launch',{taskId:task.id,expectedRevision:stored.revision!});
  assert.equal(retry.launch.ok,false);assert.equal(retry.launch.code,'OWNER_LAUNCH_UNSUPPORTED');assert.equal(typeof retry.prompt,'string');
 }finally{await f.close();}
});
test('owners.switch with a task that has no workspace never reaches Herdr',async()=>{
 const calls:OwnerLaunchInput[]=[];
 const f=setup({launcher:input=>{calls.push(input);return hostOf(input);}});
 try{
  const task=f.call('tasks.create',{title:'No workspace',goal:'fixture',ownerProfileId:'codex_owner'});
  const switched=f.call('owners.switch',{taskId:task.id,expectedRevision:task.revision,launch:true});
  assert.equal(switched.ownerEpoch,1);assert.equal(switched.launch.ok,false);assert.equal(switched.launch.code,'OWNER_LAUNCH_FAILED');
  assert.equal(calls.length,0);assert.equal(f.store.get(task.id).ownerHost,undefined);
 }finally{await f.close();}
});
test('owners.launch relaunches the current owner from the existing pack without rotating again',async()=>{
 const calls:OwnerLaunchInput[]=[];
 const f=setup({launcher:input=>{calls.push(input);return hostOf(input);}});
 try{
  const task=f.call('tasks.create',{title:'Relaunch',goal:'fixture',workspace:'/demo/project',ownerProfileId:'claude_owner'});
  assert.equal(f.raw('owners.launch',{taskId:task.id,expectedRevision:task.revision}).error?.code,'INVALID_STATE','no context pack exists yet');
  assert.equal(f.raw('owners.launch',{taskId:task.id}).error?.code,'INVALID_REQUEST','a relaunch must state the revision it expects');
  const switched=f.call('owners.switch',{taskId:task.id,expectedRevision:task.revision});
  assert.equal(switched.launch,undefined);assert.equal(calls.length,0);
  const before=f.store.get(task.id);
  const relaunched=f.call('owners.launch',{taskId:task.id,expectedRevision:before.revision});
  assert.equal(calls.length,1);const input=calls[0]!;
  assert.equal(input.engineKind,'claude');assert.equal(input.model,'claude-opus-5-5');assert.equal(input.epoch,1);
  assert.equal(input.workspace,'/demo/project');assert.equal(input.prompt,switched.prompt,'the same pack produces the same briefing');
  assert.equal(relaunched.launch.ok,true);assert.equal(relaunched.prompt,switched.prompt);
  assert.equal(relaunched.task.ownerHost.agentName,`owner-${task.id.slice(0,8)}-1`);
  const stored=f.store.get(task.id);
  assert.equal(stored.ownerEpoch,1);assert.equal(stored.continuationHistory?.length,1,'relaunch must not rotate the owner again');
  assert.equal(f.raw('owners.launch',{taskId:task.id,expectedRevision:before.revision}).error?.code,'REVISION_CONFLICT');
 }finally{await f.close();}
});
test('stored ownerHost round-trips and malformed host records are rejected',async()=>{
 const f=setup();try{
  const task=f.call('tasks.create',{title:'Persist',goal:'fixture',ownerProfileId:'codex_owner'});
  const stored=f.store.get(task.id);assert.equal(stored.ownerHost,undefined);
  const host={kind:'herdr' as const,session:'default',workspaceId:'w7',paneId:'w7:p1',agentName:'owner-11111111-1',launchedAt:stored.createdAt};
  assert.deepEqual(parseStoredTask({...stored,ownerHost:host}).ownerHost,host);
  for(const ownerHost of [{...host,kind:'tmux'},{...host,agentName:'Owner-11111111-1'},{...host,agentName:`owner-${'x'.repeat(30)}`},{}]) {
   assert.throws(()=>parseStoredTask({...stored,ownerHost}),/Invalid stored owner host/);
  }
  assert.throws(()=>parseStoredTask({...stored,ownerHost:{...host,paneId:''}}),/Invalid ownerHost paneId/);
 }finally{await f.close();}
});

test('owner prepares an unnamed task before freezing, persists criteria, and cannot rewrite a frozen package',async()=>{
 const f=setup();try{
  const task=f.call('tasks.create',{goal:'Verify project output',ownerProfileId:'codex_owner'});
  assert.equal(task.title,'等待父 Agent 命名');
  assert.equal(f.raw('workers.spawn',{taskId:task.id,provider:'mock-jsonl'}).error?.code,'INVALID_STATE');
  assert.equal(f.raw('packages.create',{taskId:task.id,scope:['fixture'],acceptanceCriteria:['check']}).error?.code,'INVALID_STATE');
  const args={taskId:task.id,expectedRevision:task.revision,title:'Verify project output',acceptanceCriteria:['Run project checks','Report output']};
  assert.equal(f.raw('tasks.describe',{...args,acceptanceCriteria:[]}).error?.code,'INVALID_REQUEST');
  assert.equal(f.store.get(task.id).title,task.title,'invalid description does not partially rename the task');
  const described=f.call('tasks.describe',args);
  assert.equal(described.title,args.title);assert.deepEqual(described.acceptanceCriteria,args.acceptanceCriteria);
  assert.equal(f.raw('tasks.describe',{...args,title:'Stale rename'}).error?.code,'REVISION_CONFLICT');
  const restored=new TaskStore(f.store.path).get(task.id);assert.equal(restored.title,args.title);assert.deepEqual(restored.acceptanceCriteria,args.acceptanceCriteria);
  const pkg=f.call('packages.create',{taskId:task.id,expectedRevision:described.revision,scope:['fixture'],acceptanceCriteria:['Final owner criterion']});
  assert.deepEqual(pkg.acceptanceCriteria,['Final owner criterion']);
  assert.deepEqual(f.store.get(task.id).acceptanceCriteria,args.acceptanceCriteria,'an explicit package criterion list never overwrites the task');
  assert.equal(f.raw('tasks.describe',{...args,expectedRevision:f.store.get(task.id).revision}).error?.code,'INVALID_STATE');
 }finally{await f.close();}
});

test('packages.create defaults to the child task own criteria and the package alone feeds the worker instruction',async()=>{
 const f=setup();try{
  const task=f.call('tasks.create',{goal:'Verify project output',ownerProfileId:'codex_owner'});
  const described=f.call('tasks.describe',{taskId:task.id,expectedRevision:task.revision,title:'Verify project output',acceptanceCriteria:['Run project checks','Report output']});
  const pkg=f.call('packages.create',{taskId:task.id,expectedRevision:described.revision,scope:['fixture']});
  assert.deepEqual(pkg.acceptanceCriteria,['Run project checks','Report output']);
  assert.deepEqual(f.store.get(task.id).acceptanceCriteria,['Run project checks','Report output']);
  const other=f.call('tasks.create',{goal:'No criteria yet',ownerProfileId:'codex_owner'});
  assert.equal(f.raw('packages.create',{taskId:other.id,scope:['fixture']}).ok,false,'a task without criteria needs them explicit');
 }finally{await f.close();}
});

test('workspace browser lists only visible directories and rejects a missing or relative directory',async()=>{
 const f=setup();try{
  const {mkdirSync,writeFileSync}=await import('node:fs');
  mkdirSync(join(f.dir,'project'));mkdirSync(join(f.dir,'.private'));writeFileSync(join(f.dir,'file.txt'),'private content');
  const listed=f.call('workspaces.list',{path:f.dir});
  assert.equal(listed.path,f.dir);assert.deepEqual(listed.directories,[{name:'project',path:join(f.dir,'project')}]);
  assert.equal(f.raw('workspaces.list',{path:'.'}).ok,false);
  assert.equal(f.raw('workspaces.list',{path:join(f.dir,'missing')}).ok,false);
  assert.equal(f.raw('workspaces.list',{path:join(f.dir,'file.txt')}).ok,false);
 }finally{await f.close();}
});
