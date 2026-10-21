import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unblockWorker } from '../../src/main/application/workers/unblock';
import { PolicyBlockService } from '../../src/main/policy/blocks';
import { ENGINE_ALL_BLOCKED_REASON } from '../../src/main/policy/routing';
import { PolicyStore } from '../../src/main/policy/store';
import { StallMonitor } from '../../src/main/stall';
import type { Block } from '../../src/shared/contracts/policy';
import { STALL_BLOCK_BY, VENDOR_BLOCK_BY } from '../../src/shared/policy/blocks';
import { readStall, stallStoreAt } from '../helpers/state-db';

// The user's 「恢复派发」 for one worker: its blocks (and the engine-wide "all limited" block that no longer holds)
// go, nothing else does, the monitors forget what they kept for it, and queued work is told to route again.

const NOW = Date.parse('2030-01-01T00:00:00Z');
const since = new Date(NOW).toISOString();
const later = new Date(NOW + 3_600_000).toISOString();
const dirs: string[] = [];
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** codex has two enabled workers (codex_worker, codexb_worker); opencode has one. */
function fixture(blocks: Block[]) {
  const dir = mkdtempSync(join(tmpdir(), 'wv-worker-unblock-'));
  dirs.push(dir);
  const policy = new PolicyStore(join(dir, 'weaver.db'), () => NOW);
  const base = policy.snapshot();
  const config = base.config;
  config.workers.codexb_worker = { ...config.workers.codex_worker!, model: 'gpt-b' };
  config.workers.opencode_worker!.enabled = true;
  config.engines.opencode!.enabled = true;
  policy.save({ revision: base.revision, config, blocks }, { allowEngineEnable: true });
  const calls = { stall: [] as string[], probe: [] as string[], pumps: 0 };
  const service = new PolicyBlockService(() => policy, { onChanged: () => { calls.pumps += 1; } });
  const deps = {
    blocks: service,
    stall: { resetWorker: (engine: string, worker: string) => { calls.stall.push(`${engine}/${worker}`); } },
    freeProbe: { resetWorker: (engine: string, worker: string) => { calls.probe.push(`${engine}/${worker}`); } },
  };
  return { dir, policy, calls, deps, blocks: () => policy.snapshot().blocks };
}
const vendor = (worker: string | undefined, extra: Partial<Block> = {}): Block => ({ engine: 'codex', ...(worker ? { worker } : {}), reason: '限流：429', since, by: VENDOR_BLOCK_BY, release_at: later, ...extra });
const allLimited = (): Block => vendor(undefined, { reason: ENGINE_ALL_BLOCKED_REASON });
const labels = (blocks: Block[]) => blocks.map(block => `${block.engine}/${block.worker ?? '*'}/${block.model ?? '*'}/${block.by}`);

test('an unknown worker is refused before anything is written or any monitor is asked', () => {
  const f = fixture([vendor('codex_worker')]);
  const revision = f.policy.snapshot().revision;
  assert.throws(() => unblockWorker(f.deps, 'ghost'), /Unknown worker ghost/);
  assert.equal(f.policy.snapshot().revision, revision);
  assert.deepEqual([f.calls.stall, f.calls.probe, f.calls.pumps], [[], [], 0]);
});

test('only the named worker\'s blocks go, whatever their source or model; siblings and other engines keep theirs', () => {
  const f = fixture([
    vendor('codex_worker'),
    { engine: 'codex', worker: 'codex_worker', model: 'gpt-x', reason: '人工', since, by: 'manual' },
    { engine: 'codex', worker: 'codex_worker', model: 'gpt-y', reason: '探测', since, by: 'weaver-free-probe' },
    vendor('codexb_worker'),
    { engine: 'opencode', worker: 'opencode_worker', reason: '人工', since, by: 'manual' },
  ]);
  const result = unblockWorker(f.deps, 'codex_worker');
  assert.deepEqual(result, { worker: 'codex_worker', engine: 'codex', removed: 3, wasBlocked: true });
  assert.deepEqual(labels(f.blocks()), ['codex/codexb_worker/*/weaver-vendor-limit', 'opencode/opencode_worker/*/manual']);
  assert.deepEqual(f.calls.stall, ['codex/codex_worker']);
  assert.deepEqual(f.calls.probe, ['codex/codex_worker']);
  assert.equal(f.calls.pumps, 1, 'queued work is told to route again');
});

test('the whole-engine "all limited" vendor block goes with the last limited worker, and stays while the engine is still fully blocked', () => {
  const f = fixture([vendor('codex_worker'), vendor('codexb_worker'), allLimited()]);
  const result = unblockWorker(f.deps, 'codex_worker');
  assert.equal(result.removed, 2, 'the worker block and the engine block that depended on it');
  assert.deepEqual(labels(f.blocks()), ['codex/codexb_worker/*/weaver-vendor-limit']);

  // A model-level ban still covers the unblocked worker, so every enabled worker of the engine stays out and the engine block stays true.
  const model = f.policy.snapshot().config.workers.codex_worker!.model;
  const held = fixture([vendor('codex_worker'), vendor('codexb_worker'), { engine: 'codex', model, reason: '人工', since, by: 'manual' }, { engine: 'codex', model: 'gpt-b', reason: '人工', since, by: 'manual' }, allLimited()]);
  const kept = unblockWorker(held.deps, 'codex_worker');
  assert.equal(kept.removed, 1);
  assert.equal(held.blocks().some(block => block.by === VENDOR_BLOCK_BY && !block.worker && block.reason === ENGINE_ALL_BLOCKED_REASON), true);
});

test('manual and other engine-level blocks, and vendor engine blocks that are not the "all limited" one, are never removed', () => {
  const manual: Block = { engine: 'codex', reason: '人工暂停', since, by: 'manual' };
  const stall: Block = { engine: 'codex', reason: '卡住', since, by: STALL_BLOCK_BY };
  const single = vendor(undefined, { reason: '限流：dispatch without a known worker' });
  const quota: Block = { engine: 'codex', model: 'gpt-b', reason: '额度', since, by: 'weaver-quota:codex' };
  for (const foreign of [manual, stall, single]) {
    const f = fixture([vendor('codex_worker'), foreign, quota]);
    assert.equal(unblockWorker(f.deps, 'codex_worker').removed, 1);
    assert.deepEqual(f.blocks(), [foreign, quota]);
  }
});

test('a worker without blocks changes nothing, does not announce a route change and still resets its monitor state', () => {
  const f = fixture([vendor('codexb_worker')]);
  const revision = f.policy.snapshot().revision;
  assert.deepEqual(unblockWorker(f.deps, 'codex_worker'), { worker: 'codex_worker', engine: 'codex', removed: 0, wasBlocked: false });
  assert.equal(f.policy.snapshot().revision, revision);
  assert.equal(f.calls.pumps, 0);
  assert.deepEqual(f.calls.stall, ['codex/codex_worker']);
});

test('a failing monitor reset does not undo the removed blocks, does not stop the next step or the notification, and is reported with what was applied', () => {
  const f = fixture([vendor('codex_worker'), vendor('codexb_worker'), allLimited()]);
  const deps = { ...f.deps, stall: { resetWorker: () => { throw new Error('injected: state write failed'); } } };
  assert.throws(() => unblockWorker(deps, 'codex_worker'), /Worker codex_worker was only partly unblocked\. The 2 block\(s\) of codex_worker were already cleared; stall reset: injected: state write failed/);
  assert.deepEqual(labels(f.blocks()), ['codex/codexb_worker/*/weaver-vendor-limit']);
  assert.deepEqual(f.calls.probe, ['codex/codex_worker'], 'the free probe reset still ran');
  assert.equal(f.calls.pumps, 1, 'queued work is still told to route again');
  const both = { ...deps, freeProbe: { resetWorker: () => { throw new Error('injected: free state write failed'); } } };
  assert.throws(() => unblockWorker(both, 'codexb_worker'), /stall reset: injected: state write failed; free probe reset: injected: free state write failed/);
});

test('the stall ladder is kept per engine: a worker unblock resets it only once no stall block of the engine is left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wv-worker-unblock-stall-'));
  dirs.push(dir);
  const policy = new PolicyStore(join(dir, 'weaver.db'), () => NOW);
  const base = policy.snapshot();
  const stall: Block = { engine: 'codex', reason: '卡住', since, by: STALL_BLOCK_BY };
  policy.save({ revision: base.revision, config: base.config, blocks: [stall] });
  const statePath = join(dir, 'state.db');
  const armed = { level: 2, lastTriggerAt: NOW - 60_000, needsAttention: false, blockedUntil: NOW + 600_000, nextProbeAt: NOW + 600_000, probeSuccesses: 1, head: 'x' };
  stallStoreAt(statePath).save({ engines: { codex: armed }, history: [] });
  const monitor = new StallMonitor({ tasks: () => [], policy: () => policy, stateStore: stallStoreAt(statePath), now: () => NOW, cpu: async () => null, log: () => {} });
  monitor.resetWorker('codex', 'codex_worker');
  assert.equal(readStall(statePath).engines.codex!.level, 2, 'the engine is still under its stall block, which the other workers share');
  // The stall block is gone (removed by hand or by the unblock): the ladder starts over.
  const after = policy.snapshot();
  policy.save({ revision: after.revision, config: after.config, blocks: [] });
  monitor.resetWorker('codex', 'codex_worker');
  assert.equal(readStall(statePath).engines.codex!.level, 0);
  assert.equal(readStall(statePath).engines.codex!.nextProbeAt, null);
  // A worker that does not belong to the engine is not this engine's business.
  stallStoreAt(statePath).save({ engines: { codex: armed }, history: [] });
  const fresh = new StallMonitor({ tasks: () => [], policy: () => policy, stateStore: stallStoreAt(statePath), now: () => NOW, cpu: async () => null, log: () => {} });
  fresh.resetWorker('codex', 'opencode_worker');
  assert.equal(readStall(statePath).engines.codex!.level, 2);
});
