import { TaskStore } from '../../src/main/store';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { connect, createServer } from 'node:net';
import { request } from 'node:http';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalIPC } from '../../src/main/local-ipc';
import { acquireInstanceLock } from '../../src/main/instance-lock';
import { startCliAgent } from '../../src/main/adapters/cli/index';
import { startRuntime, type WeaverRuntime } from '../../src/main/runtime';
import { ENGINE_CATALOG, EXECUTION_BOUNDARY } from '../../src/shared/engines';
import { RPC_METHODS } from '../../src/shared/contracts/rpc';

const REPO = process.cwd();
const TASK = { title: 'Imported', instruction: 'demo only', owner: { name: 'demo', transport: 'herdr-visible', session: 's', pane: 'p' } };

function httpCall(port: number, options: { method?: string; path?: string; headers?: Record<string, string | string[]>; body?: string | Buffer }) {
  return new Promise<{ status: number; text: string; json: any; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers: options.headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function rpcHeaders(port: number, extra: Record<string, string> = {}) {
  return { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...extra };
}

const exec = promisify(execFile);
async function cli(dataDir: string, args: string[], env?: NodeJS.ProcessEnv) {
  let status = 0;
  let stdout = '';
  let stderr = '';
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args, '--data-dir', dataDir], { cwd: REPO, encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...env } });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failed = error as { status?: number; code?: number | string; stdout?: string; stderr?: string };
    status = typeof failed.status === 'number' ? failed.status : typeof failed.code === 'number' ? failed.code : 1;
    stdout = failed.stdout ?? '';
    stderr = failed.stderr ?? '';
  }
  let json: any;
  try { json = JSON.parse(stdout); } catch { json = undefined; }
  return { status, stdout, stderr, json };
}

async function boot(t: TestContext, dataDir: string, port = 0, rendererRoot?: string): Promise<WeaverRuntime | undefined> {
  try { return await startRuntime({ dataDir, port, open: false, rendererRoot }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Sandbox denies Unix socket listen (EPERM); no bypass attempted'); return; }
    throw error;
  }
}

function rawUpgrade(port: number, headers: { host: string; origin?: string; protocol?: string; path?: string }) {
  return new Promise<{ status: number; closed: boolean }>(resolve => {
    const socket = connect(port, '127.0.0.1');
    let status = 0;
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ status, closed });
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.on('connect', () => {
      const lines = [
        `GET ${headers.path ?? '/'} HTTP/1.1`,
        `Host: ${headers.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ];
      if (headers.origin) lines.push(`Origin: ${headers.origin}`);
      if (headers.protocol) lines.push(`Sec-WebSocket-Protocol: ${headers.protocol}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      const match = chunk.toString('utf8').match(/^HTTP\/1\.[01] (\d+)/);
      if (match) status = Number(match[1]);
      finish(true);
    });
    socket.on('error', () => finish(true));
    socket.on('close', () => finish(true));
  });
}

async function listenPort(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return { port: address.port, close: () => new Promise(resolve => server.close(() => resolve())) };
}

test('HTTP guards reject unsafe requests before any task state exists', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const rendererRoot = join(dataDir, 'renderer');
  await mkdir(rendererRoot);
  await writeFile(join(rendererRoot, 'index.html'), 'INDEX');
  await writeFile(join(dataDir, 'secret.txt'), 'SECRET-TOKEN');
  const runtime = await boot(t, dataDir, 0, rendererRoot);
  if (!runtime) { await rm(dataDir, { recursive: true, force: true }); return; }
  const port = runtime.port;
  const post = (headers: Record<string, string>, body: string) => httpCall(port, { method: 'POST', path: '/api/rpc', headers, body });
  try {
    const host = await post({ ...rpcHeaders(port), host: `localhost:${port}` }, JSON.stringify({ method: 'createTask', args: [TASK] }));
    assert.equal(host.status, 403);
    assert.equal(host.json.error.code, 'INVALID_HOST');
    assert.equal(host.text.includes('SECRET-TOKEN'), false);
    assert.equal(host.text.includes('\n    at '), false);

    const origin = await post({ host: `127.0.0.1:${port}`, 'content-type': 'application/json' }, JSON.stringify({ method: 'createTask', args: [TASK] }));
    assert.equal(origin.status, 403);
    assert.equal(origin.json.error.code, 'INVALID_ORIGIN');

    const cross = await post(rpcHeaders(port, { 'sec-fetch-site': 'cross-site' }), JSON.stringify({ method: 'getPolicy', args: [] }));
    assert.equal(cross.status, 403);
    assert.equal(cross.json.error.code, 'INVALID_FETCH_SITE');

    const get = await httpCall(port, { method: 'GET', path: '/api/rpc', headers: { host: `127.0.0.1:${port}` } });
    assert.equal(get.status, 405);
    assert.equal(get.json.error.code, 'METHOD_NOT_ALLOWED');

    const type = await post({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'text/plain' }, '{}');
    assert.equal(type.status, 415);

    const huge = await post(rpcHeaders(port), 'x'.repeat(1024 * 1024 + 1));
    assert.equal(huge.status, 413);
    assert.equal(huge.json.error.code, 'PAYLOAD_TOO_LARGE');

    const escaped = await httpCall(port, { path: '/%2e%2e/secret.txt', headers: { host: `127.0.0.1:${port}` } });
    assert.equal(escaped.status, 404);
    assert.equal(escaped.text.includes('SECRET-TOKEN'), false);
    const rawEscape = await httpCall(port, { path: '/../secret.txt', headers: { host: `127.0.0.1:${port}` } });
    assert.equal(rawEscape.status, 404);
    assert.equal(rawEscape.text.includes('SECRET-TOKEN'), false);

    const files = await readdir(dataDir);
    assert.ok(files.includes('weaver.db'), 'all persistence is in weaver.db');
    assert.deepEqual(files.filter(name => /\.v1\.json/.test(name) && name !== 'control.v1.json'), [], 'no other *.v1.json is read or written');

    const page = await httpCall(port, { path: '/', headers: { host: `127.0.0.1:${port}` } });
    assert.equal(page.status, 200);
    assert.equal(page.text, 'INDEX');
    assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.match(String(page.headers['cache-control']), /no-store/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');

    const badPage = await httpCall(port, { path: '/', headers: { host: `localhost:${port}` } });
    assert.equal(badPage.status, 403);

    const caps = await post(rpcHeaders(port), JSON.stringify({ method: 'capabilities', args: [] }));
    assert.equal(caps.status, 200);
    assert.equal(caps.json.result.worker.includes('mock'), true);
    assert.equal(caps.json.result.storePath, join(dataDir, 'weaver.db'));

    const unknown = await post(rpcHeaders(port), JSON.stringify({ method: 'importTask', args: [] }));
    assert.equal(unknown.status, 400);
    const extra = await post(rpcHeaders(port), JSON.stringify({ method: 'getPolicy', args: [], token: 'nope' }));
    assert.equal(extra.status, 400);
    const arity = await post(rpcHeaders(port), JSON.stringify({ method: 'getPolicy', args: [1] }));
    assert.equal(arity.status, 400);

    const command = await post(rpcHeaders(port), JSON.stringify({ method: 'command', args: [{ apiVersion: 'weaver.v1', command: 'tasks.get', args: {} }] }));
    assert.equal(command.status, 200);
    assert.equal(command.json.result.ok, false);
    assert.equal(typeof command.json.result.error.code, 'string');

    const created = await post(rpcHeaders(port), JSON.stringify({ method: 'createTask', args: [TASK] }));
    assert.equal(created.status, 200);
    assert.equal(created.json.result.title, 'Imported');
    const listed = await post(rpcHeaders(port), JSON.stringify({ method: 'listTasks', args: [] }));
    assert.equal(listed.json.result.length, 1);

    const policy = await cli(dataDir, ['policy', 'get']);
    assert.equal(policy.status, 0);
    assert.equal(policy.json.ok, true);
    assert.equal(policy.json.data.revision, (await post(rpcHeaders(port), JSON.stringify({ method: 'getPolicy', args: [] }))).json.result.revision);
  } finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('second web invocation does not open or recover live task state', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const taskPath = join(dataDir,'weaver.db');
  await writeFile(taskPath, '{');
  let lock: Awaited<ReturnType<typeof acquireInstanceLock>> | undefined;
  try {
    lock = await acquireInstanceLock(dataDir);
    await assert.rejects(startRuntime({ dataDir, port: 0, open: false }), { code: 'INSTANCE_LOCKED' });
    assert.equal(await readFile(taskPath, 'utf8'), '{');
  } finally { await lock?.release(); await rm(dataDir, { recursive: true, force: true }); }
});

test('initialization failure releases the instance lock and leaves no late writer', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const taskPath = join(dataDir, 'weaver.db');
  const damaged = 'this is not a database file at all, just text';
  await writeFile(taskPath, damaged);
  try {
    await assert.rejects(startRuntime({ dataDir, port: 0, open: false }), /Could not initialize Weaver SQLite store/);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(await readFile(taskPath, 'utf8'), damaged);
    const lock = await acquireInstanceLock(dataDir);
    await lock.release();
    await assert.rejects(readFile(join(dataDir, 'control.v1.json'), 'utf8'));
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('normal close releases the instance lock after the endpoint is gone', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  try {
    const held = await startRuntime({ dataDir, port: 0, open: false });
    await held.close();
    const lock = await acquireInstanceLock(dataDir);
    await lock.release();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('failed HTTP bind releases only this attempt', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const taskPath = join(dataDir,'weaver.db');
  await writeFile(taskPath, '{');
  const held = await listenPort();
  try {
    await assert.rejects(startRuntime({ dataDir, port: held.port, open: false }), (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Sandbox denies Unix socket listen (EPERM); no bypass attempted'); return true; }
      assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE');
      return true;
    });
    await assert.rejects(readFile(join(dataDir, 'control.v1.json'), 'utf8'));
    assert.equal(await readFile(taskPath, 'utf8'), '{');
  } finally { await held.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('weaver web reports bind and damaged-store failures', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const held = await listenPort();
  try {
    const busy = await cli(dataDir, ['web', '--no-open', '--port', String(held.port)]);
    if (busy.stderr.includes('EPERM') || busy.json?.error?.code === 'EPERM') { t.skip('Sandbox denies Unix socket listen (EPERM); no bypass attempted'); return; }
    assert.equal(busy.status, 1);
    assert.equal(busy.stdout.trim().split('\n').length, 1);
    assert.equal(busy.json.apiVersion, 'weaver.v1');
    assert.equal(busy.json.ok, false);
    assert.equal(busy.json.error.code, 'EADDRINUSE');
    assert.match(busy.json.error.message, new RegExp(String(held.port)));
    assert.match(busy.json.error.message, /--port/);
    assert.equal(Object.hasOwn(busy.json.error, 'stack'), false);
    await assert.rejects(readFile(join(dataDir, 'control.v1.json'), 'utf8'));
    const taskPath = join(dataDir, 'weaver.db');
    await writeFile(taskPath, 'this is not a database file at all, just text');
    const damaged = await cli(dataDir, ['web', '--no-open', '--port', '0']);
    assert.equal(damaged.status, 1, damaged.stdout + damaged.stderr);
    assert.equal(damaged.stdout.trim().split('\n').length, 1);
    assert.notEqual(damaged.json.error.code, 'CLI_ERROR');
    assert.match(damaged.json.error.message, /SQLite|not a database|damaged|Unsupported/);
    assert.equal(await readFile(taskPath, 'utf8'), 'this is not a database file at all, just text', 'the damaged database is retained untouched');
    await assert.rejects(readFile(join(dataDir, 'control.v1.json'), 'utf8'));
  } finally { await held.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('headless CLI can create, dispatch, review, and leaving does not cancel work', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const runtime = await boot(t, dataDir);
  if (!runtime) { await rm(dataDir, { recursive: true, force: true }); return; }
  try {
    const herdrBin = await mkdtemp(join(tmpdir(), 't-'));
    const originalPath = process.env.PATH ?? '';
    try {
      const fakeHerdr = join(herdrBin, 'herdr');
      await writeFile(fakeHerdr, '#!/bin/sh\nexit 0\n');
      await chmod(fakeHerdr, 0o755);
      // The running app owns the Herdr availability decision, so only its PATH changes between the two reads.
      process.env.PATH = herdrBin;
      const withHerdr = await cli(dataDir, ['capabilities'], { PATH: originalPath });
      assert.equal(withHerdr.status, 0, withHerdr.stdout + withHerdr.stderr);
      assert.equal(withHerdr.json.ok, true);
      assert.equal(withHerdr.json.data.ownerSpawn, 'herdr');
      assert.equal(withHerdr.json.data.realExecution, typeof startCliAgent === 'function');
      process.env.PATH = join(herdrBin, 'no-herdr');
      const withoutHerdr = await cli(dataDir, ['capabilities'], { PATH: originalPath });
      assert.equal(withoutHerdr.status, 0, withoutHerdr.stdout + withoutHerdr.stderr);
      assert.equal(withoutHerdr.json.ok, true);
      assert.equal(withoutHerdr.json.data.ownerSpawn, 'logical-registration');
      assert.equal(withoutHerdr.json.data.realExecution, typeof startCliAgent === 'function');
    } finally { process.env.PATH = originalPath; await rm(herdrBin, { recursive: true, force: true }); }
    const input = join(dataDir, 'create.json');
    await writeFile(input, JSON.stringify({ title: 'Headless', instruction: 'Mock demonstration only.', owner: { name: 'demo', transport: 'herdr-visible', session: 'reference', pane: 'reference' } }));
    const created = await cli(dataDir, ['tasks', 'create', '--input', input, '--command-id', 'create-1']);
    assert.equal(created.status, 0, created.stdout + created.stderr);
    const id = created.json.data.id as string;
    const spawnInput = join(dataDir, 'spawn.json');
    await writeFile(spawnInput, JSON.stringify({ provider: 'mock-jsonl' }));
    const spawned = await cli(dataDir, ['workers', 'spawn', '--task-id', id, '--input', spawnInput, '--command-id', 'dispatch-1']);
    assert.equal(spawned.json.data.dispatch.execution, 'mock');
    assert.equal(spawned.json.data.dispatch.maxWaitMinutes, 15);
    assert.equal(spawned.json.data.run?.timeoutMs, undefined);
    assert.equal(spawned.status, 0, spawned.stdout + spawned.stderr);
    assert.equal(spawned.json.data.status, 'queued');
    assert.equal(spawned.json.data.scheduled, true);
    assert.equal(spawned.json.data.started, false);
    let finished: any;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const current = await cli(dataDir, ['tasks', 'get', '--task-id', id]);
      if (current.json.ok && ['completed', 'failed', 'cancelled'].includes(current.json.data.status)) { finished = current.json.data; break; }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(finished?.status, 'completed');
    const results = await cli(dataDir, ['tasks', 'results', '--task-id', id]);
    assert.equal(results.status, 0, results.stdout);
    const latest = await cli(dataDir, ['tasks', 'get', '--task-id', id]);
    assert.equal(latest.status, 0, latest.stdout + latest.stderr);
    const reviewPath = join(dataDir, 'review.json');
    await writeFile(reviewPath, JSON.stringify({ taskId: id, manifestDigest: results.json.data.manifestDigest, decision: 'accepted', expectedRevision: latest.json.data.revision }));
    const review = await cli(dataDir, ['reviews', 'submit', '--input', reviewPath, '--command-id', 'review-1']);
    assert.equal(review.status, 0, review.stdout + review.stderr);
    assert.equal(review.json.data.acceptance, 'accepted');
  } finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('shutdown and restart keep task history', { timeout: 20_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'web', '--no-open', '--port', '0', '--data-dir', dataDir], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += chunk; });
  const url = await new Promise<string>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`no ready url\n${text}\n${stderr}`)), 8000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`web exited ${code}\n${stderr}`)); });
    child.stdout?.on('data', chunk => {
      text += chunk;
      if (!text.includes('\n')) return;
      clearTimeout(timer);
      resolve(text.split('\n')[0].trim());
    });
  }).catch(async error => {
    if (stderr.includes('EPERM') || String(error).includes('EPERM')) { t.skip('Sandbox denies Unix socket listen (EPERM); no bypass attempted'); child.kill('SIGKILL'); return ''; }
    child.kill('SIGKILL');
    throw error;
  });
  if (!url) { await rm(dataDir, { recursive: true, force: true }); return; }
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const input = join(dataDir, 'create.json');
    await writeFile(input, JSON.stringify(TASK));
    const created = await cli(dataDir, ['tasks', 'create', '--input', input, '--command-id', 'keep-1']);
    assert.equal(created.status, 0, created.stdout + created.stderr);
    child.kill('SIGTERM');
    const exit = await new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    assert.equal(exit === 0 || exit === null, true);
    await assert.rejects(readFile(join(dataDir, 'control.v1.json'), 'utf8'));
    const saved = new TaskStore(join(dataDir,'weaver.db'));
    assert.equal(saved.list().length, 1);saved.close();
    const restarted = await boot(t, dataDir);
    if (!restarted) return;
    try {
      const again = await cli(dataDir, ['tasks', 'get', '--task-id', created.json.data.id]);
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.equal(again.json.data.title, 'Imported');
    } finally { await restarted.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(dataDir, { recursive: true, force: true }); }
});

test('a repeated stop signal still drains and removes the endpoint', { timeout: 20_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'web', '--dev', '--no-open', '--port', '0', '--data-dir', dataDir], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += chunk; });
  const ready = await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready url\n${stderr}`)), 8000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`web exited ${code}\n${stderr}`)); });
    // Only the URL line means the stop handlers are installed.
    let text = '';
    child.stdout?.on('data', chunk => { text += chunk; if (/^http:\/\/127\.0\.0\.1:\d+$/m.test(text)) { clearTimeout(timer); resolve(true); } });
  }).catch(error => {
    child.kill('SIGKILL');
    if (stderr.includes('EPERM') || String(error).includes('EPERM')) { t.skip('Sandbox denies Unix socket listen (EPERM); no bypass attempted'); return false; }
    throw error;
  });
  try {
    if (!ready) return;
    child.removeAllListeners('exit');
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    // A process group stop (Ctrl+C under tsx watch, systemd scope stop) delivers the signal twice.
    child.kill('SIGINT');
    await new Promise(resolve => setTimeout(resolve, 2));
    child.kill('SIGINT');
    // The exit status is not the contract: a signal landing after the drain, during Node teardown, may still end the process.
    await exited;
    await assert.rejects(readFile(join(dataDir, 'control.v1.json'), 'utf8'));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(dataDir, { recursive: true, force: true }); }
});

test('engine scan and enable do not create roles', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const runtime = await boot(t, dataDir);
  if (!runtime) { await rm(dataDir, { recursive: true, force: true }); return; }
  try {
    const scan = await httpCall(runtime.port, { method: 'POST', path: '/api/rpc', headers: rpcHeaders(runtime.port), body: JSON.stringify({ method: 'scanEngines', args: [] }) });
    assert.equal(scan.status, 200, scan.text);
    assert.equal(scan.json.result.probes.length, ENGINE_CATALOG.length);
    assert.equal(scan.json.result.boundary.roleAutoCreate, false);
    assert.equal(scan.json.result.boundary.realAdapter, EXECUTION_BOUNDARY.realAdapter);
    const installed = scan.json.result.probes.find((probe: { status: string }) => probe.status === 'installed');
    if (!installed) return;
    const before = await httpCall(runtime.port, { method: 'POST', path: '/api/rpc', headers: rpcHeaders(runtime.port), body: JSON.stringify({ method: 'getPolicy', args: [] }) });
    const enabled = await httpCall(runtime.port, { method: 'POST', path: '/api/rpc', headers: rpcHeaders(runtime.port), body: JSON.stringify({ method: 'setEngineEnabled', args: [{ id: installed.id, enabled: true, revision: before.json.result.revision }] }) });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal(enabled.json.result.snapshot.config.engines[installed.id].enabled, true);
    assert.deepEqual(enabled.json.result.snapshot.config.owners, before.json.result.config.owners);
    assert.deepEqual(enabled.json.result.snapshot.config.workers, before.json.result.config.workers);
    const cliScan = await cli(dataDir, ['engines', 'scan']);
    assert.equal(cliScan.status, 0, cliScan.stdout + cliScan.stderr);
    assert.equal(cliScan.json.data.probes.length, ENGINE_CATALOG.length);
  } finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('a rejected engine enable leaves the server and policy usable', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const runtime = await boot(t, dataDir);
  if (!runtime) { await rm(dataDir, { recursive: true, force: true }); return; }
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const before = await httpCall(runtime.port, { method: 'POST', path: '/api/rpc', headers: rpcHeaders(runtime.port), body: JSON.stringify({ method: 'getPolicy', args: [] }) });
    assert.equal(before.status, 200, before.text);
    const history = async () => (await httpCall(runtime.port, { method: 'POST', path: '/api/rpc', headers: rpcHeaders(runtime.port), body: JSON.stringify({ method: 'policyHistory', args: [] }) })).json.result;
    const beforeHistory = await history();
    const rejected = await httpCall(runtime.port, { method: 'POST', path: '/api/rpc', headers: rpcHeaders(runtime.port), body: JSON.stringify({ method: 'setEngineEnabled', args: [{ id: 'claude', enabled: true, revision: before.json.result.revision + 999 }] }) });
    assert.notEqual(rejected.status, 200);
    assert.equal(rejected.json.error.code.length > 0, true);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
    const caps = await httpCall(runtime.port, { method: 'POST', path: '/api/rpc', headers: rpcHeaders(runtime.port), body: JSON.stringify({ method: 'capabilities', args: [] }) });
    assert.equal(caps.status, 200, caps.text);
    const after = await httpCall(runtime.port, { method: 'POST', path: '/api/rpc', headers: rpcHeaders(runtime.port), body: JSON.stringify({ method: 'getPolicy', args: [] }) });
    assert.equal(after.status, 200, after.text);
    assert.equal(after.json.result.revision, before.json.result.revision);
    assert.deepEqual(after.json.result.config, before.json.result.config);
    assert.deepEqual(await history(), beforeHistory, 'a rejected enable records no policy revision');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('production upgrades and idle sockets cannot hold shutdown', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const runtime = await boot(t, dataDir);
  if (!runtime) { await rm(dataDir, { recursive: true, force: true }); return; }
  const idle = connect(runtime.port, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => { idle.once('connect', () => resolve()); idle.once('error', reject); });
    const upgrade = await rawUpgrade(runtime.port, { host: `127.0.0.1:${runtime.port}`, origin: `http://127.0.0.1:${runtime.port}`, protocol: 'vite-hmr' });
    assert.notEqual(upgrade.status, 101);
    assert.equal(upgrade.closed, true);
    const closed = runtime.close();
    const outcome = await Promise.race([
      closed.then(() => 'closed' as const),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 2_000)),
    ]);
    assert.equal(outcome, 'closed');
    await closed;
  } finally {
    idle.destroy();
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a static read failure does not kill the server', { timeout: 10_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const rendererRoot = join(dataDir, 'renderer');
  await mkdir(rendererRoot);
  await writeFile(join(rendererRoot, 'index.html'), 'INDEX');
  const locked = join(rendererRoot, 'asset.txt');
  await writeFile(locked, 'SECRET-TOKEN');
  await chmod(locked, 0);
  const runtime = await boot(t, dataDir, 0, rendererRoot);
  if (!runtime) { await rm(dataDir, { recursive: true, force: true }); return; }
  const crashes: unknown[] = [];
  const onCrash = (error: unknown) => { crashes.push(error); };
  process.on('uncaughtException', onCrash);
  try {
    const broken = await httpCall(runtime.port, { path: '/asset.txt', headers: { host: `127.0.0.1:${runtime.port}` } }).catch(() => ({ status: 0, text: '' }));
    assert.equal(broken.text.includes('SECRET-TOKEN'), false);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(crashes, []);
    const page = await httpCall(runtime.port, { path: '/', headers: { host: `127.0.0.1:${runtime.port}` } });
    assert.equal(page.status, 200);
    assert.equal(page.text, 'INDEX');
    assert.equal(page.text.includes('SECRET-TOKEN'), false);
  } finally {
    process.off('uncaughtException', onCrash);
    await chmod(locked, 0o644).catch(() => {});
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('dev mode serves the renderer on the owned origin', { timeout: 60_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  let runtime: WeaverRuntime | undefined;
  try {
    try { runtime = await startRuntime({ dataDir, port: 0, open: false, dev: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Sandbox denies Unix socket listen (EPERM); no bypass attempted'); return; }
      throw error;
    }
    if (!runtime) throw new Error('runtime missing');
    const host = `127.0.0.1:${runtime.port}`;
    const page = await httpCall(runtime.port, { path: '/', headers: { host } });
    assert.equal(page.status, 200, page.text.slice(0, 300));
    const scripts = page.text.match(/<script\b[^>]*>/gi) ?? [];
    assert.ok(scripts.length > 0);
    assert.ok(scripts.every(tag => /\bsrc=/.test(tag)));
    assert.match(page.text, /src="[^"]*@vite\/client"/);
    assert.match(page.text, /src="[^"]*main\.tsx"/);
    // The dependency cache lives in this runtime's data dir, never in the shared node_modules/.vite of a running dev server.
    for (let i = 0; i < 100 && !existsSync(join(dataDir, 'vite')); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(existsSync(join(dataDir, 'vite')), 'vite cache should be created inside the data dir');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    const csp = String(page.headers['content-security-policy']);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    const mod = await httpCall(runtime.port, { path: '/main.tsx', headers: { host } });
    assert.equal(mod.status, 200, mod.text.slice(0, 300));
    assert.match(String(mod.headers['content-type']), /javascript/);
    assert.match(mod.text, /\bimport\b/);
    assert.equal(mod.headers['cache-control'], 'no-store');
    assert.match(String(mod.headers['content-security-policy']), /script-src 'self'/);
    const client = await httpCall(runtime.port, { path: '/@vite/client', headers: { host } });
    assert.equal(client.status, 200, client.text.slice(0, 200));
    assert.match(client.text, /const hmrPort = null;/);
    assert.doesNotMatch(client.text, /24678/);
    assert.equal(client.headers['cache-control'], 'no-store');
    assert.equal(client.headers['access-control-allow-origin'], undefined);
    const tokenMatch = client.text.match(/const wsToken = ("(?:[^"\\]|\\.)*");/);
    assert.ok(tokenMatch);
    const token = JSON.parse(tokenMatch![1]) as string;
    const accepted = await rawUpgrade(runtime.port, { host, origin: `http://${host}`, protocol: 'vite-hmr', path: `/?token=${encodeURIComponent(token)}` });
    assert.equal(accepted.status, 101);
    const rejected = await rawUpgrade(runtime.port, { host, origin: 'http://127.0.0.1:9', protocol: 'vite-hmr', path: `/?token=${encodeURIComponent(token)}` });
    assert.notEqual(rejected.status, 101);
    assert.equal(rejected.closed, true);
  } finally { await runtime?.close(); await rm(dataDir, { recursive: true, force: true }); }
  // Vite's optimizer can outlive its own close; the runtime must wait for that write before close resolves.
  await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.equal(existsSync(dataDir), false, 'no late Vite dependency-cache write may recreate the data dir');
});

test('runtime janitor sweeps an injected temp root at startup and on demand', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 't-'));
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  const stale = join(root, 'wv-janitor-stale');
  const fresh = join(root, 'wv-janitor-fresh');
  await mkdir(stale); await writeFile(join(stale, 'cache.txt'), 'x'.repeat(64));
  await mkdir(fresh); await writeFile(join(fresh, 'cache.txt'), 'fresh');
  await utimes(join(stale, 'cache.txt'), old, old); await utimes(stale, old, old);
  let runtime: WeaverRuntime | undefined;
  try {
    try { runtime = await startRuntime({ dataDir, port: 0, open: false, janitor: { tmpRoot: root } }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Sandbox denies Unix socket listen (EPERM); no bypass attempted'); return; }
      throw error;
    }
    const call = (method: string, args: unknown[]) => httpCall(runtime!.port, { method: 'POST', path: '/api/rpc', headers: rpcHeaders(runtime!.port), body: JSON.stringify({ method, args }) });
    let status = await call('janitorStatus', []);
    for (let i = 0; i < 100; i++) {
      if (!existsSync(stale) && status.json?.result?.history?.length >= 1) break;
      await new Promise(resolve => setTimeout(resolve, 50));
      status = await call('janitorStatus', []);
    }
    assert.equal(existsSync(stale), false, 'the startup sweep removes a stale allow-listed directory');
    assert.equal(existsSync(fresh), true, 'a fresh directory is kept');
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json.result.settings.ttl_hours, 24);
    assert.equal(status.json.result.history[0].tmpRoot, root);
    assert.ok(status.json.result.history[0].scanned >= 2);
    const late = join(root, 'wv-janitor-late');
    await mkdir(late); await writeFile(join(late, 'cache.txt'), 'x');
    await utimes(join(late, 'cache.txt'), old, old); await utimes(late, old, old);
    const dry = await call('janitorSweep', [{ dryRun: true }]);
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.result.dryRun, true);
    assert.equal(dry.json.result.removed, 1);
    assert.equal(existsSync(late), true, 'dry run deletes nothing');
    const real = await call('janitorSweep', [{ dryRun: false }]);
    assert.equal(real.status, 200, real.text);
    assert.equal(real.json.result.removed, 1);
    assert.equal(existsSync(late), false);
    const after = await call('janitorStatus', []);
    assert.equal(after.json.result.history.length >= 3, true, 'startup and both on-demand sweeps are recorded');
    const cliStatus = await cli(dataDir, ['janitor', 'status']);
    assert.equal(cliStatus.status, 0, cliStatus.stderr);
    assert.equal(cliStatus.json.apiVersion, 'weaver.v1');
    assert.equal(cliStatus.json.data.settings.ttl_hours, 24);
    const cliDry = await cli(dataDir, ['janitor', 'sweep', '--dry-run']);
    assert.equal(cliDry.status, 0, cliDry.stderr);
    assert.equal(cliDry.json.data.dryRun, true);
    assert.equal(cliDry.json.data.removed, 0, 'only the kept fresh directory remains');
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('HTTP startup timeout begins after origin and complete RPC validation and restores on response',async t=>{
 const {Socket}=await import('node:net');const {startHttpServer}=await import('../../src/main/http');
 const timeout=t.mock.method(Socket.prototype,'setTimeout');
 const server=await startHttpServer({port:0,call:async()=>({ok:true})});
 const launch={apiVersion:'weaver.v1',command:'owners.launch',commandId:'http-launch',args:{taskId:'12345678-1234-4234-8234-123456789abc',expectedRevision:1}};
 try{
  for(const options of [
   {headers:rpcHeaders(server.port,{origin:'http://foreign.example'}),body:JSON.stringify({method:'command',args:[launch]})},
   {headers:rpcHeaders(server.port),body:'{broken}'},
   {headers:rpcHeaders(server.port),body:JSON.stringify({method:'command',args:[{...launch,args:{}}]})},
   {headers:rpcHeaders(server.port),body:JSON.stringify({method:'command',args:[{...launch,command:'tasks.list'}]})},
  ]){timeout.mock.resetCalls();await httpCall(server.port,{method:'POST',path:'/api/rpc',...options});assert.equal(timeout.mock.calls.some(call=>call.arguments[0]===210000),false);}
  timeout.mock.resetCalls();const response=await httpCall(server.port,{method:'POST',path:'/api/rpc',headers:rpcHeaders(server.port),body:JSON.stringify({method:'command',args:[launch]})});
  assert.equal(response.status,200);const timeouts=timeout.mock.calls.map(call=>call.arguments[0]);assert.ok(timeouts.includes(210000));assert.ok(timeouts.lastIndexOf(15000)>timeouts.indexOf(210000));
 }finally{await server.close();}
});

test('listEngineModels is a one-argument read RPC: valid input lists, malformed input is INVALID_REQUEST', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const runtime = await boot(t, dataDir);
  if (!runtime) { await rm(dataDir, { recursive: true, force: true }); return; }
  const call = (args: unknown[]) => httpCall(runtime.port, { method: 'POST', path: '/api/rpc', headers: rpcHeaders(runtime.port), body: JSON.stringify({ method: 'listEngineModels', args }) });
  try {
    const listed = await call([{ engine: 'claude' }]);
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.json.result.engine, 'claude');
    assert.equal(listed.json.result.status, 'ok');
    assert.ok(listed.json.result.models.some((model: { id: string }) => model.id === 'sonnet'));
    for (const bad of [[], [{ engine: 'not-an-engine' }], [{ engine: 'claude', surprise: true }], [{ engine: 'claude', refresh: 'yes' }], ['claude'], [{ engine: 'claude' }, 'extra']]) {
      const rejected = await call(bad);
      assert.equal(rejected.status, 400, JSON.stringify(bad));
      assert.equal(rejected.json.error.code, 'INVALID_REQUEST', JSON.stringify(bad));
    }
  } finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
  const client = await readFile(new URL('../../src/renderer/api/client.ts', import.meta.url), 'utf8');
  assert.equal(RPC_METHODS.listEngineModels.timeoutMs, 40_000, 'the renderer waits up to 40 seconds for a model list');
  assert.equal(RPC_METHODS.workerProbe.timeoutMs, 130_000);
  assert.deepEqual(Object.keys(RPC_METHODS).filter(method => 'timeoutMs' in RPC_METHODS[method as keyof typeof RPC_METHODS]).sort(), ['listEngineModels', 'refreshChannelQuota', 'workerProbe']);
  assert.deepEqual(Object.keys(RPC_METHODS).filter(method => 'retryable' in RPC_METHODS[method as keyof typeof RPC_METHODS]).sort(), ['capabilities', 'getChannels', 'getEngineCleanup', 'getImSettings', 'getPolicy', 'getQuota', 'getStall', 'getTask', 'janitorStatus', 'listEngineModels', 'listTasks', 'previewRoute', 'sayHiResult', 'validatePolicy', 'workerProbeStatus']);
  assert.match(client, /from '\.\.\/\.\.\/shared\/contracts\/rpc'/, 'the renderer client derives its method table, deadlines and retryable reads from the shared RPC contract');
  assert.doesNotMatch(client, /call\('listEngineModels'|\w+: \d+_000/, 'the renderer client does not hand-write method wrappers or deadlines');
});

test('policy saves are numbered revisions over RPC: history lists them, rollback is a new revision, a stale save is a 409 conflict', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 't-'));
  const runtime = await boot(t, dataDir);
  if (!runtime) { await rm(dataDir, { recursive: true, force: true }); return; }
  const call = (method: string, args: unknown[]) => httpCall(runtime.port, { method: 'POST', path: '/api/rpc', headers: rpcHeaders(runtime.port), body: JSON.stringify({ method, args }) });
  try {
    const first = (await call('getPolicy', [])).json.result;
    assert.equal(first.revision, 0);
    const config = structuredClone(first.config);
    config.display = { timezone: 'Asia/Shanghai' };
    const saved = await call('savePolicy', [{ revision: 0, config, blocks: [] }]);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.result.revision, 1);
    const stale = await call('savePolicy', [{ revision: 0, config, blocks: [] }]);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'REVISION_CONFLICT');
    config.display = { timezone: 'Not/AZone' };
    const bad = await call('savePolicy', [{ revision: 1, config, blocks: [] }]);
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /\$\.display\.timezone/);
    assert.deepEqual((await call('policyHistory', [])).json.result.revisions.map((item: { revision: number; source: string }) => [item.revision, item.source]), [[1, 'save']]);
    const rolled = await call('policyRollback', [{ revision: 1 }]);
    assert.equal(rolled.json.result.revision, 2);
    assert.deepEqual((await call('policyHistory', [])).json.result.revisions.map((item: { revision: number; source: string }) => [item.revision, item.source]), [[2, 'rollback:1'], [1, 'save']]);
    assert.equal((await call('policyRollback', [{ revision: 77 }])).status, 400);
    const files = await readdir(dataDir);
    assert.deepEqual(files.filter(name => /\.v1\.json|\.bak|pre-weight/.test(name) && name !== 'control.v1.json'), [], 'no backup or JSON policy files');
  } finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
});
