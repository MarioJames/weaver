import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalIPCError, failure } from '../../src/main/local-ipc';
import { parseCLI } from '../../src/cli/parse';
import { reconnectPolicy, withReconnect } from '../../src/cli/reconnect';
import { runCLI } from '../../src/cli/run';

const ok = (data: unknown) => ({ apiVersion: 'weaver.v1', ok: true, data });

interface Captured { code: number; stdout: string; stderr: string }
async function capture(argv: string[], runtime: Record<string, unknown> = {}): Promise<Captured> {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  try {
    process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    const code = await runCLI(argv, runtime as Parameters<typeof runCLI>[1]);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function clock() {
  let now = 100_000;
  const sleeps: number[] = [];
  const reports: string[] = [];
  return {
    runtime: {
      now: () => now,
      sleep: async (milliseconds: number) => { sleeps.push(milliseconds); now += milliseconds; },
      stderr: (text: string) => { reports.push(text); },
    },
    advance: (milliseconds: number) => { now += milliseconds; },
    sleeps,
    reports,
    now: () => now,
  };
}

test('a read survives APP_NOT_RUNNING, APP_DRAINING and one instance rotation before succeeding', async () => {
  const time = clock();
  let instance = 'a'.repeat(32);
  let attempts = 0;
  const result = await withReconnect({
    attempt: async () => {
      attempts++;
      if (attempts === 1) throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; run weaver server start');
      if (attempts === 2) return { response: failure('APP_DRAINING', 'Weaver is stopping'), instanceId: instance };
      if (attempts === 3) {
        const used = instance;
        instance = 'b'.repeat(32);
        return { response: failure('UNAUTHORIZED', 'Local authentication failed'), instanceId: used };
      }
      return { response: ok({ status: 'completed' }), instanceId: instance };
    },
    currentInstance: async () => instance,
  }, { graceMs: 60_000, maxIntervalMs: 5_000 }, { ...time.runtime, report: text => time.reports.push(text) });
  assert.deepEqual(result, ok({ status: 'completed' }));
  assert.equal(attempts, 4);
  assert.deepEqual(time.sleeps, [250, 500], 'only transport unavailability backs off; the auth retry is immediate');
  assert.equal(time.reports.length, 2);
  for (const report of time.reports) assert.match(report, /服务重启中，等待重连/);
});

test('every unavailability code retries, while non-retryable errors fail immediately', async () => {
  for (const code of ['APP_NOT_RUNNING', 'TRANSPORT_ERROR', 'APP_DRAINING', 'APP_STARTING']) {
    const time = clock();
    let attempts = 0;
    const result = await withReconnect({
      attempt: async () => {
        attempts++;
        if (attempts === 1) throw new LocalIPCError(code, code);
        return { response: ok({ status: 'running' }) };
      },
    }, { graceMs: 60_000, maxIntervalMs: 5_000 }, { ...time.runtime, report: () => {} });
    assert.deepEqual(result, ok({ status: 'running' }), code);
    assert.deepEqual(time.sleeps, [250], code);
  }
  for (const code of ['UNAUTHORIZED', 'POLICY_DENIED', 'CAPABILITY_UNAVAILABLE', 'INVALID_REQUEST', 'INVALID_RESPONSE', 'UNSAFE_ENDPOINT']) {
    const time = clock();
    let attempts = 0;
    const call = withReconnect({
      attempt: async () => {
        attempts++;
        return { response: failure(code, code) };
      },
    }, { graceMs: 60_000, maxIntervalMs: 5_000 }, { ...time.runtime, report: () => {} });
    if (code === 'UNAUTHORIZED') await assert.rejects(call, { code }, code);
    else assert.equal(((await call) as { error?: { code?: string } }).error?.code, code, code);
    assert.equal(attempts, 1, code);
    assert.deepEqual(time.sleeps, [], code);
  }
});

test('the grace budget bounds retries and the final error keeps the real code', async () => {
  const time = clock();
  let attempts = 0;
  await assert.rejects(withReconnect({
    attempt: async () => { attempts++; throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; run weaver server start'); },
  }, { graceMs: 1_000, maxIntervalMs: 5_000 }, { ...time.runtime, report: () => {} }), { code: 'APP_NOT_RUNNING' });
  assert.equal(attempts, 3);
  assert.deepEqual(time.sleeps, [250, 500, 250]);
  assert.equal(time.now(), 101_000);
});

test('instance rotation does not reset the unavailability budget', async () => {
  const time = clock();
  let instance = 'a'.repeat(32);
  let attempts = 0;
  await assert.rejects(withReconnect({
    attempt: async () => {
      attempts++;
      const used = instance;
      instance = (attempts % 2 ? 'b' : 'c').repeat(32);
      if (attempts === 1) throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; run weaver server start');
      return { response: failure('APP_STARTING', 'Weaver is starting'), instanceId: used };
    },
  }, { graceMs: 1_000, maxIntervalMs: 5_000 }, { ...time.runtime, report: () => {} }), { code: 'APP_STARTING' });
  assert.equal(attempts, 3, 'a changing instance id must not buy another full grace window');
  assert.deepEqual(time.sleeps, [250, 500, 250]);
  assert.equal(time.now(), 101_000);
});

test('consecutive UNAUTHORIZED fails immediately, including after the one rotation retry', async () => {
  let attempts = 0;
  await assert.rejects(withReconnect({
    attempt: async () => { attempts++; return { response: failure('UNAUTHORIZED', 'Local authentication failed'), instanceId: 'a'.repeat(32) }; },
    currentInstance: async () => 'a'.repeat(32),
  }, { graceMs: 60_000, maxIntervalMs: 5_000 }, { ...clock().runtime, report: () => {} }), { code: 'UNAUTHORIZED' });
  assert.equal(attempts, 1, 'the same instance must not retry');

  attempts = 0;
  let instance = 'a'.repeat(32);
  const time = clock();
  await assert.rejects(withReconnect({
    attempt: async () => {
      attempts++;
      if (attempts === 1) { instance = 'b'.repeat(32); return { response: failure('UNAUTHORIZED', 'Local authentication failed'), instanceId: 'a'.repeat(32) }; }
      return { response: failure('UNAUTHORIZED', 'Local authentication failed'), instanceId: instance };
    },
    currentInstance: async () => instance,
  }, { graceMs: 60_000, maxIntervalMs: 5_000 }, { ...time.runtime, report: () => {} }), { code: 'UNAUTHORIZED' });
  assert.equal(attempts, 2);
  assert.deepEqual(time.sleeps, [], 'auth retries never consume the unavailability backoff');
});

test('a read-only command writes reconnect progress to stderr and keeps stdout to one envelope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-reconnect-'));
  const time = clock();
  let attempts = 0;
  try {
    const result = await capture(['tasks', 'get', '--task-id', 'task', '--data-dir', directory], {
      ...time.runtime,
      request: async () => {
        attempts++;
        if (attempts === 1) throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; run weaver server start');
        return ok({ id: 'task', title: 'Fixture', status: 'completed' });
      },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim().split('\n').length, 1, 'stdout carries exactly one envelope');
    assert.equal(JSON.parse(result.stdout).data.status, 'completed');
    assert.match(time.reports.join('\n'), /等待重连/);
    assert.doesNotMatch(result.stdout, /等待重连/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('--reconnect-grace 0 and non-retryable responses keep the actual error code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-reconnect-'));
  try {
    const noGrace = await capture(['tasks', 'get', '--task-id', 'task', '--reconnect-grace', '0', '--data-dir', directory], {
      request: async () => { throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; run weaver server start'); },
    });
    assert.equal(noGrace.code, 1);
    assert.equal(JSON.parse(noGrace.stdout).error.code, 'APP_NOT_RUNNING');

    const unsafe = await capture(['tasks', 'get', '--task-id', 'task', '--data-dir', directory], {
      request: async () => { throw new LocalIPCError('UNSAFE_ENDPOINT', 'Endpoint file ownership, permissions, or size are unsafe'); },
    });
    assert.equal(unsafe.code, 1);
    assert.equal(JSON.parse(unsafe.stdout).error.code, 'UNSAFE_ENDPOINT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed run without run.finalizedAt keeps waiting and shows recovery pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-reconnect-'));
  const time = clock();
  const failed = {
    id: 'task', title: 'Fixture', status: 'failed',
    run: { id: 'run-1', status: 'stopping', launchPermittedAt: '2026-10-22T00:00:00.000Z', recovery: 'pending' },
    failure: { kind: 'other', message: 'stopped' },
  };
  try {
    const result = await capture(['tasks', 'wait', '--task-id', 'task', '--for', '2', '--data-dir', directory], {
      ...time.runtime,
      request: async (_directory: string, request: { command?: string }) => request.command === 'tasks.health' ? ok({ state: 'working' }) : ok(failed),
    });
    assert.equal(result.code, 1, 'the business terminal alone must not finish the wait');
    const response = JSON.parse(result.stdout);
    assert.equal(response.error.code, 'TIMEOUT');
    assert.equal(response.data.status, 'failed');
    assert.equal(response.data.reason, 'timeout');
    assert.equal(response.data.run.launchPermittedAt, failed.run.launchPermittedAt);
    assert.match(time.reports.join('\n'), /recovery pending/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('watch also keeps polling an unfinalized failed run, then reports terminal once finalized', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-reconnect-'));
  const time = clock();
  let gets = 0;
  try {
    const result = await capture(['tasks', 'watch', '--task-id', 'task', '--for', '5', '--data-dir', directory], {
      ...time.runtime,
      request: async (_directory: string, request: { command?: string }) => {
        if (request.command === 'tasks.events') return ok({ events: [], nextCursor: null, hasMore: false });
        if (request.command === 'tasks.health') return ok({ state: 'working' });
        gets++;
        if (gets < 3) return ok({ id: 'task', title: 'Fixture', status: 'failed', run: { id: 'run-1', launchPermittedAt: '2026-10-22T00:00:00.000Z' } });
        return ok({ id: 'task', title: 'Fixture', status: 'failed', run: { id: 'run-1', launchPermittedAt: '2026-10-22T00:00:00.000Z', finalizedAt: '2026-10-22T00:00:01.000Z' } });
      },
    });
    assert.equal(result.code, 0);
    assert.equal(gets, 3, 'the unfinalized failed snapshot did not finish the watch');
    assert.equal(JSON.parse(result.stdout).data.reason, 'terminal');
    assert.match(time.reports.join('\n'), /stopping/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a business-terminal run with run.finalizedAt returns terminal for the new lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-reconnect-'));
  try {
    for (const status of ['completed', 'failed', 'cancelled']) {
      const result = await capture(['tasks', 'wait', '--task-id', 'task', '--for', '2', '--data-dir', directory], {
        request: async () => ok({
          id: 'task', title: 'Fixture', status,
          run: { id: 'run-1', launchPermittedAt: '2026-10-22T00:00:00.000Z', finalizedAt: '2026-10-22T00:00:01.000Z' },
        }),
      });
      assert.equal(result.code, 0, status);
      assert.equal(JSON.parse(result.stdout).data.reason, 'terminal', status);
    }
    const legacy = await capture(['tasks', 'wait', '--task-id', 'task', '--for', '2', '--data-dir', directory], {
      request: async () => ok({ id: 'task', title: 'Fixture', status: 'failed', run: { id: 'run-1' } }),
    });
    assert.equal(legacy.code, 0, 'history without launchPermittedAt keeps the old terminal meaning');
    assert.equal(JSON.parse(legacy.stdout).data.reason, 'terminal');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('wait hands off a running native run with reason handoff, taskId and attemptId', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-reconnect-'));
  const next = { action: 'run_subagent', model: 'gpt-6.1-sol', effort: 'high', prompt: 'do the work', then: 'weaver workers complete --task-id task --input report.json' };
  const snapshot = {
    id: 'task', title: 'Fixture', status: 'running',
    dispatch: { execution: 'native' },
    run: { id: 'attempt-1', status: 'running', launchPermittedAt: '2026-10-22T00:00:00.000Z' },
    next,
  };
  let calls = 0;
  try {
    for (const format of ['json', 'text']) {
      const time = clock();
      const result = await capture(['tasks', 'wait', '--task-id', 'task', '--for', '5', '--output', format, '--data-dir', directory], {
        ...time.runtime,
        request: async () => { calls++; return ok(snapshot); },
      });
      assert.equal(result.code, 0, format);
      assert.deepEqual(time.sleeps, [], 'handoff returns before sleeping');
      if (format === 'json') {
        const data = JSON.parse(result.stdout).data;
        assert.equal(data.reason, 'handoff');
        assert.equal(data.taskId, 'task');
        assert.equal(data.attemptId, 'attempt-1');
        assert.deepEqual(data.next, next);
      } else {
        assert.match(result.stdout, /attempt-1/);
        assert.match(result.stdout, /do the work/);
      }
    }
    assert.equal(calls, 2, 'each wait read the identical instruction exactly once');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a running native run without a run_subagent next keeps waiting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wv-reconnect-'));
  const time = clock();
  try {
    const result = await capture(['tasks', 'wait', '--task-id', 'task', '--for', '1', '--data-dir', directory], {
      ...time.runtime,
      request: async (_directory: string, request: { command?: string }) => request.command === 'tasks.health'
        ? ok({ state: 'working' })
        : ok({ id: 'task', title: 'Fixture', status: 'running', dispatch: { execution: 'native' }, run: { id: 'attempt-1', launchPermittedAt: 'x' }, next: { action: 'wait', command: 'weaver tasks wait --task-id task' } }),
    });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'TIMEOUT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconnect flags parse only on read-only task commands and the environment supplies the default grace', () => {
  const parsed = parseCLI(['tasks', 'get', '--task-id', 'task', '--reconnect-grace', '0', '--reconnect-max-interval-s', '2']);
  assert.equal(parsed.reconnectGraceSeconds, 0);
  assert.equal(parsed.reconnectMaxIntervalSeconds, 2);
  const waiting = parseCLI(['tasks', 'wait', '--task-id', 'task', '--reconnect-grace', '5', '--reconnect-max-interval-s', '1']);
  assert.equal(waiting.reconnectGraceSeconds, 5);
  assert.equal(waiting.reconnectMaxIntervalSeconds, 1);
  assert.throws(() => parseCLI(['tasks', 'list', '--reconnect-grace', '5']), /only valid for tasks get/);
  assert.throws(() => parseCLI(['tasks', 'get', '--task-id', 'task', '--reconnect-grace', '-1']), /at least 0/);
  assert.throws(() => parseCLI(['tasks', 'get', '--task-id', 'task', '--reconnect-max-interval-s', '0']), /at least 1/);
  const previous = process.env.WEAVER_CLI_RECONNECT_GRACE_S;
  try {
    process.env.WEAVER_CLI_RECONNECT_GRACE_S = '7';
    assert.equal(reconnectPolicy({}).graceMs, 7_000);
    assert.equal(reconnectPolicy({ reconnectGraceSeconds: 0 }).graceMs, 0, 'the explicit flag wins');
  } finally {
    if (previous === undefined) delete process.env.WEAVER_CLI_RECONNECT_GRACE_S;
    else process.env.WEAVER_CLI_RECONNECT_GRACE_S = previous;
  }
});
