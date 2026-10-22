import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CliAgentInputError, startCliAgent, __setRunUnitPrefixForTests } from '../../src/main/adapters/cli';
import { FILE_SCOPE_SHELL_SCRIPT, confirmScopeAbsent, inspectScope, killOwnedScope } from '../../src/main/adapters/cli/scope';
import { attachCliRun, pickFatalFailure, startCliRun } from '../../src/main/adapters/cli/run';
import { guardPiRun } from '../../src/main/adapters/cli/pi-guard';
import { closeRunFiles, createRunFiles } from '../../src/main/adapters/cli/run-files';
import type { CliRun, RunBatch, RunCursor, RunFinal, RunLaunchRecord } from '../../src/main/adapters/cli/run';
import type { CliAgentInput } from '../../src/main/adapters/cli';
import type { WorkerRecord } from '../../src/shared/contracts/tasks';

import type { ManagedProcess } from '../../src/main/adapters/worker';

const TMP = mkdtempSync(join(tmpdir(), 'wv-cli-run-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const systemdEnabled = process.env.WEAVER_WORKER_SCOPE_TEST === '1';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await pause(50);
  }
}

async function requireRealSystemd(): Promise<void> {
  assert.equal(process.platform, 'linux', 'file scope tests require Linux');
  const state = await new Promise<string>(resolve =>
    execFile('systemctl', ['--user', 'is-system-running'], (error, stdout) => resolve(String(stdout || error?.message || '').trim())),
  );
  assert.ok(['running', 'degraded'].includes(state), `systemd user session unavailable: ${state}`);
}

function baseInput(engine: CliAgentInput['engine'] = 'opencode'): CliAgentInput & { runId: string } {
  const workspace = mkdtempSync(join(TMP, 'run-ws-'));
  return {
    engine,
    model: engine === 'pi' ? 'cc-switch-agentplan/glm-5.3-flash' : 'opencode/test',
    effort: engine === 'pi' ? 'low' : 'max',
    workspace,
    instruction: 'do it',
    stateDir: join(workspace, 'state'),
    runId: `r${randomBytes(4).toString('hex')}`,
  };
}

test('invalid input is rejected before any file is created', () => {
  const workspace = mkdtempSync(join(TMP, 'run-ws-'));
  const stateDir = join(workspace, 'state');
  assert.throws(
    () =>
      startCliRun({ engine: 'nope' as CliAgentInput['engine'], model: 'm', effort: 'low', workspace, instruction: 'x', stateDir, runId: 'r0' }, () => {}),
    (error: unknown) => error instanceof CliAgentInputError && /Engine must be/.test(error.message),
  );
  assert.equal(existsSync(stateDir), false, 'no state dir side effect on validation failure');
});

test('beforeSpawn runs before spawn and a throw spawns nothing', () => {
  const input = baseInput();
  let hookCalls = 0;
  let thrown: unknown;
  try {
    startCliRun(input, () => {
      hookCalls += 1;
      throw new Error('hook boom');
    });
  } catch (error) {
    thrown = error;
  }
  assert.match((thrown as Error)?.message ?? '', /hook boom/);
  assert.equal(hookCalls, 1);
  assert.equal(existsSync(join(input.stateDir, `exit-${input.runId}.json`)), false, 'no exit file without a spawn');
  assert.ok(existsSync(join(input.stateDir, `stdout-${input.runId}.log`)), 'log files were pre-created');
  // The FDs were closed: the same runId fails closed on the existing files.
  assert.throws(() => startCliRun(input, () => {}), /EEXIST/);
});

test('fatal candidates in one batch follow auth > quota > rate_limit > model > no_output/early_exit > other', () => {
  const failure = (kind: 'auth' | 'quota' | 'rate_limit' | 'vendor' | 'early_exit' | 'other') => ({ kind, message: kind });
  assert.equal(pickFatalFailure([]), undefined);
  assert.equal(
    pickFatalFailure([
      { failure: failure('other'), offset: 1 },
      { failure: failure('rate_limit'), offset: 100 },
      { failure: failure('quota'), offset: 200 },
      { failure: failure('auth'), offset: 300 },
    ])?.kind,
    'auth',
  );
  assert.equal(
    pickFatalFailure([
      { failure: failure('vendor'), offset: 50 },
      { failure: failure('early_exit'), offset: 60 },
      { failure: failure('rate_limit'), offset: 70 },
    ])?.kind,
    'rate_limit',
  );
  // Same priority takes the smallest source offset.
  const tie = pickFatalFailure([
    { failure: { kind: 'other', message: 'late' }, offset: 90 },
    { failure: { kind: 'other', message: 'early' }, offset: 10 },
  ]);
  assert.equal(tie?.message, 'early');
});

function dummyRun(): CliRun {
  return Object.assign(new EventEmitter(), {
    unit: '',
    evidence: { engine: 'pi', requestedModel: 'm', requestedEffort: 'low', workspace: '/tmp', terminal: 'pending' },
    launch: { unit: '', stateDir: '', nonce: '', logs: { stdout: '', stderr: '', exit: '', exitTmp: '' }, logIdentity: { stdout: { dev: 0, ino: 0 }, stderr: { dev: 0, ino: 0 } }, promptPath: '' },
    setInvocation() {},
    setCancelled() {},
    terminate: async () => ({ ok: false, reason: 'not-started' }) as const,
    detach() {},
  }) as CliRun;
}

function piInput(): CliAgentInput & { runId: string } {
  const workspace = mkdtempSync(join(TMP, 'run-ws-'));
  return { engine: 'pi', model: 'cc-switch-agentplan/glm-5.3-flash', effort: 'low', workspace, instruction: 'x', stateDir: join(workspace, 'state'), runId: `r${randomBytes(4).toString('hex')}` };
}

test('guardPiRun with a closed gate starts nothing and reports PREFLIGHT_ABORTED', async () => {
  const calls: string[] = [];
  let hookCalls = 0;
  const fake = (input: CliAgentInput & { runId: string }, _hook: (record: RunLaunchRecord) => void) => {
    calls.push(input.engine);
    return dummyRun();
  };
  const guarded = guardPiRun(fake, async () => undefined, () => false);
  const run = guarded(piInput(), () => {
    hookCalls += 1;
  });
  const error = await new Promise<Error>(resolve => run.once('error', resolve));
  assert.equal((error as NodeJS.ErrnoException).code, 'PREFLIGHT_ABORTED');
  assert.deepEqual(calls, []);
  assert.equal(hookCalls, 0, 'beforeSpawn must not run when the gate is closed');
});

test('guardPiRun passes non-pi engines straight through even with a closed gate', () => {
  const seen: Array<{ engine: string; hook: unknown }> = [];
  const fake = (input: CliAgentInput & { runId: string }, hook: (record: RunLaunchRecord) => void) => {
    seen.push({ engine: input.engine, hook });
    return dummyRun();
  };
  const guarded = guardPiRun(fake, async () => 'must not be called', () => false);
  const hook = () => {};
  const input = { ...piInput(), engine: 'opencode' as const, model: 'opencode/test', effort: 'max' as const };
  const run = guarded(input, hook as (record: RunLaunchRecord) => void);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.engine, 'opencode');
  assert.equal(seen[0]!.hook, hook);
  assert.ok(run);
});

test('guardPiRun with an open gate starts pi after the model check', async () => {
  const calls: string[] = [];
  const fake = (input: CliAgentInput & { runId: string }, _hook: (record: RunLaunchRecord) => void) => {
    calls.push(input.engine);
    return dummyRun();
  };
  const guarded = guardPiRun(fake, async () => undefined, () => true);
  guarded(piInput(), () => {});
  await waitFor(() => calls.length === 1, 5000, 'pi was not started after the check');
});

test('fd 8 is not visible to the engine process', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(TMP, 'run-fd8-'));
  const prompt = join(dir, 'prompt.txt');
  writeFileSync(prompt, 'PROMPT-BYTES\n');
  const outPath = join(dir, 'stdout.log');
  const errPath = join(dir, 'stderr.log');
  const exitPath = join(dir, 'exit.json');
  const exitTmp = join(dir, 'exit.tmp');
  const outFd = openSync(outPath, 'w', 0o600);
  const errFd = openSync(errPath, 'w', 0o600);
  const inFd = openSync(prompt, 'r');
  // The engine inspects its own fd table: fd 8 must be gone, stdin still works.
  const engine = ['sh', '-c', 'cat; if [ -e /proc/self/fd/8 ]; then echo HAS-FD-8; else echo NO-FD-8; fi'];
  const child = spawn('/bin/sh', ['-c', FILE_SCOPE_SHELL_SCRIPT, 'sh', ...engine], {
    stdio: [inFd, outFd, errFd],
    env: { ...process.env, WEAVER_RUN_ID: 'fd8', WEAVER_RUN_NONCE: 'fd8', WEAVER_EXIT_FILE: exitPath, WEAVER_EXIT_TMP: exitTmp },
  });
  closeSync(outFd);
  closeSync(errFd);
  closeSync(inFd);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('shell did not exit')), 15000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const log = readFileSync(outPath, 'utf8');
  assert.ok(log.includes('PROMPT-BYTES'), `stdin must still reach the engine: ${JSON.stringify(log)}`);
  assert.ok(log.includes('NO-FD-8') && !log.includes('HAS-FD-8'), `engine must not see fd 8: ${JSON.stringify(log)}`);
  const record = JSON.parse(readFileSync(exitPath, 'utf8')) as { code: number };
  assert.equal(record.code, 0);
});

// --- systemd file-mode runs -------------------------------------------------

function writeFixtureBin(dir: string, name: string, body: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return bin;
}

const QUICK_BODY = [
  `printf '%s\\n' '{"type":"text","sessionID":"sess-fix","part":{"type":"text","text":"PONG"}}'`,
  `printf '%s\\n' '{"type":"tool_use","sessionID":"sess-fix","part":{"type":"tool","tool":"write","state":{"status":"completed"}}}'`,
  `printf '%s\\n' '{"type":"step_finish","sessionID":"sess-fix","part":{"reason":"stop","tokens":{"input":2,"output":1}}}'`,
  'exit 0',
].join('\n');

interface Collected {
  batches: RunBatch[];
  finals: RunFinal[];
  identities: string[];
  errors: Error[];
  integrities: Array<{ reason: string; detail: string }>;
}

function track(run: CliRun): Collected {
  const collected: Collected = { batches: [], finals: [], identities: [], errors: [], integrities: [] };
  run.on('batch', (batch: RunBatch) => {
    collected.batches.push(batch);
  });
  run.on('final', (final: RunFinal) => {
    collected.finals.push(final);
  });
  run.on('identity', (invocation: string) => {
    collected.identities.push(invocation);
  });
  run.on('error', (error: Error) => {
    collected.errors.push(error);
  });
  run.on('integrity', (reason: string, detail: string) => {
    collected.integrities.push({ reason, detail });
  });
  return collected;
}

async function waitFinal(collected: Collected, timeoutMs: number): Promise<RunFinal> {
  await waitFor(() => collected.finals.length > 0, timeoutMs, 'final was not emitted');
  return collected.finals[0]!;
}

function collectPipe(pipe: ManagedProcess, timeoutMs: number): Promise<WorkerRecord[]> {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('pipe close timed out')), timeoutMs);
    pipe.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    pipe.once('close', () => {
      clearTimeout(timer);
      resolve(
        out
          .trim()
          .split('\n')
          .filter(line => line.length > 0)
          .map(line => JSON.parse(line) as WorkerRecord),
      );
    });
  });
}

async function cleanupUnit(unit: string): Promise<void> {
  if (!unit) return;
  try {
    const inspection = await inspectScope(unit);
    if (inspection.state === 'present' && inspection.invocation) {
      await killOwnedScope(unit, inspection.invocation, 'SIGKILL');
    } else if (inspection.state === 'present') {
      const { execFile: exec } = await import('node:child_process');
      await new Promise<void>(resolve => {
        exec('systemctl', ['--user', 'stop', `${unit}.scope`], () => resolve());
      });
    }
  } catch {
    /* best effort */
  }
}

test('file-mode online batches match pipe-mode records', { skip: !systemdEnabled, timeout: 120000 }, async () => {
  await requireRealSystemd();
  __setRunUnitPrefixForTests('weaver-p1test-');
  const savedPath = process.env.PATH;
  const dir = mkdtempSync(join(TMP, 'run-eq-'));
  let unit = '';
  try {
    const bin = writeFixtureBin(dir, 'opencode', QUICK_BODY);
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    const workspace = mkdtempSync(join(TMP, 'run-ws-'));
    const input = { engine: 'opencode' as const, model: 'opencode/test', effort: 'max' as const, workspace, instruction: 'do it', stateDir: join(workspace, 'state'), runId: `a${randomBytes(4).toString('hex')}` };
    let launch: RunLaunchRecord | undefined;
    const run = startCliRun(input, record => {
      launch = record;
    });
    assert.ok(launch!.unit.startsWith('weaver-p1test-'), `unit carries the test prefix: ${launch!.unit}`);
    unit = launch!.unit;
    const seen = track(run);
    const final = await waitFinal(seen, 60000);
    assert.equal(seen.errors.length, 0, `no run errors: ${seen.errors.map(String).join('; ')}`);
    assert.equal(final.exit.recorded, true);
    assert.equal(final.exit.code, 0);
    assert.equal(final.evidence.terminal, 'success');
    const pipe = startCliAgent({ ...input, stateDir: join(workspace, 'pipe-state') });
    const pipeRecords = await collectPipe(pipe, 60000);
    const runRecords = [...seen.batches.flatMap(batch => batch.records), ...final.records];
    assert.deepEqual(runRecords, pipeRecords);
    assert.ok(runRecords.some(record => record.type === 'result'), 'success delivers a result record');
    await waitFor(async () => (await confirmScopeAbsent(unit)) === true, 30000, `scope leaked: ${unit}`);
  } finally {
    process.env.PATH = savedPath;
    __setRunUnitPrefixForTests(undefined);
    await cleanupUnit(unit);
  }
});

const SLOW_BODY = [
  'for i in 1 2 3 4 5; do echo "{\\"type\\":\\"text\\",\\"sessionID\\":\\"sess-slow\\",\\"part\\":{\\"type\\":\\"text\\",\\"text\\":\\"PONG-$i\\"}}"; sleep 0.5; done',
  `printf '%s\\n' '{"type":"tool_use","sessionID":"sess-slow","part":{"type":"tool","tool":"write","state":{"status":"completed"}}}'`,
  `printf '%s\\n' '{"type":"step_finish","sessionID":"sess-slow","part":{"reason":"stop","tokens":{"input":2,"output":1}}}'`,
  'exit 0',
].join('\n');

test('detach then attach resumes without repeating records and delivers one final', { skip: !systemdEnabled, timeout: 180000 }, async () => {
  await requireRealSystemd();
  __setRunUnitPrefixForTests('weaver-p1test-');
  const savedPath = process.env.PATH;
  const dir = mkdtempSync(join(TMP, 'run-re-'));
  let unit = '';
  let refUnit = '';
  try {
    const bin = writeFixtureBin(dir, 'opencode', SLOW_BODY);
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    const workspace = mkdtempSync(join(TMP, 'run-ws-'));
    const input = { engine: 'opencode' as const, model: 'opencode/test', effort: 'max' as const, workspace, instruction: 'do it', stateDir: join(workspace, 'state'), runId: `b${randomBytes(4).toString('hex')}` };
    // Reference: one uninterrupted run.
    const refInput = { ...input, stateDir: join(workspace, 'ref-state'), runId: `ref${randomBytes(4).toString('hex')}` };
    const refRun = startCliRun(refInput, record => {
      refUnit = record.unit;
    });
    const refSeen = track(refRun);
    const refFinal = await waitFinal(refSeen, 90000);
    const reference = [...refSeen.batches.flatMap(batch => batch.records), ...refFinal.records];
    // Interrupted run: detach at the first vendor batch after identity lands.
    let launch: RunLaunchRecord | undefined;
    const run = startCliRun(input, record => {
      launch = record;
    });
    unit = '';
    const seen = track(run);
    await waitFor(() => seen.identities.length > 0, 15000, 'identity never landed');
    // Detach mid-run: after the launcher batch and the first vendor batch.
    await waitFor(() => seen.batches.filter(batch => batch.records.length > 0).length >= 2, 30000, 'vendor batches never arrived');
    const invocation = seen.identities[0]!;
    unit = launch!.unit;
    const cursor: RunCursor = { ...seen.batches[seen.batches.length - 1]!.cursor };
    run.detach();
    const preRecords = seen.batches.flatMap(batch => batch.records);
    await pause(1500);
    assert.equal(seen.finals.length, 0, 'a detached run must not emit final');
    // Attach from the last batch cursor and run to completion.
    const attached = attachCliRun({ input, launch: launch!, invocation, cursor, cancelled: false });
    const attachedSeen = track(attached);
    const attachedFinal = await waitFinal(attachedSeen, 90000);
    assert.equal(attachedSeen.finals.length, 1, 'exactly one final after attach');
    const resumed = [...preRecords, ...attachedSeen.batches.flatMap(batch => batch.records), ...attachedFinal.records];
    assert.deepEqual(resumed, reference);
    // The attached tail advanced past the detach cursor without overlap.
    assert.ok(attachedSeen.batches.every(batch => batch.cursor.appliedRecords >= cursor.appliedRecords));
    await waitFor(async () => (await confirmScopeAbsent(unit)) === true, 30000, `scope leaked: ${unit}`);
  } finally {
    process.env.PATH = savedPath;
    __setRunUnitPrefixForTests(undefined);
    await cleanupUnit(unit);
    await cleanupUnit(refUnit);
  }
});

test('attachCliRun defers its first pump so listeners attached right after it receive the backlog and final', async () => {
  const dir = mkdtempSync(join(TMP, 'run-attach-defer-'));
  const stateDir = join(dir, 'state');
  const runId = `d${randomBytes(4).toString('hex')}`;
  const created = createRunFiles(stateDir, runId);
  closeRunFiles(created.fds);
  writeFileSync(created.paths.stdout, [JSON.stringify({ type: 'step_start', sessionID: 'sess-defer' }), JSON.stringify({ type: 'text', sessionID: 'sess-defer', part: { type: 'text', text: 'PONG' } })].join('\n') + '\n');
  writeFileSync(created.paths.exit, `${JSON.stringify({ runId, nonce: created.nonce, code: 0, signal: null, pid: 1234, at: new Date().toISOString() })}\n`);
  const launch: RunLaunchRecord = {
    unit: `weaver-p1test-${runId}`,
    stateDir,
    nonce: created.nonce,
    logs: created.paths,
    logIdentity: created.identity,
    promptPath: join(stateDir, 'prompt.txt'),
  };
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho LoadState=not-found\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ''}`;
  const originalEmit = EventEmitter.prototype.emit;
  try {
    const run = attachCliRun({
      input: { engine: 'opencode', model: 'opencode/test', effort: 'max', workspace: dir, instruction: 'do it', stateDir, runId },
      launch,
      cursor: { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 0 },
      cancelled: false,
    });
    assert.equal(EventEmitter.prototype.emit, originalEmit, 'attach must not replace the global emitter');
    const batches: RunBatch[] = [];
    const finals: RunFinal[] = [];
    run.on('batch', batch => batches.push(batch));
    run.on('final', final => finals.push(final));
    assert.equal(batches.length, 0, 'attach returned before emitting the backlog');
    await waitFor(() => finals.length === 1, 5000, 'attached final was not emitted');
    assert.ok(batches.length > 0, 'the synchronous listener received the backlog batch');
    assert.ok(batches.some(batch => batch.records.length > 0), 'the backlog batch carried records');
    assert.equal(finals[0]!.exit.recorded, true);
    assert.equal(EventEmitter.prototype.emit, originalEmit, 'polling did not replace the global emitter either');
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGKILL with no exit record ends recorded=false', { skip: !systemdEnabled, timeout: 120000 }, async () => {
  await requireRealSystemd();
  __setRunUnitPrefixForTests('weaver-p1test-');
  const savedPath = process.env.PATH;
  const dir = mkdtempSync(join(TMP, 'run-kill-'));
  let unit = '';
  try {
    const bin = writeFixtureBin(dir, 'opencode', [`printf '%s\\n' '{"type":"text","sessionID":"sess-k","part":{"type":"text","text":"PONG"}}'`, 'sleep 30'].join('\n'));
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    const workspace = mkdtempSync(join(TMP, 'run-ws-'));
    const input = { engine: 'opencode' as const, model: 'opencode/test', effort: 'max' as const, workspace, instruction: 'do it', stateDir: join(workspace, 'state'), runId: `k${randomBytes(4).toString('hex')}` };
    let launch: RunLaunchRecord | undefined;
    const run = startCliRun(input, record => {
      launch = record;
    });
    unit = launch!.unit;
    const seen = track(run);
    await waitFor(() => seen.identities.length > 0, 15000, 'identity never landed');
    // SIGKILL leaves no exit record; the scope may already be reaped before
    // the follow-up stop runs, so only convergence to absent is asserted here.
    await killOwnedScope(unit, seen.identities[0]!, 'SIGKILL');
    await waitFor(async () => (await confirmScopeAbsent(unit)) === true, 30000, `scope leaked: ${unit}`);
    const final = await waitFinal(seen, 60000);
    assert.deepEqual(final.exit, { code: null, signal: null, recorded: false });
  } finally {
    process.env.PATH = savedPath;
    __setRunUnitPrefixForTests(undefined);
    await cleanupUnit(unit);
  }
});

test('an exit record with surviving descendants is cleaned before the only final', { skip: !systemdEnabled, timeout: 120000 }, async () => {
  await requireRealSystemd();
  __setRunUnitPrefixForTests('weaver-p1test-');
  const savedPath = process.env.PATH;
  const dir = mkdtempSync(join(TMP, 'run-desc-'));
  let unit = '';
  try {
    const bin = writeFixtureBin(
      dir,
      'opencode',
      [
        `printf '%s\\n' '{"type":"text","sessionID":"sess-d","part":{"type":"text","text":"PONG"}}'`,
        `printf '%s\\n' '{"type":"step_finish","sessionID":"sess-d","part":{"reason":"stop"}}'`,
        'sleep 45 &',
        'exit 0',
      ].join('\n'),
    );
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    const workspace = mkdtempSync(join(TMP, 'run-ws-'));
    const input = { engine: 'opencode' as const, model: 'opencode/test', effort: 'max' as const, workspace, instruction: 'do it', stateDir: join(workspace, 'state'), runId: `d${randomBytes(4).toString('hex')}` };
    let launch: RunLaunchRecord | undefined;
    const run = startCliRun(input, record => {
      launch = record;
    });
    unit = launch!.unit;
    const seen = track(run);
    await waitFor(() => seen.identities.length > 0, 15000, 'identity never landed');
    const final = await waitFinal(seen, 90000);
    assert.equal(seen.finals.length, 1, 'exactly one final');
    assert.equal(final.exit.recorded, true);
    assert.equal(final.exit.code, 0);
    assert.equal(final.evidence.terminal, 'success');
    assert.ok(final.records.some(record => record.type === 'result'), 'success delivers a result record');
    await waitFor(async () => (await confirmScopeAbsent(unit)) === true, 30000, `descendants were not cleaned: ${unit}`);
  } finally {
    process.env.PATH = savedPath;
    __setRunUnitPrefixForTests(undefined);
    await cleanupUnit(unit);
  }
});

test('a reattached run sweeps a descendant that escaped into another scope at final teardown', { skip: !systemdEnabled, timeout: 120000 }, async () => {
  await requireRealSystemd();
  __setRunUnitPrefixForTests('weaver-p1test-');
  const savedPath = process.env.PATH;
  const dir = mkdtempSync(join(TMP, 'run-reattach-escape-'));
  const innerUnit = `weaver-p1test-escape-inner-${randomBytes(4).toString('hex')}`;
  const ready = join(dir, 'inner.ready');
  let unit = '';
  const state = (name: string): Promise<string> => new Promise(resolve =>
    execFile('systemctl', ['--user', 'show', `${name}.scope`, '-p', 'ActiveState', '--value'], (error, stdout) => resolve(String(stdout || error?.message || '').trim())),
  );
  try {
    const input = baseInput();
    const bin = writeFixtureBin(input.workspace, 'opencode', [
      `printf '%s\\n' '{"type":"text","sessionID":"sess-escape","part":{"type":"text","text":"PONG"}}'`,
      `printf '%s\\n' '{"type":"step_finish","sessionID":"sess-escape","part":{"reason":"stop"}}'`,
      `systemd-run --user --scope --quiet --collect --unit='${innerUnit}' -- /bin/sleep 30 &`,
      `touch '${ready}'`,
      'sleep 8',
      'exit 0',
    ].join('\n'));
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    const run = startCliRun(input, () => {});
    unit = run.unit;
    const seen = track(run);
    await waitFor(() => seen.identities.length > 0, 15000, 'identity never landed');
    await waitFor(() => existsSync(ready), 15000, 'escaped scope never started');
    await waitFor(async () => (await state(innerUnit)) === 'active', 15000, 'escaped scope never became active');
    // Let the reattached run's own sweep observe the escape before the root disappears.
    await pause(3500);
    const rootPid = run.pid;
    const invocation = seen.identities[0]!;
    const cursor = seen.batches.at(-1)?.cursor ?? { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 0 };
    run.detach();
    assert.equal(await state(innerUnit), 'active', 'detach never stops the escaped worker');
    const attached = attachCliRun({ input, launch: run.launch, invocation, cursor: { ...cursor }, pid: rootPid, cancelled: false });
    const cleaned: Array<{ units: string[]; pids: number[] }> = [];
    attached.on('cleanup', report => cleaned.push(report));
    attached.on('error', () => {});
    await waitFor(() => cleaned.length > 0, 60000, 'reattached final never reported the escaped cleanup');
    assert.ok(cleaned.some(report => report.units.includes(`${innerUnit}.scope`)), JSON.stringify(cleaned));
    await waitFor(async () => !['active', 'activating'].includes(await state(innerUnit)), 15000, 'escaped scope survived final teardown');
  } finally {
    process.env.PATH = savedPath;
    __setRunUnitPrefixForTests(undefined);
    await cleanupUnit(innerUnit);
    await cleanupUnit(unit);
    rmSync(dir, { recursive: true, force: true });
  }
});
