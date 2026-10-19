import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {launchOwner, ownerAgentName, herdrOnPath, findExecutable, defaultRunner, OWNER_AGENT_START_TIMEOUT_MS, OwnerLaunchError, type Runner, type RunnerInput} from '../src/main/owner-host';
const HERDR='/opt/fake-herdr/herdr';
const CLAUDE='/opt/fake-claude/claude';
const START_TIMEOUT=String(OWNER_AGENT_START_TIMEOUT_MS);
type Step={stdout?:string;stderr?:string;code?:number};
type Script={create?:Step;claudeHelp?:string|null;start?:Step;prompt?:Step;close?:Step};
function fakeRunner(script:Script={},calls:RunnerInput[]=[]):Runner {
 let unexpected=0;
 return input=>{
  calls.push(input);
  if(input.file===CLAUDE){const help=script.claudeHelp;if(help===undefined)return {code:1,stdout:'',stderr:'unexpected claude probe'};if(help===null)return {code:1,stdout:'',stderr:'claude --help exited non-zero'};return {code:0,stdout:help,stderr:''};}
  const group=input.args[2],action=input.args[3];
  const known=(group==='workspace'&&['create','close'].includes(String(action)))||(group==='agent'&&['start','prompt'].includes(String(action)));
  // An unknown command group or action is a launcher bug, never a silent success.
  if(!known){unexpected++;return {code:1,stdout:'',stderr:`unexpected herdr call #${unexpected}`};}
  const step=group==='workspace'?(action==='create'?script.create:script.close):(action==='start'?script.start:script.prompt);
  return {code:step?.code??0,stdout:step?.stdout??'',stderr:step?.stderr??''};
 };
}
const createOk=JSON.stringify({result:{workspace:{workspace_id:'w7'},tab:{tab_id:'w7:t1'},root_pane:{pane_id:'w7:p1'}}});
const promptOk=JSON.stringify({result:{status:'submitted'}});
const launch=(overrides:Partial<Parameters<typeof launchOwner>[0]>={},runner:Runner)=>launchOwner({taskId:'11111111-1111-4111-8111-111111111111',epoch:1,title:'Fixture title',workspace:'/srv/proj',engineKind:'claude',model:'claude-opus-5-5',effort:'high',prompt:'continue the fixture work now',runner,herdrPath:HERDR,pathEnv:'',...overrides});
const codeOf=(error:unknown):string=>error instanceof OwnerLaunchError?error.code:'<none>';
test('claude launch drives herdr through argv arrays, detects the effort flag and parses the workspace JSON',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},claudeHelp:'--effort <level>   Effort level for the current session'},calls);
 const result=launch({claudePath:CLAUDE},runner);
 assert.deepEqual(result,{session:'default',workspaceId:'w7',paneId:'w7:p1',agentName:'owner-11111111-1'});
 assert.deepEqual(calls[0],{file:HERDR,args:['--session','default','workspace','create','--cwd','/srv/proj','--label','Fixture title','--no-focus'],timeout:30000});
 assert.deepEqual(calls[1],{file:CLAUDE,args:['--help'],timeout:15000});
 assert.deepEqual(calls[2],{file:HERDR,args:['--session','default','agent','start','owner-11111111-1','--kind','claude','--pane','w7:p1','--timeout',START_TIMEOUT,'--','--model','claude-opus-5-5','--effort','high'],timeout:70000});
 assert.deepEqual(calls[3],{file:HERDR,args:['--session','default','agent','prompt','owner-11111111-1','continue the fixture work now'],timeout:60000});
 assert.equal(calls.length,4);
 assert.match(result.agentName,/^[a-z][a-z0-9_-]{0,31}$/);
});
test('codex launch skips the help probe and passes the effort config as one argv element',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:JSON.stringify({result:{workspace:{workspace_id:'w7'},root_pane:{pane_id:'w7:p2'}}})}},calls);
 const result=launch({engineKind:'codex',model:'gpt-6-astra',session:'work'},runner);
 assert.equal(result.session,'work');assert.equal(result.workspaceId,'w7');assert.equal(result.paneId,'w7:p2');
 assert.equal(calls.length,3);
 assert.deepEqual(calls[1].args,['--session','work','agent','start','owner-11111111-1','--kind','codex','--pane','w7:p2','--timeout',START_TIMEOUT,'--','-m','gpt-6-astra','-c','model_reasoning_effort="high"']);
 assert.ok(!calls.some(call=>call.file===CLAUDE));
 const promptCall=calls[2];
 assert.equal(promptCall.args[5],'continue the fixture work now');
 assert.equal(promptCall.args.length,6);
});
test('long task titles are truncated to 40 characters in the workspace label',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk}},calls);
 launch({title:'T'.repeat(64)},runner);
 const create=calls[0];
 assert.equal(create.args[6],'--label');
 assert.equal(create.args[7]!.length,40);
 assert.ok(create.args[7]!.startsWith('TTT'));assert.ok(!create.args[7]!.includes('…'));
});
test('claude help without an effort flag, or failing, keeps only --model',()=>{
 for(const help of [null,'usage: claude [options]','--effort'.split('').reverse().join('')+' <level>'] as const){
  const calls:RunnerInput[]=[];
  const runner=fakeRunner({create:{stdout:createOk},claudeHelp:help as string|null},calls);
  launch({claudePath:CLAUDE},runner);
  assert.equal(calls.length,4);
  assert.ok(!calls[2]!.args.includes('--effort'));
  assert.deepEqual(calls[2]!.args.slice(-2),['--model','claude-opus-5-5']);
 }
});
test('no claude on PATH means no probe at all',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk}},calls);
 launch({},runner);
 assert.equal(calls.length,3);
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
test('a create response without a root pane still closes the workspace it created',()=>{
 for(const create of ['{"result":{"workspace":{"workspace_id":"w7"},"tab":{"tab_id":"w7:t1"}}}','{"result":{"workspace":{"workspace_id":"w7"},"root_pane":"w7:p4"}}']){
  const calls:RunnerInput[]=[];
  const runner=fakeRunner({create:{stdout:create},close:{stdout:'{"result":{"type":"ok"}}'}},calls);
  assert.throws(()=>launch({},runner),error=>{assert.ok(error instanceof Error);assert.match(error.message,/no root pane id/);return true;});
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1]!.args,['--session','default','workspace','close','w7']);
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
test('cleanup closes the documented workspace id, not a prefix of the pane id',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:JSON.stringify({result:{workspace:{workspace_id:'ws-42'},tab:{tab_id:'w8:t1'},root_pane:{pane_id:'w8:p4'}}})},start:{code:1,stderr:'boom'}},calls);
 assert.throws(()=>launch({},runner),error=>{assert.ok(error instanceof Error);assert.match(error.message,/agent start failed/);return true;});
 assert.equal(calls.length,3);
 assert.deepEqual(calls[2]!.args,['--session','default','workspace','close','ws-42']);
});
test('a failing agent start closes only the workspace it created',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},start:{code:1,stderr:'agent_not_ready: pane never reached a prompt'}},calls);
 assert.throws(()=>launch({},runner),error=>{assert.ok(error instanceof Error);assert.match(error.message,/agent start failed \(exit 1\)/);assert.match(error.message,/agent_not_ready/);return true;});
 const close=calls[2];
 assert.deepEqual(close.args,['--session','default','workspace','close','w7']);
 assert.equal(close.timeout,15000);
 assert.equal(calls.length,3);
});
test('failed cleanup is reported inside the launch failure',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},start:{code:1,stderr:'agent start blew up'},close:{code:1,stderr:`close ${'y'.repeat(900)}`}},calls);
 assert.throws(()=>launch({},runner),error=>{
  assert.ok(error instanceof Error);
  assert.match(error.message,/workspace close cleanup also failed \(exit 1\): close /);
  assert.ok(!error.message.includes('y'.repeat(301)));
  return true;});
 assert.equal(calls.length,3);
});
test('a failing prompt submission also cleans up the created workspace',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},prompt:{code:1,stderr:'agent_blocked'}},calls);
 assert.throws(()=>launch({},runner),error=>{assert.match((error as Error).message,/agent prompt failed \(exit 1\)/);return true;});
 assert.deepEqual(calls[3]!.args,['--session','default','workspace','close','w7']);
 assert.equal(calls.length,4);
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
test('a runner that throws after workspace create still closes exactly the created workspace',()=>{
 const calls:RunnerInput[]=[];
 const runner:Runner=input=>{
  calls.push(input);
  if(input.args[2]==='workspace'&&input.args[3]==='create')return {code:0,stdout:createOk,stderr:''};
  if(input.args[2]==='workspace'&&input.args[3]==='close')return {code:0,stdout:'{"result":{"type":"ok"}}',stderr:''};
  throw new Error('agent start crashed');
 };
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.match(error.message,/agent start failed: agent start crashed/);
  return true;});
 assert.deepEqual(calls[2]!.args,['--session','default','workspace','close','w7']);
 assert.equal(calls.length,3);
});
test('a failure envelope with exit code 0 fails agent start, skips the prompt and closes the workspace',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},start:{stdout:JSON.stringify({id:'cli:agent:start',error:{code:'agent_not_ready',message:'pane never reached a prompt'}})}},calls);
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.match(error.message,/agent start failed \(exit 0\): agent_not_ready: pane never reached a prompt/);
  return true;});
 assert.ok(!calls.some(call=>call.args[2]==='agent'&&call.args[3]==='prompt'));
 assert.deepEqual(calls[2]!.args,['--session','default','workspace','close','w7']);
 assert.equal(calls.length,3);
});
test('a blocked agent prompt envelope with exit code 0 fails the launch and closes the workspace',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},prompt:{stdout:JSON.stringify({id:'cli:agent:prompt',error:{code:'agent_blocked',message:'agent is blocked'}})}},calls);
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.match(error.message,/agent prompt failed \(exit 0\): agent_blocked: agent is blocked/);
  return true;});
 assert.deepEqual(calls[3]!.args,['--session','default','workspace','close','w7']);
 assert.equal(calls.length,4);
});
test('documented success envelopes are not mistaken for failures',()=>{
 const started=JSON.stringify({id:'cli:agent:start',result:{type:'agent_started',agent:{pane_id:'w7:p1',name:'owner-11111111-1',agent_status:'idle'},argv:['claude','--model','claude-opus-5-5']}});
 for(const prompt of [promptOk, JSON.stringify({id:'cli:agent:prompt',result:{type:'agent_prompted',agent:{pane_id:'w7:p1',agent_status:'working'}}})]){
  const calls:RunnerInput[]=[];
  const runner=fakeRunner({create:{stdout:createOk},start:{stdout:started},prompt:{stdout:prompt}},calls);
  assert.deepEqual(launch({},runner),{session:'default',workspaceId:'w7',paneId:'w7:p1',agentName:'owner-11111111-1'});
  assert.equal(calls.length,3);
 }
});
test('a cleanup that throws is appended to the launch failure it recovers from',()=>{
 const calls:RunnerInput[]=[];
 const runner:Runner=input=>{
  calls.push(input);
  if(input.args[2]==='workspace'&&input.args[3]==='create')return {code:0,stdout:createOk,stderr:''};
  if(input.args[2]==='agent'&&input.args[3]==='start')return {code:1,stdout:'',stderr:'agent start failed on purpose'};
  if(input.args[2]==='workspace'&&input.args[3]==='close')throw new Error('close socket gone');
  return {code:0,stdout:'',stderr:''};
 };
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.match(error.message,/agent start failed \(exit 1\): agent start failed on purpose/);
  assert.match(error.message,/workspace close cleanup also failed: close socket gone/);
  return true;});
 assert.equal(calls.length,3);
 assert.ok(!calls.some(call=>call.args[2]==='agent'&&call.args[3]==='prompt'));
});
test('a cleanup reporting a failure envelope with exit code 0 is still reported as cleanup failure',()=>{
 const calls:RunnerInput[]=[];
 const runner=fakeRunner({create:{stdout:createOk},start:{code:1,stderr:'nope'},close:{stdout:JSON.stringify({id:'cli:workspace:close',error:{code:'confirmation_required',message:'closing would remove a worktree parent'}})}},calls);
 assert.throws(()=>launch({},runner),error=>{
  assert.equal(codeOf(error),'OWNER_LAUNCH_FAILED');
  assert.ok(error instanceof Error);
  assert.match(error.message,/agent start failed \(exit 1\): nope/);
  assert.match(error.message,/workspace close cleanup also failed \(exit 0\): confirmation_required: closing would remove a worktree parent/);
  return true;});
 assert.equal(calls.length,3);
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
  assert.equal(findExecutable('herdr',''),null);
  assert.equal(findExecutable('herdr',base),join(base,'herdr'));
  assert.equal(findExecutable('herdr',`${base}${delimiter}${join(base,'nowhere')}`),join(base,'herdr'));
  assert.equal(findExecutable('noexec',base),null);
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
  assert.ok(calls.every(call=>call.file===join(base,'herdr')));
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
