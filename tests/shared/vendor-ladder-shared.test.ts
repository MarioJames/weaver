import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandHandler } from '../../src/main/commands';
import { FreeChannelProbeMonitor } from '../../src/main/free-channel';
import { TaskManager } from '../../src/main/manager';
import { defaultConfig } from '../../src/main/policy/routing';
import { PolicyStore } from '../../src/main/policy/store';
import { dbFreeProbeStore } from '../../src/main/storage/free-probe-state';
import { dbVendorLadder } from '../../src/main/storage/vendor-limits';
import { TaskStore } from '../../src/main/store';
import type { Task } from '../../src/shared/contracts/tasks';

const MINUTE = 60_000;
const START = Date.parse('2030-01-01T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** One database for the task store, the policy, the probe state and the ladder, the way the runtime wires them. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wv-vendor-ladder-'));
  let clock = START;
  const realNow = Date.now;
  Date.now = () => clock;
  const store = new TaskStore(join(dir, 'weaver.db'));
  const children: EventEmitter[] = [];
  const manager = new TaskManager(store, { id: 'fixture', canLaunchReal: () => true, start() { const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); children.push(child); return child; } });
  const policy = new PolicyStore(store.db, () => clock);
  const base = policy.snapshot();
  const config = defaultConfig();
  config.engines.qoder!.enabled = true;
  config.engines.opencode!.enabled = true;
  config.workers.qoder_worker!.enabled = true;
  config.workers.opencode_worker!.enabled = true;
  // A paid sibling on each engine keeps a single limited worker from taking its whole engine out (and the probe out of the picture).
  config.workers.qoder_paid_worker = { channels: ["default_qoder"], model: 'paid-model', effort: 'auto', enabled: true };
  config.workers.opencode_paid_worker = { channels: ["default_opencode"], model: 'paid-model', effort: 'max', enabled: true };
  policy.save({ revision: base.revision, config, blocks: [] }, { allowEngineEnable: true });
  const handler = new CommandHandler(manager, policy);
  const ladder = dbVendorLadder(store.db);
  const answers: Record<string, string[]> = {};
  const monitor = new FreeChannelProbeMonitor({
    policy: () => policy, stateStore: dbFreeProbeStore(store.db), vendorLadder: ladder,
    probe: async route => answers[route.worker]?.shift() === 'rate_limit' ? { ok: false, ms: 5, error: '429 too many requests, retry after 5 minutes' } : { ok: true, ms: 5 },
    now: () => clock, ready: () => true, onBlocksChanged: () => handler.pump(), log: () => {},
  });
  let count = 0;
  /** A dispatched attempt of this worker that ended on a vendor rate limit. */
  const dispatchLimited = async (worker: string, engine: string) => {
    const task = manager.create({ title: `limited ${count++}`, instruction: 'fake only', workspace: dir, owner: { name: 'o', transport: 'herdr-visible', session: 's', pane: 'p' } });
    task.status = 'failed';
    task.dispatch = { engine, execution: 'real', owner: 'claude_owner', worker, model: 'fake', effort: 'high', maxParallel: 2 };
    task.failure = { kind: 'rate_limit', message: '429 too many requests' } as Task['failure'];
    store.put(task);
    handler.pump();
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  const minutes = async (count: number) => { for (let index = 0; index < count; index += 1) { clock += MINUTE; await monitor.tick(); } };
  return {
    store, policy, monitor, ladder, answers, dispatchLimited, minutes,
    at: () => clock,
    free: (worker: string) => monitor.status().workers.find(item => item.worker === worker)!,
    blockOf: (worker: string, withModel: boolean) => policy.snapshot().blocks.find(block => block.worker === worker && (block.model !== undefined) === withModel),
    close: async () => {
      Date.now = realNow;
      await monitor.stop();
      handler.draining = true;
      for (const child of children) child.emit('close', 0, null);
      await manager.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a probe rate limit and a dispatch rate limit on the same worker step one ladder, in both directions', async () => {
  const f = fixture();
  try {
    f.answers.qoder_worker = ['rate_limit'];
    f.answers.opencode_worker = ['rate_limit'];
    f.monitor.start();
    // Dispatch first, probe second: opencode_worker is on level 1 from a failed dispatch when its probe is limited.
    await f.minutes(1);
    await f.dispatchLimited('opencode_worker', 'opencode');
    assert.deepEqual(f.ladder.get('opencode_worker'), { level: 1, lastTriggerAt: START + MINUTE });
    assert.equal(f.blockOf('opencode_worker', false)!.release_at, iso(START + 11 * MINUTE), 'level 1 waits 10 minutes');
    // The user clears that block by hand (a dispatch-written worker block would otherwise keep the probe from writing its own).
    const snapshot = f.policy.snapshot();
    f.policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [] });
    // Probe first, dispatch second: qoder_worker's probe is limited at the first round.
    await f.minutes(9);
    assert.equal(f.at(), START + 10 * MINUTE);
    assert.deepEqual(f.ladder.get('qoder_worker'), { level: 1, lastTriggerAt: START + 10 * MINUTE });
    assert.equal(f.blockOf('qoder_worker', true)!.release_at, iso(START + 20 * MINUTE), 'the probe stepped level 1 of the shared ladder');
    // The probe saw the dispatch failure's step: opencode_worker is on level 2 and waits 30 minutes.
    assert.deepEqual(f.ladder.get('opencode_worker'), { level: 2, lastTriggerAt: START + 10 * MINUTE });
    const record = f.free('opencode_worker');
    assert.equal(record.level, 2);
    assert.equal(record.mode, 'rate_limit');
    assert.equal(f.blockOf('opencode_worker', true)!.release_at, iso(START + 40 * MINUTE));
    assert.equal(record.history.at(-1)!.message, '限流阶梯第 2 级，30 分钟后恢复探测');
    // The dispatch failure sees the probe's step: qoder_worker moves to level 2 and waits 30 minutes.
    await f.minutes(2);
    await f.dispatchLimited('qoder_worker', 'qoder');
    assert.deepEqual(f.ladder.get('qoder_worker'), { level: 2, lastTriggerAt: START + 12 * MINUTE });
    assert.equal(f.blockOf('qoder_worker', false)!.release_at, iso(START + 42 * MINUTE));
    assert.equal(f.free('qoder_worker').level, 2, 'the probe status reads the same ladder');
    assert.equal(f.free('qoder_worker').lastTriggerAt, iso(START + 12 * MINUTE));
  } finally { await f.close(); }
});

test('the probe row keeps only the schedule of a rate-limit question; the level is the ladder\'s alone', async () => {
  const f = fixture();
  try {
    f.answers.qoder_worker = ['rate_limit'];
    f.monitor.start();
    await f.minutes(10);
    const row = (f.store.db.prepare("SELECT level,last_trigger_at,mode,blocked_until,next_probe_at FROM free_probe_workers WHERE worker='qoder_worker'").get() as Record<string, unknown>);
    assert.deepEqual({ ...row }, { level: 0, last_trigger_at: null, mode: 'rate_limit', blocked_until: START + 20 * MINUTE, next_probe_at: START + 20 * MINUTE });
    assert.deepEqual(f.ladder.get('qoder_worker'), { level: 1, lastTriggerAt: START + 10 * MINUTE });
    // A pass lifts the question; the ladder stays for the reset window so the next limit steps up.
    await f.minutes(10);
    assert.equal(f.free('qoder_worker').mode, null);
    assert.deepEqual(f.ladder.get('qoder_worker'), { level: 1, lastTriggerAt: START + 10 * MINUTE });
    f.answers.qoder_worker = ['rate_limit'];
    await f.minutes(10);
    assert.equal(f.free('qoder_worker').level, 2);
    assert.equal(f.blockOf('qoder_worker', true)!.release_at, iso(START + 60 * MINUTE));
  } finally { await f.close(); }
});
