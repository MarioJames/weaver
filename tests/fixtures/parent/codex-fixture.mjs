#!/usr/bin/env node
// Codex app-server protocol fixture for adapter tests. Speaks the app-server JSONRPC framing
// of codex-cli 0.163.0 (initialize/initialized/thread-start/turn-start and notifications)
// without contacting any model. Scenario selection: CODEX_FIXTURE_SCENARIO.
import { appendFileSync, writeFileSync } from 'node:fs';

const scenario = process.env.CODEX_FIXTURE_SCENARIO || 'default';
const marker = process.env.CODEX_FIXTURE_MARKER;
const snapshot = process.env.CODEX_FIXTURE_SNAPSHOT;

const emit = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const respond = (id, result) => emit({ id, result });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (snapshot) writeFileSync(snapshot, JSON.stringify({ argv: process.argv, env: Object.fromEntries(['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'HERDR_TOKEN', 'WEAVER_TASK_ID', 'WEAVER_WORKER_ID'].filter(key => key in process.env).map(key => [key, process.env[key]])), hasHome: !!process.env.HOME }), { mode: 0o600 });

if (marker) appendFileSync(marker, `${JSON.stringify({ spawnPid: process.pid })}\n`, { mode: 0o600 });

let turnCounter = 0;
let pendingServerRequest;
let pendingTurnStart;
const inFlightTurns = new Map();
const buffer = [];

function handle(frame) {
  // Response from the adapter to a server request we issued.
  if (pendingServerRequest && frame.id === pendingServerRequest.id) {
    const handler = pendingServerRequest;
    pendingServerRequest = undefined;
    handler.continue(frame);
    return;
  }
  if (frame.method === 'turn/interrupt' && frame.id !== undefined) {
    if (marker) appendFileSync(marker, `${JSON.stringify({ interruptRequested: frame.params })}\n`);
    if (scenario === 'interrupt-failed') { emit({ id: frame.id, error: { message: 'interrupt failed' } }); return; }
    if (scenario === 'late-ack') setTimeout(() => respond(frame.id, {}), 180);
    else respond(frame.id, {});
    if (scenario === 'missing-terminal') return;
    const { threadId, turnId } = frame.params;
    if (inFlightTurns.get(turnId) !== threadId) process.exit(12);
    setTimeout(() => {
      inFlightTurns.delete(turnId);
      emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted', items: [] } } });
      if (marker) appendFileSync(marker, `${JSON.stringify({ interrupted: turnId })}\n`);
      setTimeout(() => {
        emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, delta: 'OLD' } });
        emit({ method: 'item/agentMessage/delta', params: { delta: 'MISSING-ID' } });
        emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
      }, 20);
    }, 100);
    return;
  }
  if (frame.method === 'turn/interrupt') return;
  if (frame.id !== undefined && frame.method) {
    if (frame.method === 'initialize') {
      if (scenario === 'startup-failed') { emit({ id: frame.id, error: { message: 'initialize failed' } }); return; }
      respond(frame.id, { userAgent: 'fixture-codex/0.163.0 (Debian 13.0.0; x86_64) fixture (weaver; test)', codexHome: '/tmp/weaver-fixture-codex-home', platformFamily: 'unix', platformOs: 'linux' });
      return;
    }
    if (frame.method === 'thread/start') {
      respond(frame.id, { thread: { id: 'thr-fixture', ephemeral: true, model: frame.params?.model ?? 'fixture-model', cwd: frame.params?.cwd ?? '/tmp' }, model: 'fixture-model', cwd: frame.params?.cwd ?? '/tmp' });
      return;
    }
    if (frame.method === 'turn/start') {
      runTurn(frame);
      return;
    }
    respond(frame.id, {});
    return;
  }
  // Notifications such as `initialized` need no answer.
}

function agentItem(id, text, phase) {
  return { type: 'agentMessage', id, text, ...(phase === undefined ? {} : { phase }) };
}

function runTurn(frame) {
  // Hidden Master identity turn: bypass turnCounter/marker so existing user-turn
  // expectations stay intact. Dedicated identity-* scenarios drive failure tests.
  try {
    if (JSON.stringify(frame).includes('WEAVER_MASTER_READY')) {
      const threadId = frame.params?.threadId ?? 'thr-fixture';
      const turnId = 'turn-identity';
      const id = frame.id;
      if (scenario === 'identity-hang') return;
      if (scenario === 'identity-auth') {
        respond(id, { turn: { id: turnId, status: 'inProgress', items: [] } });
        inFlightTurns.set(turnId, threadId);
        emit({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
        emit({ method: 'error', params: { threadId, turnId, error: { message: 'authentication failed: 401 unauthorized' }, willRetry: false } });
        inFlightTurns.delete(turnId);
        emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed' } } });
        return;
      }
      const text = scenario === 'identity-wrong' ? 'WRONG-MARKER' : 'WEAVER_MASTER_READY';
      respond(id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      inFlightTurns.set(turnId, threadId);
      emit({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'it-identity', delta: text } });
      emit({ method: 'item/completed', params: { threadId, turnId, item: agentItem('it-identity', text, 'final_answer') } });
      inFlightTurns.delete(turnId);
      emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
      return;
    }
  } catch { /* fall through to the normal path */ }
  const threadId = frame.params?.threadId ?? 'thr-fixture';
  const turnId = `turn-${++turnCounter}`;
  if (marker) appendFileSync(marker, `${JSON.stringify({ pid: process.pid, turn: turnCounter })}\n`);
  pendingTurnStart = { id: frame.id, threadId, turnId };
  const start = () => {
    inFlightTurns.set(turnId, threadId);
    emit({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
  };
  const complete = status => {
    inFlightTurns.delete(turnId);
    emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, items: [] } } });
  };
  const finishNormally = answerText => {
    respond(frame.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
    void (async () => {
      start();
      emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'it-1', delta: '进度: ' } });
      emit({ method: 'item/completed', params: { threadId, turnId, item: agentItem('it-1', '进度播报', 'commentary') } });
      await sleep(40);
      emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'it-2', delta: answerText } });
      emit({ method: 'item/completed', params: { threadId, turnId, item: agentItem('it-2', answerText, 'final_answer') } });
      await sleep(40);
      complete('completed');
    })();
  };
  switch (`${scenario}:${turnCounter}`) {
    case 'interrupt-failed:1':
    case 'missing-terminal:1':
    case 'late-ack:1':
    case 'abort:1':
    case 'abort-start:1': {
      start();
      emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, delta: 'first' } });
      setTimeout(() => respond(frame.id, { turn: { id: turnId, status: 'inProgress', items: [] } }), scenario === 'abort-start' ? 100 : 0);
      return;
    }
    case 'race:1':
    case 'race:2': {
      // Notifications and turn/completed all arrive before the turn/start response.
      start();
      emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'it-2', delta: '竞态回答' } });
      emit({ method: 'item/completed', params: { threadId, turnId, item: agentItem('it-2', '竞态回答', 'final_answer') } });
      complete('completed');
      respond(frame.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      return;
    }
    case 'wrong-turn:1': {
      // Events for another thread and another turn must be ignored.
      emit({ method: 'turn/started', params: { threadId: 'thr-other', turn: { id: 'turn-other', status: 'inProgress', items: [] } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'thr-other', turnId: 'turn-other', itemId: 'it-x', delta: 'WRONG-THREAD' } });
      emit({ method: 'item/completed', params: { threadId: 'thr-other', turnId: 'turn-other', item: agentItem('it-x', 'WRONG-THREAD', 'final_answer') } });
      start();
      emit({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-wrong', itemId: 'it-y', delta: 'WRONG-TURN' } });
      emit({ method: 'item/completed', params: { threadId, turnId: 'turn-wrong', item: agentItem('it-y', 'WRONG-TURN', 'final_answer') } });
      emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'it-2', delta: '正确回答' } });
      emit({ method: 'item/completed', params: { threadId, turnId, item: agentItem('it-2', '正确回答', 'final_answer') } });
      respond(frame.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      complete('completed');
      return;
    }
    case 'approval:1': {
      start();
      respond(frame.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      pendingServerRequest = {
        id: 'srv-approval-1',
        continue: response => {
          appendFileSync(marker, `${JSON.stringify({ approvalDecision: response.result ?? response.error })}\n`);
          complete('interrupted');
        },
      };
      emit({ id: 'srv-approval-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'it-cmd', kind: 'command', command: 'rm -rf /' } });
      return;
    }
    case 'unknown-request:1': {
      start();
      respond(frame.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      pendingServerRequest = {
        id: 'srv-tool-1',
        continue: response => {
          appendFileSync(marker, `${JSON.stringify({ toolCallResponse: response.result ?? response.error })}\n`);
          emit({ method: 'item/completed', params: { threadId, turnId, item: agentItem('it-2', '工具调用被拒绝后的回答', 'final_answer') } });
          complete('completed');
        },
      };
      emit({ id: 'srv-tool-1', method: 'item/tool/call', params: { threadId, turnId, callId: 'call-1', tool: 'client_tool', input: '{}' } });
      return;
    }
    case 'exit-mid-turn:1': {
      start();
      emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'it-1', delta: '部分输出' } });
      process.exit(9);
      return;
    }
    case 'garbage:1': {
      process.stdout.write('this is not json\n');
      process.exit(7);
      return;
    }
    case 'failed:1': {
      start();
      respond(frame.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      emit({ method: 'error', params: { threadId, turnId, error: { message: 'model backend exploded' }, willRetry: false } });
      complete('failed');
      return;
    }
    case 'slow:1': {
      start();
      respond(frame.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      emit({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'it-1', delta: '慢' } });
      setTimeout(() => complete('completed'), 3000);
      return;
    }
    default:
      finishNormally(`回答${turnCounter}`);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer.push(chunk);
  let data = buffer.join('');
  buffer.length = 0;
  let index;
  while ((index = data.indexOf('\n')) >= 0) {
    const line = data.slice(0, index);
    data = data.slice(index + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch { /* malformed adapter input is ignored by the fixture */ }
  }
  if (data) buffer.push(data);
});
process.stdin.on('end', () => process.exit(0));
