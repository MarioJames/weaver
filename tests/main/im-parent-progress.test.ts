import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatParentProgress, sanitizeProgressName, PROGRESS_LINE_MAX_CHARS } from '../../src/main/im/progress';
import {
  ConfirmedParentCancellation,
  createParentAgent,
  type ParentAgentFactory,
  type ParentAgentSession,
  type ParentProgressEvent,
} from '../../src/main/im/parent-agent';
import { ImService } from '../../src/main/im/service';
import type { ImChannelFactory, ImChannelHandlers } from '../../src/main/im/channel';
import type { PolicySnapshot } from '../../src/shared/contracts/policy';
import type { NormalizedMessage } from '@larksuite/channel';

const DSH_FIXTURE = new URL('../fixtures/parent/dsh-fixture.mjs', import.meta.url).pathname;

// ---------- Part 1: 进度行清洗单元测试 ----------

test('进度行只含短标签：工具名/阶段名正常渲染', () => {
  assert.equal(formatParentProgress({ kind: 'tool', name: 'shell' }), '⏺ 调用工具：shell');
  assert.equal(formatParentProgress({ kind: 'stage', name: '步骤1' }), '⏺ 阶段：步骤1');
});

test('进度行不含绝对路径、凭据与控制字符，且单行受限', () => {
  const fromPath = formatParentProgress({ kind: 'tool', name: '/home/user/.config/secret-tool --password=hunter2' })!;
  assert.ok(!fromPath.includes('/home'), fromPath);
  assert.ok(!fromPath.includes('hunter2'), fromPath);
  assert.ok(!fromPath.includes('password=hunter2'), fromPath);

  const token = formatParentProgress({ kind: 'tool', name: 'sk-1234567890abcdef' })!;
  assert.ok(!token.includes('sk-1234567890abcdef'), token);

  const long = formatParentProgress({ kind: 'stage', name: '规'.repeat(200) })!;
  assert.ok([...long].length <= PROGRESS_LINE_MAX_CHARS, String([...long].length));

  const marker = formatParentProgress({ kind: 'tool', name: '<weaver-actions>{"a":1}</weaver-actions>' })!;
  assert.ok(!marker.includes('<'), marker);
  assert.ok(!marker.includes('>'), marker);

  assert.equal(formatParentProgress({ kind: 'tool', name: '' }), undefined);
  assert.equal(formatParentProgress({ kind: 'tool', name: '   ' }), undefined);
  assert.equal(sanitizeProgressName(undefined), '');
});

test('thinking 文本即使误入也只留短标签形态：长文本被截断、无换行透出', () => {
  const line = formatParentProgress({ kind: 'stage', name: 'SECRET_THINKING\nline2\nline3' })!;
  assert.ok(!line.includes('SECRET_THINKING\nline2'), line);
  assert.ok([...line].length <= PROGRESS_LINE_MAX_CHARS, line);
});

// ---------- Part 2: dsh 适配器发出工具/阶段进度 ----------

const dshSessions = new Set<ParentAgentSession>();

function setupDsh(scenario: string) {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'weaver-im-progress-dsh-'));
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  copyFileSync(DSH_FIXTURE, join(dir, 'dsh'));
  chmodSync(join(dir, 'dsh'), 0o755);
  const previousPath = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.DSH_FIXTURE_SCENARIO = scenario;
  process.env.DSH_FIXTURE_MARKER = join(dir, 'marker.ndjson');
  return { dir, workspace, previousPath };
}

async function teardownDsh(harness: { dir: string; previousPath: string }) {
  for (const session of dshSessions) await session.close().catch(() => {});
  dshSessions.clear();
  process.env.PATH = harness.previousPath;
  for (const key of ['DSH_FIXTURE_SCENARIO', 'DSH_FIXTURE_MARKER']) delete process.env[key];
  rmSync(harness.dir, { recursive: true, force: true });
}

test('dsh 对工具调用与阶段事件产出进度，thinking/参数/结果不进入进度', async () => {
  const harness = setupDsh('default');
  try {
    const { spawn } = await import('node:child_process');
    const session = await createParentAgent({
      engineKind: 'dsh',
      model: 'deepseek-flash',
      effort: 'high',
      workspace: harness.workspace,
      instructions: 'progress fixture only',
    }, {
      launch: (command, cwd, extra) => spawn(command[0], command.slice(1), {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extra },
      }),
      startupMs: 3000, turnMs: 5000, closeMs: 1000,
    });
    dshSessions.add(session);
    const deltas: string[] = [];
    const progress: ParentProgressEvent[] = [];
    const final = await session.send('第一轮', undefined, chunk => deltas.push(chunk), { onProgress: event => progress.push(event) });
    assert.equal(final, '你好，世界');
    assert.deepEqual(deltas, ['你好，', '世界']);
    assert.deepEqual(progress, [
      { kind: 'stage', name: '开始' },
      { kind: 'stage', name: '步骤1' },
      { kind: 'tool', name: 'bash' },
    ]);
    // thinking 全文、工具参数、工具结果绝不进入进度事件。
    assert.ok(!JSON.stringify(progress).includes('SECRET'), JSON.stringify(progress));
    const lines = progress.map(event => formatParentProgress(event)!);
    assert.ok(lines.every(line => [...line].length <= PROGRESS_LINE_MAX_CHARS));
    assert.ok(lines.join('\n').includes('⏺ 调用工具：bash'));
    assert.ok(!lines.join('\n').includes('SECRET_TOOL'));
    await session.close();
  } finally { await teardownDsh(harness); }
});

test('不提供 onProgress 的 dsh 会话行为与改动前一致：只有文字增量', async () => {
  const harness = setupDsh('default');
  try {
    const { spawn } = await import('node:child_process');
    const session = await createParentAgent({
      engineKind: 'dsh',
      model: 'deepseek-flash',
      effort: 'high',
      workspace: harness.workspace,
      instructions: 'progress fixture only',
    }, {
      launch: (command, cwd, extra) => spawn(command[0], command.slice(1), {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extra },
      }),
      startupMs: 3000, turnMs: 5000, closeMs: 1000,
    });
    dshSessions.add(session);
    const deltas: string[] = [];
    assert.equal(await session.send('第一轮', undefined, chunk => deltas.push(chunk)), '你好，世界');
    assert.deepEqual(deltas, ['你好，', '世界']);
    await session.close();
  } finally { await teardownDsh(harness); }
});

// ---------- Part 3: service 渲染、限额隔离、上限与中止清理 ----------

const ROOT = await mkdtemp(join(tmpdir(), 'weaver-im-progress-'));
test.after(async () => { await rm(ROOT, { recursive: true, force: true }); });
const tick = async () => { for (let n = 0; n < 24; n++) await new Promise<void>(r => setImmediate(r)); };

function policy(): PolicySnapshot {
  return {
    revision: 0,
    config: {
      version: 1,
      engines: { codex: { enabled: true, kind: 'codex' } },
      owners: { main: { enabled: true, engine: 'codex', model: 'gpt-test', effort: 'medium', workers: [], max_parallel: 1 } },
      workers: {}, herdr: { max_wait_minutes: 30 },
    },
    blocks: [], activeBlocks: [], owners: {}, workers: {}, execution: 'disabled',
  };
}

function fixture(parent?: ParentAgentFactory) {
  let handlers!: ImChannelHandlers;
  const chunks: string[] = [];
  const cards: { id: string; card: unknown }[] = [];
  const notices: string[] = [];
  let seq = 0;
  const factory: ImChannelFactory = (_c, h) => {
    handlers = h;
    return {
      connect: async () => {},
      close: async () => {},
      state: () => 'connected',
      send: async (_to, text) => { notices.push(text); },
      retireCard: async () => {},
      stream: async (_to, producer, delivery) => {
        const id = `om_bot${++seq}`;
        await producer({
          messageId: id,
          append: async text => { assert.ok(delivery.valid()); chunks.push(text); },
          setContent: async text => { chunks.push(`[setContent]${text}`); },
        });
        return id;
      },
      updateCard: async (id, card, delivery) => { assert.ok(delivery.valid()); cards.push({ id, card }); },
    };
  };
  return { factory, get handlers() { return handlers; }, chunks, cards, notices };
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

async function setup(t: any, parent: ParentAgentFactory) {
  const dir = await mkdtemp(join(ROOT, 'service-'));
  const f = fixture(parent);
  const service = new ImService({ dataDir: dir, policy, parentFactory: parent, channelFactory: f.factory });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const config = {
    enabled: true, appId: 'cli_test', appSecret: 'CANARY_SECRET', allowedOpenIds: ['ou_a'],
    engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 1,
  };
  await service.save({ expectedRevision: 0, config });
  await tick();
  return { f, service, config };
}

test('service 把 dsh 进度渲染为简短进度行，最终收口只剩答案', async t => {
  const parent: ParentAgentFactory = async () => ({
    send: async (_text, _signal, onDelta, options) => {
      options?.onProgress?.({ kind: 'stage', name: '开始' });
      options?.onProgress?.({ kind: 'tool', name: 'shell' });
      onDelta?.('答案正文');
      return '答案正文';
    },
    close: async () => {},
  });
  const { f } = await setup(t, parent);
  f.handlers.message(message('progress'));
  await tick();
  assert.ok(f.chunks.some(chunk => chunk.includes('⏺ 阶段：开始')), JSON.stringify(f.chunks));
  assert.ok(f.chunks.some(chunk => chunk.includes('⏺ 调用工具：shell')), JSON.stringify(f.chunks));
  assert.equal(f.chunks.at(-1), '[setContent]答案正文');
  assert.equal(f.cards.length, 1);
});

test('进度行不计入答案 REPLY_BYTES：19900 字节答案+进度照常成功，21000 字节答案仍被限', async t => {
  const sized = (n: number, ch: string): ParentAgentFactory => async () => ({
    send: async (_text, _signal, onDelta, options) => {
      options?.onProgress?.({ kind: 'tool', name: 'shell' });
      const answer = ch.repeat(n);
      onDelta?.(answer);
      return answer;
    },
    close: async () => {},
  });
  const ok = await setup(t, sized(19900, 'a'));
  ok.f.handlers.message(message('fits'));
  await tick();
  assert.equal(ok.f.cards.length, 1, '带进度行的 19900 字节答案不应触发 IM_REPLY_LIMIT');

  const over = await setup(t, sized(21000, 'b'));
  over.f.handlers.message(message('over'));
  await tick();
  assert.equal(over.f.cards.length, 0, '21000 字节答案仍应触发 IM_REPLY_LIMIT');
  assert.ok(over.f.notices.some(text => text.includes('本轮回复失败')), JSON.stringify(over.f.notices));
});

test('进度行有自身上限：100 个进度事件也不让卡片内容超过 30000 字符', async t => {
  const parent: ParentAgentFactory = async () => ({
    send: async (_text, _signal, onDelta, options) => {
      for (let i = 0; i < 100; i++) options?.onProgress?.({ kind: 'tool', name: `tool-${i}-` + 'x'.repeat(60) });
      onDelta?.('完成');
      return '完成';
    },
    close: async () => {},
  });
  const { f } = await setup(t, parent);
  f.handlers.message(message('caps'));
  await tick();
  const streamed = f.chunks.join('');
  assert.ok(streamed.length < 30000, String(streamed.length));
  assert.ok(streamed.split('⏺').length - 1 <= 20, streamed.slice(0, 400));
  assert.equal(f.cards.length, 1);
});

test('无工具事件的引擎不产生进度行：忽略第 4 参数的旧会话行为不变', async t => {
  const parent: ParentAgentFactory = async () => ({
    send: async text => `答：${text}`,
    close: async () => {},
  });
  const { f } = await setup(t, parent);
  f.handlers.message(message('legacy'));
  await tick();
  assert.ok(!f.chunks.join('').includes('⏺'), JSON.stringify(f.chunks));
  assert.equal(f.cards.length, 1);
});

test('进度行独占一行：正文块不以换行结尾时自动补换行', async t => {
  const parent: ParentAgentFactory = async () => ({
    send: async (_text, _signal, onDelta, options) => {
      onDelta?.('第一段文字');
      options?.onProgress?.({ kind: 'tool', name: 'bash' });
      onDelta?.('第二段文字');
      return '第一段文字第二段文字';
    },
    close: async () => {},
  });
  const { f } = await setup(t, parent);
  f.handlers.message(message('multistep'));
  await tick();
  const streamed = f.chunks.filter(chunk => !chunk.startsWith('[setContent]')).join('');
  assert.ok(streamed.includes('第一段文字\n⏺ 调用工具：bash\n'), JSON.stringify(f.chunks));
  assert.ok(!streamed.includes('第一段文字⏺'), JSON.stringify(f.chunks));
  assert.equal(f.chunks.at(-1), '[setContent]第一段文字第二段文字');
});

test('进度行独占一行：正文已换行结尾时不重复补空行', async t => {
  const parent: ParentAgentFactory = async () => ({
    send: async (_text, _signal, onDelta, options) => {
      onDelta?.('第一段文字\n');
      options?.onProgress?.({ kind: 'tool', name: 'bash' });
      onDelta?.('第二段文字');
      return '第一段文字\n第二段文字';
    },
    close: async () => {},
  });
  const { f } = await setup(t, parent);
  f.handlers.message(message('multistep-nl'));
  await tick();
  const streamed = f.chunks.filter(chunk => !chunk.startsWith('[setContent]')).join('');
  assert.ok(streamed.includes('第一段文字\n⏺ 调用工具：bash\n'), JSON.stringify(f.chunks));
  assert.ok(!streamed.includes('\n\n⏺'), JSON.stringify(f.chunks));
});

test('stop 中止后进度回调与增量不再进入流式卡片', async t => {
  let captured: { onDelta?: (chunk: string) => void; onProgress?: (event: ParentProgressEvent) => void } = {};
  const parent: ParentAgentFactory = async () => ({
    send: (_text, signal, onDelta, options) => new Promise<string>((_resolve, reject) => {
      captured = { onDelta, onProgress: options?.onProgress };
      signal?.addEventListener('abort', () => reject(new ConfirmedParentCancellation()), { once: true });
    }),
    close: async () => {},
  });
  const { f, config } = await setup(t, parent);
  f.handlers.message(message('abortme'));
  await tick();
  assert.deepEqual(f.chunks, [], '中止前假 parent 不应输出');
  f.handlers.menu({
    app_id: config.appId, event_id: 'stop-1', event_key: 'stop',
    create_time: String(Date.now()), operator: { operator_id: { open_id: 'ou_a' } },
  });
  await tick();
  const before = f.chunks.length;
  captured.onProgress?.({ kind: 'tool', name: 'shell' });
  captured.onDelta?.('中止后文字');
  await tick();
  assert.equal(f.chunks.length, before, '中止后进度与增量都不应再 append');
  assert.ok(!f.chunks.join('').includes('⏺'));
});
