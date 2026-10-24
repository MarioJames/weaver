import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import type { ManagedProcess } from '../../src/main/adapters/worker';
import { CommandHandler } from '../../src/main/commands';
import { workerLoad } from '../../src/main/application/scheduling/dispatch';
import { PolicyStore } from '../../src/main/policy/store';
import { OwnerLaunchError, type OwnerLaunchInput, type OwnerLaunchResult } from '../../src/main/owner-host';
import type { LogicalOwner } from '../../src/shared/contracts/owners';
import type { Task, TaskInput } from '../../src/shared/contracts/tasks';
import { metadataOf, setMetadataOf } from '../helpers/store-metadata';

/** A worker that stays alive until Weaver stops it: these tests measure who holds a slot, not what a process prints. */
function heldProcess(): ManagedProcess {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const emitter = new EventEmitter();
  let closed = false;
  // A real worker exits on a later tick, so a cancellation is observable as 'cancelling' before the slot is released.
  return Object.assign(emitter, {
    stdout, stderr, pid: 7,
    kill() { if (!closed) { closed = true; setImmediate(() => emitter.emit('close', null, 'SIGTERM')); } return true; },
  }) as ManagedProcess;
}

/** Real Herdr is never reachable from tests: an attached instance stays registration metadata. */
const blockedLaunch = (input: OwnerLaunchInput): OwnerLaunchResult => { throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `No owner launcher in this test: ${input.taskId}`); };

const ownerRef = { name: 'legacy', transport: 'herdr-visible' as const, session: 'reference', pane: 'reference' };

function setup(dir = mkdtempSync(join(tmpdir(), 'weaver-owner-instance-'))) {
  const store = new TaskStore(join(dir,'weaver.db'));
  const manager = new TaskManager(store, { id: 'mock-jsonl', start: () => heldProcess() }, () => {}, undefined, error => { throw error; });
  const policy = new PolicyStore(join(dir,'weaver.db'));
  const handler = new CommandHandler(manager, policy, blockedLaunch, () => false);
  const raw = (command: string, args: Record<string, unknown> = {}, commandId = randomUUID()) => handler.handle({ apiVersion: 'weaver.v1', commandId, command, args });
  const call = (command: string, args: Record<string, unknown> = {}, commandId = randomUUID()): any => { const response = raw(command, args, commandId); assert.equal(response.ok, true, JSON.stringify(response)); return response.data; };
  const attach = (name: string, session: string, profileId = 'codex_owner', commandId = randomUUID()) => call('owners.attach', { name, profileId, session }, commandId) as LogicalOwner;
  const parallel = (value: number, profile = 'codex_owner') => { const s = policy.snapshot(); s.config.owners[profile].max_parallel = value; policy.save({ revision: s.revision, config: s.config, blocks: [] }); };
  const taskOn = (ownerId: string, title = 'Held') => call('tasks.create', { title, instruction: 'Explicit mock fixture', ownerId }) as Task;
  const legacyTask = (title = 'Unbound') => call('tasks.create', { title, instruction: 'Explicit mock fixture', owner: ownerRef }) as Task;
  /** An unbound task names its profile at dispatch; a bound one is already tied to an instance of a profile. */
  const dispatch = (task: Task, profile?: string) => call('workers.spawn', { taskId: task.id, ...(profile === undefined ? {} : { owner: profile }), provider: 'mock-jsonl' });
  const waitFor = async (id: string, status: Task['status']) => {
    for (let i = 0; i < 100 && store.get(id).status !== status; i++) await new Promise(resolve => setTimeout(resolve, 10));
    return store.get(id);
  };
  return {
    dir, store, manager, policy, handler, raw, call, attach, parallel, taskOn, legacyTask, dispatch, waitFor,
    owners: () => metadataOf(store).owners as LogicalOwner[],
    instances: () => call('owners.list').owners as (LogicalOwner & { runningTaskCount: number; host: { ownerId: string; session?: string } })[],
    close: async (purge = true) => { handler.draining = true; await manager.shutdown(); if (purge) rmSync(dir, { recursive: true, force: true }); },
  };
}

test('an exact profile, name and session tuple is one durable instance across command IDs and a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-owner-instance-'));
  const tuple: Record<string, unknown> = { name: 'Mario', profileId: 'codex_owner', session: 'pane-7' };
  let instanceId = '';
  const first = setup(dir);
  try {
    const original = first.call('owners.attach', tuple);
    instanceId = original.id;
    assert.equal(original.mode, 'manual');
    assert.equal(original.session, 'pane-7', 'the caller label is on the instance, not only in its host evidence');
    assert.equal(original.host.session, 'pane-7');
    assert.equal(original.host.verified, false, 'registration never claims a live host was verified');
    // A repeat under a fresh command ID is not a replayed receipt: it re-registers nothing.
    assert.deepEqual(first.call('owners.attach', tuple), original);
    assert.equal(first.owners().length, 1);
    assert.equal(first.call('owners.attach', { ...tuple, pane: 'caller-pane' }).id, instanceId, 'the pane is unverified metadata, not part of the instance');
    assert.equal(first.instances()[0].id, instanceId);
  } finally { await first.close(false); }
  const second = setup(dir);
  try {
    assert.equal(second.owners()[0].session, 'pane-7', 'the session label survives a store reload');
    assert.equal(second.call('owners.attach', tuple).id, instanceId);
    assert.equal(second.owners().length, 1, 'a restart does not turn one owner session into two instances');
    // Inputs are validated before the registry is read, so a malformed repeat cannot masquerade as the stored instance.
    assert.equal(second.raw('owners.attach', { ...tuple, session: 'p'.repeat(121) }).error?.code, 'INVALID_REQUEST');
    assert.equal(second.raw('owners.attach', { ...tuple, session: 42 }).error?.code, 'INVALID_REQUEST');
    assert.equal(second.raw('owners.attach', { ...tuple, provider: 'codex' }).error?.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(second.owners().length, 1);
  } finally { await second.close(); }
});

test('an old manual instance keeps its stored session and binds work to itself after a reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-owner-instance-'));
  const f = setup(dir);
  let boundTo = '';
  try {
    const stored = f.attach('Legacy pane', 'session-old');
    // A record written before the label was a durable field carries it only in its own host evidence.
    const meta = metadataOf(f.store);
    meta.owners = meta.owners.map(owner => ({ ...owner, session: undefined }));
    setMetadataOf(f.store, meta);
    boundTo = f.call('tasks.create', { title: 'Bound', instruction: 'fixture', ownerId: stored.id }).id;
    assert.equal(f.store.get(boundTo).ownerId, stored.id);
  } finally { await f.close(false); }
  const reopened = setup(dir);
  try {
    const restored = reopened.owners()[0];
    assert.equal(restored.session, 'session-old', 'the stored session is read back, not discarded with the old record');
    assert.equal((restored.host as { ownerId?: string } | undefined)?.ownerId, restored.id, 'its host registration survives alongside the label');
    const again = reopened.call('owners.attach', { name: 'Legacy pane', profileId: 'codex_owner', session: 'session-old' });
    assert.equal(again.id, restored.id, 'a reloaded instance is still the same instance');
    assert.equal(reopened.owners().length, 1);
    assert.equal(reopened.call('tasks.get', { taskId: boundTo }).ownerId, restored.id);
  } finally { await reopened.close(); }
});

test('a changed session, name or profile is a different instance, while implicit registrations stay separate', async () => {
  const f = setup();
  try {
    const base = f.attach('Mario', 'pane-7');
    assert.notEqual(f.attach('Mario', 'pane-8').id, base.id, 'another session of the same profile is another owner');
    assert.notEqual(f.attach('Luigi', 'pane-7').id, base.id, 'a different caller label is another owner');
    assert.notEqual(f.attach('Mario', 'pane-7', 'claude_owner').id, base.id, 'the profile is part of the identity');
    assert.equal(f.owners().length, 4);
    // Spawn is an explicit registration: it never collapses onto an attached instance.
    assert.notEqual(f.call('owners.spawn', { name: 'Mario', profileId: 'codex_owner', session: 'pane-7' }).id, base.id);
    // Nor does every guided task create share one instance.
    const one = f.call('tasks.create', { title: 'One', goal: 'fixture', ownerProfileId: 'codex_owner' });
    const two = f.call('tasks.create', { title: 'Two', goal: 'fixture', ownerProfileId: 'codex_owner' });
    assert.notEqual(one.ownerId, two.ownerId);
    const mocks = [f.call('owners.spawn', { name: 'demo', profileId: 'codex_owner', provider: 'mock' }), f.call('owners.spawn', { name: 'demo', profileId: 'codex_owner', provider: 'mock' })];
    assert.deepEqual(mocks.map(owner => owner.mode), ['mock', 'mock']);
    assert.notEqual(mocks[0].id, mocks[1].id, 'explicit mock registration keeps its own fixture identity');
    assert.deepEqual(mocks.map(owner => owner.session), [undefined, undefined], 'a mock fixture has no caller session');
  } finally { await f.close(); }
});

test('attach deduplicates existing instances and admits new ones beyond the former JSON limit', async () => {
  const f = setup();
  try {
    const meta = metadataOf(f.store);
    for (let i = 0; i < 199; i++) meta.owners.push({ id: randomUUID(), name: `seed ${i}`, profileId: 'codex_owner', mode: 'manual', state: 'attached', createdAt: new Date().toISOString(), session: `seed-${i}` });
    setMetadataOf(f.store, meta);
    const last = f.attach('Full house', 'pane-last');
    assert.equal(f.owners().length, 200);
    assert.deepEqual(f.attach('Full house', 'pane-last'), last, 'a duplicate consumes no room in the registry');
    assert.equal(f.owners().length, 200);
    assert.equal(f.raw('owners.attach', { name: 'Fresh', profileId: 'codex_owner', session: 'pane-new' }).ok, true);
    assert.equal(f.owners().length, 201);
  } finally { await f.close(); }
});

test('two instances of one profile hold their own slots through admission, queue and pump', async () => {
  const f = setup();
  try {
    f.parallel(1);
    const a = f.attach('Pane A', 'session-a');
    const b = f.attach('Pane B', 'session-b');
    const [a1, a2, b1] = [f.taskOn(a.id, 'A first'), f.taskOn(a.id, 'A second'), f.taskOn(b.id, 'B first')];
    assert.equal(f.dispatch(a1).status, 'queued', 'admission is durable before the pump starts it');
    await f.waitFor(a1.id, 'running');
    const waiting = f.dispatch(a2);
    assert.equal(waiting.status, 'queued');
    assert.equal(waiting.scheduled, true, 'instance A is full');
    assert.match(waiting.queueReason?.message ?? '', /^Owner instance Pane A of profile codex_owner is at its current concurrency limit \(1\)/);
    assert.equal(f.dispatch(b1).status, 'queued', 'A being full says nothing about B');
    await f.waitFor(b1.id, 'running');
    assert.deepEqual(f.instances().map(owner => [owner.name, owner.runningTaskCount]), [['Pane A', 1], ['Pane B', 1]]);
    f.call('tasks.cancel', { taskId: a1.id });
    assert.equal((await f.waitFor(a2.id, 'running')).status, 'running', 'the released slot goes to the same instance');
    assert.equal(f.store.get(b1.id).status, 'running');
    assert.equal(f.dispatch(f.taskOn(a.id, 'A third')).scheduled, true, 'B never spends a slot of A');
  } finally { await f.close(); }
});

test('an unbound legacy task keeps its own profile group and never spends an attached instance slot', async () => {
  const f = setup();
  try {
    f.parallel(1);
    const legacyFirst = f.legacyTask('Legacy first');
    f.dispatch(legacyFirst, 'codex_owner');
    await f.waitFor(legacyFirst.id, 'running');
    const attached = f.attach('Pane A', 'session-a');
    const boundFirst = f.taskOn(attached.id, 'Bound first');
    f.dispatch(boundFirst);
    await f.waitFor(boundFirst.id, 'running');
    assert.equal(f.store.get(boundFirst.id).status, 'running', 'a profile-level legacy run does not fill the instance');
    assert.equal(f.dispatch(f.legacyTask('Legacy second'), 'codex_owner').scheduled, true, 'legacy work still shares one profile group');
    assert.deepEqual(f.instances().map(owner => owner.runningTaskCount), [1]);
    assert.equal(f.dispatch(f.taskOn(attached.id, 'Bound second')).scheduled, true, 'the instance limit still binds its own work');
  } finally { await f.close(); }
});

test('weighted worker load stays global across owner instances', async () => {
  const f = setup();
  try {
    const s = f.policy.snapshot();
    s.config.workers.codex_alt_worker = { enabled: true, channel: "default_codex", model: 'gpt-6.1-sol', effort: 'high', description: 'Second codex worker for balancing.' };
    s.config.owners.codex_owner.workers = [...s.config.owners.codex_owner.workers, 'codex_alt_worker'];
    f.policy.save({ revision: s.revision, config: s.config, blocks: [] });
    const a = f.attach('Pane A', 'session-a');
    const b = f.attach('Pane B', 'session-b');
    const onA = f.taskOn(a.id); f.dispatch(onA); await f.waitFor(onA.id, 'running');
    assert.equal(f.store.get(onA.id).dispatch?.worker, 'codex_worker', 'an idle instance starts at the higher-weight worker');
    const onB = f.taskOn(b.id); f.dispatch(onB); await f.waitFor(onB.id, 'running');
    assert.equal(f.store.get(onB.id).dispatch?.worker, 'codex_alt_worker', 'instance B sees instance A load and takes the free worker');
    assert.deepEqual(workerLoad(f.store.list()), { codex_worker: 1, codex_alt_worker: 1 });
    const third = f.taskOn(a.id); f.dispatch(third); await f.waitFor(third.id, 'running');
    assert.equal(f.store.get(third.id).dispatch?.worker, 'codex_worker', 'the least loaded worker wins regardless of which instance holds the other run');
    assert.deepEqual(workerLoad(f.store.list()), { codex_worker: 2, codex_alt_worker: 1 });
  } finally { await f.close(); }
});

test('runningTaskCount counts running and cancelling work bound to that instance', async () => {
  const f = setup();
  try {
    f.parallel(2);
    const a = f.attach('Pane A', 'session-a');
    f.attach('Pane B', 'session-b');
    const busyTask = f.taskOn(a.id, 'Running'); f.dispatch(busyTask); await f.waitFor(busyTask.id, 'running');
    const stoppingTask = f.taskOn(a.id, 'Stopping'); f.dispatch(stoppingTask); await f.waitFor(stoppingTask.id, 'running');
    const busy = f.store.get(busyTask.id); const stopping = f.store.get(stoppingTask.id);
    assert.deepEqual([busy.status, stopping.status], ['running', 'running']);
    const cancelled = f.call('tasks.cancel', { taskId: stopping.id });
    assert.equal(cancelled.status, 'cancelling');
    // Nothing is awaited between the request and this read: the worker is still holding its slot while exiting.
    const listed = f.instances();
    assert.equal(listed.find(owner => owner.id === a.id)?.runningTaskCount, 2, 'a cancelling run has not released its slot yet');
    assert.equal(listed.find(owner => owner.name === 'Pane B')?.runningTaskCount, 0, 'another instance is unaffected');
    const single = f.call('owners.get', { ownerId: a.id });
    assert.equal(single.runningTaskCount, 2);
    assert.equal(single.session, 'session-a');
  } finally { await f.close(); }
});

test('queued and terminal work hold no slot of their instance', async () => {
  const f = setup();
  try {
    f.parallel(1);
    const a = f.attach('Pane A', 'session-a');
    const busyTask = f.taskOn(a.id, 'Busy'); f.dispatch(busyTask); await f.waitFor(busyTask.id, 'running');
    const busy = f.store.get(busyTask.id);
    const waiting = f.dispatch(f.taskOn(a.id, 'Waiting'));
    assert.equal(waiting.scheduled, true);
    assert.equal(f.instances().find(owner => owner.id === a.id)?.runningTaskCount, 1, 'the scheduled task holds no slot');
    f.call('tasks.cancel', { taskId: busy.id });
    assert.equal((await f.waitFor(waiting.id, 'running')).status, 'running');
    assert.equal(f.store.get(busy.id).status, 'cancelled');
    assert.equal(f.instances().find(owner => owner.id === a.id)?.runningTaskCount, 1, 'the cancelled task holds no slot either');
  } finally { await f.close(); }
});

test('every owner summary keeps the identity needed to tell two instances apart', async () => {
  const f = setup();
  try {
    const a = f.attach('Pane A', 'session-a');
    const b = f.attach('Pane B', 'session-b');
    const listed = f.instances();
    assert.deepEqual(
      listed.map(owner => [owner.id, owner.name, owner.profileId, owner.session, owner.mode, owner.state, owner.host.ownerId]),
      [[a.id, 'Pane A', 'codex_owner', 'session-a', 'manual', 'attached', a.id], [b.id, 'Pane B', 'codex_owner', 'session-b', 'manual', 'attached', b.id]]
    );
    const snapshot = f.call('sync.snapshot');
    assert.deepEqual(snapshot.owners.map((owner: TaskInput['owner'] & { id: string }) => [owner.id, owner.session]), [[a.id, 'session-a'], [b.id, 'session-b']]);
    const caps = f.call('capabilities.get');
    assert.equal(caps.capacity.unit, 'owner-instance');
    assert.equal(caps.maxParallel, Object.values(f.policy.snapshot().config.owners).filter(owner => owner.enabled).reduce((sum: number, owner) => sum + owner.max_parallel, 0));
  } finally { await f.close(); }
});

test('attach takes an optional title and a repeat attach updates it only when a new one is sent', async () => {
  const f = setup();
  try {
    const bare = f.attach('Pane A', 'session-a');
    assert.equal(bare.title, undefined, 'a titleless attach registers no title');
    const titled = f.call('owners.attach', { name: 'Pane A', profileId: 'codex_owner', session: 'session-a', title: '  Refactor the owner store  ' }) as LogicalOwner;
    assert.equal(titled.id, bare.id, 'the title does not make it another instance');
    assert.equal(titled.title, 'Refactor the owner store', 'the title is trimmed');
    // A repeat attach without title keeps the stored value; name semantics and dedupe are unchanged.
    assert.equal(f.call('owners.attach', { name: 'Pane A', profileId: 'codex_owner', session: 'session-a' }).title, 'Refactor the owner store');
    assert.equal(f.owners().length, 1);
    assert.equal(f.call('owners.attach', { name: 'Pane A', profileId: 'codex_owner', session: 'session-a', title: 'Second topic' }).title, 'Second topic');
    assert.equal(f.owners()[0].name, 'Pane A');
    assert.equal(f.owners()[0].session, 'session-a');
    // A malformed title never reaches the stored instance.
    const rejected = f.raw('owners.attach', { name: 'Pane A', profileId: 'codex_owner', session: 'session-a', title: '' });
    assert.equal(rejected.error?.code, 'INVALID_REQUEST');
    assert.equal(f.owners()[0].title, 'Second topic');
  } finally { await f.close(); }
});

test('owners describe sets one instance title, validates it and replays its receipt', async () => {
  const f = setup();
  try {
    const a = f.attach('Pane A', 'session-a');
    f.attach('Pane B', 'session-b');
    const updated = f.call('owners.describe', { ownerId: a.id, title: '  Board title  ' }) as LogicalOwner & { runningTaskCount: number };
    assert.equal(updated.title, 'Board title', 'the title is trimmed');
    assert.equal(updated.session, 'session-a', 'describe moves nothing but the title');
    assert.equal(updated.runningTaskCount, 0);
    assert.equal(f.owners().find(owner => owner.id === a.id)?.title, 'Board title');
    assert.equal(f.owners().find(owner => owner.name === 'Pane B')?.title, undefined, 'another instance is untouched');
    assert.equal(f.instances().find(owner => owner.id === a.id)?.title, 'Board title', 'owners list returns the title');
    // A mock fixture instance is described the same way.
    const mock = f.call('owners.spawn', { name: 'demo', profileId: 'codex_owner', provider: 'mock' }) as LogicalOwner;
    assert.equal(f.call('owners.describe', { ownerId: mock.id, title: 'Mock topic' }).title, 'Mock topic');
    // Unknown ownerId fails exactly like owners get; bad titles are INVALID_REQUEST naming the field.
    assert.equal(f.raw('owners.describe', { ownerId: randomUUID(), title: 'Nope' }).error?.code, 'NOT_FOUND');
    assert.equal(f.raw('owners.get', { ownerId: randomUUID() }).error?.code, 'NOT_FOUND');
    for (const bad of ['', '   ', 'x'.repeat(121)]) {
      const rejected = f.raw('owners.describe', { ownerId: a.id, title: bad });
      assert.equal(rejected.error?.code, 'INVALID_REQUEST');
      assert.match(rejected.error?.message ?? '', /title/);
    }
    assert.equal(f.call('owners.get', { ownerId: a.id }).title, 'Board title', 'a rejected describe changed nothing');
    // The same command ID with the same arguments returns the original receipt.
    const commandId = randomUUID();
    const first = f.raw('owners.describe', { ownerId: a.id, title: 'Replayed' }, commandId);
    assert.equal(first.ok, true);
    assert.deepEqual(f.raw('owners.describe', { ownerId: a.id, title: 'Replayed' }, commandId), first);
    assert.equal(f.call('owners.get', { ownerId: a.id }).title, 'Replayed');
  } finally { await f.close(); }
});
