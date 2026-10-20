import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LADDER_RESET_MS, PROBE_MS, STALL_LADDER } from '../src/main/domain/penalties';
import { armStall, ladderLive, ladderQuiet, nextLevel } from '../src/main/monitors/ladder';
import { MonitorLifecycle } from '../src/main/monitors/lifecycle';
import { PolicyBlockService, type BlockPolicy } from '../src/main/policy/blocks';
import { PolicyStore } from '../src/main/policy/store';
import type { Block } from '../src/shared/contracts/policy';
import { FREE_PROBE_BLOCK_BY, STALL_BLOCK_BY, VENDOR_BLOCK_BY, foreignBlockOn, isEngineBlock, isQuotaBlockBy, isScopeBlock, isStallEngineBlock, ownedOnRoute, quotaBlockBy, reaches } from '../src/shared/policy/blocks';

const MINUTE = 60_000;
const SINCE = '2030-01-01T00:00:00.000Z';
const block = (extra: Partial<Block> & Pick<Block, 'engine'>): Block => ({ reason: 'r', since: SINCE, ...extra });

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'wv-blocks-'));
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  const base = policy.snapshot();
  base.config.engines.codex!.enabled = true;
  policy.save({ revision: base.revision, config: base.config, blocks: [] }, { allowEngineEnable: true });
  return { policy, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('block sources and scope rules are named once and classify blocks by engine, worker, model and owner', () => {
  assert.equal(quotaBlockBy('codex'), 'weaver-quota:codex');
  assert.equal(isQuotaBlockBy('weaver-quota:claude'), true);
  assert.equal(isQuotaBlockBy(STALL_BLOCK_BY), false);
  assert.equal(isQuotaBlockBy(undefined), false);
  const whole = block({ engine: 'codex', by: STALL_BLOCK_BY });
  const worker = block({ engine: 'codex', worker: 'w', by: VENDOR_BLOCK_BY });
  const model = block({ engine: 'codex', model: 'm', worker: 'w', by: FREE_PROBE_BLOCK_BY });
  assert.deepEqual([isEngineBlock(whole), isEngineBlock(worker), isEngineBlock(model)], [true, false, false]);
  assert.equal(isEngineBlock(whole, 'claude'), false);
  assert.deepEqual([isScopeBlock(whole, 'codex', undefined), isScopeBlock(worker, 'codex', 'w'), isScopeBlock(worker, 'codex', undefined), isScopeBlock(model, 'codex', 'w')], [true, true, false, false]);
  assert.equal(isStallEngineBlock(whole, 'codex'), true);
  assert.equal(isStallEngineBlock({ ...whole, by: 'user' }, 'codex'), false);
  assert.equal(isStallEngineBlock({ ...whole, model: 'm' }, 'codex'), false);
  const route = { engine: 'codex', worker: 'w', model: 'm' };
  assert.deepEqual([whole, worker, model, block({ engine: 'codex', worker: 'other' }), block({ engine: 'codex', model: 'x' })].map(item => reaches(item, route)), [true, true, true, false, false]);
  // The probe owns its worker's own-marker block on the same model, and a pre-worker block on that model.
  assert.equal(ownedOnRoute(model, route), true);
  assert.equal(ownedOnRoute({ ...model, worker: undefined }, route), true);
  assert.equal(ownedOnRoute({ ...model, by: 'user' }, route), false);
  assert.equal(ownedOnRoute({ ...model, by: undefined }, route), false);
  assert.equal(ownedOnRoute({ ...model, by: STALL_BLOCK_BY }, route, FREE_PROBE_BLOCK_BY), false);
  assert.equal(foreignBlockOn([model, whole], route), whole, 'a whole-engine statement is somebody else\'s block on this route');
  assert.equal(foreignBlockOn([model, { ...model, by: 'user', worker: undefined }], route)?.by, 'user');
  assert.equal(foreignBlockOn([model, block({ engine: 'codex', worker: 'other', by: 'user' })], route), undefined);
});

test('the stall ladder arms a deadline per level and waits on a passing probe at the top', () => {
  assert.deepEqual(STALL_LADDER, [5, 10, null]);
  assert.deepEqual(armStall(1, 1_000), { blockedUntil: 1_000 + 5 * MINUTE, nextProbeAt: 1_000 + 5 * MINUTE });
  assert.deepEqual(armStall(2, 1_000), { blockedUntil: 1_000 + 10 * MINUTE, nextProbeAt: 1_000 + 10 * MINUTE });
  assert.deepEqual(armStall(3, 1_000), { blockedUntil: null, nextProbeAt: 1_000 + PROBE_MS });
});

test('a ladder level only counts inside the reset window, and the cap holds', () => {
  const at = 5_000_000;
  assert.equal(nextLevel(0, null, at, 3), 1, 'no history starts at the first level');
  assert.equal(nextLevel(2, null, at, 3), 1, 'an unknown trigger time starts over');
  assert.equal(nextLevel(1, at - 1, at, 3), 2);
  assert.equal(nextLevel(3, at - 1, at, 3), 3, 'capped');
  assert.equal(nextLevel(2, at - (LADDER_RESET_MS - 1), at, 3), 3, 'one millisecond inside the window still counts');
  assert.equal(nextLevel(2, at - LADDER_RESET_MS, at, 3), 1, 'the window edge starts over');
  assert.deepEqual([ladderLive(at - (LADDER_RESET_MS - 1), at), ladderLive(at - LADDER_RESET_MS, at), ladderLive(null, at)], [true, false, false]);
  assert.deepEqual([ladderQuiet(at - (LADDER_RESET_MS - 1), at), ladderQuiet(at - LADDER_RESET_MS, at), ladderQuiet(null, at)], [false, true, false]);
});

test('PolicyBlockService reads, saves against the revision and leaves the policy alone when the mutation declines', () => {
  const f = store();
  try {
    const logs: string[] = [];
    const service = new PolicyBlockService(() => f.policy, { log: message => logs.push(message) });
    const before = f.policy.snapshot().revision;
    const idle = service.update(() => undefined);
    assert.deepEqual([idle.ok, idle.saved, idle.snapshot.revision], [true, false, before]);
    assert.equal(f.policy.snapshot().revision, before, 'declining writes no revision');
    // An unchanged list is still a save: callers decide whether a revision is wanted by returning undefined.
    const same = service.update(snapshot => snapshot.blocks);
    assert.deepEqual([same.ok, same.saved, same.snapshot.revision], [true, true, before + 1]);
    const added = service.update(snapshot => [...snapshot.blocks, block({ engine: 'codex', by: 'user' })]);
    assert.equal(added.snapshot.blocks.length, 1);
    assert.equal(f.policy.snapshot().blocks.length, 1);
    assert.deepEqual(logs, []);
  } finally { f.cleanup(); }
});

test('PolicyBlockService retries after a revision conflict with a fresh read, per the caller\'s attempts and wording', () => {
  const f = store();
  try {
    let conflicts = 0;
    const racing: BlockPolicy = {
      snapshot: () => f.policy.snapshot(),
      save: input => {
        if (conflicts === 0) {
          conflicts += 1;
          const current = f.policy.snapshot();
          f.policy.save({ revision: current.revision, config: current.config, blocks: [...current.blocks, block({ engine: 'codex', reason: '并发', by: 'user' })] });
          throw new Error('Settings changed; reload before saving');
        }
        return f.policy.save(input);
      },
    };
    const logs: string[] = [];
    const service = new PolicyBlockService(() => racing, { log: message => logs.push(message) });
    const seen: number[] = [];
    const result = service.update(snapshot => { seen.push(snapshot.blocks.length); return [...snapshot.blocks, block({ engine: 'codex', worker: 'codex_worker', by: STALL_BLOCK_BY })]; }, { attempts: 2, failureLabel: 'Test change' });
    assert.deepEqual(seen, [0, 1], 'the second attempt re-read what the other writer added');
    assert.equal(result.ok, true);
    assert.deepEqual(f.policy.snapshot().blocks.map(item => item.by), ['user', STALL_BLOCK_BY], 'the concurrent block survived');
    assert.deepEqual(logs, ['Test change will be retried: Settings changed; reload before saving']);
  } finally { f.cleanup(); }
});

test('PolicyBlockService reports a failed update by log or by throwing, never both', () => {
  const f = store();
  try {
    const broken: BlockPolicy = { snapshot: () => f.policy.snapshot(), save: () => { throw new Error('disk is full'); } };
    const logs: string[] = [];
    const logged = new PolicyBlockService(() => broken, { log: message => logs.push(message) });
    const result = logged.update(snapshot => snapshot.blocks, { attempts: 2, failureLabel: 'Probe change' });
    assert.deepEqual([result.ok, result.saved], [false, false]);
    assert.deepEqual(logs, ['Probe change will be retried: disk is full', 'Probe change was not saved: disk is full']);
    const thrown = new PolicyBlockService(() => broken, { log: message => logs.push(message) });
    assert.throws(() => thrown.update(snapshot => snapshot.blocks), /disk is full/);
    assert.equal(logs.length, 2, 'a throwing caller handles the error itself');
    let attempts = 0;
    const flaky: BlockPolicy = { snapshot: () => f.policy.snapshot(), save: () => { attempts += 1; throw new Error('still failing'); } };
    assert.throws(() => new PolicyBlockService(() => flaky).update(snapshot => snapshot.blocks, { attempts: 3 }), /still failing/);
    assert.equal(attempts, 3, 'every attempt was made before the last error propagated');
    assert.throws(() => thrown.update(() => { throw new Error('conflict'); }), /conflict/, 'an error from the mutation itself is reported the same way');
  } finally { f.cleanup(); }
});

test('clearEngine drops every block naming the engine, whatever wrote it, and nothing of other engines', () => {
  const f = store();
  try {
    const service = new PolicyBlockService(() => f.policy);
    const base = f.policy.snapshot();
    f.policy.save({
      revision: base.revision, config: base.config,
      blocks: [
        block({ engine: 'codex', by: STALL_BLOCK_BY }),
        block({ engine: 'codex', worker: 'codex_worker', by: VENDOR_BLOCK_BY }),
        block({ engine: 'codex', model: 'gpt-6.1-sol', by: 'user' }),
        block({ engine: 'codex', model: 'gpt-x', worker: 'codex_worker', by: FREE_PROBE_BLOCK_BY }),
        block({ engine: 'claude', by: 'user' }),
        block({ engine: 'claude', model: 'sonnet', by: quotaBlockBy('claude') }),
      ],
    });
    const revision = f.policy.snapshot().revision;
    assert.throws(() => service.clearEngine('ghost'), /Unknown engine ghost/);
    assert.equal(f.policy.snapshot().revision, revision, 'an unknown engine writes nothing');
    assert.equal(service.clearEngine('codex'), 4);
    assert.deepEqual(f.policy.snapshot().blocks.map(item => item.engine), ['claude', 'claude']);
    assert.equal(f.policy.snapshot().revision, revision + 1);
    assert.equal(service.clearEngine('codex'), 0, 'nothing to clear is not a write');
    assert.equal(f.policy.snapshot().revision, revision + 1);
  } finally { f.cleanup(); }
});

test('clearEngine fails loudly when the removal cannot be saved, and notifyChanged is the caller\'s signal', () => {
  const f = store();
  try {
    const base = f.policy.snapshot();
    f.policy.save({ revision: base.revision, config: base.config, blocks: [block({ engine: 'codex', by: 'user' })] });
    const broken: BlockPolicy = { snapshot: () => f.policy.snapshot(), save: () => { throw new Error('disk is full'); } };
    let notified = 0;
    const service = new PolicyBlockService(() => broken, { log: () => {}, onChanged: () => { notified += 1; } });
    assert.throws(() => service.clearEngine('codex', { attempts: 2, failureLabel: 'Unblock' }), /Blocks for codex could not be removed/);
    assert.equal(f.policy.snapshot().blocks.length, 1);
    assert.equal(notified, 0, 'a failed removal announces nothing');
    service.notifyChanged();
    assert.equal(notified, 1);
  } finally { f.cleanup(); }
});

test('MonitorLifecycle collapses ticks, fences work that awaited past a stop and aborts probes in flight', async () => {
  let ready = true;
  const lifecycle = new MonitorLifecycle(() => ready);
  let runs = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = lifecycle.coalesce(async () => { runs += 1; await gate; });
  const second = lifecycle.coalesce(async () => { runs += 1; });
  assert.equal(first, second, 'a tick in flight absorbs the next one');
  assert.equal(lifecycle.inFlight, first);
  const fence = lifecycle.generation;
  assert.equal(lifecycle.writable(fence), true);
  ready = false;
  assert.equal(lifecycle.writable(fence), false, 'the app gate closes the write window');
  ready = true;
  let signalSeen: AbortSignal | undefined;
  const probe = lifecycle.abortable(signal => new Promise<string>(resolve => { signalSeen = signal; signal.addEventListener('abort', () => resolve('aborted answer')); }), () => 'failed');
  const stopping = lifecycle.stop();
  assert.equal(signalSeen!.aborted, true, 'stop aborts the probe in flight');
  assert.deepEqual(await probe, { value: 'aborted answer', aborted: true });
  assert.equal(lifecycle.writable(fence), false, 'work that started before the stop never writes');
  assert.equal(lifecycle.stopped, true);
  release();
  await stopping;
  assert.equal(runs, 1);
  assert.equal(lifecycle.inFlight, undefined);
  const refused = await lifecycle.abortable(() => Promise.reject(new Error('boom')), error => `fallback ${(error as Error).message}`);
  assert.deepEqual(refused, { value: 'fallback boom', aborted: false });
});

test('MonitorLifecycle start re-arms a stopped monitor and ticks on its interval', async () => {
  const lifecycle = new MonitorLifecycle();
  await lifecycle.stop();
  assert.equal(lifecycle.writable(lifecycle.generation), false);
  let ticks = 0;
  const errors: unknown[] = [];
  lifecycle.start(5, async () => { ticks += 1; if (ticks === 2) throw new Error('tick failed'); }, error => errors.push(error), true);
  assert.equal(ticks, 1, 'the immediate first tick ran');
  assert.equal(lifecycle.writable(lifecycle.generation), true);
  await new Promise(resolve => setTimeout(resolve, 40));
  await lifecycle.stop();
  assert.ok(ticks >= 2);
  assert.equal(errors.length >= 1 && (errors[0] as Error).message === 'tick failed', true, 'a failing tick is reported, not thrown');
  const after = ticks;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ticks, after, 'no tick after stop');
});
