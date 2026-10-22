import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  confirmScopeAbsent,
  findFdEvidence,
  inspectScope,
  killOwnedScope,
  recoverOwnedScope,
  startOwnedScope,
} from '../../src/main/adapters/cli/scope';
import { checkLogIdentity, createRunFiles, readExitRecord } from '../../src/main/adapters/cli/run-files';

const enabled = process.env.WEAVER_WORKER_SCOPE_TEST === '1';
const TMP = mkdtempSync(join(tmpdir(), 'wv-file-scope-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs: number, message: string) => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await pause(100);
  }
};
const systemctl = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>(resolvePromise => {
    execFile('systemctl', ['--user', ...args], { timeout: 8000 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolvePromise({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
const unitName = () => `weaver-p1test-${randomBytes(4).toString('hex')}`;
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function requireRealSystemd() {
  if (process.platform !== 'linux') throw new Error('file scope tests require Linux');
  const state = await new Promise<string>(resolvePromise =>
    execFile('systemctl', ['--user', 'is-system-running'], (error, stdout) => resolvePromise(String(stdout || error?.message || '').trim())),
  );
  if (!['running', 'degraded'].includes(state)) throw new Error(`systemd user session unavailable: ${state}`);
}

async function cleanup(unit: string, invocation?: string) {
  try {
    await recoverOwnedScope(unit, invocation);
  } catch {
    try {
      await systemctl(['stop', `${unit}.scope`]);
    } catch {
      /* exact unit already gone */
    }
  }
}

test('inspectScope reports absent for a never-created unit', { skip: !enabled, timeout: 60000 }, async () => {
  await requireRealSystemd();
  const seen = await inspectScope(unitName());
  assert.deepEqual(seen, { state: 'absent' });
});

test('inspect/kill lifecycle on a real scope: present, refuse mismatch, SIGTERM cleanup', { skip: !enabled, timeout: 120000 }, async () => {
  await requireRealSystemd();
  const unit = unitName();
  const launcher = spawn('systemd-run', ['--user', '--scope', '--collect', '--quiet', `--unit=${unit}`, '--working-directory=/tmp', '--', '/bin/sleep', '60'], {
    stdio: 'ignore',
    detached: true,
  });
  launcher.unref();
  try {
    await waitFor(async () => (await inspectScope(unit)).state === 'present', 15000, 'scope never became present');
    const present = await inspectScope(unit);
    assert.equal(present.state, 'present');
    if (present.state !== 'present') throw new Error('unreachable');
    assert.equal(present.active, 'active');
    assert.match(present.invocation ?? '', /^[0-9a-f]{32}$/);
    assert.ok((present.cgroup ?? '').includes(`${unit}.scope`));
    // confirmScopeAbsent must be false while the scope lives.
    assert.equal(await confirmScopeAbsent(unit), false);
    // Wrong invocation is refused and the scope survives.
    const refused = await killOwnedScope(unit, '0'.repeat(32), 'SIGTERM');
    assert.equal(refused.ok, false);
    assert.equal((refused as { reason: string }).reason, 'invocation-mismatch');
    assert.equal((await inspectScope(unit)).state, 'present');
    // Unknown inspection input is refused without acting.
    const unknownRefused = await killOwnedScope(unit, undefined, 'SIGTERM');
    assert.equal(unknownRefused.ok, false);
    // Correct invocation kills; SIGTERM does not auto-stop, so stop explicitly.
    const killed = await killOwnedScope(unit, present.invocation, 'SIGTERM');
    assert.equal(killed.ok, true);
    await systemctl(['stop', `${unit}.scope`]);
    await waitFor(async () => (await confirmScopeAbsent(unit)) === true, 30000, 'scope did not converge to absent');
  } finally {
    try {
      launcher.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await cleanup(unit);
  }
});

test('findFdEvidence hits the live log inode and misses a foreign identity', { skip: !enabled, timeout: 120000 }, async () => {
  await requireRealSystemd();
  const dir = mkdtempSync(join(TMP, 'fscope-'));
  const created = createRunFiles(dir, 'ev1');
  const unit = unitName();
  const handle = startOwnedScope({
    command: ['/bin/sleep', '60'],
    cwd: dir,
    env: process.env,
    stdin: null,
    unit,
    files: { stdoutFd: created.fds.stdout, stderrFd: created.fds.stderr, exitPath: created.paths.exit, exitTmpPath: created.paths.exitTmp, runId: 'ev1', nonce: created.nonce },
  });
  try {
    await waitFor(async () => (await inspectScope(unit)).state === 'present', 15000, 'file scope never became present');
    // The shell + engine hold the log FDs writable inside the unit cgroup.
    let found: string | undefined;
    await waitFor(async () => {
      found = await findFdEvidence(unit, created.identity);
      return found !== undefined;
    }, 15000, 'FD evidence never hit');
    const live = await inspectScope(unit);
    assert.equal(live.state, 'present');
    if (live.state === 'present') assert.equal(found, live.invocation);
    // A foreign identity never matches (and proves nothing about liveness).
    const miss = await findFdEvidence(unit, { stdout: { dev: 1, ino: 2 }, stderr: { dev: 3, ino: 4 } });
    assert.equal(miss, undefined);
    // Log identity still matches the live files.
    assert.deepEqual(checkLogIdentity(created.paths, created.identity, { stdout: 0, stderr: 0 }), { ok: true });
  } finally {
    handle.kill('SIGKILL');
    await waitFor(async () => (await confirmScopeAbsent(unit)) === true, 30000, 'file scope leaked').catch(() => {});
    await cleanup(unit);
  }
});

test('file-mode worker survives starter SIGKILL and writes a valid exit record', { skip: !enabled, timeout: 120000 }, async () => {
  await requireRealSystemd();
  const dir = mkdtempSync(join(TMP, 'fscope-'));
  const runId = `p1${randomBytes(4).toString('hex')}`;
  const unit = unitName();
  const scopeTs = resolve('src/main/adapters/cli/scope.ts');
  const filesTs = resolve('src/main/adapters/cli/run-files.ts');
  const controllerCode = `
import { writeFileSync } from 'node:fs';
import { startOwnedScope } from ${JSON.stringify(scopeTs)};
import { createRunFiles } from ${JSON.stringify(filesTs)};
const dir = ${JSON.stringify(dir)}, runId = ${JSON.stringify(runId)}, unit = ${JSON.stringify(unit)};
const created = createRunFiles(dir, runId);
const handle = startOwnedScope({
  command: ['sh', '-c', 'for i in 1 2 3; do echo beat-$i; sleep 1; done; exit 42'],
  cwd: dir, env: process.env, stdin: null, unit,
  files: { stdoutFd: created.fds.stdout, stderrFd: created.fds.stderr, exitPath: created.paths.exit, exitTmpPath: created.paths.exitTmp, runId, nonce: created.nonce },
});
handle.on('identity', invocation => {
  writeFileSync(${JSON.stringify(join(dir, 'ready.json'))}, JSON.stringify({ unit, invocation, nonce: created.nonce, paths: created.paths, identity: created.identity }), { mode: 0o600 });
});
setInterval(() => {}, 1000);
`;
  const controllerFile = join(dir, 'controller.mts');
  writeFileSync(controllerFile, controllerCode, { mode: 0o600 });
  let controller: ChildProcess | undefined;
  try {
    controller = spawn(process.execPath, ['--import', 'tsx', controllerFile], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
    let logged = '';
    controller.stdout?.on('data', chunk => {
      logged += chunk.toString();
    });
    let controllerStderr = '';
    controller.stderr?.on('data', chunk => {
      controllerStderr += chunk.toString();
    });
    await waitFor(() => existsSync(join(dir, 'ready.json')), 30000, `controller never published identity: ${logged} ${controllerStderr}`);
    const ready = JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8')) as {
      unit: string;
      invocation: string;
      nonce: string;
      paths: { stdout: string; stderr: string; exit: string; exitTmp: string };
      identity: { stdout: { dev: number; ino: number }; stderr: { dev: number; ino: number } };
    };
    assert.equal(ready.unit, unit);
    assert.match(ready.invocation, /^[0-9a-f]{32}$/);
    // The scope is present with the controller as starter; kill the starter.
    assert.equal((await inspectScope(unit)).state, 'present');
    const sizeAtKill = readFileSync(ready.paths.stdout, 'utf8').length;
    controller.kill('SIGKILL');
    await new Promise<void>(r => {
      if (controller!.exitCode !== null || controller!.signalCode !== null) return r();
      controller!.once('close', () => r());
    });
    assert.ok(!pidAlive(controller.pid!), 'starter is dead');
    // The worker keeps writing after the starter is gone.
    await waitFor(() => existsSync(ready.paths.exit), 30000, 'exit record never appeared after starter death');
    const record = readExitRecord(ready.paths.exit, runId, ready.nonce);
    assert.ok(record, 'exit record must be valid and bound to runId+nonce');
    assert.equal(record!.code, 42);
    assert.equal(typeof record!.pid, 'number');
    const logText = readFileSync(ready.paths.stdout, 'utf8');
    assert.ok(logText.includes('beat-1') && logText.includes('beat-2') && logText.includes('beat-3'), `worker kept writing: ${JSON.stringify(logText)}`);
    assert.ok(logText.length >= sizeAtKill, 'log kept growing or completed after the kill');
    assert.equal(existsSync(ready.paths.exitTmp), false, 'no .tmp residue');
    // Identity survived the starter death; the scope converges to absent.
    const after = await inspectScope(unit);
    if (after.state === 'present') assert.equal(after.invocation, ready.invocation);
    await waitFor(async () => (await confirmScopeAbsent(unit)) === true, 30000, 'worker scope did not collect after natural exit');
    appendFileSync(join(TMP, 'worker-file-scope-proof.log'), JSON.stringify({ unit, runId, code: record!.code }) + '\n');
  } finally {
    try {
      controller?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await cleanup(unit);
  }
});
