import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startOwnedScope, __setSpawnImplForTests, type OwnedScope } from '../../src/main/adapters/cli/scope';
import { attachCliRun, type RunLaunchRecord } from '../../src/main/adapters/cli/run';
import { guardPiRun } from '../../src/main/adapters/cli/pi-guard';
import { closeRunFiles, createRunFiles } from '../../src/main/adapters/cli/run-files';

const TMP = mkdtempSync(join(tmpdir(), 'wv-detach-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

interface FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  stdout: PassThrough & { unref?: () => void };
  stderr: PassThrough & { unref?: () => void };
  stdin: PassThrough & { unref?: () => void };
  unrefCalls: number;
  killCalls: string[];
  kill(signal?: string): boolean;
  unref(): void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 424242;
  child.exitCode = null;
  child.stdout = new PassThrough() as FakeChild['stdout'];
  child.stderr = new PassThrough() as FakeChild['stderr'];
  child.stdin = new PassThrough() as FakeChild['stdin'];
  child.unrefCalls = 0;
  child.killCalls = [];
  let stdoutUnref = 0;
  let stderrUnref = 0;
  (child.stdout as { unref?: () => void }).unref = () => { stdoutUnref += 1; };
  (child.stderr as { unref?: () => void }).unref = () => { stderrUnref += 1; };
  (child.stdin as { unref?: () => void }).unref = () => {};
  (child as unknown as { __stdoutUnref: () => number }).__stdoutUnref = () => stdoutUnref;
  (child as unknown as { __stderrUnref: () => number }).__stderrUnref = () => stderrUnref;
  child.kill = (signal?: string) => {
    child.killCalls.push(signal ?? 'SIGTERM');
    return true;
  };
  child.unref = () => {
    child.unrefCalls += 1;
  };
  return child;
}

test('OwnedScope detach unrefs the child, clears timers and never emits again', async () => {
  const created: FakeChild[] = [];
  __setSpawnImplForTests(((..._args: unknown[]) => {
    const child = makeFakeChild();
    created.push(child);
    return child as never;
  }) as never);
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const origClearImmediate = globalThis.clearImmediate;
  let clearedIntervals = 0;
  let clearedTimeouts = 0;
  let clearedImmediates = 0;
  (globalThis as Record<string, unknown>).clearInterval = ((id: unknown) => {
    clearedIntervals += 1;
    return (origClearInterval as (id: unknown) => void)(id);
  }) as typeof clearInterval;
  (globalThis as Record<string, unknown>).clearTimeout = ((id: unknown) => {
    clearedTimeouts += 1;
    return (origClearTimeout as (id: unknown) => void)(id);
  }) as typeof clearTimeout;
  (globalThis as Record<string, unknown>).clearImmediate = ((id: unknown) => {
    clearedImmediates += 1;
    return (origClearImmediate as (id: unknown) => void)(id);
  }) as typeof clearImmediate;
  try {
    const cwd = mkdtempSync(join(TMP, 'detach-scope-'));
    const scope = startOwnedScope({
      command: ['true'],
      cwd,
      env: {},
      stdin: null,
      unit: `weaver-p1test-detach-${randomBytes(4).toString('hex')}`,
    });
    assert.equal(created.length, 1, 'spawn injection was used');
    const child = created[0]!;
    assert.equal(child.unrefCalls, 0, 'no unref before detach');
    const events: string[] = [];
    scope.on('close', () => events.push('close'));
    scope.on('error', () => events.push('error'));
    scope.on('identity', () => events.push('identity'));
    (scope as OwnedScope).detach();
    assert.equal(child.unrefCalls, 1, 'child unref released the loop handle');
    assert.ok(clearedIntervals >= 1, 'verify interval cleared');
    assert.ok(clearedTimeouts >= 1, 'verify deadline cleared');
    assert.ok(clearedImmediates >= 1, 'deferred first verify cleared');
    const unrefs = (child as unknown as { __stdoutUnref: () => number }).__stdoutUnref();
    assert.ok(unrefs >= 1, 'stdio pipe handle unref released');
    // Late launcher activity must not surface after detach.
    assert.equal(child.listenerCount('error'), 0, 'launcher error listener released');
    assert.equal(child.listenerCount('exit'), 0, 'launcher exit listener released');
    assert.equal(child.listenerCount('close'), 0, 'launcher close listener released');
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    scope.emit('identity', 'deadbeef'.repeat(4));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [], 'no events after detach');
    assert.equal(scope.kill('SIGTERM'), false, 'kill after detach refuses');
    assert.deepEqual(child.killCalls, [], 'detach never signals the worker');
    // Idempotent.
    (scope as OwnedScope).detach();
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    globalThis.clearImmediate = origClearImmediate;
    __setSpawnImplForTests(undefined);
  }
});

test('CliRun detach releases its scope and suppresses late scope events', async () => {
  const dir = mkdtempSync(join(TMP, 'detach-run-'));
  const runId = `d${randomBytes(4).toString('hex')}`;
  const created = createRunFiles(join(dir, 'state'), runId);
  closeRunFiles(created.fds);
  writeFileSync(created.paths.stdout, '');
  const launch: RunLaunchRecord = {
    unit: `weaver-p1test-${runId}`,
    stateDir: join(dir, 'state'),
    nonce: created.nonce,
    logs: { ...created.paths },
    logIdentity: { stdout: { ...created.identity.stdout }, stderr: { ...created.identity.stderr } },
    promptPath: join(dir, 'state', 'prompt.txt'),
  };
  const run = attachCliRun({
    input: { engine: 'opencode', model: 'opencode/test', effort: 'max', workspace: dir, instruction: 'x', stateDir: join(dir, 'state'), runId },
    launch,
    cursor: { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 0 },
    cancelled: false,
  });
  const fakeScope = new EventEmitter() as OwnedScope & { detachCalls: number };
  fakeScope.detachCalls = 0;
  fakeScope.detach = () => { fakeScope.detachCalls += 1; };
  (run as unknown as { attachScope(scope: OwnedScope): void }).attachScope(fakeScope);
  const seen: string[] = [];
  run.on('batch', () => seen.push('batch'));
  run.on('final', () => seen.push('final'));
  run.on('identity', () => seen.push('identity'));
  run.on('error', () => seen.push('error'));
  run.detach();
  assert.equal(fakeScope.detachCalls, 1, 'CliRun.detach releases the owned scope');
  fakeScope.on('error', () => {});
  fakeScope.emit('identity', 'a'.repeat(32));
  fakeScope.emit('error', new Error('late scope error'));
  fakeScope.emit('batch', {});
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(seen, [], 'no run events propagate after detach');
  run.detach();
  rmSync(dir, { recursive: true, force: true });
});

test('GuardedPiRun detach during a pending model check starts nothing and emits nothing', async () => {
  let resolveCheck!: (problem: string | undefined) => void;
  const check = () => new Promise<string | undefined>(resolve => { resolveCheck = resolve; });
  let started = 0;
  const fakeStart = (() => {
    started += 1;
    throw new Error('must not start after detach');
  }) as never;
  const guarded = guardPiRun(fakeStart, check, () => true);
  const run = guarded(
    { engine: 'pi', model: 'm', effort: 'low', workspace: '/tmp', instruction: 'x', stateDir: '/tmp', runId: 'r-detach-pi' },
    () => {},
  );
  const seen: string[] = [];
  run.on('error', () => seen.push('error'));
  run.on('batch', () => seen.push('batch'));
  run.on('final', () => seen.push('final'));
  run.detach();
  resolveCheck(undefined);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(started, 0, 'preflight detach prevents the real start');
  assert.deepEqual(seen, [], 'detached guard emits nothing');
});
