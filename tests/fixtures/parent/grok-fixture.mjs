#!/usr/bin/env node
// Grok ACP stdio fixture for adapter tests. Speaks the newline-delimited JSON-RPC shape of
// grok 1.0.62 (initialize/authenticate/session.new/prompt/cancel/close, session/update and
// session/request_permission) without contacting a model.
// Scenario selection: GROK_FIXTURE_SCENARIO. Markers: GROK_FIXTURE_MARKER.
import { appendFileSync, writeFileSync } from 'node:fs';

const scenario = process.env.GROK_FIXTURE_SCENARIO || 'default';
const marker = process.env.GROK_FIXTURE_MARKER;
const snapshot = process.env.GROK_FIXTURE_SNAPSHOT;
const argv = process.argv.slice(2);
const model = argv[argv.indexOf('--model') + 1] || 'fixture-model';
const effort = argv[argv.indexOf('--reasoning-effort') + 1] || 'high';
const sessionId = 'grok-fixture-session';
const emit = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const log = entry => { if (marker) appendFileSync(marker, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (snapshot) writeFileSync(snapshot, JSON.stringify({ argv, pid: process.pid }), { mode: 0o600 });
log({ spawnPid: process.pid, event: 'spawn' });

let turn = 0;
let pendingPrompt;
let pendingPermission;

function respond(id, result) { emit({ jsonrpc: '2.0', id, result }); }
function fail(id, message) { emit({ jsonrpc: '2.0', id, error: { code: -32000, message } }); }

async function startPrompt(id, params) {
  // Hidden Master identity turn: bypass turn/marker so existing expectations stay intact.
  try {
    if (JSON.stringify(params ?? '').includes('WEAVER_MASTER_READY')) {
      if (scenario === 'identity-hang') return;
      if (scenario === 'identity-auth') { fail(id, 'authentication failed'); return; }
      const text = scenario === 'identity-wrong' ? 'WRONG-MARKER' : 'WEAVER_MASTER_READY';
      pendingPrompt = { id, current: 0, cancelled: false };
      emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      await sleep(20);
      pendingPrompt = undefined;
      respond(id, { stopReason: 'end_turn' });
      return;
    }
  } catch { /* fall through to the normal path */ }
  const current = ++turn;
  pendingPrompt = { id, current, cancelled: false };
  log({ pid: process.pid, turn: current, prompt: params?.prompt?.[0]?.text });
  if (scenario === 'progress' && current === 1) {
    const toolCall = (toolCallId, kind, status, title, extra = {}) => ({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId, kind, status, title, content: [], locations: [], ...extra } },
    });
    // First session/update of the accepted turn: proves the turn started.
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回答' } } } });
    // Top-level tool: only the ACP kind enum may surface, never title/rawInput.
    emit(toolCall('tool-1', 'execute', 'in_progress', 'SECRET rm -rf /etc --token=SECRET_TOKEN', { rawInput: { command: 'SECRET_CMD' } }));
    // Same call reported again (update + completion): must not re-emit.
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress', content: [] } } });
    emit(toolCall('tool-1', 'execute', 'completed', 'SECRET rm -rf /etc', { rawOutput: { lines: 1 } }));
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'SECRET_THOUGHT' } } } });
    emit(toolCall('tool-2', 'read', 'in_progress', '/etc/SECRET_PATH --password=SECRET_PW', { rawInput: { path: '/etc/SECRET_PATH' } }));
    // Another agent's tool activity on a foreign session: never emits.
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'foreign-session', update: { sessionUpdate: 'tool_call', toolCallId: 'tool-x', kind: 'delete', status: 'in_progress', title: 'SECRET_FOREIGN_TOOL' } } });
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'plan', entries: [{ content: 'SECRET_PLAN', priority: 'high', status: 'in_progress' }] } } });
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '1' } } } });
    await sleep(20);
    pendingPrompt = undefined;
    respond(id, { stopReason: 'end_turn' });
    return;
  }
  emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `回答${current}` } } } });
  emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'SECRET_THOUGHT' } } } });
  emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', title: 'SECRET_TOOL' } } });
  emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'foreign-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SECRET_FOREIGN' } } } });
  if (scenario === 'permission' && current === 1) {
    pendingPermission = id;
    emit({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'tool-1' }, options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ] } });
    return;
  }
  if (current === 1 && (scenario === 'abort' || scenario === 'missing-cancel-response' || scenario === 'cancel-race')) return;
  await sleep(20);
  pendingPrompt = undefined;
  respond(id, { stopReason: 'end_turn' });
}

function finishPermission(id, message) {
  log({ permissionResponse: message });
  emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '，工具被拒绝' } } } });
  pendingPrompt = undefined;
  respond(id, { stopReason: 'end_turn' });
}

async function handle(frame) {
  if (pendingPermission && frame.id === 'perm-1' && frame.result) {
    const id = pendingPermission;
    pendingPermission = undefined;
    finishPermission(id, frame.result);
    return;
  }
  if (frame.method === 'initialize') {
    if (scenario === 'initialize-failed') { fail(frame.id, 'initialize failed'); return; }
    respond(frame.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'cached_token', name: 'cached_token' }],
      _meta: { defaultAuthMethodId: 'cached_token' },
    });
    return;
  }
  if (frame.method === 'authenticate') {
    log({ authenticate: frame.params?.methodId });
    if (scenario === 'auth-failed') { fail(frame.id, 'authentication failed'); return; }
    respond(frame.id, { _meta: { auth_mode: 'fixture' } });
    return;
  }
  if (frame.method === 'session/new') {
    const currentModel = scenario === 'model-mismatch' ? 'other-model' : model;
    const currentMode = scenario === 'effort-mismatch' ? 'low' : effort;
    respond(frame.id, {
      sessionId,
      models: { currentModelId: currentModel, availableModels: [{ modelId: currentModel }] },
      configOptions: [],
      _meta: {
        currentWorkingDirectory: frame.params?.cwd,
        'x.ai/sessionConfig': { options: [
          { id: currentModel, category: 'model', label: currentModel, selected: true },
          { id: currentMode, category: 'mode', label: currentMode, selected: true },
        ] },
      },
    });
    return;
  }
  if (frame.method === 'session/prompt') { void startPrompt(frame.id, frame.params); return; }
  if (frame.method === 'session/cancel') {
    log({ cancel: frame.params?.sessionId });
    const pending = pendingPrompt;
    if (!pending) return;
    pending.cancelled = true;
    if (scenario === 'missing-cancel-response') return;
    if (scenario === 'abort') {
      // A late tool frame after cancellation: the adapter must not report progress for it.
      emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-late', kind: 'execute', status: 'in_progress', title: 'SECRET_LATE' } } });
    }
    await sleep(30);
    pendingPrompt = undefined;
    respond(pending.id, { stopReason: scenario === 'cancel-race' ? 'end_turn' : 'cancelled' });
    return;
  }
  if (frame.method === 'session/close') { respond(frame.id, { _meta: { 'x.ai/closeOutcome': 'closed' } }); return; }
  if (frame.id !== undefined) fail(frame.id, `unsupported method ${frame.method}`);
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
