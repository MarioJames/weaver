import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {launchOwner, closeOwnerHost, ownerAgentName, herdrOnPath, defaultRunner, OWNER_AGENT_START_TIMEOUT_MS, OwnerLaunchError, type Runner, type RunnerInput} from '../../src/main/owner-host';
import {findExecutableSync} from '../../src/main/system/executables';
const HERDR='/opt/fake-herdr/herdr';
const CLAUDE='/opt/fake-claude/claude';
const START_TIMEOUT=String(OWNER_AGENT_START_TIMEOUT_MS);
const WS_LIST_OK=JSON.stringify({result:{type:'workspace_list',workspaces:[]}});
const PANE_LIST_OK=JSON.stringify({result:{type:'pane_list',panes:[]}});
const TAB_CLOSE_OK=JSON.stringify({result:{type:'ok'}});
type Step={stdout?:string;stderr?:string;code?:number};
type Script={workspaceList?:Step;paneList?:Step|((workspaceId:string)=>Step|undefined);create?:Step;claudeHelp?:string|null;start?:Step;get?:Step;prompt?:Step;rename?:Step;close?:Step;tabCreate?:Step;tabClose?:Step};
function fakeRunner(script:Script={},calls:RunnerInput[]=[]):Runner{
 let unexpected=0;
 return input=>{
  calls.push(input);
  if(input.file===CLAUDE){const help=script.claudeHelp;if(help===undefined)return {code:1,stdout:'',stderr:'unexpected claude probe'};if(help===null)return {code:1,stdout:'',stderr:'claude --help exited non-zero'};return {code:0,stdout:help,stderr:''};}
  const group=input.args[2],action=input.args[3];
  const known=(group==='workspace'&&['list','create','close'].includes(String(action)))||(group==='pane'&&action==='list')||(group==='tab'&&['create','close'].includes(String(action)))||(group==='agent'&&['start','get','prompt','rename'].includes(String(action)));
  // An unknown command group or action is a launcher bug, never a silent success.
  if(!known){unexpected++;return {code:1,stdout:'',stderr:`unexpected herdr call #${unexpected}`};}
  const step=group==='workspace'?(action==='list'?script.workspaceList:action==='create'?script.create:script.close)
    :group==='pane'?script.paneList
    :group==='tab'?(action==='create'?script.tabCreate:script.tabClose)
    :(action==='start'?script.start:action==='get'?script.get:action==='rename'?script.rename:script.prompt);
  if(group==='pane'){const resolved=typeof step==='function'?step(input.args[5]??''):step as Step|undefined;return {code:0,stdout:PANE_LIST_OK,stderr:'',...(resolved??{})};}
  if(group==='workspace'&&action==='list')return {code:0,stdout:WS_LIST_OK,stderr:'',...(step as Step|undefined)};
  if(group==='tab'&&action==='close')return {code:0,stdout:TAB_CLOSE_OK,stderr:'',...(step as Step|undefined)};
  return {code:0,stdout:'',stderr:'',...(step as Step|undefined)};
 };
}
const createOk=JSON.stringify({result:{workspace:{workspace_id:'w7'},tab:{tab_id:'w7:t1'},root_pane:{pane_id:'w7:p1'}}});
const tabCreateOk=JSON.stringify({result:{tab:{tab_id:'w9:t2',workspace_id:'w9'},root_pane:{pane_id:'w9:p2'},type:'tab_created'}});
const promptOk=JSON.stringify({result:{status:'submitted'}});
const launch=(overrides:Partial<Parameters<typeof launchOwner>[0]>={},runner:Runner)=>launchOwner({taskId:'11111111-1111-4111-8111-111111111111',epoch:1,title:'Fixture title',workspace:'/srv/proj',engineKind:'claude',model:'claude-opus-5-5',effort:'high',prompt:'continue the fixture work now',runner,herdrPath:HERDR,pathEnv:'',...overrides});
const codeOf=(error:unknown):string=>error instanceof OwnerLaunchError?error.code:'<none>';
const createResult={session:'default',workspaceId:'w7',paneId:'w7:p1',tabId:'w7:t1',createdWorkspace:true,agentName:'owner-11111111-1'};
test('claude launch drives herdr through argv arrays, detects the effort flag and parses the workspace JSON',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},claudeHelp:'--effort <level>   Effort level for the current session'},calls);
 const result=launch({claudePath:CLAUDE},runner);
 assert.deepEqual(result,createResult);
 assert.deepEqual(calls[0],{file:HERDR,args:['--session','default','workspace','create','--cwd','/srv/proj','--label','proj','--no-focus'],timeout:30000});
 assert.deepEqual(calls[1],{file:CLAUDE,args:['--help'],timeout:15000});
 assert.deepEqual(calls[2],{file:HERDR,args:['--session','default','agent','start','owner-11111111-1','--kind','claude','--pane','w7:p1','--timeout',START_TIMEOUT,'--','--model','claude-opus-5-5','--effort','high'],timeout:70000});
 assert.deepEqual(calls[3],{file:HERDR,args:['--session','default','agent','get','w7:p1'],timeout:15000});
 assert.deepEqual(calls[4],{file:HERDR,args:['--session','default','agent','prompt','w7:p1','continue the fixture work now'],timeout:60000});
 assert.deepEqual(calls[5],{file:HERDR,args:['--session','default','agent','rename','w7:p1','--clear'],timeout:15000});
 assert.equal(calls.length,6);
 assert.match(result.agentName,/^[a-z][a-z0-9_-]{0,31}$/);
});
test('codex launch skips the help probe and passes the effort config as one argv element',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:JSON.stringify({result:{workspace:{workspace_id:'w7'},root_pane:{pane_id:'w7:p2'}}})}},calls);
 const result=launch({engineKind:'codex',model:'gpt-6-astra',session:'work'},runner);
 assert.equal(result.session,'work');assert.equal(result.workspaceId,'w7');assert.equal(result.paneId,'w7:p2');assert.equal(result.createdWorkspace,true);
 assert.equal(calls.length,5);
 assert.deepEqual(calls[1].args,['--session','work','agent','start','owner-11111111-1','--kind','codex','--pane','w7:p2','--timeout',START_TIMEOUT,'--','-m','gpt-6-astra','-c','model_reasoning_effort="high"']);
 assert.ok(!calls.some(call=>call.file===CLAUDE));
 const promptCall=calls[3];
 assert.equal(promptCall.args[4],'w7:p2');
 assert.equal(promptCall.args[5],'continue the fixture work now');
 assert.equal(promptCall.args.length,6);
 assert.deepEqual(calls[4].args,['--session','work','agent','rename','w7:p2','--clear']);
});
test('the workspace label is the workspace directory name, with or without a trailing slash, never the task title',()=>{
 for(const workspace of ['/srv/proj','/srv/proj/','/srv/proj//']){
  const calls:RunnerInput[]=[];
  launch({workspace,title:'等待父 Agent 生成标题'},fakeRunner({create:{stdout:createOk}},calls));
  const create=calls[0];
  assert.equal(create.args[6],'--label');
  assert.equal(create.args[7],'proj');
  assert.ok(!create.args.includes('等待父 Agent 生成标题'));
 }
});
test('an empty directory name falls back to the title truncated to 40 characters',()=>{
 const calls:RunnerInput[]=[];
 launch({workspace:'/',title:'T'.repeat(64)},fakeRunner({create:{stdout:createOk}},calls));
 const create=calls[0];
 assert.equal(create.args[6],'--label');
 assert.equal(create.args[7]!.length,40);
 assert.ok(create.args[7]!.startsWith('TTT'));assert.ok(!create.args[7]!.includes('…'));
});
test('prompt addresses the pane id, then the agent name is cleared; the launch result keeps the original name',()=>{
 const calls:RunnerInput[]=[];
 const result=launch({},fakeRunner({create:{stdout:createOk}},calls));
 assert.equal(result.agentName,'owner-11111111-1');
 assert.deepEqual(calls.map(call=>[call.args[2],call.args[3],call.args[4]]),[['workspace','create','--cwd'],['agent','start','owner-11111111-1'],['agent','get','w7:p1'],['agent','prompt','w7:p1'],['agent','rename','w7:p1']]);
 assert.equal(calls[4]!.args[5],'--clear');
});
test('a failing or throwing rename --clear is cosmetic: the launch succeeds and nothing is closed',()=>{
 for(const mode of ['exit','envelope','throw'] as const){
  const calls:RunnerInput[]=[];
  const base=fakeRunner({create:{stdout:createOk},rename:mode==='exit'?{code:1,stderr:'rename refused'}:mode==='envelope'?{stdout:JSON.stringify({error:{code:'agent_not_found',message:'gone'}})}:undefined},calls);
  const runner:Runner=input=>{if(mode==='throw'&&input.args[3]==='rename'){calls.push(input);throw new Error('rename exploded');}return base(input);};
  assert.deepEqual(launch({},runner),createResult);
  assert.equal(calls.at(-1)!.args[3],'rename');
  assert.ok(!calls.some(call=>call.args.includes('close')));
 }
});
test('a failed prompt never reaches rename',()=>{
 const calls:RunnerInput[]=[];
 assert.throws(()=>launch({},fakeRunner({create:{stdout:createOk},prompt:{code:1,stderr:'agent_blocked'}},calls)),()=>true);
 assert.ok(!calls.some(call=>call.args[3]==='rename'));
});
test('claude help without an effort flag, or failing, keeps only --model',()=>{
 for(const help of [null,'usage: claude [options]','--effort'.split('').reverse().join('')+' <level>'] as const){
  const calls:RunnerInput[]=[];
  const runner=fakeRunner({create:{stdout:createOk},claudeHelp:help as string|null},calls);
   launch({claudePath:CLAUDE},runner);
   assert.equal(calls.length,6);
   assert.ok(!calls[2]!.args.includes('--effort'));
  assert.deepEqual(calls[2]!.args.slice(-2),['--model','claude-opus-5-5']);
 }
});
test('no claude on PATH means no probe at all',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk}},calls);
 launch({},runner);
 assert.equal(calls.length,5);
 assert.ok(!calls[1]!.args.includes('--effort'));
});
test('unsupported engine kinds fail before any herdr call',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({},calls);
 assert.throws(()=>launch({engineKind:'grok'},runner),error=>{assert.equal(codeOf(error),'OWNER_LAUNCH_UNSUPPORTED');return true;});
 assert.equal(calls.length,0);
});
test('missing herdr on PATH fails as unavailable before any herdr call',()=>{
 const createCalls:RunnerInput[]=[];
 const runner=fakeRunner({},createCalls);
 assert.throws(()=>launch({herdrPath:undefined},runner),error=>{assert.equal(codeOf(error),'OWNER_LAUNCH_UNAVAILABLE');return true;});
 assert.equal(createCalls.length,0);
 assert.equal(herdrOnPath(''),false);
});
test('step failures report the step with stderr capped at 500 characters and skip cleanup',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{code:1,stderr:`trace-prefix ${'x'.repeat(900)}`}},calls);
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.ok(error.message.startsWith('herdr workspace create failed (exit 1): trace-prefix '));
  assert.ok(error.message.length<=600);
  return true;});
 assert.equal(calls.length,1);
 assert.ok(!calls.some(call=>call.args.includes('close')));
});
test('unparseable create JSON fails the launch without touching any other resource',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:'plain text, not JSON'}},calls);
 assert.throws(()=>launch({},runner),error=>{assert.ok(error instanceof Error);assert.match(error.message,/workspace create returned unparseable JSON/);return true;});
 assert.equal(calls.length,1);
});
test('a create response without a root pane closes its tab, or the workspace when no tab receipt exists',()=>{
 for(const [create,closeArgs] of [
  ['{"result":{"workspace":{"workspace_id":"w7"},"tab":{"tab_id":"w7:t1"}}}',['--session','default','tab','close','w7:t1']],
  ['{"result":{"workspace":{"workspace_id":"w7"},"root_pane":"w7:p4"}}',['--session','default','workspace','close','w7']],
 ] as const){
  const calls:RunnerInput[]=[];
  const runner=fakeRunner({create:{stdout:create},close:{stdout:'{"result":{"type":"ok"}}'}},calls);
  assert.throws(()=>launch({},runner),error=>{assert.ok(error instanceof Error);assert.match(error.message,/no root pane id/);return true;});
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1]!.args,closeArgs);
 }
});
test('a failed cleanup of a paneless workspace is reported inside the launch failure',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:'{"result":{"workspace":{"workspace_id":"w7"}}}'},close:{code:1,stderr:'workspace is busy'}},calls);
 assert.throws(()=>launch({},runner),error=>{
  assert.ok(error instanceof Error);
  assert.match(error.message,/no root pane id; herdr workspace close cleanup also failed \(exit 1\): workspace is busy/);
  return true;});
 assert.equal(calls.length,2);
});
test('a create response with no documented workspace id never launches, prompts or closes a guessed workspace',()=>{
 const shapes=['{"result":{"root_pane":{"pane_id":"w8:p4"}}}','{"result":{"workspace":"w8","root_pane":{"pane_id":"w8:p4"}}}','{"workspace":{"workspace_id":"w8"},"root_pane":{"pane_id":"w8:p4"}}','{"result":{"workspace":{"workspace_id":"  "},"root_pane":{"pane_id":"w8:p4"}}}','{"result":{"not_pane":true}}'] as const;
 for(const stdout of shapes){
  const calls:RunnerInput[]=[];
  assert.throws(()=>launch({},fakeRunner({create:{stdout},start:{stdout:createOk},prompt:{stdout:promptOk}},calls)),error=>{
   assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
   assert.ok(error instanceof Error);
   assert.match(error.message,/workspace create returned no workspace id/);
   return true;});
  assert.deepEqual(calls.map(call=>[call.args[2],call.args[3]]),[['workspace','create']]);
 }
});
test('cleanup closes the documented tab id, not a prefix of the pane id',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:JSON.stringify({result:{workspace:{workspace_id:'ws-42'},tab:{tab_id:'w8:t1'},root_pane:{pane_id:'w8:p4'}}})},start:{code:1,stderr:'boom'}},calls);
 assert.throws(()=>launch({},runner),error=>{assert.ok(error instanceof Error);assert.match(error.message,/agent start failed/);return true;});
 assert.equal(calls.length,3);
 assert.deepEqual(calls[2]!.args,['--session','default','tab','close','w8:t1']);
});
test('a failing agent start closes only the tab it created',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},start:{code:1,stderr:'agent_not_ready: pane never reached a prompt'}},calls);
 assert.throws(()=>launch({},runner),error=>{assert.ok(error instanceof Error);assert.match(error.message,/agent start failed \(exit 1\)/);assert.match(error.message,/agent_not_ready/);return true;});
 const close=calls[2];
 assert.deepEqual(close.args,['--session','default','tab','close','w7:t1']);
 assert.equal(close.timeout,15000);
 assert.equal(calls.length,3);
 assert.ok(!calls.some(call=>call.args[2]==='workspace'&&call.args[3]==='close'));
});
test('failed cleanup is reported inside the launch failure',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},start:{code:1,stderr:'agent start blew up'},tabClose:{code:1,stderr:`close ${'y'.repeat(900)}`}},calls);
 assert.throws(()=>launch({},runner),error=>{
  assert.ok(error instanceof Error);
  assert.match(error.message,/tab close cleanup also failed \(exit 1\): close /);
  assert.ok(!error.message.includes('y'.repeat(301)));
  return true;});
 assert.equal(calls.length,3);
});
test('a failing prompt submission also cleans up the created tab',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},prompt:{code:1,stderr:'agent_blocked'}},calls);
 assert.throws(()=>launch({},runner),error=>{assert.match((error as Error).message,/agent prompt failed \(exit 1\)/);return true;});
 assert.deepEqual(calls[4]!.args,['--session','default','tab','close','w7:t1']);
 assert.equal(calls.length,5);
});
test('a runner that throws on workspace create reports the step and closes nothing',()=>{
 const calls:RunnerInput[]=[];
 const runner:Runner=input=>{calls.push(input);throw new Error('runner exploded');};
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.match(error.message,/workspace create failed: runner exploded/);
  return true;});
 assert.equal(calls.length,1);
 assert.ok(!calls.some(call=>call.args.includes('close')));
});
test('a runner that throws after workspace create still closes exactly the created tab',()=>{
 const calls:RunnerInput[]=[];
 const runner:Runner=input=>{
  calls.push(input);
  if(input.args[2]==='workspace'&&input.args[3]==='create')return {code:0,stdout:createOk,stderr:''};
  if(input.args[2]==='tab'&&input.args[3]==='close')return {code:0,stdout:TAB_CLOSE_OK,stderr:''};
  throw new Error('agent start crashed');
 };
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.match(error.message,/agent start failed: agent start crashed/);
  return true;});
 assert.deepEqual(calls[2]!.args,['--session','default','tab','close','w7:t1']);
 assert.equal(calls.length,3);
});
test('a failure envelope with exit code 0 fails agent start, skips the prompt and closes the created tab',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},start:{stdout:JSON.stringify({id:'cli:agent:start',error:{code:'agent_not_ready',message:'pane never reached a prompt'}})}},calls);
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.match(error.message,/agent start failed \(exit 0\): agent_not_ready: pane never reached a prompt/);
  return true;});
 assert.ok(!calls.some(call=>call.args[2]==='agent'&&call.args[3]==='prompt'));
 assert.deepEqual(calls[2]!.args,['--session','default','tab','close','w7:t1']);
 assert.equal(calls.length,3);
});
test('a blocked agent prompt envelope with exit code 0 fails the launch and closes the created tab',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},prompt:{stdout:JSON.stringify({id:'cli:agent:prompt',error:{code:'agent_blocked',message:'agent is blocked'}})}},calls);
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.match(error.message,/agent prompt failed \(exit 0\): agent_blocked: agent is blocked/);
  return true;});
 assert.deepEqual(calls[4]!.args,['--session','default','tab','close','w7:t1']);
 assert.equal(calls.length,5);
});
test('documented success envelopes are not mistaken for failures',()=>{
 const started=JSON.stringify({id:'cli:agent:start',result:{type:'agent_started',agent:{pane_id:'w7:p1',name:'owner-11111111-1',agent_status:'idle'},argv:['claude','--model','claude-opus-5-5']}});
 for(const prompt of [promptOk, JSON.stringify({id:'cli:agent:prompt',result:{type:'agent_prompted',agent:{pane_id:'w7:p1',agent_status:'working'}}})]){
  const calls:RunnerInput[]=[];
  const runner=fakeRunner({create:{stdout:createOk},start:{stdout:started},prompt:{stdout:prompt}},calls);
  assert.deepEqual(launch({},runner),createResult);
  assert.equal(calls.length,5);
 }
});
test('agent start records the pane terminal id, and a failed identity read never fails the launch',()=>{
 const calls:RunnerInput[]=[];
 const withTerminal=fakeRunner({create:{stdout:createOk},get:{stdout:JSON.stringify({result:{agent:{pane_id:'w7:p1',terminal_id:'term-42'}}})}},calls);
 assert.deepEqual(launch({},withTerminal),{...createResult,terminalId:'term-42'});
 assert.deepEqual(calls[2].args,['--session','default','agent','get','w7:p1']);
 for(const get of [{code:1,stderr:'pane metadata unavailable'},{stdout:'{"error":{"code":"gone","message":"agent exited"}}'},{stdout:'not json'}] as const){
  const failedCalls:RunnerInput[]=[];
  const result=launch({},fakeRunner({create:{stdout:createOk},get},failedCalls));
  assert.equal(result.terminalId,undefined);
  assert.deepEqual(result,createResult);
  assert.equal(failedCalls.length,5);
 }
});
test('a cleanup that throws is appended to the launch failure it recovers from',()=>{
 const calls:RunnerInput[]=[];
 const runner:Runner=input=>{
  calls.push(input);
  if(input.args[2]==='workspace'&&input.args[3]==='create')return {code:0,stdout:createOk,stderr:''};
  if(input.args[2]==='agent'&&input.args[3]==='start')return {code:1,stdout:'',stderr:'agent start failed on purpose'};
  if(input.args[2]==='tab'&&input.args[3]==='close')throw new Error('close socket gone');
  return {code:0,stdout:'',stderr:''};
 };
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.match(error.message,/agent start failed \(exit 1\): agent start failed on purpose/);
  assert.match(error.message,/tab close cleanup also failed: close socket gone/);
  return true;});
 assert.equal(calls.length,3);
 assert.ok(!calls.some(call=>call.args[2]==='agent'&&call.args[3]==='prompt'));
});
test('a cleanup reporting a failure envelope with exit code 0 is still reported as cleanup failure',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},start:{code:1,stderr:'nope'},tabClose:{stdout:JSON.stringify({id:'cli:tab:close',error:{code:'confirmation_required',message:'closing would remove a worktree parent'}})}},calls);
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.match(error.message,/agent start failed \(exit 1\): nope/);
  assert.match(error.message,/tab close cleanup also failed \(exit 0\): confirmation_required: closing would remove a worktree parent/);
  return true;});
 assert.equal(calls.length,3);
});
test('an exact directory match reuses that workspace with one unfocused tab and never creates a workspace',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'wv-owner-reuse-')));
 try{
  const calls:RunnerInput[]=[];
  const workspaceList={stdout:JSON.stringify({result:{type:'workspace_list',workspaces:[{workspace_id:'w3B',number:14},{workspace_id:'w1',number:2}]}})};
  const paneList=(id:string):Step=>({stdout:JSON.stringify({result:{type:'pane_list',panes:id==='w3B'?[{pane_id:'w3B:p1',cwd:`${dir}/`}]:[{pane_id:'w1:p1',cwd:'/srv/elsewhere'}]}})});
  const runner=fakeRunner({workspaceList,paneList,tabCreate:{stdout:tabCreateOk}},calls);
  const result=launch({workspace:dir},runner);
  assert.deepEqual(result,{session:'default',workspaceId:'w3B',paneId:'w9:p2',tabId:'w9:t2',createdWorkspace:false,agentName:'owner-11111111-1'});
  assert.deepEqual(calls[0].args,['--session','default','workspace','list']);
  assert.deepEqual(calls[1].args,['--session','default','pane','list','--workspace','w3B']);
  assert.deepEqual(calls[2].args,['--session','default','pane','list','--workspace','w1']);
  assert.deepEqual(calls[3],{file:HERDR,args:['--session','default','tab','create','--workspace','w3B','--cwd',dir,'--label','Fixture title'],timeout:30000});
  assert.equal(calls[4]!.args[8],'w9:p2');
  assert.ok(!calls.some(call=>call.args[2]==='workspace'&&call.args[3]==='create'));
  assert.ok(!calls.some(call=>call.args.includes('--focus')));
  assert.ok(!calls.some(call=>call.args.includes('--no-focus')&&call.args[2]==='tab'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a foreground_cwd match reuses the workspace, and the tab label is the title truncated to 40 characters',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'wv-owner-reuse-fg-')));
 try{
  const calls:RunnerInput[]=[];
  const workspaceList={stdout:JSON.stringify({result:{type:'workspace_list',workspaces:[{workspace_id:'wA',number:3}]}})};
  const paneList={stdout:JSON.stringify({result:{type:'pane_list',panes:[{cwd:'/srv/nowhere'},{foreground_cwd:dir}]}})};
  const title='T'.repeat(64);
  const result=launch({workspace:dir,title},fakeRunner({workspaceList,paneList,tabCreate:{stdout:tabCreateOk}},calls));
  assert.equal(result.createdWorkspace,false);
  assert.deepEqual(calls[2].args,['--session','default','tab','create','--workspace','wA','--cwd',dir,'--label','T'.repeat(40)]);
  assert.ok(!calls.some(call=>call.args[2]==='workspace'&&call.args[3]==='create'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('several matching workspaces reuse the one with the lowest Herdr number',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'wv-owner-reuse-multi-')));
 try{
  const calls:RunnerInput[]=[];
  const workspaceList={stdout:JSON.stringify({result:{type:'workspace_list',workspaces:[{workspace_id:'wD',number:40},{workspace_id:'wB',number:2},{workspace_id:'wC',number:21}]} })};
  const paneList=(id:string):Step=>({stdout:JSON.stringify({result:{type:'pane_list',panes:[{pane_id:`${id}:p1`,foreground_cwd:dir}]}})});
  const runner=fakeRunner({workspaceList,paneList,tabCreate:{stdout:tabCreateOk}},calls);
  const result=launch({workspace:dir},runner);
  assert.equal(result.workspaceId,'wB');assert.equal(result.tabId,'w9:t2');assert.equal(result.createdWorkspace,false);
  assert.deepEqual(calls[4].args.slice(4,8),['--workspace','wB','--cwd',dir]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('workspaces without a matching directory fall through to the existing workspace create flow',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'wv-owner-reuse-none-')));
 try{
  const calls:RunnerInput[]=[];
  const workspaceList={stdout:JSON.stringify({result:{type:'workspace_list',workspaces:[{workspace_id:'wA',number:1}]}})};
  const paneList={stdout:JSON.stringify({result:{type:'pane_list',panes:[{cwd:'/srv/unrelated'}]}})};
  const runner=fakeRunner({workspaceList,paneList,create:{stdout:createOk}},calls);
  const result=launch({workspace:dir},runner);
  assert.deepEqual(result,createResult);
  assert.deepEqual(calls.map(call=>[call.args[2],call.args[3]]),[['workspace','list'],['pane','list'],['workspace','create'],['agent','start'],['agent','get'],['agent','prompt'],['agent','rename']]);
  assert.deepEqual(calls[2]!.args,['--session','default','workspace','create','--cwd',dir,'--label',realpathSync(dir).split('/').at(-1),'--no-focus']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a workspace list failure reports the step and never falls back to creating a workspace',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'wv-owner-reuse-wsl-')));
 try{
  for(const workspaceList of [{code:1,stderr:'socket gone'},{stdout:JSON.stringify({id:'cli:workspace:list',error:{code:'denied',message:'no'}})},{stdout:'not json'},{stdout:''}] as const){
   const calls:RunnerInput[]=[];
   assert.throws(()=>launch({workspace:dir},fakeRunner({workspaceList},calls)),error=>{
    assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
    assert.ok(error instanceof Error);
    assert.match(error.message,/herdr workspace list/);
    return true;});
   assert.equal(calls.length,1);
   assert.ok(!calls.some(call=>call.args[3]==='create'));
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a pane list failure reports the step and never falls back to creating a workspace',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'wv-owner-reuse-pain-')));
 try{
  for(const paneList of [{code:1,stderr:'pane list exploded'},{stdout:JSON.stringify({error:{code:'nope',message:'denied'}})},{stdout:'garbage'}] as const){
   const calls:RunnerInput[]=[];
   const workspaceList={stdout:JSON.stringify({result:{type:'workspace_list',workspaces:[{workspace_id:'wA',number:1}]}})};
   assert.throws(()=>launch({workspace:dir},fakeRunner({workspaceList,paneList},calls)),error=>{
    assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
    assert.ok(error instanceof Error);
    assert.match(error.message,/herdr pane list/);
    return true;});
   assert.equal(calls.length,2);
   assert.ok(!calls.some(call=>call.args[3]==='create'));
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a failed tab create with an exact receipt closes only that tab; without a receipt nothing is guessed',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'wv-owner-reuse-fail-')));
 try{
  const base={workspaceList:{stdout:JSON.stringify({result:{type:'workspace_list',workspaces:[{workspace_id:'wA',number:1}]}})},paneList:{stdout:JSON.stringify({result:{type:'pane_list',panes:[{cwd:dir}]}})}};
  const calls:RunnerInput[]=[];
  const withReceipt=fakeRunner({...base,tabCreate:{code:1,stdout:JSON.stringify({result:{tab:{tab_id:'wA:t9'}}}),stderr:'tab create refused'}},calls);
  assert.throws(()=>launch({workspace:dir},withReceipt),error=>{assert.match((error as Error).message,/tab create failed \(exit 1\): tab create refused/);return true;});
  assert.equal(calls.length,4);
  assert.deepEqual(calls[3]!.args,['--session','default','tab','close','wA:t9']);
  const noReceiptCalls:RunnerInput[]=[];
  const withoutReceipt=fakeRunner({...base,tabCreate:{code:1,stderr:'tab create refused'}},noReceiptCalls);
  assert.throws(()=>launch({workspace:dir},withoutReceipt),error=>{assert.match((error as Error).message,/tab create failed \(exit 1\): tab create refused/);return true;});
  assert.deepEqual(noReceiptCalls.map(call=>[call.args[2],call.args[3]]),[['workspace','list'],['pane','list'],['tab','create']]);
  assert.ok(!calls.some(call=>call.args[2]==='workspace'&&call.args[3]==='close'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a tab create without a tab id fails the launch and never starts or closes a guessed tab',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'wv-owner-reuse-notab-')));
 try{
  const calls:RunnerInput[]=[];
  const workspaceList={stdout:JSON.stringify({result:{type:'workspace_list',workspaces:[{workspace_id:'wA',number:1}]}})};
  const paneList={stdout:JSON.stringify({result:{type:'pane_list',panes:[{cwd:dir}]}})};
  assert.throws(()=>launch({workspace:dir},fakeRunner({workspaceList,paneList,tabCreate:{stdout:'{"result":{"root_pane":{"pane_id":"wA:p1"}}}'}},calls)),error=>{
   assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
   assert.ok(error instanceof Error);
   assert.match(error.message,/tab create returned no tab id/);
   return true;});
  assert.deepEqual(calls.map(call=>[call.args[2],call.args[3]]),[['workspace','list'],['pane','list'],['tab','create']]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a failing agent start after reuse closes only the new tab, never the reused workspace',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'wv-owner-reuse-guard-')));
 try{
  const calls:RunnerInput[]=[];
  const workspaceList={stdout:JSON.stringify({result:{type:'workspace_list',workspaces:[{workspace_id:'wA',number:1}]}})};
  const paneList={stdout:JSON.stringify({result:{type:'pane_list',panes:[{cwd:dir}]}})};
  assert.throws(()=>launch({workspace:dir},fakeRunner({workspaceList,paneList,tabCreate:{stdout:tabCreateOk},start:{code:1,stderr:'agent_not_ready'}},calls)),error=>{assert.match((error as Error).message,/agent start failed \(exit 1\)/);return true;});
  assert.deepEqual(calls.at(-1)!.args,['--session','default','tab','close','w9:t2']);
  assert.ok(!calls.some(call=>call.args[2]==='workspace'&&call.args[3]==='close'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('closeOwnerHost closes only the tab for records with a tab id; legacy records still close the workspace',()=>{
 const tabCalls:RunnerInput[]=[];
 closeOwnerHost({session:'default',workspaceId:'wA',paneId:'wA:p1',tabId:'wA:t9',createdWorkspace:false,agentName:'owner-x'},{herdrPath:HERDR,runner:fakeRunner({},tabCalls)});
 assert.deepEqual(tabCalls.map(call=>[call.args[2],call.args[3],call.args[4]]),[['tab','close','wA:t9']]);
 const legacyCalls:RunnerInput[]=[];
 closeOwnerHost({session:'default',workspaceId:'wA',paneId:'wA:p1',agentName:'owner-x'},{herdrPath:HERDR,runner:fakeRunner({},legacyCalls)});
 assert.deepEqual(legacyCalls.map(call=>[call.args[2],call.args[3],call.args[4]]),[['workspace','close','wA']]);
});
test('invalid epochs and task ids are rejected deterministically',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({},calls);
 assert.throws(()=>launch({epoch:-1},runner),()=>true);
 assert.throws(()=>launch({taskId:'short'},runner),()=>true);
 assert.equal(calls.length,0);
});
test('ownerAgentName derives the normalized bounded pattern',()=>{
 assert.equal(ownerAgentName('ABCDEF12-1111-4111-8111-111111111111',12),'owner-abcdef12-12');
 assert.match(ownerAgentName('11111111-1111-4111-8111-111111111111',0),/^[a-z][a-z0-9_-]{0,31}$/);
});
test('executable discovery scans the injected PATH and honors the executable bit',()=>{
 const base=mkdtempSync(join(tmpdir(),'wv-owner-scan-'));
 try{
  writeFileSync(join(base,'herdr'),'#!/bin/sh\nexit 0\n');chmodSync(join(base,'herdr'),0o755);
  writeFileSync(join(base,'noexec'),'#!/bin/sh\n');chmodSync(join(base,'noexec'),0o644);
  const real=realpathSync(base);
  assert.equal(findExecutableSync('herdr',''),undefined);
  assert.equal(findExecutableSync('herdr',base),join(real,'herdr'));
  assert.equal(findExecutableSync('herdr',`${base}${delimiter}${join(base,'nowhere')}`),join(real,'herdr'));
  assert.equal(findExecutableSync('noexec',base),undefined);
  assert.equal(herdrOnPath(base),true);
  assert.equal(herdrOnPath(''),false);
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('the launcher resolves herdr from the injected PATH instead of a fixed location',()=>{
 const base=mkdtempSync(join(tmpdir(),'wv-owner-launch-'));
 try{
  writeFileSync(join(base,'herdr'),'#!/bin/sh\nexit 0\n');chmodSync(join(base,'herdr'),0o755);
  const calls:RunnerInput[]=[];
  const runner=fakeRunner({create:{stdout:createOk}},calls);
  const result=launchOwner({taskId:'11111111-1111-4111-8111-111111111111',epoch:1,title:'Fixture title',workspace:'/srv/proj',engineKind:'codex',model:'gpt-6-astra',effort:'high',prompt:'continue the fixture work now',runner,pathEnv:base});
  assert.equal(result.workspaceId,'w7');
  assert.ok(calls.every(call=>call.file===join(realpathSync(base),'herdr')));
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('defaultRunner captures stdout, stderr, exit codes and timeouts without a shell',()=>{
 const base=mkdtempSync(join(tmpdir(),'wv-owner-run-'));
 try{
  const pinned=defaultRunner({file:process.execPath,args:['-e','process.stdout.write("out-ok");process.stderr.write("err-ok")'],timeout:10000});
  assert.equal(pinned.code,0);assert.equal(pinned.stdout,'out-ok');assert.equal(pinned.stderr,'err-ok');
  const missing=defaultRunner({file:join(base,'definitely-missing-binary'),args:[],timeout:5000});
  assert.equal(missing.code,127);assert.ok(missing.stderr.length>0);assert.equal(missing.stdout,'');
  const slow=defaultRunner({file:process.execPath,args:['-e','setTimeout(()=>{},4000)'],timeout:400});
  assert.ok(slow.code===143||slow.code===124,`unexpected slow code ${slow.code}`);
  assert.ok(slow.stderr.length>0);
 }finally{rmSync(base,{recursive:true,force:true});}
});
