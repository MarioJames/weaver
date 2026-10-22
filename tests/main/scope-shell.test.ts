import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_SCOPE_SHELL_SCRIPT } from '../../src/main/adapters/cli/scope';

const TMP = mkdtempSync(join(tmpdir(), 'wv-scope-shell-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const SH = '/bin/sh';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(cond: () => boolean, timeoutMs: number, message: string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await pause(25);
  }
}

interface ShellRun {
  child: ChildProcess;
  runId: string;
  nonce: string;
  exitPath: string;
  exitTmp: string;
  logOut: string;
  close: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function launchShell(engine: string[], opts: { stdinFile?: string } = {}): ShellRun {
  const dir = mkdtempSync(join(TMP, 'shell-'));
  const runId = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
  const nonce = `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}abcdef`;
  const exitPath = join(dir, `exit-${runId}.json`);
  const exitTmp = join(dir, `exit-${runId}.tmp`);
  const logOut = join(dir, 'stdout.log');
  const logErr = join(dir, 'stderr.log');
  const outFd = openSync(logOut, 'w', 0o600);
  const errFd = openSync(logErr, 'w', 0o600);
  let stdinFd: number | undefined;
  if (opts.stdinFile) stdinFd = openSync(opts.stdinFile, 'r');
  const child = spawn(SH, ['-c', FILE_SCOPE_SHELL_SCRIPT, 'sh', ...engine], {
    stdio: [stdinFd ?? 'ignore', outFd, errFd],
    env: { ...process.env, WEAVER_RUN_ID: runId, WEAVER_RUN_NONCE: nonce, WEAVER_EXIT_FILE: exitPath, WEAVER_EXIT_TMP: exitTmp },
  });
  closeSync(outFd);
  closeSync(errFd);
  if (stdinFd !== undefined) closeSync(stdinFd);
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, runId, nonce, exitPath, exitTmp, logOut, close };
}

function readRecord(run: ShellRun) {
  const lines = readFileSync(run.exitPath, 'utf8').split('\n').filter(l => l.length > 0);
  assert.equal(lines.length, 1, 'exit file must contain exactly one record');
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(parsed['runId'], run.runId);
  assert.equal(parsed['nonce'], run.nonce);
  return parsed;
}

test('shell wrapper is transparent: positional argv, no-op traps, no exec, env binding', () => {
  assert.ok(FILE_SCOPE_SHELL_SCRIPT.includes("trap ':' TERM INT HUP"), 'only no-op traps');
  assert.ok(!FILE_SCOPE_SHELL_SCRIPT.includes('trap \'\'') && !FILE_SCOPE_SHELL_SCRIPT.includes('trap ""'), 'must not use ignoring traps');
  assert.ok(!FILE_SCOPE_SHELL_SCRIPT.includes('exec "$@"') && !FILE_SCOPE_SHELL_SCRIPT.includes('exec $'), 'shell must not exec the engine (only the exec 8<&0 fd anchor)');
  assert.ok(FILE_SCOPE_SHELL_SCRIPT.includes('"$@" 0<&0'), 'engine runs in background with explicit stdin');
  assert.ok(FILE_SCOPE_SHELL_SCRIPT.includes('<&8'), 'stdin is anchored on a pre-saved fd (dash assigns /dev/null before redirections)');
  for (const name of ['WEAVER_RUN_ID', 'WEAVER_RUN_NONCE', 'WEAVER_EXIT_FILE', 'WEAVER_EXIT_TMP']) {
    assert.ok(FILE_SCOPE_SHELL_SCRIPT.includes(`$${name}`), `script reads ${name} from env`);
  }
  assert.ok(FILE_SCOPE_SHELL_SCRIPT.includes('mv -f "$WEAVER_EXIT_TMP" "$WEAVER_EXIT_FILE"'), 'exit record is tmp+rename');
});

test('TERM interrupting wait does not kill the shell; engine exit code is recorded', { timeout: 30000 }, async () => {
  const run = launchShell(['/bin/sleep', '2']);
  const pid = run.child.pid!;
  await pause(300);
  assert.ok(alive(pid), 'shell should be running before TERM');
  run.child.kill('SIGTERM');
  await pause(500);
  assert.ok(alive(pid), 'shell must survive a TERM that only interrupts wait');
  assert.equal(existsSync(run.exitPath), false, 'no exit file while the engine still runs');
  const record = await Promise.race([run.close.then(() => readRecord(run)), pause(8000).then(() => { throw new Error('shell did not finish after engine exit'); })]);
  assert.equal(record['code'], 0);
  assert.equal(record['signal'], null);
  assert.equal(existsSync(run.exitTmp), false, 'no .tmp residue');
});

test('consecutive TERMs still yield exactly one valid exit record', { timeout: 30000 }, async () => {
  const run = launchShell(['/bin/sleep', '1']);
  await pause(200);
  run.child.kill('SIGTERM');
  await pause(100);
  run.child.kill('SIGTERM');
  await pause(100);
  run.child.kill('SIGTERM');
  await run.close;
  const record = readRecord(run);
  assert.equal(record['code'], 0);
  assert.equal(typeof record['pid'], 'number');
  assert.match(String(record['at']), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(existsSync(run.exitTmp), false);
});

test('engine ignoring TERM keeps the shell waiting until KILL result is recorded', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(TMP, 'shell-'));
  const pidFile = join(dir, 'engine.pid');
  const engine = ['sh', '-c', `echo $$ > '${pidFile}'; trap '' TERM; sleep 30`];
  const run = launchShell(engine);
  await waitFor(() => existsSync(pidFile), 5000, 'engine did not start');
  const enginePid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(alive(enginePid));
  // TERM the shell: the no-op trap absorbs it, the engine ignores it too.
  run.child.kill('SIGTERM');
  await pause(400);
  assert.ok(alive(run.child.pid!), 'shell waits while the engine ignores TERM');
  assert.ok(alive(enginePid), 'engine ignored TERM');
  assert.equal(existsSync(run.exitPath), false);
  // Service escalates per killAfter: KILL the engine; the shell records it.
  process.kill(enginePid, 'SIGKILL');
  const end = await run.close;
  assert.equal(end.code, 137, 'shell exits with the recorded KILL status');
  const record = readRecord(run);
  assert.equal(record['code'], 137);
  assert.equal(record['pid'], enginePid);
});

test('stdin reaches the engine via 0<&0; control without the redirect starves', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(TMP, 'shell-'));
  const prompt = join(dir, 'prompt.txt');
  writeFileSync(prompt, 'PROMPT-BYTES-42\nsecond line\n');
  const run = launchShell(['/bin/cat'], { stdinFile: prompt });
  await run.close;
  assert.equal(readFileSync(run.logOut, 'utf8'), 'PROMPT-BYTES-42\nsecond line\n');
  const record = readRecord(run);
  assert.equal(record['code'], 0);

  // Control: identical shell without stdin anchoring leaves background stdin empty.
  const controlScript = FILE_SCOPE_SHELL_SCRIPT.replace('"$@" 0<&0 <&8 8<&- &', '"$@" &');
  assert.ok(!controlScript.includes('0<&0') && !controlScript.includes('<&8'));
  const cdir = mkdtempSync(join(TMP, 'shell-'));
  const cout = join(cdir, 'stdout.log');
  const cerr = join(cdir, 'stderr.log');
  const outFd = openSync(cout, 'w', 0o600);
  const errFd = openSync(cerr, 'w', 0o600);
  const inFd = openSync(prompt, 'r');
  const child = spawn(SH, ['-c', controlScript, 'sh', '/bin/cat'], {
    stdio: [inFd, outFd, errFd],
    env: { ...process.env, WEAVER_RUN_ID: 'control', WEAVER_RUN_NONCE: 'control', WEAVER_EXIT_FILE: join(cdir, 'e.json'), WEAVER_EXIT_TMP: join(cdir, 'e.tmp') },
  });
  closeSync(outFd);
  closeSync(errFd);
  closeSync(inFd);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('control cat did not exit')), 10000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.equal(readFileSync(cout, 'utf8'), '', 'without 0<&0 the background engine sees empty stdin');
});

test('natural exit writes code via atomic rename with no residue', { timeout: 30000 }, async () => {
  const run = launchShell(['sh', '-c', 'exit 7']);
  const end = await run.close;
  assert.equal(end.code, 7);
  const record = readRecord(run);
  assert.equal(record['code'], 7);
  assert.equal(existsSync(run.exitTmp), false);
});

test('cancel racing natural exit still records exactly one true exit', { timeout: 30000 }, async () => {
  for (let i = 0; i < 3; i++) {
    const run = launchShell(['sh', '-c', 'sleep 0.3; exit 3']);
    await pause(150);
    run.child.kill('SIGTERM');
    await run.close;
    const record = readRecord(run);
    assert.equal(record['code'], 3, `iteration ${i}: exit file must hold the real engine status`);
  }
});
