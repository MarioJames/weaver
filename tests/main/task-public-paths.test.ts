import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../../src/shared/contracts/tasks';
import { publicTask } from '../../src/main/application/tasks/records';
import { briefTaskFields, projectTaskView } from '../../src/main/application/tasks/projection';

for (const withRun of [false, true]) test(`public task projections hide private channel material paths with run=${withRun}`, () => {
  const host = {kind:'herdr' as const,session:'fixture',workspaceId:'workspace',paneId:'pane',tabId:'tab',terminalId:'terminal',createdWorkspace:true,agentName:'owner',launchedAt:'2026-10-24T00:00:00Z'};
  const task:Task={owner:{name:'fixture',transport:'herdr-visible',session:'fixture',pane:'pane'},id:'fixture',title:'Task',instruction:'Fixture',status:'running',progress:0,createdAt:'2026-10-24T00:00:00Z',updatedAt:'2026-10-24T00:00:00Z',events:[],artifacts:[],ownerHost:{...host,channelStateDir:'/private/channel-state',channelProfilePath:'/private/profile',channelEnvironmentPath:'/private/environment'},...(withRun?{run:{id:'run',adapter:'codex',execution:'real' as const,status:'running' as const,channel:'selected',channelStateDir:'/private/run-state',channelProfilePath:'/private/run-profile'}}:{})};
  const original=structuredClone(task);
  const full=publicTask(task);
  assert.deepEqual(full.ownerHost,host);
  const {events,artifacts,...list}=full;
  const surfaces=[full,{...list,artifactCount:artifacts.length},projectTaskView(full,briefTaskFields(task),{view:'brief'}),projectTaskView(full,briefTaskFields(task),{view:'brief',fields:['ownerHost','run']})];
  for(const surface of surfaces){
    assert.equal(JSON.stringify(surface).includes('/private/'),false);
    if(Object.hasOwn(surface,'ownerHost'))assert.deepEqual(surface.ownerHost,host);
  }
  if(withRun){const run=(full as {run?:Task['run']}).run;assert.equal(run?.channel,'selected');assert.equal(Object.hasOwn(run!,'channelStateDir'),false);assert.equal(Object.hasOwn(run!,'channelProfilePath'),false);}
  assert.deepEqual(task,original,'public projection leaves durable cleanup and reattach paths intact');
});

import { createRpcHandlers, type ActiveServices, type RpcHost } from '../../src/main/transport/handlers';

test('all task RPC write responses retain owner contract and hide only channel material paths',async()=>{
 const task:Task={id:'11111111-1111-4111-8111-111111111111',title:'Fixture',instruction:'Fixture',owner:{name:'fixture',transport:'herdr-visible',session:'s',pane:'p'},status:'queued',progress:0,createdAt:'2026-10-24T00:00:00Z',updatedAt:'2026-10-24T00:00:00Z',events:[],artifacts:[],ownerHost:{kind:'herdr',session:'s',workspaceId:'w',paneId:'p',agentName:'owner',launchedAt:'2026-10-24T00:00:00Z',channelStateDir:'/private/host',channelProfilePath:'/private/profile',channelEnvironmentPath:'/private/env'},run:{id:'run',adapter:'codex',status:'running',pid:4242,stateDir:'existing-rpc-state',channel:'selected',channelStateDir:'/private/run',channelProfilePath:'/private/run-profile'}};
 const before=structuredClone(task);
 const active={store:{get:()=>task},commands:{handle:()=>({ok:true,data:{id:task.id}}),handleAsync:async()=>({ok:true})}} as unknown as ActiveServices;
 const handlers=createRpcHandlers({} as RpcHost);
 for(const method of ['createTask','startTask','cancelTask'] as const){
  const args=method==='createTask'?[{title:'Fixture',instruction:'Fixture',owner:task.owner}]:[task.id];
  const result=await handlers[method](active,args) as Task;
  assert.doesNotMatch(JSON.stringify(result),/\/private\//);
  assert.deepEqual(result.owner,task.owner);assert.equal(result.ownerHost?.paneId,'p');assert.equal(result.run?.channel,'selected');
  assert.equal(result.run?.pid,4242,'preserve the existing RPC fields outside this path fix');
  assert.equal(result.run?.stateDir,'existing-rpc-state');
 }
 assert.deepEqual(task,before);
});
