#!/usr/bin/env node
// Qoder CLI stream-json fixture for adapter tests. Speaks the public 1.1.75 print/stream-json
// shape: an immediate system/init, control_request initialize, user JSONL frames, partial
// stream_event text deltas, control_response interrupt and result. No model is contacted.
// Scenario selection: QODER_FIXTURE_SCENARIO. Markers: QODER_FIXTURE_MARKER.
import { appendFileSync, writeFileSync } from 'node:fs';

const scenario = process.env.QODER_FIXTURE_SCENARIO || 'default';
const marker = process.env.QODER_FIXTURE_MARKER;
const snapshot = process.env.QODER_FIXTURE_SNAPSHOT;
const argv = process.argv.slice(2);
const model = argv[argv.indexOf('--model') + 1] || 'fixture-model';
const sessionId = 'qoder-fixture-session';
const emit = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const log = entry => { if (marker) appendFileSync(marker, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (snapshot) writeFileSync(snapshot, JSON.stringify({ argv, pid: process.pid }), { mode: 0o600 });
log({ spawnPid: process.pid, event: 'spawn' });

let turn = 0;
let pendingPermission;
let currentTurn;

if (scenario !== 'no-init') {
  emit({
    type: 'system', subtype: 'init', apiKeySource: 'none', qodercli_version: '1.1.75', protocol_version: '1.5.0',
    cwd: process.cwd(), tools: [], mcp_servers: [], model: scenario === 'model-mismatch' ? 'Other-Model' : model,
    permissionMode: 'default', capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'],
    session_id: sessionId, uuid: 'fixture-init',
  });
}

function result(subtype, text, uuid, overrides = {}) {
  return { type: 'result', subtype, duration_ms: 10, duration_api_ms: 5, is_error: subtype !== 'success', num_turns: 1, result: text, stop_reason: null, uuid, session_id: sessionId, ...overrides };
}

async function streamTurn(frame) {
  // Hidden Master identity turn: bypass turn/marker so existing expectations stay intact.
  try {
    if (JSON.stringify(frame).includes('WEAVER_MASTER_READY')) {
      if (scenario === 'identity-hang') return;
      if (scenario === 'identity-auth') {
        emit(result('error_during_execution', '', 'result-identity', { errors: ['authentication failed: 401 unauthorized'], error_code: 105 }));
        return;
      }
      const text = scenario === 'identity-wrong' ? 'WRONG-MARKER' : 'WEAVER_MASTER_READY';
      emit({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, uuid: 'evt-identity-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
      emit({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] }, uuid: 'assistant-identity' });
      await sleep(20);
      emit(result('success', text, 'result-identity'));
      return;
    }
  } catch { /* fall through to the normal path */ }
  const current = ++turn;
  currentTurn = current;
  log({ pid: process.pid, turn: current });
  // Native 1.1.75 reports auth/quota/provider failures as an is_error result before any
  // public delta; the zero-delta shape must settle instead of waiting for turn timeout.
  if (scenario === 'auth') {
    emit(result('error_during_execution', '', `result-${current}`, { errors: ['authentication failed: 401 unauthorized'], error_code: 105 }));
    return;
  }
  if (scenario === 'auth-code') {
    emit(result('error_during_execution', '', `result-${current}`, { errors: [], error_code: 105 }));
    return;
  }
  if (scenario === 'auth-success-error') {
    emit(result('success', 'authentication failed: 401 unauthorized', `result-${current}`, { is_error: true, error_code: 105 }));
    return;
  }
  if (scenario === 'result-error') {
    emit(result('error_during_execution', '', `result-${current}`, { errors: ['provider unavailable: model service failed'] }));
    return;
  }
  if (scenario === 'top-error' || scenario === 'top-error-auth') {
    emit({ type: 'error', subtype: 'server_error', session_id: sessionId, parent_tool_use_id: null, uuid: `top-error-${current}`, error: { message: scenario === 'top-error-auth' ? 'authentication failed: 401 unauthorized' : 'provider unavailable: model service failed' } });
    return;
  }
  if (scenario === 'stale-foreign-error') {
    if (current === 1) {
      emit(result('error_during_execution', '', 'result-shared', { errors: ['provider unavailable: stale error'] }));
      return;
    }
    // A duplicate of the settled first-turn error, a stale success, a foreign-session error,
    // a subagent error and a foreign top-level error must all leave the current turn alone.
    emit(result('error_during_execution', '', 'result-shared', { errors: ['duplicate stale error'] }));
    emit(result('success', 'STALE', 'old-result-uuid'));
    emit(result('error_during_execution', '', 'result-foreign', { errors: ['foreign session error'], session_id: 'foreign-session' }));
    emit(result('error_during_execution', '', 'result-sub', { errors: ['subagent error'], parent_tool_use_id: 'task-sub' }));
    emit({ type: 'error', session_id: 'foreign-session', parent_tool_use_id: null, uuid: 'top-foreign', error: { message: 'authentication failed: 401 unauthorized' } });
  }
  if (scenario === 'old-terminal' && current === 2) {
    emit(result('success', 'STALE', 'old-result-uuid'));
    await sleep(20);
  }
  emit({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, uuid: `evt-${current}-1`, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `回答${current}` } } });
  emit({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, uuid: `evt-${current}-2`, event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'SECRET_THINKING' } } });
  emit({ type: 'stream_event', session_id: 'foreign-session', parent_tool_use_id: null, uuid: `evt-${current}-3`, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SECRET_FOREIGN' } } });
  emit({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: `回答${current}` }, { type: 'thinking', thinking: 'SECRET_ASSISTANT_THINKING' }] }, uuid: `assistant-${current}` });
  if (scenario === 'permission' && current === 1) {
    pendingPermission = { turn: current };
    emit({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /' } } });
    return;
  }
  if (scenario === 'mirror-notice') {
    emit({ type: 'system', subtype: 'mirror_error', session_id: sessionId, uuid: `mirror-${current}`, message: 'mirror storage unavailable' });
  }
  if (current === 1 && (scenario === 'abort' || scenario === 'abort-foreign-error' || scenario === 'missing-terminal' || scenario === 'missing-ack' || scenario === 'abort-fail' || scenario === 'result-before-ack')) return;
  if (scenario === 'missing-result') return;
  await sleep(20);
  emit(result('success', `最终回答${current}`, `result-${current}`));
}

function finishPermission(response, next) {
  log({ controlResponse: response });
  emit({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, uuid: 'evt-perm', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '被拒绝' } } });
  finishResult();
  next();
}

function finishResult() {
  emit(result('success', '工具使用被拒绝', 'result-perm'));
}

async function handle(frame) {
  if (pendingPermission && frame.type === 'control_response' && frame.response?.request_id === 'perm-1') {
    const pending = pendingPermission;
    pendingPermission = undefined;
    finishPermission(frame, () => log({ permissionDone: pending.turn }));
    return;
  }
  if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
    if (scenario === 'initialize-failed') {
      emit({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'initialize failed' } });
      return;
    }
    await sleep(10);
    emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [], output_style: 'default', models: [] } } });
    return;
  }
  if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt') {
    log({ interruptRequest: frame.request_id, turn });
    if (scenario === 'missing-ack') {
      emit(result('error_during_execution', '', 'result-abort', { errors: ['turn aborted'] }));
      return;
    }
    if (scenario === 'result-before-ack') {
      emit(result('error_during_execution', '', 'result-abort', { errors: ['turn aborted'] }));
      await sleep(20);
      emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { still_queued: [], cancelled: ['queued'] } } });
      return;
    }
    if (scenario === 'abort-fail') {
      emit({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'interrupt failed' } });
      return;
    }
    emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { still_queued: [], cancelled: ['queued'] } } });
    if (scenario === 'missing-terminal') return;
    if (scenario === 'abort-foreign-error') {
      emit(result('error_during_execution', '', 'result-foreign-abort', { errors: ['authentication failed'], session_id: 'foreign-session' }));
      await sleep(30);
      emit(result('error_during_execution', '', 'result-abort', { errors: ['turn aborted'] }));
      return;
    }
    if (scenario === 'abort') {
      await sleep(30);
      emit(result('error_during_execution', '', 'result-abort', { errors: ['turn aborted'] }));
    }
    return;
  }
  if (frame.type === 'user' && frame.message?.role === 'user') {
    log({ pid: process.pid, user: currentTurn ?? null, text: frame.message.content?.[0]?.text });
    await streamTurn(frame);
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
