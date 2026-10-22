import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultConfig } from '../../src/main/policy/routing';
import { PolicyStore } from '../../src/main/policy/store';
import { STALL_BLOCK_BY } from '../../src/shared/policy/blocks';
import { isStalled, StallMonitor } from '../../src/main/stall';
import { type ProcessSnapshot } from '../../src/main/monitors/process-tree';
import type { CpuSample } from '../../src/main/monitors/cpu';
import type { Task } from '../../src/shared/contracts/tasks';
import { stallStoreAt } from '../helpers/state-db';

const START = Date.parse('2030-01-01T00:00:00Z');
const MINUTE = 60_000;
const dirs = new Set<string>();
after(() => Promise.all([...dirs].map(dir => rm(dir, { recursive: true, force: true }))));

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wv-command-health-'));
  dirs.add(dir);
  return dir;
}

function task(options: { silentMs?: number; pid?: number; firstOutputAt?: boolean } = {}): Task {
  const id = randomUUID();
  const at = new Date(START - (options.silentMs ?? 0)).toISOString();
  return {
    id, title: 'command', instruction: 'work', owner: { name: 'owner', transport: 'herdr-visible', session: 's', pane: 'p' },
    createdAt: at, updatedAt: at, status: 'running', progress: 0,
    events: [{ id: randomUUID(), at, kind: 'lifecycle', message: 'started' }], artifacts: [],
    dispatch: { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'm', effort: 'high', execution: 'real', maxParallel: 2 },
    run: { id: randomUUID(), adapter: 'opencode', execution: 'real', status: 'running', startedAt: at, ...(options.firstOutputAt === false ? {} : { firstOutputAt: at }), scopeUnit: 'weaver-cli-command-test', pid: options.pid ?? 900 },
  };
}

const proc = (pid: number, ppid: number, argv: string[], startMs: number): ProcessSnapshot => ({ pid, ppid, argv, state: 'S', utime: 0, stime: 0, startTicks: 0, startedAtMs: startMs });

function table(commandStart: number | null): ProcessSnapshot[] {
  const rows = [
    proc(900, 1, ['systemd-run', '--user', '--scope', '--unit=weaver-cli-command-test', '--', 'node', 'vendor.js'], commandStart ?? START),
    proc(901, 900, ['node', '/opt/vendor.js'], commandStart ?? START),
    proc(902, 901, ['bash', '-c', 'pnpm build'], commandStart ?? START),
    proc(903, 902, ['node', '/repo/node_modules/.bin/pnpm', 'build'], commandStart ?? START),
    proc(904, 901, ['node', '/opt/mcp-server.js'], commandStart ?? START),
  ];
  return commandStart === null ? rows.filter(row => row.pid < 902) : rows;
}

async function monitor(options: { commandStart: number | null; now?: () => number; configure?: (config: ReturnType<typeof defaultConfig>) => void; tasks?: Task[]; utime?: () => number }) {
  const dir = await workspace();
  const config = defaultConfig();
  options.configure?.(config);
  const policy = new PolicyStore(join(dir, 'weaver.db'), () => START);
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config, blocks: base.blocks });
  let now = START;
  const clock = options.now ?? (() => now);
  const monitor = new StallMonitor({
    tasks: () => options.tasks ?? [],
    policy: () => policy,
    stateStore: stallStoreAt(join(dir, 'state.db')),
    cpu: async () => 0,
    processes: () => { const ticks = options.utime?.() ?? 0; return table(options.commandStart).map(row => ({ ...row, utime: ticks })); },
    now: clock,
    log: () => {},
  });
  return {
    dir, policy, monitor, optionsTasks: options.tasks ?? [],
    advance: async (minutes: number) => { for (let index = 0; index < minutes; index += 1) { now += MINUTE; await monitor.tick(); } },
  };
}

const idleSamples = (count: number): CpuSample[] => Array.from({ length: count }, (_, index) => ({ at: START + index * MINUTE, cpu: 0 }));

test('a live command keeps health at running_command with a bounded command summary and age', async () => {
  const h = await monitor({ commandStart: START + 2 * MINUTE });
  try {
    const health = h.monitor.taskHealth(task({ silentMs: 20 * MINUTE }));
    assert.equal(health.state, 'running_command');
    assert.equal(health.reason, undefined);
    assert.equal(health.runningCommand?.pid, 903);
    assert.match(health.runningCommand!.summary, /pnpm build$/);
    assert.doesNotMatch(health.runningCommand!.summary, /mcp-server/);
    assert.equal(health.runningCommand!.elapsedMs, 0, 'a command started after the clock reads as new, never negative');
  } finally { await h.monitor.stop(); await rm(h.dir, { recursive: true, force: true }); }
});

test('a live command blocks the stall verdict; removing it restores silence plus idle-only stalling', async () => {
  const h = await monitor({ commandStart: START });
  try {
    const running = task({ silentMs: 20 * MINUTE });
    await h.advance(8);
    assert.equal(h.policy.snapshot().blocks.filter(block => block.by === STALL_BLOCK_BY).length, 0, 'a command outranks five idle minutes');
    assert.equal(h.monitor.taskHealth(running).state, 'running_command');
  } finally { await h.monitor.stop(); await rm(h.dir, { recursive: true, force: true }); }

  const quiet = await monitor({ commandStart: null, tasks: [task({ silentMs: 20 * MINUTE }), task({ silentMs: 20 * MINUTE })] });
  try {
    await quiet.advance(6);
    assert.equal(quiet.policy.snapshot().blocks.filter(block => block.by === STALL_BLOCK_BY).length, 1, 'no command, long silence and idle CPU still stall');
  } finally { await quiet.monitor.stop(); await rm(quiet.dir, { recursive: true, force: true }); }
});

test('a command past max_command_minutes is stalled with command_timeout, and the summary is named', async () => {
  const h = await monitor({ commandStart: START - 31 * MINUTE });
  try {
    const health = h.monitor.taskHealth(task({ silentMs: MINUTE }));
    assert.equal(health.state, 'stalled');
    assert.equal(health.reason, 'command_timeout');
    assert.match(health.runningCommand!.summary, /pnpm build$/);
    assert.equal(health.runningCommand!.elapsedMs, 31 * MINUTE);
  } finally { await h.monitor.stop(); await rm(h.dir, { recursive: true, force: true }); }

  const custom = await monitor({ commandStart: START - 2 * MINUTE, configure: config => { config.herdr.max_command_minutes = 1; } });
  try {
    const health = custom.monitor.taskHealth(task({ silentMs: MINUTE }));
    assert.equal(health.state, 'stalled');
    assert.equal(health.reason, 'command_timeout');
  } finally { await custom.monitor.stop(); await rm(custom.dir, { recursive: true, force: true }); }
});


test('CPU from the process tree outranks an idle scope, so an escaped build is never called stalled', async () => {
  let busy = true;
  let ticks = 0;
  const h = await monitor({
    commandStart: null,
    tasks: [task({ silentMs: 20 * MINUTE }), task({ silentMs: 20 * MINUTE })],
    utime: () => { if (busy) ticks += 200; return ticks; },
  });
  try {
    await h.advance(6);
    assert.equal(h.monitor.taskHealth(h.optionsTasks[0]!).cpuActive, true, 'the tree, not just the scope, proves work');
    assert.equal(h.policy.snapshot().blocks.filter(block => block.by === STALL_BLOCK_BY).length, 0);
    busy = false;
    await h.advance(6);
    assert.equal(h.policy.snapshot().blocks.filter(block => block.by === STALL_BLOCK_BY).length, 1, 'after the tree goes idle the same silence stalls');
  } finally { await h.monitor.stop(); await rm(h.dir, { recursive: true, force: true }); }
});

test('the stall classifier prefers a timed-out command over silence, and a live command over idle samples', () => {
  const running = task();
  const live = idleSamples(8);
  live[live.length - 1] = { ...live[live.length - 1]!, command: { pid: 1, summary: 'sleep 60', startedAt: new Date(START).toISOString(), elapsedMs: MINUTE } };
  assert.equal(isStalled(running, START + 8 * MINUTE, { [running.id]: live }), false);
  const timedOut = live.map((sample, index) => index === live.length - 1 ? { ...sample, commandTimedOut: true } : sample);
  assert.equal(isStalled(running, START + 8 * MINUTE, { [running.id]: timedOut }), true);
});
