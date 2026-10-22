import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicTextBoundary } from '../../src/main/im/public-text';
import { prepareParentAgentInput, type ParentProcessLauncher } from '../../src/main/im/parent-agent';
import { startClaudeParentSession } from '../../src/main/im/parent-claude';
import { startCodexParentSession } from '../../src/main/im/parent-codex';
import { startPiParentSession } from '../../src/main/im/parent-pi';

// ---------- helper 单元回归 ----------

test('public-text: 同一段内 token 原样连接，Markdown/中文/代码分片不变', () => {
  const boundary = new PublicTextBoundary();
  assert.equal(boundary.format('**加'), '**加');
  assert.equal(boundary.format('粗**'), '粗**');
  assert.equal(boundary.format('你好，'), '你好，');
  assert.equal(boundary.format('世界'), '世界');
  assert.equal(boundary.format('`code'), '`code');
  assert.equal(boundary.format('()`'), '()`');
});

test('public-text: 前段尾换行跨 chunk 累计，不因分片多加空行', () => {
  // 前段尾部 LF 被拆到前后两个 chunk：已有 2 个 LF，不再补。
  const split = new PublicTextBoundary();
  const head = split.format('第一段\n') + split.format('\n');
  split.noteBoundary();
  assert.equal(head + split.format('第二段'), '第一段\n\n第二段');
  // 同一语义合并切分对照。
  const merged = new PublicTextBoundary();
  const mergedHead = merged.format('第一段\n\n');
  merged.noteBoundary();
  assert.equal(mergedHead + merged.format('第二段'), '第一段\n\n第二段');
});

test('public-text: 边界后单个 LF 独占 chunk 时不超额分隔', () => {
  // 新段首个 LF 独占一个 chunk，下个 chunk 又以前导 LF 开头：共 2 个 LF。
  const split = new PublicTextBoundary();
  const head = split.format('第一段');
  split.noteBoundary();
  assert.equal(head + split.format('\n') + split.format('\n第二段'), '第一段\n\n第二段');
  // 同一语义合并切分对照。
  const merged = new PublicTextBoundary();
  const mergedHead = merged.format('第一段');
  merged.noteBoundary();
  assert.equal(mergedHead + merged.format('\n\n第二段'), '第一段\n\n第二段');
});

test('public-text: 新段落补空一行，已有换行不叠加，首段无前导空行', () => {
  const boundary = new PublicTextBoundary();
  assert.equal(boundary.format('前段'), '前段');
  boundary.noteBoundary();
  assert.equal(boundary.format('后段'), '\n\n后段');
  // 已有单个换行只补一个
  const second = new PublicTextBoundary();
  assert.equal(second.format('第一段\n'), '第一段\n');
  second.noteBoundary();
  assert.equal(second.format('第二段'), '\n第二段');
  // 已有空行不再膨胀
  const third = new PublicTextBoundary();
  assert.equal(third.format('第一段\n\n'), '第一段\n\n');
  third.noteBoundary();
  assert.equal(third.format('第二段'), '第二段');
  // 首段 noteBoundary 无效果
  const fresh = new PublicTextBoundary();
  fresh.noteBoundary();
  assert.equal(fresh.format('首段'), '首段');
});

test('public-text: 空/过滤段不造空段，新实例不跨回合泄漏', () => {
  const boundary = new PublicTextBoundary();
  assert.equal(boundary.format('前段'), '前段');
  boundary.noteBoundary();
  assert.equal(boundary.format(''), '');
  // 空串不消耗挂起边界：下一个真实段落仍只得到一个空行
  assert.equal(boundary.format('后段'), '\n\n后段');
  // 新回合使用新实例：不泄漏前轮文字、无首段空行
  const next = new PublicTextBoundary();
  next.noteBoundary();
  assert.equal(next.format('新回合'), '新回合');
});

// ---------- 合成协议帧回归：最小内存 fake 进程 ----------

interface FakeScope extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { destroyed: boolean; write: (data: string) => boolean; end: () => void };
  kill: (signal?: string) => boolean;
}

function fakeScope(onFrame: (frame: Record<string, unknown>, scope: FakeScope) => void): { scope: FakeScope; emit: (frame: unknown) => void } {
  const scope = new EventEmitter() as FakeScope;
  scope.stdout = new EventEmitter();
  scope.stderr = new EventEmitter();
  let closed = false;
  const doClose = () => { if (!closed) { closed = true; scope.emit('close'); } };
  const emit = (frame: unknown) => scope.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));
  (scope as { stdin: unknown }).stdin = {
    destroyed: false,
    write: (data: string) => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) continue;
        onFrame(JSON.parse(line) as Record<string, unknown>, scope);
      }
      return true;
    },
    end: () => { doClose(); },
  };
  scope.kill = () => { setTimeout(doClose, 0); return true; };
  return { scope, emit };
}

function withDummyPath(names: string[]): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-im-format-'));
  for (const name of names) {
    writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    chmodSync(join(dir, name), 0o755);
  }
  const previous = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${previous}`;
  return () => { process.env.PATH = previous; rmSync(dir, { recursive: true, force: true }); };
}

function workspace(): { root: string; ws: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'weaver-im-format-ws-'));
  const ws = join(root, 'ws');
  mkdirSync(ws);
  return { root, ws, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const WAITS = { startupMs: 3000, turnMs: 3000, closeMs: 500 };

// Claude 真实协议帧：同一用户请求内两个 assistant 消息之间有段落分隔，
// 同一消息内分片原样连接；第二轮发送不泄漏前轮文字、无首段空行。
test('claude 合成帧：两个公开 assistant 消息之间补空行，连续 delta 不变', async () => {
  const restore = withDummyPath(['claude']);
  const { ws, cleanup } = workspace();
  try {
    let captured: { scope: FakeScope; emit: (frame: unknown) => void } | undefined;
    const launch: ParentProcessLauncher = () => {
      const fake = fakeScope((frame, scope) => {
        if (frame.type === 'control_request' && (frame.request as Record<string, unknown>)?.subtype === 'initialize') {
          setTimeout(() => fake.emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { claude_code_version: '2.1.304' } } }), 0);
          return;
        }
        if (frame.type === 'user' && typeof frame.uuid === 'string') {
          const uuid = frame.uuid as string;
          const turn = (fake as unknown as { n?: number }).n = ((fake as unknown as { n?: number }).n ?? 0) + 1;
          setTimeout(() => {
            if (turn === 1) {
              fake.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1' } } });
              fake.emit({ type: 'stream_event', api_message_id: 'msg-1', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '前' } } });
              // 非文本 delta 必须被过滤且不影响边界
              fake.emit({ type: 'stream_event', api_message_id: 'msg-1', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'SECRET' } } });
              fake.emit({ type: 'stream_event', api_message_id: 'msg-1', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '段' } } });
              fake.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-2' } } });
              fake.emit({ type: 'stream_event', api_message_id: 'msg-2', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '后段' } } });
              fake.emit({ type: 'result', subtype: 'success', is_error: false, result: '前段后段', user_message_uuid: uuid, user_message_uuids: [uuid] });
            } else {
              fake.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-3' } } });
              fake.emit({ type: 'stream_event', api_message_id: 'msg-3', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '第三段' } } });
              fake.emit({ type: 'result', subtype: 'success', is_error: false, result: '第三段', user_message_uuid: uuid, user_message_uuids: [uuid] });
            }
          }, 5);
        }
      });
      captured = fake;
      return fake.scope as unknown as ReturnType<ParentProcessLauncher>;
    };
    const prepared = prepareParentAgentInput({ engineKind: 'claude', model: 'fixture-model', effort: 'high', workspace: ws, instructions: 'test' });
    const session = await startClaudeParentSession(prepared, { ...WAITS, launch });
    assert.ok(captured);
    try {
      const deltas: string[] = [];
      const final = await session.send('问题', undefined, chunk => deltas.push(chunk));
      assert.deepEqual(deltas, ['前', '段', '\n\n后段']);
      assert.equal(deltas.join(''), '前段\n\n后段');
      // 流式排版不改变最终正文语义：原生 result 原样返回
      assert.equal(final, '前段后段');
      const nextDeltas: string[] = [];
      assert.equal(await session.send('继续', undefined, chunk => nextDeltas.push(chunk)), '第三段');
      assert.deepEqual(nextDeltas, ['第三段']);
    } finally {
      await session.close();
    }
  } finally {
    cleanup();
    restore();
  }
});

// Codex 真实协议帧：不同 item 的 delta 之间补空行，同一 item 内分片连续。
test('codex 合成帧：item 切换补空行，同一 item 分片不变', async () => {
  const restore = withDummyPath(['codex']);
  const { ws, cleanup } = workspace();
  try {
    const launch: ParentProcessLauncher = () => {
      const fake = fakeScope(frame => {
        if (frame.id !== undefined && typeof frame.method === 'string') {
          if (frame.method === 'initialize') {
            setTimeout(() => fake.emit({ id: frame.id, result: { userAgent: 'weaver-test/0.163.0' } }), 0);
            return;
          }
          if (frame.method === 'thread/start') {
            setTimeout(() => fake.emit({ id: frame.id, result: { thread: { id: 'thr-1' } } }), 0);
            return;
          }
          if (frame.method === 'turn/start') {
            setTimeout(() => {
              fake.emit({ id: frame.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
              fake.emit({ method: 'turn/started', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
              fake.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', turnId: 'turn-1', itemId: 'it-1', delta: '前' } });
              fake.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', turnId: 'turn-1', itemId: 'it-1', delta: '段' } });
              fake.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thr-1', turnId: 'turn-1', itemId: 'it-2', delta: '后段' } });
              fake.emit({ method: 'item/completed', params: { threadId: 'thr-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'it-2', text: '前段后段', phase: 'final_answer' } } });
              fake.emit({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
            }, 5);
          }
        }
      });
      return fake.scope as unknown as ReturnType<ParentProcessLauncher>;
    };
    const prepared = prepareParentAgentInput({ engineKind: 'codex', model: 'fixture-model', effort: 'high', workspace: ws, instructions: 'test' });
    const session = await startCodexParentSession(prepared, { ...WAITS, launch });
    try {
      const deltas: string[] = [];
      const final = await session.send('问题', undefined, chunk => deltas.push(chunk));
      assert.deepEqual(deltas, ['前', '段', '\n\n后段']);
      assert.equal(final, '前段后段');
    } finally {
      await session.close();
    }
  } finally {
    cleanup();
    restore();
  }
});

// Pi 真实协议帧：已完成的 assistant 消息之后的新文本补空行；失败尝试不断开续写。
test('pi 合成帧：message_end 后的新文本补空行', async () => {
  const restore = withDummyPath(['pi']);
  const { ws, cleanup } = workspace();
  try {
    const launch: ParentProcessLauncher = () => {
      const fake = fakeScope(frame => {
        if (frame.type === 'get_state') {
          setTimeout(() => fake.emit({ id: frame.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-s1', model: { id: 'fixture-model', provider: 'fixture' }, thinkingLevel: 'medium' } }), 0);
          return;
        }
        if (frame.type === 'prompt') {
          setTimeout(() => {
            fake.emit({ id: frame.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
            fake.emit({ type: 'agent_start' });
            fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '第一' } });
            fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '段' } });
            fake.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '第一段' }], stopReason: 'stop' } });
            fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '第二' } });
            fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '段' } });
            fake.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '第二段' }], stopReason: 'stop' } });
            fake.emit({ type: 'agent_settled', aborted: false });
          }, 5);
        }
      });
      return fake.scope as unknown as ReturnType<ParentProcessLauncher>;
    };
    const prepared = prepareParentAgentInput({ engineKind: 'pi', model: 'fixture-model', effort: 'medium', workspace: ws, instructions: 'test' });
    const session = await startPiParentSession(prepared, { ...WAITS, launch });
    try {
      const deltas: string[] = [];
      const final = await session.send('问题', undefined, chunk => deltas.push(chunk));
      assert.deepEqual(deltas, ['第一', '段', '\n\n第二', '段']);
      // 最终正文仍由原生 message_end 决定，不把中间进度冒充最终答案
      assert.equal(final, '第二段');
    } finally {
      await session.close();
    }
  } finally {
    cleanup();
    restore();
  }
});
