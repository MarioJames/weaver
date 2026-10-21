import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../../src/main/manager';
import { TaskStore } from '../../src/main/store';
import { PolicyStore } from '../../src/main/policy/store';
import { CommandHandler } from '../../src/main/commands';
import { EngineModelLister } from '../../src/main/engines/models';
import { createPiModelCheck, type PiModelCheck } from '../../src/main/engines/pi-model-check';
import { guardPiLaunch } from '../../src/main/adapters/cli/pi-guard';
import { startCliAgent } from '../../src/main/adapters/cli';
import { sayHi, type HelloProcess } from '../../src/main/engines/hello';
import { classifyVendorEvent, piErrorText } from '../../src/main/adapters/cli/vendor-errors';
import type { CaptureResult } from '../../src/main/engines/probe';
import type { CliAgentInput } from '../../src/main/adapters/cli/types';
import type { ManagedProcess } from '../../src/main/adapters/worker';

const CONFIGURED = 'cc-switch-agentplan/glm-5.3-flash';
// `pi --list-models` after cc-switch switched the provider: only the zhipu models remain.
const AFTER_SWITCH = [
  'provider             model                context  max-out  thinking  images',
  'cc-switch-zhipu-glm  glm-5.3              200K     128K     yes       no    ',
  'cc-switch-zhipu-glm  glm-5.3-flash        200K     128K     yes       no    ',
].join('\n');
const BEFORE_SWITCH = [
  'provider             model                context  max-out  thinking  images',
  'cc-switch-agentplan  glm-5.3-flash        1M       128K     yes       yes   ',
].join('\n');
const ok = (stdout: string, extra: Partial<CaptureResult> = {}): CaptureResult => ({ code: 0, timedOut: false, overflow: false, stdout, stderr: '', ...extra });

/** A fake `pi --list-models`: the answers are consumed in order, the last one repeats. */
function fakeList(answers: CaptureResult[], clock = { now: Date.parse('2026-10-21T00:00:00Z') }) {
  const calls: string[][] = [];
  const lister = new EngineModelLister({
    now: () => new Date(clock.now),
    find: async () => '/fake/pi',
    run: async (_exe, args) => { calls.push([...args]); return answers[Math.min(calls.length - 1, answers.length - 1)]!; },
  });
  return { lister, calls, clock, check: createPiModelCheck(lister, () => clock.now) };
}

test('a configured model that pi lists exactly passes the check', async () => {
  const f = fakeList([ok(BEFORE_SWITCH)]);
  assert.equal(await f.check(CONFIGURED), undefined);
  assert.deepEqual(f.calls, [['--list-models']]);
});

test('a missing provider is a Chinese configuration error that names the available models and the cc-switch cause', async () => {
  const f = fakeList([ok(AFTER_SWITCH)]);
  const problem = await f.check(CONFIGURED);
  assert.equal(problem, `pi 当前没有模型 ${CONFIGURED}（可用：cc-switch-zhipu-glm/glm-5.3、cc-switch-zhipu-glm/glm-5.3-flash），可能已在 cc-switch 中切换了供应商；请在子 Agent 配置中改选模型`);
  // A bare model name or a different provider is not "close enough": the id must match exactly.
  assert.ok(await f.check('glm-5.3-flash'));
  assert.ok(await f.check('cc-switch-zhipu-glm/glm-5.3-fla'));
});

test('a failing list command is reported and never taken as "the model exists"', async () => {
  for (const result of [ok('', { code: 1 }), ok('', { timedOut: true }), ok('no table here'), ok('', { error: 'spawn pi ENOENT' })]) {
    const f = fakeList([result]);
    const problem = await f.check(CONFIGURED);
    assert.match(problem ?? '', /无法确认 pi 是否提供模型 cc-switch-agentplan\/glm-5\.3-flash/);
    assert.match(problem ?? '', /未启动 pi/);
  }
  const missing = new EngineModelLister({ find: async () => undefined });
  assert.match(await createPiModelCheck(missing)(CONFIGURED) ?? '', /未在本机找到 pi/);
});

test('the list is cached for 60 seconds, a miss on an old cache re-reads once, and a fresh miss does not', async () => {
  const f = fakeList([ok(BEFORE_SWITCH), ok(AFTER_SWITCH)]);
  assert.equal(await f.check(CONFIGURED), undefined);
  assert.equal(await f.check(CONFIGURED), undefined);
  assert.equal(f.calls.length, 1, 'a hit inside the minute runs no second pi --list-models');
  // A model that is not in the list read moments ago is a miss without another pi call.
  const wanted = 'cc-switch-zhipu-glm/glm-5.3';
  assert.match(await f.check(wanted) ?? '', /当前没有模型/);
  assert.equal(f.calls.length, 1, 'a miss on a list read moments ago is answered from it');
  // Later the user switched the provider in cc-switch: a miss on the old list is re-read once and now succeeds.
  f.clock.now += 30_000;
  assert.equal(await f.check(wanted), undefined);
  assert.equal(f.calls.length, 2);
  // The new list is fresh again, so the old provider is a miss without a third call.
  assert.match(await f.check(CONFIGURED) ?? '', /当前没有模型/);
  assert.equal(f.calls.length, 2);
  f.clock.now += 61_000;
  await f.check(wanted);
  assert.equal(f.calls.length, 3, 'the cache expires after a minute');
});

// --- the guarded launcher ---------------------------------------------------------------------------------------------

function fakeAgent() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, scopeUnit: 'weaver-cli-pi-fake', evidence: undefined as ManagedProcess['evidence'], kill: () => true });
  return child;
}
const inputOf = (model: string, engine: CliAgentInput['engine'] = 'pi'): CliAgentInput => ({ engine, model, effort: 'high', workspace: '/tmp', instruction: 'fake only', stateDir: '/tmp' });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
async function until(cond: () => boolean, ms = 3000) { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); }

function harness(check: PiModelCheck, launched: CliAgentInput[] = [], agent = fakeAgent()) {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-pi-guard-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const launch = guardPiLaunch(input => { launched.push(input); return agent; }, check);
  const manager = new TaskManager(store, { id: 'pi', canLaunchReal: () => true, start: task => launch(inputOf(task.dispatch!.model)) });
  const task = manager.create({ title: 'fixture', instruction: 'fake only', owner: { name: 'o', transport: 'herdr-visible', session: 's', pane: 'p' } });
  task.dispatch = { execution: 'real', adapter: 'pi', engineKind: 'pi', engine: 'pi', model: CONFIGURED, effort: 'high', owner: 'o', worker: 'pi_worker', maxParallel: 2 };
  store.put(task);
  return { dir, store, manager, id: task.id, agent, launched, policy: new PolicyStore(join(dir, 'weaver.db')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a model pi does not offer fails the task with a configuration error: pi is never started, nothing is blocked', async () => {
  const f = fakeList([ok(AFTER_SWITCH)]);
  const h = harness(f.check);
  try {
    h.manager.start(h.id);
    await until(() => h.store.get(h.id).status === 'failed');
    const task = h.store.get(h.id);
    assert.equal(task.status, 'failed');
    assert.equal(h.launched.length, 0, 'the real launcher was not called');
    assert.equal(task.failure?.kind, 'early_exit', 'a start failure, not a vendor limit');
    assert.match(task.failure?.message ?? '', /pi 当前没有模型 cc-switch-agentplan\/glm-5\.3-flash（可用：cc-switch-zhipu-glm\/glm-5\.3、cc-switch-zhipu-glm\/glm-5\.3-flash）.*cc-switch/);
    assert.equal(task.events.filter(e => e.kind === 'error').length, 1);
    assert.equal(task.run?.status, 'stopped');
    // Neither dispatch pumping nor the vendor-limit path turns this into a block on the engine or the worker.
    const handler = new CommandHandler(h.manager, h.policy);
    handler.pump();
    assert.deepEqual(h.policy.snapshot().blocks, []);
    handler.draining = true;
  } finally { h.cleanup(); }
});

test('a failing pi --list-models fails the task without starting pi', async () => {
  const f = fakeList([ok('', { code: 2 })]);
  const h = harness(f.check);
  try {
    h.manager.start(h.id);
    await until(() => h.store.get(h.id).status === 'failed');
    assert.equal(h.launched.length, 0);
    assert.equal(h.store.get(h.id).failure?.kind, 'early_exit');
    assert.match(h.store.get(h.id).failure?.message ?? '', /无法确认 pi 是否提供模型.*pi --list-models 退出码 2.*未启动 pi/);
  } finally { h.cleanup(); }
});

test('an existing model starts pi and relays its output, evidence and close unchanged', async () => {
  const f = fakeList([ok(BEFORE_SWITCH)]);
  const h = harness(f.check);
  try {
    h.manager.start(h.id);
    await until(() => h.launched.length === 1);
    assert.equal(h.launched[0]!.model, CONFIGURED);
    h.agent.stdout.write(JSON.stringify({ type: 'progress', percent: 20, message: 'pi agent started' }) + '\n');
    h.agent.stdout.write(JSON.stringify({ type: 'result', summary: 'done' }) + '\n');
    h.agent.stdout.end();
    h.agent.stderr.end();
    h.agent.emit('close', 0, null);
    await until(() => h.store.get(h.id).status === 'completed');
    const task = h.store.get(h.id);
    assert.equal(task.status, 'completed');
    assert.equal(task.summary, 'done');
    assert.equal(task.failure, undefined);
    assert.equal(task.run?.pid, undefined, 'pid is released on close like any other run');
  } finally { h.cleanup(); }
});

test('cancelling while the check is pending starts nothing', async () => {
  let release!: (problem: string | undefined) => void;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  try {
    h.manager.start(h.id);
    h.manager.cancel(h.id);
    release(undefined);
    await nextTurn();
    await until(() => h.store.get(h.id).status === 'cancelled');
    assert.equal(h.launched.length, 0);
    assert.equal(h.store.get(h.id).status, 'cancelled');
  } finally { h.cleanup(); }
});

test('only pi is guarded: other engines launch immediately and never consult the check', () => {
  const launched: CliAgentInput[] = [];
  const agent = fakeAgent();
  const launch = guardPiLaunch(input => { launched.push(input); return agent; }, async () => { throw new Error('must not be called'); });
  assert.equal(launch(inputOf('gpt-6.1-sol', 'codex')), agent);
  assert.equal(launched.length, 1);
});

// --- the connectivity hello and probes -------------------------------------------------------------------------------

function helloChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  queueMicrotask(() => {
    child.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'glm-5.3-flash', content: [{ type: 'text', text: 'hi' }], stopReason: 'stop' } }) + '\n');
    child.stdout.end();
    child.emit('close', 0);
  });
  return child as unknown as HelloProcess;
}

test('the pi connectivity hello and free-channel probe check the model first and spawn nothing when it is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-pi-hello-'));
  try {
    let spawned = 0;
    const route = { engine: 'pi', kind: 'pi', model: CONFIGURED, effort: 'high' };
    const missing = await sayHi(route, { root: dir, spawn: () => { spawned++; return helloChild(); }, checkPiModel: async model => `pi 当前没有模型 ${model}（可用：x/y）` });
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /pi 当前没有模型 cc-switch-agentplan\/glm-5\.3-flash/);
    assert.equal(spawned, 0);
    const broken = await sayHi(route, { root: dir, spawn: () => { spawned++; return helloChild(); }, checkPiModel: async () => { throw new Error('boom'); } });
    assert.equal(broken.ok, false);
    assert.match(broken.error ?? '', /无法确认 pi 是否提供模型.*boom/);
    assert.equal(spawned, 0);
    const present = await sayHi(route, { root: dir, spawn: () => { spawned++; return helloChild(); }, checkPiModel: async () => undefined });
    assert.equal(present.ok, true);
    assert.equal(spawned, 1);
    // Other engines are not checked even when a check is supplied.
    const other = await sayHi({ engine: 'opencode', kind: 'opencode', model: 'opencode/x', effort: 'high' }, { root: dir, spawn: () => { spawned++; return helloChild(); }, checkPiModel: async () => 'must not be consulted' });
    assert.equal(other.error?.includes('must not be consulted'), false);
    assert.equal(spawned, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- the model pi reports it actually used ---------------------------------------------------------------------------

function engineHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-pi-actual-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const child = fakeAgent();
  const manager = new TaskManager(store, { id: 'pi', canLaunchReal: () => true, start: () => child });
  const task = manager.create({ title: 'fixture', instruction: 'fake only', owner: { name: 'o', transport: 'herdr-visible', session: 's', pane: 'p' } });
  task.dispatch = { execution: 'real', adapter: 'pi', engineKind: 'pi', engine: 'pi', model: CONFIGURED, effort: 'high', owner: 'o', worker: 'pi_worker', maxParallel: 2 };
  store.put(task);
  manager.start(task.id);
  return { child, store, id: task.id, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the model pi reports is written once to the task timeline and a matching run is untouched', () => {
  const h = engineHarness();
  try {
    h.child.emit('engine-model', { actual: CONFIGURED, expected: CONFIGURED, match: true });
    const task = h.store.get(h.id);
    assert.equal(task.status, 'running');
    assert.deepEqual(task.events.filter(e => e.message.startsWith('pi 实际模型')).map(e => [e.kind, e.message]), [['lifecycle', `pi 实际模型：${CONFIGURED}`]]);
    h.child.stdout.write(JSON.stringify({ type: 'result', summary: 'ok' }) + '\n');
    h.child.emit('close', 0, null);
    assert.equal(h.store.get(h.id).status, 'completed');
  } finally { h.cleanup(); }
});

test('a different provider/model fails the attempt with an event saying which was used and which was configured', () => {
  const h = engineHarness();
  try {
    h.child.emit('engine-model', { actual: 'cc-switch-zhipu-glm/glm-5.3', expected: CONFIGURED, match: false });
    const task = h.store.get(h.id);
    assert.equal(task.status, 'failed');
    assert.equal(task.failure?.kind, 'other');
    assert.match(task.failure?.message ?? '', /pi 实际使用 cc-switch-zhipu-glm\/glm-5\.3，配置为 cc-switch-agentplan\/glm-5\.3-flash/);
    assert.ok(task.events.some(e => e.kind === 'lifecycle' && e.message === 'pi 实际模型：cc-switch-zhipu-glm/glm-5.3'));
    assert.ok(task.events.some(e => e.kind === 'error' && /实际使用 cc-switch-zhipu-glm\/glm-5\.3，配置为 cc-switch-agentplan\/glm-5\.3-flash/.test(e.message)));
    // Even if the process then reports a normal result and exits 0, the wrong-model run is not delivered.
    h.child.stdout.write(JSON.stringify({ type: 'result', summary: 'wrong model answer' }) + '\n');
    h.child.emit('close', 0, null);
    const done = h.store.get(h.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.summary, undefined);
  } finally { h.cleanup(); }
});

async function runFakePi(lines: Array<Record<string, unknown>>, model: string) {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-pi-events-'));
  const previous = process.env.PATH;
  writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(join(dir, 'systemctl'), '#!/bin/sh\necho ActiveState=inactive\n', { mode: 0o700 });
  writeFileSync(join(dir, 'pi'), `#!${process.execPath}\nrequire('node:fs').readFileSync(0);for(const line of ${JSON.stringify(lines.map(line => JSON.stringify(line)))})console.log(line);`, { mode: 0o700 });
  process.env.PATH = `${dir}:${previous}`;
  try {
    const agent = startCliAgent({ engine: 'pi', model, effort: 'high', workspace: dir, stateDir: join(dir, 'state'), instruction: 'Fixture only. No model calls.' });
    const reports: unknown[] = [];
    agent.on('engine-model', report => reports.push(report));
    agent.stdout.resume();
    agent.stderr.resume();
    await new Promise(resolve => agent.once('close', resolve));
    return reports;
  } finally {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the pi launcher reports each distinct provider/model once and whether it is the configured one', { timeout: 20_000 }, async () => {
  const assistant = (provider: string, model: string, extra: Record<string, unknown> = {}) => ({ role: 'assistant', provider, model, content: [], ...extra });
  const events = [
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'user', content: 'x' } },
    { type: 'message_start', message: assistant('cc-switch-agentplan', 'glm-5.3-flash') },
    { type: 'message_update', message: assistant('cc-switch-agentplan', 'glm-5.3-flash') },
    { type: 'message_end', message: assistant('cc-switch-agentplan', 'glm-5.3-flash', { stopReason: 'stop', responseModel: 'glm-5.3-flash-2026' }) },
    { type: 'turn_end', message: assistant('cc-switch-agentplan', 'glm-5.3-flash') },
    { type: 'agent_end' },
  ];
  assert.deepEqual(await runFakePi(events, CONFIGURED), [{ actual: CONFIGURED, expected: CONFIGURED, match: true }]);
  assert.deepEqual(await runFakePi(events, 'cc-switch-zhipu-glm/glm-5.3'), [{ actual: CONFIGURED, expected: 'cc-switch-zhipu-glm/glm-5.3', match: false }]);
  // Output without provider and model (older fixtures, tool-only events) reports nothing and cannot fail a run.
  assert.deepEqual(await runFakePi([{ type: 'message_end', message: { role: 'assistant', model: 'fixture/pi', stopReason: 'stop', content: [] } }], 'fixture/pi'), []);
});

// --- pi events are not misread as a vendor limit -----------------------------------------------------------------------

const piLine = (message: Record<string, unknown>, type = 'message_start') => ({ type, message: { role: 'assistant', api: 'openai-completions', provider: 'cc-switch-agentplan', model: 'glm-5.3-flash', usage: { input: 429, output: 0, cacheRead: 0, totalTokens: 429, cost: { total: 0 } }, timestamp: 1790000000000, ...message } });

test('a pi event is classified on its error text only, never on token counters or provider names', () => {
  const missing = piLine({ stopReason: 'error', errorMessage: 'Error: Model "cc-switch-agentplan/glm-5.3-flash" not found. Use --list-models to see available models.' });
  assert.equal(classifyVendorEvent('pi', missing, JSON.stringify(missing)), undefined, 'a missing model is a configuration error, not a vendor limit');
  const bare = piLine({ stopReason: 'error' });
  assert.equal(classifyVendorEvent('pi', bare, JSON.stringify(bare)), undefined, 'the input:429 token counter is not an HTTP 429');
  const turn = piLine({ stopReason: 'aborted' }, 'turn_end');
  assert.equal(classifyVendorEvent('pi', turn, JSON.stringify(turn)), undefined);
});

test('a real pi rate limit is still a rate limit, and the block reason is its error text rather than the raw JSON line', () => {
  const limited = piLine({ stopReason: 'error', errorMessage: '429 {"error":{"message":"Rate limit reached for requests"}}' });
  const failure = classifyVendorEvent('pi', limited, JSON.stringify(limited));
  assert.equal(failure?.kind, 'rate_limit');
  assert.doesNotMatch(failure?.message ?? '', /message_start|cc-switch-agentplan/);
  assert.match(failure?.message ?? '', /Rate limit reached/);
  assert.equal(piErrorText({ type: 'error', error: { message: 'insufficient_quota' } }), 'insufficient_quota');
  assert.equal(classifyVendorEvent('pi', { type: 'error', error: 'You exceeded your current quota' }, '')?.kind, 'quota');
});

test('other engines keep classifying the whole structured line', () => {
  const line = JSON.stringify({ type: 'error', error: { message: 'Rate limit exceeded' } });
  assert.equal(classifyVendorEvent('opencode', JSON.parse(line), line)?.kind, 'rate_limit');
});
