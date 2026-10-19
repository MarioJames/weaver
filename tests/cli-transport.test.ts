import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { startLocalIPC, readDiscovery, MAX_FRAME_BYTES } from '../src/main/local-ipc';
import { makeRequest, parseCLI, sendRequest } from '../src/cli/main';
async function startOrSkip(t: TestContext, directory: string, handler: (input: any) => unknown) {
  try { return await startLocalIPC(directory, handler); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Sandbox denies Unix socket listen (EPERM); no bypass attempted'); return; } throw error; }
}
const response = (request: any) => ({ apiVersion: 'weaver.v1', commandId: request.commandId, ok: true, data: request });

test('CLI parsing supports args/envelopes and explicit retry IDs', () => {
  const options = parseCLI(['tasks', 'get', '--task-id', 'task-1', '--command-id', 'retry-id', '--json']);
  assert.deepEqual(makeRequest(options), { apiVersion: 'weaver.v1', command: 'tasks.get', commandId: 'retry-id', args: { taskId: 'task-1' } });
  assert.equal(makeRequest(parseCLI(['capabilities'])).command, 'capabilities.get');
  assert.throws(() => parseCLI(['tasks', 'list', '--bogus']));
  assert.throws(() => parseCLI(['tasks', 'get', '--no-input']), /Unknown option/);
  assert.throws(() => makeRequest(options, { apiVersion: 'weaver.v1', command: 'tasks.cancel', args: {} }));
  assert.throws(() => makeRequest(options, { taskId: 'different' }));
});

test('missing app returns APP_NOT_RUNNING', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-'));
  try { await assert.rejects(sendRequest(directory, {}), { code: 'APP_NOT_RUNNING', message: 'Weaver is not running; run weaver server start' }); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual authenticated socket supports request and clean restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-'));
  let app: Awaited<ReturnType<typeof startLocalIPC>> | undefined;
  try {
    app = await startOrSkip(t, directory, response);
    if (!app) return;
    const discovery = await readDiscovery(directory);
    assert.equal((await lstat(discovery.discovery.tokenPath)).mode & 0o777, 0o600);
    const request = makeRequest(parseCLI(['tasks', 'list']));
    assert.deepEqual(await sendRequest(directory, request), response(request));
    await assert.rejects(startLocalIPC(directory, response), { code: 'ENDPOINT_EXISTS' });
    assert.deepEqual(await sendRequest(directory, request), response(request));
    await app.close();
    app = await startOrSkip(t, directory, response);
    if (!app) return;
    assert.deepEqual(await sendRequest(directory, request), response(request));
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('rejects bad authentication and oversized requests without invoking handler', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-'));
  let called = 0;
  const app = await startOrSkip(t, directory, () => { called++; return {}; });
  if (!app) { await rm(directory, { recursive: true, force: true }); return; }
  try {
    const { discovery } = await readDiscovery(directory);
    const exchange = (frame: string) => new Promise<any>((resolve, reject) => {
      const socket = connect(discovery.socketPath); let text = '';
      socket.once('connect', () => socket.write(frame)); socket.on('error', reject);
      socket.on('data', chunk => text += chunk); socket.once('end', () => resolve(JSON.parse(text)));
    });
    assert.equal((await exchange(JSON.stringify({ version: 1, token: '0'.repeat(64), request: {} }) + '\n')).error.code, 'UNAUTHORIZED');
    assert.equal((await exchange('x'.repeat(MAX_FRAME_BYTES + 1))).error.code, 'INVALID_REQUEST');
    assert.equal(called, 0);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unsafe token permissions fail closed and cleanup preserves replacement discovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-'));
  const app = await startOrSkip(t, directory, response);
  if (!app) { await rm(directory, { recursive: true, force: true }); return; }
  try {
    const { discovery } = await readDiscovery(directory);
    await chmod(discovery.tokenPath, 0o644);
    await assert.rejects(readDiscovery(directory), { code: 'UNSAFE_ENDPOINT' });
    const path = join(directory, 'control.v1.json');
    const replacement = JSON.stringify({ ...discovery, instanceId: 'f'.repeat(32) });
    await writeFile(path, replacement);
    await app.close();
    assert.equal(await readFile(path, 'utf8'), replacement);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('endpoint discovery rejects unsafe files and path substitution without sockets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-'));
  try {
    const path = join(directory, 'control.v1.json');
    await writeFile(path, '{}', { mode: 0o644 });
    await assert.rejects(readDiscovery(directory), { code: 'UNSAFE_ENDPOINT' });
    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify({ version: 1, instanceId: 'a'.repeat(32), socketPath: '/tmp/substitute', tokenPath: '/tmp/token' }));
    await assert.rejects(readDiscovery(directory), { code: 'UNSAFE_ENDPOINT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI subprocess prints a single JSON response when app is not running', async () => {
 const {spawnSync}=await import('node:child_process');
 const result=spawnSync(process.execPath,['--import','tsx','src/cli/main.ts','capabilities','--data-dir','/tmp/weaver-does-not-exist-'+Date.now()],{encoding:'utf8'});
 assert.equal(result.status,1);assert.equal(result.stdout.trim().split('\n').length,1);
 const response=JSON.parse(result.stdout);assert.equal(response.apiVersion,'weaver.v1');assert.equal(response.error.code,'APP_NOT_RUNNING');
 assert.match(response.error.message,/weaver server start/);
});

test('only complete launch envelopes receive the fixed startup allowance', async()=>{
 const {requestTimeoutMs,TRANSPORT_TIMEOUT_MS,OWNER_LAUNCH_REQUEST_TIMEOUT_MS}=await import('../src/main/local-ipc');
 const args={taskId:'12345678-1234-4234-8234-123456789abc',expectedRevision:1};
 const launch={apiVersion:'weaver.v1',command:'owners.launch',commandId:'launch-fixture',args};
 const switchLaunch={...launch,command:'owners.switch',args:{...args,launch:true}};
 for(const request of [launch,switchLaunch,{method:'command',args:[launch]}])assert.equal(requestTimeoutMs(request),OWNER_LAUNCH_REQUEST_TIMEOUT_MS);
 for(const request of [{},null,{...launch,apiVersion:'wrong'},{...launch,commandId:''},{...launch,args:{...args,taskId:'bad'}},{...launch,args:{...args,expectedRevision:'1'}},{...switchLaunch,args:{...switchLaunch.args,launch:'true'}},{...switchLaunch,args:{...switchLaunch.args,reason:'unknown'}},{...launch,command:'tasks.list'},{method:'command',args:[launch,launch]},{method:'command',args:[launch],extra:true}])assert.equal(requestTimeoutMs(request),TRANSPORT_TIMEOUT_MS);
});

test('IPC extends wall and inactivity deadlines only after a complete authenticated launch frame',async t=>{
 const {Socket}=await import('node:net');
 const socketTimeout=t.mock.method(Socket.prototype,'setTimeout');
 const wallTimeout=t.mock.method(globalThis,'setTimeout');
 const directory=await mkdtemp(join(tmpdir(),'wv-'));
 const app=await startLocalIPC(directory,response);
 try{
  const {discovery,token}=await readDiscovery(directory);
  const launch={apiVersion:'weaver.v1',command:'owners.launch',commandId:'launch-fixture',args:{taskId:'12345678-1234-4234-8234-123456789abc',expectedRevision:1}};
  const reset=()=>{socketTimeout.mock.resetCalls();wallTimeout.mock.resetCalls();};
  const extended=()=>({socket:socketTimeout.mock.calls.some(call=>call.arguments[0]===210000),wall:wallTimeout.mock.calls.some(call=>call.arguments[1]===210000)});
  const raw=(frame:string,partial=false)=>new Promise<any>((resolve,reject)=>{
   const socket=connect(discovery.socketPath);let text='';socket.on('error',reject);
   socket.once('connect',()=>{socket.write(frame);if(partial)setImmediate(()=>{socket.destroy();resolve(undefined);});});
   socket.on('data',chunk=>text+=chunk);socket.on('end',()=>resolve(JSON.parse(text)));
  });
  for(const [frame,partial] of [
   [JSON.stringify({version:1,token,request:launch}).slice(0,-1),true],
   ['{broken}\n',false],
   [JSON.stringify({version:1,token:'0'.repeat(64),request:launch})+'\n',false],
   [JSON.stringify({version:1,token,request:{...launch,args:{}}})+'\n',false],
   [JSON.stringify({version:1,token,request:{...launch,command:'tasks.list'}})+'\n',false],
  ] as const){reset();await raw(frame,partial);assert.deepEqual(extended(),{socket:false,wall:false});}
  for(const request of [launch,{method:'command',args:[launch]}]){
   reset();await raw(JSON.stringify({version:1,token,request})+'\n');assert.deepEqual(extended(),{socket:true,wall:true});
  }
  reset();await assert.rejects(sendRequest(directory,launch,0),{code:'TIMEOUT'});assert.equal(wallTimeout.mock.calls.some(call=>call.arguments[1]===210000),false);
 }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});

test('explicit shorter client deadlines remain binding for launch and ordinary requests',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wv-'));
 const replies:(()=>void)[]=[];
 const app=await startLocalIPC(directory,request=>new Promise(resolve=>replies.push(()=>resolve(response(request)))));
 try{
  const launch={apiVersion:'weaver.v1',command:'owners.launch',commandId:'short-launch',args:{taskId:'12345678-1234-4234-8234-123456789abc',expectedRevision:1}};
  for(const request of [launch,{apiVersion:'weaver.v1',command:'tasks.list',args:{}}]){
   await assert.rejects(sendRequest(directory,request,30),{code:'TIMEOUT'});
   assert.equal(replies.length,1);replies.shift()!();
  }
 }finally{for(const reply of replies)reply();await app.close();await rm(directory,{recursive:true,force:true});}
});
