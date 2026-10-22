#!/usr/bin/env node
// Pi RPC protocol fixture for adapter tests. Speaks the JSONL command/response/event framing of
// pi 1.3.0 docs/rpc.md and docs/json.md without contacting a model.
// Scenario selection: PI_FIXTURE_SCENARIO. Markers: PI_FIXTURE_MARKER.
import { appendFileSync, writeFileSync } from 'node:fs';

const scenario = process.env.PI_FIXTURE_SCENARIO || 'default';
const marker = process.env.PI_FIXTURE_MARKER;
const snapshot = process.env.PI_FIXTURE_SNAPSHOT;
const argv = process.argv.slice(2);
const model = argv[argv.indexOf('--model') + 1] || 'fixture-model';
let thinking = argv[argv.indexOf('--thinking') + 1] || 'medium';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const log = entry => { if (marker) appendFileSync(marker, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); };
if (snapshot) writeFileSync(snapshot, JSON.stringify({ argv, pid: process.pid }), { mode: 0o600 });
log({ spawnPid: process.pid, event: 'spawn' });

let turn = 0;
let awaitingExtension;
let currentPrompt;

function state() {
  return {
    model: { id: scenario === 'model-mismatch' ? 'other-model' : model, provider: 'fixture', reasoning: true },
    thinkingLevel: scenario === 'effort-mismatch' ? 'low' : thinking,
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'one-at-a-time',
    sessionId: 'pi-fixture-session',
    autoCompactionEnabled: true,
    messageCount: turn,
    pendingMessageCount: 0,
  };
}

function respond(id, command, data) {
  emit({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) });
}

function fail(id, command, error) {
  emit({ id, type: 'response', command, success: false, error });
}

function assistant(content, stopReason = 'stop', errorMessage) {
  return { role: 'assistant', content, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now() };
}

async function runPrompt(frame) {
  // Hidden Master identity turn: bypass turn/marker so existing user-turn expectations stay intact.
  try {
    if (JSON.stringify(frame).includes('WEAVER_MASTER_READY')) {
      respond(frame.id, 'prompt', { disposition: 'started' });
      if (scenario === 'identity-hang') return;
      if (scenario === 'identity-auth') {
        emit({ type: 'agent_start' });
        emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'auth failed' }], 'error', 'authentication failed: 401 unauthorized') });
        emit({ type: 'agent_settled', aborted: false });
        return;
      }
      const text = scenario === 'identity-wrong' ? 'WRONG-MARKER' : 'WEAVER_MASTER_READY';
      emit({ type: 'agent_start' });
      emit({ type: 'turn_start' });
      emit({ type: 'message_start', message: assistant([], 'pending') });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } });
      emit({ type: 'message_end', message: assistant([{ type: 'text', text }]) });
      emit({ type: 'agent_end', messages: [], willRetry: false });
      emit({ type: 'agent_settled', aborted: false });
      return;
    }
  } catch { /* fall through to the normal path */ }
  const current = ++turn;
  log({ pid: process.pid, turn: current, prompt: frame.message });
  await sleep(5);
  respond(frame.id, 'prompt', { disposition: 'started' });
  if (scenario === 'auth') {
    emit({ type: 'agent_start' });
    emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'auth failed' }], 'error', 'authentication failed: 401 unauthorized') });
    emit({ type: 'agent_settled', aborted: false });
    return;
  }
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({ type: 'message_start', message: assistant([], 'pending') });
  if (scenario === 'extension' && current === 1) {
    awaitingExtension = { promptId: frame.id, current };
    emit({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Allow dangerous command?', message: 'Fixture', timeout: 5000 });
    return;
  }
  if (current === 1 && (scenario === 'abort' || scenario === 'abort-early-settled' || scenario === 'missing-terminal' || scenario === 'abort-fail' || scenario === 'abort-retry')) {
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `部分${current}` } });
    return;
  }
  if (scenario === 'retry-success' && current === 1) {
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '你好，' } });
    emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'transient fail' }], 'error', 'transient stream drop') });
    await sleep(20);
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '世界' } });
    emit({ type: 'message_end', message: assistant([{ type: 'text', text: `最终回答${current}` }]) });
    emit({ type: 'auto_retry_end', success: true, attempt: 1 });
    emit({ type: 'agent_settled', aborted: false });
    return;
  }
  if (scenario === 'retry-exhausted' && current === 1) {
    emit({ type: 'message_end', message: assistant([{ type: 'text', text: 'failed' }], 'error', 'transient stream drop') });
    emit({ type: 'auto_retry_end', success: false, attempt: 2, finalError: 'transient stream drop' });
    emit({ type: 'agent_settled', aborted: false });
    return;
  }
  const answer = `最终回答${current}`;
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '你好，' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'SECRET_THINKING' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 2, delta: 'SECRET_TOOL' } });
  emit({ type: 'message_update', parentToolCallId: 'sub-1', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'SECRET_SUBAGENT' } });
  await sleep(20);
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '世界' } });
  emit({ type: 'message_end', message: assistant([{ type: 'text', text: answer }]) });
  emit({ type: 'agent_end', messages: [], willRetry: false });
  emit({ type: 'agent_settled', aborted: false });
}

async function handle(frame) {
  if (awaitingExtension && frame.type === 'extension_ui_response') {
    log({ extensionUiResponse: frame });
    const pending = awaitingExtension;
    awaitingExtension = undefined;
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '被拒绝' } });
    emit({ type: 'message_end', message: assistant([{ type: 'text', text: '工具使用被拒绝' }]) });
    emit({ type: 'agent_settled', aborted: false });
    return;
  }
  if (frame.type === 'get_state') { respond(frame.id, 'get_state', state()); return; }
  if (frame.type === 'set_thinking_level') {
    log({ setThinkingLevel: frame.level });
    if (scenario !== 'effort-mismatch') thinking = frame.level;
    respond(frame.id, 'set_thinking_level', undefined);
    return;
  }
  if (frame.type === 'prompt') { void runPrompt(frame); return; }
  if (frame.type === 'abort') {
    log({ abort: frame.id, turn });
    if (scenario === 'abort-fail') { fail(frame.id, 'abort', 'abort failed'); return; }
    if (scenario === 'abort-early-settled') {
      log({ settledBeforeAck: true });
      emit({ type: 'agent_settled', aborted: true });
      await sleep(40);
      log({ ackAfterSettled: true });
      respond(frame.id, 'abort', undefined);
      return;
    }
    if (scenario === 'abort-retry') {
      log({ abort: frame.id, turn });
      respond(frame.id, 'abort', undefined);
      await sleep(40);
      emit({ type: 'message_end', message: assistant([{ type: 'text', text: '不该成为正文' }]) });
      emit({ type: 'auto_retry_end', success: true, attempt: 1 });
      emit({ type: 'agent_settled', aborted: true });
      return;
    }
    respond(frame.id, 'abort', undefined);
    if (scenario === 'missing-terminal') return;
    await sleep(40);
    emit({ type: 'agent_settled', aborted: true });
    return;
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    try { void handle(JSON.parse(line)); } catch { /* malformed adapter input is ignored */ }
  }
});
process.stdin.on('end', () => process.exit(0));
