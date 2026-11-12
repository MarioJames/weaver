#!/usr/bin/env node
// OpenCode 2.2.x `serve`/SSE fixture for parent adapter tests.
// Implements the subset of the installed 2.2.7 `/openapi.json` surface the IM parent uses:
// `/api/info`, `/api/session` create/delete, `/api/event`, `/api/session/:id/prompt`,
// `/api/session/:id/interrupt`, `/api/session/:id/message`, permission reply and form cancel.
// It never contacts a model. Scenario: OPENCODE_FIXTURE_SCENARIO. Markers: OPENCODE_FIXTURE_MARKER.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scenario = process.env.OPENCODE_FIXTURE_SCENARIO || 'default';
const marker = process.env.OPENCODE_FIXTURE_MARKER;
const snapshot = process.env.OPENCODE_FIXTURE_SNAPSHOT;
const password = process.env.OPENCODE_SERVER_PASSWORD || '';
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] || 0);
const sessionId = 'ses_fixture';
const log = entry => { if (marker) appendFileSync(marker, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (snapshot) writeFileSync(snapshot, JSON.stringify({ argv, pid: process.pid, hasPassword: !!password }), { mode: 0o600 });
log({ spawnPid: process.pid, event: 'spawn', argv: argv.slice(0, 3) });

let sse;
let turn = 0;
let active;
let messages = [];
let eventSeq = 0;
let promptSeq = 0;
const session = { id: sessionId, model: undefined, location: undefined, instructions: undefined, permissions: undefined };
const expectedAuth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
function authorized(req) { return req.headers.authorization === expectedAuth; }
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
function body(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
function event(type, data) {
  if (!sse) return;
  sse.write(`data: ${JSON.stringify({ id: `evt_${++eventSeq}`, created: Date.now(), type, data })}\n\n`);
}
function noteAssistant(id) {
  if (!active) return;
  if (!active.assistants.includes(id)) active.assistants.push(id);
}
function text(id, value, chunks) {
  noteAssistant(id);
  event('session.text.started', { sessionID: sessionId, assistantMessageID: id, ordinal: 0 });
  if (chunks) {
    for (const chunk of chunks) event('session.text.delta', { sessionID: sessionId, assistantMessageID: id, ordinal: 0, delta: chunk });
  } else {
    event('session.text.delta', { sessionID: sessionId, assistantMessageID: id, ordinal: 0, delta: value });
  }
  event('session.text.ended', { sessionID: sessionId, assistantMessageID: id, ordinal: 0, text: value });
}
function stepStart(id) {
  noteAssistant(id);
  event('session.step.started', { sessionID: sessionId, agent: 'build', model: session.model, assistantMessageID: id, started: Date.now() });
}
function stepEnd(id, finish = 'stop') {
  event('session.step.streamed', { sessionID: sessionId, assistantMessageID: id });
  event('session.step.ended', { sessionID: sessionId, assistantMessageID: id, finish, rawFinish: finish, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } });
}
function success() { event('session.execution.succeeded', { sessionID: sessionId }); }
function failure(type, message, status) {
  event('session.execution.failed', { sessionID: sessionId, error: { type, message, ...(status ? { status } : {}) } });
}
function toolStarted(id, name) {
  noteAssistant(id);
  event('session.tool.input.started', { sessionID: sessionId, assistantMessageID: id, id: `call_${name}_${turn}`, name });
}
function toolSecrets(id, name) {
  event('session.tool.called', { sessionID: sessionId, assistantMessageID: id, id: `call_${name}_${turn}`, input: { command: 'curl -H "Authorization: Bearer SECRET_TOOL_TOKEN" https://example.test/SECRET_PATH' }, executed: false });
  event('session.tool.success', { sessionID: sessionId, assistantMessageID: id, id: `call_${name}_${turn}`, content: [{ type: 'text', text: 'SECRET_TOOL_OUTPUT' }], metadata: { status: 'completed', title: 'SECRET_TOOL_TITLE', path: '/home/test/SECRET_PATH' }, executed: false });
}

async function runTurn(prompt) {
  const promptText = String(prompt.text ?? '');
  if (promptText.includes('WEAVER_MASTER_READY')) {
    const id = 'msg_identity';
    active = { turn: 0, promptID: prompt.id, assistants: [] };
    if (scenario === 'identity-hang') return;
    event('session.execution.started', { sessionID: sessionId });
    stepStart(id);
    if (scenario === 'identity-auth') { failure('provider.auth', 'not authenticated', 401); return; }
    if (scenario === 'identity-split') {
      text('msg_identity_progress', '身份初始化中，接线完成。');
      stepEnd('msg_identity_progress', 'tool-calls');
      stepStart(id);
      text(id, 'WEAVER_MASTER_READY');
      stepEnd(id, 'stop');
      success();
      return;
    }
    const value = scenario === 'identity-wrong' ? 'WRONG-MARKER' : scenario === 'identity-prefix' ? '身份初始化中，只输出就绪标记。WEAVER_MASTER_READY' : 'WEAVER_MASTER_READY';
    text(id, value);
    stepEnd(id, 'stop');
    success();
    return;
  }

  const current = ++turn;
  const assistantID = `msg_a${current}`;
  active = { turn: current, promptID: prompt.id, assistants: [] };
  log({ pid: process.pid, turn: current, messageID: prompt.id, model: session.model, variant: session.model?.variant, instructions: session.instructions, text: prompt.text });
  event('session.execution.started', { sessionID: sessionId });

  if (scenario === 'stale-idle') {
    // A stale session.idle is not a turn terminal in 2.2; only execution.* settles.
    event('session.idle', { sessionID: sessionId });
  }
  if (scenario === 'stale-execution') {
    // A stale terminal from an earlier execution arrives before this turn binds anything.
    event('session.execution.succeeded', { sessionID: sessionId });
  }
  await sleep(10);
  if (active?.turn !== current) return;

  if (scenario === 'auth') { failure('provider.auth', 'not authenticated', 401); return; }
  if (scenario === 'execution-failed') { failure('provider.no-route', 'Model unavailable: fixture-provider/fixture-model'); return; }
  if (scenario === 'midturn-exit') {
    stepStart(assistantID);
    event('session.text.started', { sessionID: sessionId, assistantMessageID: assistantID, ordinal: 0 });
    event('session.text.delta', { sessionID: sessionId, assistantMessageID: assistantID, ordinal: 0, delta: 'PARTIAL-' });
    setTimeout(() => process.exit(1), 50);
    return;
  }
  if (scenario === 'permission' || scenario === 'permission-denied' || scenario === 'question') {
    stepStart(assistantID);
    if (scenario === 'question') {
      event('form.created', { form: { id: 'frm_fixture', sessionID: sessionId, title: 'Fixture form', fields: [{ key: 'answer', type: 'string', title: 'Answer' }] } });
    } else {
      event('permission.asked', { id: 'per_fixture', sessionID: sessionId, action: 'external_directory', resources: [scenario === 'permission' ? join(process.cwd(), '..', 'extra') : '/etc/passwd'], save: ['*'] });
    }
    return;
  }
  if (scenario === 'multi-assistant' || scenario === 'identity-split' || scenario === 'progress' || scenario === 'progress-abort') {
    const secondID = `${assistantID}_b`;
    if (scenario === 'progress' || scenario === 'progress-abort') {
      stepStart(assistantID);
      toolStarted(assistantID, 'bash');
      toolSecrets(assistantID, 'bash');
      toolStarted(assistantID, 'read');
      toolSecrets(assistantID, 'read');
      if (scenario === 'progress-abort') return;
      stepEnd(assistantID, 'tool-calls');
      stepStart(secondID);
      text(secondID, '进度完成', ['进度', '完成']);
      stepEnd(secondID, 'stop');
      success();
      return;
    }
    stepStart(assistantID);
    text(assistantID, scenario === 'identity-split' ? '身份初始化中，接线完成。' : '中间-');
    stepEnd(assistantID, 'tool-calls');
    stepStart(secondID);
    text(secondID, scenario === 'identity-split' ? 'WEAVER_MASTER_READY' : '最终');
    stepEnd(secondID, 'stop');
    success();
    return;
  }
  if (scenario === 'reasoning-stream') {
    stepStart(assistantID);
    event('session.reasoning.started', { sessionID: sessionId, assistantMessageID: assistantID, ordinal: 0 });
    event('session.reasoning.delta', { sessionID: sessionId, assistantMessageID: assistantID, ordinal: 0, delta: 'SECRET_REASONING' });
    event('session.reasoning.ended', { sessionID: sessionId, assistantMessageID: assistantID, ordinal: 0, text: 'SECRET_REASONING' });
    event('session.synthetic', { sessionID: sessionId, text: 'SECRET_SYNTHETIC', description: 'fixture' });
    text(assistantID, '公开-正文', ['公开', '-正文']);
    stepEnd(assistantID, 'stop');
    success();
    return;
  }
  if (scenario === 'missing-final') {
    stepStart(assistantID);
    stepEnd(assistantID, 'stop');
    success();
    return;
  }
  if (scenario === 'missing-terminal') {
    stepStart(assistantID);
    text(assistantID, '只有文本没有执行终态');
    stepEnd(assistantID, 'stop');
    return;
  }
  if (scenario === 'wrong-session') {
    event('session.text.delta', { sessionID: 'ses_other', assistantMessageID: 'msg_other', ordinal: 0, delta: 'SECRET_FOREIGN' });
    return;
  }

  if (scenario === 'delta-first') {
    noteAssistant(assistantID);
    event('session.text.delta', { sessionID: sessionId, assistantMessageID: assistantID, ordinal: 0, delta: '你好，' });
  }
  stepStart(assistantID);
  text(assistantID, `你好，世界${current}`, scenario === 'delta-first' ? ['世界1'] : ['你好，', `世界${current}`]);
  stepEnd(assistantID, 'stop');
  if (current === 1 && (scenario === 'abort' || scenario === 'abort-error' || scenario === 'abort-early' || scenario === 'abort-missing-idle' || scenario === 'abort-false')) {
    // Leave the first execution running until the test sends the interrupt.
    return;
  }
  if (scenario === 'stale-idle' || scenario === 'stale-execution') {
    // The stale signal arrived before the real terminal; a correct adapter must keep waiting.
    await sleep(300);
    if (active?.turn !== current) return;
  }
  success();
}

function finishAfterPermission(value) {
  const current = active;
  if (!current) return;
  const id = current.assistants.at(-1) || 'msg_a1';
  text(id, '工具请求已处理');
  stepEnd(id, 'stop');
  success();
}

function finishAfterForm() {
  const current = active;
  if (!current) return;
  const id = current.assistants.at(-1) || 'msg_a1';
  text(id, '问题已拒绝');
  stepEnd(id, 'stop');
  success();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
  if (req.method === 'GET' && url.pathname === '/api/info') {
    if (scenario === 'health-auth') { json(res, 401, { error: 'unauthorized' }); return; }
    if (scenario === 'health-garbage') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('not-json'); return; }
    json(res, 200, { version: '2.2.7', pid: process.pid, hostname: 'fixture', urls: [`http://127.0.0.1:${port}`], paths: { tmp: '/tmp' }, capabilities: { persistentPty: true } });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const parsed = JSON.parse(await body(req));
    session.model = parsed.model;
    session.location = parsed.location;
    session.permissions = parsed.permissions;
    json(res, 200, { data: { id: sessionId, projectID: 'fixture', model: parsed.model, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now(), updated: Date.now() }, location: parsed.location } });
    return;
  }
  const instructions = /^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'PUT' && instructions && instructions[1] === sessionId) {
    const parsed = JSON.parse(await body(req));
    session.instructions = parsed.value;
    res.writeHead(204); res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    sse = res;
    event('server.connected', {});
    req.on('close', () => { if (sse === res) sse = undefined; });
    return;
  }
  if (req.method === 'POST' && url.pathname === `/api/session/${sessionId}/prompt`) {
    const parsed = JSON.parse(await body(req));
    const promptID = typeof parsed.id === 'string' ? parsed.id : `msg_p${++promptSeq}`;
    json(res, 200, { data: { id: promptID, sessionID: sessionId, time: { created: Date.now() }, type: 'user', payload: { text: parsed.text }, delivery: 'steer' } });
    void runTurn({ ...parsed, id: promptID });
    return;
  }
  if (req.method === 'POST' && url.pathname === `/api/session/${sessionId}/interrupt`) {
    log({ abort: true, turn: active?.turn });
    if (scenario === 'abort-false') { json(res, 200, { interrupted: false }); return; }
    json(res, 200, { interrupted: true });
    if (scenario === 'abort' || scenario === 'abort-error') {
      if (active) {
        event('session.step.failed', { sessionID: sessionId, assistantMessageID: active.assistants.at(-1) || 'msg_a1', error: { type: 'aborted', message: 'Step interrupted' } });
        setTimeout(() => event('session.execution.interrupted', { sessionID: sessionId, reason: 'user' }), 20);
      }
    }
    if (scenario === 'abort-early') {
      setTimeout(() => {
        if (!active) return;
        event('session.step.failed', { sessionID: sessionId, assistantMessageID: active.assistants.at(-1) || 'msg_a1', error: { type: 'aborted', message: 'Step interrupted' } });
        event('session.execution.interrupted', { sessionID: sessionId, reason: 'user' });
      }, 250);
    }
    if (scenario === 'progress-abort' && active) {
      const id = active.assistants.at(-1) || 'msg_a1';
      event('session.tool.input.started', { sessionID: sessionId, assistantMessageID: id, id: 'call_late', name: 'grep' });
      event('session.step.failed', { sessionID: sessionId, assistantMessageID: id, error: { type: 'aborted', message: 'Step interrupted' } });
      setTimeout(() => event('session.execution.interrupted', { sessionID: sessionId, reason: 'user' }), 20);
    }
    if (scenario === 'abort-missing-idle') {
      // ACK without any native terminal: the adapter must not claim a confirmed stop.
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === `/api/session/${sessionId}/message`) {
    const order = url.searchParams.get('order');
    const data = order === 'asc' ? messages : [...messages].reverse();
    json(res, 200, { data, cursor: { previous: null, next: null } });
    return;
  }
  if (req.method === 'GET' && url.pathname === `/api/session/${sessionId}`) {
    json(res, 200, { data: { ...session, projectID: 'fixture', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now(), updated: Date.now() } } });
    return;
  }
  if (req.method === 'DELETE' && url.pathname === `/api/session/${sessionId}`) {
    log({ deleted: true });
    res.writeHead(204); res.end();
    return;
  }
  const permission = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(url.pathname);
  if (req.method === 'POST' && permission && permission[1] === sessionId) {
    const parsed = JSON.parse(await body(req));
    log({ permissionReply: { id: permission[2], decision: parsed.decision } });
    res.writeHead(204); res.end();
    finishAfterPermission(parsed.decision);
    return;
  }
  const form = /^\/api\/session\/([^/]+)\/form\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && form && form[1] === sessionId) {
    log({ formCancelled: form[2] });
    res.writeHead(204); res.end();
    event('form.cancelled', { id: form[2], sessionID: sessionId });
    finishAfterForm();
    return;
  }
  json(res, 404, { error: 'not found', path: url.pathname });
});

if (!port) { log({ error: 'missing port' }); process.exit(2); }
server.listen(port, '127.0.0.1', () => {
  const announced = scenario === 'bad-url' ? `http://127.0.0.1:${port + 1}` : `http://127.0.0.1:${port}`;
  process.stdout.write(`server listening on ${announced}\n`);
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
