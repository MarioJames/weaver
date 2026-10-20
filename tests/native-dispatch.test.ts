import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/main/store';
import { TaskManager } from '../src/main/manager';
import { CommandHandler } from '../src/main/commands';
import { PolicyStore } from '../src/main/policy/store';
import { workerInstruction } from '../src/main/adapters/instruction';
import type { WorkerAdapter } from '../src/main/adapters/worker';
import type { Task } from '../src/shared/types';
import type { WorkPackage } from '../src/shared/commands';

/** A real (non-mock) adapter that must never be asked to launch a process for native work. */
const launches: string[] = [];
const adapter = { id: 'routing', canLaunchReal: () => false, start: (task: { id: string }) => { launches.push(task.id); throw new Error('native work must not launch a process'); } } as unknown as WorkerAdapter;

function setup() {
  launches.length = 0;
  const dir = mkdtempSync(join(tmpdir(), 'weaver-native-'));
  const store = new TaskStore(join(dir,'weaver.db'));
  const manager = new TaskManager(store, adapter);
  const policy = new PolicyStore(join(dir,'weaver.db'));
  const handler = new CommandHandler(manager, policy);
  const raw = (command: string, args: Record<string, unknown> = {}) => handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command, args });
  const call = (command: string, args: Record<string, unknown> = {}): any => { const r = raw(command, args); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  // Without an ownerId each create registers its own owner instance; passing one keeps the work on that instance.
  const task = (ownerId?: string) => call('tasks.create', { title: 'Native', goal: 'edit a file', workspace: dir, ...(ownerId === undefined ? { ownerProfileId: 'claude_owner' } : { ownerId }) });
  return { dir, store, policy, call, raw, task, close: async () => { handler.draining = true; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a worker on the owner engine runs natively: no process, task running until the owner reports', async () => {
  const f = setup();
  try {
    const t = f.task();
    const started = f.call('workers.spawn', { taskId: t.id });
    assert.equal(started.status, 'running');
    assert.equal(started.dispatch.worker, 'claude_worker');
    assert.equal(started.dispatch.execution, 'native');
    assert.equal(started.dispatch.model, 'sonnet');
    assert.equal(started.run.execution, 'native');
    assert.deepEqual(launches, []);
    const done = f.call('workers.complete', { taskId: t.id, expectedRevision: f.store.get(t.id).revision, outcome: 'completed', summary: 'Edited the file', artifacts: [{ name: 'notes.md', mediaType: 'text/markdown', content: '# done' }] });
    assert.equal(done.status, 'completed');
    assert.equal(done.summary, 'Edited the file');
    const result = f.call('tasks.results', { taskId: t.id });
    assert.equal(result.execution, 'completed');
    assert.equal(result.artifacts[0].name, 'notes.md');
    const ack = f.call('results.ack', { taskId: t.id, manifestDigest: result.manifestDigest, expectedRevision: f.store.get(t.id).revision });
    assert.equal(ack.delivery, 'acknowledged');
    assert.equal(f.call('reviews.submit', { taskId: t.id, manifestDigest: result.manifestDigest, decision: 'accepted', expectedRevision: f.store.get(t.id).revision }).acceptance, 'accepted');
  } finally { await f.close(); }
});

test('a failed native report is recorded as failed with its reason', async () => {
  const f = setup();
  try {
    const t = f.task();
    f.call('workers.spawn', { taskId: t.id });
    const failed = f.call('workers.complete', { taskId: t.id, outcome: 'failed', summary: 'Tests did not pass' });
    assert.equal(failed.status, 'failed');
    assert.match(f.store.get(t.id).events.at(-1)!.message, /Tests did not pass/);
  } finally { await f.close(); }
});

test('only a running native task accepts a report, and only once', async () => {
  const f = setup();
  try {
    const t = f.task();
    assert.equal(f.raw('workers.complete', { taskId: t.id, outcome: 'completed', summary: 'x' }).error?.code, 'INVALID_STATE');
    f.call('workers.spawn', { taskId: t.id });
    assert.equal(f.raw('workers.complete', { taskId: t.id, outcome: 'done', summary: 'x' }).error?.code, 'INVALID_REQUEST');
    assert.equal(f.raw('workers.complete', { taskId: t.id, outcome: 'completed', summary: 'x', artifacts: [{ name: '../escape', mediaType: 'text/plain', content: 'x' }] }).ok, false);
    f.call('workers.complete', { taskId: t.id, outcome: 'completed', summary: 'x' });
    assert.equal(f.raw('workers.complete', { taskId: t.id, outcome: 'completed', summary: 'again' }).error?.code, 'INVALID_STATE');
  } finally { await f.close(); }
});

test('a worker on another engine is not native and still needs its launcher', async () => {
  const f = setup();
  try {
    const t = f.task();
    const r = f.raw('workers.spawn', { taskId: t.id, worker: 'codex_worker' });
    assert.equal(r.error?.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(f.store.get(t.id).status, 'queued');
  } finally { await f.close(); }
});

test('native work holds an owner slot, can be cancelled, and survives a restart', async () => {
  const f = setup();
  try {
    const s = f.policy.snapshot(); s.config.owners.claude_owner.max_parallel = 1; f.policy.save({ revision: s.revision, config: s.config, blocks: [] });
    const a = f.task(); const b = f.task(a.ownerId);
    assert.equal(b.ownerId, a.ownerId, 'one owner instance holds one slot budget');
    f.call('workers.spawn', { taskId: a.id });
    assert.equal(f.call('workers.spawn', { taskId: b.id }).scheduled, true);
    const reloaded = new TaskStore(join(f.dir,'weaver.db')); reloaded.recover();
    assert.equal(reloaded.get(a.id).status, 'running');
    assert.equal(f.call('tasks.cancel', { taskId: a.id }).status, 'cancelled');
    for (let i = 0; i < 50 && f.store.get(b.id).status !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.store.get(b.id).status, 'running');
    assert.equal(f.store.get(b.id).run?.execution, 'native');
    assert.deepEqual(launches, []);
  } finally { await f.close(); }
});

test('a native dispatch hands the owner the same instruction a real worker would get', async () => {
  const f = setup();
  try {
    const t = f.task();
    const started = f.call('workers.spawn', { taskId: t.id });
    assert.equal(started.dispatch.execution, 'native');
    const stored = f.store.get(t.id);
    const pkg = f.store.getMetadata().packages.find(p => p.id === stored.packageId)!;
    assert.equal(started.next.action, 'run_subagent');
    assert.equal(started.next.model, 'sonnet');
    assert.equal(started.next.effort, 'high');
    // Byte for byte the frozen worker contract, so a native subagent is no different from a launched one.
    assert.equal(started.next.prompt, workerInstruction(stored, pkg));
    assert.match(started.next.prompt, /You are a Weaver worker executing one frozen work package/);
    assert.equal(started.next.then, `weaver workers complete --task-id ${t.id} --input report.json`);
    // An owner that lost the spawn response recovers the same handoff from the running task.
    assert.deepEqual(f.call('tasks.get', { taskId: t.id }).next, started.next);
    f.call('workers.complete', { taskId: t.id, outcome: 'completed', summary: 'Edited the file' });
    assert.equal(f.call('tasks.get', { taskId: t.id }).next, undefined);
  } finally { await f.close(); }
});

test('native work that has not been admitted into a slot is only waited for', async () => {
  const f = setup();
  try {
    const s = f.policy.snapshot();
    s.config.owners.claude_owner.max_parallel = 1;
    f.policy.save({ revision: s.revision, config: s.config, blocks: [] });
    const a = f.task(); const b = f.task(a.ownerId);
    assert.equal(b.ownerId, a.ownerId, 'a queued slot is the same owner instance waiting for itself');
    assert.equal(f.call('workers.spawn', { taskId: a.id }).next.action, 'run_subagent');
    const queued = f.call('workers.spawn', { taskId: b.id });
    assert.equal(queued.scheduled, true);
    assert.equal(queued.dispatch.execution, 'native');
    assert.deepEqual(queued.next, { action: 'wait', command: `weaver tasks wait --task-id ${b.id}` });
    assert.equal(f.call('tasks.get', { taskId: b.id }).next, undefined);
  } finally { await f.close(); }
});

test('two instances of one profile hold separate native slots and a cancellation frees only its own instance', async () => {
  const f = setup();
  try {
    const s = f.policy.snapshot(); s.config.owners.claude_owner.max_parallel = 1;
    f.policy.save({ revision: s.revision, config: s.config, blocks: [] });
    const a = f.call('owners.attach', { name: 'pane A', profileId: 'claude_owner', session: 'session-a' });
    const b = f.call('owners.attach', { name: 'pane B', profileId: 'claude_owner', session: 'session-b' });
    const [a1, a2, b1] = [f.task(a.id), f.task(a.id), f.task(b.id)];
    assert.equal(f.call('workers.spawn', { taskId: a1.id }).status, 'running');
    const waiting = f.call('workers.spawn', { taskId: a2.id });
    assert.equal(waiting.scheduled, true, 'instance A is full');
    assert.match(waiting.queueReason.message, /pane A/);
    assert.equal(f.call('workers.spawn', { taskId: b1.id }).status, 'running', 'instance B has its own slot while A is full');
    assert.deepEqual(f.call('owners.list').owners.map((owner: { runningTaskCount: number }) => owner.runningTaskCount), [1, 1]);
    assert.equal(f.call('tasks.cancel', { taskId: a1.id }).status, 'cancelled');
    for (let i = 0; i < 50 && f.store.get(a2.id).status !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.store.get(a2.id).status, 'running', 'A releases a slot to its own waiting work');
    assert.equal(f.store.get(b1.id).status, 'running');
    assert.equal(f.store.get(b1.id).run?.execution, 'native');
    assert.deepEqual(launches, []);
  } finally { await f.close(); }
});

test('the frozen prompt carries only the work package criteria, never the root task criteria', () => {
  const task = { workspace: '/repo', title: 'Native', instruction: 'edit a file', owner: { profileId: 'claude_owner', model: 'sonnet', effort: 'high' }, acceptanceCriteria: ['', 'shared criterion', 'task-only criterion'], constraints: ['stay minimal'], dispatch: { execution: 'native', worker: 'claude_worker', model: 'sonnet', effort: 'high', workspace: '/repo' }, id: 't-1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', status: 'running', progress: 0, events: [], artifacts: [] } as unknown as Task;
  const pkg: WorkPackage = { id: 'pkg-1', taskId: 't-1', revision: 1, instruction: 'edit a file', scope: ['src/**'], acceptanceCriteria: ['shared criterion', 'package criterion'], createdAt: '2026-01-01T00:00:00Z' };
  const prompt = workerInstruction(task, pkg);
  const body = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1)) as { acceptanceCriteria: string[]; taskId: string; workspace: string | null; scope: string[]; constraints: string[]; goal: string };
  assert.deepEqual(body, { taskId: 't-1', workspace: '/repo', goal: 'edit a file', scope: ['src/**'], constraints: ['stay minimal'], acceptanceCriteria: ['shared criterion', 'package criterion'] });
  assert.ok(!prompt.includes('task-only criterion'));
});
