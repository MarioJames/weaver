import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../../src/main/store';
import { PolicyStore } from '../../src/main/policy/store';
import { ScheduleService } from '../../src/main/schedules/service';
import { startCliAgent } from '../../src/main/adapters/cli/launch';
import { buildDirectPrompt, classifyScheduleAgent, cleanupStateDir, directStateDir, neutralScheduleWorkspace } from '../../src/main/schedules/agent';
import type { ScheduleDefinition, ScheduleRun } from '../../src/shared/contracts/schedules';
import type { CliAgentInput, ManagedAgentProcess } from '../../src/main/adapters/cli/types';
import type { PreparedCliAgent } from '../../src/main/adapters/cli/launch';
import { ConfirmedParentCancellation, ParentAgentError } from '../../src/main/im/parent-agent';

const ROOT = process.env.ACCEPTANCE_TMPDIR ?? tmpdir();
mkdirSync(ROOT, { recursive: true });
const AT = Date.parse('2030-01-01T00:00:00Z');

function setup() {
  const dir = mkdtempSync(join(ROOT, 'wv-sch-exec-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const policy = new PolicyStore(store.db);
  return { dir, store, policy, close() { try { store.close(); } finally { rmSync(dir, { recursive: true, force: true }); } } };
}

function save(policy: PolicyStore, mutate: (s: ReturnType<PolicyStore['snapshot']>) => void) {
  const snap = policy.snapshot();
  mutate(snap);
  policy.save({ revision: snap.revision, config: snap.config, blocks: snap.blocks }, { allowEngineEnable: true });
}

const waitFor = async (predicate: () => boolean, timeout = 10000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 20));
  }
};

type FakeCliOptions = {
  engine: string; model: string; effort: string; workspace: string; role?: string;
  summary?: string; terminal?: string; exitCode?: number | null; neverClose?: boolean;
  onInput?: (input: CliAgentInput) => void;
};

function fakeCliProcess(unit: string, opts: FakeCliOptions): ManagedAgentProcess & { writeResult: () => void; closeNow: (code?: number | null) => void } {
  const proc = new EventEmitter() as unknown as ManagedAgentProcess & { writeResult: () => void; closeNow: (code?: number | null) => void };
  (proc as unknown as { stdout: PassThrough }).stdout = new PassThrough();
  (proc as unknown as { stderr: PassThrough }).stderr = new PassThrough();
  (proc as unknown as { scopeUnit: string }).scopeUnit = unit;
  (proc as unknown as { evidence: ManagedAgentProcess['evidence'] }).evidence = {
    engine: opts.engine as never, requestedModel: opts.model, requestedEffort: opts.effort,
    workspace: opts.workspace, role: opts.role as never, terminal: 'pending',
  };
  let killed = false;
  (proc as unknown as { kill: (s?: NodeJS.Signals) => boolean }).kill = () => { killed = true; setImmediate(() => (proc as unknown as EventEmitter).emit('close', 1, 'SIGTERM')); return true; };
  (proc as unknown as { writeResult: () => void }).writeResult = () => {
    (proc.stdout as PassThrough).write(`${JSON.stringify({ type: 'result', summary: opts.summary ?? 'fake summary' })}\n`);
  };
  (proc as unknown as { closeNow: (code?: number | null) => void }).closeNow = (code?: number | null) => {
    (proc.evidence as { terminal: string }).terminal = opts.terminal ?? 'success';
    setImmediate(() => (proc as unknown as EventEmitter).emit('close', code ?? opts.exitCode ?? 0, null));
  };
  void killed;
  return proc;
}

function fakeStartCli(calls: CliAgentInput[], behavior: (input: CliAgentInput, beforeSpawn: () => void) => ManagedAgentProcess) {
  return (input: CliAgentInput, beforeSpawn?: (p: PreparedCliAgent) => void) => {
    calls.push(input);
    const unit = `weaver-cli-${String(input.engine)}-abcdef12`;
    if (beforeSpawn) beforeSpawn({ unit } as unknown as PreparedCliAgent);
    return behavior(input, () => {});
  };
}

test('worker uses the selected worker profile directly with zero owner roots', async () => {
  const f = setup();
  try {
    const calls: CliAgentInput[] = [];
    const confirmed: string[] = [];
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('worker must never start an owner root'); },
      command: () => { throw new Error('worker must never call tasks.start/cancel'); },
      dataDir: f.dir,
      startCli: fakeStartCli(calls, (input) => {
        const proc = fakeCliProcess(`weaver-cli-${String(input.engine)}-abcdef12`, {
          engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role,
        });
        setImmediate(() => { proc.writeResult(); proc.closeNow(0); });
        return proc;
      }),
      recoverScope: async (unit) => { confirmed.push(unit); },
    });
    const d = service.create({ name: 'worker direct', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: '整理文档', executor: { role: 'worker', profileId: 'codex_worker' } } });
    assert.equal(d.workspace, undefined);
    const run = service.run({ scheduleId: d.id });
    assert.equal(run.taskId, undefined);
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    const detail = service.runs({ scheduleId: d.id, runId: run.id }).runs[0];
    assert.equal(detail.status, 'succeeded');
    assert.match(detail.output, /fake summary/);
    assert.equal(f.store.list().length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.engine, 'codex');
    assert.equal(calls[0]!.model, 'gpt-6.1-sol');
    assert.equal(calls[0]!.role, 'worker');
    assert.ok(confirmed.length >= 1);
    await service.stop();
  } finally { f.close(); }
});

test('worker and owner with a shared id use their own section and parameters', async () => {
  const f = setup();
  try {
    save(f.policy, snap => { snap.config.workers.codex_owner = { enabled: true, channel: "default_codex", model: 'worker-model', effort: 'low' }; });
    const seen: Array<{ role?: string; model: string }> = [];
    const mk = () => new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: (args) => {
        const task = { id: `task-${Math.random()}`, ...(args as object) };
        seen.push({ role: 'owner-root', model: String((args as Record<string, unknown>).ownerProfileId) });
        return task;
      },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      startCli: (input, beforeSpawn) => {
        seen.push({ role: input.role, model: input.model });
        if (beforeSpawn) beforeSpawn({ unit: 'weaver-cli-codex-abcdef12' } as never);
        const proc = fakeCliProcess('weaver-cli-codex-abcdef12', { engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role });
        setImmediate(() => { proc.writeResult(); proc.closeNow(0); });
        return proc;
      },
      recoverScope: async () => {},
    });
    const workerService = mk();
    const workerDef = workerService.create({ name: 'shared worker', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'worker goal', executor: { role: 'worker', profileId: 'codex_owner' } } });
    const workerRun = workerService.run({ scheduleId: workerDef.id });
    await waitFor(() => workerService.runs({ scheduleId: workerDef.id, runId: workerRun.id }).runs[0].status !== 'running');
    assert.equal(workerService.runs({ scheduleId: workerDef.id, runId: workerRun.id }).runs[0].status, 'succeeded');
    await workerService.stop();
    const ownerSeen = seen.find(s => s.role === 'worker');
    assert.equal(ownerSeen?.model, 'worker-model');
    assert.ok(!seen.some(s => s.role === 'owner-root'), 'shared worker must not start an owner root');
  } finally { f.close(); }
});

test('parent claude/codex keeps the owner root while other real owner kinds run direct CLI', async () => {
  const f = setup();
  try {
    save(f.policy, snap => {
      snap.config.engines.pi.enabled = true;
      snap.config.owners.pi_owner.enabled = true;
      snap.config.workers.pi_worker.enabled = true;
    });
    const cliCalls: CliAgentInput[] = [];
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: (args) => ({ id: 'root-task', ...(args as object) }),
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      startCli: (input, beforeSpawn) => {
        cliCalls.push(input);
        if (beforeSpawn) beforeSpawn({ unit: 'weaver-cli-pi-abcdef12' } as never);
        const proc = fakeCliProcess('weaver-cli-pi-abcdef12', { engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role });
        setImmediate(() => { proc.writeResult(); proc.closeNow(0); });
        return proc;
      },
      recoverScope: async () => {},
    });
    const legacy = service.create({ name: 'legacy', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'legacy goal', executor: { role: 'owner', profileId: 'codex_owner' } } });
    const legacyRun = service.run({ scheduleId: legacy.id });
    assert.ok(legacyRun.taskId);
    assert.equal(cliCalls.length, 0);
    await new Promise(r => setTimeout(r, 20));
    const direct = service.create({ name: 'pi owner direct', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'pi goal', executor: { role: 'owner', profileId: 'pi_owner' } } });
    const directRun = service.run({ scheduleId: direct.id });
    assert.equal(directRun.taskId, undefined);
    await waitFor(() => service.runs({ scheduleId: direct.id, runId: directRun.id }).runs[0].status !== 'running');
    assert.equal(service.runs({ scheduleId: direct.id, runId: directRun.id }).runs[0].status, 'succeeded');
    assert.equal(cliCalls.length, 1);
    assert.equal(cliCalls[0]!.role, 'owner');
    assert.equal(cliCalls[0]!.engine, 'pi');
    await service.stop();
  } finally { f.close(); }
});

test('missing workspace uses a neutral private dir and survives schedule deletion', async () => {
  const f = setup();
  try {
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      startCli: (input, beforeSpawn) => {
        if (beforeSpawn) beforeSpawn({ unit: 'weaver-cli-codex-abcdef12' } as never);
        writeFileSync(join(String(input.workspace), 'business.txt'), 'business output');
        const proc = fakeCliProcess('weaver-cli-codex-abcdef12', { engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role });
        setImmediate(() => { proc.writeResult(); proc.closeNow(0); });
        return proc;
      },
      recoverScope: async () => {},
    });
    const d = service.create({ name: 'neutral', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'neutral goal', executor: { role: 'worker', profileId: 'codex_worker' } } });
    assert.equal(d.workspace, undefined);
    const run = service.run({ scheduleId: d.id });
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    const neutral = join(f.dir, 'schedule-workspaces', d.id);
    assert.ok(existsSync(join(neutral, 'business.txt')));
    assert.equal(readFileSync(join(neutral, 'business.txt'), 'utf8'), 'business output');
    assert.equal(service.get({ scheduleId: d.id }).workspace, undefined);
    service.delete({ scheduleId: d.id, expectedRevision: service.get({ scheduleId: d.id }).revision });
    assert.ok(existsSync(join(neutral, 'business.txt')), 'deleting a schedule must not wipe user business files');
    await service.stop();
  } finally { f.close(); }
});

test('explicit workspace executes there and script without cwd uses the same neutral dir', async () => {
  const f = setup();
  try {
    const explicit = mkdtempSync(join(f.dir, 'explicit-'));
    const seen: string[] = [];
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      startCli: (input, beforeSpawn) => {
        seen.push(String(input.workspace));
        if (beforeSpawn) beforeSpawn({ unit: 'weaver-cli-codex-abcdef12' } as never);
        const proc = fakeCliProcess('weaver-cli-codex-abcdef12', { engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role });
        setImmediate(() => { proc.writeResult(); proc.closeNow(0); });
        return proc;
      },
      recoverScope: async () => {},
    });
    const d = service.create({ name: 'explicit', kind: 'agent', workspace: explicit, timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'explicit goal', executor: { role: 'worker', profileId: 'codex_worker' } } });
    const run = service.run({ scheduleId: d.id });
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    assert.equal(seen[0], (await import('node:fs')).realpathSync(explicit));
    const script = service.create({ name: 'neutral script', kind: 'script', timing: { mode: 'interval', seconds: 60 }, script: { command: 'pwd', timeoutSeconds: 10 } });
    assert.equal(script.workspace, undefined);
    const scriptRun = service.run({ scheduleId: script.id });
    await waitFor(() => service.runs({ scheduleId: script.id, runId: scriptRun.id }).runs[0].status !== 'running');
    const out = service.runs({ scheduleId: script.id, runId: scriptRun.id }).runs[0].output;
    assert.match(out, new RegExp(script.id));
    await service.stop();
  } finally { f.close(); }
});

test('zero exit without a result fails and cancelling a direct run settles cancelled only after scope confirm', async () => {
  const f = setup();
  try {
    const confirmed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      startCli: ((which: string) => (input: CliAgentInput, beforeSpawn?: (p: never) => void) => {
        if (beforeSpawn) beforeSpawn({ unit: which === 'empty' ? 'weaver-cli-codex-aaaa1111' : 'weaver-cli-codex-bbbb2222' } as never);
        const proc = fakeCliProcess(which, { engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role, neverClose: which === 'hang' });
        if (which === 'empty') setImmediate(() => proc.closeNow(0));
        return proc;
      })('empty'),
      recoverScope: async (unit) => { confirmed.push(unit); await gate; },
    });
    const empty = service.create({ name: 'empty', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'empty goal', executor: { role: 'worker', profileId: 'codex_worker' } } });
    const emptyRun = service.run({ scheduleId: empty.id });
    release();
    await waitFor(() => service.runs({ scheduleId: empty.id, runId: emptyRun.id }).runs[0].status !== 'running');
    const detail = service.runs({ scheduleId: empty.id, runId: emptyRun.id }).runs[0];
    assert.equal(detail.status, 'failed');
    assert.match(detail.error ?? '', /without successful result/);
    await service.stop();
  } finally { f.close(); }
});

test('direct cancel releases only after scope confirm and close failure keeps the claim', async () => {
  const f = setup();
  try {
    let confirmCalls = 0;
    let failConfirm = true;
    const hanging: Array<ReturnType<typeof fakeCliProcess>> = [];
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      startCli: (input, beforeSpawn) => {
        if (beforeSpawn) beforeSpawn({ unit: 'weaver-cli-codex-abcdef12' } as never);
        const proc = fakeCliProcess('weaver-cli-codex-abcdef12', { engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role, neverClose: true });
        hanging.push(proc);
        return proc;
      },
      recoverScope: async () => { confirmCalls++; if (failConfirm) throw new Error('Injected strict cleanup failure'); },
      parentFactory: async () => ({ send: async () => 'native', close: async () => { throw new Error('close boom'); } }) as never,
    });
    const d = service.create({ name: 'hang', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'hang goal', executor: { role: 'worker', profileId: 'codex_worker' } } });
    const run = service.run({ scheduleId: d.id });
    await waitFor(() => !!service.storage.read().runs[d.id]?.[0]?.process?.unit);
    service.cancel({ scheduleId: d.id, runId: run.id });
    await waitFor(() => (service.storage.read().runs[d.id]?.[0]?.recoveryError ?? '').includes('Injected strict cleanup failure'), 10000);
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'running');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, run.id);
    failConfirm = false;
    service.tick();
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'cancelled');
    await service.stop();
  } finally { f.close(); }
});

test('direct CLI cleanup failure keeps the claim and later recovery settles interrupted without replay', async () => {
  const f = setup();
  try {
    let launches = 0;
    let failConfirm = true;
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => { throw new Error('no tasks'); },
      dataDir: f.dir,
      startCli: (input, beforeSpawn) => {
        launches++;
        if (beforeSpawn) beforeSpawn({ unit: 'weaver-cli-codex-abcdef12' } as never);
        const proc = fakeCliProcess('weaver-cli-codex-abcdef12', { engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role });
        setImmediate(() => { proc.emit('identity', 'fedcba9876543210fedcba9876543210'); proc.writeResult(); proc.closeNow(0); });
        return proc;
      },
      recoverScope: async () => { if (failConfirm) throw new Error('Injected strict cleanup failure'); },
    });
    const d = service.create({ name: 'cleanup', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'cleanup goal', executor: { role: 'worker', profileId: 'codex_worker' } } });
    const run = service.run({ scheduleId: d.id });
    await waitFor(() => !!service.storage.read().runs[d.id]?.[0]?.recoveryError);
    let stored = service.storage.read().runs[d.id]![0]!;
    assert.equal(stored.status, 'running');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, run.id);
    assert.match(stored.error!, /Injected strict cleanup failure/);
    assert.match(stored.output, /fake summary/);
    assert.equal(launches, 1);
    failConfirm = false;
    service.tick();
    await waitFor(() => service.storage.read().runs[d.id]?.[0]?.status !== 'running');
    stored = service.storage.read().runs[d.id]![0]!;
    assert.equal(stored.status, 'interrupted');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, undefined);
    assert.match(stored.output, /fake summary/);
    assert.equal(launches, 1, 'recovery never replays the goal');
    await service.stop();
  } finally { f.close(); }
});

test('restart recovers a persisted direct unit as interrupted without replaying the goal', async () => {
  const f = setup();
  let launches = 0;
  try {
    const mk = (confirm: (unit: string) => Promise<void>) => new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      startCli: () => { launches++; throw new Error('must not replay after restart'); },
      recoverScope: confirm,
    });
    const first = mk(async () => {});
    const d = first.create({ name: 'restart', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'restart goal', executor: { role: 'worker', profileId: 'codex_worker' } } });
    const run = (first as unknown as { claim: (id: string, t: string) => ScheduleRun }).claim(d.id, 'manual');
    first.storage.transaction(s => { s.runs[d.id][0]!.process = { unit: 'weaver-cli-codex-abcdef12' }; });
    await first.stop();
    const second = mk(async () => {});
    await second.start(60000);
    await waitFor(() => second.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    assert.equal(second.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'interrupted');
    assert.equal(launches, 0);
    assert.equal(second.get({ scheduleId: d.id }).activeRunId, undefined);
    await second.stop();
  } finally { f.close(); }
});

test('a disabled profile rejects the next run and an overlong goal fails before launch', async () => {
  const f = setup();
  const calls: CliAgentInput[] = [];
  try {
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      startCli: (input, beforeSpawn) => {
        calls.push(input);
        if (beforeSpawn) beforeSpawn({ unit: 'weaver-cli-codex-abcdef12' } as never);
        const proc = fakeCliProcess('weaver-cli-codex-abcdef12', { engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role });
        setImmediate(() => { proc.writeResult(); proc.closeNow(0); });
        return proc;
      },
      recoverScope: async () => {},
    });
    const d = service.create({ name: 'deny', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'deny goal', executor: { role: 'worker', profileId: 'codex_worker' } } });
    const first = service.run({ scheduleId: d.id });
    await waitFor(() => service.runs({ scheduleId: d.id, runId: first.id }).runs[0].status !== 'running');
    assert.equal(service.runs({ scheduleId: d.id, runId: first.id }).runs[0].status, 'succeeded');
    const snap = f.policy.snapshot();
    snap.blocks.push({ engine: 'codex', worker: 'codex_worker', reason: 'fixture block', since: new Date(AT).toISOString() });
    f.policy.save({ revision: snap.revision, config: snap.config, blocks: snap.blocks });
    assert.throws(() => service.run({ scheduleId: d.id }), /available worker profile|POLICY_DENIED/);
    assert.equal(service.runs({ scheduleId: d.id }).total, 1);
    const long = service.create({ name: 'long', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: `g-${'x'.repeat(15900)}`, executor: { role: 'worker', profileId: 'claude_worker' } } });
    const before = calls.length;
    const longRun = service.run({ scheduleId: long.id });
    await waitFor(() => service.runs({ scheduleId: long.id, runId: longRun.id }).runs[0].status !== 'running');
    assert.match(service.runs({ scheduleId: long.id, runId: longRun.id }).runs[0].error ?? '', /目标过长需缩短/);
    assert.equal(calls.length, before);
    await service.stop();
  } finally { f.close(); }
});

test('unknown engine kinds fail explicitly and beforeSpawn throwing never starts a CLI', async () => {
  assert.throws(() => classifyScheduleAgent('worker', 'nope'), /no schedule adapter/);
  const dir = mkdtempSync(join(ROOT, 'wv-sch-hook-'));
  try {
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    assert.throws(() => startCliAgent({
      engine: 'codex', model: 'test-model', effort: 'high', workspace: dir, instruction: 'hello', stateDir, role: 'worker',
    }, () => { throw new Error('persist boom'); }), /persist boom/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('claude worker sends once with the frozen goal and closes the owned scope', async () => {
  const f = setup();
  try {
    const seen: Array<{ model: string; workspace: string; instructions: string; sent: string }> = [];
    let closed = 0;
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('claude worker must not start a root'); },
      command: () => { throw new Error('no tasks.start'); },
      dataDir: f.dir,
      recoverScope: async () => {},
      parentFactory: (async (input: { model: string; effort: string; workspace: string; instructions: string }) => ({
        send: async (text: string) => { seen.push({ model: input.model, workspace: input.workspace, instructions: input.instructions, sent: text }); assert.match(text, /frozen goal/); return 'native summary'; },
        close: async () => { closed++; },
      })) as never,
    });
    const d = service.create({ name: 'claude worker', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'frozen goal', executor: { role: 'worker', profileId: 'claude_worker' } } });
    const run = service.run({ scheduleId: d.id });
    assert.equal(run.taskId, undefined);
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'succeeded');
    assert.match(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].output, /native summary/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.model, 'sonnet');
    assert.equal(closed, 1);
    assert.equal(f.store.list().length, 0);
    await service.stop();
  } finally { f.close(); }
});


test('neutral workspace and private state reject symlink boundaries without touching external content', () => {
  const f = setup();
  const external = mkdtempSync(join(ROOT, 'wv-sch-external-'));
  try {
    const marker = join(external, 'business.txt');
    writeFileSync(marker, 'external business');
    chmodSync(external, 0o755);
    const before = lstatSync(external).mode & 0o777;
    const scheduleId = randomUUID(), runId = randomUUID();

    // A configured data dir symlink is a trusted deployment alias and may be canonicalized.
    const dataLink = join(f.dir, 'data-link');
    symlinkSync(f.dir, dataLink);
    assert.equal(neutralScheduleWorkspace(dataLink, scheduleId), join(f.dir, 'schedule-workspaces', scheduleId));
    rmSync(join(f.dir, 'schedule-workspaces'), { recursive: true, force: true });

    // A link at the fixed root is never followed or chmodded.
    symlinkSync(external, join(f.dir, 'schedule-workspaces'));
    assert.throws(() => neutralScheduleWorkspace(f.dir, scheduleId), /real directory|symlink/);
    assert.equal(lstatSync(external).mode & 0o777, before);
    assert.equal(readFileSync(marker, 'utf8'), 'external business');
    assert.equal(existsSync(join(external, scheduleId)), false);
    rmSync(join(f.dir, 'schedule-workspaces'));

    // A link at the per-schedule child is also refused, with the target untouched.
    mkdirSync(join(f.dir, 'schedule-workspaces'), { mode: 0o700 });
    symlinkSync(external, join(f.dir, 'schedule-workspaces', scheduleId));
    assert.throws(() => neutralScheduleWorkspace(f.dir, scheduleId), /real directory|symlink/);
    assert.equal(lstatSync(external).mode & 0o777, before);
    assert.equal(readFileSync(marker, 'utf8'), 'external business');
    rmSync(join(f.dir, 'schedule-workspaces'), { recursive: true, force: true });

    // Existing owned directories are tightened to 0700, while state symlinks are refused.
    const root = join(f.dir, 'schedule-workspaces');
    mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
    const child = join(root, scheduleId); mkdirSync(child); chmodSync(child, 0o755);
    assert.equal(neutralScheduleWorkspace(f.dir, scheduleId), child);
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
    assert.equal(lstatSync(child).mode & 0o777, 0o700);
    symlinkSync(external, join(f.dir, 'schedule-agent-state'));
    assert.throws(() => directStateDir(f.dir, runId), /real directory|symlink/);
    assert.equal(lstatSync(external).mode & 0o777, before);
    assert.equal(readFileSync(marker, 'utf8'), 'external business');
    rmSync(join(f.dir, 'schedule-agent-state'));

    // Cleanup never follows a run-state symlink out of the private root.
    mkdirSync(join(f.dir, 'schedule-agent-state'), { mode: 0o700 });
    symlinkSync(external, join(f.dir, 'schedule-agent-state', runId));
    cleanupStateDir(f.dir, runId);
    assert.equal(readFileSync(marker, 'utf8'), 'external business');
    assert.equal(existsSync(join(f.dir, 'schedule-agent-state', runId)), true, 'a symlink is not recursively removed');
    rmSync(join(f.dir, 'schedule-agent-state'), { recursive: true, force: true });
    const state = directStateDir(f.dir, runId);
    writeFileSync(join(state, 'prompt.txt'), 'private');
    cleanupStateDir(f.dir, runId);
    assert.equal(existsSync(state), false);
    assert.equal(readFileSync(marker, 'utf8'), 'external business');
  } finally {
    rmSync(external, { recursive: true, force: true });
    f.close();
  }
});

test('pi worker identity is forwarded through the existing model guard', async () => {
  const f = setup();
  try {
    save(f.policy, snap => { snap.config.engines.pi.enabled = true; snap.config.workers.pi_worker.enabled = true; });
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => { throw new Error('no tasks'); },
      dataDir: f.dir,
      checkPiModel: async () => undefined,
      startCli: (input, beforeSpawn) => {
        if (beforeSpawn) beforeSpawn({ unit: 'weaver-cli-pi-abcdef12' } as never);
        const proc = fakeCliProcess('weaver-cli-pi-abcdef12', { engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role });
        setImmediate(() => { proc.emit('identity', 'abcdef0123456789abcdef0123456789'); proc.writeResult(); proc.closeNow(0); });
        return proc;
      },
      recoverScope: async () => {},
    });
    const d = service.create({ name: 'pi guard', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'pi goal', executor: { role: 'worker', profileId: 'pi_worker' } } });
    const run = service.run({ scheduleId: d.id });
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'succeeded');
    assert.equal(service.storage.read().runs[d.id]![0]!.process?.invocation, 'abcdef0123456789abcdef0123456789');
    await service.stop();
  } finally { f.close(); }
});

test('direct CLI persists the exact scope invocation observed by the adapter', async () => {
  const f = setup();
  try {
    let confirmed: { unit: string; invocation?: string } | undefined;
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => { throw new Error('no tasks'); },
      dataDir: f.dir,
      startCli: (input, beforeSpawn) => {
        if (beforeSpawn) beforeSpawn({ unit: 'weaver-cli-codex-abcdef12' } as never);
        const proc = fakeCliProcess('weaver-cli-codex-abcdef12', { engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role });
        setImmediate(() => {
          proc.emit('identity', '0123456789abcdef0123456789abcdef');
          proc.writeResult();
          setImmediate(() => proc.closeNow(0));
        });
        return proc;
      },
      recoverScope: async (unit, invocation) => { confirmed = { unit, invocation }; },
    });
    const d = service.create({ name: 'identity', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'identity goal', executor: { role: 'worker', profileId: 'codex_worker' } } });
    const run = service.run({ scheduleId: d.id });
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    const persisted = service.storage.read().runs[d.id]![0]!;
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'succeeded');
    assert.equal(persisted.process?.unit, 'weaver-cli-codex-abcdef12');
    assert.equal(persisted.process?.invocation, '0123456789abcdef0123456789abcdef');
    assert.deepEqual(confirmed, { unit: 'weaver-cli-codex-abcdef12', invocation: '0123456789abcdef0123456789abcdef' });
    await service.stop();
  } finally { f.close(); }
});

test('direct prompt binds the exact instance prefix and keeps the goal verbatim', () => {
  const parent = mkdtempSync(join(ROOT, 'wv-sch-prompt-'));
  const dataDir = join(parent, "instance 'quoted' $(not-a-command)");
  try {
    mkdirSync(dataDir);
    const goal = '整理文档；不要执行 $(rm -rf /) 或 `whoami`。';
    const expected = `weaver --data-dir '${dataDir.replaceAll("'", "'\\''")}'`;
    const worker = buildDirectPrompt({ role: 'worker', profileId: 'codex_worker', goal, workspace: '/tmp/project', unspecified: false, dataDir });
    assert.ok(worker.includes(expected), worker);
    assert.match(worker, /bare weaver/);
    assert.match(worker, /worker\/codex_worker/);
    assert.match(worker, /do not delegate/);
    assert.match(worker, /owner/);
    assert.ok(worker.includes(`<goal>\n${goal}\n</goal>`));
    const owner = buildDirectPrompt({ role: 'owner', profileId: 'pi_owner', goal, workspace: '/tmp/project', unspecified: true, dataDir });
    assert.match(owner, /owner\/pi_owner/);
    assert.match(owner, /Coordinate complex work/);
    assert.ok(owner.includes(`<goal>\n${goal}\n</goal>`));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function claudeDefinition(service: ScheduleService, name: string) {
  return service.create({ name, kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'frozen goal', executor: { role: 'worker', profileId: 'claude_worker' } } });
}

test('claude init cancel holds the claim and a late factory never sends', async () => {
  const f = setup();
  const factoryGate = deferred<void>();
  const confirmGate = deferred<void>();
  try {
    let factoryCalls = 0, sends = 0, closes = 0, confirmCalls = 0;
    const confirmed: string[] = [];
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      recoverScope: async (unit) => { confirmCalls++; confirmed.push(unit); await confirmGate.promise; },
      parentFactory: (async () => {
        factoryCalls++;
        await factoryGate.promise;
        return { send: async () => { sends++; return 'late summary'; }, close: async () => { closes++; } };
      }) as never,
    });
    const d = claudeDefinition(service, 'late-cancel');
    const run = service.run({ scheduleId: d.id });
    await waitFor(() => factoryCalls >= 1);
    await waitFor(() => !!service.storage.read().runs[d.id]?.[0]?.process?.unit);
    const cancelled = service.cancel({ scheduleId: d.id, runId: run.id });
    assert.equal(cancelled.status, 'running', 'no scope confirm yet, so the claim must stay running');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, run.id);
    factoryGate.resolve();
    await waitFor(() => closes >= 1);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(sends, 0, 'a late factory must never send the goal after cancel');
    assert.equal(closes, 1);
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'running');
    confirmGate.resolve();
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'cancelled');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, undefined);
    assert.equal(confirmed[0], `weaver-schedule-${run.id}`);
    assert.ok(confirmCalls >= 1);
    assert.equal(f.store.list().length, 0);
    await service.stop();
  } finally { factoryGate.resolve(); confirmGate.resolve(); f.close(); }
});

test('claude late resolve with close failure keeps the claim for precise recovery', async () => {
  const f = setup();
  const factoryGate = deferred<void>();
  try {
    let factoryCalls = 0, sends = 0, closes = 0, confirmCalls = 0;
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      recoverScope: async () => { confirmCalls++; },
      parentFactory: (async () => {
        factoryCalls++;
        await factoryGate.promise;
        return { send: async () => { sends++; return 'late summary'; }, close: async () => { closes++; throw new Error('close boom'); } };
      }) as never,
    });
    const d = claudeDefinition(service, 'close-fail');
    const run = service.run({ scheduleId: d.id });
    await waitFor(() => factoryCalls >= 1);
    assert.equal(service.cancel({ scheduleId: d.id, runId: run.id }).status, 'running');
    factoryGate.resolve();
    await waitFor(() => closes >= 1);
    await waitFor(() => (service.storage.read().runs[d.id]?.[0]?.recoveryError ?? '').includes('close boom'));
    assert.equal(sends, 0);
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'running');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, run.id);
    const callsBefore = factoryCalls;
    service.tick();
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'cancelled');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, undefined);
    assert.equal(factoryCalls, callsBefore, 'recovery must not replay the goal');
    assert.equal(sends, 0);
    assert.ok(confirmCalls >= 1);
    await service.stop();
  } finally { factoryGate.resolve(); f.close(); }
});

test('claude stop during init never sends and settles interrupted', async () => {
  const f = setup();
  const factoryGate = deferred<void>();
  try {
    let factoryCalls = 0, sends = 0, closes = 0;
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      recoverScope: async () => {},
      parentFactory: (async () => {
        factoryCalls++;
        await factoryGate.promise;
        return { send: async () => { sends++; return 'late summary'; }, close: async () => { closes++; } };
      }) as never,
    });
    const d = claudeDefinition(service, 'stop-init');
    const run = service.run({ scheduleId: d.id });
    await waitFor(() => factoryCalls >= 1);
    const stopping = service.stop();
    factoryGate.resolve();
    await stopping;
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    assert.equal(sends, 0);
    assert.equal(closes, 1);
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'interrupted');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, undefined);
  } finally { factoryGate.resolve(); f.close(); }
});

test('claude user cancel then stop still settles cancelled', async () => {
  const f = setup();
  const factoryGate = deferred<void>();
  try {
    let factoryCalls = 0, sends = 0;
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      recoverScope: async () => {},
      parentFactory: (async () => {
        factoryCalls++;
        await factoryGate.promise;
        return { send: async () => { sends++; return 'late summary'; }, close: async () => {} };
      }) as never,
    });
    const d = claudeDefinition(service, 'cancel-then-stop');
    const run = service.run({ scheduleId: d.id });
    await waitFor(() => factoryCalls >= 1);
    assert.equal(service.cancel({ scheduleId: d.id, runId: run.id }).status, 'running');
    const stopping = service.stop();
    factoryGate.resolve();
    await stopping;
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    assert.equal(sends, 0);
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'cancelled');
  } finally { factoryGate.resolve(); f.close(); }
});

test('claude send failures classify failed except genuine cancellation', async () => {
  const f = setup();
  try {
    const behaviors: Array<() => Promise<string>> = [
      async () => { throw new ParentAgentError('auth denied', 'auth'); },
      async () => { throw new ParentAgentError('protocol mismatch', 'protocol'); },
      async () => { throw new ParentAgentError('engine blew up', 'engine'); },
      async () => { throw new ConfirmedParentCancellation(); },
      async () => 'native summary',
    ];
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      recoverScope: async () => {},
      parentFactory: (async () => ({
        send: async () => { const next = behaviors.shift()!; return next(); },
        close: async () => {},
      })) as never,
    });
    const d = claudeDefinition(service, 'classify');
    const expected: Array<'failed' | 'failed' | 'failed' | 'cancelled' | 'succeeded'> = ['failed', 'failed', 'failed', 'cancelled', 'succeeded'];
    for (const status of expected) {
      const run = service.run({ scheduleId: d.id });
      await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
      const detail = service.runs({ scheduleId: d.id, runId: run.id }).runs[0];
      assert.equal(detail.status, status);
      if (status === 'failed') assert.ok(detail.error && detail.error.length > 0);
      if (status === 'succeeded') assert.match(detail.output, /native summary/);
    }
    assert.equal(f.store.list().length, 0);
    await service.stop();
  } finally { f.close(); }
});

test('direct CLI stop without user cancel settles interrupted', async () => {
  const f = setup();
  try {
    let launches = 0;
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      startCli: (input, beforeSpawn) => {
        launches++;
        if (beforeSpawn) beforeSpawn({ unit: 'weaver-cli-codex-abcdef12' } as never);
        return fakeCliProcess('weaver-cli-codex-abcdef12', { engine: String(input.engine), model: input.model, effort: input.effort, workspace: input.workspace, role: input.role, neverClose: true });
      },
      recoverScope: async () => {},
    });
    const d = service.create({ name: 'cli stop', kind: 'agent', timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'stop goal', executor: { role: 'worker', profileId: 'codex_worker' } } });
    const run = service.run({ scheduleId: d.id });
    await waitFor(() => !!service.storage.read().runs[d.id]?.[0]?.process?.unit);
    await service.stop();
    await waitFor(() => service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status !== 'running');
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'interrupted');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, undefined);
    assert.equal(launches, 1, 'stop must not replay the goal');
  } finally { f.close(); }
});

test('direct CLI launch throw keeps state until scope confirm, recovery cleans only run state', async () => {
  const f = setup();
  try {
    const explicit = mkdtempSync(join(f.dir, 'explicit-'));
    writeFileSync(join(explicit, 'business.txt'), 'business output');
    let launches = 0, failConfirm = true;
    const confirmed: string[] = [];
    const service = new ScheduleService({
      store: f.store, policy: f.policy, notify: () => {}, now: () => AT,
      createTask: () => { throw new Error('no root'); },
      command: () => ({ apiVersion: 'weaver.v1' as const, ok: true }),
      dataDir: f.dir,
      startCli: (_input, beforeSpawn) => {
        launches++;
        if (beforeSpawn) beforeSpawn({ unit: 'weaver-cli-codex-abcdef12' } as never);
        throw new Error('launch boom');
      },
      recoverScope: async (unit) => { confirmed.push(unit); if (failConfirm) throw new Error('Injected strict cleanup failure'); },
    });
    const d = service.create({ name: 'launch-throw', kind: 'agent', workspace: explicit, timing: { mode: 'interval', seconds: 60 }, agent: { goal: 'throw goal', executor: { role: 'worker', profileId: 'codex_worker' } } });
    const run = service.run({ scheduleId: d.id });
    const statePath = join(f.dir, 'schedule-agent-state', run.id);
    await waitFor(() => (service.storage.read().runs[d.id]?.[0]?.recoveryError ?? '').includes('Injected strict cleanup failure'));
    assert.equal(service.storage.read().runs[d.id]![0]!.status, 'running');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, run.id);
    assert.ok(existsSync(statePath), 'unconfirmed run state must be retained with the claim');
    assert.equal(readFileSync(join(explicit, 'business.txt'), 'utf8'), 'business output');
    failConfirm = false;
    service.tick();
    await waitFor(() => service.storage.read().runs[d.id]?.[0]?.status !== 'running');
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'interrupted');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, undefined);
    assert.equal(launches, 1, 'recovery never replays the goal');
    assert.ok(!existsSync(statePath), 'confirmed recovery recycles only the run state');
    assert.equal(readFileSync(join(explicit, 'business.txt'), 'utf8'), 'business output', 'business cwd must survive state cleanup');
    assert.ok(confirmed.includes('weaver-cli-codex-abcdef12'));
    await service.stop();
  } finally { f.close(); }
});
