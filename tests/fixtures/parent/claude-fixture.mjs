#!/usr/bin/env node
// Claude Code CLI protocol fixture for adapter tests. Speaks the headless stream-json
// framing of Claude Code 2.1.304 (system init, stream_event deltas, result with
// user_message_uuid attribution, control_request/control_response) without contacting a
// model. Scenario selection: CLAUDE_FIXTURE_SCENARIO.
import { appendFileSync, writeFileSync } from 'node:fs';

const scenario = process.env.CLAUDE_FIXTURE_SCENARIO || 'default';
const marker = process.env.CLAUDE_FIXTURE_MARKER;
const snapshot = process.env.CLAUDE_FIXTURE_SNAPSHOT;
const sessionId = process.argv[process.argv.indexOf('--session-id') + 1];

const emit = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (snapshot) writeFileSync(snapshot, JSON.stringify({ argv: process.argv, env: Object.fromEntries(['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'HERDR_TOKEN', 'WEAVER_TASK_ID', 'WEAVER_WORKER_ID'].filter(key => key in process.env).map(key => [key, process.env[key]])), hasHome: !!process.env.HOME }), { mode: 0o600 });

if (marker) appendFileSync(marker, `${JSON.stringify({ spawnPid: process.pid })}\n`, { mode: 0o600 });

let messageCounter = 0;
const messageStart = uuid => emit({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: `msg-${uuid}` } } });

function streamDelta(text, extraSession, apiMessageId = `msg-${currentUuid}`) {
  emit({
    type: 'stream_event',
    api_message_id: apiMessageId,
    ...(extraSession ? { session_id: extraSession } : { session_id: sessionId }),
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  });
}

function streamTool(id, name, { parent = null, input = {}, extra = {} } = {}) {
  emit({
    type: 'stream_event',
    api_message_id: `msg-${currentUuid}`,
    session_id: sessionId,
    parent_tool_use_id: parent,
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id, name, input, ...extra },
    },
  });
}

function streamToolInput(partial, parent = null) {
  emit({
    type: 'stream_event',
    api_message_id: `msg-${currentUuid}`,
    session_id: sessionId,
    parent_tool_use_id: parent,
    event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partial } },
  });
}

function streamToolStop() {
  emit({
    type: 'stream_event',
    api_message_id: `msg-${currentUuid}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', index: 1 },
  });
}

function noisyStreamEvents() {
  emit({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'SECRET_THINKING' } } });
  emit({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"SECRET_TOOL_JSON":1}' } } });
  emit({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: 'subagent-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SECRET_SUBAGENT' } } });
}

function result(uuid, overrides = {}) {
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'FINAL',
    session_id: sessionId,
    duration_ms: 10,
    num_turns: 1,
    user_message_uuid: uuid,
    user_message_uuids: [uuid],
    ...overrides,
  });
}

async function runTurn(uuid, current) {
  messageStart(uuid);
  const key = `${scenario}:${current}`;
  switch (key) {
    case 'background:1': {
      streamDelta('开始 ');
      await sleep(40);
      // A result that belongs to some other producer must not release the send.
      result('bg-not-mine', { result: 'BACKGROUND' });
      await sleep(150);
      streamDelta('继续 ');
      result(uuid, { result: '最终回答' });
      return;
    }
    case 'progress:1': {
      streamTool('toolu-progress-1', 'Bash', { input: { command: 'cat /home/user/SECRET_COMMAND' } });
      // Same native call id repeated: the adapter must not report it twice.
      streamTool('toolu-progress-1', 'Bash', { input: { command: 'duplicate SECRET_COMMAND' } });
      // Nested subagent tool: parent_tool_use_id is set, so no progress may be emitted.
      streamTool('toolu-progress-nested', 'Read', { parent: 'subagent-1', input: { file_path: '/home/user/SECRET_SUBAGENT_PATH' } });
      streamToolInput('{"command":"SECRET_TOOL_JSON"}');
      streamToolStop();
      // Sensitive title/description/input must never become the progress label.
      streamTool('toolu-progress-2', 'Grep', {
        input: { pattern: 'SECRET_PATTERN', path: '/home/user/SECRET_PATH' },
        extra: { title: 'SECRET_TITLE', description: 'SECRET_DESCRIPTION' },
      });
      streamDelta('回答一');
      await sleep(20);
      result(uuid, { result: '最终回答1' });
      return;
    }
    case 'progress:2': {
      streamTool('toolu-progress-3', 'Write', { input: { file_path: '/home/user/SECRET_PATH_2', content: 'SECRET_CONTENT' } });
      streamTool('toolu-progress-nested-2', 'Edit', { parent: 'subagent-2', input: { old_string: 'SECRET_OLD' } });
      streamTool('toolu-progress-4', 'Edit', { input: { old_string: 'SECRET_OLD_2' }, extra: { description: 'SECRET_DESCRIPTION_2' } });
      streamDelta('回答二');
      await sleep(20);
      result(uuid, { result: '最终回答2' });
      return;
    }
    case 'progress-abort:1': {
      streamTool('toolu-progress-early', 'EarlyTool', { input: { command: 'SECRET_EARLY' } });
      streamDelta('将被中止 ');
      break;
    }
    case 'error:1': {
      streamDelta('失败前 ');
      result(uuid, { subtype: 'error_during_execution', is_error: true, result: '', errors: ['boom failed badly'] });
      return;
    }
    case 'unattributed:1': {
      streamDelta('无归属 ');
      emit({ type: 'result', subtype: 'success', is_error: false, result: 'UNATTRIBUTED', session_id: sessionId });
      return;
    }
    case 'wrong-session:1': {
      streamDelta('泄漏', 'sess-other');
      result(uuid, { result: '不应到达' });
      return;
    }
    case 'control:1': {
      emit({
        type: 'control_request',
        request_id: 'ctl-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
      });
      // Wait for the adapter's control_response on stdin (handled in handleFrame).
      break;
    }
    case 'slow:1': {
      streamDelta('慢 ');
      await sleep(3000);
      result(uuid, { result: '太晚' });
      return;
    }
    case 'exit-mid-turn:1': { streamDelta('退出'); process.exit(9); return; }
    case 'interrupt-failed:1':
    case 'missing-terminal:1':
    case 'late-ack:1':
    case 'abort:1': {
      streamDelta('将被中止 ');
      break;
    }
    default:
      streamDelta('你好，');
      noisyStreamEvents();
      await sleep(60);
      streamDelta('世界');
      await sleep(20);
      result(uuid, { result: `最终回答${current}` });
  }
}

async function handleFrame(frame) {
  if (frame.type === 'control_response') {
    if (frame.response?.request_id === 'ctl-1') {
      appendFileSync(marker, `${JSON.stringify({ controlResponse: frame.response })}\n`);
      emit({
        type: 'stream_event',
        session_id: sessionId,
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '被拒绝' } },
      });
      result(currentUuid, { result: '工具使用被拒绝，需要用户在本地设置中授权' });
    }
    return;
  }
  if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
    emit({ type: 'control_response', response: { subtype: scenario === 'startup-failed' ? 'error' : 'success', request_id: frame.request_id, response: { claude_code_version: '2.1.304' } } });
    return;
  }
  if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt') {
    const uuid = currentUuid;
    if (marker) appendFileSync(marker, `${JSON.stringify({ interruptRequested: uuid })}\n`);
    if (scenario === 'interrupt-failed') {
      emit({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'interrupt failed' } });
      return;
    }
    const ack = () => emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
    if (scenario === 'late-ack') setTimeout(ack, 180); else ack();
    if (scenario === 'missing-terminal') return;
    setTimeout(() => {
      // A tool frame after the interrupt request must never reach progress.
      if (scenario === 'progress-abort') streamTool('toolu-progress-late', 'LateTool', { input: { command: 'SECRET_LATE' } });
      result(uuid, { subtype: 'error_during_execution', is_error: true, result: '', errors: ['turn aborted by interrupt'] });
      if (marker) appendFileSync(marker, `${JSON.stringify({ interrupted: uuid })}\n`);
      setTimeout(() => { messageStart(uuid); streamDelta('OLD', undefined, `msg-${uuid}`); result(uuid, { result: 'OLD' }); }, 20);
    }, 100);
    return;
  }
  if (frame.type === 'user' && frame.message?.role === 'user' && typeof frame.uuid === 'string') {
    // Hidden Master identity turn: bypass counters/marker so existing user-turn
    // expectations stay intact. Dedicated identity-* scenarios drive failure tests.
    try {
      if (JSON.stringify(frame).includes('WEAVER_MASTER_READY')) {
        const uuid = frame.uuid;
        currentUuid = uuid;
        if (!messageCounter) emit({ type: 'system', subtype: 'init', session_id: sessionId, version: '2.1.304' });
        messageStart(uuid);
        if (scenario === 'identity-hang') return;
        if (scenario === 'identity-auth') {
          result(uuid, { subtype: 'error_during_execution', is_error: true, result: '', errors: ['authentication failed: 401 unauthorized'] });
          return;
        }
        const text = scenario === 'identity-wrong' ? 'WRONG-MARKER' : 'WEAVER_MASTER_READY';
        streamDelta(text);
        await sleep(20);
        result(uuid, { result: text });
        return;
      }
    } catch { /* fall through to the normal path */ }
    if (!messageCounter) emit({ type: 'system', subtype: 'init', session_id: sessionId, version: '2.1.304' });
    currentUuid = frame.uuid;
    const current = ++messageCounter;
    if (marker) appendFileSync(marker, `${JSON.stringify({ pid: process.pid, message: current })}\n`);
    void runTurn(frame.uuid, current);
  }
}

let currentUuid;

process.stdin.setEncoding('utf8');
const buffer = [];
process.stdin.on('data', chunk => {
  buffer.push(chunk);
  let data = buffer.join('');
  buffer.length = 0;
  let index;
  while ((index = data.indexOf('\n')) >= 0) {
    const line = data.slice(0, index);
    data = data.slice(index + 1);
    if (!line.trim()) continue;
    try { handleFrame(JSON.parse(line)); } catch { /* ignore malformed adapter input */ }
  }
  if (data) buffer.push(data);
});
process.stdin.on('end', () => process.exit(0));
