import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../../src/shared/contracts/tasks';
import type { OpenCodeAccountQuotas, OpenCodeAccountRef } from '../../src/shared/contracts/opencode-account-quotas';
import { OpenCodeAccountAdmission } from '../../src/main/application/scheduling/opencode-accounts';

const A = { accountID: 'a', orgID: 'one' }; const B = { accountID: 'b', orgID: 'two' };
const task = (model = 'opencode-go/kimi'): Task => ({ owner: { name: 'fixture', transport: 'herdr-visible', session: 'fixture', pane: 'fixture' }, id: 'task', title: 'fixture', instruction: 'fixture', status: 'queued', progress: 0, createdAt: '', updatedAt: '', events: [], artifacts: [], dispatch: { owner: 'owner', worker: 'worker', engine: 'opencode', engineKind: 'opencode', model, effort: 'default', execution: 'real', maxParallel: 3 } });
function fixture(discovered = true) {
 let actual: OpenCodeAccountRef = A; let switches = 0; let refreshes = 0; let busy: string | undefined; let tasks: Task[] = []; let refuseGo = false; let now = Date.now(); let onRefresh: (() => void) | undefined;
 const snapshot: OpenCodeAccountQuotas = { active: A, switching: false, accounts: [A, B].map((ref, i) => ({ account: { ...ref, accountEmail: `${ref.accountID}@example.test`, accountUrl: 'https://opencode.ai/console', orgName: ref.orgID, active: i === 0 }, quota: { engine: 'opencode', status: i === 0 ? 'exhausted' : 'available', source: 'fixture', stale: false, checkedAt: new Date().toISOString(), observedAt: new Date().toISOString(), windows: [], detail: '', retryAt: null }, goReady: true, cooldownUntil: null })) };
 const failures: Array<{ ref: OpenCodeAccountRef; runID: string }> = [];
 const nativeSnapshot = () => ({ orgs: snapshot.accounts.map(a => ({ ...a.account, active: a.account.accountID === actual.accountID })), consoleManagedProviders: refuseGo ? [] : ['opencode-go'], switchableOrgCount: 2 });
 const pool = { hasFailure: (ref: OpenCodeAccountRef) => failures.some(item => item.ref.accountID === ref.accountID && item.ref.orgID === ref.orgID), get: () => structuredClone(snapshot), refresh: async () => { refreshes++; onRefresh?.(); return structuredClone(snapshot); }, setActive: (ref: OpenCodeAccountRef | null) => { snapshot.active = ref; }, setSwitching: (value: boolean, detail?: string) => { snapshot.switching = value; snapshot.detail = detail; }, candidate: () => snapshot.accounts.find(a => a.account.accountID !== snapshot.active?.accountID && a.goReady && a.quota.status === 'available' && !a.quota.stale && !a.cooldownUntil), recordFailure: (ref: OpenCodeAccountRef, f: { runID: string }) => { failures.push({ ref, runID: f.runID }); } };
 const gate = new OpenCodeAccountAdmission({ pool, now: () => now, native: { list: async () => nativeSnapshot(), switchAccount: async input => { switches++; actual = input; return nativeSnapshot(); } }, tasks: () => tasks, readActive: () => actual, busyReason: () => busy, externalBusy: () => undefined, wake: () => {} });
 if (discovered) gate.refreshed();
 return { gate, snapshot, failures, set now(value: number) { now = value; }, set onRefresh(value: () => void) { onRefresh = value; }, get switches() { return switches; }, get refreshes() { return refreshes; }, set busy(value: string | undefined) { busy = value; }, set tasks(value: Task[]) { tasks = value; }, set actual(value: OpenCodeAccountRef) { actual = value; }, set refuseGo(value: boolean) { refuseGo = value; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('two queued Go tasks share one native switch and capture B; failure task is never replayed', async () => {
 const f = fixture(); const first = task(); const second = { ...task(), id: 'second' };
 assert.ok(f.gate.admit(first)); assert.ok(f.gate.admit(second)); await tick();
 assert.equal(f.switches, 1); assert.equal(f.gate.admit(first), undefined); assert.equal(f.gate.capture(first)?.accountID, 'b');
 const failed = { ...task(), status: 'failed', failure: { kind: 'quota', message: 'modified files before limit' }, run: { id: 'run-a', adapter: 'opencode', status: 'stopped', finalizedAt: 'done', consoleAccount: { ...A, generation: 0 } } } as Task;
 assert.equal(f.gate.recordFailure(failed), true); assert.deepEqual(f.failures[0]?.ref.accountID, 'a'); assert.equal(failed.status, 'failed'); assert.equal(f.switches, 1); await f.gate.close();
});
test('running, stopping, recovered-unfinalized, IM and external leases hold cursor; non-Go stays available', async () => {
 for (const mode of ['running', 'stopping', 'recovery', 'im', 'external', 'probe']) {
  const f = fixture(); let release: (() => void) | undefined;
  if (mode === 'im' || mode === 'external') f.busy = `${mode} busy`;
  else if (mode === 'probe') release = f.gate.lease();
  else { const running = task(); running.status = mode === 'running' ? 'running' : 'failed'; running.run = { id: 'running', adapter: 'opencode', status: mode === 'stopping' ? 'stopping' : 'running' }; f.tasks = [running]; }
  assert.ok(f.gate.admit(task())); await tick(); assert.equal(f.switches, 0, mode); assert.equal(f.gate.admit(task('opencode/free')), undefined); release?.(); await f.gate.close();
 }
});
test('unknown and stale without proven limits use existing dispatch, free models never consume pool gate', async () => {
 const f = fixture(); f.snapshot.accounts[0]!.quota.status = 'unknown'; f.snapshot.accounts[0]!.quota.stale = true;
 assert.equal(f.gate.admit(task()), undefined); assert.equal(f.switches, 0);
 f.snapshot.accounts[0]!.quota.status = 'exhausted'; assert.equal(f.gate.admit(task()), undefined); f.snapshot.accounts[0]!.quota.stale = false; f.snapshot.accounts[1]!.quota.status = 'unknown'; f.snapshot.accounts[1]!.quota.stale = true;
 assert.ok(f.gate.admit(task())); await tick(); assert.equal(f.switches, 0); assert.equal(f.refreshes, 1); assert.match(f.snapshot.detail!, /全部账号/); assert.equal(f.gate.admit(task('other-provider/model')), undefined); await f.gate.close();
});
test('manual mutation and beforeSpawn gate reject mismatched captured cursor and pending launch', async () => {
 const f = fixture(); f.snapshot.accounts[0]!.quota.status = 'available';
 const queued = task(); const captured = f.gate.capture(queued)!; queued.run = { id: 'run', adapter: 'opencode', status: 'running', consoleAccount: captured };
 f.gate.beforeSpawn(queued);
 f.actual = B; assert.throws(() => f.gate.beforeSpawn(queued), /启动前变化/);
 f.actual = A; const release = f.gate.beginMutation(); assert.throws(() => f.gate.beforeSpawn(queued), /账号状态暂不允许启动/); assert.throws(() => f.gate.lease(), /账号正在切换/); release();
 f.tasks = [queued]; assert.throws(() => f.gate.beginMutation(), /任务尚未结束/); await f.gate.close();
});
test('switch target without native Go managed provider stays fenced and never reverses automatically', async () => {
 const f = fixture(); f.refuseGo = true; assert.ok(f.gate.admit(task())); await tick();
 assert.equal(f.switches, 1); assert.throws(() => f.gate.capture(task()), /状态尚未确认/); assert.equal(f.failures[0]?.ref.accountID, 'b'); await f.gate.close();
});

test('first Go admission discovers native account pool before capture; no Console or single unknown stays legacy', async () => {
 const f = fixture(false); assert.match(f.gate.admit(task())!, /首次确认/); assert.equal(f.switches, 0); await tick(); assert.equal(f.refreshes, 1);
 assert.ok(f.gate.admit(task())); await tick(); assert.equal(f.switches, 1); await f.gate.close();
 const g = fixture(false); g.snapshot.accounts = []; g.snapshot.active = null; assert.ok(g.gate.admit(task())); await tick(); assert.equal(g.gate.admit(task()), undefined); assert.equal(g.gate.capture(task()), undefined); await g.gate.close();
 const h = fixture(); h.snapshot.accounts[0]!.quota.status = 'unknown'; h.snapshot.accounts[0]!.goReady = false; assert.equal(h.gate.capture(task()), undefined); await h.gate.close();
});
test('finishing a busy task retries waiting-for-idle immediately instead of sleeping through its cooldown timer', async () => {
 const f = fixture(); const running = task(); running.status = 'running'; f.tasks = [running]; assert.ok(f.gate.admit(task())); await tick(); assert.equal(f.switches, 0);
 f.tasks = []; f.gate.activityChanged(); assert.ok(f.gate.admit(task())); await tick(); assert.equal(f.switches, 1); await f.gate.close();
});

test('manager direct start and its actual beforeSpawn permission cannot bypass the generic guard', async () => {
 const { TaskManager } = await import('../../src/main/manager'); const { TaskStore } = await import('../../src/main/store');
 const { mkdtempSync, rmSync } = await import('node:fs'); const { join } = await import('node:path'); const { EventEmitter } = await import('node:events');
 const root = mkdtempSync(join(process.env.ACCEPTANCE_TMPDIR ?? tmpdir(), 'weaver-account-mgr-')); const store = new TaskStore(join(root, 'weaver.db')); let spawns = 0;
 const manager = new TaskManager(store, { id: 'file-fixture', start: () => { throw Error('unused legacy'); }, startRun: (_task: Task, _run: string, permit: (record: never) => void) => { permit({} as never); spawns++; return new EventEmitter(); } } as never);
 try {
  const created = manager.create({ title: 'fixture', instruction: 'isolated fixture', owner: task().owner }); created.dispatch = task().dispatch; manager.update(created);
  manager.launchGuard = { capture: () => { throw Error('closed at start'); }, beforeSpawn: () => {} };
  assert.throws(() => manager.start(created.id), /closed at start/); assert.equal(store.get(created.id).status, 'queued'); assert.equal(store.get(created.id).run, undefined);
  manager.launchGuard = { capture: () => ({ ...A, generation: 3 }), beforeSpawn: () => { throw Error('closed before spawn'); } };
  const failed = manager.start(created.id); assert.equal(spawns, 0); assert.equal(failed.status, 'failed'); assert.match(failed.failure!.message, /closed before spawn/); assert.deepEqual(failed.run?.consoleAccount, { ...A, generation: 3 });
 } finally { await manager.shutdown(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('captured account failure bypasses worker penalties while existing manual and unknown vendor blocks survive restart', async () => {
 const { TaskManager } = await import('../../src/main/manager'); const { TaskStore } = await import('../../src/main/store'); const { PolicyStore } = await import('../../src/main/policy/store'); const { VendorLimits } = await import('../../src/main/application/scheduling/vendor-limits');
 const { mkdtempSync, rmSync } = await import('node:fs'); const { join } = await import('node:path');
 const root = mkdtempSync(join(process.env.ACCEPTANCE_TMPDIR ?? tmpdir(), 'weaver-account-vendor-')); const store = new TaskStore(join(root, 'weaver.db')); const policy = new PolicyStore(store.db); const manager = new TaskManager(store, { id: 'unused', start: () => { throw Error('must never replay'); } }); const f = fixture();
 try {
  const saved = policy.snapshot(); const blocks = [{ engine: 'opencode', model: 'opencode-go/other', reason: 'manual block', since: new Date().toISOString(), by: 'user' }, { engine: 'opencode', worker: Object.entries(saved.config.workers).find(([, worker]) => worker.engine === 'opencode')![0], reason: 'old unknown account vendor', since: new Date().toISOString(), by: 'weaver-vendor-limit' }]; policy.save({ revision: saved.revision, config: saved.config, blocks });
  const failed = manager.create({ title: 'failure', instruction: 'already changed files', owner: task().owner }); failed.dispatch = task().dispatch; failed.status = 'failed'; failed.failure = { kind: 'quota', message: 'known A failure' }; failed.run = { id: 'old-a-run', adapter: 'opencode', status: 'stopped', finalizedAt: 'done', consoleAccount: { ...A, generation: 1 } }; store.put(failed);
  const limits = new VendorLimits(manager, policy, f.gate); limits.applyVendorBlocks(); assert.equal(f.failures[0]?.ref.accountID, 'a'); assert.deepEqual(policy.snapshot().blocks, blocks); assert.equal(store.get(failed.id).status, 'failed');
  const restarted = new VendorLimits(manager, policy, f.gate); restarted.applyVendorBlocks(); assert.deepEqual(policy.snapshot().blocks, blocks); assert.equal(store.get(failed.id).run?.id, 'old-a-run');
 } finally { await f.gate.close(); await manager.shutdown(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('persisted account failure remains a gate after cooldown expires until a fresh recovery is recorded', async () => {
 const f = fixture(); f.snapshot.accounts[0]!.quota.status = 'available'; f.snapshot.accounts[0]!.quota.stale = true;
 const failed = { ...task(), failure: { kind: 'rate_limit', message: 'known A limit' }, run: { id: 'cooldown-a', adapter: 'opencode', status: 'stopped', consoleAccount: { ...A, generation: 0 } } } as Task;
 f.gate.recordFailure(failed); assert.ok(f.gate.admit(task())); await tick(); assert.equal(f.switches, 1); await f.gate.close();
});

test('expired Go proof is refreshed without UI activity before capturing the next run and attributing its failure', async () => {
 const f = fixture(); f.snapshot.accounts[0]!.quota.status = 'available'; f.gate.refreshed();
 f.now = Date.now() + 6 * 60_000; f.snapshot.accounts[0]!.goReady = false; f.snapshot.accounts[0]!.quota.stale = true;
 f.onRefresh = () => { f.snapshot.accounts[0]!.goReady = true; f.snapshot.accounts[0]!.quota.stale = false; };
 assert.match(f.gate.admit(task())!, /更新当前账号/); await tick(); const captured = f.gate.capture(task())!; assert.equal(captured.accountID, 'a');
 const failed = { ...task(), failure: { kind: 'quota', message: 'A quota exhausted' }, run: { id: 'expired-proof-a', adapter: 'opencode', status: 'stopped', consoleAccount: captured } } as Task;
 f.gate.recordFailure(failed); assert.ok(f.gate.admit(task())); await tick(); assert.equal(f.switches, 1); assert.equal(f.gate.capture(task())?.accountID, 'b'); await f.gate.close();
});
