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
  try { await assert.rejects(sendRequest(directory, {}), { code: 'APP_NOT_RUNNING' }); }
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
 assert.match(response.error.message,/weaver web --no-open/);
});
