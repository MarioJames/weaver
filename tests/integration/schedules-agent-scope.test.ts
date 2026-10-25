import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { TaskStore } from '../../src/main/store';
import { PolicyStore } from '../../src/main/policy/store';
import { ScheduleService } from '../../src/main/schedules/service';
import { ScheduleStore } from '../../src/main/schedules/store';
import { recoverOwnedScope } from '../../src/main/adapters/cli/scope';
import type { ScheduleDefinition, ScheduleRun } from '../../src/shared/contracts/schedules';

const enabled = process.env.WEAVER_SCHEDULE_SCOPE_TEST === '1' && !!process.env.WEAVER_SCHEDULE_SCOPE_ROOT;
const ROOT = process.env.WEAVER_SCHEDULE_SCOPE_ROOT;
const PROOF = process.env.WEAVER_SCHEDULE_SCOPE_PROOF;
const proof = (value: unknown) => { if (PROOF) appendFileSync(PROOF, `${JSON.stringify({ at: new Date().toISOString(), ...value as object })}\n`, { mode: 0o600 }); };
const pause = (ms = 25) => new Promise(r => setTimeout(r, ms));
const waitFor = async (predicate: () => boolean, timeout = 60000, message = 'waitFor timeout') => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(message);
    await pause();
  }
};
const systemctl = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolvePromise => {
  execFile('systemctl', ['--user', ...args], { timeout: 8000 }, (error, stdout, stderr) => {
    const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
    resolvePromise({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
  });
});
const show = async (unit: string) => (await systemctl(['show', `${unit}.scope`, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'InvocationID', '-p', 'ControlGroup', '-p', 'MemoryHigh', '-p', 'MemoryMax', '-p', 'KillMode', '--no-pager'])).stdout;
const prop = (text: string, key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim();
const cgroupExists = (text: string) => { const path = prop(text, 'ControlGroup'); return !!path && existsSync(join('/sys/fs/cgroup', path)); };
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const fixtureMarkerLines = (marker: string) => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { pid: number; childPid?: number; declaredExit?: number; input?: string; argv?: string[] }) : [];

const FIXTURE = String.raw`#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const scenario = process.env.WEAVER_SCHEDULE_FIXTURE_SCENARIO || 'success';
const marker = process.env.WEAVER_SCHEDULE_FIXTURE_MARKER;
const childFile = process.env.WEAVER_SCHEDULE_FIXTURE_CHILD;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = readFileSync(0, 'utf8');
const base = { pid: process.pid, scenario, declaredExit: 0, input, argv: process.argv.slice(2), startedAt: new Date().toISOString() };
if (scenario === 'success') {
  appendFileSync(marker, JSON.stringify(base) + '\n', { mode: 0o600 });
  emit({ type: 'thread.started', thread_id: 'fixture-thread' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'FIXTURE-OK' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}
if (scenario === 'missing-terminal') {
  appendFileSync(marker, JSON.stringify(base) + '\n', { mode: 0o600 });
  emit({ type: 'thread.started', thread_id: 'fixture-thread' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'DONE-WITHOUT-TERMINAL' } });
  process.exit(0);
}
if (scenario === 'long') {
  const child = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
  if (childFile) writeFileSync(childFile, String(child.pid), { mode: 0o600 });
  appendFileSync(marker, JSON.stringify({ ...base, childPid: child.pid }) + '\n', { mode: 0o600 });
  process.on('SIGTERM', () => { /* prove the whole cgroup is killed after the grace period */ });
  setInterval(() => {}, 1000);
  emit({ type: 'thread.started', thread_id: 'fixture-thread' });
  return;
}
throw new Error('unknown fixture scenario ' + scenario);
`;

function setup(scenario: 'success' | 'missing-terminal' | 'long') {
  if (!ROOT) throw new Error('WEAVER_SCHEDULE_SCOPE_ROOT is required');
  const dir = mkdtempSync(join(ROOT, 'scope-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const fake = join(bin, 'codex'); writeFileSync(fake, FIXTURE, { mode: 0o700 }); chmodSync(fake, 0o700);
  const marker = join(dir, 'marker'), childFile = join(dir, 'child');
  const store = new TaskStore(join(dir, 'weaver.db'));
  const policy = new PolicyStore(store.db);
  const snap = policy.snapshot();
  snap.config.engines.codex = { ...snap.config.engines.codex!, enabled: true, kind: 'codex' };
  snap.config.workers.scope_fixture = { enabled: true, channels:["default_codex"], model: 'fixture-model', effort: 'high' };
  policy.save({ revision: snap.revision, config: snap.config, blocks: snap.blocks }, { allowEngineEnable: true });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  process.env.WEAVER_SCHEDULE_FIXTURE_SCENARIO = scenario;
  process.env.WEAVER_SCHEDULE_FIXTURE_MARKER = marker;
  process.env.WEAVER_SCHEDULE_FIXTURE_CHILD = childFile;
  let service: ScheduleService | undefined;
  const close = async (units: string[] = []) => {
    try { await service?.stop(); } catch { /* keep the original failure */ }
    const owned = new Map<string, string | undefined>();
    for (const unit of units) owned.set(unit, undefined);
    try {
      for (const definition of new ScheduleStore(store).read().definitions) {
        for (const run of new ScheduleStore(store).read().runs[definition.id] ?? []) if (run.process?.unit) owned.set(run.process.unit, run.process.invocation);
      }
    } catch { /* private store already closed by an explicit test path */ }
    for (const [unit, invocation] of owned) {
      try { await recoverOwnedScope(unit, invocation); } catch { try { await systemctl(['stop', `${unit}.scope`]); } catch { /* exact unit already gone */ } }
    }
    try { store.close(); } catch { /* already closed */ }
    process.env.PATH = oldPath;
    delete process.env.WEAVER_SCHEDULE_FIXTURE_SCENARIO;
    delete process.env.WEAVER_SCHEDULE_FIXTURE_MARKER;
    delete process.env.WEAVER_SCHEDULE_FIXTURE_CHILD;
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    dir, marker, childFile, store, policy,
    makeService: () => {
      service = new ScheduleService({
        store, policy, dataDir: dir, notify: () => {},
        createTask: () => { throw new Error('schedule worker must never start an owner root'); },
        command: () => { throw new Error('schedule worker must never call tasks.start/cancel'); },
      });
      return service;
    },
    create(service: ScheduleService): ScheduleDefinition {
      return service.create({ name: `scope ${scenario}`, kind: 'agent', enabled: false, timing: { mode: 'interval', seconds: 3600 }, agent: { goal: 'Go through the schedule goal exactly.', executor: { role: 'worker', profileId: 'scope_fixture' } } });
    },
    close,
  };
}

const currentRun = (service: ScheduleService, scheduleId: string) => service.storage.read().runs[scheduleId]?.[0];
const tickUntilRecoveryError = async (service: ScheduleService, scheduleId: string, pattern: RegExp, timeout = 30000) => {
  const started = Date.now();
  while (Date.now() - started <= timeout) {
    service.tick();
    const error = service.storage.read().runs[scheduleId]?.[0]?.recoveryError ?? '';
    if (pattern.test(error)) return error;
    await pause(100);
  }
  throw new Error(`recovery error did not match ${pattern}`);
};
const waitSettled = async (service: ScheduleService, scheduleId: string, timeout = 60000): Promise<ScheduleRun> => {
  let value: ScheduleRun | undefined;
  await waitFor(() => {
    const run = currentRun(service, scheduleId);
    if (!run || run.status === 'running') return false;
    value = service.runs({ scheduleId, runId: run.id }).runs[0];
    return true;
  }, timeout, 'schedule run did not settle');
  if (!value) throw new Error('schedule run did not settle');
  return value;
};
const waitScopeGone = async (unit: string) => {
  let text = '';
  for (let i = 0; i < 300; i++) {
    text = await show(unit);
    if (prop(text, 'LoadState') === 'not-found' && !cgroupExists(text)) return text;
    await pause(50);
  }
  throw new Error(`scope/cgroup survived: ${text}`);
};
const requireRealSystemd = async () => {
  if (process.platform !== 'linux') throw new Error('real schedule scope tests require Linux');
  const state = await new Promise<string>(resolvePromise => execFile('systemctl', ['--user', 'is-system-running'], (error, stdout) => resolvePromise(String(stdout || error?.message || '').trim())));
  if (!['running', 'degraded'].includes(state)) throw new Error(`systemd user session unavailable: ${state}`);
};

for (const scenario of ['success', 'missing-terminal'] as const) test(`default startCliAgent + real systemd ${scenario}: claim settles only after exact scope cleanup`, { skip: !enabled, timeout: 180000 }, async () => {
  await requireRealSystemd();
  const f = setup(scenario);
  let unit = '';
  try {
    const service = f.makeService();
    const d = f.create(service);
    const run = service.run({ scheduleId: d.id });
    const result = await waitSettled(service, d.id);
    const persisted = currentRun(service, d.id)!;
    unit = persisted.process!.unit;
    const markerLines = fixtureMarkerLines(f.marker);
    assert.equal(markerLines.length, 1, 'one real CLI launch');
    assert.match(markerLines[0]!.input!, /Go through the schedule goal exactly\./);
    assert.ok(markerLines[0]!.input!.includes(`weaver --data-dir '${f.dir}'`), 'the prompt must bind this private instance');
    assert.equal(markerLines[0]!.input!.includes('--data-dir'), true);
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, undefined);
    assert.equal(existsSync(join(f.dir, 'schedule-agent-state', run.id)), false, 'private state is recycled after cleanup');
    if (scenario === 'success') {
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      assert.match(result.output, /FIXTURE-OK/);
      assert.equal(result.exitCode, 0);
    } else {
      assert.equal(markerLines[0]!.declaredExit, 0, 'the fixture exited 0');
      assert.equal(result.status, 'failed', JSON.stringify(result));
      assert.match(result.error ?? '', /terminal missing|Worker failed/i);
      assert.equal(result.output, '');
    }
    const gone = await waitScopeGone(unit);
    assert.match(gone, /LoadState=not-found/);
    // Repeating recovery on an already-collected scope is a successful no-op (the reported owner failure).
    await recoverOwnedScope(unit, persisted.process!.invocation);
    await recoverOwnedScope(unit);
    proof({ case: `default-${scenario}`, unit, invocation: persisted.process!.invocation, fixtureExit: markerLines[0]!.declaredExit, status: result.status, exitCode: result.exitCode, output: result.output.slice(0, 100), markerLines: markerLines.length, gone });
  } finally { await f.close(unit ? [unit] : []); }
});

test('cancel through the default service kills the whole real systemd scope and releases the claim', { skip: !enabled, timeout: 180000 }, async () => {
  await requireRealSystemd();
  const f = setup('long');
  let unit = '';
  try {
    const service = f.makeService();
    const d = f.create(service);
    const run = service.run({ scheduleId: d.id });
    try {
      await waitFor(() => { const r = currentRun(service, d.id); return !!(r?.process?.invocation && fixtureMarkerLines(f.marker).length === 1); }, 30000, 'long CLI did not become fully owned');
    } catch (error) {
      const r = currentRun(service, d.id);
      const detail = r?.process?.unit ? await show(r.process.unit) : '';
      const marker = fixtureMarkerLines(f.marker)[0];
      const cg = marker ? (() => { try { return readFileSync(`/proc/${marker.pid}/cgroup`, 'utf8'); } catch { return ''; } })() : '';
      throw new Error(`${(error as Error).message}: status=${r?.status} error=${r?.error} unit=${r?.process?.unit} invocation=${r?.process?.invocation} marker=${JSON.stringify(fixtureMarkerLines(f.marker))} show=${JSON.stringify(detail)} cgroup=${JSON.stringify(cg)}`);
    }
    const persisted = currentRun(service, d.id)!;
    unit = persisted.process!.unit;
    const line = fixtureMarkerLines(f.marker)[0]!;
    const text = await show(unit);
    assert.equal(prop(text, 'MemoryHigh'), '8589934592');
    assert.equal(prop(text, 'MemoryMax'), '10737418240');
    assert.equal(prop(text, 'KillMode'), 'control-group');
    assert.ok(cgroupExists(text));
    assert.equal(pidAlive(line.pid), true);
    assert.equal(pidAlive(line.childPid!), true);
    service.cancel({ scheduleId: d.id, runId: run.id });
    const result = await waitSettled(service, d.id);
    assert.equal(result.status, 'cancelled', JSON.stringify(result));
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, undefined);
    await waitFor(() => !pidAlive(line.pid) && !pidAlive(line.childPid!), 20000, 'cancelled descendants survived');
    const gone = await waitScopeGone(unit);
    assert.equal(fixtureMarkerLines(f.marker).length, 1, 'cancel must not replay the goal');
    proof({ case: 'cancel', unit, invocation: persisted.process!.invocation, status: result.status, exitCode: result.exitCode, memoryHigh: prop(text, 'MemoryHigh'), memoryMax: prop(text, 'MemoryMax'), killMode: prop(text, 'KillMode'), processAlive: false, childAlive: false, gone });
  } finally { await f.close(unit ? [unit] : []); }
});

test('restart recovers the exact persisted real CLI scope without replaying the goal', { skip: !enabled, timeout: 180000 }, async () => {
  await requireRealSystemd();
  const f = setup('long');
  let controller: ChildProcess | undefined, service: ScheduleService | undefined, unit = '', invocation: string | undefined;
  const ready = join(f.dir, 'ready.json');
  try {
    const code = `
import { TaskStore } from ${JSON.stringify(resolve('src/main/store.ts'))};
import { PolicyStore } from ${JSON.stringify(resolve('src/main/policy/store.ts'))};
import { ScheduleService } from ${JSON.stringify(resolve('src/main/schedules/service.ts'))};
import { existsSync, writeFileSync } from 'node:fs';
const store=new TaskStore(${JSON.stringify(join(f.dir, 'weaver.db'))}),policy=new PolicyStore(store.db);
const service=new ScheduleService({store,policy,dataDir:${JSON.stringify(f.dir)},notify:()=>{},createTask:()=>{throw new Error('no root')},command:()=>{throw new Error('no command')}});
const d=service.create({name:'restart',kind:'agent',enabled:false,timing:{mode:'interval',seconds:3600},agent:{goal:'RESTART FROZEN GOAL',executor:{role:'worker',profileId:'scope_fixture'}}});
const run=service.run({scheduleId:d.id});
const deadline=Date.now()+30000;
const timer=setInterval(()=>{const r=service.storage.read().runs[d.id]?.[0];if(r?.process?.invocation&&existsSync(${JSON.stringify(f.marker)})){writeFileSync(${JSON.stringify(ready)},JSON.stringify({scheduleId:d.id,runId:run.id,unit:r.process.unit,invocation:r.process.invocation}),{mode:0o600});clearInterval(timer);}},20);
setInterval(()=>{if(Date.now()>deadline)process.exit(3);},1000);
`;
    controller = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(() => existsSync(ready), 45000, 'controller never persisted a real owned unit');
    const record = JSON.parse(readFileSync(ready, 'utf8')) as { scheduleId: string; runId: string; unit: string; invocation: string };
    unit = record.unit; invocation = record.invocation;
    const line = fixtureMarkerLines(f.marker)[0]!;
    assert.equal(pidAlive(line.pid), true);
    controller.kill('SIGKILL');
    await new Promise<void>(r => { if (controller!.exitCode !== null) return r(); controller!.once('close', () => r()); });
    assert.equal(pidAlive(line.pid), true, 'the systemd scope survives the crashed controller');
    service = new ScheduleService({
      store: new TaskStore(join(f.dir, 'weaver.db')), policy: new PolicyStore(join(f.dir, 'weaver.db')),
      dataDir: f.dir, notify: () => {},
      createTask: () => { throw new Error('no root'); }, command: () => { throw new Error('no command'); },
    });
    await service.start(60000);
    await waitFor(() => service!.storage.read().runs[record.scheduleId]?.[0]?.status !== 'running', 30000, 'restart recovery did not settle');
    const recovered = service.runs({ scheduleId: record.scheduleId, runId: record.runId }).runs[0];
    assert.equal(recovered.status, 'interrupted', JSON.stringify(recovered));
    assert.equal(service.get({ scheduleId: record.scheduleId }).activeRunId, undefined);
    await waitFor(() => !pidAlive(line.pid) && !pidAlive(line.childPid!), 20000, 'recovered scope process survived');
    const gone = await waitScopeGone(unit);
    assert.equal(fixtureMarkerLines(f.marker).length, 1, 'restart must not replay the goal');
    proof({ case: 'restart', unit, invocation, status: recovered.status, markerLines: fixtureMarkerLines(f.marker).length, gone });
  } finally {
    controller?.kill('SIGKILL');
    try { await service?.stop(); } catch { /* original failure */ }
    if (unit && invocation) { try { await recoverOwnedScope(unit, invocation); } catch { try { await systemctl(['stop', `${unit}.scope`]); } catch { /* gone */ } } }
    await f.close(unit ? [unit] : []);
  }
});

test('missing or mismatched invocation never kills a live replacement; matching recovery does', { skip: !enabled, timeout: 180000 }, async () => {
  await requireRealSystemd();
  const f = setup('success');
  const unit = `weaver-cli-codex-${randomBytes(4).toString('hex')}`;
  const pidFile = join(f.dir, 'scope-pid');
  let launcher: ChildProcess | undefined, service: ScheduleService | undefined;
  try {
    const store = new TaskStore(join(f.dir, 'weaver.db'));
    const serviceInternal = new ScheduleService({
      store, policy: new PolicyStore(store.db), dataDir: f.dir, notify: () => {},
      createTask: () => { throw new Error('no root'); }, command: () => { throw new Error('no command'); },
    });
    const d = serviceInternal.create({ name: 'identity', kind: 'agent', enabled: false, timing: { mode: 'interval', seconds: 3600 }, agent: { goal: 'identity goal', executor: { role: 'worker', profileId: 'scope_fixture' } } });
    const run = (serviceInternal as unknown as { claim: (id: string, trigger: string) => ScheduleRun }).claim(d.id, 'manual');
    serviceInternal.storage.transaction(s => { s.runs[d.id][0]!.process = { unit }; });
    serviceInternal.storage.transaction(s => { s.runs[d.id][0]!.process = { unit }; });
    await serviceInternal.stop();
    store.close();

    launcher = spawn('systemd-run', ['--user', '--scope', '--collect', '--quiet', `--unit=${unit}`, `--working-directory=${f.dir}`, '-p', 'MemoryHigh=8G', '-p', 'MemoryMax=10G', '-p', 'KillMode=control-group', '--', '/bin/sh', '-c', `printf $$ > '${pidFile}'; sleep 60`], { cwd: f.dir, env: process.env, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    await waitFor(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let text = await show(unit);
    let invocation = prop(text, 'InvocationID')!;
    assert.ok(invocation);

    service = new ScheduleService({
      store: new TaskStore(join(f.dir, 'weaver.db')), policy: new PolicyStore(join(f.dir, 'weaver.db')),
      dataDir: f.dir, notify: () => {}, createTask: () => { throw new Error('no root'); }, command: () => { throw new Error('no command'); },
    });
    await service.start(60000);
    await waitFor(() => !!service!.storage.read().runs[d.id]?.[0]?.recoveryError, 15000, 'missing invocation did not fail closed');
    assert.equal(service.storage.read().runs[d.id]![0]!.status, 'running');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, run.id);
    assert.match(service.storage.read().runs[d.id]![0]!.recoveryError!, /identity is missing/);
    assert.equal(pidAlive(pid), true);

    service.storage.transaction(s => { s.runs[d.id][0]!.process!.invocation = '00000000000000000000000000000000'; });
    await tickUntilRecoveryError(service, d.id, /identity changed/);
    assert.equal(pidAlive(pid), true, 'a replacement must not be killed');
    text = await show(unit); assert.equal(prop(text, 'ActiveState'), 'active');

    service.storage.transaction(s => { s.runs[d.id][0]!.process!.invocation = invocation; });
    const recoveredByTick = async () => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 30000) {
        service!.tick();
        if (service!.storage.read().runs[d.id]?.[0]?.status !== 'running') return;
        await pause(100);
      }
      throw new Error('matching invocation did not recover');
    };
    await recoveredByTick();
    assert.equal(service.runs({ scheduleId: d.id, runId: run.id }).runs[0].status, 'interrupted');
    assert.equal(service.get({ scheduleId: d.id }).activeRunId, undefined);
    await waitFor(() => !pidAlive(pid), 20000, 'verified replacement was not cleaned');
    const gone = await waitScopeGone(unit);
    proof({ case: 'identity', unit, invocation, missingInvocation: 'refused', wrongInvocation: 'refused', recovered: true, gone });
  } finally {
    launcher?.kill('SIGKILL');
    try { await service?.stop(); } catch { /* original failure */ }
    try { await recoverOwnedScope(unit); } catch { try { await systemctl(['stop', `${unit}.scope`]); } catch { /* gone */ } }
    await f.close([unit]);
  }
});
