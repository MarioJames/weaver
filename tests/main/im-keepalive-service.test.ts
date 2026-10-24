import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImService } from '../../src/main/im/service';
import type { ImChannelFactory, ImChannelHandlers, Delivery } from '../../src/main/im/channel';
import { ConfirmedParentCancellation, type ParentAgentFactory, type ParentProgressEvent } from '../../src/main/im/parent-agent';
import type { KeepaliveTimers } from '../../src/main/im/keepalive';
import { KEEPALIVE_IDLE_COPY, KEEPALIVE_QUEUED_COPY, KEEPALIVE_SINGLE_COPY } from '../../src/main/im/keepalive';
import type { PolicySnapshot } from '../../src/shared/contracts/policy';
import type { NormalizedMessage } from '@larksuite/channel';

const ROOT = await mkdtemp(join(tmpdir(), 'weaver-im-keepalive-'));
test.after(async () => { await rm(ROOT, { recursive: true, force: true }); });
const tick = async () => { for (let n = 0; n < 24; n++) await new Promise<void>(r => setImmediate(r)); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; }); return { promise, resolve, reject }; }

function policy(): PolicySnapshot {
  return {
    revision: 0,
    config: {
      version: 1,
      engines: { codex: { enabled: true, kind: 'codex' } },channels:{"default_codex":{engine:"codex",label:"codex",kind:"subscription",enabled:true}},
      owners: { main: { enabled: true, channel: "default_codex", model: 'gpt-test', effort: 'medium', workers: [], max_parallel: 1 } },
      workers: {}, herdr: { max_wait_minutes: 30 },
    },
    blocks: [], activeBlocks: [], owners: {}, workers: {}, execution: 'disabled',
  };
}

function message(id: string, text = '你好', now = Date.now()): NormalizedMessage {
  return {
    messageId: `om_${id}`, chatId: 'oc_a', chatType: 'p2p', senderId: 'ou_a', senderType: 'user',
    content: text, rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: false,
    createTime: now,
    raw: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_a' } },
      message: { message_id: `om_${id}`, chat_id: 'oc_a', chat_type: 'p2p', message_type: 'text', create_time: String(now), content: JSON.stringify({ text }) },
    },
  };
}

function fixture() {
  let handlers!: ImChannelHandlers;
  const chunks: string[] = [];
  const cards: { id: string; card: unknown }[] = [];
  const notices: string[] = [];
  let seq = 0;
  let failSends = false;
  let updateGate: Promise<void> | undefined;
  const factory: ImChannelFactory = (_config, channelHandlers) => {
    handlers = channelHandlers;
    return {
      connect: async () => {},
      close: async () => {},
      state: () => 'connected',
      send: async (_to, text) => { if (failSends) throw new Error('CANARY_TRANSPORT'); notices.push(text); },
      retireCard: async () => {},
      stream: async (_to, producer, delivery: Delivery) => {
        const id = `om_bot${++seq}`;
        await producer({
          messageId: id,
          append: async text => { assert.ok(delivery.valid()); chunks.push(text); },
          setContent: async text => { chunks.push(`[setContent]${text}`); },
        });
        return id;
      },
      updateCard: async (id, card, delivery) => {
        if (updateGate) await updateGate;
        assert.ok(delivery.valid());
        cards.push({ id, card });
      },
    };
  };
  return {
    factory,
    get handlers() { return handlers; },
    chunks, cards, notices,
    failSends() { failSends = true; },
    holdUpdate(gate: Promise<void>) { updateGate = gate; },
  };
}

function manualTimers() {
  let nextId = 0;
  const scheduled = new Map<number, { callback: () => void; delayMs: number }>();
  const timers: KeepaliveTimers = {
    setTimer(callback, delayMs) { const id = ++nextId; scheduled.set(id, { callback, delayMs }); return id; },
    clearTimer(handle) { scheduled.delete(handle as number); },
  };
  return {
    timers,
    delays: () => [...scheduled.values()].map(item => item.delayMs),
    fire() {
      const [entry] = scheduled.entries();
      assert.ok(entry, 'expected a scheduled keepalive timer');
      scheduled.delete(entry[0]);
      entry[1].callback();
    },
  };
}

function heldParent() {
  const outcome = deferred<string>();
  let captured: { onDelta?: (text: string) => void; onProgress?: (event: ParentProgressEvent) => void } = {};
  const factory: ParentAgentFactory = async () => ({
    send: (_text, signal, onDelta, options) => new Promise<string>((resolve, reject) => {
      captured = { onDelta, onProgress: options?.onProgress };
      outcome.promise.then(resolve, reject);
      signal?.addEventListener('abort', () => reject(new ConfirmedParentCancellation()), { once: true });
    }),
    close: async () => {},
  });
  return { factory, outcome, get captured() { return captured; } };
}

function queuedParent() {
  const first = deferred<string>();
  let captured: { onDelta?: (text: string) => void; onProgress?: (event: ParentProgressEvent) => void } = {};
  let launched = 0;
  const factory: ParentAgentFactory = async () => {
    const current = launched++;
    return {
      send: (text, signal, onDelta, options) => {
        if (current !== 0) return Promise.resolve('完成');
        captured = { onDelta, onProgress: options?.onProgress };
        return new Promise<string>((resolve, reject) => {
          first.promise.then(resolve, reject);
          signal?.addEventListener('abort', () => reject(new ConfirmedParentCancellation()), { once: true });
        });
      },
      close: async () => {},
    };
  };
  return { factory, first, get captured() { return captured; } };
}

async function setup(t: any, parent: ParentAgentFactory, timers = manualTimers()) {
  const dir = await mkdtemp(join(ROOT, 'service-'));
  const f = fixture();
  const service = new ImService({ dataDir: dir, policy, parentFactory: parent, channelFactory: f.factory, keepaliveTimers: timers.timers });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const config = {
    enabled: true, appId: 'cli_test', appSecret: 'CANARY_SECRET', allowedOpenIds: ['ou_a'],
    channel: "default_codex", model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30,
    ownerProfileId: '',
  };
  await service.save({ expectedRevision: 0, config });
  await tick();
  return { dir, f, service, config, timers };
}

test('service 按 5/15/30/30 秒发独立纯文本短消息，卡片与最终收口不受影响', async t => {
  const parent = heldParent();
  const { f, timers } = await setup(t, parent.factory);
  f.handlers.message(message('keepalive'));
  await tick();

  assert.deepEqual(timers.delays(), [5_000]);
  timers.fire();
  assert.deepEqual(f.notices, [KEEPALIVE_IDLE_COPY[0][0]]);
  assert.deepEqual(f.chunks, [], '等待推送不写入流式卡片');
  assert.deepEqual(timers.delays(), [15_000]);

  timers.fire();
  timers.fire();
  timers.fire();
  assert.deepEqual(f.notices, [KEEPALIVE_IDLE_COPY[0][0], KEEPALIVE_IDLE_COPY[1][0], KEEPALIVE_IDLE_COPY[2][0], KEEPALIVE_IDLE_COPY[2][1]]);
  assert.deepEqual(timers.delays(), [30_000]);

  parent.outcome.resolve('最终答案');
  await tick();
  assert.deepEqual(timers.delays(), [], '轮末取消等待推送');
  assert.equal(f.cards.length, 1);
  assert.equal(f.chunks.at(-1), '[setContent]最终答案');
  assert.ok(!f.notices.join('').includes('最终答案'));
});

test('排队深度变化重置到 5 秒档：1 条用单条文案，>1 条带真实条数', async t => {
  const parent = queuedParent();
  const { f, timers } = await setup(t, parent.factory);
  f.handlers.message(message('A'));
  await tick();
  assert.deepEqual(timers.delays(), [5_000]);

  f.handlers.message(message('B'));
  await tick();
  assert.deepEqual(timers.delays(), [5_000], '入队重置计时');
  timers.fire();
  assert.deepEqual(f.notices, [KEEPALIVE_SINGLE_COPY[0]]);

  f.handlers.message(message('C'));
  await tick();
  timers.fire();
  assert.equal(f.notices[1], KEEPALIVE_QUEUED_COPY[0].replaceAll('{count}', '2'));
  assert.match(f.notices[1]!, /2 条/);

  f.handlers.message(message('D'));
  await tick();
  timers.fire();
  assert.equal(f.notices[2], KEEPALIVE_QUEUED_COPY[1].replaceAll('{count}', '3'));
  assert.match(f.notices[2]!, /3 条/);
  assert.deepEqual(timers.delays(), [15_000], '队列变化重置档位后按下一次 15 秒推进');

  parent.first.resolve('A 完成');
  await tick();
  assert.deepEqual(timers.delays(), []);
});

test('可见正文与进度行 append 重置回 5 秒档；空增量与隐藏控制片段不重置', async t => {
  const parent = heldParent();
  const { f, timers } = await setup(t, parent.factory);
  f.handlers.message(message('content'));
  await tick();
  timers.fire();
  assert.deepEqual(f.notices, [KEEPALIVE_IDLE_COPY[0][0]]);
  assert.deepEqual(timers.delays(), [15_000]);

  parent.captured.onDelta?.('公开内容');
  await tick();
  assert.deepEqual(timers.delays(), [5_000], '正文增量重置计时');
  timers.fire();
  assert.equal(f.notices[1], KEEPALIVE_IDLE_COPY[0][1], '正文到达后从 5 秒档重新开始');
  assert.deepEqual(timers.delays(), [15_000]);

  parent.captured.onDelta?.('');
  parent.captured.onDelta?.('<weaver-actions>{"actions":[]}</weaver-actions>');
  await tick();
  assert.deepEqual(timers.delays(), [15_000], '空增量与隐藏片段不算新内容');
  assert.ok(!f.chunks.join('').includes('weaver-actions'));

  parent.captured.onProgress?.({ kind: 'tool', name: 'shell' });
  await tick();
  assert.deepEqual(timers.delays(), [5_000], '进度行 append 重置计时');
  timers.fire();
  assert.equal(f.notices[2], KEEPALIVE_IDLE_COPY[0][2]);
  assert.ok(f.chunks.join('').includes('*工具调用中……*'));
  assert.ok(!f.chunks.join('').includes('shell'));

  parent.outcome.resolve('公开内容');
  await tick();
  assert.equal(f.chunks.at(-1), '[setContent]公开内容');
});

test('用户 stop 立即取消等待推送并保持流式卡片语义', async t => {
  const parent = heldParent();
  const { f, service, config, timers } = await setup(t, parent.factory);
  f.handlers.message(message('stop'));
  await tick();
  timers.fire();
  assert.deepEqual(timers.delays(), [15_000]);

  f.handlers.menu({ app_id: config.appId, event_id: 'stop-1', event_key: 'stop', create_time: String(Date.now()), operator: { operator_id: { open_id: 'ou_a' } } });
  await tick();
  assert.deepEqual(timers.delays(), []);
  assert.ok(f.notices.some(text => text.includes('已停止当前回复')));
  assert.equal(f.cards.length, 0);
  assert.equal(service.snapshot().status.busySessions, 0);
});

test('轮末（含 updateCard 未完成期间）与失败都取消等待推送', async t => {
  const completed = heldParent();
  const gate = deferred<void>();
  const first = await setup(t, completed.factory);
  first.f.holdUpdate(gate.promise);
  first.f.handlers.message(message('done'));
  await tick();
  first.timers.fire();
  assert.deepEqual(first.timers.delays(), [15_000]);
  completed.outcome.resolve('完成');
  await tick();
  assert.deepEqual(first.timers.delays(), [], 'parent send 结束后不再计时');
  assert.equal(first.f.cards.length, 0, 'updateCard 仍被挂起');
  gate.resolve();
  await tick();
  assert.equal(first.f.cards.length, 1);

  const failed = heldParent();
  const second = await setup(t, failed.factory);
  second.f.handlers.message(message('fail'));
  await tick();
  second.timers.fire();
  failed.outcome.reject(new Error('CANARY_PARENT'));
  await tick();
  assert.deepEqual(second.timers.delays(), []);
  assert.ok(second.f.notices.some(text => text.includes('本轮回复失败')));
  assert.ok(!second.f.notices.join('').includes('CANARY_PARENT'));
});

test('new_session 与传输失败都会取消等待推送', async t => {
  const parent = heldParent();
  const { f, config, timers } = await setup(t, parent.factory);
  f.handlers.message(message('reset'));
  await tick();
  timers.fire();
  assert.deepEqual(timers.delays(), [15_000]);
  f.handlers.menu({ app_id: config.appId, event_id: 'reset-1', event_key: 'new_session', create_time: String(Date.now()), operator: { operator_id: { open_id: 'ou_a' } } });
  await tick();
  assert.deepEqual(timers.delays(), []);

  const transport = heldParent();
  const second = await setup(t, transport.factory);
  second.f.handlers.message(message('transport'));
  await tick();
  second.f.failSends();
  second.timers.fire();
  await tick();
  assert.deepEqual(second.timers.delays(), [], '独立消息发送失败即取消');
  assert.equal(second.service.snapshot().status.connection, 'error');
  transport.outcome.resolve('完成');
  await tick();
});
