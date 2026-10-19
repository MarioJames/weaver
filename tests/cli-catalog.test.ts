import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CLI_CATALOG, CLI_HELP, applyCallerWorkspace, parseCLI, renderEnvelope } from '../src/cli/main';
import { READ_COMMANDS, WRITE_COMMANDS } from '../src/main/commands';

const serverCommands = [...READ_COMMANDS, ...WRITE_COMMANDS];
const rpcCommands = ['policy.get', 'policy.validate', 'policy.save', 'policy.preview', 'engines.scan', 'engines.set-enabled', 'quota.get', 'quota.refresh'];

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
