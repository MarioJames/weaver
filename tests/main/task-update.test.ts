import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandHandler } from '../../src/main/commands';
import { TaskManager } from '../../src/main/manager';
import { TaskStore } from '../../src/main/store';
import { PolicyStore } from '../../src/main/policy/store';
import type { OwnerLaunchInput, OwnerLaunchResult } from '../../src/main/owner-host';

const blockedLaunch=(input:OwnerLaunchInput):OwnerLaunchResult=>{throw new Error(`Test did not inject an owner launcher for ${input.taskId}`);};

function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'weaver-task-update-'));
 const store=new TaskStore(join(dir,'weaver.db'));const policy=new PolicyStore(join(dir,'weaver.db'));
 const manager=new TaskManager(store,{id:'forbidden',start(){throw new Error('No worker process allowed');}});
 const handler=new CommandHandler(manager,policy,blockedLaunch,()=>false);
 const raw=(command:string,args:Record<string,unknown>={},commandId:string=randomUUID())=>handler.handle({apiVersion:'weaver.v1',command,args,commandId});
 const call=(command:string,args:Record<string,unknown>={},commandId?:string):any=>{const response=raw(command,args,commandId);assert.equal(response.ok,true,JSON.stringify(response));return response.data;};
 const draft=(args:Record<string,unknown>={})=>call('tasks.create',{goal:'原始目标',workspace:'/tmp/weaver-draft-ws',acceptanceCriteria:['旧标准'],constraints:['保留约束'],ownerProfileId:'codex_owner',...args});
 return {dir,store,policy,manager,handler,raw,call,draft,async close(){await manager.shutdown();rmSync(dir,{recursive:true,force:true});}};
}

test('tasks.update edits a draft goal and keeps unprovided fields, bumping revision with one lifecycle event',async()=>{
 const f=fixture();try{
  const task=f.draft();const revision=task.revision;const eventCount=task.events.length;
  const updated=f.call('tasks.update',{taskId:task.id,expectedRevision:revision,goal:'新的完整目标'});
  assert.equal(updated.instruction,'新的完整目标');
  assert.equal(updated.workspace,'/tmp/weaver-draft-ws');
  assert.deepEqual(updated.constraints,['保留约束']);
  assert.deepEqual(updated.acceptanceCriteria,['旧标准']);
  assert.equal(updated.status,'queued');assert.equal(updated.parentTaskId,undefined);assert.equal(updated.title,'等待父 Agent 命名');
  assert.equal(updated.revision,revision+1);
  assert.equal(updated.events.length,eventCount+1);
  assert.equal(updated.events.at(-1).kind,'lifecycle');assert.equal(updated.events.at(-1).message,'Draft edited before start');
  const persisted=new TaskStore(f.store.path).get(task.id);
  assert.equal(persisted.instruction,'新的完整目标');assert.equal(persisted.revision,revision+1);
  assert.ok(persisted.events.some(e=>e.kind==='lifecycle'&&e.message==='Draft edited before start'));
 }finally{await f.close();}
});

test('tasks.update accepts instruction as a synonym of goal, clears workspace with null and acceptanceCriteria with an empty array',async()=>{
 const f=fixture();try{
  const task=f.draft();
  const updated=f.call('tasks.update',{taskId:task.id,expectedRevision:task.revision,instruction:'instruction 同义写法'});
  assert.equal(updated.instruction,'instruction 同义写法');
  const cleared=f.call('tasks.update',{taskId:task.id,expectedRevision:updated.revision,workspace:null});
  assert.equal(cleared.workspace,undefined);
  assert.equal(new TaskStore(f.store.path).get(task.id).workspace,undefined);
  const criteria=f.call('tasks.update',{taskId:task.id,expectedRevision:cleared.revision,acceptanceCriteria:['  新标准  ','second']});
  assert.deepEqual(criteria.acceptanceCriteria,['新标准','second']);
  const empty=f.call('tasks.update',{taskId:task.id,expectedRevision:criteria.revision,acceptanceCriteria:[]});
  assert.equal(empty.acceptanceCriteria,undefined);
  assert.equal(new TaskStore(f.store.path).get(task.id).acceptanceCriteria,undefined);
 }finally{await f.close();}
});

test('tasks.update switches a web-created draft to another profile by spawning a fresh Task owner and leaving the old one intact',async()=>{
 const f=fixture();try{
  const task=f.draft();
  const oldOwner=f.store.getOwner(task.ownerId)!;
  assert.equal(oldOwner.profileId,'codex_owner');assert.equal(oldOwner.session,'external-cli');
  const ownersBefore=f.store.listOwners().length;
  const updated=f.call('tasks.update',{taskId:task.id,expectedRevision:task.revision,ownerProfileId:'claude_owner'});
  assert.notEqual(updated.ownerId,task.ownerId);
  const newOwner=f.store.getOwner(updated.ownerId)!;
  assert.equal(newOwner.profileId,'claude_owner');assert.equal(newOwner.name,'Task owner');
  assert.equal(f.store.getOwner(task.ownerId)!.profileId,'codex_owner');
  assert.equal(f.store.listOwners().length,ownersBefore+1);
  assert.equal(f.store.get(task.id).ownerEpoch,0);assert.ok(f.store.get(task.id).ownerLastActivityAt);
  assert.equal(new TaskStore(f.store.path).get(task.id).ownerId,updated.ownerId);
  assert.equal(new TaskStore(f.store.path).getOwner(updated.ownerId)!.profileId,'claude_owner');
  assert.equal(new TaskStore(f.store.path).getOwner(task.ownerId)!.profileId,'codex_owner');
  assert.equal(new TaskStore(f.store.path).get(task.id).revision,task.revision+1);
  assert.ok(new TaskStore(f.store.path).get(task.id).events.some(e=>e.kind==='lifecycle'&&e.message==='Draft edited before start'));
 }finally{await f.close();}
});

test('tasks.update switches a shared draft to another profile without touching the other task\'s owner binding',async()=>{
 const f=fixture();try{
  const first=f.draft();const owner=f.store.getOwner(first.ownerId)!;
  const second=f.call('tasks.create',{goal:'第二个',ownerId:owner.id});
  assert.equal(second.ownerId,owner.id);
  const updated=f.call('tasks.update',{taskId:first.id,expectedRevision:first.revision,ownerProfileId:'claude_owner'});
  assert.notEqual(updated.ownerId,owner.id);
  assert.equal(f.store.getOwner(updated.ownerId)!.profileId,'claude_owner');
  assert.equal(f.store.get(second.id).ownerId,owner.id);
  assert.equal(f.store.get(second.id).revision,second.revision);
  assert.equal(f.store.getOwner(owner.id)!.profileId,'codex_owner');
 }finally{await f.close();}
});

test('tasks.update rejects malformed requests without touching the task',async()=>{
 const f=fixture();try{
  const task=f.draft();const revision=task.revision;
  assert.equal(f.raw('tasks.update',{taskId:task.id,goal:'x'}).error?.code,'INVALID_REQUEST');
  assert.equal(f.raw('tasks.update',{taskId:task.id,expectedRevision:'0',goal:'x'}).error?.code,'INVALID_REQUEST');
  assert.equal(f.raw('tasks.update',{taskId:task.id,expectedRevision:1.5,goal:'x'}).error?.code,'INVALID_REQUEST');
  assert.equal(f.raw('tasks.update',{taskId:task.id,expectedRevision:revision+99,goal:'x'}).error?.code,'REVISION_CONFLICT');
  assert.equal(f.raw('tasks.update',{taskId:task.id,expectedRevision:revision,workspace:'relative/path'}).error?.code,'INVALID_REQUEST');
  assert.equal(f.raw('tasks.update',{taskId:task.id,expectedRevision:revision,acceptanceCriteria:Array.from({length:31},(_,i)=>`c${i}`)}).error?.code,'INVALID_REQUEST');
  assert.equal(f.raw('tasks.update',{taskId:task.id,expectedRevision:revision,acceptanceCriteria:['']}).error?.code,'INVALID_REQUEST');
  assert.equal(f.raw('tasks.update',{taskId:task.id,expectedRevision:revision,goal:''}).error?.code,'INVALID_REQUEST');
  assert.equal(f.raw('tasks.update',{taskId:task.id,expectedRevision:revision,ownerProfileId:'missing_profile'}).error?.code,'INVALID_REQUEST');
  const after=f.store.get(task.id);
  assert.equal(after.instruction,'原始目标');assert.equal(after.revision,revision);
  assert.equal(after.workspace,'/tmp/weaver-draft-ws');assert.deepEqual(after.acceptanceCriteria,['旧标准']);
 }finally{await f.close();}
});

test('tasks.update rejects anything but an unstarted root draft and leaves the task unchanged',async()=>{
 const f=fixture();try{
  const child=f.draft();const stored=f.store.get(child.id);stored.parentTaskId=randomUUID();f.store.put(stored);
  const childBefore=f.store.get(child.id);
  assert.equal(f.raw('tasks.update',{taskId:child.id,expectedRevision:childBefore.revision,goal:'x'}).error?.code,'INVALID_STATE');
  const started=f.draft();const startedRecord=f.store.get(started.id);startedRecord.executionRole='owner';f.store.put(startedRecord);
  const startedBefore=f.store.get(started.id);
  assert.equal(f.raw('tasks.update',{taskId:started.id,expectedRevision:startedBefore.revision,goal:'x'}).error?.code,'INVALID_STATE');
  const running=f.draft();const runningRecord=f.store.get(running.id);runningRecord.status='running';f.store.put(runningRecord);
  const runningBefore=f.store.get(running.id);
  assert.equal(f.raw('tasks.update',{taskId:running.id,expectedRevision:runningBefore.revision,goal:'x'}).error?.code,'INVALID_STATE');
  const scheduled=f.draft();const scheduledRecord=f.store.get(scheduled.id);scheduledRecord.scheduled=true;f.store.put(scheduledRecord);
  const scheduledBefore=f.store.get(scheduled.id);
  assert.equal(f.raw('tasks.update',{taskId:scheduled.id,expectedRevision:scheduledBefore.revision,goal:'x'}).error?.code,'INVALID_STATE');
  // A frozen package blocks editing.
  const frozen=f.draft();
  f.call('tasks.describe',{taskId:frozen.id,expectedRevision:f.store.get(frozen.id).revision,title:'Real title',acceptanceCriteria:['可交付']});
  f.call('packages.create',{taskId:frozen.id,scope:['fixture scope'],acceptanceCriteria:['verified']});
  const frozenBefore=f.store.get(frozen.id);
  assert.equal(f.raw('tasks.update',{taskId:frozen.id,expectedRevision:frozenBefore.revision,goal:'x'}).error?.code,'INVALID_STATE');
  for(const [before,id] of [[childBefore,child.id],[startedBefore,started.id],[runningBefore,running.id],[scheduledBefore,scheduled.id],[frozenBefore,frozen.id]] as const){
   const after=f.store.get(id);
   assert.deepEqual({instruction:after.instruction,revision:after.revision,status:after.status,workspace:after.workspace},{instruction:before.instruction,revision:before.revision,status:before.status,workspace:before.workspace},id);
  }
 }finally{await f.close();}
});

test('tasks.update refuses an unknown profile and leaves the task and owners list unchanged',async()=>{
 const f=fixture();try{
  const task=f.draft();const revision=task.revision;const ownersBefore=f.store.listOwners().length;
  const rejected=f.raw('tasks.update',{taskId:task.id,expectedRevision:revision,ownerProfileId:'missing_profile'});
  assert.equal(rejected.error?.code,'INVALID_REQUEST');
  const after=f.store.get(task.id);
  assert.equal(after.ownerId,task.ownerId);assert.equal(after.revision,revision);
  assert.equal(f.store.listOwners().length,ownersBefore);
 }finally{await f.close();}
});

test('tasks.update with an invalid field together with ownerProfileId spawns no owner',async()=>{
 const f=fixture();try{
  const task=f.draft();const ownersBefore=f.store.listOwners().length;
  const rejected=f.raw('tasks.update',{taskId:task.id,expectedRevision:task.revision,ownerProfileId:'claude_owner',workspace:'relative/path'});
  assert.equal(rejected.error?.code,'INVALID_REQUEST');
  assert.equal(f.store.listOwners().length,ownersBefore);
  assert.equal(f.store.get(task.id).ownerId,task.ownerId);
 }finally{await f.close();}
});

test('tasks.update with the same profile keeps the owner binding and spawns no owner',async()=>{
 const f=fixture();try{
  const task=f.draft();const ownersBefore=f.store.listOwners().length;
  const updated=f.call('tasks.update',{taskId:task.id,expectedRevision:task.revision,ownerProfileId:'codex_owner',goal:'同 profile 编辑'});
  assert.equal(updated.ownerId,task.ownerId);assert.equal(updated.instruction,'同 profile 编辑');
  assert.equal(f.store.listOwners().length,ownersBefore);
  assert.equal(f.store.getOwner(task.ownerId)!.profileId,'codex_owner');
 }finally{await f.close();}
});

test('tasks.start refuses a workspace-less root task before changing any state',async()=>{
 const f=fixture();try{
  const task=f.draft({workspace:undefined});
  const before=f.store.get(task.id);
  assert.equal(before.workspace,undefined);
  const rejected=f.raw('tasks.start',{taskId:task.id,expectedRevision:before.revision});
  assert.equal(rejected.error?.code,'INVALID_STATE');
  assert.match(rejected.error?.message??'',/workspace/i);
  const after=f.store.get(task.id);
  assert.equal(after.status,'queued');assert.equal(after.revision,before.revision);
  assert.equal(after.executionRole,undefined);assert.equal(after.run,undefined);assert.equal(after.ownerHost,undefined);
  assert.equal(after.events.length,before.events.length);
  // The same task starts once a workspace exists, so the guard does not block described drafts.
  const updated=f.call('tasks.update',{taskId:task.id,expectedRevision:before.revision,workspace:'/tmp'});
  assert.equal(updated.workspace,'/tmp');
 }finally{await f.close();}
});
