#!/usr/bin/env node
// OpenCode serve/SSE fixture for adapter tests. Implements the subset of the 1.19.3 OpenAPI
// schema the parent uses (health, session create/delete, event SSE, prompt_async, abort,
// message list, permission reply) without contacting a model.
// Scenario selection: OPENCODE_FIXTURE_SCENARIO. Markers: OPENCODE_FIXTURE_MARKER.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

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
let holdFirstMessageGet = false;
const pendingPermissions = new Map();

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
function event(type, properties) {
  if (!sse) return;
  sse.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
}
function assistantInfo(id, parentID, error, finish = 'stop') {
  return { id, sessionID: sessionId, role: 'assistant', parentID, modelID: 'fixture-model', providerID: 'fixture-provider', time: { created: Date.now(), completed: Date.now() }, ...(error ? { error } : {}), ...(finish ? { finish } : {}) };
}
function assistantInfoOpen(id, parentID) {
  return { id, sessionID: sessionId, role: 'assistant', parentID, modelID: 'fixture-model', providerID: 'fixture-provider', time: { created: Date.now() } };
}
function messageEntry(id, parentID, parts, error) { return { info: assistantInfo(id, parentID, error), parts }; }

function completeAfterPermission(type, props) {
  if (type === 'permission.asked') {
    pendingPermissions.set(props.id, { kind: 'legacy', patterns: props.patterns });
  } else if (type === 'permission.v2.asked') {
    pendingPermissions.set(props.id, { kind: 'v2' });
  } else {
    pendingPermissions.set(props.id, { kind: 'question' });
  }
}

async function runTurn(frame, prompt) {
  const current = ++turn;
  const assistantID = `msg_a${current}`;
  const partID = `prt_${current}_1`;
  const promptID = prompt.messageID;
  log({ pid: process.pid, turn: current, messageID: promptID, model: prompt.model, variant: prompt.variant, text: prompt.parts?.[0]?.text });
  if (scenario === 'stale-success' || scenario === 'stale-cancel' || scenario === 'abort-error' || scenario === 'abort-early' || scenario === 'intermediate-success' || scenario === 'intermediate-cancel' || scenario === 'missing-finish' || scenario === 'finalize-race') {
    active = { turn: current, promptID, assistantID };
  }
  await sleep(10);
  if (scenario === 'stale-success') {
    // Current turn binds but stays generating (no time.completed); a stale same-session idle
    // arrives first and must not settle the turn. The true terminal follows ~400ms later.
    active = { turn: current, promptID, assistantID };
    event('message.updated', { sessionID: sessionId, info: assistantInfoOpen(assistantID, promptID) });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'PARTIAL-' });
    messages = [{ info: assistantInfoOpen(assistantID, promptID), parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-' }] }];
    event('session.idle', { sessionID: sessionId });
    await sleep(400);
    if (active?.turn !== current) return;
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'FULL' });
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-FULL' } });
    event('message.updated', { sessionID: sessionId, info: { ...assistantInfo(assistantID, promptID), finish: 'stop' } });
    messages = [{ info: { ...assistantInfo(assistantID, promptID), finish: 'stop' }, parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-FULL' }] }];
    event('session.idle', { sessionID: sessionId });
    return;
  }
  if (scenario === 'stale-cancel') {
    // Current turn binds and stays generating forever; abort returns true but only a stale
    // same-session idle follows while the message still has no completed/error and the turn
    // is still busy. The adapter must not report a confirmed stop from this sequence.
    active = { turn: current, promptID, assistantID };
    event('message.updated', { sessionID: sessionId, info: assistantInfoOpen(assistantID, promptID) });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'PARTIAL-' });
    messages = [{ info: assistantInfoOpen(assistantID, promptID), parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-' }] }];
    return;
  }
  if (scenario === 'intermediate-success' || scenario === 'intermediate-cancel') {
    // Native-faithful intermediate tool step: the assistant message is stored with
    // time.completed AND finish:"tool-calls" while the turn keeps running (status busy).
    // A stale same-session idle follows. Only a later finish:"stop" message plus idle ends
    // the turn (intermediate-success); intermediate-cancel never completes.
    const mid = { id: assistantID, sessionID: sessionId, role: 'assistant', parentID: promptID, modelID: 'fixture-model', providerID: 'fixture-provider', time: { created: Date.now(), completed: Date.now() }, finish: 'tool-calls' };
    active = { turn: current, promptID, assistantID };
    event('message.updated', { sessionID: sessionId, info: mid });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'PARTIAL-' });
    messages = [{ info: mid, parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-' }] }];
    event('session.status', { sessionID: sessionId, status: { type: 'busy' } });
    event('session.idle', { sessionID: sessionId });
    if (scenario === 'intermediate-cancel') return;
    await sleep(400);
    if (active?.turn !== current) return;
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'FULL' });
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-FULL' } });
    event('message.updated', { sessionID: sessionId, info: { ...assistantInfo(assistantID, promptID), finish: 'stop' } });
    messages = [{ info: { ...assistantInfo(assistantID, promptID), finish: 'stop' }, parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-FULL' }] }];
    event('session.idle', { sessionID: sessionId });
    return;
  }
  if (scenario === 'missing-finish') {
    // Completed observation without `finish`: insufficient, never terminal. A same-session
    // idle follows while the message carries time.completed but no finish; only a later
    // finish:"stop" message plus idle ends the turn.
    const open = { id: assistantID, sessionID: sessionId, role: 'assistant', parentID: promptID, modelID: 'fixture-model', providerID: 'fixture-provider', time: { created: Date.now(), completed: Date.now() } };
    active = { turn: current, promptID, assistantID };
    event('message.updated', { sessionID: sessionId, info: open });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'PARTIAL-' });
    messages = [{ info: open, parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-' }] }];
    event('session.status', { sessionID: sessionId, status: { type: 'busy' } });
    event('session.idle', { sessionID: sessionId });
    await sleep(400);
    if (active?.turn !== current) return;
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'FULL' });
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-FULL' } });
    event('message.updated', { sessionID: sessionId, info: { ...assistantInfo(assistantID, promptID), finish: 'stop' } });
    messages = [{ info: { ...assistantInfo(assistantID, promptID), finish: 'stop' }, parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-FULL' }] }];
    event('session.idle', { sessionID: sessionId });
    return;
  }
  if (scenario === 'finalize-race') {
    // The first GET /message is held open while the true terminal (completed finish:"stop"
    // plus idle) arrives mid-fetch; the held read then answers with the stale open snapshot.
    // The adapter must re-check instead of dropping that wake and stalling to turn timeout.
    active = { turn: current, promptID, assistantID };
    event('message.updated', { sessionID: sessionId, info: assistantInfoOpen(assistantID, promptID) });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'PARTIAL-' });
    messages = [{ info: assistantInfoOpen(assistantID, promptID), parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-' }] }];
    holdFirstMessageGet = true;
    event('session.idle', { sessionID: sessionId });
    await sleep(150);
    if (active?.turn !== current) return;
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'FULL' });
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-FULL' } });
    event('message.updated', { sessionID: sessionId, info: { ...assistantInfo(assistantID, promptID), finish: 'stop' } });
    messages = [{ info: { ...assistantInfo(assistantID, promptID), finish: 'stop' }, parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-FULL' }] }];
    event('session.idle', { sessionID: sessionId });
    return;
  }
  if (scenario === 'abort-error') {
    // Abort arrives mid-generation; the server records a native MessageAbortedError terminal.
    active = { turn: current, promptID, assistantID };
    event('message.updated', { sessionID: sessionId, info: assistantInfoOpen(assistantID, promptID) });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'PARTIAL-' });
    messages = [{ info: assistantInfoOpen(assistantID, promptID), parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-' }] }];
    return;
  }
  if (scenario === 'abort-early') {
    // Abort arrives before the first assistant binds; the terminal (abort error) follows late.
    active = { turn: current, promptID, assistantID };
    await sleep(250);
    if (active?.turn !== current) return;
    const error = { name: 'MessageAbortedError', data: { message: 'aborted' } };
    event('message.updated', { sessionID: sessionId, info: { ...assistantInfoOpen(assistantID, promptID), error } });
    messages = [{ info: { ...assistantInfoOpen(assistantID, promptID), error }, parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PARTIAL-' }] }];
    event('session.idle', { sessionID: sessionId });
    return;
  }
  if (scenario === 'midturn-exit') {
    // Mid-turn engine death: bind and stream a delta, then the whole fixture process exits.
    // The adapter fails the session and rejects the send while `unavailable` fires; the host
    // must still deliver the terminal error frame before tearing down the socket.
    event('message.updated', { sessionID: sessionId, info: assistantInfoOpen(assistantID, promptID) });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'PARTIAL-' });
    setTimeout(() => process.exit(1), 50);
    return;
  }
  if (scenario === 'multi-assistant') {
    // Two assistant messages under the same prompt: an intermediate tool assistant completes
    // while the turn continues. Only the newest current-turn assistant proves the final turn,
    // and public text must not truncate to the first nor leak reasoning/tool parts.
    const secondID = `msg_a${current}_b`;
    event('message.updated', { sessionID: sessionId, info: assistantInfo(assistantID, promptID, undefined, 'tool-calls') });
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '中间-' } });
    event('message.part.updated', { sessionID: sessionId, part: { id: `prt_think_${current}`, sessionID: sessionId, messageID: assistantID, type: 'reasoning', text: 'SECRET_REASONING' } });
    event('message.updated', { sessionID: sessionId, info: assistantInfo(secondID, promptID) });
    event('message.part.delta', { sessionID: sessionId, messageID: secondID, partID: `prt_${current}_2`, field: 'text', delta: '最终' });
    event('message.part.updated', { sessionID: sessionId, part: { id: `prt_${current}_2`, sessionID: sessionId, messageID: secondID, type: 'text', text: '最终' } });
    messages = [
      { info: assistantInfo(assistantID, promptID, undefined, 'tool-calls'), parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '中间-' }] },
      { info: assistantInfo(secondID, promptID), parts: [{ id: `prt_${current}_2`, sessionID: sessionId, messageID: secondID, type: 'text', text: '最终' }] },
    ];
    event('session.idle', { sessionID: sessionId });
    return;
  }
  if (scenario === 'auth') {
    event('session.error', { sessionID: sessionId, error: { name: 'ProviderAuthError', data: { providerID: 'fixture-provider', message: 'not authenticated' } } });
    return;
  }
  if (scenario === 'wrong-session') {
    event('message.updated', { sessionID: 'ses_other', info: assistantInfo('msg_other', promptID) });
    event('message.part.delta', { sessionID: 'ses_other', messageID: 'msg_other', partID: 'prt_other', field: 'text', delta: 'SECRET_FOREIGN' });
    return;
  }
  if (scenario === 'permission' || scenario === 'permission-denied' || scenario === 'permission-v2' || scenario === 'question') {
    active = { turn: current, promptID, assistantID };
    const props = typeForScenario();
    completeAfterPermission(props.type, props.properties);
    event(props.type, props.properties);
    return;
  }
  if (scenario === 'delta-first') {
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: '你好，' });
  }
  event('message.updated', { sessionID: sessionId, info: assistantInfo(assistantID, promptID) });
  event('message.updated', { sessionID: sessionId, info: assistantInfo('msg_foreign', 'msg_not_mine') });
  event('message.part.delta', { sessionID: sessionId, messageID: 'msg_foreign', partID: 'prt_for', field: 'text', delta: 'SECRET_FOREIGN' });
  event('message.part.updated', { sessionID: sessionId, part: { id: `prt_think_${current}`, sessionID: sessionId, messageID: assistantID, type: 'reasoning', text: 'SECRET_REASONING' } });
  event('message.part.updated', { sessionID: sessionId, part: { id: `prt_tool_${current}`, sessionID: sessionId, messageID: assistantID, type: 'tool', tool: 'bash', state: { status: 'completed' } } });
  if (scenario !== 'delta-first') {
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: '你好，' });
  }
  event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID: `prt_thinking_${current}`, field: 'thinking', delta: 'SECRET_THINKING' });
  await sleep(20);
  const finalText = scenario === 'divergent' ? 'DIVERGENT' : `你好，世界${current}`;
  event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: finalText } });
  event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: finalText } });
  if (scenario === 'missing-final') {
    messages.push(messageEntry(assistantID, promptID, []));
  } else {
    messages.push(messageEntry(assistantID, promptID, [
      { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: finalText },
      { id: `prt_think_${current}`, sessionID: sessionId, messageID: assistantID, type: 'reasoning', text: 'SECRET_REASONING' },
    ]));
  }
  if (scenario === 'missing-idle') return;
  if (scenario === 'abort-missing-idle' && current === 1) return;
  event('session.idle', { sessionID: sessionId });
}

function typeForScenario() {
  if (scenario === 'permission-v2') return { type: 'permission.v2.asked', properties: { id: 'per_v2', sessionID: sessionId, action: 'external_directory', resources: ['/etc/passwd'] } };
  if (scenario === 'question') return { type: 'question.asked', properties: { id: 'que_1', sessionID: sessionId, questions: [{ question: 'Allow?' }] } };
  const workspace = process.cwd();
  const allowed = scenario === 'permission';
  return { type: 'permission.asked', properties: { id: 'per_1', sessionID: sessionId, permission: 'external_directory', patterns: [allowed ? `${workspace}/extra` : '/etc/passwd'], metadata: {}, always: [] } };
}

function respondPermission(kind, reply) {
  log({ permissionReply: { kind, reply } });
  if (!active) return;
  event('message.updated', { sessionID: sessionId, info: assistantInfo(active.assistantID, active.promptID) });
  event('message.part.delta', { sessionID: sessionId, messageID: active.assistantID, partID: 'prt_1', field: 'text', delta: '工具请求已处理' });
  messages.push(messageEntry(active.assistantID, active.promptID, [{ id: 'prt_1', sessionID: sessionId, messageID: active.assistantID, type: 'text', text: '工具请求已处理' }]));
  event('session.idle', { sessionID: sessionId });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }
  if (req.method === 'GET' && url.pathname === '/global/health') {
    if (scenario === 'health-auth') { json(res, 401, { error: 'unauthorized' }); return; }
    if (scenario === 'health-garbage') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('not-json'); return; }
    json(res, 200, { healthy: true, version: '1.19.3' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/session') {
    json(res, 200, { id: sessionId, slug: 'fixture', projectID: 'global', directory: process.cwd(), path: process.cwd(), time: { created: Date.now(), updated: Date.now() } });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': fixture\n\n');
    sse = res;
    req.on('close', () => { if (sse === res) sse = undefined; });
    return;
  }
  if (req.method === 'POST' && url.pathname === `/session/${sessionId}/prompt_async`) {
    const text = await body(req);
    let prompt;
    try { prompt = JSON.parse(text); } catch { json(res, 400, { error: 'bad request' }); return; }
    res.writeHead(204); res.end();
    void runTurn(null, prompt);
    return;
  }
  if (req.method === 'POST' && url.pathname === `/session/${sessionId}/abort`) {
    log({ abort: true, turn: active?.turn });
    if (scenario === 'abort-false') { json(res, 200, false); return; }
    json(res, 200, true);
    if (scenario === 'abort') setTimeout(() => event('session.idle', { sessionID: sessionId }), 30);
    if (scenario === 'stale-cancel' || scenario === 'intermediate-cancel') {
      // Stale idle only: the current message keeps no terminal state and the turn stays busy.
      setTimeout(() => event('session.idle', { sessionID: sessionId }), 20);
    }
    if (scenario === 'abort-error' && active) {
      const error = { name: 'MessageAbortedError', data: { message: 'aborted' } };
      const aid = active.assistantID;
      messages = [{ info: { ...assistantInfoOpen(aid, active.promptID), error }, parts: [{ id: 'prt_abort', sessionID: sessionId, messageID: aid, type: 'text', text: 'PARTIAL-' }] }];
      setTimeout(() => {
        event('message.updated', { sessionID: sessionId, info: { ...assistantInfoOpen(aid, active.promptID), error } });
        event('session.idle', { sessionID: sessionId });
      }, 20);
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === `/session/${sessionId}/message`) {
    if (scenario === 'finalize-race' && holdFirstMessageGet) {
      holdFirstMessageGet = false;
      // Capture the stale open snapshot now; the true terminal lands while this read hangs.
      const stale = messages;
      await sleep(300);
      json(res, 200, stale);
      return;
    }
    json(res, 200, messages);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/session/status') {
    // Mirrors native 1.19.3: `{}` when nothing runs (missing key is idle-equivalent),
    // `{session: {type:"busy"}}` while a turn is generating. The adapter never settles a
    // turn from this map; authority is the message list finish/error.
    if (scenario === 'stale-success' || scenario === 'stale-cancel' || scenario === 'abort-error' || scenario === 'intermediate-success' || scenario === 'intermediate-cancel' || scenario === 'missing-finish' || scenario === 'finalize-race') json(res, 200, { [sessionId]: { type: 'busy' } });
    else json(res, 200, {});
    return;
  }
  if (req.method === 'DELETE' && url.pathname === `/session/${sessionId}`) { json(res, 200, true); return; }
  if (req.method === 'POST' && url.pathname === '/global/dispose') { json(res, 200, true); return; }
  const permission = /^\/(?:api\/session\/[^/]+\/)?permission\/([^/]+)\/reply$/.exec(url.pathname);
  if (req.method === 'POST' && permission) {
    const text = await body(req);
    let value;
    try { value = JSON.parse(text); } catch { json(res, 400, { error: 'bad request' }); return; }
    const kind = url.pathname.startsWith('/api/') ? 'v2' : 'legacy';
    respondPermission(kind, value.reply);
    if (kind === 'v2' || scenario === 'permission-v2') { res.writeHead(204); res.end(); }
    else json(res, 200, true);
    return;
  }
  const question = /^\/api\/session\/[^/]+\/question\/([^/]+)\/reject$/.exec(url.pathname);
  if (req.method === 'POST' && question) {
    log({ questionRejected: question[1] });
    res.writeHead(204); res.end();
    if (active) {
      event('message.updated', { sessionID: sessionId, info: assistantInfo(active.assistantID, active.promptID) });
      event('message.part.delta', { sessionID: sessionId, messageID: active.assistantID, partID: `prt_q_${active.turn}`, field: 'text', delta: '问题已拒绝' });
      messages.push(messageEntry(active.assistantID, active.promptID, [{ id: `prt_q_${active.turn}`, sessionID: sessionId, messageID: active.assistantID, type: 'text', text: '问题已拒绝' }]));
      event('session.idle', { sessionID: sessionId });
    }
    return;
  }
  json(res, 404, { error: 'not found', path: url.pathname });
});

if (!port) { log({ error: 'missing port' }); process.exit(2); }
server.listen(port, '127.0.0.1', () => {
  const announced = scenario === 'bad-url' ? `http://127.0.0.1:${port + 1}` : `http://127.0.0.1:${port}`;
  process.stdout.write(`opencode server listening on ${announced}\n`);
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
