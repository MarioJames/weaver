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
  // Hidden Master identity turn: the host sends imMasterIdentityPrompt() once after native
  // startup and only treats the trimmed WEAVER_MASTER_READY reply as ready. Identity turns
  // bypass scenario counters and the main marker log so existing user-turn expectations
  // (turn numbers, marker line counts) stay intact; dedicated identity-* scenarios drive
  // failure-path tests without affecting normal user turns.
  try {
    if (JSON.stringify(prompt ?? '').includes('WEAVER_MASTER_READY')) {
      const promptID = prompt.messageID;
      const assistantID = 'msg_identity';
      const partID = 'prt_identity_1';
      await sleep(10);
      if (scenario === 'identity-hang') return;
      if (scenario === 'identity-auth') {
        event('session.error', { sessionID: sessionId, error: { name: 'ProviderAuthError', data: { providerID: 'fixture-provider', message: 'not authenticated' } } });
        return;
      }
      // Real 2026-10-22 native evidence: opencode-go/muse-spark-1.3-contributor
      // accepts variant=xhigh (204) yet the hidden turn resolves with a narration
      // prefix plus the marker. The strict host gate must still fail closed as
      // protocol; a contains-check would fake ready and is forbidden.
      // identity-split replays the corrected root cause: the progress paragraph lives
      // in an intermediate tool-calls assistant while the true terminal assistant holds
      // only the marker. Default aggregate keeps both paragraphs; final-only resolves
      // the terminal message alone.
      if (scenario === 'identity-split') {
        const progressID = 'msg_identity_progress';
        const progressPart = 'prt_identity_progress';
        const progressText = '身份初始化中，接线完成。';
        const progressInfo = { ...assistantInfo(progressID, promptID, undefined, 'tool-calls'), time: { created: Date.now(), completed: Date.now() } };
        event('message.updated', { sessionID: sessionId, info: progressInfo });
        event('message.part.updated', { sessionID: sessionId, part: { id: progressPart, sessionID: sessionId, messageID: progressID, type: 'text', text: '' } });
        event('message.part.delta', { sessionID: sessionId, messageID: progressID, partID: progressPart, field: 'text', delta: progressText });
        event('message.part.updated', { sessionID: sessionId, part: { id: progressPart, sessionID: sessionId, messageID: progressID, type: 'text', text: progressText } });
        event('message.part.updated', { sessionID: sessionId, part: { id: 'prt_identity_tool', sessionID: sessionId, messageID: progressID, type: 'tool', tool: 'read', state: { status: 'completed' } } });
        await sleep(20);
        const finalText = 'WEAVER_MASTER_READY';
        event('message.updated', { sessionID: sessionId, info: assistantInfo(assistantID, promptID) });
        event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
        event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: finalText });
        event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: finalText } });
        messages.push(
          { info: progressInfo, parts: [
            { id: progressPart, sessionID: sessionId, messageID: progressID, type: 'text', text: progressText },
            { id: 'prt_identity_tool', sessionID: sessionId, messageID: progressID, type: 'tool', tool: 'read', state: { status: 'completed' } },
          ] },
          messageEntry(assistantID, promptID, [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: finalText }]),
        );
        event('session.idle', { sessionID: sessionId });
        return;
      }
      const text = scenario === 'identity-wrong' ? 'WRONG-MARKER' : scenario === 'identity-prefix' ? '身份初始化中，只输出就绪标记。WEAVER_MASTER_READY' : 'WEAVER_MASTER_READY';
      event('message.updated', { sessionID: sessionId, info: assistantInfo(assistantID, promptID) });
      event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
      event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: text });
      event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text } });
      messages.push(messageEntry(assistantID, promptID, [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text }]));
      event('session.idle', { sessionID: sessionId });
      return;
    }
  } catch { /* fall through to the normal path */ }
  const current = ++turn;
  const assistantID = `msg_a${current}`;
  const partID = `prt_${current}_1`;
  const promptID = prompt.messageID;
  log({ pid: process.pid, turn: current, messageID: promptID, model: prompt.model, variant: prompt.variant, system: prompt.system, text: prompt.parts?.[0]?.text });
  if (scenario === 'stale-success' || scenario === 'stale-cancel' || scenario === 'abort-error' || scenario === 'abort-early' || scenario === 'intermediate-success' || scenario === 'intermediate-cancel' || scenario === 'missing-finish' || scenario === 'finalize-race') {
    active = { turn: current, promptID, assistantID };
  }
  await sleep(10);
  if (scenario === 'stale-success') {
    // Current turn binds but stays generating (no time.completed); a stale same-session idle
    // arrives first and must not settle the turn. The true terminal follows ~400ms later.
    active = { turn: current, promptID, assistantID };
    event('message.updated', { sessionID: sessionId, info: assistantInfoOpen(assistantID, promptID) });
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
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
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
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
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
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
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
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
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
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
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
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
    event('message.part.updated', { sessionID: sessionId, part: { id: `prt_${current}_2`, sessionID: sessionId, messageID: secondID, type: 'text', text: '' } });
    event('message.part.delta', { sessionID: sessionId, messageID: secondID, partID: `prt_${current}_2`, field: 'text', delta: '最终' });
    event('message.part.updated', { sessionID: sessionId, part: { id: `prt_${current}_2`, sessionID: sessionId, messageID: secondID, type: 'text', text: '最终' } });
    messages = [
      { info: assistantInfo(assistantID, promptID, undefined, 'tool-calls'), parts: [{ id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '中间-' }] },
      { info: assistantInfo(secondID, promptID), parts: [{ id: `prt_${current}_2`, sessionID: sessionId, messageID: secondID, type: 'text', text: '最终' }] },
    ];
    event('session.idle', { sessionID: sessionId });
    return;
  }
  if (scenario === 'reasoning-stream') {
    // The native producer uses field:"text" for both public text and reasoning deltas; only
    // the part metadata distinguishes them. Cover metadata-before-delta and delta-before-
    // metadata for a private reasoning part, then a normally streamed public text part.
    const known = `prt_reason_${current}`;
    const unknown = `prt_reason_unknown_${current}`;
    active = { turn: current, promptID, assistantID };
    event('message.updated', { sessionID: sessionId, info: assistantInfoOpen(assistantID, promptID) });
    event('message.part.updated', { sessionID: sessionId, part: { id: known, sessionID: sessionId, messageID: assistantID, type: 'reasoning', text: 'SECRET_REASONING' } });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID: known, field: 'text', delta: 'SECRET_REASONING_DELTA' });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID: unknown, field: 'text', delta: 'SECRET_UNKNOWN_DELTA' });
    event('message.part.updated', { sessionID: sessionId, part: { id: unknown, sessionID: sessionId, messageID: assistantID, type: 'reasoning', text: 'SECRET_UNKNOWN_DELTA' } });
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: '公开' });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: '-正文' });
    await sleep(20);
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '公开-正文' } });
    messages = [{ info: assistantInfo(assistantID, promptID), parts: [
      { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '公开-正文' },
      { id: known, sessionID: sessionId, messageID: assistantID, type: 'reasoning', text: 'SECRET_REASONING_DELTA' },
      { id: unknown, sessionID: sessionId, messageID: assistantID, type: 'reasoning', text: 'SECRET_UNKNOWN_DELTA' },
    ] }];
    event('session.idle', { sessionID: sessionId });
    return;
  }
  if (scenario === 'buffered-private') {
    // Private metadata and deltas arrive before the assistant binding. Replay must preserve
    // the original type/flags, drop the reasoning deltas, and still flush the later public text.
    const reasoning = `prt_buf_reason_${current}`;
    const synthetic = `prt_buf_synthetic_${current}`;
    active = { turn: current, promptID, assistantID };
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID: reasoning, field: 'text', delta: 'SECRET_BUFFERED_DELTA' });
    event('message.part.updated', { sessionID: sessionId, part: { id: reasoning, sessionID: sessionId, messageID: assistantID, type: 'reasoning', text: 'SECRET_BUFFERED_DELTA' } });
    event('message.part.updated', { sessionID: sessionId, part: { id: synthetic, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'SECRET_BUFFERED_SYNTHETIC', synthetic: true } });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID: synthetic, field: 'text', delta: 'SECRET_BUFFERED_SYNTHETIC_DELTA' });
    event('message.updated', { sessionID: sessionId, info: assistantInfoOpen(assistantID, promptID) });
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'BUFFERED-PUBLIC' });
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'BUFFERED-PUBLIC' } });
    messages = [{ info: assistantInfo(assistantID, promptID), parts: [
      { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'BUFFERED-PUBLIC' },
      { id: reasoning, sessionID: sessionId, messageID: assistantID, type: 'reasoning', text: 'SECRET_BUFFERED_DELTA' },
      { id: synthetic, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'SECRET_BUFFERED_SYNTHETIC', synthetic: true },
    ] }];
    event('session.idle', { sessionID: sessionId });
    return;
  }
  if (scenario === 'synthetic-text') {
    // Synthetic and ignored text parts use type:"text" but are not public conversation text.
    // Neither their deltas nor their final snapshots may stream or reach the final text.
    const synthetic = `prt_synthetic_${current}`;
    const ignored = `prt_ignored_${current}`;
    active = { turn: current, promptID, assistantID };
    event('message.updated', { sessionID: sessionId, info: assistantInfoOpen(assistantID, promptID) });
    event('message.part.updated', { sessionID: sessionId, part: { id: synthetic, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'SECRET_SYNTHETIC', synthetic: true } });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID: synthetic, field: 'text', delta: 'SECRET_SYNTHETIC_DELTA' });
    event('message.part.updated', { sessionID: sessionId, part: { id: ignored, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'SECRET_IGNORED', ignored: true } });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID: ignored, field: 'text', delta: 'SECRET_IGNORED_DELTA' });
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
    event('message.part.delta', { sessionID: sessionId, messageID: assistantID, partID, field: 'text', delta: 'PUBLIC' });
    event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PUBLIC' } });
    messages = [{ info: assistantInfo(assistantID, promptID), parts: [
      { id: synthetic, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'SECRET_SYNTHETIC', synthetic: true },
      { id: ignored, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'SECRET_IGNORED', ignored: true },
      { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: 'PUBLIC' },
    ] }];
    event('session.idle', { sessionID: sessionId });
    return;
  }
  if (scenario === 'progress' || scenario === 'progress-abort') {
    // Native 1.19.3 Part shapes (installed @opencode-ai/sdk types.gen.d.ts): ToolPart is
    // {id,sessionID,messageID,type:"tool",callID,tool,state}; StepStartPart is {type:"step-start"}.
    // Only `tool` is a public label: state.input/title/output/metadata carry SECRET_* canaries.
    // A subagent runs in its own native child session, so its tool part has a foreign
    // sessionID; a `subtask` part is a separate Part type, not a ToolPart.
    const stepID = `prt_step_${current}`;
    const bashPart = `prt_tool_bash_${current}`;
    const bashCall = `call_${current}_bash`;
    const readPart = `prt_tool_read_${current}`;
    const readCall = `call_${current}_read`;
    const toolState = (status, input) => ({ status, input, ...(status === 'completed' ? { output: 'SECRET_TOOL_OUTPUT', title: 'SECRET_TOOL_TITLE', metadata: { path: '/home/test/SECRET_PATH' }, time: { start: Date.now(), end: Date.now() } } : status === 'running' ? { title: 'SECRET_TOOL_TITLE', metadata: { path: '/home/test/SECRET_PATH' }, time: { start: Date.now() } } : { raw: 'SECRET_RAW' }) });
    active = { turn: current, promptID, assistantID };
    event('message.updated', { sessionID: sessionId, info: assistantInfoOpen(assistantID, promptID) });
    event('message.part.updated', { sessionID: sessionId, part: { id: stepID, sessionID: sessionId, messageID: assistantID, type: 'step-start' } });
    event('message.part.updated', { sessionID: sessionId, part: { id: bashPart, sessionID: sessionId, messageID: assistantID, type: 'tool', callID: bashCall, tool: 'bash', state: toolState('pending', { command: 'curl -H "Authorization: Bearer SECRET_TOOL_TOKEN" https://example.test/SECRET_PATH' }) } });
    event('message.part.updated', { sessionID: sessionId, part: { id: bashPart, sessionID: sessionId, messageID: assistantID, type: 'tool', callID: bashCall, tool: 'bash', state: toolState('running', { command: 'cat /home/test/SECRET_PATH' }) } });
    event('message.part.updated', { sessionID: sessionId, part: { id: bashPart, sessionID: sessionId, messageID: assistantID, type: 'tool', callID: bashCall, tool: 'bash', state: toolState('completed', { command: 'cat /home/test/SECRET_PATH' }) } });
    event('message.part.updated', { sessionID: sessionId, part: { id: readPart, sessionID: sessionId, messageID: assistantID, type: 'tool', callID: readCall, tool: 'read', state: toolState('pending', { filePath: '/home/test/SECRET_FILE' }) } });
    event('message.part.updated', { sessionID: sessionId, part: { id: readPart, sessionID: sessionId, messageID: assistantID, type: 'tool', callID: readCall, tool: 'read', state: toolState('completed', { filePath: '/home/test/SECRET_FILE' }) } });
    // Nested subagent tool part: native child session, must not be attributed to this turn.
    event('message.part.updated', { sessionID: 'ses_fixture_child', part: { id: `prt_child_${current}`, sessionID: 'ses_fixture_child', messageID: 'msg_child', type: 'tool', callID: `call_child_${current}`, tool: 'webfetch', state: toolState('pending', { url: 'https://example.test/SECRET_CHILD' }) } });
    // A subtask Part names its subagent; it is not a ToolPart and never emits progress.
    event('message.part.updated', { sessionID: sessionId, part: { id: `prt_subtask_${current}`, sessionID: sessionId, messageID: assistantID, type: 'subtask', agent: 'explore', description: 'SECRET_SUBTASK_DESCRIPTION', prompt: 'SECRET_SUBTASK_PROMPT' } });
    // A tool part on a different message of this session is not the bound current-turn assistant.
    event('message.part.updated', { sessionID: sessionId, part: { id: `prt_foreign_tool_${current}`, sessionID: sessionId, messageID: 'msg_foreign', type: 'tool', callID: `call_foreign_${current}`, tool: 'grep', state: toolState('pending', { pattern: 'SECRET_PATTERN' }) } });
    if (scenario === 'progress-abort') return; // the abort reply drives the native terminal
    event('message.updated', { sessionID: sessionId, info: assistantInfo(assistantID, promptID, undefined, 'tool-calls') });
    await sleep(10);
    const secondID = `msg_a${current}_final`;
    const finalPart = `prt_${current}_final`;
    event('message.updated', { sessionID: sessionId, info: assistantInfoOpen(secondID, promptID) });
    event('message.part.updated', { sessionID: sessionId, part: { id: `prt_step_final_${current}`, sessionID: sessionId, messageID: secondID, type: 'step-start' } });
    event('message.part.updated', { sessionID: sessionId, part: { id: finalPart, sessionID: sessionId, messageID: secondID, type: 'text', text: '' } });
    event('message.part.delta', { sessionID: sessionId, messageID: secondID, partID: finalPart, field: 'text', delta: '进度' });
    event('message.part.delta', { sessionID: sessionId, messageID: secondID, partID: finalPart, field: 'text', delta: '完成' });
    event('message.part.updated', { sessionID: sessionId, part: { id: finalPart, sessionID: sessionId, messageID: secondID, type: 'text', text: '进度完成' } });
    messages = [
      { info: assistantInfo(assistantID, promptID, undefined, 'tool-calls'), parts: [
        { id: stepID, sessionID: sessionId, messageID: assistantID, type: 'step-start' },
        { id: bashPart, sessionID: sessionId, messageID: assistantID, type: 'tool', callID: bashCall, tool: 'bash', state: toolState('completed', { command: 'cat /home/test/SECRET_PATH' }) },
        { id: readPart, sessionID: sessionId, messageID: assistantID, type: 'tool', callID: readCall, tool: 'read', state: toolState('completed', { filePath: '/home/test/SECRET_FILE' }) },
        { id: `prt_subtask_${current}`, sessionID: sessionId, messageID: assistantID, type: 'subtask', agent: 'explore', description: 'SECRET_SUBTASK_DESCRIPTION', prompt: 'SECRET_SUBTASK_PROMPT' },
      ] },
      messageEntry(secondID, promptID, [{ id: finalPart, sessionID: sessionId, messageID: secondID, type: 'text', text: '进度完成' }]),
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
  event('message.part.updated', { sessionID: sessionId, part: { id: partID, sessionID: sessionId, messageID: assistantID, type: 'text', text: '' } });
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
  event('message.part.updated', { sessionID: sessionId, part: { id: 'prt_1', sessionID: sessionId, messageID: active.assistantID, type: 'text', text: '' } });
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
    if (scenario === 'progress-abort' && active) {
      // A post-abort tool frame for the same bound message must never reach onProgress: the
      // adapter clears the callback on cancellation and ignores events while cancelError is set.
      event('message.part.updated', { sessionID: sessionId, part: { id: `prt_tool_late_${active.turn}`, sessionID: sessionId, messageID: active.assistantID, type: 'tool', callID: `call_late_${active.turn}`, tool: 'grep', state: { status: 'pending', input: { pattern: 'SECRET_PATTERN' }, raw: 'SECRET_RAW' } } });
      const error = { name: 'MessageAbortedError', data: { message: 'aborted' } };
      const aid = active.assistantID;
      messages = [{ info: { ...assistantInfoOpen(aid, active.promptID), error }, parts: [] }];
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
      event('message.part.updated', { sessionID: sessionId, part: { id: `prt_q_${active.turn}`, sessionID: sessionId, messageID: active.assistantID, type: 'text', text: '' } });
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
