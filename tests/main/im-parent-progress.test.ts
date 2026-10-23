import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatParentProgress, sanitizeProgressName, PROGRESS_LINE_MAX_CHARS, PROGRESS_THINKING_LINE, PROGRESS_TOOL_LINE } from '../../src/main/im/progress';
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

test('进度行只含固定斜体文案：工具/阶段不渲染动态名', () => {
  assert.equal(formatParentProgress({ kind: 'tool', name: 'shell' }), '*工具调用中……*');
  assert.equal(formatParentProgress({ kind: 'stage', name: '步骤1' }), '*深度思考中……*');
  assert.equal(formatParentProgress({ kind: 'tool', name: '' }), '*工具调用中……*');
  assert.equal(formatParentProgress({ kind: 'stage', name: '   ' }), '*深度思考中……*');
});

test('进度行不含绝对路径、凭据与控制字符，且单行受限', () => {
  const fromPath = formatParentProgress({ kind: 'tool', name: '/home/user/.config/secret-tool --password=hunter2' })!;
  assert.equal(fromPath, '*工具调用中……*');
  assert.ok(!fromPath.includes('/home'), fromPath);
  assert.ok(!fromPath.includes('hunter2'), fromPath);

  const token = formatParentProgress({ kind: 'tool', name: 'sk-1234567890abcdef' })!;
  assert.equal(token, '*工具调用中……*');
  assert.ok(!token.includes('sk-1234567890abcdef'), token);

  const long = formatParentProgress({ kind: 'stage', name: '规'.repeat(200) })!;
  assert.equal(long, '*深度思考中……*');
  assert.ok([...long].length <= PROGRESS_LINE_MAX_CHARS, String([...long].length));

  const marker = formatParentProgress({ kind: 'tool', name: '<weaver-actions>{"a":1}</weaver-actions>' })!;
  assert.equal(marker, '*工具调用中……*');
  assert.ok(!marker.includes('<'), marker);
  assert.ok(!marker.includes('>'), marker);

  assert.equal(formatParentProgress({ kind: 'delta' as never, name: 'x' } as never), undefined);
  assert.equal(sanitizeProgressName(undefined), '');
});

test('thinking 文本即使误入也只留固定文案：无换行透出', () => {
  const line = formatParentProgress({ kind: 'stage', name: 'SECRET_THINKING\nline2\nline3' })!;
  assert.equal(line, '*深度思考中……*');
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

test('dsh 对工具调用与开始事件产出进度，thinking/参数/结果与步骤号不进入进度', async () => {
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
    // 统一进度语义：只发 turn_start「开始」与顶层 tool_call；步骤号/执行 stage 不再出现。
    assert.deepEqual(progress, [
      { kind: 'stage', name: '开始' },
      { kind: 'tool', name: 'bash' },
    ]);
    assert.ok(!progress.some(event => event.kind === 'stage' && event.name !== '开始'), JSON.stringify(progress));
    // thinking 全文、工具参数、工具结果绝不进入进度事件。
    assert.ok(!JSON.stringify(progress).includes('SECRET'), JSON.stringify(progress));
    const lines = progress.map(event => formatParentProgress(event)!);
    assert.deepEqual(lines, [PROGRESS_THINKING_LINE, PROGRESS_TOOL_LINE]);
    assert.ok(lines.every(line => [...line].length <= PROGRESS_LINE_MAX_CHARS));
    assert.ok(!lines.join('\n').includes('SECRET_TOOL'));
    await session.close();
  } finally { await teardownDsh(harness); }
});

test('dsh 同一 callId 的重复 tool_call 只发一次进度', async () => {
  const harness = setupDsh('dup-tool');
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
    const progress: ParentProgressEvent[] = [];
    assert.equal(await session.send('第一轮', undefined, undefined, { onProgress: event => progress.push(event) }), '你好，世界');
    assert.deepEqual(progress, [
      { kind: 'stage', name: '开始' },
      { kind: 'tool', name: 'bash' },
      { kind: 'tool', name: 'read' },
    ]);
    assert.ok(!JSON.stringify(progress).includes('SECRET'), JSON.stringify(progress));
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

test('service 把 stage+工具批渲染为固定合并状态，最终收口只剩答案', async t => {
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
  const streamed = f.chunks.filter(chunk => !chunk.startsWith('[setContent]')).join('');
  assert.equal(streamed, '*深度思考中……*\n*工具调用中……*\n*调用结束*\n\n答案正文');
  assert.ok(!streamed.includes('shell'), JSON.stringify(f.chunks));
  assert.ok(!streamed.includes('开始'), JSON.stringify(f.chunks));
  assert.equal(f.chunks.at(-1), '[setContent]答案正文');
  assert.equal(f.cards.length, 1);
  const card = f.cards[0]!.card as { body: { elements: { content?: string }[] } };
  assert.equal(card.body.elements[0]?.content, '答案正文');
});

test('单个工具只输出一次工具调用中，不显示工具名', async t => {
  const parent: ParentAgentFactory = async () => ({
    send: async (_text, _signal, onDelta, options) => {
      options?.onProgress?.({ kind: 'tool', name: 'bash' });
      onDelta?.('正文');
      return '正文';
    },
    close: async () => {},
  });
  const { f } = await setup(t, parent);
  f.handlers.message(message('single-tool'));
  await tick();
  const streamed = f.chunks.filter(chunk => !chunk.startsWith('[setContent]')).join('');
  assert.equal(streamed, '*工具调用中……*\n*调用结束*\n\n正文');
  assert.ok(!streamed.includes('bash'), JSON.stringify(f.chunks));
  assert.equal(f.chunks.at(-1), '[setContent]正文');
});

test('连续5次工具：第3次实时追加继续努力且只一次，第4/5次不重复', async t => {
  let chunksRef: string[] = [];
  let gateRelease!: () => void;
  const gate = new Promise<void>(resolve => { gateRelease = resolve; });
  let enteredGate = false;
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  const streamed = () => chunksRef.filter(chunk => !chunk.startsWith('[setContent]')).join('');
  const settle = async () => { for (let i = 0; i < 60; i++) await new Promise<void>(r => setImmediate(r)); };
  const parent: ParentAgentFactory = async () => ({
    send: async (_text, _signal, onDelta, options) => {
      options?.onProgress?.({ kind: 'tool', name: 'a' });
      await settle();
      assert.equal(count(streamed(), '*工具调用中……*'), 1, `第1次后批次开始可见: ${JSON.stringify(chunksRef)}`);
      assert.equal(count(streamed(), '*继续努力中……*'), 0, `第1次后不应出现继续: ${JSON.stringify(chunksRef)}`);
      options?.onProgress?.({ kind: 'tool', name: 'b' });
      await settle();
      assert.equal(count(streamed(), '*继续努力中……*'), 0, `第2次后不应出现继续: ${JSON.stringify(chunksRef)}`);
      options?.onProgress?.({ kind: 'tool', name: 'c' });
      await settle();
      assert.equal(count(streamed(), '*继续努力中……*'), 1, `第3次已实时追加且仅一次: ${JSON.stringify(chunksRef)}`);
      options?.onProgress?.({ kind: 'tool', name: 'd' });
      await settle();
      assert.equal(count(streamed(), '*继续努力中……*'), 1, `第4次不重复: ${JSON.stringify(chunksRef)}`);
      // 正文到达前仍仅一次：延后输出不能让继续行重复。
      assert.equal(count(streamed(), '*继续努力中……*'), 1, `正文前继续行仍仅一次: ${JSON.stringify(chunksRef)}`);
      enteredGate = true;
      await gate;
      options?.onProgress?.({ kind: 'tool', name: 'e' });
      await settle();
      assert.equal(count(streamed(), '*继续努力中……*'), 1, `第5次不重复: ${JSON.stringify(chunksRef)}`);
      onDelta?.('完成');
      return '完成';
    },
    close: async () => {},
  });
  const { f } = await setup(t, parent);
  chunksRef = f.chunks;
  f.handlers.message(message('five-tools'));
  const gateDeadline = Date.now() + 8000;
  while (!enteredGate && Date.now() < gateDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(enteredGate, 'parent 未在正文前进入 gate：turn 应保持未结束以便实时断言');
  assert.equal(count(streamed(), '*继续努力中……*'), 1, `放行前真实 channel 已有且仅一次继续行: ${JSON.stringify(chunksRef)}`);
  assert.ok(!streamed().includes('完成'), '放行前正文不应到达');
  gateRelease();
  const endDeadline = Date.now() + 8000;
  while (!f.chunks.some(chunk => chunk.startsWith('[setContent]')) && Date.now() < endDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  await tick();
  const finalStreamed = f.chunks.filter(chunk => !chunk.startsWith('[setContent]')).join('');
  assert.equal(finalStreamed, '*工具调用中……*\n*继续努力中……*\n*调用结束*\n\n完成');
  assert.ok(!finalStreamed.includes('a'), JSON.stringify(f.chunks));
  assert.equal(f.chunks.at(-1), '[setContent]完成');
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

test('进度行有自身上限也不吞正文：100 个工具事件只显示一批开始/继续/结束', async t => {
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
  assert.equal(streamed.split('*工具调用中……*').length - 1, 1, streamed.slice(0, 400));
  assert.equal(streamed.split('*继续努力中……*').length - 1, 1, streamed.slice(0, 400));
  assert.equal(streamed.split('*调用结束*').length - 1, 1, streamed.slice(0, 400));
  assert.ok(!streamed.includes('tool-0'), streamed.slice(0, 400));
  assert.ok(!streamed.includes('⏺'), streamed.slice(0, 400));
  assert.equal(f.cards.length, 1);
  assert.equal(f.chunks.at(-1), '[setContent]完成');
});

test('无工具事件的引擎不产生进度行：忽略第 4 参数的旧会话行为不变', async t => {
  const parent: ParentAgentFactory = async () => ({
    send: async text => `答：${text}`,
    close: async () => {},
  });
  const { f } = await setup(t, parent);
  f.handlers.message(message('legacy'));
  await tick();
  assert.ok(!f.chunks.join('').includes('*工具调用中'), JSON.stringify(f.chunks));
  assert.ok(!f.chunks.join('').includes('*深度思考中'), JSON.stringify(f.chunks));
  assert.equal(f.cards.length, 1);
});

test('文字工具多批交替与跨 flush：正文原样有序、空行分段', async t => {
  let chunksRef: string[] = [];
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  let firstBatchOpen = false;
  const streamed = () => chunksRef.filter(chunk => !chunk.startsWith('[setContent]')).join('');
  const appends = () => chunksRef.filter(chunk => !chunk.startsWith('[setContent]'));
  const settle = async () => { for (let i = 0; i < 60; i++) await new Promise<void>(r => setImmediate(r)); };
  const parent: ParentAgentFactory = async () => ({
    send: async (_text, _signal, onDelta, options) => {
      onDelta?.('A');
      options?.onProgress?.({ kind: 'tool', name: 'bash' });
      await settle();
      firstBatchOpen = true;
      // 保持 turn 未结束，让测试体在放行前断言中间文本已实时可见。
      await secondGate;
      onDelta?.('B');
      options?.onProgress?.({ kind: 'tool', name: 'ls' });
      await settle();
      onDelta?.('C');
      return 'ABC';
    },
    close: async () => {},
  });
  const { f } = await setup(t, parent);
  chunksRef = f.chunks;
  f.handlers.message(message('alternate'));
  const openDeadline = Date.now() + 8000;
  while (!firstBatchOpen && Date.now() < openDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(firstBatchOpen, '第一批应在放行 B 前已进入 gate');
  // 中间文本已实时可见：仅统计 append（不含 setContent），且 A 与第一批状态已在 channel 中。
  assert.ok(appends().length >= 1, `第一批应已产生真实 append: ${JSON.stringify(chunksRef)}`);
  assert.ok(streamed().includes('A'), `A 应实时可见: ${JSON.stringify(chunksRef)}`);
  assert.ok(streamed().includes('*工具调用中……*'), `第一批开始应实时可见: ${JSON.stringify(chunksRef)}`);
  assert.ok(!streamed().includes('B') && !streamed().includes('C'), `放行前 B/C 不应到达: ${JSON.stringify(chunksRef)}`);
  releaseSecond();
  const endDeadline = Date.now() + 8000;
  while (!f.chunks.some(chunk => chunk.startsWith('[setContent]')) && Date.now() < endDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  await tick();
  assert.equal(streamed(), 'A\n\n*工具调用中……*\n*调用结束*\n\nB\n\n*工具调用中……*\n*调用结束*\n\nC');
  assert.ok(appends().length > 1, `交替批次应跨多个 append flush（仅统计 append，不含 setContent）: ${JSON.stringify(f.chunks)}`);
  assert.equal(f.chunks.at(-1), '[setContent]ABC');
  const card = f.cards[0]!.card as { body: { elements: { content?: string }[] } };
  assert.equal(card.body.elements[0]?.content, 'ABC');
});

test('轮末无后续文字时 end 关闭批次', async t => {
  const parent: ParentAgentFactory = async () => ({
    send: async (_text, _signal, onDelta, options) => {
      options?.onProgress?.({ kind: 'tool', name: 'bash' });
      return '答案';
    },
    close: async () => {},
  });
  const { f } = await setup(t, parent);
  f.handlers.message(message('end-close'));
  await tick();
  const streamed = f.chunks.filter(chunk => !chunk.startsWith('[setContent]')).join('');
  assert.equal(streamed, '*工具调用中……*\n*调用结束*\n');
  assert.equal(f.chunks.at(-1), '[setContent]答案');
  const card = f.cards[0]!.card as { body: { elements: { content?: string }[] } };
  assert.equal(card.body.elements[0]?.content, '答案');
});

test('隐藏控制标记被过滤且不假关闭仍打开批次、不泄漏', async t => {
  let chunksRef: string[] = [];
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  const streamed = () => chunksRef.filter(chunk => !chunk.startsWith('[setContent]')).join('');
  const settle = async () => { for (let i = 0; i < 60; i++) await new Promise<void>(r => setImmediate(r)); };
  const parent: ParentAgentFactory = async () => ({
    send: async (_text, _signal, onDelta, options) => {
      // 保持工具批开放：先第 1 个工具，再喂拆分隐藏 marker 与空 delta，
      // 它们都不应关闭仍打开的批次；随后第 2/3 个工具仍属同一批。
      options?.onProgress?.({ kind: 'tool', name: 'bash' });
      await settle();
      assert.equal(count(streamed(), '*工具调用中……*'), 1, `首工具批开始实时可见: ${JSON.stringify(chunksRef)}`);
      assert.equal(count(streamed(), '*调用结束*'), 0, `批次仍打开时不应有关闭行: ${JSON.stringify(chunksRef)}`);
      // Split control marker: the filter holds back the partial suffix (visible '')
      // and hides the completed marker tail (visible ''); neither may close the
      // still-open batch nor leak protocol text.
      onDelta?.('<weaver-act');
      await settle();
      assert.equal(count(streamed(), '*调用结束*'), 0, `拆分 marker 前半不应关闭仍打开批次: ${JSON.stringify(chunksRef)}`);
      onDelta?.('ions>{"actions":[{"label":"继续","message":"SECRET_NEXT"}]}</weaver-actions>');
      await settle();
      assert.equal(count(streamed(), '*调用结束*'), 0, `隐藏 marker 整体不应关闭仍打开批次: ${JSON.stringify(chunksRef)}`);
      assert.ok(!streamed().includes('weaver-actions'), JSON.stringify(chunksRef));
      assert.ok(!streamed().includes('SECRET_NEXT'), JSON.stringify(chunksRef));
      onDelta?.('');
      await settle();
      assert.equal(count(streamed(), '*调用结束*'), 0, `空 delta 不应关闭仍打开批次: ${JSON.stringify(chunksRef)}`);
      options?.onProgress?.({ kind: 'tool', name: 'ls' });
      await settle();
      assert.equal(count(streamed(), '*工具调用中……*'), 1, `同批第 2 个工具不重复开始行: ${JSON.stringify(chunksRef)}`);
      assert.equal(count(streamed(), '*调用结束*'), 0, `同批继续期间不应提前关闭: ${JSON.stringify(chunksRef)}`);
      options?.onProgress?.({ kind: 'tool', name: 'wc' });
      await settle();
      assert.equal(count(streamed(), '*继续努力中……*'), 1, `同批第 3 个工具实时追加继续且仅一次: ${JSON.stringify(chunksRef)}`);
      assert.equal(count(streamed(), '*工具调用中……*'), 1, `同批开始行仍仅一次: ${JSON.stringify(chunksRef)}`);
      // 注意：PublicDeltaFilter 一旦见隐藏 marker 即永久隐藏后续增量（控制数据不进流），
      // 因此公开正文不再经 onDelta，而经返回值收口；仍打开的批次由轮末 end 关闭。
      return '公开一';
    },
    close: async () => {},
  });
  const { f } = await setup(t, parent);
  chunksRef = f.chunks;
  f.handlers.message(message('hidden-marker'));
  const endDeadline = Date.now() + 8000;
  while (!f.chunks.some(chunk => chunk.startsWith('[setContent]')) && Date.now() < endDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  await tick();
  assert.equal(streamed(), '*工具调用中……*\n*继续努力中……*\n*调用结束*\n');
  assert.equal(count(streamed(), '*调用结束*'), 1, '轮末应恰好一次结束行');
  assert.ok(!streamed().includes('weaver-actions'), JSON.stringify(f.chunks));
  assert.ok(!streamed().includes('SECRET_NEXT'), JSON.stringify(f.chunks));
  assert.equal(f.chunks.at(-1), '[setContent]公开一');
  const hiddenCard = f.cards[0]!.card as { body: { elements: { content?: string }[] } };
  assert.equal(hiddenCard.body.elements[0]?.content, '公开一');
});

test('正文工具交替：正文块不以换行结尾时用空行分段', async t => {
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
  assert.equal(streamed, '第一段文字\n\n*工具调用中……*\n*调用结束*\n\n第二段文字');
  assert.ok(!streamed.includes('第一段文字*'), JSON.stringify(f.chunks));
  assert.equal(f.chunks.at(-1), '[setContent]第一段文字第二段文字');
});

test('正文已换行结尾时不重复补空行、不出现三连换行', async t => {
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
  assert.equal(streamed, '第一段文字\n\n*工具调用中……*\n*调用结束*\n\n第二段文字');
  assert.ok(!streamed.includes('\n\n\n'), JSON.stringify(f.chunks));
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
  assert.ok(!f.chunks.join('').includes('*工具调用中'));
  assert.ok(!f.chunks.join('').includes('中止后文字'));
});
