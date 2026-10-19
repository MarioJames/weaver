import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELLO_ENGINES, HelloJobs, parseHelloInput, sayHi, type SpawnPrint } from '../src/main/engines/hello';
import type { HelloResult } from '../src/shared/engines';

type Call = { command: string; argv: string[]; cwd: string };
/** Fake CLI: writes the given output, then exits with the given code. */
function fake(stdout: string, code = 0, stderr = '', calls: Call[] = []): SpawnPrint {
  return (command, argv, cwd) => {
    calls.push({ command, argv, cwd });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.stdout.end(); setImmediate(() => child.emit('close', null)); return true; } });
    setImmediate(() => { child.stderr.end(stderr); child.stdout.end(stdout); setImmediate(() => child.emit('close', code)); });
    return child;
  };
}
const hang: SpawnPrint = () => { const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.stdout.end(); setImmediate(() => child.emit('close', null)); return true; } }); return child; };

async function probe(kind: string, spawn: SpawnPrint, extra: Partial<{ model: string; effort: string; timeoutMs: number }> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'weaver-hello-'));
  try {
    const result = await sayHi({ engine: kind, kind, model: extra.model ?? 'm-1', effort: extra.effort ?? 'high' }, { root, spawn, timeoutMs: extra.timeoutMs });
    assert.deepEqual(readdirSync(root), [], 'scratch directory is removed');
    return result;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('each engine is called in its lightest mode: no tools, MCP, user settings or saved session where the CLI allows', async () => {
  const calls: Call[] = [];
  for (const kind of Object.keys(HELLO_ENGINES)) await probe(kind, fake('', 0, '', calls));
  const byCommand = Object.fromEntries(calls.map(call => [call.command, call.argv.join(' ')]));
  assert.match(byCommand.claude, /--setting-sources  --/);
  assert.match(byCommand.claude, /--strict-mcp-config/);
  assert.match(byCommand.claude, /--tools  /);
  assert.match(byCommand.claude, /--no-session-persistence/);
  assert.doesNotMatch(byCommand.claude, /--bare/, 'bare mode never reads OAuth, so subscription logins would fail');
  assert.match(byCommand.codex, /--ignore-user-config --ignore-rules --sandbox read-only/);
  assert.match(byCommand.codex, /--ephemeral/);
  assert.match(byCommand.codex, /model_reasoning_effort="high"/);
  assert.match(byCommand.qodercli, /--setting-sources  .*--no-session-persistence/);
  assert.match(byCommand.pi, /--no-tools --no-mcp --no-extensions --no-skills --no-context-files/);
  assert.match(byCommand.opencode, /run --pure/);
  assert.match(byCommand.grok, /--max-turns 1/);
  for (const call of calls) assert.match(call.cwd, /hello-[0-9a-f]{8}$/);
});

test('replies are read from each CLI output format, with the vendor model when reported', async () => {
  const claude = await probe('claude', fake(JSON.stringify({ type: 'result', is_error: false, result: 'hi', modelUsage: { 'claude-sonnet-5-5': {} } })));
  assert.deepEqual([claude.ok, claude.reply, claude.model], [true, 'hi', 'claude-sonnet-5-5']);
  const codex = await probe('codex', fake(['{"type":"thread.started"}', '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"你好"}}', '{"type":"turn.completed"}'].join('\n')));
  assert.deepEqual([codex.ok, codex.reply], [true, '你好']);
  const opencode = await probe('opencode', fake('{"type":"step_start"}\n{"type":"text","part":{"text":"hi"}}\n{"type":"step_finish"}'));
  assert.deepEqual([opencode.ok, opencode.reply], [true, 'hi']);
  const pi = await probe('pi', fake(JSON.stringify({ type: 'agent_end', messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply' }] }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }], model: 'glm-5.3-flash', responseModel: 'glm-5-3-flash-260828', stopReason: 'stop' }] })));
  assert.deepEqual([pi.ok, pi.reply, pi.model], [true, 'hi', 'glm-5-3-flash-260828']);
  const qoder = await probe('qodercli', fake('{"type":"result","subtype":"success","is_error":false,"result":"Hi! 👋","modelUsage":{"qfmodel":{}}}'));
  assert.deepEqual([qoder.ok, qoder.reply, qoder.model], [true, 'Hi! 👋', undefined]);
});

test('a vendor error is reported with its own message', async () => {
  const grok = await probe('grok', fake(JSON.stringify({ type: 'error', message: 'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}' }), 1, 'Error: Internal error'));
  assert.equal(grok.ok, false);
  assert.equal(grok.error, 'API error (status 402 Payment Required): Grok Build usage balance exhausted');
  const claude = await probe('claude', fake('{"type":"result","is_error":true,"result":"Invalid API key"}', 1));
  assert.deepEqual([claude.ok, claude.error], [false, 'Invalid API key']);
  const codex = await probe('codex', fake('{"type":"turn.failed","error":{"message":"model not found"}}', 1));
  assert.match(codex.error ?? '', /model not found/);
  const pi = await probe('pi', fake(JSON.stringify({ role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 unauthorized' }), 1));
  assert.match(pi.error ?? '', /401/);
  const silent = await probe('opencode', fake('', 1, 'warn\nprovider not configured\n'));
  assert.match(silent.error ?? '', /provider not configured/);
});

test('no reply within the deadline stops the process and reports a timeout', async () => {
  const result = await probe('codex', hang, { timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /超时/);
});

test('a missing command, an unknown engine and flag-like values are refused cleanly', async () => {
  const missing: SpawnPrint = () => { const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); setImmediate(() => child.emit('error', Object.assign(new Error('spawn qodercli ENOENT'), { code: 'ENOENT' }))); return child; };
  assert.match((await probe('qodercli', missing)).error ?? '', /找不到命令 qodercli/);
  const calls: Call[] = [];
  // Every catalog kind has a greeting adapter, so the not-integrated branch needs a policy kind outside the catalog.
  assert.equal(Object.hasOwn(HELLO_ENGINES, 'cursor'), false);
  assert.match((await probe('cursor', fake('', 0, '', calls))).error ?? '', /还没有接入/);
  assert.match((await probe('codex', fake('', 0, '', calls), { model: '--dangerously-bypass-approvals-and-sandbox' })).error ?? '', /模型名称/);
  assert.match((await probe('codex', fake('', 0, '', calls), { effort: '-x' })).error ?? '', /推理强度/);
  assert.equal(calls.length, 0);
});

test('input must name an engine with model and effort', () => {
  assert.deepEqual(parseHelloInput({ engine: 'codex', model: 'gpt', effort: 'low' }), { engine: 'codex', model: 'gpt', effort: 'low' });
  assert.throws(() => parseHelloInput({ engine: 'codex', model: '', effort: 'low' }));
  assert.throws(() => parseHelloInput({ engine: 'codex', model: 'gpt', effort: 'low', extra: 1 }));
  assert.throws(() => parseHelloInput(null));
});

test('greetings run as polled jobs: started at once, bounded, kept for a while after they finish', async () => {
  let now = 1_000_000;
  const pending: ((result: HelloResult) => void)[] = [];
  const jobs = new HelloJobs(() => new Promise(resolve => pending.push(resolve)), 2, 60_000, () => now);
  const a = jobs.start({ engine: 'codex', model: 'm', effort: 'low' });
  assert.equal(a.status, 'running');
  jobs.start({ engine: 'pi', model: 'm', effort: 'low' });
  assert.throws(() => jobs.start({ engine: 'claude', model: 'm', effort: 'low' }), /2 个探测/);
  pending[0]!({ ok: true, reply: 'hi', durationMs: 5, checkedAt: 'x' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(jobs.get(a.id)?.result?.reply, 'hi');
  assert.equal(jobs.get(a.id)?.status, 'done');
  assert.equal(jobs.running(), 1);
  now += 61_000;
  assert.equal(jobs.get(a.id), undefined);
  const failing = new HelloJobs(() => Promise.reject(new Error('boom')));
  const b = failing.start({ engine: 'codex', model: 'm', effort: 'low' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failing.get(b.id)?.result?.error, 'boom');
});
