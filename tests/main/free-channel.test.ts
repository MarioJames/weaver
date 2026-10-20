import test from 'node:test';
import { freeStoreAt, readFree, stallStoreAt, vendorLadderAt } from '../helpers/state-db';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeBlocks, availabilityOf } from '../../src/shared/policy/availability';
import { defaultConfig } from '../../src/main/policy/routing';
import { PolicyStore } from '../../src/main/policy/store';
import { FreeChannelProbeMonitor, parseFreeProbeInput } from '../../src/main/free-channel';
import { unblockEngine } from '../../src/main/application/engines/unblock';
import { PolicyBlockService } from '../../src/main/policy/blocks';
import { StallMonitor } from '../../src/main/stall';
import { FREE_PROBE_BLOCK_BY, STALL_BLOCK_BY } from '../../src/shared/policy/blocks';
import { parseFreeProbeState } from '../../src/main/storage/free-probe-state';
import { classifyVendorError } from '../../src/main/adapters/cli/vendor-errors';

const START = Date.parse('2026-10-19T08:00:00Z');
const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

type ProbeOutcomeLike = { ok: boolean; ms: number; error?: string };
type Probe = (route: { worker: string }, signal: AbortSignal) => Promise<ProbeOutcomeLike>;

const answer = (kind: string): ProbeOutcomeLike => {
  if (kind === 'quota_reset') return { ok: false, ms: 10, error: 'FreeUsageLimitError: free quota used up, retry after 30m' };
  if (kind === 'quota_plain') return { ok: false, ms: 10, error: 'FreeUsageLimitError: free quota used up' };
  if (kind === 'rate_limit') return { ok: false, ms: 10, error: '429 too many requests, retry after 5 minutes' };
  if (kind === 'auth') return { ok: false, ms: 10, error: '401 authentication failed' };
  return { ok: true, ms: 42 };
};

interface HarnessOptions {
  /** Per-worker answer scripts; an exhausted or missing queue answers 'pass'. */
  scripts?: Record<string, string[]>;
  /** Per-worker probe functions replacing the script for that worker. */
  probes?: Record<string, Probe>;
  /** Run without a loaded prober: failures are recorded, no block is written. */
  noProber?: boolean;
}
interface ProbeCall { worker: string; at: number }
async function harness(options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wv-free-probe-'));
  let now = START;
  let ready = true;
  const config = defaultConfig();
  config.engines.qoder.enabled = true;
  config.engines.opencode.enabled = true;
  config.workers.qoder_worker.enabled = true;
  config.workers.opencode_worker.enabled = true;
  // A paid worker shares the qoder engine and must never be touched by free-channel writes.
  config.workers.qoder_paid_worker = { engine: 'qoder', model: 'paid-model', effort: 'auto', enabled: true };
  const policy = new PolicyStore(join(dir,'weaver.db'), () => now);
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config, blocks: base.blocks }, { allowEngineEnable: true });
  const statePath = join(dir, 'state.db');
  const logs: string[] = [];
  const calls: ProbeCall[] = [];
  let pumps = 0;
  const monitor = new FreeChannelProbeMonitor({
    policy: () => policy,
    stateStore: freeStoreAt(statePath),
    vendorLadder: vendorLadderAt(statePath),
    ...(options.noProber
      ? {}
      : {
          probe: async (route, signal) => {
            calls.push({ worker: route.worker, at: now });
            const custom = options.probes?.[route.worker];
            if (custom) return custom(route, signal);
            return answer(options.scripts?.[route.worker]?.shift() ?? 'pass');
          },
        }),
    now: () => now,
    ready: () => ready,
    onBlocksChanged: () => { pumps += 1; },
    log: message => logs.push(message),
  });
  monitor.start();
  /** One minute per tick, so a probe can only run at its own deadline. */
  const step = async (minutes: number) => {
    for (let index = 0; index < minutes; index += 1) { now += MINUTE; await monitor.tick(); }
  };
  return {
    dir, policy, monitor, statePath, logs, calls,
    now: () => now,
    worker: (id: string) => monitor.status().workers.find(item => item.worker === id)!,
    status: () => monitor.status(),
    state: () => readFree(statePath),
    blockFor: (engine: string, model: string) => policy.snapshot().blocks.find(item => item.engine === engine && item.model === model),
    byBlock: (by: string, engine: string) => policy.snapshot().blocks.find(item => item.by === by && item.engine === engine),
    blocks: () => policy.snapshot().blocks,
    active: () => activeBlocks({ version: 1, blocks: policy.snapshot().blocks }, now),
    probesOf: (worker: string) => calls.filter(call => call.worker === worker),
    pumps: () => pumps,
    step, tick: () => monitor.tick(),
    setReady: (value: boolean) => { ready = value; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('the vendor classifier keeps the documented failure kinds and retry times', () => {
  const quota = classifyVendorError('opencode', 'error.error="FreeUsageLimitError: usage limit reached, retry after 30m"', START);
  assert.equal(quota?.kind, 'quota');
  assert.equal(quota.retryAt, iso(START + 30 * MINUTE));
  assert.equal(classifyVendorError('opencode', '429 too many requests', START)?.kind, 'rate_limit');
  assert.equal(classifyVendorError('opencode', '401 authentication failed', START)?.kind, 'auth');
  assert.equal(classifyVendorError('opencode', 'just noise', START), undefined);
});

test('free_channel markers are probed on the settings cadence and a pass writes nothing', async () => {
  const h = await harness();
  try {
    assert.deepEqual(parseFreeProbeInput({}), {});
    assert.deepEqual(parseFreeProbeInput({ worker: 'qoder_worker' }), { worker: 'qoder_worker' });
    assert.deepEqual(h.status().schedule, { enabled: true, interval_minutes: 10, lastRunAt: null, nextRunAt: iso(START + 10 * MINUTE) });
    await h.step(9);
    assert.deepEqual(h.calls, [], 'nothing happens before the first round is due');
    await h.step(1);
    assert.deepEqual(h.calls.map((call: ProbeCall) => call.worker), ['qoder_worker', 'opencode_worker'], 'each worker is probed once per round');
    assert.equal(h.blocks().length, 0, 'a passing probe writes no block');
    assert.equal(h.pumps(), 0);
    assert.equal(h.status().schedule.lastRunAt, iso(START + 10 * MINUTE));
    assert.equal(h.worker('qoder_worker').level, 0);
    assert.equal(h.worker('qoder_worker').availability.status, 'available');
    assert.equal(h.state()!.history.length, 2, 'the answers are recorded');
    assert.equal(h.state()!.history[0]!.probe.ok, true);
    await h.step(10);
    assert.deepEqual(h.calls.map((call: ProbeCall) => call.worker), ['qoder_worker', 'opencode_worker', 'qoder_worker', 'opencode_worker'], 'rounds repeat on their interval');
    assert.equal(h.status().schedule.nextRunAt, iso(START + 30 * MINUTE));
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('a disabled free_channel_probe setting stops all probing', async () => {
  const h = await harness();
  try {
    const snapshot = h.policy.snapshot();
    snapshot.config.free_channel_probe = { enabled: false, interval_minutes: 10 };
    h.policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: snapshot.blocks });
    await h.step(11);
    assert.deepEqual(h.calls, []);
    assert.equal(h.status().schedule.enabled, false);
    assert.equal(h.status().schedule.nextRunAt, null);
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('vendor quota exhaustion bans the marked engine+model with the given reset time; nothing probed while held', async () => {
  const h = await harness({ scripts: { qoder_worker: ['quota_reset'] } });
  try {
    await h.step(10);
    assert.deepEqual(h.calls.map((call: ProbeCall) => call.worker), ['qoder_worker', 'opencode_worker'], 'all marked workers are probed');
    const block = h.byBlock(FREE_PROBE_BLOCK_BY, 'qoder')!;
    assert.deepEqual(Object.keys(block).filter(key => key !== 'reason').sort(), ['by', 'engine', 'model', 'release_at', 'since', 'worker']);
    assert.equal(block.model, 'Qwen3.8-Flash');
    assert.equal(block.worker, 'qoder_worker', 'the ban is a worker-level block');
    assert.equal(block.release_at, iso(START + 40 * MINUTE), 'the vendor named the reset time');
    assert.match(block.reason, /额度耗尽/);
    assert.ok(block.reason.length <= 120);
    const record = h.state()!.history.find(item => item.block !== undefined)!;
    assert.equal(record.worker, 'qoder_worker');
    assert.equal(record.level, 0, 'the record carries the pre-ban level');
    assert.equal(record.probe?.ok, false);
    assert.ok((record.probe?.error?.length ?? 0) <= 200, 'probe errors are bounded');
    assert.equal(record.probe?.error, 'FreeUsageLimitError: free quota used up, retry after 30m');
    assert.equal(record.message, '封禁至供应商给出的重置时间');
    const held = h.worker('qoder_worker');
    assert.equal(held.mode, 'quota');
    assert.equal(held.blockedUntil, iso(START + 40 * MINUTE));
    assert.equal(held.nextProbeAt, null, 'the reset time releases it alone; no probe is owed');
    assert.equal(held.availability.status, 'blocked');
    assert.equal(held.availability.release_at, block.release_at);
    assert.ok(h.pumps() >= 1, 'routing learns about the ban');
    // Routing itself: the free worker is out, the paid worker on the same engine stays usable.
    const config = h.policy.snapshot().config;
    assert.equal(availabilityOf(config, h.active(), config.workers.qoder_worker, 'qoder_worker').status, 'blocked');
    assert.equal(availabilityOf(config, h.active(), config.workers.qoder_paid_worker, 'qoder_paid_worker').status, 'available');
    assert.equal(availabilityOf(config, h.active(), config.workers.opencode_worker, 'opencode_worker').status, 'available', 'the other marked worker answers on its own engine');
    // Rounds keep probing the other marked worker but skip the held one.
    await h.step(20);
    assert.equal(h.probesOf('qoder_worker').length, 1, 'the held worker is not probed again');
    assert.ok(h.probesOf('opencode_worker').length >= 2);
    assert.equal(h.byBlock(FREE_PROBE_BLOCK_BY, 'qoder')!.release_at, iso(START + 40 * MINUTE), 'the block is untouched while it holds');
    // One minute past the release the reconcile clears the answer; the next round probes again.
    await h.step(21);
    assert.equal(h.worker('qoder_worker').mode, null, 'a reset time releases the ban without a probe');
    assert.equal(h.byBlock(FREE_PROBE_BLOCK_BY, 'qoder')!.release_at, iso(START + 40 * MINUTE), 'the stale row stays until it is replaced');
    assert.equal(availabilityOf(h.policy.snapshot().config, h.active(), h.policy.snapshot().config.workers.qoder_worker, 'qoder_worker').status, 'available', 'the expired release no longer blocks routing');
    assert.ok(h.logs.some(item => item.includes('阻断不再由本进程持有')));
    assert.equal(h.state()!.history.length <= 50, true);
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('quota without a vendor time stays banned and the interval keeps probing until one pass releases it', async () => {
  const h = await harness({ scripts: { qoder_worker: ['quota_plain', 'quota_plain', 'pass'] } });
  try {
    await h.step(10);
    const block = h.byBlock(FREE_PROBE_BLOCK_BY, 'qoder')!;
    assert.equal(block.release_at, undefined, 'the vendor named no time');
    const held = h.worker('qoder_worker');
    assert.equal(held.mode, 'quota');
    assert.equal(held.nextProbeAt, iso(START + 20 * MINUTE), 'the probe interval keeps asking');
    assert.equal(held.blockedUntil, null);
    assert.equal(held.availability.status, 'blocked');
    assert.equal(h.probesOf('qoder_worker').length, 1);
    await h.step(9);
    assert.equal(h.probesOf('qoder_worker').length, 1, 'not before its own deadline');
    await h.step(1);
    assert.equal(h.probesOf('qoder_worker').length, 2, 'probed again at its deadline');
    assert.equal(h.byBlock(FREE_PROBE_BLOCK_BY, 'qoder')?.since, block.since, 'the re-answered ban replaces the same key');
    await h.step(1);
    assert.equal(h.probesOf('qoder_worker').length, 2, 'not before the next deadline');
    await h.step(9);
    assert.equal(h.byBlock(FREE_PROBE_BLOCK_BY, 'qoder'), undefined, 'a passing probe releases the ban');
    assert.equal(h.worker('qoder_worker').mode, null);
    assert.equal(h.worker('qoder_worker').availability.status, 'available');
    assert.ok(h.pumps() >= 2);
    assert.ok(h.state()!.history.some(item => item.message === '免费额度探测成功，解除封禁'));
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('rate limits walk the vendor ladder on the marked route, 10 then 30 minutes, one pass lifts level 1', async () => {
  const h = await harness({ scripts: { qoder_worker: ['rate_limit', 'pass', 'rate_limit'] } });
  try {
    await h.step(10);
    const vendor = h.byBlock('weaver-vendor-limit', 'qoder')!;
    assert.equal(vendor.model, 'Qwen3.8-Flash');
    assert.equal(vendor.worker, 'qoder_worker');
    assert.equal(vendor.release_at, iso(START + 20 * MINUTE), 'level 1 waits 10 minutes');
    assert.equal(h.worker('qoder_worker').mode, 'rate_limit');
    assert.equal(h.worker('qoder_worker').level, 1);
    assert.equal(h.worker('qoder_worker').blockedUntil, iso(START + 20 * MINUTE));
    assert.equal(h.worker('qoder_worker').nextProbeAt, iso(START + 20 * MINUTE));
    // Ten minutes later the deadline passed: the question resets, the stale row stays inactive.
    await h.step(10);
    assert.equal(h.worker('qoder_worker').mode, null);
    assert.equal(h.byBlock('weaver-vendor-limit', 'qoder')!.release_at, iso(START + 20 * MINUTE), 'the stale row is not removed proactively');
    assert.deepEqual(availabilityOf(h.policy.snapshot().config, h.active(), h.policy.snapshot().config.workers.qoder_worker, 'qoder_worker').status, 'available', 'an expired release no longer blocks routing');
    await h.step(10);
    assert.equal(h.byBlock('weaver-vendor-limit', 'qoder')!.release_at, iso(START + 60 * MINUTE), 'level 2 waits 30 minutes');
    assert.equal(h.worker('qoder_worker').level, 2);
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('other failures walk the stall ladder on the marked route; level 3 needs three consecutive passes', async () => {
  const h = await harness({ scripts: { qoder_worker: ['auth', 'auth', 'auth', 'pass', 'pass', 'pass'] } });
  try {
    await h.step(10);
    const stall = h.byBlock(STALL_BLOCK_BY, 'qoder')!;
    assert.equal(stall.model, 'Qwen3.8-Flash');
    assert.equal(stall.worker, 'qoder_worker');
    assert.equal(stall.release_at, undefined, 'a stall penalty is not on a timer');
    assert.equal(h.worker('qoder_worker').mode, 'stall');
    assert.equal(h.worker('qoder_worker').blockedUntil, iso(START + 15 * MINUTE), 'level 1 probes after five minutes');
    await h.step(5);
    assert.equal(h.worker('qoder_worker').level, 2);
    assert.equal(h.worker('qoder_worker').blockedUntil, iso(START + 25 * MINUTE));
    await h.step(10);
    assert.equal(h.worker('qoder_worker').level, 3);
    assert.equal(h.worker('qoder_worker').needsAttention, true);
    assert.equal(h.worker('qoder_worker').blockedUntil, null, 'level 3 has no deadline');
    assert.equal(h.worker('qoder_worker').nextProbeAt, iso(START + 35 * MINUTE), 'the recovery cadence takes over');
    await h.step(10);
    assert.equal(h.worker('qoder_worker').probeSuccesses, 1);
    assert.equal(h.byBlock(STALL_BLOCK_BY, 'qoder') !== undefined, true, 'level 3 does not lift after one pass');
    assert.ok(h.state()!.history.some(item => item.message === '连续成功 1/3，继续按恢复间隔探测'));
    await h.step(10);
    assert.equal(h.worker('qoder_worker').probeSuccesses, 2);
    await h.step(10);
    assert.equal(h.byBlock(STALL_BLOCK_BY, 'qoder'), undefined, 'the third pass lifts the penalty');
    assert.equal(h.worker('qoder_worker').mode, null);
    assert.equal(h.worker('qoder_worker').level, 3, 'the level stays until the reset window');
    assert.ok(h.state()!.history.some(item => item.message === '三次连续探测成功，解除惩罚'));
    assert.ok(h.state()!.history.some(item => item.message === '惩罚升级到第 3 级'));
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('a held stall never lifts on time alone; removing the block by hand resets the question', async () => {
  const h = await harness({ probes: { qoder_worker: () => Promise.resolve({ ok: false, ms: 5, error: '401 authentication failed' }) } });
  try {
    await h.step(10);
    const reason = h.byBlock(STALL_BLOCK_BY, 'qoder')!.reason;
    await h.step(150);
    assert.equal(h.byBlock(STALL_BLOCK_BY, 'qoder')!.reason, reason, 'no probe passed, nothing lifts on its own');
    // Manual removal through the ordinary policy save path.
    const snapshot = h.policy.snapshot();
    h.policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: snapshot.blocks.filter(item => item.by !== STALL_BLOCK_BY) });
    await h.step(1);
    assert.equal(h.byBlock(STALL_BLOCK_BY, 'qoder'), undefined);
    assert.equal(h.worker('qoder_worker').mode, null, 'the whole question resets to healthy');
    assert.ok(h.logs.some(item => item.includes('阻断不再由本进程持有')), 'the reset is explained in the log');
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('a foreign block on the same route suppresses free-channel writes; the manual block keeps its owner', async () => {
  const h = await harness({ scripts: { qoder_worker: ['quota_plain', 'quota_plain'] } });
  try {
    await h.step(10);
    assert.equal(h.byBlock(FREE_PROBE_BLOCK_BY, 'qoder')?.by, FREE_PROBE_BLOCK_BY);
    // Manual edit: remove our block, put a manual one on the same engine+model.
    const snapshot = h.policy.snapshot();
    h.policy.save({
      revision: snapshot.revision, config: snapshot.config,
      blocks: [...snapshot.blocks.filter(item => item.by !== FREE_PROBE_BLOCK_BY), { engine: 'qoder', model: 'Qwen3.8-Flash', reason: '人工暂停', since: iso(h.now()), by: 'manual' }],
    });
    await h.step(1);
    assert.equal(h.worker('qoder_worker').mode, null, 'removing our block by hand ends the question');
    assert.equal(h.state()!.history.some(item => /未写入/.test(item.message ?? '')), false, 'no write attempt happened yet');
    await h.step(10);
    assert.equal(h.byBlock(FREE_PROBE_BLOCK_BY, 'qoder'), undefined, 'no probe-produced ban while the manual block holds');
    assert.equal(h.blockFor('qoder', 'Qwen3.8-Flash')!.reason, '人工暂停', 'the manual block is never replaced');
    assert.ok(h.state()!.history.some(item => /未写入/.test(item.message ?? '')), 'the suppressed answer is recorded');
    assert.equal(h.probesOf('qoder_worker').length, 2, 'the answer was still asked for');
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('the user unblock of an engine clears its probe blocks and resets its workers\' open questions at once, leaving other engines and the record alone', async () => {
  const h = await harness({ scripts: { qoder_worker: ['quota_plain'], opencode_worker: ['auth'] } });
  try {
    await h.step(10);
    assert.equal(h.worker('qoder_worker').mode, 'quota');
    assert.equal(h.worker('opencode_worker').mode, 'stall');
    const history = h.state()!.history.length;
    const stall = new StallMonitor({ tasks: () => [], policy: () => h.policy, stateStore: stallStoreAt(join(h.dir, 'unblock-stall.db')), cpu: async () => null, now: h.now, log: () => {} });
    let pumps = h.pumps();
    unblockEngine({ blocks: new PolicyBlockService(() => h.policy, { onChanged: () => { pumps += 1; } }), stall, freeProbe: h.monitor }, 'qoder');
    assert.deepEqual(h.blocks().map(block => block.engine), ['opencode'], 'every qoder block is gone, opencode keeps its own');
    assert.equal(h.worker('qoder_worker').mode, null, 'the question reset without waiting for the next tick');
    assert.equal(h.worker('qoder_worker').nextProbeAt, null);
    assert.equal(h.worker('opencode_worker').mode, 'stall', 'another engine\'s question is untouched');
    assert.equal(h.state()!.history.length, history, 'the record survives');
    assert.equal(readFree(h.statePath).workers.qoder_worker!.mode, null, 'and the reset is persisted');
    assert.equal(pumps, h.pumps() + 1, 'queued work is announced once');
    assert.throws(() => unblockEngine({ blocks: new PolicyBlockService(() => h.policy), stall, freeProbe: h.monitor }, 'ghost'), /Unknown engine ghost/);
    await stall.stop();
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('probeNow validates its target, runs the named probe, and stop fences anything in flight', async () => {
  const h = await harness({ scripts: { qoder_worker: [] } });
  try {
    await assert.rejects(() => h.monitor.probeNow('unknown'), /Unknown worker/);
    await assert.rejects(() => h.monitor.probeNow('codex_worker'), /不是启用且标记 free_channel 的子 Agent/);
    assert.throws(() => parseFreeProbeInput({ worker: 'x'.repeat(121) }), /Invalid free probe worker/);
    await h.monitor.probeNow('qoder_worker');
    assert.deepEqual(h.calls.map((call: ProbeCall) => call.worker), ['qoder_worker'], 'the named worker probed alone');
    assert.equal(h.probesOf('opencode_worker').length, 0);
    // Draining: a probe can only answer after being aborted; that answer writes nothing at all.
    const slow: Probe = (_route, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ ok: false, ms: 10, error: 'aborted probe' })));
    const fenced = new FreeChannelProbeMonitor({
      policy: () => h.policy, stateStore: freeStoreAt(join(h.dir, 'other-probes.db')), vendorLadder: vendorLadderAt(join(h.dir, 'other-probes.db')), probe: slow, now: h.now, ready: () => true, log: () => {},
    });
    fenced.start();
    const inFlight = fenced.probeNow('qoder_worker');
    await fenced.stop();
    await inFlight.catch(() => {});
    assert.equal(h.blocks().some(item => item.by === FREE_PROBE_BLOCK_BY), false, 'the aborted answer wrote nothing');
    // Not ready: probes are refused outright.
    h.setReady(false);
    await assert.rejects(() => h.monitor.probeNow(), /Weaver 正在停止/);
    h.setReady(true);
  } finally { await h.monitor.stop(); h.cleanup(); }
});

/** A monitor with its own policy and state tables, on a clock the test moves; `withReady: false` gives it no ready callback, so only its own stop() can fence it. */
function lonelyMonitor(withReady: boolean, probe: Probe) {
  const dir = mkdtempSync(join(tmpdir(), 'wv-free-stop-'));
  let now = START;
  const config = defaultConfig();
  config.engines.qoder.enabled = true;
  config.workers.qoder_worker.enabled = true;
  const policy = new PolicyStore(join(dir, 'weaver.db'), () => now);
  const base = policy.snapshot();
  policy.save({ revision: base.revision, config, blocks: [] }, { allowEngineEnable: true });
  const statePath = join(dir, 'state.db');
  const calls: string[] = [];
  let pumps = 0;
  const monitor = new FreeChannelProbeMonitor({
    policy: () => policy, stateStore: freeStoreAt(statePath), vendorLadder: vendorLadderAt(statePath),
    probe: (route, signal) => { calls.push(route.worker); return probe(route, signal); },
    now: () => now, ...(withReady ? { ready: () => true } : {}), onBlocksChanged: () => { pumps += 1; }, log: () => {},
  });
  return {
    dir, policy, monitor, statePath, calls,
    pumps: () => pumps,
    advance: (minutes: number) => { now += minutes * MINUTE; },
    now: () => now,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('after stop() a manual tick writes nothing and starts nothing, with or without a ready callback', async () => {
  for (const withReady of [true, false]) {
    const l = lonelyMonitor(withReady, () => Promise.resolve({ ok: false, ms: 5, error: '401 authentication failed' }));
    try {
      // Somebody else's held free-probe ban: the monitor adopts it as an open question and persists that.
      const base = l.policy.snapshot();
      l.policy.save({ revision: base.revision, config: base.config, blocks: [{ engine: 'qoder', model: 'Qwen3.8-Flash', worker: 'qoder_worker', reason: '额度耗尽：免费额度已用完', since: iso(l.now()), by: FREE_PROBE_BLOCK_BY }] });
      l.monitor.start();
      l.advance(1);
      await l.monitor.tick();
      assert.equal(readFree(l.statePath).workers.qoder_worker!.mode, 'quota', 'the question is open and persisted before the stop');
      await l.monitor.stop();
      // The ban is lifted by hand after the stop: reconciling the question is exactly what would write state now.
      const snapshot = l.policy.snapshot();
      l.policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [] });
      const rows = JSON.stringify(readFree(l.statePath));
      const revision = l.policy.snapshot().revision;
      const probes = l.calls.length;
      l.advance(30);
      await l.monitor.tick();
      await l.monitor.tick();
      assert.equal(JSON.stringify(readFree(l.statePath)), rows, `a stopped monitor writes no state (ready callback: ${withReady})`);
      assert.equal(l.policy.snapshot().revision, revision, 'nor policy');
      assert.equal(l.calls.length, probes, 'and starts no probe');
      assert.equal(l.pumps(), 0, 'nor announces anything');
      await assert.rejects(() => l.monitor.probeNow('qoder_worker'), /正在停止/, 'a manual probe after the stop is refused as well');
      // start() is what brings it back.
      l.monitor.start();
      await l.monitor.tick();
      assert.equal(readFree(l.statePath).workers.qoder_worker!.mode, null, 'a restarted monitor reconciles again');
      await l.monitor.stop();
    } finally { await l.monitor.stop(); l.cleanup(); }
  }
});

test('a greeting that answers only after stop() becomes neither a block nor a row, with or without a ready callback', async () => {
  for (const withReady of [true, false]) {
    let late: (outcome: ProbeOutcomeLike) => void = () => {};
    // The greeting ignores the abort signal, like a process that is already past the point of being killed.
    const l = lonelyMonitor(withReady, () => new Promise(resolve => { late = resolve; }));
    try {
      l.monitor.start();
      l.advance(10);
      const flying = l.monitor.tick();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(l.calls, ['qoder_worker'], 'the greeting is in flight');
      const revision = l.policy.snapshot().revision;
      const stopping = l.monitor.stop();
      late({ ok: false, ms: 5, error: 'FreeUsageLimitError: free quota used up' });
      await Promise.all([flying, stopping]);
      assert.deepEqual(l.policy.snapshot().blocks, [], 'the late answer wrote no block');
      assert.equal(l.policy.snapshot().revision, revision);
      assert.deepEqual(readFree(l.statePath), { version: 1, workers: {}, history: [] }, 'and no row or history');
      assert.equal(l.pumps(), 0);
    } finally { await l.monitor.stop(); l.cleanup(); }
  }
});

test('probe state is parsed, persisted in weaver.db and reloaded; an empty database adopts its own held block', async () => {
  const h = await harness({ scripts: { qoder_worker: ['quota_plain'] } });
  try {
    await h.step(10);
    assert.equal(h.state()!.workers.qoder_worker!.mode, 'quota');
    const parsed = readFree(h.statePath);
    assert.equal(parsed.history.length, h.state()!.history.length);
    assert.equal(parsed.workers.qoder_worker!.blockSince, h.byBlock(FREE_PROBE_BLOCK_BY, 'qoder')!.since);
    assert.throws(() => parseFreeProbeState({ version: 2, workers: {}, history: [] }), /Unsupported free probe store/);
    assert.throws(() => parseFreeProbeState({ version: 1, workers: {} }), /Invalid free probe history/);
    const coerced = parseFreeProbeState({ version: 1, workers: { x: { level: 'nope', mode: null, needsAttention: false, blockedUntil: null, nextProbeAt: null, probeSuccesses: 0, lastTriggerAt: null, head: '' } }, history: [] });
    assert.equal(coerced.workers.x!.level, 3, 'a damaged level falls back to needing attention');
    // The tables keep the open question and the history across a reopen.
    const state = h.state()!;
    const reloaded = readFree(h.statePath);
    assert.equal(reloaded.workers.qoder_worker!.blockSince, state.workers.qoder_worker!.blockSince);
    assert.equal(reloaded.history.length, state.history.length);
    {
      // A fresh monitor over the same policy but with empty probe tables adopts only its own marker.
      const adoptionLogs: string[] = [];
      const revived = new FreeChannelProbeMonitor({
        policy: () => h.policy, stateStore: freeStoreAt(join(h.dir, 'empty.db')), vendorLadder: vendorLadderAt(join(h.dir, 'empty.db')), probe: () => Promise.resolve({ ok: true, ms: 5 }), now: h.now, ready: () => true, log: message => adoptionLogs.push(message),
      });
      try {
        revived.start();
        await revived.tick();
        const adopted = revived.status().workers.find(item => item.worker === 'qoder_worker')!;
        assert.equal(adopted.mode, 'quota', 'the held block is adopted');
        assert.notEqual(adopted.nextProbeAt, null, 'a block without a reset time is probed again on the interval');
        assert.ok(adoptionLogs.some(item => item.includes('接管')));
      } finally { await revived.stop(); }
    }
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('without a loaded prober failures are recorded but nothing is ever banned', async () => {
  const h = await harness({ noProber: true });
  try {
    await h.step(10);
    assert.equal(h.blocks().length, 0, 'no prober means no penalty');
    assert.ok(h.state()!.history.some(item => item.message === '未装载探测执行器，仅记录失败'));
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('probe blocks are worker-level: only the probed worker is out, and a pass removes exactly that block', async () => {
  const h = await harness({ scripts: { qoder_worker: ['quota_plain', 'pass'] } });
  try {
    await h.step(10);
    const written = h.blocks().filter(block => block.worker !== undefined);
    assert.deepEqual(written.map(block => [block.worker, block.by]), [['qoder_worker', FREE_PROBE_BLOCK_BY]]);
    const config = h.policy.snapshot().config;
    assert.equal(h.policy.snapshot().workers.qoder_worker!.status, 'blocked');
    assert.equal(h.policy.snapshot().workers.qoder_worker!.worker, 'qoder_worker');
    assert.equal(h.policy.snapshot().workers.qoder_paid_worker!.status, 'available');
    // A same-model sibling is not covered by another worker's block.
    config.workers.qoder_twin = { ...config.workers.qoder_worker!, enabled: true };
    assert.equal(availabilityOf(config, h.active(), config.workers.qoder_twin, 'qoder_twin').status, 'available');
    assert.equal(h.byBlock('weaver-vendor-limit', 'qoder'), undefined, 'one blocked worker does not take the engine out');
    await h.step(10);
    assert.deepEqual(h.blocks(), [], 'the passing probe removed its own worker-level block');
    assert.equal(h.policy.snapshot().workers.qoder_worker!.status, 'available');
  } finally { await h.monitor.stop(); h.cleanup(); }
});

test('a rate-limit probe that leaves no enabled worker on the engine usable blocks the engine too, released with the earliest worker block', async () => {
  const h = await harness({ scripts: { qoder_worker: ['rate_limit'] } });
  try {
    const snapshot = h.policy.snapshot();
    snapshot.config.workers.qoder_paid_worker!.enabled = false;
    h.policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: snapshot.blocks });
    await h.step(10);
    const worker = h.blocks().find(block => block.worker === 'qoder_worker')!;
    const engine = h.blocks().find(block => block.engine === 'qoder' && block.worker === undefined)!;
    assert.equal(engine.by, 'weaver-vendor-limit');
    assert.equal(engine.model, undefined);
    assert.match(engine.reason, /全部子 Agent/);
    assert.equal(engine.release_at, worker.release_at);
    assert.equal(h.policy.snapshot().owners.claude_owner!.status, 'available', 'an owner on another engine is unaffected');
  } finally { await h.monitor.stop(); h.cleanup(); }
});
