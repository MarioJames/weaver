import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { MockWorkerAdapter } from '../../src/main/adapters/worker';
import { CommandHandler } from '../../src/main/commands';
import { PolicyStore } from '../../src/main/policy/store';
import { OwnerLaunchError, type OwnerLaunchInput, type OwnerLaunchResult } from '../../src/main/owner-host';
import { buildTaskOverview } from '../../src/main/application/tasks/owner-report';
import { CLI_CATALOG, CLI_HELP, catalogCommand } from '../../src/cli/catalog';
import type { Task } from '../../src/shared/contracts/tasks';

const execFileAsync = promisify(execFile);
const blockedLaunch = (input: OwnerLaunchInput): OwnerLaunchResult => {
  throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `Test did not inject an owner launcher for ${input.taskId}`);
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-owner-report-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const manager = new TaskManager(store, new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs')));
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  const handler = new CommandHandler(manager, policy, blockedLaunch, () => false);
  const raw = (command: string, args: Record<string, unknown> = {}, commandId: string = randomUUID(), ownerAuth?: unknown) =>
    handler.handle({ apiVersion: 'weaver.v1', commandId, command, args, ...(ownerAuth === undefined ? {} : { ownerAuth }) } as never);
  const call = (command: string, args: Record<string, unknown> = {}, commandId: string = randomUUID(), ownerAuth?: unknown): any => {
    const r = raw(command, args, commandId, ownerAuth);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.data;
  };
  const close = async () => { handler.draining = true; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, manager, handler, raw, call, close };
}

function attachOwner(f: ReturnType<typeof setup>, name = 'Owner') {
  const profileId = Object.keys(f.handler['policy'].snapshot().config.owners)[0]!;
  const attached = f.call('owners.attach', { name, profileId, session: `sess-${randomUUID().slice(0, 6)}` });
  const secret = JSON.parse(readFileSync(attached.credentialPath, 'utf8')) as { ownerId: string; token: string };
  return { attached, auth: { ownerId: secret.ownerId, token: secret.token } };
}

/** Synthetic store fixture: mark a queued task as a running owner root without launching a real owner agent. */
function makeRunningRoot(f: ReturnType<typeof setup>, ownerId: string, title = 'Root'): Task {
  const created = f.call('tasks.create', { title, instruction: 'fixture', ownerId });
  const task = f.store.get(created.id);
  task.executionRole = 'owner';
  task.status = 'running';
  task.acceptanceCriteria = ['verify'];
  task.title = title;
  f.store.put(task);
  return f.store.get(task.id);
}

test('tasks.report stores latest report, bumps revision once and appends exactly one progress event', async () => {
  const f = setup();
  try {
    const { attached, auth } = attachOwner(f);
    const root = makeRunningRoot(f, attached.id);
    const before = f.store.get(root.id);
    const beforeRevision = before.revision ?? 0;
    const beforeEvents = before.events.length;
    const res = f.call('tasks.report', { taskId: root.id, summary: 'Working on split', percent: 40, phase: 'split', blockers: ['waiting'], nextSteps: ['dispatch'] }, randomUUID(), auth);
    assert.equal(res.ownerReport.summary, 'Working on split');
    assert.equal(res.ownerReport.percent, 40);
    assert.equal(res.ownerReport.phase, 'split');
    assert.deepEqual(res.ownerReport.blockers, ['waiting']);
    assert.deepEqual(res.ownerReport.nextSteps, ['dispatch']);
    assert.ok(Date.parse(res.ownerReport.reportedAt));
    const after = f.store.get(root.id);
    assert.equal(after.revision, beforeRevision + 1);
    assert.equal(after.events.length, beforeEvents + 1);
    assert.equal(after.events.at(-1)!.kind, 'progress');
    assert.equal(after.progress, 40);
    assert.equal(after.title, before.title);
    assert.equal(after.instruction, before.instruction);
    // Second report replaces the latest but keeps history as events.
    const second = f.call('tasks.report', { taskId: root.id, summary: 'Second update', percent: 60 }, randomUUID(), auth);
    assert.equal(second.ownerReport.summary, 'Second update');
    assert.equal(second.ownerReport.percent, 60);
    assert.equal(second.ownerReport.phase, null);
    assert.deepEqual(second.ownerReport.blockers, []);
    const latest = f.store.get(root.id);
    assert.equal(latest.progress, 60);
    assert.equal(latest.events.filter(e => e.kind === 'progress').length, 2);
  } finally { await f.close(); }
});

test('tasks.report without percent leaves progress unchanged and normalizes omitted fields to null', async () => {
  const f = setup();
  try {
    const { attached, auth } = attachOwner(f);
    const root = makeRunningRoot(f, attached.id);
    const stored = f.store.get(root.id);
    stored.progress = 25;
    f.store.put(stored);
    const res = f.call('tasks.report', { taskId: root.id, summary: 'No percent yet' }, randomUUID(), auth);
    assert.equal(res.ownerReport.percent, null);
    assert.equal(res.ownerReport.phase, null);
    assert.deepEqual(res.ownerReport.blockers, []);
    assert.deepEqual(res.ownerReport.nextSteps, []);
    assert.equal(f.store.get(root.id).progress, 25);
  } finally { await f.close(); }
});

test('tasks.report rejects unauthenticated, foreign, child, non-owner and non-running tasks', async () => {
  const f = setup();
  try {
    const a = attachOwner(f, 'A');
    const b = attachOwner(f, 'B');
    const root = makeRunningRoot(f, a.attached.id);
    assert.equal(f.raw('tasks.report', { taskId: root.id, summary: 'x' }).error?.code, 'UNAUTHORIZED');
    assert.equal(f.raw('tasks.report', { taskId: root.id, summary: 'x' }, randomUUID(), b.auth).error?.code, 'FORBIDDEN');
    const child = f.call('tasks.create', { parentTaskId: root.id, title: 'Child', instruction: 'work' }, randomUUID(), a.auth);
    assert.equal(f.raw('tasks.report', { taskId: child.id, summary: 'x' }, randomUUID(), a.auth).error?.code, 'INVALID_STATE');
    const plain = f.call('tasks.create', { title: 'Plain', instruction: 'work', ownerId: a.attached.id }, randomUUID(), a.auth);
    assert.equal(f.raw('tasks.report', { taskId: plain.id, summary: 'x' }, randomUUID(), a.auth).error?.code, 'INVALID_STATE');
    assert.equal(f.raw('tasks.report', { taskId: plain.id, summary: 'x' }).error?.code, 'UNAUTHORIZED');
    const queuedOwner = f.call('tasks.create', { title: 'Queued root', instruction: 'work', ownerId: a.attached.id }, randomUUID(), a.auth);
    const q = f.store.get(queuedOwner.id);
    q.executionRole = 'owner';
    f.store.put(q);
    assert.equal(f.raw('tasks.report', { taskId: queuedOwner.id, summary: 'x' }, randomUUID(), a.auth).error?.code, 'INVALID_STATE');
    const done = f.store.get(root.id);
    done.status = 'completed';
    f.store.put(done);
    assert.equal(f.raw('tasks.report', { taskId: root.id, summary: 'x' }, randomUUID(), a.auth).error?.code, 'INVALID_STATE');
  } finally { await f.close(); }
});

test('tasks.report validates shapes, bounds and unknown fields without leaking input', async () => {
  const f = setup();
  try {
    const { attached, auth } = attachOwner(f);
    const root = makeRunningRoot(f, attached.id);
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ taskId: root.id }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: '   ' }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'x'.repeat(2001) }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', percent: Number.NaN }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', percent: Infinity }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', percent: -1 }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', percent: 101 }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', percent: '40' }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', phase: '   ' }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', phase: 'x'.repeat(121) }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', blockers: 'waiting' }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', blockers: Array(11).fill('x') }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', blockers: ['  '] }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', nextSteps: ['x'.repeat(501)] }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', extra: 1 }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', expectedRevision: -1 }, 'INVALID_REQUEST'],
      [{ taskId: root.id, summary: 'ok', expectedRevision: 1.5 }, 'INVALID_REQUEST'],
    ];
    for (const [args, code] of bad) {
      const r = f.raw('tasks.report', args, randomUUID(), auth);
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.equal(r.error?.code, code, JSON.stringify(args));
      assert.doesNotMatch(JSON.stringify(r), /x{100}|secret-value/i);
    }
    // Secrets are redacted at rest and on the timeline without echoing the value in errors.
    const secret = 'token=secret-value-abc123';
    const ok = f.call('tasks.report', { taskId: root.id, summary: `progress with ${secret}`, blockers: [`password=${secret}`], nextSteps: ['Bearer abcdefghij123456'] }, randomUUID(), auth);
    assert.doesNotMatch(JSON.stringify(ok), /secret-value-abc123/);
    assert.match(JSON.stringify(ok.ownerReport), /REDACTED/);
    const stored = f.store.get(root.id);
    assert.doesNotMatch(JSON.stringify(stored.ownerReport), /secret-value-abc123/);
    assert.doesNotMatch(stored.events.at(-1)!.message, /secret-value-abc123/);
    // Control characters are stripped.
    const ctrl = f.call('tasks.report', { taskId: root.id, summary: 'a\x00b\x1fc' }, randomUUID(), auth);
    assert.equal(ctrl.ownerReport.summary, 'abc');
    assert.doesNotMatch(ctrl.ownerReport.summary, /[\x00\x1f]/);
  } finally { await f.close(); }
});

test('tasks.report masks CLI space-form credentials and control-char key splits everywhere', async () => {
  const f = setup();
  try {
    const { attached, auth } = attachOwner(f);
    const root = makeRunningRoot(f, attached.id);
    const T1 = 'SYNTH-CANARY-A1x';
    const T2 = 'SYNTH-CANARY-B2x';
    const T3 = 'SYNTH-CANARY-C3x';
    const T4 = 'SYNTH-CANARY-D4x';
    const T5 = 'SYNTH-CANARY-E5x';
    const T6 = 'SYNTH-CANARY-F6x';
    const T7 = 'SYNTH-CANARY-G7x';
    const T8 = 'SYNTH-CANARY-H8x';
    const T9 = 'SYNTH-CANARY-I9x';
    const T10 = 'SYNTH-CANARY-J10x';
    const canaries = [T1, T2, T3, T4, T5, T6, T7, T8, T9, T10];
    const ok = f.call('tasks.report', {
      taskId: root.id,
      summary: `deploy with --token ${T1} and --api-key=${T2} plus sec\x9bret=${T6}, tok\x7fen=${T7}, --secret-key ${T8} and --token\x00${T10}`,
      phase: 'rollout',
      blockers: [`--password "${T3} with space"`, `line1 --token\n${T4} rest`, `--password "prefix\n${T9} suffix"`],
      nextSteps: ['pass\x00word=' + T5],
    }, randomUUID(), auth);
    const seen = JSON.stringify(ok);
    for (const t of canaries) assert.doesNotMatch(seen, new RegExp(t));
    assert.match(seen, /REDACTED/);
    const stored = f.store.get(root.id);
    for (const t of canaries) assert.doesNotMatch(JSON.stringify(stored.ownerReport), new RegExp(t));
    for (const t of canaries) assert.doesNotMatch(stored.events.at(-1)!.message, new RegExp(t));
    const got = f.call('tasks.get', { taskId: root.id });
    for (const t of canaries) assert.doesNotMatch(JSON.stringify(got), new RegExp(t));
    const overview = f.call('tasks.overview', {}) as { roots: Array<{ id: string; ownerReport: unknown }> };
    const mine = overview.roots.find(r => r.id === root.id)!;
    for (const t of canaries) assert.doesNotMatch(JSON.stringify(mine.ownerReport), new RegExp(t));
    assert.doesNotMatch(JSON.stringify(mine), new RegExp(T1));
  } finally { await f.close(); }
});

test('tasks.report rejects explicit nulls and malformed shapes without echoing input', async () => {
  const f = setup();
  try {
    const { attached, auth } = attachOwner(f);
    const root = makeRunningRoot(f, attached.id);
    const CANARY = 'SYNTH-CANARY-N0echo';
    const bad: Array<Record<string, unknown>> = [
      // Explicit null is rejected for optional fields (omission reads back as null; null is not valid input).
      { taskId: root.id, summary: 'ok', percent: null },
      { taskId: root.id, summary: 'ok', phase: null },
      { taskId: root.id, summary: 'ok', blockers: null },
      { taskId: root.id, summary: 'ok', nextSteps: null },
      { taskId: root.id, summary: 'ok', expectedRevision: null },
      // Boolean / object / array shapes.
      { taskId: root.id, summary: true },
      { taskId: root.id, summary: 42 },
      { taskId: root.id, summary: {} },
      { taskId: root.id, summary: [] },
      { taskId: root.id, summary: 'ok', percent: true },
      { taskId: root.id, summary: 'ok', percent: {} },
      { taskId: root.id, summary: 'ok', percent: [] },
      { taskId: root.id, summary: 'ok', phase: 42 },
      { taskId: root.id, summary: 'ok', phase: true },
      { taskId: root.id, summary: 'ok', phase: {} },
      { taskId: root.id, summary: 'ok', phase: [] },
      { taskId: root.id, summary: 'ok', blockers: [42] },
      { taskId: root.id, summary: 'ok', blockers: [null] },
      { taskId: root.id, summary: 'ok', blockers: [{}] },
      { taskId: root.id, summary: 'ok', nextSteps: [true] },
      // expectedRevision: real service-layer NaN (direct call, not JSON null), string, unsafe int, boolean, object.
      { taskId: root.id, summary: 'ok', expectedRevision: Number.NaN },
      { taskId: root.id, summary: 'ok', expectedRevision: '3' },
      { taskId: root.id, summary: 'ok', expectedRevision: 2 ** 53 },
      { taskId: root.id, summary: 'ok', expectedRevision: true },
      { taskId: root.id, summary: 'ok', expectedRevision: {} },
      // Unknown fields never echo the value.
      { taskId: root.id, summary: 'ok', extra: CANARY },
      { taskId: root.id, summary: 'x'.repeat(1990) + CANARY },
    ];
    for (const args of bad) {
      const r = f.raw('tasks.report', args, randomUUID(), auth);
      assert.equal(r.ok, false, JSON.stringify(args).slice(0, 120));
      assert.equal(r.error?.code, 'INVALID_REQUEST', JSON.stringify(args).slice(0, 120));
      assert.doesNotMatch(JSON.stringify(r), new RegExp(CANARY));
    }
    // No report was stored by any rejected call.
    assert.equal(f.store.get(root.id).ownerReport, undefined);
    assert.equal(f.store.get(root.id).events.filter(e => e.kind === 'progress').length, 0);
  } finally { await f.close(); }
});

test('overview lastError applies the same CLI-form and control-char cleaning', async () => {
  const f = setup();
  try {
    const a = attachOwner(f, 'A');
    const b = attachOwner(f, 'B');
    const rootA = makeRunningRoot(f, a.attached.id, 'Root A');
    const rootB = makeRunningRoot(f, b.attached.id, 'Root B');
    const T7 = 'SYNTH-CANARY-L7x';
    const T8 = 'SYNTH-CANARY-L8x';
    const T9 = 'SYNTH-CANARY-L9x';
    const withFailure = f.store.get(rootA.id);
    withFailure.failure = { kind: 'other', message: `boom --token ${T7} plus --api-key\n${T9}` };
    f.store.put(withFailure);
    const withEvent = f.store.get(rootB.id);
    withEvent.events.push({ id: randomUUID(), at: new Date().toISOString(), kind: 'error', message: 'x pass\x01word=' + T8 + ' y' });
    f.store.put(withEvent);
    const overview = buildTaskOverview(f.store, {});
    const byId = Object.fromEntries(overview.roots.map(r => [r.id, r]));
    assert.doesNotMatch(byId[rootA.id]!.lastError ?? '', new RegExp(T7));
    assert.doesNotMatch(byId[rootA.id]!.lastError ?? '', new RegExp(T9));
    assert.match(byId[rootA.id]!.lastError ?? '', /REDACTED/);
    assert.doesNotMatch(byId[rootB.id]!.lastError ?? '', new RegExp(T8));
    assert.match(byId[rootB.id]!.lastError ?? '', /REDACTED/);
    assert.doesNotMatch(byId[rootB.id]!.lastError ?? '', /[\x01]/);
  } finally { await f.close(); }
});
test('tasks.report honors expectedRevision and command-id idempotency', async () => {
  const f = setup();
  try {
    const { attached, auth } = attachOwner(f);
    const root = makeRunningRoot(f, attached.id);
    const rev = f.store.get(root.id).revision ?? 0;
    assert.equal(f.raw('tasks.report', { taskId: root.id, summary: 'stale', expectedRevision: rev + 99 }, randomUUID(), auth).error?.code, 'REVISION_CONFLICT');
    const id = randomUUID();
    const args = { taskId: root.id, summary: 'idem', percent: 10, expectedRevision: rev };
    const first = f.call('tasks.report', args, id, auth);
    const eventsAfterFirst = f.store.get(root.id).events.length;
    const revAfterFirst = f.store.get(root.id).revision;
    const replayed = f.call('tasks.report', args, id, auth);
    assert.deepEqual(replayed, first);
    assert.equal(f.store.get(root.id).events.length, eventsAfterFirst);
    assert.equal(f.store.get(root.id).revision, revAfterFirst);
    assert.equal(f.raw('tasks.report', { ...args, summary: 'changed' }, id, auth).error?.code, 'IDEMPOTENCY_CONFLICT');
  } finally { await f.close(); }
});

test('tasks.report persists through SQLite reopen and stays visible on committed reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-owner-report-persist-'));
  try {
    const store = new TaskStore(join(dir, 'weaver.db'));
    const manager = new TaskManager(store, new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs')));
    const policy = new PolicyStore(join(dir, 'weaver.db'));
    const handler = new CommandHandler(manager, policy, blockedLaunch, () => false);
    const raw = (command: string, args: Record<string, unknown> = {}, commandId = randomUUID(), ownerAuth?: unknown) =>
      handler.handle({ apiVersion: 'weaver.v1', commandId, command, args, ...(ownerAuth === undefined ? {} : { ownerAuth }) } as never);
    const profileId = Object.keys(policy.snapshot().config.owners)[0]!;
    const attached: any = (raw('owners.attach', { name: 'Persist', profileId, session: 's' }).data as any);
    const secret = JSON.parse(readFileSync(attached.credentialPath, 'utf8'));
    const auth = { ownerId: secret.ownerId, token: secret.token };
    const created: any = (raw('tasks.create', { title: 'R', instruction: 'i', ownerId: attached.id }, randomUUID(), auth).data as any);
    const t = store.get(created.id);
    t.executionRole = 'owner';
    t.status = 'running';
    t.acceptanceCriteria = ['a'];
    store.put(t);
    const rev = store.get(created.id).revision;
    const reported: any = (raw('tasks.report', { taskId: created.id, summary: 'persist me', percent: 33, expectedRevision: rev }, randomUUID(), auth).data as any);
    assert.equal(reported.ownerReport.summary, 'persist me');
    handler.draining = true;
    await manager.shutdown();
    const reopened = new TaskStore(join(dir, 'weaver.db'));
    try {
      const committed = reopened.getCommitted(created.id);
      assert.equal(committed.ownerReport?.summary, 'persist me');
      assert.equal(committed.ownerReport?.percent, 33);
      assert.equal(committed.progress, 33);
      assert.equal(committed.events.filter(e => e.kind === 'progress').length, 1);
      const manager2 = new TaskManager(reopened, new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs')));
      const policy2 = new PolicyStore(join(dir, 'weaver.db'));
      const handler2 = new CommandHandler(manager2, policy2, blockedLaunch, () => false);
      try {
        const got: any = handler2.handle({ apiVersion: 'weaver.v1', command: 'tasks.get', args: { taskId: created.id } }).data;
        assert.equal(got.ownerReport.summary, 'persist me');
        const events: any = handler2.handle({ apiVersion: 'weaver.v1', command: 'tasks.events', args: { taskId: created.id } }).data;
        assert.ok(events.events.some((e: any) => e.kind === 'progress' && e.message.includes('persist me')));
      } finally {
        handler2.draining = true;
        await manager2.shutdown();
      }
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tasks.report keeps the latest ownerReport after terminal completion', async () => {
  const f = setup();
  try {
    const { attached, auth } = attachOwner(f);
    const root = makeRunningRoot(f, attached.id, 'Terminal root');
    const running = f.store.get(root.id);
    running.run = { id: randomUUID(), adapter: 'owner-native', execution: 'native', status: 'running' };
    f.store.put(running);
    f.call('tasks.report', { taskId: root.id, summary: 'before terminal', percent: 90 }, randomUUID(), auth);
    const child = f.call('tasks.create', { parentTaskId: root.id, title: 'Child', instruction: 'work' }, randomUUID(), auth);
    const accepted = f.store.get(child.id);
    accepted.status = 'completed';
    accepted.reviewState = 'accepted';
    f.store.put(accepted);
    const rev = f.store.get(root.id).revision ?? 0;
    const completed = f.call('tasks.complete', { taskId: root.id, outcome: 'completed', summary: 'root done', expectedRevision: rev }, randomUUID(), auth);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.ownerReport.summary, 'before terminal');
    const stored = f.store.get(root.id);
    assert.equal(stored.ownerReport?.summary, 'before terminal');
    assert.equal(stored.ownerReport?.percent, 90);
    assert.equal(stored.progress, 100);
    assert.equal(f.call('tasks.get', { taskId: root.id }).ownerReport.summary, 'before terminal');
    const overview = f.call('tasks.overview', {}) as { roots: Array<{ id: string }> };
    assert.equal(overview.roots.some(r => r.id === root.id), false);
  } finally { await f.close(); }
});

test('tasks.get returns ownerReport null for old tasks and supports explicit field projection with unchanged brief', async () => {
  const f = setup();
  try {
    const task = f.call('tasks.create', { title: 'Legacy', instruction: 'fixture', owner: { name: 'demo', transport: 'herdr-visible', session: 's', pane: 'p' } });
    const full = f.call('tasks.get', { taskId: task.id });
    assert.equal(full.ownerReport, null);
    const projected = f.call('tasks.get', { taskId: task.id, fields: ['id', 'ownerReport'] });
    assert.deepEqual(projected, { id: task.id, ownerReport: null });
    const brief = f.call('tasks.get', { taskId: task.id, view: 'brief' });
    assert.equal('ownerReport' in brief, false);
    assert.deepEqual(Object.keys(brief).sort(), ['dispatch', 'id', 'ownerId', 'parentTaskId', 'progress', 'reviewState', 'status', 'title', 'updatedAt', 'workspace'].sort());
    const listed = f.call('tasks.list', { view: 'brief' }).tasks[0];
    assert.equal('ownerReport' in listed, false);
  } finally { await f.close(); }
});

test('buildTaskOverview aggregates running roots globally with child counts, last error and deterministic staleness', async () => {
  const f = setup();
  try {
    const a = attachOwner(f, 'A');
    const b = attachOwner(f, 'B');
    const rootA = makeRunningRoot(f, a.attached.id, 'Root A');
    const rootB = makeRunningRoot(f, b.attached.id, 'Root B');
    // Children of A: one queued (c1 untouched), one failed, one completed; B stays childless and unreported.
    const c1 = f.call('tasks.create', { parentTaskId: rootA.id, title: 'c1', instruction: 'w' }, randomUUID(), a.auth);
    const c2 = f.call('tasks.create', { parentTaskId: rootA.id, title: 'c2', instruction: 'w' }, randomUUID(), a.auth);
    const c3 = f.call('tasks.create', { parentTaskId: rootA.id, title: 'c3', instruction: 'w' }, randomUUID(), a.auth);
    for (const [id, status] of [[c2.id, 'failed'], [c3.id, 'completed']] as const) {
      const t = f.store.get(id);
      t.status = status;
      if (status === 'failed') t.failure = { kind: 'other', message: 'child boom' };
      f.store.put(t);
    }
    // A retry child keeps the same parentTaskId and counts as a direct child.
    const retry = f.store.get(c2.id);
    const retryId = randomUUID();
    const retryTask: Task = { ...retry, id: retryId, status: 'running', retryOf: c2.id, failure: undefined, events: [], artifacts: [] };
    f.store.put(retryTask);
    // Report on A only.
    const reported = f.call('tasks.report', { taskId: rootA.id, summary: 'A progress', percent: 20 }, randomUUID(), a.auth);
    const reportedAt = Date.parse(reported.ownerReport.reportedAt);
    const overview = buildTaskOverview(f.store, { staleAfterSeconds: 900, now: reportedAt + 100 * 1000 });
    assert.equal(overview.staleAfterSeconds, 900);
    assert.equal(overview.roots.length, 2);
    const byId = Object.fromEntries(overview.roots.map(r => [r.id, r]));
    assert.deepEqual(byId[rootA.id]!.childCounts, { total: 4, queued: 1, running: 1, cancelling: 0, completed: 1, failed: 1, cancelled: 0 });
    assert.equal(byId[rootA.id]!.ownerReport?.summary, 'A progress');
    assert.equal(byId[rootA.id]!.reportAgeSeconds, 100);
    assert.equal(byId[rootA.id]!.reportStale, false);
    assert.equal(byId[rootB.id]!.ownerReport, null);
    assert.equal(byId[rootB.id]!.reportAgeSeconds, null);
    assert.equal(byId[rootB.id]!.reportStale, false);
    assert.deepEqual(byId[rootB.id]!.childCounts, { total: 0, queued: 0, running: 0, cancelling: 0, completed: 0, failed: 0, cancelled: 0 });
    // Stale boundary: age >= staleAfterSeconds is stale; 0 forces stale when reported.
    const zero = buildTaskOverview(f.store, { staleAfterSeconds: 0, now: reportedAt + 100 * 1000 });
    assert.equal(zero.roots.find(r => r.id === rootA.id)!.reportStale, true);
    assert.equal(zero.roots.find(r => r.id === rootB.id)!.reportStale, false);
    const exact = buildTaskOverview(f.store, { staleAfterSeconds: 100, now: reportedAt + 100 * 1000 });
    assert.equal(exact.roots.find(r => r.id === rootA.id)!.reportStale, true);
    const justBefore = buildTaskOverview(f.store, { staleAfterSeconds: 101, now: reportedAt + 100 * 1000 });
    assert.equal(justBefore.roots.find(r => r.id === rootA.id)!.reportStale, false);
    // Owner filter keeps the authenticated policy: global by default, filtered when requested.
    const filtered = buildTaskOverview(f.store, { ownerId: a.attached.id });
    assert.deepEqual(filtered.roots.map(r => r.id), [rootA.id]);
    // Last error prefers failure.message over newer non-error events.
    const withFailure = f.store.get(rootA.id);
    withFailure.failure = { kind: 'other', message: 'root failure wins' };
    withFailure.events.push({ id: randomUUID(), at: new Date().toISOString(), kind: 'lifecycle', message: 'newer non-error' });
    f.store.put(withFailure);
    const errOverview = buildTaskOverview(f.store, {});
    assert.equal(errOverview.roots.find(r => r.id === rootA.id)!.lastError, 'root failure wins');
    // Without failure, the latest error event is used.
    const noFailure = f.store.get(rootB.id);
    noFailure.events.push({ id: randomUUID(), at: new Date().toISOString(), kind: 'error', message: 'first boom' });
    noFailure.events.push({ id: randomUUID(), at: new Date().toISOString(), kind: 'error', message: 'latest boom' });
    f.store.put(noFailure);
    const err2 = buildTaskOverview(f.store, {});
    assert.equal(err2.roots.find(r => r.id === rootB.id)!.lastError, 'latest boom');
    // Invalid options fail without leaking.
    assert.throws(() => buildTaskOverview(f.store, { staleAfterSeconds: -1 }), /staleAfterSeconds/);
    assert.throws(() => buildTaskOverview(f.store, { staleAfterSeconds: 86401 }), /staleAfterSeconds/);
    // tasks.overview command uses the same builder and reads committed state.
    const viaCommand = f.call('tasks.overview', {});
    assert.equal(viaCommand.roots.length, 2);
    const viaZero = f.call('tasks.overview', { staleAfterSeconds: 0 });
    assert.equal(viaZero.staleAfterSeconds, 0);
    assert.equal(viaZero.roots.find((r: any) => r.id === rootA.id).reportStale, true);
    const viaFiltered = f.call('tasks.overview', { ownerId: b.attached.id });
    assert.deepEqual(viaFiltered.roots.map((r: any) => r.id), [rootB.id]);
    assert.equal(f.raw('tasks.overview', { staleAfterSeconds: -5 }).error?.code, 'INVALID_REQUEST');
    assert.equal(f.raw('tasks.overview', { staleAfterSeconds: 1.5 }).error?.code, 'INVALID_REQUEST');
    assert.equal(f.raw('tasks.overview', { staleAfterSeconds: '900' }).error?.code, 'INVALID_REQUEST');
    assert.equal(f.raw('tasks.overview', { nope: 1 }).error?.code, 'INVALID_REQUEST');
  } finally { await f.close(); }
});

test('tasks.report and tasks.overview appear in the CLI catalog and help', async () => {
  assert.ok(CLI_CATALOG.some(c => c.command === 'tasks.report' && c.mutation === true));
  assert.ok(CLI_CATALOG.some(c => c.command === 'tasks.overview' && c.mutation === false));
  assert.ok(catalogCommand(['tasks', 'report'])?.command === 'tasks.report');
  assert.ok(catalogCommand(['tasks', 'overview'])?.command === 'tasks.overview');
  assert.match(CLI_HELP, /tasks report/);
  assert.match(CLI_HELP, /tasks overview/);
  const root = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', '--help', '--output', 'json'], { cwd: resolve('.'), timeout: 15000 });
  const catalog = JSON.parse(root.stdout).data.catalog as Array<{ command: string }>;
  assert.ok(catalog.some(c => c.command === 'tasks.report'));
  assert.ok(catalog.some(c => c.command === 'tasks.overview'));
  const reportHelp = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'tasks', 'report', '--help'], { cwd: resolve('.'), timeout: 15000 });
  assert.match(reportHelp.stdout, /tasks report/);
  const overviewHelp = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'tasks', 'overview', '--help'], { cwd: resolve('.'), timeout: 15000 });
  assert.match(overviewHelp.stdout, /tasks overview/);
});
