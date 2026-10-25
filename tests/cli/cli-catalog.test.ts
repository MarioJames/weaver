import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalIPC } from '../../src/main/local-ipc';
import { CLI_CATALOG, CLI_HELP } from '../../src/cli/catalog';
import { applyCallerWorkspace, makeRequest } from '../../src/cli/input';
import { parseCLI } from '../../src/cli/parse';
import { renderEnvelope } from '../../src/cli/output';
import { runCLI } from '../../src/cli/run';
import { READ_COMMANDS, WRITE_COMMANDS } from '../../src/shared/contracts/commands';

const serverCommands = [...READ_COMMANDS, ...WRITE_COMMANDS];
const rpcCommands = ['policy.get', 'policy.validate', 'policy.save', 'policy.preview', 'engines.scan', 'quota.get', 'quota.refresh', 'janitor.sweep', 'janitor.status'];

test('catalog covers every handler command, nested continuation, and output flags', () => {
  for (const name of [...serverCommands, ...rpcCommands, 'tasks.wait', 'tasks.watch']) {
    assert.ok(CLI_CATALOG.some(item => item.command === name), name);
    const words = name.split('.');
    assert.equal(parseCLI(words).command, name);
    assert.equal(parseCLI([name]).command, name);
    assert.match(CLI_HELP, new RegExp(name.replaceAll('.', ' ').replaceAll('-', '\\-')));
  }
  assert.equal(parseCLI(['capabilities']).command, 'capabilities.get');
  assert.equal(parseCLI(['owners', 'continuation', 'get', '--task-id', 't']).command, 'owners.continuation.get');
  assert.equal(parseCLI(['owners', 'continuation', 'configure']).command, 'owners.continuation.configure');
  assert.equal(parseCLI(['tasks', 'get', '--output', 'text']).output, 'text');
  assert.equal(parseCLI(['tasks', 'get', '--output', 'jsonl']).output, 'jsonl');
  assert.equal(parseCLI(['tasks', 'get', '--json']).output, 'json');
  assert.throws(() => parseCLI(['owners', 'continuation']), /Unknown command/);
  assert.throws(() => parseCLI(['tasks', 'nope']), /Unknown command/);
  assert.throws(() => parseCLI(['tasks', 'get', '--json', '--output', 'text']), /cannot be combined/);
  assert.throws(() => parseCLI(['tasks', 'get', '--json', '--output', 'json']), /cannot be combined/);
  assert.throws(() => parseCLI(['tasks', 'get', '--output', 'yaml']), /json, jsonl, or text/);
  assert.throws(() => parseCLI(['owners', 'attach', '--no-input']), /Unknown option/);
  assert.throws(() => parseCLI(['web', '--no-input']), /Unknown option/);
  assert.throws(() => parseCLI(['tasks', 'get', '--for', '5']), /only valid for tasks wait/);
  assert.equal(parseCLI(['tasks', 'wait', '--task-id', 't', '--for', '30']).forSeconds, 30);
  assert.match(CLI_HELP, /working directory/);
  assert.match(CLI_HELP, /--output json\|jsonl\|text/);
});

test('tasks create stamps the caller cwd and keeps an explicit absolute path', () => {
  const omitted: Record<string, unknown> = { apiVersion: 'weaver.v1', command: 'tasks.create', args: { title: 'A' } };
  applyCallerWorkspace(omitted, '/tmp/caller-workspace');
  assert.equal((omitted.args as { workspace: string }).workspace, '/tmp/caller-workspace');
  const explicit: Record<string, unknown> = { apiVersion: 'weaver.v1', command: 'tasks.create', args: { workspace: '/srv/project' } };
  applyCallerWorkspace(explicit, '/tmp/caller-workspace');
  assert.equal((explicit.args as { workspace: string }).workspace, '/srv/project');
  const relative: Record<string, unknown> = { apiVersion: 'weaver.v1', command: 'tasks.create', args: { workspace: 'nested' } };
  applyCallerWorkspace(relative, '/tmp/caller-workspace');
  assert.equal((relative.args as { workspace: string }).workspace, '/tmp/caller-workspace/nested');
  const other: Record<string, unknown> = { apiVersion: 'weaver.v1', command: 'tasks.get', args: {} };
  applyCallerWorkspace(other, '/tmp/caller-workspace');
  assert.equal('workspace' in (other.args as object), false);
});

test('schedules create keeps workspace optional in canonical and envelope forms; tasks roots and children unchanged', () => {
  for (const request of [
    { apiVersion: 'weaver.v1', command: 'schedules.create', args: { kind: 'script' } },
    { apiVersion: 'weaver.v1', command: 'schedules.create', args: { kind: 'agent' } },
  ]) {
    applyCallerWorkspace(request, '/tmp/caller');
    assert.equal('workspace' in (request.args as object), false);
  }
  const canonical = makeRequest(parseCLI(['schedules', 'create']), { name: 'n', kind: 'script', timing: { mode: 'interval', seconds: 60 }, script: { command: 'true', timeoutSeconds: 10 } });
  applyCallerWorkspace(canonical, '/tmp/caller');
  assert.equal('workspace' in (canonical.args as object), false);
  const envelope = makeRequest(parseCLI(['schedules', 'create']), { apiVersion: 'weaver.v1', command: 'schedules.create', args: { name: 'n' } });
  applyCallerWorkspace(envelope, '/tmp/caller');
  assert.equal('workspace' in (envelope.args as object), false);
  for (const workspace of ['', '   ']) {
    const request: Record<string, unknown> = { command: 'schedules.create', args: { workspace } };
    applyCallerWorkspace(request, '/tmp/caller');
    assert.equal((request.args as Record<string, unknown>).workspace, workspace);
  }
  const relative: Record<string, unknown> = { command: 'schedules.create', args: { workspace: 'project' } };
  applyCallerWorkspace(relative, '/tmp/caller');
  assert.equal((relative.args as Record<string, unknown>).workspace, '/tmp/caller/project');
  const absolute: Record<string, unknown> = { command: 'schedules.create', args: { workspace: '/srv/project' } };
  applyCallerWorkspace(absolute, '/tmp/caller');
  assert.equal((absolute.args as Record<string, unknown>).workspace, '/srv/project');
  for (const workspace of [null, 12, false, {}]) {
    const request: Record<string, unknown> = { command: 'schedules.create', args: { workspace } };
    applyCallerWorkspace(request, '/tmp/caller');
    assert.deepEqual((request.args as Record<string, unknown>).workspace, workspace);
  }
  const child: Record<string, unknown> = { command: 'tasks.create', args: { parentTaskId: 'p-1' } };
  applyCallerWorkspace(child, '/tmp/caller');
  assert.deepEqual(child.args, { parentTaskId: 'p-1' });
  const patch: Record<string, unknown> = { command: 'schedules.update', args: { scheduleId: 's', patch: { workspace: '' } } };
  applyCallerWorkspace(patch, '/tmp/caller');
  assert.deepEqual(patch.args, { scheduleId: 's', patch: { workspace: '' } });
});

test('text and jsonl errors stay in the requested format', () => {
  const text = renderEnvelope('text', { ok: false, error: { code: 'APP_NOT_RUNNING', message: 'start weaver web --no-open' } });
  assert.equal(text, 'APP_NOT_RUNNING: start weaver web --no-open');
  const jsonl = renderEnvelope('jsonl', { apiVersion: 'weaver.v1', ok: false, error: { code: 'APP_NOT_RUNNING', message: 'down' } });
  assert.equal(JSON.parse(jsonl).error.code, 'APP_NOT_RUNNING');
  const directory = `/tmp/weaver-does-not-exist-${Date.now()}`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'capabilities', '--output', 'text', '--data-dir', directory], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.match(result.stdout, /^APP_NOT_RUNNING: /);
  assert.throws(() => JSON.parse(result.stdout));
  const lines = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'owners', 'continuation', 'get', '--task-id', 'missing', '--output', 'jsonl', '--data-dir', directory], { encoding: 'utf8' });
  assert.equal(lines.status, 1);
  assert.equal(lines.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(lines.stdout).error.code, 'APP_NOT_RUNNING');
  const removed = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'web', '--no-input', '--data-dir', directory], { encoding: 'utf8' });
  assert.equal(removed.status, 1);
  assert.equal(JSON.parse(removed.stdout).error.code, 'INVALID_ARGUMENT');
  assert.match(removed.stdout, /Unknown option/);
});


test('explicit invalid workspace is rejected instead of becoming caller cwd',()=>{
 for(const workspace of ['', '   ', null, 12, false, {}]){
  const request={command:'tasks.create',args:{workspace}};
  assert.throws(()=>applyCallerWorkspace(request,'/tmp/caller'),/Explicit workspace/);
  assert.deepEqual(request.args.workspace,workspace);
 }
 assert.throws(()=>parseCLI(['tasks','watch','--task-id','x','--input','ignored.json']),/do not accept --input/);
});

test('CLI parse errors respect a valid output format in any flag order',()=>{
 for(const argv of [
  ['unknown-command','--output','text'],
  ['--output','text','tasks','get','--bad'],
  ['tasks','get','--bad','--output','text'],
  ['web','--port','invalid','--output','text'],
  ['--output','text','web','--port','invalid']
 ]){
  const result=spawnSync(process.execPath,['--import','tsx','src/cli/main.ts',...argv],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stdout,/^INVALID_ARGUMENT: /);assert.equal(result.stdout.trim().split('\n').length,1);
 }
 const result=spawnSync(process.execPath,['--import','tsx','src/cli/main.ts','unknown-command','--output','jsonl'],{encoding:'utf8'});
 assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).error.code,'INVALID_ARGUMENT');assert.equal(result.stdout.trim().split('\n').length,1);
});

test('command help and root catalog are machine-readable and expose digest and revision fields',()=>{
 for(const words of [['results','ack'],['results.ack']]){
  const result=spawnSync(process.execPath,['--import','tsx','src/cli/main.ts',...words,'--help','--output','json'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const command=JSON.parse(result.stdout).data;
  assert.equal(command.command,'results.ack');assert.equal(command.mutation,true);assert.ok(command.inputFields.required.manifestDigest);assert.ok(command.inputFields.required.expectedRevision);
 }
 const root=spawnSync(process.execPath,['--import','tsx','src/cli/main.ts','--help','--output','json'],{encoding:'utf8'});
 assert.equal(root.status,0);const catalog=JSON.parse(root.stdout).data.catalog;
 assert.equal(catalog.length,CLI_CATALOG.length);for(const item of catalog)assert.ok(item.inputFields);
});

const logical = [['tasks','health'],['engines','health'],['engines','penalty'],['engines','unblock'],['workers','unblock'],['owners','launch'],['owners','describe']];

test('new logical commands are catalogued, parseable in both forms and in help',()=>{
 for(const words of logical){
  const name=words.join('.');
  assert.ok(CLI_CATALOG.some(item=>item.command===name),name);
  assert.equal(parseCLI(words).command,name);
  assert.equal(parseCLI([name]).command,name);
  assert.match(CLI_HELP,new RegExp(name.replaceAll('.',' ')));
 }
  assert.match(CLI_HELP,/\[--engine <id>\] \[--worker <id>\] \[--cancel\]/);
 assert.match(CLI_HELP,/engine <id> is the engine argument of engines penalty, engines unblock and engines models/);
 assert.match(CLI_HELP,/worker <id> is the optional worker argument of workers probe and the required worker argument of workers unblock/);
 assert.match(CLI_HELP,/tasks retry returns the linked task already dispatched/);
 // The help says what an owner gets, not which component decides it.
 assert.doesNotMatch(CLI_HELP,/the server decides|the CLI never/);
});

test('owners describe is catalogued as a mutation with required ownerId and title',()=>{
 const row=CLI_CATALOG.find(item=>item.command==='owners.describe');
 assert.ok(row);assert.equal(row!.mutation,true);
 assert.deepEqual(Object.keys(row!.inputFields!.required).sort(),['ownerId','title']);
 assert.deepEqual(Object.keys(row!.inputFields!.optional??{}),[]);
 assert.match(row!.usage,/owners describe/);
 assert.match(CLI_HELP,/owners describe sets or updates one instance's title/);
});

test('text output carries the next step a dispatch or retry handed back',()=>{
 const waited={id:'t-1',status:'running',title:'Held',dispatch:{engine:'claude'},next:{action:'wait',command:'weaver tasks wait --task-id t-1'},excludedWorkers:['codex_alt_worker']};
 const text=renderEnvelope('text',{apiVersion:'weaver.v1',ok:true,data:waited});
 assert.equal(text.split('\n')[0],'t-1 running Held');
 assert.match(text,/^next: weaver tasks wait --task-id t-1$/m);
 assert.match(text,/^excluded workers: codex_alt_worker$/m);
 const native={id:'t-2',status:'running',title:'Native',next:{action:'run_subagent',model:'sonnet',effort:'high',prompt:'FULL INSTRUCTION\nsecond line',then:'weaver workers complete --task-id t-2 --input report.json'}};
 const handoff=renderEnvelope('text',{apiVersion:'weaver.v1',ok:true,data:native});
 assert.match(handoff,/^t-2 running Native$/m);
 assert.match(handoff,/^next: run a subagent on model sonnet, effort high$/m);
 assert.ok(handoff.includes('FULL INSTRUCTION\nsecond line'),'the whole native prompt is handed over, not shortened');
 assert.match(handoff,/^then: weaver workers complete --task-id t-2 --input report\.json$/m);
 // The machine formats keep every field the text format reshapes.
 for(const format of ['json','jsonl'] as const){
  assert.deepEqual(JSON.parse(renderEnvelope(format,{apiVersion:'weaver.v1',ok:true,data:waited})).data,waited,'wait command and exclusions survive');
  assert.deepEqual(JSON.parse(renderEnvelope(format,{apiVersion:'weaver.v1',ok:true,data:native})).data,native,'the full prompt survives');
 }
});

test('flags become the frozen logical args and a mutation keeps the shared command ID rule',()=>{
 assert.equal(makeRequest(parseCLI(['tasks','health','--task-id','task-1'])).command,'tasks.health');
 assert.deepEqual(makeRequest(parseCLI(['tasks','health','--task-id','task-1'])).args,{taskId:'task-1'});
 assert.deepEqual(makeRequest(parseCLI(['engines','health'])).args,{});
 assert.deepEqual(makeRequest(parseCLI(['engines','penalty','--engine','qoder'])).args,{engine:'qoder'});
 assert.deepEqual(makeRequest(parseCLI(['tasks','retry','--task-id','task-1','--cancel'])).args,{taskId:'task-1',cancel:true});
 assert.deepEqual(makeRequest(parseCLI(['owners','launch','--task-id','task-1']),{expectedRevision:3}).args,{expectedRevision:3,taskId:'task-1'});
 const generated=makeRequest(parseCLI(['engines','unblock','--engine','qoder']));
 assert.match(String(generated.commandId),/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
 assert.equal(makeRequest(parseCLI(['engines','unblock','--engine','qoder','--command-id','c-1'])).commandId,'c-1');
 assert.deepEqual(makeRequest(parseCLI(['workers','unblock','--worker','codex_worker','--command-id','c-2'])).args,{worker:'codex_worker'});
 assert.equal(makeRequest(parseCLI(['workers','unblock','--worker','codex_worker','--command-id','c-2'])).commandId,'c-2');
 assert.throws(()=>makeRequest(parseCLI(['workers','unblock','--worker','codex_worker']),{worker:'other'}),/Input worker does not match CLI worker/);
});

test('--worker is refused on any command but workers probe and workers unblock, repeated or without a value',()=>{
 for(const words of [['tasks','health','--task-id','t'],['engines','unblock','--engine','qoder'],['workers','spawn','--task-id','t'],['workers','complete','--task-id','t']]){
  assert.throws(()=>parseCLI([...words,'--worker','codex_worker']),/--worker is only valid for workers probe and workers unblock/);
 }
 assert.equal(parseCLI(['workers','unblock','--worker','codex_worker']).worker,'codex_worker');
 assert.equal(parseCLI(['workers','probe','--worker','codex_worker']).worker,'codex_worker');
 assert.throws(()=>parseCLI(['workers','unblock','--worker','a','--worker','b']),/Duplicate option --worker/);
 assert.throws(()=>parseCLI(['workers','unblock','--worker']),/Missing value for --worker/);
});

test('--engine and --cancel are refused on any other command, repeated or without a value',()=>{
 for(const words of [['tasks','health','--task-id','t'],['engines','health'],['tasks','get','--task-id','t'],['tasks','retry','--task-id','t'],['owners','launch','--task-id','t'],['engines','scan']]){
  assert.throws(()=>parseCLI([...words,'--engine','qoder']),/--engine is only valid for engines penalty, engines unblock and engines models/);
 }
 for(const words of [['tasks','cancel','--task-id','t'],['tasks','health','--task-id','t'],['engines','unblock','--engine','qoder'],['tasks','list']]){
  assert.throws(()=>parseCLI([...words,'--cancel']),/--cancel is only valid for tasks retry/);
 }
 assert.throws(()=>parseCLI(['engines','penalty','--engine','qoder','--engine','codex']),/Duplicate option --engine/);
 assert.throws(()=>parseCLI(['tasks','retry','--task-id','t','--cancel','--cancel']),/Duplicate option --cancel/);
 assert.throws(()=>parseCLI(['engines','unblock','--engine']),/Missing value for --engine/);
 assert.throws(()=>parseCLI(['engines','unblock','--engine','--command-id','c']),/Missing value for --engine/);
 assert.throws(()=>parseCLI(['--engine','qoder','--input','{"taskId":"t"}']),/--engine is only valid/);
 // --cancel takes no value, so a trailing word stays a positional and never becomes an argument.
 assert.throws(()=>parseCLI(['tasks','retry','--task-id','t','--cancel','qoder']),/Unknown command/);
});

test('a flag never overrides a different value already in the --input body or envelope',()=>{
 const penalty=parseCLI(['engines','penalty','--engine','qoder']);
 assert.deepEqual(makeRequest(penalty,{engine:'qoder'}).args,{engine:'qoder'});
 assert.throws(()=>makeRequest(penalty,{engine:'codex'}),/Input engine does not match CLI engine/);
 assert.throws(()=>makeRequest(penalty,{apiVersion:'weaver.v1',command:'engines.penalty',args:{engine:'codex'}}),/Input engine does not match CLI engine/);
 const retry=parseCLI(['tasks','retry','--task-id','task-1','--cancel']);
 assert.deepEqual(makeRequest(retry,{expectedRevision:2}).args,{expectedRevision:2,taskId:'task-1',cancel:true});
 assert.throws(()=>makeRequest(retry,{cancel:false}),/Input cancel does not match CLI cancel/);
 assert.throws(()=>makeRequest(retry,{taskId:'other'}),/Input task ID does not match CLI task ID/);
 assert.throws(()=>makeRequest(parseCLI(['tasks','health','--task-id','t']),{apiVersion:'weaver.v1',command:'tasks.health',args:[1]}),/Request args must be an object/);
 assert.throws(()=>makeRequest(parseCLI(['tasks','health','--task-id','t']),{apiVersion:'weaver.v1',command:'tasks.get',args:{}}),/does not match CLI command/);
});

test('help parses the new flags and reports an invalid pairing in the requested format',()=>{
 const run=(argv:string[])=>spawnSync(process.execPath,['--import','tsx','src/cli/main.ts',...argv],{encoding:'utf8'});
 for(const [argv,command,mutation] of [[['engines','penalty','--engine','qoder','--help','--output','json'],'engines.penalty',false],[['engines','unblock','--engine','qoder','--help','--output','json'],'engines.unblock',true],[['workers','unblock','--worker','codex_worker','--help','--output','json'],'workers.unblock',true]] as const){
  const result=run([...argv]);
  assert.equal(result.status,0,result.stderr);
  const item=JSON.parse(result.stdout).data;
  assert.equal(item.command,command);assert.equal(item.mutation,mutation);assert.ok(command==='workers.unblock'?item.inputFields.required.worker:item.inputFields.required.engine);
 }
 const launch=run(['owners','launch','--help','--output','json']);
 assert.equal(launch.status,0,launch.stderr);
 assert.ok(JSON.parse(launch.stdout).data.inputFields.required.expectedRevision);
 const text=run(['tasks','retry','--cancel','--help']);
 assert.equal(text.status,0,text.stderr);
 assert.match(text.stdout,/^tasks retry --task-id <id> \[--cancel\]/m);
 assert.match(text.stdout,/Mutation: true/);
 const bad=run(['tasks','get','--cancel','--help','--output','text']);
 assert.equal(bad.status,1);assert.match(bad.stdout,/^INVALID_ARGUMENT: --cancel is only valid/);
 assert.equal(bad.stdout.trim().split('\n').length,1);
});

test('janitor sweep is a direct RPC call and --dry-run becomes a boolean argument', async () => {
  assert.equal(parseCLI(['janitor', 'sweep']).dryRun, undefined);
  assert.equal(parseCLI(['janitor', 'sweep', '--dry-run']).dryRun, true);
  assert.throws(() => parseCLI(['tasks', 'get', '--dry-run']), /--dry-run is only valid for janitor sweep/);
  assert.throws(() => parseCLI(['janitor', 'sweep', '--dry-run', '--dry-run']), /Duplicate option --dry-run/);
  const directory = await mkdtemp(join(tmpdir(), 'wj-'));
  const app = await startLocalIPC(directory, request => ({ apiVersion: 'weaver.v1', ok: true, data: request }));
  const original = process.stdout.write;
  let output = '';
  try {
    process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    assert.equal(await runCLI(['janitor', 'sweep', '--dry-run', '--data-dir', directory]), 0);
    const sent = JSON.parse(output).data as { method: string; args: unknown[]; commandId?: unknown };
    assert.equal(sent.method, 'janitorSweep');
    assert.deepEqual(sent.args, [{ dryRun: true }]);
    assert.equal(sent.commandId, undefined, 'direct RPC commands do not carry a command ID');
    output = '';
    assert.equal(await runCLI(['janitor', 'sweep', '--data-dir', directory]), 0);
    assert.deepEqual((JSON.parse(output).data as { args: unknown[] }).args, [{}]);
    output = '';
    assert.equal(await runCLI(['janitor', 'sweep', '--dry-run', '--input', '{"dryRun":false}', '--data-dir', directory]), 1);
    assert.match(JSON.parse(output).error.message, /Input dry run does not match CLI dry run/);
    output = '';
    assert.equal(await runCLI(['janitor', 'status', '--data-dir', directory]), 0);
    assert.equal((JSON.parse(output).data as { method: string }).method, 'janitorStatus');
  } finally {
    process.stdout.write = original;
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the new commands reach the socket as logical envelopes, not method wrappers',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wc-'));
 const app=await startLocalIPC(directory,request=>({apiVersion:'weaver.v1',ok:true,data:request}));
 const original=process.stdout.write;
 let output='';
 try{
  process.stdout.write=((chunk:unknown)=>{output+=String(chunk);return true;}) as typeof process.stdout.write;
  const cases:[string[],string,Record<string,unknown>][]=[
   [['tasks','health','--task-id','task-1'],'tasks.health',{taskId:'task-1'}],
   [['engines','health'],'engines.health',{}],
   [['engines','penalty','--engine','qoder'],'engines.penalty',{engine:'qoder'}],
   [['engines','unblock','--engine','qoder'],'engines.unblock',{engine:'qoder'}],
   [['workers','unblock','--worker','codex_worker'],'workers.unblock',{worker:'codex_worker'}],
   [['tasks','retry','--task-id','task-1','--cancel'],'tasks.retry',{taskId:'task-1',cancel:true}],
   [['owners','launch','--task-id','task-1','--input','{"expectedRevision":3}'],'owners.launch',{expectedRevision:3,taskId:'task-1'}],
  ];
  for(const [argv,command,args] of cases){
   output='';
   assert.equal(await runCLI([...argv,'--data-dir',directory]),0,command);
   const sent=JSON.parse(output).data as {apiVersion?:string;command?:string;method?:unknown;args?:unknown;commandId?:unknown};
   assert.equal(sent.apiVersion,'weaver.v1',command);
   assert.equal(sent.command,command);
   assert.equal(sent.method,undefined,`${command} must not become an RPC method wrapper`);
   assert.deepEqual(sent.args,args);
   assert.equal(typeof sent.commandId,'string');
  }
  output='';
  assert.equal(await runCLI(['engines','health','--engine','qoder','--data-dir',directory]),1);
  assert.equal(JSON.parse(output).error.code,'INVALID_ARGUMENT');
 }finally{process.stdout.write=original;await app.close();await rm(directory,{recursive:true,force:true});}
});

test('text health names a running command and its age, and a command timeout says so',()=>{
 const running={taskId:'t-3',state:'running_command',engine:'codex',silenceMs:900000,cpuActive:true,cpuIdleMs:0,runningCommand:{pid:42,summary:'pnpm test',startedAt:new Date(0).toISOString(),elapsedMs:125000}};
 const text=renderEnvelope('text',{apiVersion:'weaver.v1',ok:true,data:running});
 assert.match(text,/t-3 running_command/);
 assert.match(text,/command: pnpm test \(pid 42, 125s\)/);
 assert.match(text,/cpuActive=true/);
 const timed={...running,state:'stalled',reason:'command_timeout'};
 const stalled=renderEnvelope('text',{apiVersion:'weaver.v1',ok:true,data:{id:'t-3',status:'running',reason:'stalled',health:timed,hint:'cancel'}});
 assert.match(stalled,/reason=command_timeout/);
 assert.match(stalled,/command: pnpm test/);
});
