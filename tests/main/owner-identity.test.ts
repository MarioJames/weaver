import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { MockWorkerAdapter } from '../../src/main/adapters/worker';
import { CommandHandler } from '../../src/main/commands';
import { PolicyStore } from '../../src/main/policy/store';
import { OwnerLaunchError, type OwnerLaunchInput, type OwnerLaunchResult } from '../../src/main/owner-host';
import type { Task } from '../../src/shared/contracts/tasks';

const blockedLaunch = (input: OwnerLaunchInput): OwnerLaunchResult => { throw new OwnerLaunchError('OWNER_LAUNCH_FAILED', `Test did not inject an owner launcher for ${input.taskId}`); };
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function open(dir = mkdtempSync(join(tmpdir(), 'weaver-owner-identity-'))) {
  const store = new TaskStore(join(dir, 'weaver.db'));
  const manager = new TaskManager(store, new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs')));
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  const handler = new CommandHandler(manager, policy, blockedLaunch, () => false);
  const raw = (command: string, args: Record<string, unknown> = {}, commandId = randomUUID(), ownerAuth?: unknown) =>
    handler.handle({ apiVersion: 'weaver.v1', commandId, command, args, ...(ownerAuth === undefined ? {} : { ownerAuth }) } as never);
  const call = (command: string, args: Record<string, unknown> = {}, commandId = randomUUID(), ownerAuth?: unknown): any => {
    const response = raw(command, args, commandId, ownerAuth);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  const attach = (args: Record<string, unknown>, commandId = randomUUID()) => call('owners.attach', args, commandId);
  const stop = async (remove = true) => { handler.draining = true; await manager.shutdown(); if (remove) rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, manager, policy, handler, raw, call, attach, stop };
}

function fileOf(path: string) {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version: number; ownerId: string; token: string };
  return parsed;
}
function assertNoSecret(value: unknown, secrets: string[]) {
  const encoded = JSON.stringify(value);
  for (const secret of secrets) assert.equal(encoded.includes(secret), false, 'public output leaked private credential material');
}
async function done(f: ReturnType<typeof open>, id: string) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const task = f.store.get(id);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 15));
  }
  throw new Error('timeout');
}
const authOf = (ownerId: string, token: string) => ({ ownerId, token });

test('attach returns a private credential file, reuses it across repeats and restart, and keeps it out of public data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-owner-identity-'));
  const first = open(dir);
  const args = { name: 'CLI owner', profileId: 'codex_owner', session: 'pane-1', pane: 'pane-1' };
  let ownerId = '';
  let token = '';
  try {
    const attached = first.attach(args);
    ownerId = attached.id;
    const credentialPath = attached.credentialPath as string;
    assert.equal(credentialPath, join(dir, 'owner-credentials', `${ownerId}.json`));
    assert.equal(statSync(join(dir, 'owner-credentials')).mode & 0o777, 0o700);
    assert.equal(statSync(credentialPath).mode & 0o777, 0o600);
    const secret = fileOf(credentialPath);
    token = secret.token;
    assert.deepEqual(Object.keys(secret).sort(), ['ownerId', 'token', 'version']);
    assert.equal(secret.version, 1);
    assert.equal(secret.ownerId, ownerId);
    assert.match(token, /^[0-9a-f]{64}$/);
    assertNoSecret(attached, [token]);
    // The existing kv store keeps only a digest; public owner views never carry the path, token or digest.
    const stored = first.store.getValue<Record<string, unknown>>(`owner.credential.v1.${ownerId}`);
    assert.equal(stored?.digest, sha256(token));
    assertNoSecret(stored, [token]);
    assertNoSecret({
      list: first.call('owners.list'),
      get: first.call('owners.get', { ownerId }),
      snapshot: first.call('sync.snapshot'),
    }, [token, 'credentialPath', String(stored?.digest)]);
    // A repeat under a fresh command ID is the same owner and the same credential file.
    const repeated = first.attach(args);
    assert.equal(repeated.id, ownerId);
    assert.equal(repeated.credentialPath, credentialPath);
    assert.equal(sha256(fileOf(credentialPath).token), sha256(token));
    // The write receipt stores only the path-bearing response, never the token.
    const commandId = randomUUID();
    const replayable = first.attach({ ...args, title: 'Retained' }, commandId);
    assertNoSecret(replayable, [token]);
    assert.deepEqual(first.attach({ ...args, title: 'Retained' }, commandId), replayable);
    assertNoSecret(first.raw('operations.get', { commandId }), [token]);
  } finally { await first.stop(false); }
  const second = open(dir);
  try {
    const restored = second.attach(args);
    assert.equal(restored.id, ownerId, 'the durable registration survives a restart');
    assert.equal(restored.credentialPath, join(dir, 'owner-credentials', `${ownerId}.json`));
    assert.equal(sha256(fileOf(restored.credentialPath).token), sha256(token), 'the credential token is reused rather than rotated');
    const task = second.call('tasks.create', { title: 'Authenticated after restart', instruction: 'safe mock' }, randomUUID(), authOf(ownerId, token));
    assert.equal(task.ownerId, ownerId);
  } finally { await second.stop(); }
});

test('attach with ownerId claims the existing root owner instead of creating another one', async () => {
  const f = open();
  try {
    const root = f.call('tasks.create', { title: 'Root', goal: 'fixture', ownerProfileId: 'codex_owner' });
    const child = f.call('tasks.create', { title: 'Child', instruction: 'fixture', ownerId: root.ownerId });
    assert.equal(f.call('owners.list').owners.length, 1);
    const claimed = f.attach({ ownerId: root.ownerId, name: 'Herdr root', profileId: 'codex_owner', session: 'pane-9', pane: 'pane-9', title: '  Claimed root  ' });
    assert.equal(claimed.id, root.ownerId, 'claiming keeps the existing identity');
    assert.equal(claimed.name, 'Herdr root');
    assert.equal(claimed.session, 'pane-9');
    assert.equal(claimed.host.session, 'pane-9');
    assert.equal(claimed.host.pane, 'pane-9');
    assert.equal(claimed.host.verified, false);
    assert.equal(claimed.title, 'Claimed root');
    assert.ok(claimed.credentialPath);
    assert.equal(f.call('owners.list').owners.length, 1, 'claiming never adds an owner');
    assert.equal(f.store.get(root.id).ownerId, root.ownerId);
    assert.equal(f.store.get(child.id).ownerId, root.ownerId, 'existing child bindings stay with the claimed owner');
    assert.equal(f.call('owners.get', { ownerId: root.ownerId }).name, 'Herdr root');
    // A different profile, an unknown owner and a logical mock owner are explicit refusals.
    assert.equal(f.raw('owners.attach', { ownerId: root.ownerId, name: 'Wrong', profileId: 'claude_owner' }).error?.code, 'INVALID_REQUEST');
    assert.equal(f.raw('owners.attach', { ownerId: randomUUID(), name: 'Missing', profileId: 'codex_owner' }).error?.code, 'NOT_FOUND');
    const mock = f.call('owners.spawn', { name: 'Logical demo', profileId: 'codex_owner', provider: 'mock' });
    assert.equal(f.raw('owners.attach', { ownerId: mock.id, name: 'Mock claim', profileId: 'codex_owner' }).error?.code, 'INVALID_STATE');
    assert.equal(f.call('owners.get', { ownerId: root.ownerId }).name, 'Herdr root', 'a rejected claim changes nothing');
  } finally { await f.stop(); }
});

test('ownerAuth binds create, freeze, dispatch, acknowledgement, review and retry while foreign ids fail closed', async () => {
  const f = open();
  try {
    const a = f.attach({ name: 'Owner A', profileId: 'codex_owner', session: 'a' });
    const b = f.attach({ name: 'Owner B', profileId: 'codex_owner', session: 'b' });
    const tokenA = fileOf(a.credentialPath).token;
    const authA = authOf(a.id, tokenA);
    const authB = authOf(b.id, fileOf(b.credentialPath).token);
    const root = f.call('tasks.create', { title: 'Root', instruction: 'fixture' }, randomUUID(), authA) as Task;
    const described = f.store.get(root.id);described.executionRole='owner';described.status='running';described.acceptanceCriteria=['fixture'];
    f.store.put(described);
    const child = f.call('tasks.create', { parentTaskId: root.id, title: 'Child', instruction: 'fixture' }, randomUUID(), authA) as Task;
    assert.equal(child.ownerId, a.id, 'a parent-bound create keeps the authenticated owner');
    assert.equal(child.parentTaskId, root.id);
    assert.equal(f.raw('tasks.create', { parentTaskId: root.id, title: 'Foreign child', instruction: 'fixture' }, randomUUID(), authB).error?.code, 'FORBIDDEN');
    const task = child;
    assert.equal(task.ownerId, a.id, 'an authenticated create binds the credential owner');
    assert.equal(f.raw('tasks.create', { title: 'Other owner', instruction: 'fixture', ownerId: b.id }, randomUUID(), authA).error?.code, 'FORBIDDEN');
    assert.equal(f.raw('tasks.create', { title: 'Other profile', instruction: 'fixture', ownerProfileId: 'claude_owner' }, randomUUID(), authA).error?.code, 'FORBIDDEN');
    const pkg = f.call('packages.create', { taskId: task.id, scope: ['fixture'], acceptanceCriteria: ['result'], expectedRevision: task.revision }, randomUUID(), authA);
    const dispatched = f.call('workers.spawn', { taskId: task.id, packageId: pkg.id }, randomUUID(), authA);
    assert.equal(dispatched.dispatch.execution, 'mock');
    const completed = await done(f, task.id);
    assert.equal(completed.ownerId, a.id);
    const manifest = f.call('tasks.results', { taskId: task.id }, randomUUID(), authA);
    const ack = f.call('results.ack', { taskId: task.id, manifestDigest: manifest.manifestDigest, expectedRevision: f.store.get(task.id).revision }, randomUUID(), authA);
    assert.equal(ack.delivery, 'acknowledged');
    const review = f.call('reviews.submit', { taskId: task.id, manifestDigest: manifest.manifestDigest, decision: 'accepted', expectedRevision: f.store.get(task.id).revision }, randomUUID(), authA);
    assert.equal(review.acceptance, 'accepted');
    const retryId = randomUUID();
    const retry = f.call('tasks.retry', { taskId: task.id }, retryId, authA);
    assert.equal(retry.ownerId, a.id, 'retry inherits the original owner, not the caller shortcut');
    assert.equal(retry.retryOf, task.id);
    assert.equal(retry.parentTaskId, root.id, 'a retry keeps the original parent binding');
    assertNoSecret({
      task: f.call('tasks.get', { taskId: task.id }, randomUUID(), authA),
      list: f.call('tasks.list', {}, randomUUID(), authA),
      results: f.call('tasks.results', { taskId: task.id }, randomUUID(), authA),
      observability: f.call('observability.get', { taskId: task.id }, randomUUID(), authA),
      receipt: f.call('operations.get', { commandId: retryId }, randomUUID(), authA),
    }, [tokenA, sha256(tokenA)]);
    // Another credential may not read or mutate this task through any command face.
    const foreignRequests: [string, Record<string, unknown>][] = [
      ['tasks.get', { taskId: task.id }],
      ['tasks.events', { taskId: task.id }],
      ['tasks.cancel', { taskId: task.id }],
      ['workers.spawn', { taskId: task.id }],
      ['tasks.retry', { taskId: task.id }],
      ['reviews.submit', { taskId: task.id, manifestDigest: manifest.manifestDigest, decision: 'rejected', expectedRevision: f.store.get(task.id).revision }],
      ['packages.get', { packageId: pkg.id }],
      ['tasks.create', { parentTaskId: task.id, title: 'Foreign child', instruction: 'fixture' }],
    ];
    for (const [command, args] of foreignRequests) assert.equal(f.raw(command, args, randomUUID(), authB).error?.code, 'FORBIDDEN', command);
    assert.equal(f.store.get(task.id).status, 'completed', 'a rejected foreign cancel changed nothing');
    // The trusted local administrator path is unchanged when ownerAuth is absent.
    assert.equal(f.call('tasks.get', { taskId: task.id }).ownerId, a.id);
    assert.equal(f.call('owners.list').owners.length, 2);
  } finally { await f.stop(); }
});

test('owner receipts live in their own namespace and authentication precedes replay', async () => {
  const f = open();
  try {
    const a = f.attach({ name: 'Owner A', profileId: 'codex_owner', session: 'a' });
    const b = f.attach({ name: 'Owner B', profileId: 'codex_owner', session: 'b' });
    const authA = authOf(a.id, fileOf(a.credentialPath).token);
    const authB = authOf(b.id, fileOf(b.credentialPath).token);
    const commandId = randomUUID();
    const args = { title: 'Namespaced', instruction: 'safe mock' };
    const owned = f.call('tasks.create', args, commandId, authA);
    const receipt = f.call('operations.get', { commandId }, randomUUID(), authA);
    assert.equal(receipt.state, 'settled');
    assert.deepEqual(receipt.response.data, owned);
    assert.equal(f.raw('operations.get', { commandId }).error?.code, 'NOT_FOUND', 'the administrator namespace does not expose an owner receipt');
    assert.equal(f.raw('operations.get', { commandId }, randomUUID(), authB).error?.code, 'NOT_FOUND', 'another owner namespace does not expose the receipt');
    assert.deepEqual(f.call('tasks.create', args, commandId, authA), owned, 'the same owner replays its receipt');
    // The same command ID remains independent in the administrator namespace.
    const admin = f.call('tasks.create', { title: 'Administrator task', instruction: 'safe mock', ownerId: a.id }, commandId);
    assert.notEqual(admin.id, owned.id);
    assert.equal(f.call('operations.get', { commandId }).response.data.id, admin.id);
    // Authentication is checked before the receipt is replayed or an intent is written.
    assert.equal(f.raw('tasks.create', args, commandId, { ...authA, token: '0'.repeat(64) }).error?.code, 'UNAUTHORIZED');
    assert.equal(f.raw('tasks.create', args, commandId, { ownerId: a.id }).error?.code, 'UNAUTHORIZED');
    assert.equal(f.raw('tasks.create', args, commandId, { ownerId: b.id, token: authA.token }).error?.code, 'UNAUTHORIZED');
    assert.equal(f.raw('tasks.create', args, commandId, null).error?.code, 'UNAUTHORIZED');
    assert.notEqual(f.store.getReceipt(`local-owner:${a.id}:${commandId}`), undefined);
    assert.equal(f.store.list().filter(task => task.title === 'Namespaced').length, 1, 'invalid credentials never execute');
    // Scope is checked before namespace replay: B cannot borrow A's command ID to reach A's task.
    assert.equal(f.raw('tasks.cancel', { taskId: owned.id }, commandId, authB).error?.code, 'FORBIDDEN');
    assert.equal(f.store.get(owned.id).status, 'queued');
  } finally { await f.stop(); }
});

test('a tampered credential file is rejected instead of falling back to the administrator', async () => {
  const f = open();
  try {
    const a = f.attach({ name: 'Owner A', profileId: 'codex_owner', session: 'a' });
    const auth = authOf(a.id, fileOf(a.credentialPath).token);
    assert.equal(f.call('tasks.create', { title: 'Before tamper', instruction: 'safe mock' }, randomUUID(), auth).ownerId, a.id);
    chmodSync(a.credentialPath, 0o644);
    assert.equal(f.raw('tasks.create', { title: 'After tamper', instruction: 'safe mock' }, randomUUID(), auth).error?.code, 'UNAUTHORIZED');
    chmodSync(a.credentialPath, 0o600);
    assert.equal(f.call('tasks.create', { title: 'Restored', instruction: 'safe mock' }, randomUUID(), auth).ownerId, a.id);
  } finally { await f.stop(); }
});
