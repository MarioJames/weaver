import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CommandHandler } from '../../src/main/commands';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { PolicyStore } from '../../src/main/policy/store';
import type { OwnerLaunchInput } from '../../src/main/owner-host';
const tick=async()=>{for(let n=0;n<5;n++)await new Promise<void>(r=>setImmediate(r));};
function command(prompt:string,suffix=' --skill'):string {const end=prompt.indexOf(suffix);assert.ok(end>=0);const start=prompt.lastIndexOf('weaver --data-dir ',end);assert.ok(start>=0,'prompt must bind CLI to actual instance');return prompt.slice(start,end+suffix.length);}
function argv(script:string,cwd:string):string[]{return execFileSync('/bin/sh',['-c',`weaver() { printf '%s\\000' "$@"; }; ${script}`],{cwd,encoding:'utf8'}).split('\0').filter(Boolean);}

for(const long of [false,true])test(`root/handoff/switch/continuation bind the ${long?'long':'shell-special'} actual instance across target projects`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'ri-'));const dataDir=join(root,long?'x'.repeat(240):"instance 'quoted' $() ``");const project=join(root,'project');mkdirSync(project);
 const store=new TaskStore(join(dataDir,'weaver.db'));const policy=new PolicyStore(store.db);const manager=new TaskManager(store,{id:'forbidden',start(){throw Error('No worker allowed');}});const captures:OwnerLaunchInput[]=[];
 const handler=new CommandHandler(manager,policy,()=>{throw Error('No real Herdr allowed');},()=>true,undefined,{launcher:async input=>{captures.push(input);return{session:'fake',workspaceId:'fake',paneId:'fake',agentName:`owner-${input.taskId.slice(0,8)}-${input.epoch}`};},closer:async()=>{}});
 const call=async(command:string,args:Record<string,unknown>)=>{const result=await handler.handleAsync({apiVersion:'weaver.v1',command,args,commandId:randomUUID()});assert.equal(result.ok,true,JSON.stringify(result));return result.data as any;};
 try {
  const goal='完整原始目标'.repeat(1000);const task=await call('tasks.create',{ownerProfileId:'codex_owner',workspace:project,goal});await call('tasks.start',{taskId:task.id});await tick();assert.equal(captures.length,1);assert.equal(captures[0]!.workspace,project);assert.ok(captures[0]!.prompt.includes(goal));assert.ok(captures[0]!.prompt.includes(task.id));assert.ok(captures[0]!.prompt.includes(task.ownerId));
  assert.deepEqual(argv(command(captures[0]!.prompt),project),['--data-dir',dataDir,'--skill']);
  assert.deepEqual(argv(command(captures[0]!.prompt,` tasks get --task-id ${task.id}`),project),['--data-dir',dataDir,'--owner-file','<credentialPath>','tasks','get','--task-id',task.id]);
  const queued=await call('tasks.create',{ownerProfileId:'codex_owner',workspace:project,goal:'Actual project handoff'});
  const rotation=await call('owners.switch',{taskId:queued.id,expectedRevision:queued.revision});
  const get=await call('owners.continuation.get',{taskId:queued.id});assert.equal(get.prompt,rotation.prompt);
  await call('owners.launch',{taskId:queued.id,expectedRevision:store.get(queued.id).revision});
  const switched=await call('owners.switch',{taskId:queued.id,expectedRevision:store.get(queued.id).revision,launch:true});
  assert.equal(captures.length,3);for(const prompt of [rotation.prompt,get.prompt,captures[1]!.prompt,switched.prompt,captures[2]!.prompt])assert.deepEqual(argv(command(prompt),project),['--data-dir',dataDir,'--skill']);
  assert.equal(dirname(resolve(store.path)),dataDir);
 } finally {await handler.drain();await manager.shutdown();store.close();rmSync(root,{recursive:true,force:true});}
});
