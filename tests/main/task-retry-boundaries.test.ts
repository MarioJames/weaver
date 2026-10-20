import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { CommandHandler } from '../../src/main/commands';
import { PolicyStore } from '../../src/main/policy/store';
import type { Task, TaskDispatch } from '../../src/shared/contracts/tasks';
import { metadataOf, setMetadataOf } from '../helpers/store-metadata';

/** In-memory worker: cancellation holds its slot until this fixture emits close. No OS process exists. */
class HeldWorker extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM') { this.signals.push(signal); return true; }
  close() { this.stdout.end(); this.stderr.end(); this.emit('close', null, 'SIGTERM'); }
}
function setup(engines = ['qoder', 'codex', 'opencode']) {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-retry-boundary-'));
  const path = join(dir,'weaver.db');
  const store = new TaskStore(path);
  const children: HeldWorker[] = [];
  const manager = new TaskManager(store, { id: 'fixture', canLaunchReal: () => true, start() { const child = new HeldWorker(); children.push(child); return child; } });
  const policy = new PolicyStore(join(dir,'weaver.db'));
  const snapshot = policy.snapshot();
  const owner = snapshot.config.owners.codex_owner;
  owner.workers = engines.map(engine => `${engine}_worker`);
  owner.worker_weights = Object.fromEntries(engines.map((engine, i) => [`${engine}_worker`, 10 - i * 2]));
  owner.max_parallel = 10;
  for (const engine of engines) { snapshot.config.workers[`${engine}_worker`].enabled = true; snapshot.config.engines[engine].enabled = true; }
  policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [] }, { allowEngineEnable: true });
  // No owner host or real-engine launcher is touched: only the injected in-memory adapter can start.
  const handler = new CommandHandler(manager, policy, () => { throw new Error('No owner launch in fixture'); }, () => false);
  const raw = (command: string, args: Record<string, unknown> = {}, commandId = randomUUID()) => handler.handle({ apiVersion: 'weaver.v1', commandId, command, args });
  const call = (command: string, args: Record<string, unknown> = {}): any => { const response = raw(command, args); assert.equal(response.ok, true, JSON.stringify(response)); return response.data; };
  const create = (): Task => store.get(call('tasks.create', { title: 'Retry boundary', instruction: 'Inspect the fixture diff', ownerProfileId: 'codex_owner', workspace: dir }).id);
  const route = (engine: string, execution: TaskDispatch['execution'] = 'mock'): TaskDispatch => ({ owner: 'codex_owner', worker: `${engine}_worker`, engine, model: 'fixture', effort: 'high', execution, maxParallel: 10, adapter: execution === 'mock' ? 'mock-jsonl' : engine === 'qoder' ? 'qodercli' : engine, workspace: dir });
  const attempt = (engine: string, status: 'completed' | 'failed' | 'running', retryOf?: string, execution: TaskDispatch['execution'] = 'mock') => {
    const task = create(); task.dispatch = route(engine, execution); task.retryOf = retryOf;
    task.status = status === 'running' ? 'queued' : status; store.put(task);
    return status === 'running' ? manager.start(task.id) : store.get(task.id);
  };
  return { dir, path, store, manager, children, handler, raw, call, create, route, attempt, close: async () => {
    handler.draining = true;
    for (const child of children) child.close();
    await manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  } };
}

for (const frozen of [true, false]) for (const active of [false, true]) {
  test(`retry admits beyond 1000 packages for a ${frozen ? 'frozen' : 'unfrozen'} ${active ? 'active --cancel' : 'terminal'} attempt`, async () => {
    const f = setup();
    try {
      const original = f.create();
      const pkg = f.call('packages.create', { taskId: original.id, scope: ['fixture'], acceptanceCriteria: ['Preserve original output'] });
      const staged = f.store.get(original.id);
      if (!frozen) delete staged.packageId;
      staged.dispatch = f.route('qoder');
      staged.status = active ? 'queued' : 'completed';
      f.store.put(staged);
      if (active) f.manager.start(original.id);
      const task = f.store.get(original.id);
      task.artifacts.push({ id: randomUUID(), name: 'partial.md', mediaType: 'text/markdown', content: 'Retain partial work', createdAt: new Date().toISOString() });
      f.store.put(task);
      const metadata = metadataOf(f.store);
      while (metadata.packages.length < 1000) metadata.packages.push({ ...pkg, id: randomUUID() });
      setMetadataOf(f.store, metadata);
      const launches = f.children.length;
      const commandId = randomUUID();
      const args = { taskId: original.id, ...(active ? { cancel: true } : {}) };
      const response = f.raw('tasks.retry', args, commandId);
      assert.equal(response.ok, true, JSON.stringify(response));
      const retried=response.data as Task;
      assert.equal(retried.retryOf,original.id);
      assert.equal(metadataOf(f.store).packages.length,1001);
      assert.equal(f.children.length,launches+1);
      assert.deepEqual(f.store.get(original.id).artifacts,task.artifacts,'partial work survives retry');
      assert.equal(f.store.get(original.id).status,active?'cancelling':'completed');
      if(frozen)assert.deepEqual(f.store.getPackage(retried.packageId!)!.scope,pkg.scope);
      assert.deepEqual(f.raw('tasks.retry',args,commandId),response,'successful retry has a replayable receipt');
      const reopened=new TaskStore(f.path);
      try {
       assert.equal(metadataOf(reopened).packages.length,1001);
       assert.deepEqual(reopened.get(retried.id),f.store.get(retried.id));
       assert.deepEqual(reopened.getReceipt(`local-demo:${commandId}`)!.response,response);
      }finally{reopened.close();}
    } finally { await f.close(); }
  });
}

test('a cancelling real ancestor remains excluded across three generations, while a completed engine remains eligible', async () => {
  const f = setup();
  try {
    const ancestor = f.attempt('qoder', 'running', undefined, 'real');
    f.manager.cancel(ancestor.id);
    assert.equal(f.store.get(ancestor.id).status, 'cancelling');
    assert.equal(f.manager.runningCount, 1, 'the abandoned real worker still holds its slot');
    const middle = f.attempt('codex', 'completed', ancestor.id);
    const original = f.attempt('opencode', 'failed', middle.id);
    // Another owner instance using codex does not make that engine unavailable to this chain.
    f.attempt('codex', 'running', undefined, 'real');
    const retry = f.call('tasks.retry', { taskId: original.id });
    assert.equal(retry.dispatch.engine, 'codex');
    assert.deepEqual(new Set(retry.excludedEngines), new Set(['qoder', 'opencode']));
    assert.equal(f.store.get(ancestor.id).status, 'cancelling');
    assert.equal(f.store.get(middle.id).status, 'completed');
  } finally { await f.close(); }
});

test('no remaining engine refuses a later --cancel retry before touching its active attempt', async () => {
  const f = setup(['qoder', 'opencode']);
  try {
    const ancestor = f.attempt('qoder', 'running', undefined, 'real');
    f.manager.cancel(ancestor.id);
    const middle = f.attempt('opencode', 'failed', ancestor.id);
    const original = f.attempt('opencode', 'running', middle.id);
    const before = f.store.list();
    const packages = metadataOf(f.store).packages;
    const launches = f.children.length;
    const signals = f.children.map(child => [...child.signals]);
    const response = f.raw('tasks.retry', { taskId: original.id, cancel: true });
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'NO_ALTERNATIVE_ENGINE');
    assert.deepEqual(f.store.list(), before);
    assert.deepEqual(metadataOf(f.store).packages, packages);
    assert.equal(f.children.length, launches);
    assert.deepEqual(f.children.map(child => child.signals), signals, 'the current attempt is never cancelled');
    assert.equal(f.manager.runningCount, 2, 'both original fixture slots are still held');
  } finally { await f.close(); }
});

test('a task written before proxies were removed still reads and retries; the retired dispatch.proxy is ignored', async () => {
  const f = setup(['qoder', 'codex']);
  try {
    const legacy = f.create();
    legacy.dispatch = { ...f.route('qoder'), proxy: 'http://127.0.0.1:7890' } as TaskDispatch;
    legacy.status = 'failed';
    f.store.put(legacy);
    const reopened = new TaskStore(f.path);
    try { assert.equal(reopened.get(legacy.id).dispatch?.engine, 'qoder'); } finally { reopened.close(); }
    const retry = f.call('tasks.retry', { taskId: legacy.id });
    assert.equal(retry.dispatch.engine, 'codex');
    assert.equal('proxy' in retry.dispatch, false, 'the retry is routed afresh and carries no proxy');
    assert.equal('proxy' in (f.store.get(retry.id).dispatch as object), false);
  } finally { await f.close(); }
});
