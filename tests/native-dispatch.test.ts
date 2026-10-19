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
import type { WorkerAdapter } from '../src/main/adapters/worker';

/** A real (non-mock) adapter that must never be asked to launch a process for native work. */
const launches: string[] = [];
const adapter = { id: 'routing', canLaunchReal: () => false, start: (task: { id: string }) => { launches.push(task.id); throw new Error('native work must not launch a process'); } } as unknown as WorkerAdapter;

function setup() {
  launches.length = 0;
  const dir = mkdtempSync(join(tmpdir(), 'weaver-native-'));
  const store = new TaskStore(join(dir, 'tasks.json'));
  const manager = new TaskManager(store, adapter);
  const policy = new PolicyStore(join(dir, 'policy.json'));
  const handler = new CommandHandler(manager, policy);
  const raw = (command: string, args: Record<string, unknown> = {}) => handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command, args });
  const call = (command: string, args: Record<string, unknown> = {}): any => { const r = raw(command, args); assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const task = () => call('tasks.create', { title: 'Native', goal: 'edit a file', ownerProfileId: 'claude_owner', workspace: dir });
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
    const a = f.task(); const b = f.task();
    f.call('workers.spawn', { taskId: a.id });
    assert.equal(f.call('workers.spawn', { taskId: b.id }).scheduled, true);
    const reloaded = new TaskStore(join(f.dir, 'tasks.json')); reloaded.recover();
    assert.equal(reloaded.get(a.id).status, 'running');
    assert.equal(f.call('tasks.cancel', { taskId: a.id }).status, 'cancelled');
    for (let i = 0; i < 50 && f.store.get(b.id).status !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.store.get(b.id).status, 'running');
    assert.equal(f.store.get(b.id).run?.execution, 'native');
    assert.deepEqual(launches, []);
  } finally { await f.close(); }
});
