import assert from 'node:assert/strict';
import test from 'node:test';
import { command } from '../../src/renderer/api/commands';
import { readMutationReceipt, ScheduleMutationGate, type ScheduleMutation, type UnconfirmedIntent } from '../../src/renderer/features/schedules/schedule-mutations';
import {
  BUILTIN_INTERVAL_MAX_SECONDS, BUILTIN_INTERVAL_MIN_SECONDS, builtinPatch, cronExpressionError,
  draftErrors, emptyDraft, scheduleInput,
} from '../../src/renderer/features/schedules/schedules-view';
import type { CommandRequest, CommandResponse } from '../../src/shared/contracts/commands';
import type { ScheduleDefinition } from '../../src/shared/contracts/schedules';
import type { WeaverAPI } from '../../src/shared/contracts/api';

const ULT = (code: string, message: string): Error => Object.assign(new Error(message), { code });

test('cron 判断只看字段个数，Croner 的 L、W、# 全部交给服务端', () => {
  assert.equal(cronExpressionError('0 0 1 * *'), '');
  assert.equal(cronExpressionError('*/15 * * * * 30'), '');
  assert.equal(cronExpressionError('0 0 * * 1#1'), '');
  assert.equal(cronExpressionError('0 0 L * *'), '');
  assert.equal(cronExpressionError('0 0 * * *L+1W'), '');
  assert.equal(cronExpressionError('59 59 31 12 * ?'), '');
  assert.equal(cronExpressionError('*/15 * * * *'), '');
  assert.match(cronExpressionError(''), /cron/);
  assert.match(cronExpressionError('*/15 *'), /5 或 6/);
  assert.match(cronExpressionError('*/15 * * * * * 30'), /5 或 6/);
});

test('用户任务必须填已有绝对路径的 workspace，内置任务跳过执行类检查', () => {
  const userDraft = { ...emptyDraft(), name: '清缓存', kind: 'script' as const, intervalSeconds: 900, command: 'echo ok', timeoutSeconds: 60 };
  assert.match(draftErrors(userDraft, false).workspace ?? '', /选择目标项目目录/);
  assert.equal(draftErrors(userDraft, false).command, undefined);
  const builtinDraft = { ...emptyDraft(), name: '额度刷新', intervalSeconds: BUILTIN_INTERVAL_MIN_SECONDS };
  assert.equal(draftErrors(builtinDraft, true).workspace, undefined);
  assert.equal(draftErrors(builtinDraft, true).timeout, undefined);
});

test('名称长于 160 字、验收标准/约束按共享契约的 30 行×1000 字收紧', () => {
  assert.match(draftErrors({ ...emptyDraft(), name: 'n'.repeat(170) }, false).name ?? '', /160/);
  const long = 'c'.repeat(1001);
  assert.match(draftErrors({ ...emptyDraft(), name: 'ok', kind: 'agent' as const, goal: 'g', profile: 'p', criteria: long }, false).criteria ?? '', /1000/);
  const many = Array.from({ length: 31 }, (_, i) => `c${i}`).join('\n');
  assert.match(draftErrors({ ...emptyDraft(), name: 'ok', kind: 'agent' as const, goal: 'g', profile: 'p', constraints: many }, false).constraints ?? '', /30/);
});

test('内置额度间隔只在 300–86400 秒且整分钟内有效，编辑输出一个原子 patch', () => {
  const builtin = (seconds?: number, patch: { enabled?: boolean } = {}) => ({ ...emptyDraft(), name: '内置', intervalSeconds: seconds, ...patch });
  assert.ok(draftErrors(builtin(240), true).interval, '低于下限直接判无效');
  assert.equal(draftErrors(builtin(BUILTIN_INTERVAL_MIN_SECONDS), true).interval, undefined);
  assert.equal(draftErrors(builtin(BUILTIN_INTERVAL_MIN_SECONDS + 30 * 60), true).interval, undefined);
  assert.ok(draftErrors(builtin(450), true).interval, '不整分钟的秒数无效');
assert.ok(draftErrors(builtin(BUILTIN_INTERVAL_MAX_SECONDS + 60), true).interval, '高于上限判无效');
  assert.equal(draftErrors(builtin(BUILTIN_INTERVAL_MAX_SECONDS), true).interval, undefined);
  const flippedOff = builtin(BUILTIN_INTERVAL_MIN_SECONDS + 30 * 60, { enabled: false });
  assert.equal(draftErrors(flippedOff, true).interval, undefined);
  const definition = { id: 's', name: '内置', kind: 'script', enabled: true, builtin: 'quota.refresh',
    timing: { mode: 'interval', seconds: BUILTIN_INTERVAL_MIN_SECONDS + 30 * 60 }, revision: 1,
    createdAt: '', updatedAt: '', nextRunAt: null, lastRunAt: null } as ScheduleDefinition;
  const patch = builtinPatch(flippedOff, definition);
  assert.deepEqual(patch, { timing: { mode: 'interval', seconds: BUILTIN_INTERVAL_MIN_SECONDS + 30 * 60 }, enabled: false });
  assert.deepEqual(Object.keys(patch), ['timing', 'enabled']);
});

test('scheduleInput 一次性带上 workspace 与 enabled，单请求完成切换', () => {
  const input = scheduleInput({ ...emptyDraft(), name: '巡检', kind: 'script', enabled: false, intervalSeconds: 60, workspace: '/srv/project', command: 'echo hi', timeoutSeconds: 30 });
  assert.deepEqual(input, {
    name: '巡检', kind: 'script', enabled: false, timing: { mode: 'interval', seconds: 60 },
    workspace: '/srv/project', script: { command: 'echo hi', timeoutSeconds: 30 },
  });
});

/**
 * The current command gateway in miniature: one receipt per id, apply-once mutations, and
 * receipt reuse rules. Transport failure modes switch per test via `mode`.
 */
class SimGateway {
  readonly receipts = new Map<string, { command: string; args?: Record<string, unknown>; response?: CommandResponse }>();
  readonly sends: CommandRequest[] = [];
  applied = { create: 0, run: 0 };
  /** ok: answer normally; lost: apply and store the receipt but lose the response;
   * interrupted: receipt stored without a verdict; silent: throw before touching state. */
  mode: 'ok' | 'lost' | 'interrupted' | 'silent' = 'ok';

  private response(data: unknown, request: CommandRequest): CommandResponse {
    return { apiVersion: 'weaver.v1', commandId: request.commandId, ok: true, data };
  }

  async command(request: CommandRequest): Promise<CommandResponse> {
    this.sends.push(request);
    if (request.command === 'operations.get') {
      const id = String((request.args as { commandId?: unknown }).commandId ?? '');
      const receipt = this.receipts.get(id);
      if (!receipt) throw ULT('NOT_FOUND', 'Command receipt not found');
      return { apiVersion: 'weaver.v1', ok: true, data: { commandId: id, state: receipt.response ? 'settled' : 'indeterminate', response: receipt.response } };
    }
    if (request.command !== 'schedules.create' && request.command !== 'schedules.run') throw ULT('COMMAND_UNKNOWN', request.command);
    const existing = this.receipts.get(request.commandId!);
    if (existing && existing.response) return existing.response;
    if (existing && !existing.response) throw ULT('COMMAND_INDETERMINATE', '那条命令的回执还没有结果');
    if (this.mode === 'silent') throw ULT('NETWORK', '连接在送达前断开');
    if (request.command === 'schedules.create') {
      this.applied.create += 1;
      const data: ScheduleDefinition = {
        id: 'schedule-new', name: '新建任务', kind: 'script', enabled: true, timing: { mode: 'interval', seconds: 60 },
        revision: 1, createdAt: '', updatedAt: '', nextRunAt: null, lastRunAt: null,
      };
      const settled = this.response(data, request);
      this.receipts.set(request.commandId!, { command: request.command, args: request.args, response: this.mode === 'interrupted' ? undefined : settled });
    } else {
      this.applied.run += 1;
      const data = { id: 'run-1', scheduleId: 'schedule-1', trigger: 'manual', status: 'succeeded', startedAt: '', finishedAt: '', output: 'done' };
      const settled = this.response(data, request);
      this.receipts.set(request.commandId!, { command: request.command, args: request.args, response: this.mode === 'interrupted' ? undefined : settled });
    }
    if (this.mode !== 'ok') throw ULT('NETWORK', '请求结果在返回途中丢失');
    return this.receipts.get(request.commandId!)!.response!;
  }
}

function makeGate(sim: SimGateway, initialSend?: (mutation: ScheduleMutation) => Promise<unknown>) {
  let send: (mutation: ScheduleMutation) => Promise<unknown> =
    initialSend ?? (mutation => command(mutation.command, mutation.args, true, mutation.commandId));
  const state = {
    busy: false, checking: false, settle: 0,
    decided: [] as [unknown, string][],
    applied: [] as [unknown, string, boolean][],
    pending: undefined as UnconfirmedIntent | undefined,
  };
  const gate = new ScheduleMutationGate({
    send: mutation => send(mutation),
    readReceipt: readMutationReceipt,
    busy: value => { state.busy = value; },
    checking: value => { state.checking = value; },
    pending: value => { state.pending = value; },
    settle: () => { state.settle += 1; },
    rejected: (error, context) => { state.decided.push([error, context]); },
    applied: (result, intent, confirmed) => { state.applied.push([result, intent.context, confirmed]); intent.applied?.(result); },
  });
  return { state, gate, useSend: (next: (mutation: ScheduleMutation) => Promise<unknown>) => { send = next; } };
}

function bridge(fn: WeaverAPI['command'] | undefined) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fn ? { weaver: { command: fn } } : undefined });
}

test('发送后响应丢失：通过 operations.get 用同一个 commandId 核对并复用它，绝不重跑创建', async () => {
  const sim = new SimGateway();
  sim.mode = 'lost';
  const { state, gate } = makeGate(sim);
  bridge(sim.command.bind(sim));
  try {
    assert.equal(await gate.run('schedules.create', { name: '巡检', kind: 'script' }, '创建定时任务失败'), false);
    assert.ok(state.pending, '判不明的结果必须停下来，把这次 intent 挂起');
    assert.equal(sim.applied.create, 1, '服务端只执行了一次创建');
    assert.equal(state.applied.length, 0, '拿到确定结果前不宣布成功');
    const parkedId = state.pending!.mutation.commandId;
    assert.match(parkedId, /^[0-9a-f-]{36}$/);
    assert.equal(await gate.verify(), true);
    assert.equal(sim.applied.create, 1, '核对结果不能再创建一条');
    const [result, context, confirmed] = state.applied[0];
    assert.equal(context, '创建定时任务失败');
    assert.equal(confirmed, true, '核对确定的 outcome 也记一次 applied');
    assert.ok(result);
    const mutationSends = sim.sends.filter(request => request.command === 'schedules.create');
    assert.equal(mutationSends.length, 1, '只有最初那一次真正送达创建');
    const lookups = sim.sends.filter(request => request.command === 'operations.get');
    assert.equal(lookups.length, 1);
    assert.deepEqual(lookups[0]!.args, { commandId: parkedId });
    assert.equal(state.pending, undefined);
    assert.ok(state.settle >= 1);
  } finally { bridge(undefined); }
});

test('回执尚未定论：不自动重发；用户要求时用同一 id 和同样参数重发一次', async () => {
  const sim = new SimGateway();
  sim.mode = 'interrupted';
  const { state, gate } = makeGate(sim);
  bridge(sim.command.bind(sim));
  try {
    assert.equal(await gate.run('schedules.run', { scheduleId: 'schedule-1' }, '立即运行失败'), false);
    assert.equal(sim.applied.run, 1, '短脚本在第一次发送时已经跑过');
    assert.equal(await gate.verify(), false, '核对仍处于未定状态');
    assert.match(state.pending!.reason, /核对/);
    const parkedId = state.pending!.mutation.commandId;
    const parkedArgs = state.pending!.mutation.args;
    assert.equal(await gate.resend(), false, '重发同一请求拿到的仍是「回执没有结果」');
    assert.equal(sim.applied.run, 1, '重发同一请求不会再次执行短脚本');
    const sends = sim.sends.filter(request => request.command === 'schedules.run');
    assert.ok(sends.length >= 2, '确实发生过一次重发');
    for (const request of sends) {
      assert.equal(request.commandId, parkedId, '重发沿用挂起的 commandId');
      assert.deepEqual(request.args, parkedArgs, 'args 快照保持原样');
    }
    assert.ok(state.pending, '还停在未确认状态，等下一次核对');
  } finally { bridge(undefined); }
});

test('请求从未送达服务端：核对后按同一 id、同一参数重发，并且恰好执行一次', async () => {
  const sim = new SimGateway();
  sim.mode = 'silent';
  const { state, gate } = makeGate(sim);
  bridge(sim.command.bind(sim));
  try {
    assert.equal(await gate.run('schedules.create', { name: '巡检', kind: 'script' }, '创建定时任务失败'), false);
    assert.equal(sim.applied.create, 0);
    assert.equal(await gate.verify(), false, '没有回执：核对说明当时很可能没送达');
    assert.match(state.pending!.reason, /重发/);
    sim.mode = 'ok';
    assert.equal(await gate.resend(), true);
    assert.equal(sim.applied.create, 1, '同一 id 只会执行一次');
    assert.deepEqual(state.applied[0][1], '创建定时任务失败');
    assert.equal(state.pending, undefined);
    const ids = new Set(sim.sends.filter(request => request.command !== 'operations.get').map(request => request.commandId));
    assert.equal(ids.size, 1, '全程只用一个 commandId');
  } finally { bridge(undefined); }
});

test('服务端明确的拒绝：不挂起 intent，直接归为失败，页面立刻可以提交修正后的意图', async () => {
  const sim = new SimGateway();
  const { state, gate, useSend } = makeGate(sim, async () => { throw ULT('REVISION_CONFLICT', '定义已更新，请刷新后重试。'); });
  assert.equal(await gate.run('schedules.disable', { scheduleId: 'schedule-1', expectedRevision: 2 }, '停用失败'), false);
  assert.equal(state.pending, undefined, '明确失败不占用未确认位');
  assert.equal(state.decided.length, 1);
  const [error, context] = state.decided[0];
  assert.equal(context, '停用失败');
  assert.equal((error as { code?: string }).code, 'REVISION_CONFLICT');
  assert.match((error as Error).message, /已更新/);
  assert.ok(state.settle >= 1);
  bridge(sim.command.bind(sim));
  try {
    sim.mode = 'ok';
    useSend(async mutation => command(mutation.command, mutation.args, true, mutation.commandId));
    assert.equal(await gate.run('schedules.create', { name: '第二条' }, '创建定时任务失败'), true, '页面随即可以提交修正后的意图');
    assert.equal(state.applied[0][1], '创建定时任务失败');
    assert.equal(sim.applied.create, 1);
  } finally { bridge(undefined); }
});

test('存在未确认 intent 期间：页面暂停其它提交，解除前不发出新意图', async () => {
  const sim = new SimGateway();
  sim.mode = 'lost';
  const { state, gate } = makeGate(sim);
  bridge(sim.command.bind(sim));
  try {
    assert.equal(await gate.run('schedules.run', { scheduleId: 'schedule-1' }, '立即运行失败'), false);
    assert.ok(state.pending);
    assert.equal(state.busy, false, '传输层那一轮已经结束，暂停来自挂起的 intent');
    assert.equal(await gate.run('schedules.create', { name: '第二条' }, '创建定时任务失败'), false, '未有结论时不提交下一个意图');
    assert.equal(sim.applied.create, 0, '挂起期间不发出新的 mutation');
    assert.equal(await gate.verify(), true);
    assert.equal(state.pending, undefined);
    sim.mode = 'ok';
    assert.equal(await gate.run('schedules.create', { name: '第二条' }, '创建定时任务失败'), true, '解决后再提交正常执行');
    assert.equal(sim.applied.create, 1);
  } finally { bridge(undefined); }
});

test('核对回执缺失：按未解决处理，绝不虚构成功', async () => {
  const sim = new SimGateway();
  sim.mode = 'silent';
  const { state, gate } = makeGate(sim);
  bridge(sim.command.bind(sim));
  try {
    await assert.rejects(readMutationReceipt('missing-id'), (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
    assert.equal(await gate.run('schedules.run', { scheduleId: 'schedule-1' }, '立即运行失败'), false);
    assert.equal(await gate.verify(), false);
    assert.match(state.pending!.reason, /重发/);
    const runs = sim.sends.filter(item => item.command === 'schedules.run');
    assert.equal(state.pending!.mutation.commandId, runs[0]!.commandId);
  } finally { bridge(undefined); }
});
