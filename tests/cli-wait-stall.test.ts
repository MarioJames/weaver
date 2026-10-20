import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalIPC } from '../src/main/local-ipc';
import { CLI_CATALOG, CLI_HELP } from '../src/cli/catalog';
import { runCLI } from '../src/cli/run';

const ok = (data: unknown) => ({ apiVersion: 'weaver.v1', ok: true, data });
const task = { id: 'task', title: 'Fixture', status: 'running', revision: 3 };
const stalled = { taskId: 'task', state: 'stalled', engine: 'codex', silenceMs: 360_000, cpuIdleMs: 330_000, cpuActive: false };

// Exercise identical polling contracts with both a deterministic request boundary and
// the production Unix-socket transport. Only explicit polling sleeps advance time;
// discovery IO and socket scheduling cannot consume the simulated deadline.
for (const transport of ['injected', 'unix'] as const) {
  describe(transport, () => {
    async function poll(handle: (request: any, now: number) => unknown, args: string[] = []) {
      const directory = await mkdtemp(join(tmpdir(), 'ipc-'));
      let app: Awaited<ReturnType<typeof startLocalIPC>> | undefined;
      const original = process.stdout.write;
      let output = '';
      let now = 100_000;
      try {
        if (transport === 'unix') app = await startLocalIPC(directory, request => handle(request, now));
        process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
        const code = await runCLI(['tasks', ...args, '--task-id', 'task', '--data-dir', directory], {
          now: () => now,
          sleep: async milliseconds => { now += milliseconds; },
          ...(transport === 'injected' ? { request: async (_directory: string, request: unknown) => handle(request, now) } : {}),
        });
        return { code, output };
      } finally {
        process.stdout.write = original;
        await app?.close();
        await rm(directory, { recursive: true, force: true });
      }
    }

    test('wait returns a stalled snapshot with health and recovery hint in JSON and text', async () => {
      for (const format of ['json', 'text']) {
        const result = await poll(request => request.command === 'tasks.health' ? ok(stalled) : ok(task), ['wait', '--for', '2', '--output', format]);
        assert.equal(result.code, 0);
        if (format === 'json') {
          const response = JSON.parse(result.output);
          assert.equal(response.ok, true);
          assert.equal(response.data.id, task.id);
          assert.equal(response.data.status, 'running');
          assert.equal(response.data.revision, 3);
          assert.equal(response.data.reason, 'stalled');
          assert.deepEqual(response.data.health, stalled);
          assert.match(response.data.hint, /weaver tasks retry --task-id task --cancel/);
        } else {
          assert.match(result.output, /stalled/);
          assert.match(result.output, /cpuIdleMs=330000/);
          assert.match(result.output, /cpuActive=false/);
          assert.match(result.output, /engine=codex/);
          assert.match(result.output, /weaver tasks retry --task-id task --cancel/);
        }
      }
    });

    test('wait checks health every 30 seconds and exits when it becomes stalled', async () => {
      const checks: number[] = [];
      const result = await poll((request, now) => {
        if (request.command !== 'tasks.health') return ok(task);
        checks.push(now);
        return ok({ ...stalled, state: checks.length < 3 ? 'waiting_model' : 'stalled' });
      }, ['wait', '--for', '65']);
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.output).data.reason, 'stalled');
      assert.equal(checks.length, 3);
      for (let i = 1; i < checks.length; i++) assert.ok(checks[i] - checks[i - 1] >= 30_000 && checks[i] - checks[i - 1] <= 30_500);
    });

    test('terminal snapshots take priority over health and retain all existing fields', async () => {
      for (const status of ['completed', 'failed', 'cancelled']) {
        const result = await poll(request => {
          assert.equal(request.command, 'tasks.get');
          return ok({ ...task, status });
        }, ['wait', '--for', '2']);
        assert.equal(result.code, 0);
        assert.deepEqual(JSON.parse(result.output).data, { ...task, status, reason: 'terminal' });
      }
    });

    test('wait checks health again before a short timeout, allowing a late stall to win', async () => {
      let checks = 0;
      const result = await poll(request => request.command === 'tasks.health'
        ? ok({ ...stalled, state: ++checks === 1 ? 'starting' : 'stalled' }) : ok(task), ['wait', '--for', '2']);
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.output).data.reason, 'stalled');
      assert.equal(checks, 2);
    });

    test('timeout retains TIMEOUT and exit 1 while adding the last snapshot and reason', async () => {
      let checks = 0;
      const result = await poll(request => {
        if (request.command === 'tasks.health') { checks++; return ok({ ...stalled, state: 'working' }); }
        return ok(task);
      }, ['wait', '--for', '2']);
      assert.equal(result.code, 1);
      const response = JSON.parse(result.output);
      assert.equal(response.error.code, 'TIMEOUT');
      assert.equal(response.data.id, task.id);
      assert.equal(response.data.reason, 'timeout');
      assert.equal(checks, 2);
    });

    test('older servers silently disable unsupported health checks', async () => {
      for (const error of [{ code: 'COMMAND_UNKNOWN', message: 'Unknown logical command' }, { code: 'INVALID_REQUEST', message: 'Unknown method' }]) {
        let checks = 0;
        let gets = 0;
        const result = await poll(request => {
          if (request.command === 'tasks.health') { checks++; return { apiVersion: 'weaver.v1', ok: false, error }; }
          return ok({ ...task, status: ++gets > 2 ? 'completed' : 'running' });
        }, ['wait', '--for', '2']);
        assert.equal(result.code, 0);
        assert.equal(checks, 1);
        assert.equal(JSON.parse(result.output).data.reason, 'terminal');
        assert.doesNotMatch(result.output, /Unknown/);
      }
    });

    test('health failures other than unknown method remain visible', async () => {
      const result = await poll(request => request.command === 'tasks.health'
        ? { apiVersion: 'weaver.v1', ok: false, error: { code: 'PERSISTENCE_ERROR', message: 'Cannot read health' } }
        : ok(task), ['wait', '--for', '2']);
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.output).error.code, 'PERSISTENCE_ERROR');
    });

    test('watch emits one stalled transition and continues through terminal events', async () => {
      for (const format of ['text', 'jsonl']) {
        let gets = 0;
        const result = await poll(request => {
          if (request.command === 'tasks.health') return ok(stalled);
          if (request.command === 'tasks.events') return ok({ events: gets === 3 ? [{ id: 'done', kind: 'result', message: 'finished-after-stall' }] : [] });
          return ok({ ...task, status: ++gets >= 3 ? 'completed' : 'running' });
        }, ['watch', '--for', '2', '--output', format]);
        assert.equal(result.code, 0);
        assert.ok(gets >= 3);
        assert.match(result.output, /finished-after-stall/);
        if (format === 'text') assert.equal(result.output.match(/stalled/g)?.length, 1);
        else {
          const lines = result.output.trim().split('\n').map(line => JSON.parse(line));
          assert.equal(lines.filter(line => line.data.reason === 'stalled').length, 1);
          assert.equal(lines.at(-1).data.reason, 'terminal');
        }
      }
    });

    test('watch suppresses repeated stalled notices and reports a new stall after recovery', async () => {
      for (const recovers of [false, true]) {
        let checks = 0;
        const result = await poll(request => {
          if (request.command === 'tasks.health') return ok({ ...stalled, state: ++checks === 2 && recovers ? 'working' : 'stalled' });
          if (request.command === 'tasks.events') return ok({ events: [] });
          return ok({ ...task, status: checks >= 3 ? 'completed' : 'running' });
        }, ['watch', '--for', '65', '--output', 'text']);
        assert.equal(result.code, 0);
        assert.equal(checks, 3);
        assert.equal(result.output.match(/stalled/g)?.length, recovers ? 2 : 1);
        assert.match(result.output, /completed/);
      }
    });

    test('help and catalog explain stalled wait and continuing watch', () => {
      assert.match(CLI_HELP, /stalled/);
      assert.match(CLI_CATALOG.find(item => item.command === 'tasks.wait')!.usage, /stalled/);
      assert.match(CLI_CATALOG.find(item => item.command === 'tasks.watch')!.usage, /stalled/);
    });
  });
}
