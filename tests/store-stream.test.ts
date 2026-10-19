import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TaskStore, event } from '../src/main/store';
import { TaskManager } from '../src/main/manager';
import { CommandHandler } from '../src/main/commands';
import { PolicyStore } from '../src/main/policy/store';
import { API_VERSION } from '../src/shared/commands';
import type { Task } from '../src/shared/types';

const root = join(tmpdir(), 'weaver-store-stream');
const input = { title: 'Stream fixture', instruction: 'Local test', owner: { name: 'owner', transport: 'herdr-visible' as const, session: 'main', pane: '1' } };
function fixture(): Task {
  const at = new Date().toISOString();
  return { ...input, id: randomUUID(), createdAt: at, updatedAt: at, status: 'queued', progress: 0, events: [], artifacts: [] };
}
function setup() {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'coalescing-'));
  const path = join(dir, 'tasks.json');
  let writes = 0, fail = false;
  const store = new TaskStore(path, (temp, content) => {
    if (fail) throw new Error('disk unavailable');
    writes++; writeFileSync(temp, content, { mode: 0o600 });
  });
  return { dir, path, store, writes: () => writes, fail: (value: boolean) => { fail = value; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('500 stream records over a large store coalesce, stay visible, and survive terminal exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup();
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; } });
  let notifications = 0;
  const manager = new TaskManager(f.store, { id: 'mock-jsonl', start: () => child }, () => { notifications++; });
  try {
    f.store.transaction(() => {
      for (let i = 0; i < 100; i++) {
        const task = fixture();
        for (let j = 0; j < 100; j++) event(task, 'log', 'x'.repeat(500));
        f.store.put(task);
      }
    });
    assert.ok(readFileSync(f.path).length > 5_000_000);
    const task = manager.create(input); manager.start(task.id);
    assert.equal(new TaskStore(f.path).get(task.id).run?.pid, 123);
    const before = f.writes(), notices = notifications, revision = f.store.revision;
    for (let i = 0; i < 500; i++) {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'progress', percent: i % 100, message: `stream ${i}` }) + '\n'));
      if (i === 249) t.mock.timers.tick(500);
    }
    assert.equal(f.writes() - before, 1);
    assert.equal(notifications - notices, 500);
    assert.ok(f.store.revision > revision);
    assert.equal(f.store.get(task.id).events.at(-1)?.message, 'stream 499');
    assert.equal(new TaskStore(f.path).get(task.id).events.at(-1)?.message, 'stream 249');
    t.mock.timers.tick(499); assert.equal(f.writes() - before, 1);
    t.mock.timers.tick(1); assert.equal(f.writes() - before, 2);
    child.stderr.emit('data', Buffer.from('diagnostic'));
    child.stdout.emit('data', Buffer.from('{"type":"result","summary":"done"}\n'));
    assert.equal(f.writes() - before, 2);
    child.emit('close', 0, null);
    assert.equal(f.writes() - before, 3);
    const saved = new TaskStore(f.path).get(task.id);
    assert.equal(saved.status, 'completed'); assert.equal(saved.summary, 'done');
    assert.ok(saved.events.some(e => e.message === 'stderr: diagnostic'));
    t.mock.timers.tick(1000); assert.equal(f.writes() - before, 3);
    assert.equal(readFileSync(f.path, 'utf8').includes('\n'), false);
  } finally { await manager.shutdown(); f.cleanup(); }
});

test('command receipts synchronously persist pending streams, and failed transactions preserve pending work', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup();
  try {
    const task = fixture(); f.store.put(task);
    event(task, 'log', 'pending'); f.store.put(task, 'stream');
    assert.throws(() => f.store.transaction(() => { f.store.put({ ...task, title: 'rolled back' }); throw new Error('rollback'); }), /rollback/);
    const manager = new TaskManager(f.store, { id: 'mock-jsonl', start: () => { throw new Error('unused'); } });
    const handler = new CommandHandler(manager, new PolicyStore(join(f.dir, 'policy.json')));
    const response = handler.handle({ apiVersion: API_VERSION, commandId: 'durable-create', command: 'tasks.create', args: input });
    assert.equal(response.ok, true);
    const disk = new TaskStore(f.path);
    assert.equal(disk.get(task.id).title, input.title);
    assert.equal(disk.get(task.id).events.at(-1)?.message, 'pending');
    assert.deepEqual(disk.getMetadata().receipts['local-demo:durable-create'].response, response);
    const count = f.writes(); t.mock.timers.tick(1000); assert.equal(f.writes(), count);
    event(task, 'log', 'drain'); f.store.put(task, 'stream');
    f.store.close(); assert.equal(new TaskStore(f.path).get(task.id).events.at(-1)?.message, 'drain');
    t.mock.timers.tick(1000); assert.equal(f.writes(), count + 1);
  } finally { f.store.close(); f.cleanup(); }
});

test('failed background and synchronous writes retain pending streams for retry', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(), errors: unknown[] = [];
  try {
    const task = fixture(); f.store.put(task);
    event(task, 'log', 'retained'); f.store.put(task, 'stream', error => errors.push(error));
    f.fail(true); t.mock.timers.tick(500);
    assert.equal(errors.length, 1);
    assert.equal(f.store.get(task.id).events.at(-1)?.message, 'retained');
    assert.throws(() => f.store.put({ ...task, title: 'failed command' }), /disk unavailable/);
    assert.equal(f.store.get(task.id).title, input.title);
    f.fail(false); t.mock.timers.tick(500);
    assert.equal(new TaskStore(f.path).get(task.id).events.at(-1)?.message, 'retained');
    const count = f.writes(); t.mock.timers.tick(1000); assert.equal(f.writes(), count);
  } finally { f.fail(false); f.store.close(); f.cleanup(); }
});

test('manager shutdown flushes pending work even without a managed child', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup();
  try {
    const task = fixture(); f.store.put(task);
    event(task, 'log', 'last event'); f.store.put(task, 'stream');
    const manager = new TaskManager(f.store, { id: 'mock-jsonl', start: () => { throw new Error('unused'); } });
    await manager.shutdown();
    assert.equal(new TaskStore(f.path).get(task.id).events.at(-1)?.message, 'last event');
    const count = f.writes(); t.mock.timers.tick(1000); assert.equal(f.writes(), count);
  } finally { f.store.close(); f.cleanup(); }
});

test('streams from multiple tasks share a fixed window and metadata writes flush them synchronously', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup();
  try {
    const first = fixture(), second = fixture();
    f.store.transaction(() => { f.store.put(first); f.store.put(second); });
    const before = f.writes();
    event(first, 'log', 'first'); f.store.put(first, 'stream');
    t.mock.timers.tick(400);
    event(second, 'log', 'second'); f.store.put(second, 'stream');
    t.mock.timers.tick(100);
    assert.equal(f.writes() - before, 1);
    const saved = new TaskStore(f.path);
    assert.equal(saved.get(first.id).events.at(-1)?.message, 'first');
    assert.equal(saved.get(second.id).events.at(-1)?.message, 'second');
    event(second, 'log', 'metadata checkpoint'); f.store.put(second, 'stream');
    f.store.setMetadata(f.store.getMetadata());
    assert.equal(f.writes() - before, 2);
    assert.equal(new TaskStore(f.path).get(second.id).events.at(-1)?.message, 'metadata checkpoint');
    t.mock.timers.tick(1000); assert.equal(f.writes() - before, 2);
  } finally { f.store.close(); f.cleanup(); }
});

test('a transaction disk failure rolls back commands while retaining the pending stream checkpoint', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup();
  try {
    const task = fixture(); f.store.put(task);
    event(task, 'log', 'pending before command'); f.store.put(task, 'stream');
    f.fail(true);
    assert.throws(() => f.store.transaction(() => {
      f.store.put({ ...task, title: 'uncommitted command' });
    }), /disk unavailable/);
    assert.equal(f.store.get(task.id).title, input.title);
    assert.equal(new TaskStore(f.path).get(task.id).events.length, 0);
    f.fail(false); t.mock.timers.tick(500);
    const saved = new TaskStore(f.path).get(task.id);
    assert.equal(saved.title, input.title);
    assert.equal(saved.events.at(-1)?.message, 'pending before command');
  } finally { f.fail(false); f.store.close(); f.cleanup(); }
});
