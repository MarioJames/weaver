#!/usr/bin/env node
// dsh headless --json fixture for the IM parent adapter tests. It speaks the installed
// 0.2.1-rc.2 one-task-per-invocation contract: a persisted session id, committed public text,
// private thinking/tool events, a terminal final event, and process termination on SIGTERM.
// It contacts no model and never reads credentials.
// Scenario selection: DSH_FIXTURE_SCENARIO. Markers: DSH_FIXTURE_MARKER.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const scenario = process.env.DSH_FIXTURE_SCENARIO || 'default';
const marker = process.env.DSH_FIXTURE_MARKER;
const argv = process.argv.slice(2);
const patchIndex = argv.indexOf('--patch');
const overlayPath = patchIndex >= 0 ? argv[patchIndex + 1] : undefined;
const overlay = overlayPath ? readFileSync(overlayPath, 'utf8') : '';
const sessionIndex = argv.indexOf('--session-id');
const adopted = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
const json = argv.includes('--json');
const sessionId = adopted || process.env.DSH_FIXTURE_SESSION_ID || `session-${randomUUID()}`;
const emit = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const log = entry => { if (marker) appendFileSync(marker, `${JSON.stringify({ pid: process.pid, ...entry })}\n`, { mode: 0o600 }); };

log({ event: 'spawn', argv, cwd: process.cwd(), overlay, overlayPath, adopted, sessionId });
if (!json) { process.stderr.write('dsh fixture requires --json\n'); process.exitCode = 2; } else {
  let task = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { task += chunk; });
  process.stdin.on('end', () => { void run(task); });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let keepAlive;

function hold() {
  keepAlive = setInterval(() => {}, 1000);
}

process.on('SIGTERM', () => {
  log({ event: 'signal', signal: 'SIGTERM', sessionId });
  if (scenario === 'abort-ignore') return;
  process.exit(143);
});
process.on('SIGINT', () => {
  log({ event: 'signal', signal: 'SIGINT', sessionId });
  process.exit(130);
});

function completed(text) {
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  emit({ type: 'final', text });
  process.exitCode = 0;
}

async function run(task) {
  const hidden = task.includes('WEAVER_MASTER_READY');
  log({ event: 'task', hidden, sessionId, adopted: !!adopted, task });

  if (scenario === 'exit-before-session') {
    process.stderr.write('dsh: AUTH: authentication failed: missing credential\n');
    process.exitCode = 1;
    return;
  }

  if (hidden) {
    if (scenario === 'identity-hang') { emit({ type: 'session', sessionId, cwd: process.cwd() }); hold(); return; }
    emit({ type: 'session', sessionId, cwd: process.cwd() });
    emit({ type: 'status', phase: 'turn_start', turn: 1 });
    emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
    emit({ type: 'thinking', text: 'SECRET_IDENTITY_THINKING' });
    const text = scenario === 'identity-wrong' ? 'WRONG-MARKER' : 'WEAVER_MASTER_READY';
    if (scenario === 'identity-auth') {
      process.stderr.write('dsh: AUTH: authentication failed: 401 unauthorized\n');
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: 'authentication failed' } } });
      emit({ type: 'final', text: '' });
      process.exitCode = 1;
      return;
    }
    emit({ type: 'text', text });
    emit({ type: 'status', phase: 'step_end', turn: 1, step: 1 });
    completed(text);
    return;
  }

  if (scenario === 'wrong-session' && adopted) {
    emit({ type: 'session', sessionId: 'session-other', cwd: process.cwd() });
    emit({ type: 'final', text: 'wrong' });
    process.exitCode = 0;
    return;
  }

  if (scenario === 'abort-tree' && (task.includes('取消') || task.includes('first'))) {
    // A real tool descendant with its own long life and ignored SIGTERM. Only the owned
    // process tree/group kill may reclaim it; killing this fixture alone must not confirm.
    const ready = `${marker}.tool-ready-${process.pid}`;
    const tool = spawn(process.execPath, ['-e', `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},'1');setInterval(()=>{},1000)`], { stdio: 'ignore' });
    // Do not advertise the turn until the tool has installed its SIGTERM handler: the test
    // must prove a real ignored TERM needs the owned tree fallback, not a startup race.
    for (let i = 0; i < 400 && !existsSync(ready); i++) await sleep(5);
    log({ event: 'tool', toolPid: tool.pid });
    emit({ type: 'session', sessionId, cwd: process.cwd() });
    emit({ type: 'status', phase: 'turn_start', turn: 1 });
    emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
    emit({ type: 'thinking', text: 'SECRET_TREE_THINKING' });
    emit({ type: 'text', text: '你好，' });
    hold();
    return;
  }

  emit({ type: 'session', sessionId, cwd: process.cwd() });
  emit({ type: 'status', phase: 'turn_start', turn: 1 });

  if (scenario === 'auth') {
    process.stderr.write('dsh: AUTH: authentication failed: 401 unauthorized\n');
    emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: 'authentication failed: 401 unauthorized' } } });
    emit({ type: 'final', text: '' });
    process.exitCode = 1;
    return;
  }

  if (scenario === 'missing-final') {
    emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
    emit({ type: 'text', text: '无终结回答' });
    emit({ type: 'status', phase: 'step_end', turn: 1, step: 1 });
    process.exitCode = 0;
    return;
  }

  emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
  emit({ type: 'thinking', text: 'SECRET_THINKING' });
  emit({ type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command: 'SECRET_TOOL' } });
  emit({ type: 'text', text: '你好，' });
  emit({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'SECRET_TOOL_RESULT' });
  await sleep(5);
  emit({ type: 'text', text: '世界' });
  emit({ type: 'status', phase: 'step_end', turn: 1, step: 1 });

  if ((scenario === 'abort' || scenario === 'abort-ignore') && (task.includes('取消') || task.includes('first'))) {
    hold();
    return;
  }

  completed('你好，世界');
}
