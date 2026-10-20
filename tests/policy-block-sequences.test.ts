import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unblockEngine } from '../src/main/application/engines/unblock';
import { FreeChannelProbeMonitor } from '../src/main/free-channel';
import { CommandHandler } from '../src/main/commands';
import { TaskManager } from '../src/main/manager';
import { PolicyBlockService } from '../src/main/policy/blocks';
import { applyQuotaSnapshot } from '../src/main/policy/quota';
import { defaultConfig } from '../src/main/policy/routing';
import { PolicyStore } from '../src/main/policy/store';
import { StallMonitor } from '../src/main/stall';
import { TaskStore } from '../src/main/store';
import type { Block } from '../src/shared/contracts/policy';
import type { Task } from '../src/shared/contracts/tasks';
import { engineDiagnostics } from './helpers/diagnostics';
import { freeStoreAt, stallStoreAt, vendorLadderAt } from './helpers/state-db';
import { DISPATCH_FAILURES, FREE_FOREIGN, FREE_QUOTA, FREE_RATE_LIMIT, FREE_STALL, QUOTA_SEQUENCE, STALL_FAIL_LADDER, STALL_PASS_LIFT } from './policy-block-sequences.golden';

// Input sequences with fixed clocks. For each step where anything changed they pin the block list, the policy
// revision and the number of re-route notifications, so a change in how blocks are written, retried or announced
// shows up here before it shows up in production. The expected rows were recorded from the monitors before the
// block writes moved behind PolicyBlockService, and the full persisted state was compared step by step at that point.

const MINUTE = 60_000;
const START = Date.parse('2030-01-01T00:00:00Z');
/** step, policy revision, re-route notifications so far, blocks as engine/worker/model/source/release. */
type Row = [string, number, number | null, string];
const blocksOf = (blocks: Block[]) => blocks.map(b => [b.engine, b.worker ?? '', b.model ?? '', (b.by ?? '').replace('weaver-', ''), b.release_at ? b.release_at.slice(11, 16) : ''].join('/')).join('|');
/** Appends a row whenever the observable result differs from the previous step's. */
function recorder(policy: PolicyStore, pumps: () => number | null) {
  const rows: Row[] = [];
  let last = '';
  return {
    rows,
    at: (step: string, extra = '') => {
      const snapshot = policy.snapshot();
      const row: Row = [step, snapshot.revision, pumps(), blocksOf(snapshot.blocks)];
      const text = JSON.stringify(row.slice(1)) + extra;
      if (text !== last) { last = text; rows.push(row); }
    },
  };
}

const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'wv-sequence-')); dirs.push(dir); return dir; };
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function stalledTask(engine: string, scope: string): Task {
  const at = new Date(START - 20 * MINUTE).toISOString();
  return {
    id: `task-${scope}`, title: 'package', instruction: 'work', owner: { name: 'owner', transport: 'herdr-visible', session: 's', pane: 'p' },
    createdAt: at, updatedAt: at, status: 'running', progress: 0,
    events: [{ id: `e-${scope}`, at, kind: 'lifecycle', message: 'started' }], artifacts: [],
    dispatch: { owner: `${engine}_owner`, worker: `${engine}_worker`, engine, model: 'm', effort: 'high', execution: 'real', maxParallel: 2 },
    run: { id: `run-${scope}`, adapter: engine, execution: 'real', status: 'running', startedAt: at, firstOutputAt: at, scopeUnit: scope },
  } as Task;
}

async function stallSequence(answers: ('pass' | 'fail')[], withManual: boolean): Promise<Row[]> {
  const dir = scratch();
  let now = START;
  const config = defaultConfig();
  config.engines.codex.enabled = true;
  const policy = new PolicyStore(join(dir, 'weaver.db'), () => now);
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config, blocks: base.blocks });
  const tasks = [stalledTask('claude', 'w-a'), stalledTask('claude', 'w-b')];
  let pumps = 0;
  let call = 0;
  const monitor = new StallMonitor({
    tasks: () => tasks, policy: () => policy, stateStore: stallStoreAt(join(dir, 'state.db')), cpu: async () => 0,
    probe: async () => (answers[call++] ?? 'pass') === 'pass' ? { ok: true, ms: 10 } : { ok: false, ms: 20, error: '进程退出码 1，没有回复。' },
    now: () => now, ready: () => true, onBlocksChanged: () => { pumps += 1; }, log: () => {},
  });
  const record = recorder(policy, () => pumps);
  for (let index = 1; index <= 90; index += 1) {
    now += MINUTE;
    await monitor.tick();
    record.at(`t${index}`, JSON.stringify(monitor.status().engines.claude));
    if (withManual && index === 20) {
      const snapshot = policy.snapshot();
      policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [...snapshot.blocks, { engine: 'codex', reason: '人工暂停', since: new Date(now).toISOString(), by: 'user' }, { engine: 'claude', model: 'sonnet', reason: 'model pause', since: new Date(now).toISOString(), by: 'user' }] });
      record.at('manual blocks');
    }
    if (withManual && index === 70) {
      unblockEngine({ blocks: new PolicyBlockService(() => policy, { onChanged: () => { pumps += 1; } }), stall: monitor }, 'claude');
      record.at('after unblock', JSON.stringify(monitor.status().engines.claude));
    }
  }
  await monitor.stop();
  return record.rows;
}

const answer = (kind: string) => {
  if (kind === 'quota_reset') return { ok: false, ms: 10, error: 'FreeUsageLimitError: free quota used up, retry after 30m' };
  if (kind === 'quota_plain') return { ok: false, ms: 10, error: 'FreeUsageLimitError: free quota used up' };
  if (kind === 'rate_limit') return { ok: false, ms: 10, error: '429 too many requests, retry after 5 minutes' };
  if (kind === 'auth') return { ok: false, ms: 10, error: '401 authentication failed' };
  return { ok: true, ms: 42 };
};

async function freeSequence(scripts: Record<string, string[]>, ticks: number, edits: Record<number, (policy: PolicyStore, now: number) => void> = {}): Promise<Row[]> {
  const dir = scratch();
  let now = START;
  const config = defaultConfig();
  config.engines.qoder.enabled = true;
  config.engines.opencode.enabled = true;
  config.workers.qoder_worker.enabled = true;
  config.workers.opencode_worker.enabled = true;
  config.workers.qoder_paid_worker = { engine: 'qoder', model: 'paid-model', effort: 'auto', enabled: true };
  const policy = new PolicyStore(join(dir, 'weaver.db'), () => now);
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config, blocks: base.blocks }, { allowEngineEnable: true });
  let pumps = 0;
  const queues = structuredClone(scripts);
  const monitor = new FreeChannelProbeMonitor({
    policy: () => policy, stateStore: freeStoreAt(join(dir, 'state.db')), vendorLadder: vendorLadderAt(join(dir, 'state.db')),
    probe: async route => answer(queues[route.worker]?.shift() ?? 'pass'),
    now: () => now, ready: () => true, onBlocksChanged: () => { pumps += 1; }, log: () => {},
  });
  monitor.start();
  const record = recorder(policy, () => pumps);
  for (let index = 1; index <= ticks; index += 1) {
    now += MINUTE;
    await monitor.tick();
    record.at(`t${index}`);
    if (edits[index]) { edits[index]!(policy, now); record.at(`e${index}`); }
  }
  await monitor.stop();
  return record.rows;
}

async function dispatchFailures(): Promise<Row[]> {
  const dir = scratch();
  const store = new TaskStore(join(dir, 'weaver.db'));
  const children: EventEmitter[] = [];
  const manager = new TaskManager(store, { id: 'fixture', canLaunchReal: () => true, start() { const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); children.push(child); return child; } });
  const policy = new PolicyStore(store.db);
  const snapshot = policy.snapshot();
  const config = snapshot.config;
  config.workers.codexb_worker = { ...config.workers.codex_worker!, model: 'gpt-b' };
  config.workers.opencode_worker!.enabled = true;
  config.engines.opencode!.enabled = true;
  config.owners.claude_owner!.workers = ['codex_worker', 'codexb_worker', 'opencode_worker'];
  config.owners.claude_owner!.max_parallel = 10;
  policy.save({ revision: snapshot.revision, config, blocks: [] }, { allowEngineEnable: true });
  const handler = new CommandHandler(manager, policy, () => { throw new Error('no owner launch'); }, () => false);
  const realNow = Date.now;
  let clock = START;
  Date.now = () => clock;
  const record = recorder(policy, () => null);
  try {
    let count = 0;
    const fail = async (worker: string | undefined, engine: string, failure: NonNullable<Task['failure']>) => {
      const task = manager.create({ title: `t${count++}`, instruction: 'fake', workspace: dir, owner: { name: 'o', transport: 'herdr-visible', session: 's', pane: 'p' } });
      task.status = 'failed';
      task.dispatch = { engine, execution: 'real', owner: 'claude_owner', worker: worker ?? 'ghost', model: 'fake', effort: 'high', maxParallel: 2 };
      task.failure = failure;
      store.put(task);
      handler.pump();
      await new Promise<void>(resolve => setImmediate(resolve));
      record.at(`${engine}/${worker} ${failure.kind}`, JSON.stringify(store.listVendorLimits()));
    };
    const rate = { kind: 'rate_limit', message: '429 too many requests' } as const;
    await fail('codex_worker', 'codex', rate);
    clock += 5 * MINUTE;
    await fail('codex_worker', 'codex', rate);
    await fail('codexb_worker', 'codex', rate);
    await fail('opencode_worker', 'opencode', rate);
    clock += 10 * MINUTE;
    await fail('codex_worker', 'codex', { kind: 'quota', message: 'FreeUsageLimitError', retryAt: new Date(clock + 90 * MINUTE).toISOString() });
    await fail(undefined, 'claude', rate);
    await fail(undefined, 'claude', rate);
    clock += 3 * 60 * MINUTE;
    await fail('codex_worker', 'codex', rate);
    await fail('codex_worker', 'codex', rate);
    const monitor = new StallMonitor({ tasks: () => [], policy: () => policy, stateStore: stallStoreAt(join(dir, 'state.db')), cpu: async () => null, log: () => {} });
    const unblocker = new CommandHandler(manager, policy, () => { throw new Error('no owner launch'); }, () => false, engineDiagnostics(policy, monitor));
    assert.equal(unblocker.handle({ apiVersion: 'weaver.v1', commandId: 'unblock-1', command: 'engines.unblock', args: { engine: 'codex' } }).ok, true);
    record.at('unblock codex', JSON.stringify(store.listVendorLimits()));
    await fail('codex_worker', 'codex', rate);
    unblocker.draining = true;
  } finally {
    Date.now = realNow;
    handler.draining = true;
    for (const child of children) child.emit('close', 0, null);
    await manager.shutdown();
  }
  return record.rows;
}

function quotaSequence(): Row[] {
  const dir = scratch();
  const policy = new PolicyStore(join(dir, 'weaver.db'), () => START);
  const base = policy.snapshot();
  base.config.engines.codex!.enabled = true;
  base.config.engines.codex!.quota_refresh = true;
  policy.save({ revision: base.revision, config: base.config, blocks: [{ engine: 'claude', reason: 'manual', since: new Date(START).toISOString(), by: 'user' }] }, { allowEngineEnable: true });
  const record = recorder(policy, () => null);
  const observation = (status: string, resetsAt: string | null) => ({
    engine: 'codex', status, stale: false, checkedAt: new Date(START).toISOString(), observedAt: new Date(START).toISOString(), statusBasis: 'windows',
    windows: [{ scope: 'account', usedPercent: status === 'exhausted' ? 100 : 10, resetsAt, remaining: null, total: null, used: null }],
  });
  const apply = (label: string, status: string, resetsAt: string | null = null) => {
    const result = applyQuotaSnapshot(policy, { records: [observation(status, resetsAt)] } as never, {}, START);
    record.at(`${label} changed=${result.policyChanged}`, String(result.policyChanged));
  };
  apply('exhausted-no-reset', 'exhausted');
  apply('exhausted-same', 'exhausted');
  apply('exhausted-reset', 'exhausted', new Date(START + 3 * 3600_000).toISOString());
  apply('available', 'available');
  apply('available-again', 'available');
  return record.rows;
}

const SEQUENCES: Record<string, () => Promise<Row[]> | Row[]> = {
  STALL_FAIL_LADDER: () => stallSequence(['fail', 'fail', 'fail', 'fail', 'pass', 'pass', 'pass', 'pass'], true),
  STALL_PASS_LIFT: () => stallSequence(['pass'], false),
  FREE_QUOTA: () => freeSequence({ qoder_worker: ['quota_reset'], opencode_worker: ['quota_plain', 'quota_plain', 'pass'] }, 120),
  FREE_RATE_LIMIT: () => freeSequence({ qoder_worker: ['rate_limit', 'pass', 'rate_limit', 'rate_limit', 'pass'], opencode_worker: ['rate_limit', 'rate_limit', 'rate_limit', 'rate_limit', 'pass'] }, 200),
  FREE_STALL: () => freeSequence({ qoder_worker: ['auth', 'auth', 'auth', 'pass', 'pass', 'pass'], opencode_worker: ['auth', 'pass'] }, 120, {
    60: policy => { const s = policy.snapshot(); policy.save({ revision: s.revision, config: s.config, blocks: s.blocks.filter(b => b.engine !== 'opencode') }); },
  }),
  FREE_FOREIGN: () => freeSequence({ qoder_worker: ['quota_plain', 'quota_plain', 'auth'] }, 60, {
    12: (policy, now) => { const s = policy.snapshot(); policy.save({ revision: s.revision, config: s.config, blocks: [...s.blocks.filter(b => b.by !== 'weaver-free-probe'), { engine: 'qoder', model: 'Qwen3.8-Flash', reason: '人工暂停', since: new Date(now).toISOString(), by: 'manual' }] }); },
  }),
  DISPATCH_FAILURES: dispatchFailures,
  QUOTA_SEQUENCE: quotaSequence,
};
const GOLDEN: Record<string, Row[]> = { DISPATCH_FAILURES, FREE_FOREIGN, FREE_QUOTA, FREE_RATE_LIMIT, FREE_STALL, QUOTA_SEQUENCE, STALL_FAIL_LADDER, STALL_PASS_LIFT };

const TITLES: Record<string, string> = {
  STALL_FAIL_LADDER: 'stall ladder: blocks, revisions and re-route notifications for failing probes, manual blocks and a user unblock',
  STALL_PASS_LIFT: 'stall ladder: one passing probe lifts level 1 and nothing else is written afterwards',
  FREE_QUOTA: 'free channel: quota bans are held until the vendor reset time or lifted by a pass',
  FREE_RATE_LIMIT: 'free channel: rate limits walk the vendor ladder per worker and take the engine out when no worker is left',
  FREE_STALL: 'free channel: auth failures walk the stall ladder and a hand edit resets the question',
  FREE_FOREIGN: 'free channel: a foreign block on the route is never replaced',
  DISPATCH_FAILURES: 'dispatch failures: worker ladder, engine escalation, retry-time precedence, ladder reset and a user unblock',
  QUOTA_SEQUENCE: 'quota observations: the own block follows the observation, a foreign block stays, an unchanged policy is not saved',
};
for (const [name, run] of Object.entries(SEQUENCES)) {
  test(TITLES[name]!, async () => { assert.deepEqual(await run(), GOLDEN[name]); });
}
