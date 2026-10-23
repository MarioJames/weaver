import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Keepalive,
  KEEPALIVE_DELAYS_MS,
  KEEPALIVE_IDLE_COPY,
  KEEPALIVE_QUEUED_COPY,
  KEEPALIVE_SINGLE_COPY,
  type KeepaliveTimers,
} from '../../src/main/im/keepalive';

interface Scheduled { callback: () => void; delayMs: number }

function harness(options: { depth?: number; valid?: () => boolean; send?: (text: string) => void | boolean | Promise<void | boolean> } = {}) {
  let nextId = 0;
  const scheduled = new Map<number, Scheduled>();
  const timers: KeepaliveTimers = {
    setTimer(callback, delayMs) { const id = ++nextId; scheduled.set(id, { callback, delayMs }); return id; },
    clearTimer(handle) { scheduled.delete(handle as number); },
  };
  const sent: string[] = [];
  let depth = options.depth ?? 0;
  const keepalive = new Keepalive({
    timers,
    depth: () => depth,
    valid: options.valid,
    send: options.send ?? (text => { sent.push(text); }),
  });
  const delays = () => [...scheduled.values()].map(item => item.delayMs);
  const fire = () => {
    const [entry] = scheduled.entries();
    assert.ok(entry, 'expected a scheduled keepalive timer');
    scheduled.delete(entry[0]);
    entry[1].callback();
  };
  return { keepalive, sent, delays, fire, scheduled, setDepth: (value: number) => { depth = value; } };
}

const rendered = (template: string, count: number) => template.replaceAll('{count}', String(count));

test('档位：首次 5 秒、15 秒，之后每 30 秒一次', () => {
  const h = harness();
  h.keepalive.start();
  assert.deepEqual(h.delays(), [KEEPALIVE_DELAYS_MS[0]]);

  h.fire();
  assert.deepEqual(h.sent, [KEEPALIVE_IDLE_COPY[0][0]]);
  assert.deepEqual(h.delays(), [KEEPALIVE_DELAYS_MS[1]]);

  h.fire();
  assert.deepEqual(h.sent, [KEEPALIVE_IDLE_COPY[0][0], KEEPALIVE_IDLE_COPY[1][0]]);
  assert.deepEqual(h.delays(), [KEEPALIVE_DELAYS_MS[2]]);

  h.fire();
  assert.equal(h.sent[2], KEEPALIVE_IDLE_COPY[2][0]);
  assert.deepEqual(h.delays(), [KEEPALIVE_DELAYS_MS[2]]);

  h.fire();
  assert.equal(h.sent[3], KEEPALIVE_IDLE_COPY[2][1]);
  assert.deepEqual(h.delays(), [KEEPALIVE_DELAYS_MS[2]]);
});

test('touch 把档位与计时重置回首次 5 秒，之后重新按 15/30 秒推进', () => {
  const h = harness();
  h.keepalive.start();
  h.fire();
  h.fire();
  assert.deepEqual(h.delays(), [KEEPALIVE_DELAYS_MS[2]]);

  h.keepalive.touch();
  assert.deepEqual(h.delays(), [KEEPALIVE_DELAYS_MS[0]]);
  h.fire();
  assert.equal(h.sent[2], KEEPALIVE_IDLE_COPY[0][1], '触摸后从 5 秒档重新选择文案');
  assert.deepEqual(h.delays(), [KEEPALIVE_DELAYS_MS[1]]);
});

test('队列深度选择三类文案：排队带真实条数、单条、空闲按当前档位分组', () => {
  const h = harness({ depth: 7 });
  h.keepalive.start();
  h.fire();
  assert.equal(h.sent[0], rendered(KEEPALIVE_QUEUED_COPY[0], 7));
  assert.match(h.sent[0]!, /7 条/);

  h.setDepth(1);
  h.fire();
  assert.equal(h.sent[1], KEEPALIVE_SINGLE_COPY[0]);

  h.setDepth(0);
  h.fire();
  assert.equal(h.sent[2], KEEPALIVE_IDLE_COPY[2][0], '第三次触发处于 30 秒档');
});

test('队列变化后 touch：计时回到 5 秒，文案按最新深度与首个档位选择', () => {
  const h = harness({ depth: 0 });
  h.keepalive.start();
  h.fire();
  h.setDepth(2);
  h.keepalive.touch();
  assert.deepEqual(h.delays(), [KEEPALIVE_DELAYS_MS[0]]);
  h.fire();
  assert.equal(h.sent[1], rendered(KEEPALIVE_QUEUED_COPY[0], 2));

  h.setDepth(1);
  h.keepalive.touch();
  h.fire();
  assert.equal(h.sent[2], KEEPALIVE_SINGLE_COPY[0]);
});

test('同一轮内连续文案不重复，候选重复时换下一条并正常轮换', () => {
  const h = harness();
  h.keepalive.start();
  for (let index = 0; index < KEEPALIVE_IDLE_COPY[0].length + 3; index++) {
    h.keepalive.touch();
    h.fire();
  }
  for (let index = 1; index < h.sent.length; index++) assert.notEqual(h.sent[index], h.sent[index - 1]);
  assert.deepEqual(h.sent.slice(0, KEEPALIVE_IDLE_COPY[0].length), [...KEEPALIVE_IDLE_COPY[0]]);
  assert.equal(h.sent[KEEPALIVE_IDLE_COPY[0].length], KEEPALIVE_IDLE_COPY[0][0], '轮换从列表开头继续');
});

test('cancel 后不再发送，touch 也不能复活；valid=false 时静默取消', () => {
  const h = harness();
  h.keepalive.start();
  h.keepalive.cancel();
  assert.deepEqual(h.delays(), []);
  h.keepalive.touch();
  assert.deepEqual(h.delays(), []);
  assert.deepEqual(h.sent, []);

  let valid = true;
  const blocked = harness({ valid: () => valid });
  blocked.keepalive.start();
  valid = false;
  blocked.fire();
  assert.deepEqual(blocked.sent, []);
  assert.deepEqual(blocked.delays(), []);
});

test('发送同步抛错、返回 false 或异步失败都会取消后续推送', async () => {
  const throwing = harness({ send: () => { throw new Error('transport'); } });
  throwing.keepalive.start();
  throwing.fire();
  assert.deepEqual(throwing.delays(), []);

  const rejectedSync = harness({ send: () => false });
  rejectedSync.keepalive.start();
  rejectedSync.fire();
  assert.deepEqual(rejectedSync.delays(), []);

  const rejectedAsync = harness({ send: () => Promise.resolve(false) });
  rejectedAsync.keepalive.start();
  rejectedAsync.fire();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(rejectedAsync.delays(), []);

  const failedAsync = harness({ send: () => Promise.reject(new Error('transport')) });
  failedAsync.keepalive.start();
  failedAsync.fire();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(failedAsync.delays(), []);
});

test('文案表完整且为纯文本：逐类 ≥5 条、排队含条数占位、无 Markdown 星号与时间承诺', () => {
  assert.ok(KEEPALIVE_QUEUED_COPY.length >= 5);
  assert.ok(KEEPALIVE_SINGLE_COPY.length >= 5);
  assert.equal(KEEPALIVE_IDLE_COPY.length, 3);
  for (const group of KEEPALIVE_IDLE_COPY) assert.ok(group.length >= 5);
  for (const text of KEEPALIVE_QUEUED_COPY) assert.match(text, /\{count\}/);

  const all = [...KEEPALIVE_QUEUED_COPY, ...KEEPALIVE_SINGLE_COPY, ...KEEPALIVE_IDLE_COPY.flat()];
  for (const text of all) {
    assert.ok(!text.includes('*'), text);
    assert.ok(!/百分之|%|预计|剩余时间|马上好|分钟|秒后/.test(text), text);
  }
});
