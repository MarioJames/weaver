import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { commandSummary, observeProcessTree, processTreeCpuNs, cgroupUnit, readProcessSnapshots, type ProcessSnapshot } from '../../src/main/monitors/process-tree';
import { startOwnedScope } from '../../src/main/adapters/cli/scope';

const START = Date.parse('2030-01-01T00:00:00Z');
const proc = (pid: number, ppid: number, argv: string[], overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot => ({
  pid, ppid, argv, state: 'S', utime: 0, stime: 0, startTicks: 100 + pid, startedAtMs: START, ...overrides,
});

const tempDirs = new Set<string>();
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wv-process-tree-'));
  tempDirs.add(dir);
  return dir;
}
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await pause();
  }
}
function systemctl(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => execFile('systemctl', ['--user', ...args], { timeout: 8000 }, (error, stdout) => {
    resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, stdout: stdout ?? '' });
  }));
}
async function systemdReady(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const state = await new Promise<string>(resolve => execFile('systemctl', ['--user', 'is-system-running'], (error, stdout) => resolve(String(stdout || error?.message || '').trim())));
    return ['running', 'degraded'].includes(state);
  } catch { return false; }
}
const skip = async () => await systemdReady() ? false : 'systemd user session is unavailable';

test('the process tree sums descendants across cgroups and ignores vendor services for command health', () => {
  const table: ProcessSnapshot[] = [
    proc(100, 1, ['systemd-run', '--user', '--scope', '--unit=worker', '--', 'node', 'vendor.js'], { utime: 10 }),
    proc(101, 100, ['node', '/opt/vendor.js'], { utime: 20 }),
    proc(102, 101, ['node', '/opt/mcp-server.js'], { utime: 100 }),                       // resident MCP server
    proc(103, 101, ['node', '/opt/typescript-language-server.js'], { utime: 100 }),        // resident LSP
    proc(104, 101, ['bash', '-c', 'pnpm test'], { utime: 30 }),
    proc(105, 104, ['node', '/repo/node_modules/.bin/pnpm', 'test'], { utime: 40 }),
    proc(106, 105, ['node', 'worker.js'], { utime: 50 }),
    proc(107, 101, ['/usr/bin/docker', 'build', '--token=super-secret', '.'], { utime: 60, startTicks: 1 }), // moved to its own scope
  ];
  const observation = observeProcessTree(100, table, START + 60_000, 100, 0);
  assert.equal(observation.cpuNs, (10 + 20 + 100 + 100 + 30 + 40 + 50 + 60) * 10_000_000, 'every descendant counts once, whatever its cgroup');
  assert.equal(observation.command?.pid, 107, 'the oldest command is reported');
  assert.match(observation.command!.summary, /^\/usr\/bin\/docker build --token=\[REDACTED\] \.$/);
  assert.doesNotMatch(observation.command!.summary, /super-secret/);
  assert.equal(observation.command!.elapsedMs, 60_000);
});

test('the command summary carries argv only and masks credential-shaped arguments and env assignments', () => {
  const summary = commandSummary(['bash', '-lc', 'DEEPSEEK_API_KEY=sk-live-12345678 tool --password hunter2 --token=abc']);
  assert.match(summary, /DEEPSEEK_API_KEY=\[REDACTED\]/);
  assert.match(summary, /--password \[REDACTED\]/);
  assert.match(summary, /--token=\[REDACTED\]/);
  assert.doesNotMatch(summary, /sk-live|hunter2|abc/);
  assert.equal(commandSummary(['x'.repeat(400)]).length, 300, 'summary stays bounded');
});

test('a shell wrapper yields to the command it runs, while a plain persistent shell is not a command', () => {
  const table: ProcessSnapshot[] = [
    proc(200, 1, ['systemd-run', '--unit=w', '--', 'node', 'vendor.js']),
    proc(201, 200, ['node', 'vendor.js']),
    proc(202, 201, ['bash', '-lc', 'sleep 300'], { startTicks: 10 }),
    proc(203, 202, ['sleep', '300'], { startTicks: 11 }),
    proc(204, 201, ['bash'], { startTicks: 5 }),
  ];
  const observation = observeProcessTree(200, table, START, 100, 0);
  assert.equal(observation.command?.pid, 203);
  assert.match(observation.command!.summary, /^sleep 300$/);
});

test('a real systemd-run child in another cgroup contributes CPU and a live command', { skip: await skip(), timeout: 30_000 }, async t => {
  const dir = tempDir();
  const unit = `weaver-tree-inner-${randomBytes(4).toString('hex')}`;
  const pidfile = join(dir, 'inner.pid');
  const script = join(dir, 'root.cjs');
  writeFileSync(script, `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn('systemd-run', ['--user','--scope','--collect','--quiet','--unit=' + process.env.INNER, '--', '/bin/bash', '-c', 'while :; do :; done'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.PIDFILE, String(child.pid));
    setInterval(() => {}, 1000);
  `);
  const root = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', env: { ...process.env, INNER: unit, PIDFILE: pidfile } });
  t.after(() => { try { process.kill(-root.pid!, 'SIGKILL'); } catch { /* gone */ } });
  t.after(async () => { await systemctl(['stop', `${unit}.scope`]); rmSync(dir, { recursive: true, force: true }); });
  await until(() => { try { return Number(readFileSync(pidfile, 'utf8')) > 1; } catch { return false; } }, 'inner launcher');
  const inner = Number(readFileSync(pidfile, 'utf8'));
  await until(() => cgroupUnit(inner) === unit, 'the child to move to its own scope');
  const before = processTreeCpuNs(root.pid!, readProcessSnapshots())!;
  await pause(400);
  const after = processTreeCpuNs(root.pid!, readProcessSnapshots())!;
  assert.ok(after - before > 0, `expected the escaped busy loop to burn CPU (${before} -> ${after})`);
  const observation = observeProcessTree(root.pid!, readProcessSnapshots(), Date.now(), 100, 0);
  assert.ok(observation.cpuNs !== null);
  assert.ok(observation.command, 'the escaped command is still a live command');
  assert.match(observation.command!.summary, /while :; do :; done/);
  assert.ok(alive(inner));
});

test('cancelling an owned scope stops exactly the scope a descendant escaped into', { skip: await skip(), timeout: 30_000 }, async t => {
  const dir = tempDir();
  const innerUnit = `weaver-escape-inner-${randomBytes(4).toString('hex')}`;
  const outerUnit = `weaver-escape-outer-${randomBytes(4).toString('hex')}`;
  const pidfile = join(dir, 'inner.pid');
  const script = join(dir, 'escape.cjs');
  writeFileSync(script, `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn('systemd-run', ['--user','--scope','--collect','--quiet','--unit=' + process.env.INNER, '--', '/bin/sleep', '60'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.PIDFILE, String(child.pid));
    setInterval(() => {}, 1000);
  `);
  const scope = startOwnedScope({ command: [process.execPath, script], cwd: dir, env: { ...process.env, INNER: innerUnit, PIDFILE: pidfile }, stdin: null, unit: outerUnit });
  scope.on('error', () => {});
  const cleanup = new Promise<{ units: string[]; pids: number[] }>(resolve => scope.once('cleanup', resolve));
  t.after(async () => { try { scope.kill('SIGKILL'); } catch { /* already closed */ } await systemctl(['stop', `${innerUnit}.scope`]); rmSync(dir, { recursive: true, force: true }); });
  await until(() => { try { return Number(readFileSync(pidfile, 'utf8')) > 1; } catch { return false; } }, 'escaped launcher');
  const inner = Number(readFileSync(pidfile, 'utf8'));
  await until(() => cgroupUnit(inner) === innerUnit, 'the escaped process to join its own scope');
  const closed = new Promise<void>(resolve => scope.once('close', () => resolve()));
  assert.equal(scope.kill('SIGTERM'), true);
  const report = await Promise.race([cleanup, pause(8000).then(() => { throw new Error('cleanup event never arrived'); })]);
  await closed;
  assert.ok(report.units.includes(`${innerUnit}.scope`), JSON.stringify(report));
  assert.ok(report.pids.includes(inner));
  await until(() => !alive(inner), 'the escaped process to stop');
  const state = await systemctl(['show', `${innerUnit}.scope`, '-p', 'LoadState', '--value']);
  assert.equal(state.stdout.trim(), 'not-found');
});
