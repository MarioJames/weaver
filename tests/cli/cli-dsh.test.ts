import { roleEngine } from '../../src/shared/policy/channels';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ENGINE_CATALOG, catalogEntry } from '../../src/shared/engines';
import { REAL_ENGINE_KINDS, isRealEngineKind } from '../../src/main/workspace';
import { EFFORTS } from '../../src/shared/policy/settings';
import { buildDshOverlayPatch, buildLaunchSpec } from '../../src/main/adapters/cli/argv';
import { prepareCliAgentInput } from '../../src/main/adapters/cli';
import { createNormalizer } from '../../src/main/adapters/cli/normalize';
import { classifyVendorError, classifyVendorEvent, vendorBlockReason } from '../../src/main/adapters/cli/vendor-errors';
import { EngineModelLister } from '../../src/main/engines/models';
import { HELLO_ENGINES, sayHi, type SpawnPrint } from '../../src/main/engines/hello';
import { EngineProber } from '../../src/main/engines/probe';
import { defaultConfig, validateConfig } from '../../src/main/policy/routing';
import { TaskStore } from '../../src/main/store';

const instruction = 'MARKER-dsh-only Reply PONG only.';

function dshAvailable(): boolean {
  try {
    execFileSync('dsh', ['--version'], { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

test('catalog lists dsh as its own real engine, unrelated to the opencode deepseek worker', () => {
  const entry = catalogEntry('dsh');
  assert.deepEqual(entry, { id: 'dsh', kind: 'dsh', command: 'dsh' });
  assert.ok(ENGINE_CATALOG.some(e => e.id === 'dsh' && e.kind === 'dsh' && e.command === 'dsh'));
  assert.ok((REAL_ENGINE_KINDS as readonly string[]).includes('dsh'));
  assert.equal(isRealEngineKind('dsh'), true);
  // The opencode deepseek worker stays exactly where it was: a worker on the opencode engine.
  const config = defaultConfig();
  assert.equal(roleEngine(config,config.workers.opencode_worker!), 'opencode');
});

test('dsh launch runs headless json from stdin with a private per-run overlay patch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-dsh-argv-'));
  try {
    const overlayPath = join(dir, 'state', 'dsh-overlay-test.yml');
    const spec = buildLaunchSpec({ engine: 'dsh', model: 'deepseek-flash', effort: 'high', workspace: dir, instruction, promptPath: join(dir, 'state', 'prompt.txt'), sessionDir: join(dir, 'state', 's'), leaderSocket: join(dir, 'state', 'l.sock'), overlayPath });
    assert.deepEqual(spec.argv, ['dsh', '--profile', 'headless', '--patch', overlayPath, '--json']);
    assert.equal(spec.stdin, instruction);
    assert.equal(spec.argv.some(arg => arg.includes('MARKER-dsh-only')), false, 'the prompt goes through stdin, never argv');
    assert.throws(() => buildLaunchSpec({ engine: 'dsh', model: 'deepseek-flash', effort: 'ultra', workspace: dir, instruction, promptPath: 'p', sessionDir: 's', leaderSocket: 'l', overlayPath }), /reasoningEffort|effort/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('prepare writes the dsh overlay with model, reasoningEffort and pinned permissions, never credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-dsh-overlay-'));
  try {
    const prepared = prepareCliAgentInput({ engine: 'dsh', model: 'deepseek-v4-pro', effort: 'low', workspace: dir, stateDir: join(dir, 'state'), instruction });
    assert.equal(prepared.argv[0], 'dsh');
    assert.equal(prepared.stdin, instruction);
    assert.ok(prepared.overlayPath, 'dsh carries a private overlay path');
    assert.ok(prepared.overlayPath!.startsWith(prepared.stateDir), 'overlay lives in the private run directory');
    const patchIndex = prepared.argv.indexOf('--patch');
    assert.ok(patchIndex >= 0 && prepared.argv[patchIndex + 1] === prepared.overlayPath);
    const overlay = readFileSync(prepared.overlayPath!, 'utf8');
    assert.match(overlay, /model:\s*"deepseek-v4-pro"/);
    assert.match(overlay, /reasoningEffort:\s*"low"/);
    assert.match(overlay, /mode:\s*"?workspace-write"?/);
    assert.match(overlay, /policy:\s*"?ask"?/);
    assert.match(overlay, /- id:\s*credentials\n\s*disabled:\s*false/);
    assert.doesNotMatch(overlay, /DEEPSEEK_API_KEY/i, 'no credential material in the overlay');
    assert.doesNotMatch(overlay, /sk-[A-Za-z0-9]/i, 'no credential material in the overlay');
    assert.doesNotMatch(overlay, /refs:|records:/, 'no inline credential store content');
    assert.equal(readFileSync(prepared.promptPath, 'utf8'), instruction);
    assert.equal(prepared.sessionDir, undefined, 'dsh has no pi-style session directory');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dsh overlay patch text always uses deepseek-official and enables the local credential store', () => {
  const overlay = buildDshOverlayPatch('deepseek-flash', 'max');
  assert.match(overlay, /provider:\s*deepseek-official/);
  assert.match(overlay, /model:\s*"deepseek-flash"/);
  assert.match(overlay, /reasoningEffort:\s*"max"/);
  assert.match(overlay, /mode:\s*"?workspace-write"?/);
  assert.match(overlay, /policy:\s*"?ask"?/);
  // Minimal entry enabling the file-backed credential service (dsh-credentials-local):
  // story precedence is stored file > launch env > project .env > home .env.
  assert.match(overlay, /- id:\s*credentials\n\s*disabled:\s*false/);
  assert.doesNotMatch(overlay, /deepseek-account/, 'no account route: deepseek-official only');
  assert.doesNotMatch(overlay, /authorization/, 'authorization stays disabled: no login flow in headless');
  assert.doesNotMatch(overlay, /DEEPSEEK_API_KEY/i);
  assert.doesNotMatch(overlay, /sk-[A-Za-z0-9]/i);
  assert.doesNotMatch(overlay, /refs:|records:/, 'no inline credential store content');
});

test('dsh overlay never carries credential values', () => {
  for (const [model, effort] of [['deepseek-flash', 'high'], ['deepseek-v4-pro', 'low']] as const) {
    const overlay = buildDshOverlayPatch(model, effort);
    assert.match(overlay, /provider:\s*deepseek-official/);
    assert.doesNotMatch(overlay, /DEEPSEEK_API_KEY/i);
    assert.doesNotMatch(overlay, /sk-[A-Za-z0-9]/i);
    assert.doesNotMatch(overlay, /records:|refs:/, 'no inline credential store content');
  }
});

test('dsh NDJSON success yields progress, tool logs, vendor session and the final answer', () => {
  const normalizer = createNormalizer('dsh');
  const lines = [
    JSON.stringify({ type: 'session', sessionId: 'session-abc', cwd: '/w' }),
    JSON.stringify({ type: 'status', phase: 'turn_start', turn: 1 }),
    JSON.stringify({ type: 'thinking', text: 'plan' }),
    JSON.stringify({ type: 'text', text: 'partial' }),
    JSON.stringify({ type: 'tool_call', callId: 'call-1', tool: 'write', input: { path: 'a.txt' } }),
    JSON.stringify({ type: 'tool_result', callId: 'call-1', status: 'completed', result: 'ok' }),
    JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 2 } }),
    JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 12, outputTokens: 3 } }),
    JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } }),
    JSON.stringify({ type: 'final', text: 'DONE' }),
  ];
  const records = lines.flatMap(line => normalizer.push(line));
  assert.ok(records.some(item => item.type === 'progress' && /dsh/i.test(item.message)), 'session start is progress');
  assert.ok(records.some(item => item.type === 'log' && /tool started write/.test(item.message)));
  assert.ok(records.some(item => item.type === 'log' && /tool finished write/.test(item.message)));
  assert.ok(!records.some(item => item.type === 'log' && /call-1/.test(item.message)), 'tool_result logs the tool name, never the callId');
  assert.equal(normalizer.sessionId(), 'session-abc');
  const done = normalizer.finish({ exitCode: 0, cancelled: false, truncated: false });
  assert.equal(done.evidence.terminal, 'success');
  assert.equal(done.evidence.vendorSessionId, 'session-abc');
  assert.deepEqual(done.evidence.usage, { inputTokens: 12, outputTokens: 3 }, 'dsh step usage is already cumulative: keep the last step_end value');
  assert.equal(done.records.find(item => item.type === 'result')?.summary, 'DONE');
});

test('dsh tool_result without a matching tool_call falls back to a generic log without the callId', () => {
  const normalizer = createNormalizer('dsh');
  const records = normalizer.push(JSON.stringify({ type: 'tool_result', callId: 'call-9', status: 'completed', result: 'ok' }));
  assert.equal(records.length, 1);
  const [note] = records;
  assert.equal(note?.type, 'log');
  if (note?.type === 'log') {
    assert.match(note.message, /tool finished/);
    assert.doesNotMatch(note.message, /call-9/);
  }
});

test('dsh still accepts the legacy string turn_end reason defensively', () => {
  const normalizer = createNormalizer('dsh');
  normalizer.push(JSON.stringify({ type: 'session', sessionId: 'session-s', cwd: '/w' }));
  normalizer.push(JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: 'completed' }));
  normalizer.push(JSON.stringify({ type: 'final', text: 'DONE' }));
  assert.equal(normalizer.finish({ exitCode: 0, cancelled: false, truncated: false }).evidence.terminal, 'success');
});

test('dsh turn-outside failure (error event, no final, exit 1) and turn-inside failure (empty final, turn_end reason, exit 1) both fail', () => {
  const outside = createNormalizer('dsh');
  outside.push(JSON.stringify({ type: 'session', sessionId: 'session-x', cwd: '/w' }));
  outside.push(JSON.stringify({ type: 'error', message: 'a task is required' }));
  const outsideDone = outside.finish({ exitCode: 1, cancelled: false, truncated: false });
  assert.equal(outsideDone.evidence.terminal, 'error');
  assert.equal(outsideDone.evidence.vendorSessionId, 'session-x');

  const insideReasons = [
    { kind: 'error', error: { code: 'AUTH', message: 'missing credential for deepseek-official' } },
    { kind: 'aborted' },
  ];
  for (const reason of insideReasons) {
    const inside = createNormalizer('dsh');
    inside.push(JSON.stringify({ type: 'session', sessionId: 'session-y', cwd: '/w' }));
    inside.push(JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason }));
    inside.push(JSON.stringify({ type: 'final', text: '' }));
    const insideDone = inside.finish({ exitCode: 1, cancelled: false, truncated: false });
    assert.equal(insideDone.evidence.terminal, 'error');
    assert.ok(insideDone.records.some(item => item.type === 'log' && /aborted|AUTH|missing credential/i.test(item.message)));
  }
});

test('dsh in-turn RATE_LIMIT/QUOTA error reasons surface details the vendor-error path reads as 限流/额度耗尽', () => {
  const cases = [
    { code: 'RATE_LIMIT', message: 'too many requests, retry later', kind: 'rate_limit', prefix: '限流' },
    { code: 'QUOTA', message: 'quota exceeded for deepseek-official', kind: 'quota', prefix: '额度耗尽' },
  ] as const;
  for (const { code, message, kind, prefix } of cases) {
    const normalizer = createNormalizer('dsh');
    normalizer.push(JSON.stringify({ type: 'session', sessionId: 'session-q', cwd: '/w' }));
    normalizer.push(JSON.stringify({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { code, message } } }));
    normalizer.push(JSON.stringify({ type: 'final', text: '' }));
    const done = normalizer.finish({ exitCode: 1, cancelled: false, truncated: false });
    assert.equal(done.evidence.terminal, 'error');
    const detail = done.records.filter(item => item.type === 'log').map(item => item.type === 'log' ? item.message : '').join('\n');
    assert.ok(detail.includes(code) && detail.includes(message), `failure detail keeps code and message for ${code}`);
    const failure = classifyVendorError('dsh', detail);
    assert.equal(failure?.kind, kind);
    assert.ok(failure && vendorBlockReason(failure).startsWith(prefix));
  }
});

test('dsh classifies RATE_LIMIT as rate_limit and QUOTA as quota without changing other engines', () => {
  assert.equal(classifyVendorError('dsh', 'dsh: RATE_LIMIT: too many requests')?.kind, 'rate_limit');
  assert.equal(classifyVendorError('dsh', 'dsh: QUOTA: quota exceeded')?.kind, 'quota');
  assert.equal(classifyVendorEvent('dsh', { type: 'error', message: 'dsh: QUOTA: exhausted' }, '{"type":"error","message":"dsh: QUOTA: exhausted"}')?.kind, 'quota');
  // Established patterns of the other engines are untouched: a bare QUOTA code with no
  // quota wording is only recognised through the dsh entry.
  assert.equal(classifyVendorError('grok', 'dsh: QUOTA: over budget')?.kind, undefined);
  assert.equal(classifyVendorError('dsh', 'dsh: QUOTA: over budget')?.kind, 'quota');
  assert.equal(classifyVendorError('codex', 'usage limit reached')?.kind, 'quota');
});

test('dsh effort values are off, low, high and max', () => {
  assert.deepEqual(EFFORTS.dsh, ['off', 'low', 'high', 'max']);
});

test('default policy ships an enabled dsh engine and disabled worker, validates clean, and routes no owner to it', () => {
  const config = defaultConfig();
  assert.deepEqual(config.engines.dsh, { enabled: true, kind: 'dsh' });
  assert.equal(roleEngine(config,config.workers.dsh_worker!), 'dsh');
  assert.equal(config.workers.dsh_worker?.model, 'deepseek-flash');
  assert.equal(config.workers.dsh_worker?.effort, 'high');
  assert.equal(config.workers.dsh_worker?.enabled, false);
  assert.doesNotMatch(config.workers.dsh_worker?.description ?? '', /Disabled/);
  assert.match(config.workers.dsh_worker?.description ?? '', /dsh settings/);
  assert.match(config.workers.dsh_worker?.description ?? '', /DEEPSEEK_API_KEY/);
  for (const owner of Object.values(config.owners)) {
    assert.ok(!owner.workers.includes('dsh_worker'), `${owner} must not gain the dsh worker`);
  }
  assert.deepEqual(validateConfig(config), []);
  const bad = defaultConfig();
  bad.workers.dsh_worker.effort = 'ultra';
  assert.ok(validateConfig(bad).some(issue => issue.path.includes('dsh_worker') && /effort/.test(issue.message)));
});

test('dsh models are the static deepseek-flash and deepseek-v4-pro without running a list command', async () => {
  let ran = 0;
  const lister = new EngineModelLister({ find: async () => { ran++; return '/fake/dsh'; }, run: async () => { ran++; throw new Error('must not run'); } });
  const list = await lister.list({ engine: 'dsh' });
  assert.equal(list.status, 'ok');
  assert.deepEqual(list.models.map(m => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(ran, 0, 'no list command runs for dsh');
});

test('dsh hello greets through headless json with the same overlay patch', () => {
  assert.equal(HELLO_ENGINES.dsh.command, 'dsh');
  assert.deepEqual(HELLO_ENGINES.dsh.argv('deepseek-flash', 'high', '/tmp/x/dsh-overlay.yml'), ['--profile', 'headless', '--patch', '/tmp/x/dsh-overlay.yml', '--json', 'Reply with exactly: hi']);
});

test('dsh hello parses final replies and AUTH failures without crashing', async () => {
  const run = async (stdout: string, code: number | null, stderr: string) => {
    let seen: { command: string; argv: string[] } | undefined;
    const spawn: SpawnPrint = (command, argv) => {
      seen = { command, argv };
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.stdout.end(); setImmediate(() => child.emit('close', null)); return true; } });
      setImmediate(() => { child.stderr.end(stderr); child.stdout.end(stdout); setImmediate(() => child.emit('close', code)); });
      return child;
    };
    const dir = mkdtempSync(join(tmpdir(), 'weaver-dsh-hello-'));
    try {
      const result = await sayHi({ engine: 'dsh', kind: 'dsh', model: 'deepseek-flash', effort: 'high' }, { root: dir, spawn, timeoutMs: 5000 });
      const at = seen!.argv.indexOf('--patch');
      assert.ok(at >= 0, 'hello must pass --patch like the formal run');
      assert.ok(seen!.argv.indexOf('--json') > at, '--patch precedes --json');
      return result;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const ok = await run(['{"type":"session","sessionId":"session-1","cwd":"/tmp/x"}', '{"type":"status","phase":"turn_end","turn":1,"reason":"completed"}', '{"type":"final","text":"hi"}'].join('\n'), 0, '');
  assert.deepEqual([ok.ok, ok.reply], [true, 'hi']);
  const auth = await run(['{"type":"session","sessionId":"session-2","cwd":"/tmp/x"}', '{"type":"error","message":"missing credential"}'].join('\n'), 1, 'dsh: AUTH: missing credential for deepseek-official');
  assert.equal(auth.ok, false);
  assert.match(auth.error ?? '', /AUTH|credential/i);
});

test('dsh hello parses the object turn_end reason: completed succeeds, error reports code: message', async () => {
  const run = async (stdout: string, code: number | null, stderr: string) => {
    const spawn: SpawnPrint = (command, argv) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.stdout.end(); setImmediate(() => child.emit('close', null)); return true; } });
      setImmediate(() => { child.stderr.end(stderr); child.stdout.end(stdout); setImmediate(() => child.emit('close', code)); });
      return child;
    };
    const dir = mkdtempSync(join(tmpdir(), 'weaver-dsh-hello-reason-'));
    try {
      return await sayHi({ engine: 'dsh', kind: 'dsh', model: 'deepseek-flash', effort: 'high' }, { root: dir, spawn, timeoutMs: 5000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const ok = await run(['{"type":"session","sessionId":"session-1","cwd":"/tmp/x"}', '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}', '{"type":"final","text":"hi"}'].join('\n'), 0, '');
  assert.deepEqual([ok.ok, ok.reply], [true, 'hi']);
  const failed = await run(['{"type":"session","sessionId":"session-2","cwd":"/tmp/x"}', '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"code":"AUTH","message":"missing credential"}}}', '{"type":"final","text":""}'].join('\n'), 1, '');
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /AUTH: missing credential/);
  const aborted = await run(['{"type":"session","sessionId":"session-3","cwd":"/tmp/x"}', '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"aborted"}}', '{"type":"final","text":""}'].join('\n'), 1, '');
  assert.equal(aborted.ok, false);
  assert.match(aborted.error ?? '', /aborted/);
});

test('dsh hello runs through the same overlay logic as a formal run, from a private temp file that is cleaned up', async () => {
  let patchPath = '';
  let patchText = '';
  let patchCwd = '';
  const spawn: SpawnPrint = (command, argv, cwd) => {
    assert.equal(command, 'dsh');
    const at = argv.indexOf('--patch');
    assert.ok(at >= 0, 'hello must pass --patch like the formal run');
    assert.ok(argv.indexOf('--json') > at, '--patch is a launcher flag and precedes the headless --json flag');
    patchPath = argv[at + 1];
    patchCwd = cwd;
    assert.ok(patchPath.startsWith(cwd), 'overlay lives in the private scratch directory');
    patchText = readFileSync(patchPath, 'utf8');
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.stdout.end(); setImmediate(() => child.emit('close', null)); return true; } });
    setImmediate(() => { child.stderr.end(''); child.stdout.end(['{"type":"session","sessionId":"session-9","cwd":"/tmp/x"}', '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}', '{"type":"final","text":"hi"}'].join('\n')); setImmediate(() => child.emit('close', 0)); });
    return child;
  };
  const dir = mkdtempSync(join(tmpdir(), 'weaver-dsh-hello-patch-'));
  try {
    const result = await sayHi({ engine: 'dsh', kind: 'dsh', model: 'deepseek-flash', effort: 'high' }, { root: dir, spawn, timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.match(patchText, /provider:\s*deepseek-official/);
    assert.match(patchText, /model:\s*"deepseek-flash"/);
    assert.match(patchText, /reasoningEffort:\s*"high"/);
    assert.match(patchText, /mode:\s*"?workspace-write"?/);
    assert.match(patchText, /policy:\s*"?ask"?/);
    assert.match(patchText, /- id:\s*credentials\n\s*disabled:\s*false/);
    assert.doesNotMatch(patchText, /deepseek-account/, 'no account route');
    assert.doesNotMatch(patchText, /authorization/, 'authorization stays disabled');
    assert.doesNotMatch(patchText, /DEEPSEEK_API_KEY/i);
    assert.doesNotMatch(patchText, /sk-[A-Za-z0-9]/i);
    assert.doesNotMatch(patchText, /refs:|records:/, 'no inline credential store content');
    assert.equal(patchPath.startsWith(dir), true);
    assert.equal(patchCwd.startsWith(dir), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal((() => { try { readFileSync(patchPath, 'utf8'); return true; } catch { return false; } })(), false, 'overlay temp file is removed with the scratch directory');
});

test('catalog probe reads dsh --version as 0.2.1-rc.2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-dsh-probe-'));
  try {
    writeFileSync(join(dir, 'dsh'), `#!${process.execPath}\nconsole.log('0.2.1-rc.2');\n`, { mode: 0o700 });
    const probe = await new EngineProber({ pathEnv: dir, timeoutMs: 5000 }).probeOne('dsh');
    assert.equal(probe.status, 'installed');
    assert.equal(probe.version, '0.2.1-rc.2');
    assert.equal(probe.command, 'dsh');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real dsh --version probes 0.2.1-rc.2 when dsh is installed', async t => {
  if (!dshAvailable()) {
    t.skip('dsh is not on PATH; skipping live version probe');
    return;
  }
  const probe = await new EngineProber({ timeoutMs: 10_000 }).probeOne('dsh');
  assert.equal(probe.status, 'installed');
  assert.equal(probe.version, '0.2.1-rc.2');
});

test('real dsh --dump-config proves the generated overlay takes effect', async t => {
  if (!dshAvailable()) {
    t.skip('dsh is not on PATH; skipping live dump-config verification');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'weaver-dsh-dump-'));
  try {
    const overlayPath = join(dir, 'dsh-overlay.yml');
    writeFileSync(overlayPath, buildDshOverlayPatch('deepseek-v4-pro', 'low'), { mode: 0o600 });
    const composed = execFileSync('dsh', ['--profile', 'headless', '--dump-config', '--patch', overlayPath], { cwd: dir, timeout: 30_000, encoding: 'utf8', env: { ...process.env, DSH_PERMISSION_MODE: 'danger-full-access' } });
    assert.match(composed, /provider:\s*deepseek-official/);
    assert.match(composed, /model:\s*deepseek-v4-pro/);
    assert.match(composed, /reasoningEffort:\s*low/);
    assert.match(composed, /mode:\s*workspace-write/);
    assert.match(composed, /policy:\s*ask/);
    assert.match(composed, /id: credentials[\s\S]*?disabled: false/);
    assert.match(composed, /id: authorization[\s\S]*?disabled: true/);
    assert.match(composed, /id: deepseek-account[\s\S]*?disabled: true/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a dsh run round-trips through the persisted store and reloads after a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-dsh-store-'));
  try {
    const path = join(dir, 'weaver.db');
    const writer = new TaskStore(path);
    const task = { id: randomUUID(), title: 'dsh', instruction: 'probe', owner: { name: 'o', transport: 'herdr-visible' as const, session: 's', pane: '1' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'completed' as const, progress: 100, events: [], artifacts: [], run: { id: randomUUID(), adapter: 'dsh' as const, execution: 'real' as const, status: 'stopped' as const, evidence: { engine: 'dsh' as const, requestedModel: 'deepseek-flash', requestedEffort: 'high', workspace: dir, terminal: 'success' as const, vendorSessionId: 'session-dsh-1' } } };
    writer.put(task as never);
    writer.close();
    const reader = new TaskStore(path);
    const run = reader.get(task.id).run;
    assert.equal(run?.adapter, 'dsh');
    assert.equal(run?.evidence?.engine, 'dsh');
    assert.equal(run?.evidence?.vendorSessionId, 'session-dsh-1');
    reader.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
