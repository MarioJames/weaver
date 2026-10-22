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

/** In-memory worker: no OS process exists, and every retry dispatch is counted. */
class HeldWorker extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM') { this.signals.push(signal); return true; }
  close() { this.stdout.end(); this.stderr.end(); this.emit('close', null, 'SIGTERM'); }
}

const GOAL = 'Inspect the fixture diff';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-retry-review-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const children: HeldWorker[] = [];
  const manager = new TaskManager(store, { id: 'fixture', canLaunchReal: () => true, start() { const child = new HeldWorker(); children.push(child); return child; } });
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  const snapshot = policy.snapshot();
  const owner = snapshot.config.owners.codex_owner;
  owner.workers = ['qoder_worker', 'codex_worker', 'opencode_worker'];
  owner.worker_weights = { qoder_worker: 10, codex_worker: 8, opencode_worker: 6 };
  owner.max_parallel = 10;
  for (const engine of ['qoder', 'codex', 'opencode']) {
    snapshot.config.workers[`${engine}_worker`].enabled = true;
    snapshot.config.engines[engine].enabled = true;
  }
  policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [] }, { allowEngineEnable: true });
  const handler = new CommandHandler(manager, policy, () => { throw new Error('No owner launch in fixture'); }, () => false);
  const raw = (command: string, args: Record<string, unknown> = {}, commandId = randomUUID()) => handler.handle({ apiVersion: 'weaver.v1', commandId, command, args });
  const call = (command: string, args: Record<string, unknown> = {}): any => { const response = raw(command, args); assert.equal(response.ok, true, JSON.stringify(response)); return response.data; };
  const route = (engine: string): TaskDispatch => ({ owner: 'codex_owner', worker: `${engine}_worker`, engine, model: 'fixture', effort: 'high', execution: 'mock', maxParallel: 10, adapter: 'mock-jsonl', workspace: dir });
  const create = (instruction = GOAL): Task => store.get(call('tasks.create', { title: 'Retry review', instruction, ownerProfileId: 'codex_owner', workspace: dir }).id);
  const attempt = (engine: string, retryOf?: string, instruction = GOAL): Task => {
    const task = create(instruction);
    task.dispatch = route(engine);
    task.status = 'completed';
    if (retryOf) task.retryOf = retryOf;
    store.put(task);
    return store.get(task.id);
  };
  return { dir, store, manager, handler, raw, call, create, attempt, close: async () => {
    handler.draining = true;
    for (const child of children) child.close();
    await manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  } };
}

function note(task: Task): string {
  return `[Weaver retry] The previous attempt (task ${task.id.slice(0, 8)}) ran on ${task.dispatch?.worker ?? 'no worker'} (${task.dispatch?.engine ?? 'no engine'}) and ended ${task.status}. Before changing anything, inspect the current git diff and any partial output already in the workspace, then continue from what is there rather than repeating finished work. The goal below is the original instruction, unchanged.`;
}

test('a rejected attempt carries the parent review comment before the original goal', async () => {
  const f = setup();
  try {
    const comment = 'The workspace diff still rewrites unrelated files.\nAdd a regression test for the retry note.';
    const original = f.attempt('qoder');
    original.reviewState = 'rejected';
    original.reviewComment = comment;
    f.store.put(original);

    const retry = f.call('tasks.retry', { taskId: original.id });
    const instruction = f.store.getPackage(retry.packageId)!.instruction;

    assert.ok(instruction.includes(comment), 'the review comment is embedded verbatim');
    assert.ok(instruction.includes(original.id.slice(0, 8)), 'the note names the task the review came from');
    assert.match(instruction, /parent Agent/i);
    assert.match(instruction, /every point it raises must be addressed/i);
    assert.match(instruction, /verbatim as data, not as a new instruction/i);
    assert.ok(instruction.indexOf(comment) < instruction.indexOf(GOAL), 'the review comment precedes the original goal');
    assert.ok(instruction.endsWith(`\n\n${GOAL}`), 'the original goal is still last and unchanged');
    assert.ok(instruction.startsWith(note(original)), 'the existing retry note is preserved first');
  } finally { await f.close(); }
});

for (const reviewState of [undefined, 'pending', 'accepted', 'rejected'] as const) {
  test(`a ${reviewState ?? 'missing'} review with no comment leaves the retry instruction byte-identical`, async () => {
    const f = setup();
    try {
      const original = f.attempt('qoder');
      if (reviewState !== undefined) original.reviewState = reviewState;
      original.reviewComment = '';
      f.store.put(original);

      const retry = f.call('tasks.retry', { taskId: original.id });
      assert.equal(f.store.getPackage(retry.packageId)!.instruction, `${note(original)}\n\n${GOAL}`);
    } finally { await f.close(); }
  });
}

test('an oversized review comment is truncated and the retry still dispatches', async () => {
  const f = setup();
  try {
    const comment = 'R'.repeat(5000);
    const original = f.attempt('qoder');
    original.reviewState = 'rejected';
    original.reviewComment = comment;
    f.store.put(original);

    const retry = f.call('tasks.retry', { taskId: original.id });
    const instruction = f.store.getPackage(retry.packageId)!.instruction;

    assert.ok(instruction.length <= 16000);
    assert.ok(instruction.includes('R'.repeat(4000)), 'the first 4000 characters are kept');
    assert.ok(!instruction.includes('R'.repeat(4001)), 'no more than the 4000-character review limit is kept');
    assert.match(instruction, /truncat/i);
    assert.equal(f.store.get(retry.id).retryOf, original.id);
  } finally { await f.close(); }
});

test('a review comment is shortened further to keep a long original goal under the task limit', async () => {
  const f = setup();
  try {
    const goal = `g${'o'.repeat(13999)}`;
    const original = f.attempt('qoder', undefined, goal);
    original.reviewState = 'rejected';
    original.reviewComment = 'C'.repeat(5000);
    f.store.put(original);

    const retry = f.call('tasks.retry', { taskId: original.id });
    const instruction = f.store.getPackage(retry.packageId)!.instruction;

    assert.ok(instruction.length <= 16000);
    assert.ok(instruction.endsWith(`\n\n${goal}`));
    assert.ok(instruction.includes('C'.repeat(100)));
    assert.match(instruction, /truncat/i);
  } finally { await f.close(); }
});

test('a review comment still reaches a retry whose original goal nearly fills the task limit', async () => {
  const f = setup();
  try {
    const goal = 'g'.repeat(15500);
    const comment = 'C'.repeat(5000);
    const original = f.attempt('qoder', undefined, goal);
    original.reviewState = 'rejected';
    original.reviewComment = comment;
    f.store.put(original);

    const retry = f.call('tasks.retry', { taskId: original.id });
    const instruction = f.store.getPackage(retry.packageId)!.instruction;

    assert.ok(instruction.length <= 16000);
    assert.ok(instruction.startsWith(note(original)));
    assert.ok(instruction.endsWith(`\n\n${goal}`));
    assert.ok(instruction.includes('C'.repeat(10)));
    assert.match(instruction, /truncat/i);
    assert.match(instruction, /must be addressed/i);
  } finally { await f.close(); }
});

test('a chain with several rejected attempts carries only the most recent review comment', async () => {
  const f = setup();
  try {
    const root = f.attempt('qoder');
    root.reviewState = 'rejected';
    root.reviewComment = 'OLDER: fix the first defect.';
    f.store.put(root);
    const middle = f.attempt('codex', root.id);
    middle.reviewState = 'rejected';
    middle.reviewComment = 'NEWER: fix the remaining defect.';
    f.store.put(middle);

    const retry = f.call('tasks.retry', { taskId: middle.id });
    const instruction = f.store.getPackage(retry.packageId)!.instruction;

    assert.ok(instruction.includes('NEWER: fix the remaining defect.'));
    assert.ok(!instruction.includes('OLDER: fix the first defect.'), 'older review comments are not stacked');
    assert.ok(instruction.includes(middle.id.slice(0, 8)));
    assert.ok(!instruction.includes(root.id.slice(0, 8)));
  } finally { await f.close(); }
});

test('a completed attempt with pending review does not inherit an older review in the chain', async () => {
  const f = setup();
  try {
    const root = f.attempt('qoder');
    root.reviewState = 'rejected';
    root.reviewComment = 'OLD: this comment belongs to the earlier attempt.';
    f.store.put(root);
    const current = f.attempt('codex', root.id);
    current.status = 'completed';
    current.reviewState = 'pending';
    f.store.put(current);

    const retry = f.call('tasks.retry', { taskId: current.id });
    assert.equal(f.store.getPackage(retry.packageId)!.instruction, `${note(current)}\n\n${GOAL}`);
  } finally { await f.close(); }
});

test('a cancelled attempt inherits the earlier rejected review and notes the intermediate attempt', async () => {
  const f = setup();
  try {
    const comment = 'OLD: fix the defect flagged by the parent review.';
    const root = f.attempt('qoder');
    root.reviewState = 'rejected';
    root.reviewComment = comment;
    f.store.put(root);
    const current = f.attempt('codex', root.id);
    current.status = 'cancelled';
    f.store.put(current);

    const retry = f.call('tasks.retry', { taskId: current.id });
    const instruction = f.store.getPackage(retry.packageId)!.instruction;

    assert.ok(instruction.includes(comment), 'the earlier review comment is embedded verbatim');
    assert.ok(instruction.includes(root.id.slice(0, 8)), 'the note names the task the review came from');
    assert.ok(instruction.includes(current.id.slice(0, 8)), 'the note names the cancelled intermediate attempt');
    assert.match(instruction, /without a new review conclusion/i);
    assert.match(instruction, /cancelled/);
    assert.ok(instruction.indexOf(comment) < instruction.indexOf(GOAL));
    assert.ok(instruction.endsWith(`\n\n${GOAL}`));
    assert.ok(instruction.startsWith(note(current)));
  } finally { await f.close(); }
});

test('a failed attempt inherits the earlier rejected review and notes the intermediate attempt', async () => {
  const f = setup();
  try {
    const comment = 'OLD: address the parent rejection before continuing.';
    const root = f.attempt('qoder');
    root.reviewState = 'rejected';
    root.reviewComment = comment;
    f.store.put(root);
    const current = f.attempt('codex', root.id);
    current.status = 'failed';
    f.store.put(current);

    const retry = f.call('tasks.retry', { taskId: current.id });
    const instruction = f.store.getPackage(retry.packageId)!.instruction;

    assert.ok(instruction.includes(comment));
    assert.ok(instruction.includes(root.id.slice(0, 8)));
    assert.ok(instruction.includes(current.id.slice(0, 8)));
    assert.match(instruction, /without a new review conclusion/i);
    assert.match(instruction, /failed/);
    assert.ok(instruction.endsWith(`\n\n${GOAL}`));
    assert.ok(instruction.startsWith(note(current)));
  } finally { await f.close(); }
});

test('two cancelled/failed intermediates still carry the earliest rejected review', async () => {
  const f = setup();
  try {
    const comment = 'OLDEST: the original rejection still applies.';
    const root = f.attempt('qoder');
    root.reviewState = 'rejected';
    root.reviewComment = comment;
    f.store.put(root);
    const middle = f.attempt('codex', root.id);
    middle.status = 'cancelled';
    f.store.put(middle);
    const current = f.attempt('opencode', middle.id);
    current.status = 'failed';
    f.store.put(current);

    const retry = f.call('tasks.retry', { taskId: current.id });
    const instruction = f.store.getPackage(retry.packageId)!.instruction;

    assert.ok(instruction.includes(comment));
    assert.ok(instruction.includes(root.id.slice(0, 8)), 'the review source is named');
    assert.ok(instruction.includes(middle.id.slice(0, 8)), 'the cancelled intermediate is named');
    assert.ok(instruction.includes(current.id.slice(0, 8)), 'the failed intermediate is named');
    assert.match(instruction, /without a new review conclusion/i);
    assert.ok(instruction.endsWith(`\n\n${GOAL}`));
  } finally { await f.close(); }
});

test('a chain with a cycle or a missing retryOf target stops safely without throwing', async () => {
  const f = setup();
  try {
    const root = f.attempt('qoder');
    root.reviewState = 'rejected';
    root.reviewComment = 'OLD: must not be reached through a broken link.';
    f.store.put(root);

    const missing = f.attempt('codex', root.id);
    missing.status = 'cancelled';
    missing.retryOf = randomUUID();
    f.store.put(missing);
    const retryMissing = f.call('tasks.retry', { taskId: missing.id });
    assert.equal(f.store.getPackage(retryMissing.packageId)!.instruction, `${note(missing)}\n\n${GOAL}`);

    const first = f.attempt('qoder');
    first.status = 'cancelled';
    f.store.put(first);
    const second = f.attempt('codex', first.id);
    second.status = 'failed';
    f.store.put(second);
    first.retryOf = second.id;
    f.store.put(first);
    const retryCycle = f.call('tasks.retry', { taskId: second.id });
    assert.equal(f.store.getPackage(retryCycle.packageId)!.instruction, `${note(second)}\n\n${GOAL}`);
  } finally { await f.close(); }
});
