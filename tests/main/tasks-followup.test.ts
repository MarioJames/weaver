import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MockWorkerAdapter } from '../../src/main/adapters/worker';
import { CLI_CATALOG, CLI_HELP } from '../../src/cli/catalog';
import { parseCLI } from '../../src/cli/parse';
import { CommandHandler } from '../../src/main/commands';
import { TaskManager } from '../../src/main/manager';
import { ownerFollowupPrompt, type OwnerLaunchInput, type OwnerLaunchResult, type Runner, type RunnerInput, type RunnerResult } from '../../src/main/owner-host';
import { PolicyStore } from '../../src/main/policy/store';
import { TaskStore } from '../../src/main/store';
import type { TaskOwnerHost } from '../../src/shared/contracts/tasks';

const HERDR = '/fake/herdr';
const OK = (value: unknown): RunnerResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const agentInfo = (overrides: Record<string, unknown> = {}) => OK({ result: { agent: { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: 'term-1', agent: 'codex', ...overrides } } });
const promptOk = () => OK({ result: { type: 'agent_prompted', agent: { pane_id: 'w1:p1', agent_status: 'working' } } });

function fixture(options: { host?: Partial<TaskOwnerHost> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-followup-'));
  const store = new TaskStore(join(dir, 'weaver.db'));
  const policy = new PolicyStore(join(dir, 'weaver.db'));
  const manager = new TaskManager(store, new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs')));
  const launches: OwnerLaunchInput[] = [];
  const calls: RunnerInput[] = [];
  let get: () => RunnerResult = agentInfo;
  let prompt: () => RunnerResult = promptOk;
  const runner: Runner = input => {
    calls.push(input);
    if (input.args[2] === 'agent' && input.args[3] === 'get') return get();
    if (input.args[2] === 'agent' && input.args[3] === 'prompt') return prompt();
    return { code: 1, stdout: '', stderr: `unexpected herdr call ${input.args.join(' ')}` };
  };
  const host = (input: OwnerLaunchInput): OwnerLaunchResult => ({
    session: 'sess-1', workspaceId: 'w1', paneId: 'w1:p1', tabId: 'w1:t1', terminalId: 'term-1',
    agentName: `owner-${input.taskId.slice(0, 8)}-${input.epoch}`, ...options.host,
  });
  const handler = new CommandHandler(manager, policy, () => { throw new Error('No synchronous owner launch in fixture'); }, () => true, undefined,
    { launcher: async input => { launches.push(input); return host(input); }, closer: async () => {} }, {}, { runner, herdrPath: HERDR });
  const raw = (command: string, args: Record<string, unknown> = {}, commandId: string = randomUUID()) => handler.handle({ apiVersion: 'weaver.v1', commandId, command, args });
  const call = (command: string, args: Record<string, unknown> = {}, commandId?: string): any => {
    const response = raw(command, args, commandId);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  const task = call('tasks.create', { goal: 'root follow-up fixture', workspace: dir, ownerProfileId: 'codex_owner' });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const start = async () => { call('tasks.start', { taskId: task.id }); await settle(); };
  const followup = (args: Record<string, unknown>, commandId: string = randomUUID()) => raw('tasks.followup', { taskId: task.id, ...args }, commandId);
  const promptCalls = () => calls.filter(input => input.args[2] === 'agent' && input.args[3] === 'prompt');
  return {
    dir, store, policy, manager, handler, task, launches, calls, raw, call, start, settle, followup, promptCalls,
    setGet: (value: () => RunnerResult) => { get = value; },
    setPrompt: (value: () => RunnerResult) => { prompt = value; },
    async close() { await handler.drain(); await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('followup delivers the fixed template as one argv element, records the event and replays its receipt', async () => {
  const f = fixture(); try {
    await f.start();
    const message = '请补充导出 CSV，并保留现有格式。\n第二行包含 "quotes" 和 $HOME';
    const request = { apiVersion: 'weaver.v1', command: 'tasks.followup', commandId: randomUUID(), args: { taskId: f.task.id, message, source: 'feishu-bot' } };
    const response = await f.handler.handleAsync(request);
    assert.equal(response.ok, true, JSON.stringify(response));
    const data = response.data as any;
    assert.equal(data.taskId, f.task.id);
    assert.equal(data.delivered, true);
    assert.ok(Number.isFinite(Date.parse(data.deliveredAt)));
    assert.deepEqual(data.ownerHost, { session: 'sess-1', paneId: 'w1:p1' });
    const prompts = f.promptCalls();
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0], { file: HERDR, args: ['--session', 'sess-1', 'agent', 'prompt', 'w1:p1', ownerFollowupPrompt({ taskId: f.task.id, message, source: 'feishu-bot' })], timeout: 60000 });
    assert.equal(prompts[0]!.args.length, 6);
    assert.ok(prompts[0]!.args[5]!.includes(message));
    assert.deepEqual(f.calls[0], { file: HERDR, args: ['--session', 'sess-1', 'agent', 'get', 'w1:p1'], timeout: 15000 });
    const event = f.store.get(f.task.id).events.at(-1)!;
    assert.equal(event.kind, 'log');
    assert.ok(event.message.includes('feishu-bot'));
    assert.ok(event.message.includes(message));
    assert.ok(f.call('tasks.events', { taskId: f.task.id }).events.some((item: any) => item.message.includes(message)));
    assert.deepEqual(await f.handler.handleAsync(request), response);
    assert.equal(f.promptCalls().length, 1);
    assert.equal(f.store.get(f.task.id).events.filter(item => item.message.includes(message)).length, 1);
  } finally { await f.close(); }
});

test('followup redacts the stored event but delivers the original message', async () => {
  const f = fixture(); try {
    await f.start();
    const message = 'keep this correction but token=super-secret-value';
    assert.equal(f.followup({ message }).ok, true);
    assert.ok(f.promptCalls()[0]!.args[5]!.includes(message), 'the owner receives the original text');
    const event = f.store.get(f.task.id).events.at(-1)!;
    assert.equal(event.message.includes('super-secret-value'), false);
    assert.match(event.message, /token=\[REDACTED\]/);
  } finally { await f.close(); }
});

test('followup validates message and source before any host or task effect', async () => {
  const f = fixture(); try {
    await f.start();
    const before = f.store.get(f.task.id);
    for (const args of [{ message: '' }, { message: '   ' }, { message: 'x'.repeat(8001) }, { message: 42 }, { message: 'ok', source: 's'.repeat(41) }, { message: 'ok', source: '   ' }, { message: 'ok', source: 7 }]) {
      const response = f.raw('tasks.followup', { taskId: f.task.id, ...args });
      assert.equal(response.error?.code, 'INVALID_REQUEST', JSON.stringify(args));
    }
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.store.get(f.task.id), before, 'invalid input leaves the task untouched');
  } finally { await f.close(); }
});

test('followup refuses non-root, queued and hostless tasks with INVALID_STATE and no delivery', async () => {
  const f = fixture(); try {
    const queued = f.raw('tasks.followup', { taskId: f.task.id, message: 'too early' });
    assert.equal(queued.error?.code, 'INVALID_STATE');
    assert.match(queued.error?.message ?? '', /not started/i);
    await f.start();
    f.call('tasks.describe', { taskId: f.task.id, expectedRevision: f.store.get(f.task.id).revision, title: 'Root', acceptanceCriteria: ['done'] });
    const child = f.call('tasks.create', { parentTaskId: f.task.id, title: 'Child', goal: 'bounded work' });
    const nonRoot = f.raw('tasks.followup', { taskId: child.id, message: 'wrong target' });
    assert.equal(nonRoot.error?.code, 'INVALID_STATE');
    assert.match(nonRoot.error?.message ?? '', /root/i);
    const stored = f.store.get(f.task.id);
    delete stored.ownerHost;
    f.store.put(stored);
    const hostless = f.raw('tasks.followup', { taskId: f.task.id, message: 'no host' });
    assert.equal(hostless.error?.code, 'INVALID_STATE');
    assert.match(hostless.error?.message ?? '', /owner host/i);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.get(f.task.id).events.some(item => item.message.includes('no host')), false);
  } finally { await f.close(); }
});

test('followup verifies the pane, workspace, tab, terminal and agent kind before prompting', async () => {
  const f = fixture(); try {
    await f.start();
    const mismatches: [string, () => RunnerResult][] = [
      ['missing', () => ({ code: 1, stdout: '', stderr: 'pane not found' })],
      ['envelope', () => OK({ error: { code: 'agent_not_found', message: 'gone' } })],
      ['workspace', () => agentInfo({ workspace_id: 'w2' })],
      ['tab', () => agentInfo({ tab_id: 'w2:t9' })],
      ['terminal', () => agentInfo({ terminal_id: 'term-9' })],
      ['agent kind', () => agentInfo({ agent: 'claude' })],
    ];
    for (const [label, get] of mismatches) {
      f.setGet(get);
      const message = `private follow-up for ${label}`;
      const response = f.followup({ message });
      assert.equal(response.error?.code, 'OWNER_HOST_UNAVAILABLE', label);
      assert.equal(f.promptCalls().length, 0, `${label} must not prompt`);
      const event = f.store.get(f.task.id).events.at(-1)!;
      assert.equal(event.kind, 'error', label);
      assert.equal(event.message.includes(message), false, `${label} failure event must not contain the original text`);
      assert.ok(event.message.includes('OWNER_HOST_UNAVAILABLE'), label);
    }
    assert.equal(f.store.get(f.task.id).ownerHost?.paneId, 'w1:p1');
    f.setGet(agentInfo);
    assert.equal(f.followup({ message: 'host is back' }).ok, true);
  } finally { await f.close(); }
});

test('legacy hosts without tab or terminal identity still verify by the remaining fields', async () => {
  const f = fixture(); try {
    await f.start();
    const stored = f.store.get(f.task.id);
    delete stored.ownerHost!.tabId;
    delete stored.ownerHost!.terminalId;
    f.store.put(stored);
    f.setGet(() => agentInfo({ tab_id: 'other:t', terminal_id: 'other-term' }));
    const response = f.followup({ message: 'legacy record follow-up' });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(f.promptCalls().length, 1);
  } finally { await f.close(); }
});

test('followup reports Herdr prompt failures as OWNER_FOLLOWUP_FAILED without retrying or recording the original text', async () => {
  const f = fixture(); try {
    await f.start();
    for (const prompt of [() => OK({ error: { code: 'agent_blocked', message: 'agent is busy' } }), () => ({ code: 1, stdout: '', stderr: 'socket closed' }), () => ({ code: 0, stdout: 'not json', stderr: '' })]) {
      f.setPrompt(prompt);
      const message = 'secret instruction that must not be stored';
      const response = f.followup({ message, source: 'feishu-bot' });
      assert.equal(response.error?.code, 'OWNER_FOLLOWUP_FAILED');
      const event = f.store.get(f.task.id).events.at(-1)!;
      assert.equal(event.kind, 'error');
      assert.equal(event.message.includes(message), false);
      assert.ok(event.message.includes('feishu-bot'));
      assert.equal(f.store.get(f.task.id).events.filter(item => item.message.includes(message)).length, 0);
    }
    assert.equal(f.promptCalls().length, 3, 'each attempt delivers once and never retries');
  } finally { await f.close(); }
});

test('CLI catalog exposes tasks followup with its input contract and help', () => {
  const row = CLI_CATALOG.find(item => item.command === 'tasks.followup');
  assert.ok(row);
  assert.equal(row!.mutation, true);
  assert.deepEqual(Object.keys(row!.inputFields!.required).sort(), ['message', 'taskId']);
  assert.deepEqual(Object.keys(row!.inputFields!.optional ?? {}), ['source']);
  assert.match(row!.usage, /tasks followup/);
  assert.match(CLI_HELP, /tasks followup/);
  assert.equal(parseCLI(['tasks', 'followup', '--task-id', 't']).command, 'tasks.followup');
  assert.equal(parseCLI(['tasks.followup']).command, 'tasks.followup');
});
