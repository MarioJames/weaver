import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sendRequest } from '../../src/cli/client';
import { TaskStore } from '../../src/main/store';
import { confirmScopeAbsent, inspectScope, killOwnedScope } from '../../src/main/adapters/cli/scope';

const enabled = process.env.WEAVER_WORKER_SCOPE_TEST === '1';
const TMP = mkdtempSync(join(tmpdir(), 'wv-detach-sigterm-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const REPO = process.cwd();

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(message);
    await pause(100);
  }
};

function writeFixture(dir: string, body: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'codex');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return bin;
}

async function command(dataDir: string, name: string, args: Record<string, unknown>): Promise<any> {
  const response = (await sendRequest(dataDir, { apiVersion: 'weaver.v1', command: name, commandId: randomUUID(), args })) as { ok: boolean; data: any };
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
}

async function taskView(dataDir: string, id: string): Promise<any> {
  return command(dataDir, 'tasks.get', { taskId: id });
}

interface ServiceProc {
  child: ChildProcess;
  url: Promise<string>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startService(dataDir: string, bin: string, savedPath: string | undefined): ServiceProc {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'web', '--no-open', '--port', '0', '--data-dir', dataDir], {
    cwd: REPO,
    env: { ...process.env, PATH: `${bin}:${savedPath ?? ''}`, WEAVER_RUN_UNIT_PREFIX: 'weaver-p1test-' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let resolveUrl!: (url: string) => void;
  const url = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    const timer = setTimeout(() => reject(new Error(`service never printed a ready URL: ${out.slice(-2000)}`)), 60000);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.stderr?.on('data', () => {
    /* drained to avoid backpressure; failures surface via exit code/timeout */
  });
  return { child, url, exited };
}

async function stopService(proc: ServiceProc, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }> {
  const start = Date.now();
  proc.child.kill('SIGTERM');
  const result = await proc.exited;
  return { ...result, elapsedMs: Date.now() - start };
}

async function listTestUnits(): Promise<string> {
  return new Promise(resolve => {
    execFile('systemctl', ['--user', 'list-units', '--all', '--no-legend', '--no-pager', 'weaver-p1test-*'], (error, stdout) => {
      resolve(error ? `ERROR: ${error.message}` : stdout.trim());
    });
  });
}

// Long enough to survive a service SIGTERM + restart, short enough for a bounded test.
const SIGTERM_BODY = [
  `printf '%s\\n' '{"type":"thread.started","thread_id":"sess-sigterm"}'`,
  `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"STARTED"}}'`,
  'sleep 25',
  `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}'`,
  'exit 0',
].join('\n');

test('SIGTERM with a running fixture worker exits the service fast, keeps the scope, and reattaches with one result', { skip: !enabled, timeout: 180000 }, async () => {
  mkdirSync(TMP, { recursive: true });
  const workspace = mkdtempSync(join(TMP, 'sig-ws-'));
  const bin = writeFixture(workspace, SIGTERM_BODY);
  const savedPath = process.env.PATH;
  const dataDir = mkdtempSync(join(TMP, 'sig-data-'));
  let first: ServiceProc | undefined;
  let second: ServiceProc | undefined;
  let unit = '';
  let invocation: string | undefined;
  try {
    first = startService(dataDir, bin, savedPath);
    await first.url;
    const created = await command(dataDir, 'tasks.create', {
      title: 'sigterm detach fixture',
      instruction: 'Write a bounded fixture stream only.',
      workspace,
      owner: { name: 'owner', transport: 'herdr-visible', session: 'main', pane: '1' },
    });
    const id: string = created.id;
    await command(dataDir, 'packages.create', { taskId: id, scope: ['fixture only'], acceptanceCriteria: ['fixture output'] });
    await command(dataDir, 'workers.spawn', { taskId: id, owner: 'claude_owner', worker: 'codex_worker' });
    await waitFor(async () => {
      const view = await taskView(dataDir, id);
      return view.status === 'running' && typeof view.run?.scopeInvocation === 'string';
    }, 30000, 'worker never recorded its invocation');
    const view = await taskView(dataDir, id);
    unit = view.run.scopeUnit;
    invocation = view.run.scopeInvocation;
    assert.ok(unit.startsWith('weaver-p1test-'), `test unit prefix: ${unit}`);
    assert.equal((await inspectScope(unit)).state, 'present');

    const stop = await stopService(first, 15000);
    first = undefined;
    assert.ok(stop.elapsedMs <= 15000, `service exited in ${stop.elapsedMs}ms (over 15s budget)`);
    assert.equal(stop.signal, null, `service was not killed by a signal: ${String(stop.signal)}`);
    assert.equal(stop.code, 0, 'service exited naturally with code 0');
    assert.equal((await inspectScope(unit)).state, 'present', 'worker scope survives the service SIGTERM');

    second = startService(dataDir, bin, savedPath);
    await second.url;
    await waitFor(async () => {
      const current = await taskView(dataDir, id);
      return current.status === 'completed' && typeof current.run?.finalizedAt === 'string';
    }, 90000, 'reattached worker never completed');
    const stored = new TaskStore(join(dataDir, 'weaver.db'));
    try {
      const task = stored.get(id);
      assert.equal(task.events.filter(value => value.kind === 'result').length, 1, 'result exactly once');
      assert.equal(task.run?.finalizedAt !== undefined, true);
    } finally {
      stored.close();
    }
    await waitFor(async () => (await confirmScopeAbsent(unit)) === true, 30000, `scope leaked: ${unit}`);
  } finally {
    if (first) {
      try {
        first.child.kill('SIGTERM');
        await first.exited;
      } catch { /* best effort */ }
      first = undefined;
    }
    if (second) {
      try {
        second.child.kill('SIGTERM');
        await Promise.race([second.exited, pause(15000)]);
        if (second.child.exitCode === null && second.child.signalCode === null) second.child.kill('SIGKILL');
        await Promise.race([second.exited, pause(5000)]);
      } catch { /* best effort */ }
      second = undefined;
    }
    if (unit) {
      try {
        const inspection = await inspectScope(unit);
        if (inspection.state === 'present' && invocation) await killOwnedScope(unit, invocation, 'SIGKILL');
        else if (inspection.state === 'present') await new Promise<void>(resolve => execFile('systemctl', ['--user', 'stop', `${unit}.scope`], () => resolve()));
      } catch { /* best effort */ }
    }
    const residue = await listTestUnits();
    assert.equal(residue, '', `zero weaver-p1test-* residue, got: ${residue.slice(0, 500)}`);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
