import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startLocalIPC, LocalIPCError, type Discovery } from '../../src/main/local-ipc';
import { startRuntime } from '../../src/main/runtime';
import { SERVER_HELP, parseServer } from '../../src/cli/server/commands';
import { serverEnv, UNIT_MARKER, type Envelope, type RunResult, type ServerArgs, type ServerEnv, type ServerInfo } from '../../src/cli/server/env';
import { LAUNCHD_LABEL, launchdPlist, plistProgramArguments } from '../../src/cli/server/launchd';
import { selfCommand, serverInstall, serverStart, serverStatus, serverStop, serverUninstall, webArgs } from '../../src/cli/server/lifecycle';
import { SERVICE_NAME, systemdQuote, systemdTokens, systemdUnit } from '../../src/cli/server/systemd';

const exec = promisify(execFile);

const entry = resolve('src/cli/main.ts');
const scratch = mkdtempSync(join(tmpdir(), 'wv-server-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const okData = (data: unknown): Envelope => ({ apiVersion: 'weaver.v1', commandId: null, ok: true, data });
/** How a pre-serverInfo weaver answers: a running server that cannot describe itself. */
const legacyEnvelope: Envelope = { apiVersion: 'weaver.v1', commandId: null, ok: false, error: { code: 'INVALID_REQUEST', message: 'Unknown method' } };
const otherErrorEnvelope: Envelope = { apiVersion: 'weaver.v1', commandId: null, ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid argument arity' } };
/** A stopped server reaches the CLI as a thrown APP_NOT_RUNNING, the way sendRequest does. */
const stopped = 'down' as const;
type Probe = Envelope | typeof stopped;
const infoOf = (over: Partial<ServerInfo> = {}): ServerInfo => ({
  pid: 4242, url: 'http://127.0.0.1:4737', port: 4737, dataDir: '/data', version: '0.1.0',
  startedAt: '2026-01-01T00:00:00.000Z', runningWorkers: 0, managedBy: null, ...over,
});
const argsOf = (over: Partial<ServerArgs> = {}): ServerArgs => ({ action: 'status', port: 4737, dataDir: '/data', output: 'json', force: false, cancelWorkers: false, timeoutMs: 5_000, ...over });
const data = (envelope: Envelope) => envelope.data as Record<string, unknown>;

/** A serverEnv that never touches systemctl, launchd, a real home, or a real clock. */
function fake(options: {
  platform?: string; home?: string; standalone?: boolean; path?: string; probes?: Probe[]; configHome?: string;
  run?: (file: string, args: readonly string[]) => RunResult; spawn?: () => Promise<{ code: number | null }>; extra?: Partial<ServerEnv>;
} = {}): { env: ServerEnv; runs: string[][]; killed: number[]; home: string } {
  const home = options.home ?? join(scratch, 'home-' + randomBytes(4).toString('hex'));
  const runs: string[][] = [];
  const killed: number[] = [];
  const probes = [...(options.probes ?? [])];
  let clock = 0;
  const env = serverEnv(
    { request: async () => { const next: Probe = probes.length > 1 ? probes.shift()! : (probes[0] ?? stopped); if (next === stopped) throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; run weaver server start'); return next; }, output: () => {}, defaultPort: 4737, defaultDataDir: join(home, 'default') },
    {
      platform: options.platform ?? 'linux',
      home,
      env: { PATH: options.path ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, ...(options.configHome ? { XDG_CONFIG_HOME: options.configHome } : {}) },
      uid: 1000,
      pid: 7,
      standalone: options.standalone ?? true,
      execPath: '/opt/weaver/weaver',
      execArgv: [],
      entryPath: '/checkout/src/cli/main.ts',
      cwd: '/checkout',
      run: async (file, callArgs) => {
        const call = [file, ...callArgs];
        runs.push(call);
        return options.run ? options.run(call[0]!, callArgs) : { code: 0, stdout: '', stderr: 'systemctl said no' };
      },
      spawnServer: () => (options.spawn ? options.spawn() : Promise.resolve({ code: 0 })),
      kill: pid => { killed.push(pid); },
      sleep: async () => {},
      now: () => (clock += 1_000),
      ...options.extra,
    },
  );
  return { env, runs, killed, home };
}

const unitPath = (env: ServerEnv) => join(env.env.XDG_CONFIG_HOME || join(env.home, '.config'), 'systemd', 'user', SERVICE_NAME);
const plistPath = (env: ServerEnv) => join(env.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const ran = (runs: string[][], ...prefix: string[]) => runs.some(call => call.slice(0, prefix.length).join(' ') === prefix.join(' '));

// ---------------------------------------------------------------- real CLI lifecycle

test('weaver server start, status and stop drive a real control plane on a free port', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'live-'));
  // Strip service-manager wiring (env var and unit path) so the spawned CLI sees an unmanaged server regardless of host.
  const isolatedEnv = (): NodeJS.ProcessEnv => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'WEAVER_SERVICE' && key !== 'XDG_CONFIG_HOME'));
    return { ...clean, XDG_CONFIG_HOME: join(dataDir, 'config') };
  };
  const cli = (words: string[]) => spawnSync(process.execPath, ['--import', 'tsx', entry, 'server', ...words, '--data-dir', dataDir, '--output', 'json'], { encoding: 'utf8', cwd: resolve('.'), env: isolatedEnv() });
  let started = false;
  try {
    const start = cli(['start', '--port', '0', '--timeout', '60']);
    assert.equal(start.status, 0, start.stderr);
    const body = JSON.parse(start.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.data.status, 'running');
    assert.equal(body.data.dataDir, dataDir);
    assert.ok(Number.isInteger(body.data.pid) && body.data.pid > 0);
    assert.ok(body.data.port > 0 && body.data.url.includes(String(body.data.port)), 'the actual port is reported');
    assert.equal(body.data.runningWorkers, 0);
    assert.equal(body.data.managedBy, null);
    started = true;

    const again = cli(['start', '--port', '0']);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).data.alreadyRunning, true, 'start is idempotent');

    const status = cli(['status']);
    assert.equal(status.status, 0, status.stderr);
    const shown = JSON.parse(status.stdout).data;
    assert.equal(shown.status, 'running');
    assert.equal(shown.pid, body.data.pid);
    assert.equal(shown.service.installed, false);
    assert.ok(existsSync(join(dataDir, 'server.log')), 'the detached server logs under the data directory');

    const stop = cli(['stop', '--timeout', '60']);
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).data.status, 'stopped');
    started = false;
    // Stop observes the closed socket before asynchronous discovery cleanup finishes.
    const cleanupDeadline = Date.now() + 2_000;
    while (existsSync(join(dataDir, 'control.v1.json')) && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(join(dataDir, 'control.v1.json')), false, 'the endpoint is cleaned up');

    const twice = cli(['stop']);
    assert.equal(twice.status, 0, twice.stderr);
    assert.equal(JSON.parse(twice.stdout).data.alreadyStopped, true);

    const idle = cli(['status']);
    assert.equal(idle.status, 0, 'status of a stopped server exits 0');
    assert.equal(JSON.parse(idle.stdout).data.status, 'stopped');
  } finally {
    if (started) cli(['stop', '--force', '--timeout', '60']);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('weaver server --help prints the group help and the CLI help points at it', () => {
  const help = spawnSync(process.execPath, ['--import', 'tsx', entry, 'server', '--help'], { encoding: 'utf8', cwd: resolve('.') });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout.trim(), SERVER_HELP.trim());
  const root = spawnSync(process.execPath, ['--import', 'tsx', entry, '--help'], { encoding: 'utf8', cwd: resolve('.') });
  assert.equal(root.status, 0, root.stderr);
  assert.match(root.stdout, /weaver server <status\|start\|stop\|install\|uninstall>/);
  assert.match(root.stdout, /APP_NOT_RUNNING, start: weaver server start/);
  const missing = spawnSync(process.execPath, ['--import', 'tsx', entry, 'sync', 'snapshot', '--data-dir', join(scratch, 'absent')], { encoding: 'utf8', cwd: resolve('.') });
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).error.message, /weaver server start/);
});

test('weaver web reuses a running service instead of starting a second instance', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'live-'));
  // Async spawns only: the runtime answers the CLI probe from this test's own event loop.
  const cli = (words: string[]) => exec(process.execPath, ['--import', 'tsx', entry, ...words], { encoding: 'utf8', cwd: resolve('.'), maxBuffer: 1 << 24 });
  let runtime;
  try {
    runtime = await startRuntime({ dataDir, port: 0, open: false });
    const info = { url: runtime.url, port: runtime.port };
    const endpoint = (): string => readFileSync(join(dataDir, 'control.v1.json'), 'utf8');
    const published = endpoint();

    const web = await cli(['web', '--data-dir', dataDir, '--output', 'json', '--no-open']);
    const ready = JSON.parse(web.stdout);
    assert.equal(ready.ok, true);
    assert.equal(ready.data.url, info.url, 'the running service URL is returned');
    assert.equal(ready.data.port, info.port);
    assert.equal(ready.data.alreadyRunning, true);
    assert.equal(ready.data.note, undefined, 'no note without an explicit port');

    const text = await cli(['web', '--data-dir', dataDir, '--output', 'text', '--no-open']);
    assert.equal(text.stdout.trim(), info.url);

    const shifted = await cli(['web', '--port', '4799', '--data-dir', dataDir, '--output', 'json', '--no-open']);
    const note = JSON.parse(shifted.stdout).data;
    assert.equal(note.url, info.url, 'the running URL wins over the requested port');
    assert.equal(note.alreadyRunning, true);
    assert.match(note.note, /already running/);
    assert.ok(String(note.note).includes(String(info.port)), String(note.note));

    assert.equal(endpoint(), published, 'a reused web call never republishes the endpoint');
    assert.equal(readdirSync(dataDir).filter(name => name.startsWith('control-')).length, 1, 'no second instance laid down an endpoint');
    const stillRunning = await cli(['capabilities', '--data-dir', dataDir, '--output', 'json']);
    assert.equal(JSON.parse(stillRunning.stdout).ok, true, 'the instance that was already running still answers');
  } finally {
    await runtime?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- parsing

test('parseServer fills defaults and validates every flag', () => {
  const { env } = fake();
  assert.deepEqual(parseServer(['server', 'status'], ['server', 'status'], env), argsOf({ action: 'status', dataDir: resolve(join(env.home, 'default')), timeoutMs: 20_000 }));
  const parsed = parseServer(['server', 'stop', '--port', '0', '--data-dir', 'relative', '--timeout', '3', '--force', '--cancel-workers', '--output', 'text'], ['server', 'stop'], env);
  assert.equal(parsed.port, 0);
  assert.equal(parsed.dataDir, resolve('relative'));
  assert.equal(parsed.timeoutMs, 3_000, '--timeout is seconds');
  assert.equal(parsed.force, true);
  assert.equal(parsed.cancelWorkers, true);
  assert.equal(parsed.output, 'text');
  assert.equal(parseServer(['server', 'stop'], ['server', 'stop'], env).cancelWorkers, false);
  for (const argv of [['server'], ['server', 'restart'], ['server', 'status', '--output', 'yaml'], ['server', 'status', 'extra'], ['server', 'status', '--port', 'x'], ['server', 'status', '--port', '70000'], ['server', 'status', '--timeout', '0'], ['server', 'status', '--nope'], ['server', 'status', '--port'], ['server', 'status', '--force', '--force'], ['server', 'status', '--cancel-workers', '--cancel-workers']]) {
    assert.throws(() => parseServer(argv, argv.filter(word => !word.startsWith('--')), env), (error: { code: string }) => error.code === 'INVALID_ARGUMENT', argv.join(' '));
  }
});

// ---------------------------------------------------------------- unit and plist rendering

test('the systemd unit quotes, carries PATH, and is readable back', () => {
  const { env } = fake({ path: '/opt/bin:/usr/bin:/bin' });
  const command = ['/opt/weaver/weaver', 'web', '--no-open', '--port', '0', '--data-dir', '/srv/we data/100%'];
  const unit = systemdUnit(command, env);
  assert.equal(unit.split('\n')[0], `# ${UNIT_MARKER}`);
  assert.match(unit, /^\[Unit\]\nDescription=Weaver local control plane$/m);
  assert.match(unit, /^Type=simple$/m);
  assert.match(unit, /^Environment=WEAVER_SERVICE=systemd$/m);
  assert.match(unit, /^Environment=PATH=\/opt\/bin:\/usr\/bin:\/bin$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartSec=5$/m);
  assert.match(unit, /^\[Install\]\nWantedBy=default\.target$/m);
  const execStart = unit.split('\n').find(line => line.startsWith('ExecStart='))!;
  assert.deepEqual(systemdTokens(execStart.slice('ExecStart='.length)), command, 'ExecStart round-trips through quoting');
  assert.equal(systemdQuote('/plain/path'), '/plain/path');
  assert.equal(systemdQuote('a "quoted" \\ value'), '"a \\"quoted\\" \\\\ value"');
});

test('the launchd plist escapes XML, marks itself, and is readable back', () => {
  const { env } = fake();
  const command = ['/opt/weaver/weaver', 'web', '--no-open', '--port', '4737', '--data-dir', '/srv/a&b/c'];
  const plist = launchdPlist(command, env, '/data/server.log');
  assert.ok(plist.includes(`<!-- ${UNIT_MARKER} -->`));
  assert.match(plist, /<key>Label<\/key>\n  <string>dev\.weaver\.server<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n  <dict>\n    <key>SuccessfulExit<\/key>\n    <false\/>/);
  assert.ok(plist.includes('<string>/srv/a&amp;b/c</string>'), 'values are XML-escaped');
  assert.ok(plist.includes('<key>StandardOutPath</key>'), 'stdout goes to the log');
  assert.ok(plist.includes('<key>StandardErrorPath</key>'), 'stderr goes to the log');
  assert.ok(plist.includes('<string>/usr/local/bin:/usr/bin:/bin</string>'), 'PATH is carried');
  assert.ok(plist.includes('<string>launchd</string>'), 'WEAVER_SERVICE is set');
  assert.deepEqual(plistProgramArguments(plist), command, 'ProgramArguments round-trips');
});

// ---------------------------------------------------------------- start

test('start reuses an installed service for the same port and data directory', async () => {
  const { env, runs } = fake({ probes: [stopped, okData(infoOf())] });
  const args = argsOf({ action: 'start' });
  mkdirSync(join(unitPath(env), '..'), { recursive: true });
  writeFileSync(unitPath(env), systemdUnit(selfCommand(webArgs(args.port, args.dataDir), env), env), { mode: 0o600 });
  const result = await serverStart(env, args);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(data(result).status, 'running');
  assert.ok(ran(runs, 'systemctl', '--user', 'start', SERVICE_NAME), JSON.stringify(runs));
  assert.equal(runs.length, 1, 'the service starts the server instead of a spawn');
});

test('start spawns a detached server when no service matches and reports the real port', async () => {
  let spawned = 0;
  const { env } = fake({ probes: [stopped, okData(infoOf({ port: 39_000, url: 'http://127.0.0.1:39000' }))], spawn: () => { spawned++; return new Promise(() => {}); } });
  const result = await serverStart(env, argsOf({ action: 'start', port: 0 }));
  assert.equal(spawned, 1);
  assert.equal(data(result).status, 'running');
  assert.equal(data(result).port, 39_000, '--port 0 reports the actual port');
});

test('start reports already running without touching anything', async () => {
  const { env, runs } = fake({ probes: [okData(infoOf({ managedBy: 'systemd' }))] });
  assert.equal(data(await serverStart(env, argsOf({ action: 'start' }))).alreadyRunning, true);
  assert.equal(runs.length, 0);
});

test('a child that dies before ready gives SERVER_START_FAILED with its log tail', async () => {
  const dataDir = join(scratch, 'dead-');
  const { env } = fake({ probes: [stopped], spawn: async () => ({ code: 3 }) });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'server.log'), 'first\n\x07 EADDRINUSE: port taken\n'.repeat(40));
  const result = await serverStart(env, argsOf({ action: 'start', dataDir }));
  assert.equal(result.error?.code, 'SERVER_START_FAILED');
  assert.match(result.error?.message ?? '', /code 3/);
  assert.match(result.error?.message ?? '', /EADDRINUSE/);
  assert.ok((result.error?.message ?? '').length < 2_400, 'the tail stays bounded');
  assert.equal(result.error?.message?.includes('\x07'), false, 'control characters are stripped');
});

test('a child that never becomes ready gives SERVER_START_TIMEOUT', async () => {
  const { env } = fake({ probes: [], spawn: () => new Promise(() => {}) });
  const result = await serverStart(env, argsOf({ action: 'start', timeoutMs: 2_500 }));
  assert.equal(result.error?.code, 'SERVER_START_TIMEOUT');
});

// ---------------------------------------------------------------- stop

test('stop no longer refuses while workers run; they keep running and reattach', async () => {
  const busy = fake({ probes: [okData(infoOf({ runningWorkers: 2 })), stopped] });
  const result = await serverStop(busy.env, argsOf({ action: 'stop' }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(busy.killed, [4242], 'the server is still signalled');
  assert.deepEqual(data(result), { status: 'stopped', pid: 4242, workers: 2, note: '2 workers keep running and reattach automatically after restart.' });

  const single = fake({ probes: [okData(infoOf({ runningWorkers: 1 })), stopped] });
  assert.deepEqual(data(await serverStop(single.env, argsOf({ action: 'stop' }))), { status: 'stopped', pid: 4242, workers: 1, note: '1 worker keeps running and reattach automatically after restart.' });
});

test('stop --cancel-workers cancels real workers with stable command IDs before signalling', async () => {
  type Listed = { id: string; status: string; run?: { execution: string }; dispatch?: { execution: string } };
  const real: Listed = { id: '11111111-1111-4111-8111-111111111111', status: 'running', run: { execution: 'real' } };
  const cancelling: Listed = { id: '22222222-2222-4222-8222-222222222222', status: 'cancelling', dispatch: { execution: 'mock' } };
  const native: Listed = { id: '33333333-3333-4333-8333-333333333333', status: 'running', dispatch: { execution: 'native' } };
  const remaining = new Map([[real.id, real], [cancelling.id, cancelling]]);
  const commandIds: string[] = [];
  let signalled = false;
  const { env, killed } = fake({
    probes: [stopped],
    extra: {
      kill: () => { signalled = true; killed.push(4242); },
      request: async (_dataDir: string, payload: unknown) => {
        const method = (payload as { method?: string }).method;
        if (method === 'serverInfo') {
          if (signalled) throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; run weaver server start');
          return okData(infoOf({ runningWorkers: remaining.size }));
        }
        if (method === 'listTasks') return okData([...remaining.values(), native]);
        if (method === 'command') {
          const body = (payload as { args?: unknown[] }).args?.[0] as { commandId?: string; command?: string; args?: { taskId?: string } };
          assert.equal(body.command, 'tasks.cancel');
          commandIds.push(String(body.commandId));
          remaining.delete(String(body.args?.taskId));
          return okData({ cancelled: true });
        }
        throw new Error(`unexpected method ${String(method)}`);
      },
    },
  });
  const result = await serverStop(env, argsOf({ action: 'stop', cancelWorkers: true }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(commandIds, [`server-stop-cancel-${real.id}`, `server-stop-cancel-${cancelling.id}`], 'native runs are never cancelled');
  assert.deepEqual(killed, [4242], 'SIGTERM follows the drain');
  assert.deepEqual(data(result), { status: 'stopped', pid: 4242, cancelledWorkers: 2 });
});

test('stop --cancel-workers times out without signalling when workers do not drain', async () => {
  const stuck = fake({
    extra: {
      request: async (_dataDir: string, payload: unknown) => {
        const method = (payload as { method?: string }).method;
        if (method === 'listTasks') return okData([{ id: '11111111-1111-4111-8111-111111111111', status: 'running', run: { execution: 'real' } }]);
        if (method === 'command') return okData({ cancelled: true });
        return okData(infoOf({ runningWorkers: 1 }));
      },
    },
  });
  const result = await serverStop(stuck.env, argsOf({ action: 'stop', cancelWorkers: true, timeoutMs: 2_500 }));
  assert.equal(result.error?.code, 'SERVER_CANCEL_TIMEOUT');
  assert.match(result.error?.message ?? '', /SIGTERM was not sent/);
  assert.deepEqual(stuck.killed, [], 'nothing is signalled on drain timeout');
});

test('stop signals the reported pid and waits for it to go away', async () => {
  const { env, killed } = fake({ probes: [okData(infoOf({ pid: 9_001 })), stopped] });
  const result = await serverStop(env, argsOf({ action: 'stop' }));
  assert.deepEqual(killed, [9_001]);
  assert.equal(data(result).status, 'stopped');

  const stuck = fake({ probes: [okData(infoOf({ pid: 9_002 })), okData(infoOf({ pid: 9_002 }))] });
  assert.equal((await serverStop(stuck.env, argsOf({ action: 'stop', timeoutMs: 2_500 }))).error?.code, 'SERVER_STOP_TIMEOUT');

  for (const pid of [7, 0, -3]) {
    const bad = fake({ probes: [okData(infoOf({ pid }))] });
    assert.equal((await serverStop(bad.env, argsOf({ action: 'stop' }))).error?.code, 'SERVER_STOP_FAILED', `pid ${pid}`);
  }
  assert.equal(fake({ probes: [] }).killed.length, 0);
  assert.equal(data(await serverStop(fake({ probes: [stopped] }).env, argsOf({ action: 'stop' }))).alreadyStopped, true);
});

test('stop maps a failed signal to SERVER_STOP_FAILED', async () => {
  const { env } = fake({ probes: [okData(infoOf({ pid: 9_100 }))], extra: { kill: () => { throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }); } } });
  const result = await serverStop(env, argsOf({ action: 'stop' }));
  assert.equal(result.error?.code, 'SERVER_STOP_FAILED');
  assert.match(result.error?.message ?? '', /Operation not permitted/);
});

// ---------------------------------------------------------------- error probes

test('status reports any envelope error from the probe as an error, an old server included', async () => {
  const old = await serverStatus(fake({ probes: [legacyEnvelope] }).env, argsOf({ action: 'status' }));
  assert.equal(old.ok, false);
  assert.equal(old.error?.code, 'INVALID_REQUEST');
  assert.equal(old.error?.message, 'Unknown method');

  const failed = await serverStatus(fake({ probes: [otherErrorEnvelope] }).env, argsOf({ action: 'status' }));
  assert.equal(failed.ok, false);
  assert.equal(failed.error?.code, 'INVALID_REQUEST');
  assert.equal(failed.error?.message, 'Invalid argument arity', 'other envelope errors stay errors');
});

test('start fails with a probe error and never spawns a doomed second process', async () => {
  let spawned = 0;
  const { env } = fake({ probes: [otherErrorEnvelope], spawn: () => { spawned++; return new Promise(() => {}); } });
  const result = await serverStart(env, argsOf({ action: 'start' }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INVALID_REQUEST');
  assert.equal(result.error?.message, 'Invalid argument arity');
  assert.equal(spawned, 0);
});

test('install treats a probe error as an unknown running state without starting', async () => {
  const { env, runs } = fake({ probes: [otherErrorEnvelope] });
  const result = await serverInstall(env, argsOf({ action: 'install' }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(data(result).running, 'unknown');
  assert.deepEqual(data(result).error, { code: 'INVALID_REQUEST', message: 'Invalid argument arity' });
  assert.deepEqual(runs, [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', SERVICE_NAME]], 'enable happens, start does not');
  assert.equal(existsSync(unitPath(env)), true);
});

// ---------------------------------------------------------------- install

test('install writes the unit and starts it through systemd', async () => {
  const home = join(scratch, 'linux-home');
  const { env, runs } = fake({ home, probes: [stopped, okData(infoOf({ managedBy: 'systemd' }))] });
  const result = await serverInstall(env, argsOf({ action: 'install' }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(data(result).running, 'started');
  assert.deepEqual(runs, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', SERVICE_NAME],
    ['systemctl', '--user', 'start', SERVICE_NAME],
  ]);
  const unit = readFileSync(unitPath(env), 'utf8');
  assert.equal(unit.split('\n')[0], `# ${UNIT_MARKER}`);
  assert.match(unit, /ExecStart=\/opt\/weaver\/weaver web --no-open --port 4737 --data-dir \/data/);
  assert.deepEqual(readdirSync(join(unitPath(env), '..')).filter(name => name.includes('.tmp')), [], 'no half-written unit');
});

test('install honours XDG_CONFIG_HOME and the chosen port and data directory', async () => {
  const configHome = join(scratch, 'xdg-home');
  const { env } = fake({ configHome, probes: [stopped, okData(infoOf({ managedBy: 'systemd' }))] });
  const result = await serverInstall(env, argsOf({ action: 'install', port: 0, dataDir: '/srv/we data' }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(existsSync(join(configHome, 'systemd', 'user', SERVICE_NAME)), true);
  assert.match(readFileSync(join(configHome, 'systemd', 'user', SERVICE_NAME), 'utf8'), /--port 0 --data-dir "\/srv\/we data"/);
});

test('install respects the manager that is already running this server', async () => {
  const managed = fake({ probes: [okData(infoOf({ managedBy: 'systemd' }))] });
  assert.equal(data(await serverInstall(managed.env, argsOf({ action: 'install' }))).running, 'managed');
  assert.equal(ran(managed.runs, 'systemctl', '--user', 'start', SERVICE_NAME), false, 'a running managed server is left alone');

  const unmanaged = fake({ probes: [okData(infoOf({ managedBy: null }))] });
  const result = await serverInstall(unmanaged.env, argsOf({ action: 'install' }));
  assert.equal(data(result).running, 'unmanaged');
  assert.equal(data(result).hint, 'weaver server stop && weaver server start');
  assert.equal(ran(unmanaged.runs, 'systemctl', '--user', 'start', SERVICE_NAME), false);
});

test('install keeps a foreign unit unless --force and rewrites its own', async () => {
  const foreign = fake();
  mkdirSync(join(unitPath(foreign.env), '..'), { recursive: true });
  writeFileSync(unitPath(foreign.env), '[Service]\nExecStart=/someone/else\n', { mode: 0o600 });
  const refused = await serverInstall(foreign.env, argsOf({ action: 'install' }));
  assert.equal(refused.error?.code, 'SERVER_UNIT_EXISTS');
  assert.match(refused.error?.message ?? '', /--force/);
  assert.equal(readFileSync(unitPath(foreign.env), 'utf8'), '[Service]\nExecStart=/someone/else\n');
  assert.equal(foreign.runs.length, 0);

  const replaced = fake();
  await serverInstall(replaced.env, argsOf({ action: 'install', force: true }));
  assert.match(readFileSync(unitPath(replaced.env), 'utf8'), new RegExp(UNIT_MARKER));

  const own = fake({ probes: [okData(infoOf({ managedBy: 'systemd' }))] });
  mkdirSync(join(unitPath(own.env), '..'), { recursive: true });
  writeFileSync(unitPath(own.env), systemdUnit(['weaver', 'web', '--port', '9', '--data-dir', '/other'], own.env), { mode: 0o600 });
  await serverInstall(own.env, argsOf({ action: 'install' }));
  assert.match(readFileSync(unitPath(own.env), 'utf8'), /--port 4737 --data-dir \/data/, 'a marked unit is rewritten');
});

test('install reports a service manager failure without a temp file left behind', async () => {
  const { env } = fake({ run: (_file, args) => args.includes('enable') ? { code: 1, stdout: '', stderr: 'unit file is bad' } : { code: 0, stdout: '', stderr: '' } });
  const result = await serverInstall(env, argsOf({ action: 'install' }));
  assert.equal(result.error?.code, 'SERVER_INSTALL_FAILED');
  assert.match(result.error?.message ?? '', /systemctl --user enable weaver.service failed/);
  assert.match(result.error?.message ?? '', /unit file is bad/, 'stderr is quoted');
  assert.deepEqual(readdirSync(join(unitPath(env), '..')).filter(name => name.includes('.tmp')), []);
});

test('install bootstraps a launchd plist on macOS', async () => {
  const home = join(scratch, 'mac-home');
  const { env, runs } = fake({ platform: 'darwin', home, probes: [stopped, okData(infoOf({ managedBy: 'launchd' }))] });
  const result = await serverInstall(env, argsOf({ action: 'install' }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(data(result).manager, 'launchd');
  assert.equal(ran(runs, 'systemctl'), false);
  assert.ok(ran(runs, 'launchctl', 'bootstrap', 'gui/1000', plistPath(env)), JSON.stringify(runs));
  const plist = readFileSync(plistPath(env), 'utf8');
  assert.ok(plist.includes(`<!-- ${UNIT_MARKER} -->`));
  assert.ok(plist.includes('<string>/usr/local/bin:/usr/bin:/bin</string>'));
});

test('install is limited to the standalone executable and supported platforms', async () => {
  const checkout = fake({ standalone: false });
  const refused = await serverInstall(checkout.env, argsOf({ action: 'install' }));
  assert.equal(refused.error?.code, 'SERVER_INSTALL_UNSUPPORTED');
  assert.match(refused.error?.message ?? '', /weaver server start from a checkout/);
  assert.equal(existsSync(join(checkout.home, '.config')), false);

  const windows = fake({ platform: 'win32' });
  assert.equal((await serverInstall(windows.env, argsOf({ action: 'install' }))).error?.code, 'SERVER_INSTALL_UNSUPPORTED');
});

// ---------------------------------------------------------------- uninstall

test('uninstall disables and removes the unit weaver installed, leaving a running server alone', async () => {
  const none = fake();
  assert.deepEqual(data(await serverUninstall(none.env, argsOf({ action: 'uninstall' }))), { installed: false, manager: 'systemd', path: unitPath(none.env) });
  assert.equal(none.runs.length, 0);

  const { env, runs } = fake({ probes: [okData(infoOf({ managedBy: 'systemd' }))] });
  await serverInstall(env, argsOf({ action: 'install' }));
  runs.length = 0;
  const result = await serverUninstall(env, argsOf({ action: 'uninstall' }));
  assert.deepEqual(runs, [['systemctl', '--user', 'disable', SERVICE_NAME], ['systemctl', '--user', 'daemon-reload']]);
  assert.equal(existsSync(unitPath(env)), false, 'the unit is gone');
  assert.equal(data(result).installed, false);
  assert.equal(data(result).running, true, 'the running server is reported, not stopped');

  const foreign = fake();
  mkdirSync(join(unitPath(foreign.env), '..'), { recursive: true });
  writeFileSync(unitPath(foreign.env), 'not ours\n');
  assert.equal(data(await serverUninstall(foreign.env, argsOf({ action: 'uninstall' }))).installed, false);
  assert.equal(readFileSync(unitPath(foreign.env), 'utf8'), 'not ours\n', 'a foreign file is never removed');
  assert.equal(foreign.runs.length, 0);
});

test('uninstall on macOS leaves running workers alone but still removes the service', async () => {
  const running3 = okData(infoOf({ runningWorkers: 3, managedBy: 'launchd' }));
  const { env } = fake({ platform: 'darwin', probes: [running3, running3, stopped] });
  await serverInstall(env, argsOf({ action: 'install' }));
  const busy = await serverUninstall(env, argsOf({ action: 'uninstall' }));
  assert.equal(busy.ok, true, JSON.stringify(busy.error));
  assert.deepEqual(data(busy), { installed: false, manager: 'launchd', path: plistPath(env), running: false, workers: 3, note: '3 workers keep running and reattach automatically after restart.' });
  assert.equal(existsSync(plistPath(env)), false, 'the plist is still removed');
});

test('uninstall on macOS --cancel-workers drains before bootout', async () => {
  const remaining = new Map([['11111111-1111-4111-8111-111111111111', { id: '11111111-1111-4111-8111-111111111111', status: 'running', run: { execution: 'real' } }]]);
  const commandIds: string[] = [];
  let gone = false;
  const { env, runs } = fake({
    platform: 'darwin',
    run: (file, args) => { if (args.includes('bootout')) gone = true; return { code: 0, stdout: '', stderr: '' }; },
    extra: {
      request: async (_dataDir: string, payload: unknown) => {
        const method = (payload as { method?: string }).method;
        if (method === 'serverInfo') {
          if (gone) throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; run weaver server start');
          return okData(infoOf({ runningWorkers: remaining.size, managedBy: 'launchd' as const }));
        }
        if (method === 'listTasks') return okData([...remaining.values()]);
        const body = (payload as { args?: unknown[] }).args?.[0] as { commandId?: string; args?: { taskId?: string } };
        commandIds.push(String(body.commandId));
        remaining.delete(String(body.args?.taskId));
        return okData({ cancelled: true });
      },
    },
  });
  await serverInstall(env, argsOf({ action: 'install' }));
  runs.length = 0;
  const result = await serverUninstall(env, argsOf({ action: 'uninstall', cancelWorkers: true }));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(commandIds, ['server-stop-cancel-11111111-1111-4111-8111-111111111111']);
  assert.ok(ran(runs, 'launchctl', 'bootout', `gui/1000/${LAUNCHD_LABEL}`), JSON.stringify(runs));
  assert.equal(existsSync(plistPath(env)), false);
  assert.equal(data(result).running, false);
});

test('uninstall on macOS boots the service out and removes the plist', async () => {
  const { env, runs } = fake({ platform: 'darwin', probes: [stopped] });
  await serverInstall(env, argsOf({ action: 'install' }));
  assert.ok(ran(runs, 'launchctl', 'bootstrap', 'gui/1000', plistPath(env)), JSON.stringify(runs));
  runs.length = 0;
  const result = await serverUninstall(env, argsOf({ action: 'uninstall' }));
  assert.ok(ran(runs, 'launchctl', 'bootout', `gui/1000/${LAUNCHD_LABEL}`), JSON.stringify(runs));
  assert.equal(existsSync(plistPath(env)), false);
  assert.equal(data(result).running, false);
});

// ---------------------------------------------------------------- stale endpoint

const shortBase = () => mkdtempSync(join('/tmp', 'wvx-'));

async function leaveEndpoint(base: string): Promise<{ staleId: string; directory: string }> {
  const instanceId = randomBytes(16).toString('hex');
  const directory = join(base, `control-${instanceId}`);
  mkdirSync(directory, { mode: 0o700 });
  const socketPath = join(directory, 'ipc.sock');
  const tokenPath = join(directory, 'token');
  writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  const server = createServer();
  await new Promise<void>(done => server.listen(socketPath, done));
  await new Promise<void>(done => server.close(() => done()));
  writeFileSync(join(base, 'control.v1.json'), JSON.stringify({ version: 1, instanceId, socketPath, tokenPath } satisfies Discovery), { mode: 0o600 });
  return { staleId: instanceId, directory };
}

test('startup clears a provably stale endpoint once and continues', async () => {
  const base = shortBase();
  try {
    const stale = await leaveEndpoint(base);
    const ipc = await startLocalIPC(base, () => okData('handled'));
    try {
      assert.equal(existsSync(stale.directory), false, 'the dead instance directory is removed');
      const published = JSON.parse(readFileSync(join(base, 'control.v1.json'), 'utf8')) as Discovery;
      assert.notEqual(published.instanceId, stale.staleId, 'a fresh endpoint is published');
      assert.equal(published.socketPath, join(base, `control-${published.instanceId}`, 'ipc.sock'));
    } finally { await ipc.close(); }
    assert.equal(existsSync(join(base, 'control.v1.json')), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a live endpoint is never cleared: startup stops with ENDPOINT_EXISTS', async () => {
  const base = shortBase();
  let first;
  try {
    first = await startLocalIPC(base, () => okData('handled'));
    const published = JSON.parse(readFileSync(join(base, 'control.v1.json'), 'utf8')) as Discovery;
    const second = await startLocalIPC(base, () => okData('other')).then(
      () => { throw new Error('expected ENDPOINT_EXISTS'); },
      (error: { code: string }) => error,
    );
    assert.equal(second.code, 'ENDPOINT_EXISTS');
    assert.deepEqual(JSON.parse(readFileSync(join(base, 'control.v1.json'), 'utf8')), published, 'the live endpoint is untouched');
    assert.equal(existsSync(join(base, `control-${published.instanceId}`, 'ipc.sock')), true);
  } finally {
    await first?.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unreadable or foreign endpoint file is not treated as stale', async () => {
  const broken = shortBase();
  try {
    writeFileSync(join(broken, 'control.v1.json'), '{not json\n', { mode: 0o600 });
    await assert.rejects(startLocalIPC(broken, () => null), (error: { code: string }) => error.code === 'ENDPOINT_EXISTS');
    assert.equal(readFileSync(join(broken, 'control.v1.json'), 'utf8'), '{not json\n', 'an invalid file is left for the operator');
  } finally { rmSync(broken, { recursive: true, force: true }); }

  const elsewhere = shortBase();
  const foreign = shortBase();
  try {
    const instanceId = randomBytes(16).toString('hex');
    const socketPath = join(foreign, `control-${instanceId}`, 'ipc.sock');
    writeFileSync(join(elsewhere, 'control.v1.json'), JSON.stringify({ version: 1, instanceId, socketPath, tokenPath: `${socketPath}.token` } satisfies Discovery), { mode: 0o600 });
    await assert.rejects(startLocalIPC(elsewhere, () => null), (error: { code: string }) => error.code === 'ENDPOINT_EXISTS');
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});
