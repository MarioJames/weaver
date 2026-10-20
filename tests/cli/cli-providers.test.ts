import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parseWorkerRecord } from '../../src/shared/validation';
import { CliAgentInputError, prepareCliAgentInput, startCliAgent } from '../../src/main/adapters/cli';
import { createNormalizer } from '../../src/main/adapters/cli/normalize';
import { createRedactedLineBuffer } from '../../src/main/adapters/cli/redact';
import type { CliAgentInput } from '../../src/main/adapters/cli';
import type { RealEngineKind } from '../../src/shared/contracts/tasks';

const instruction = 'MARKER-do-not-put-this-on-argv Reply PONG only.';

function input(dir: string, engine: RealEngineKind, extra: Partial<CliAgentInput> = {}): CliAgentInput {
  return { engine, model: engine === 'opencode' ? 'opencode/glm-5.3-flash-free' : engine === 'pi' ? 'cc-switch-agentplan/glm-5.3-flash' : engine === 'grok' ? 'grok-4.7' : 'gpt-6.1-sol', effort: engine === 'pi' ? 'low' : engine === 'opencode' ? 'max' : 'low', workspace: dir, instruction, stateDir: join(dir, 'state'), ...extra };
}

test('rejects a missing workspace before any process is started', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-cli-input-'));
  try {
    assert.throws(() => startCliAgent(input(join(dir, 'missing'), 'pi')), (error: unknown) => error instanceof CliAgentInputError && error.field === 'workspace' && /existing directory/.test(error.message));
    assert.throws(() => prepareCliAgentInput({ ...input(dir, 'codex'), engine: 'claude' as RealEngineKind }), (error: unknown) => error instanceof CliAgentInputError && error.field === 'engine');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('prepared argv is fixed, keeps the prompt off the command line, and refuses credential directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-cli-argv-'));
  const link = join(dir, 'cred');
  try {
    symlinkSync(join(homedir(), '.codex'), link);
    assert.throws(() => prepareCliAgentInput(input(link, 'codex')), (error: unknown) => error instanceof CliAgentInputError && error.field === 'workspace');
    for (const engine of ['pi', 'opencode', 'grok', 'codex'] as const) {
      const prepared = prepareCliAgentInput(input(dir, engine));
      assert.equal(prepared.argv[0], engine);
      assert.equal(prepared.argv.some(arg => arg.includes('MARKER-do-not-put-this-on-argv')), false);
      assert.equal(prepared.workspace.startsWith('/'), true);
      assert.equal(readFileSync(prepared.promptPath, 'utf8'), instruction);
      if (engine === 'grok') {
        assert.equal(prepared.stdin, null);
        assert.ok(prepared.argv.includes('--permission-mode') && prepared.argv.includes('bypassPermissions'));
        assert.ok(prepared.argv.includes('--no-subagents') && prepared.argv.includes('--no-leader'));
        const socket = prepared.argv[prepared.argv.indexOf('--leader-socket') + 1];
        assert.equal(socket.startsWith(prepared.stateDir), true);
      } else assert.equal(prepared.stdin, instruction);
      if (engine === 'codex') {
        assert.equal(prepared.argv.at(-1), '-');
        assert.ok(prepared.argv.includes('danger-full-access'));
        assert.equal(prepared.argv.includes('workspace-write'), false);
        assert.equal(prepared.argv.includes('--dangerously-bypass-approvals-and-sandbox'), false);
      }
      if (engine === 'pi') assert.ok(prepared.argv.includes('--no-session') && prepared.argv.includes('--mode') && prepared.argv.includes('json'));
      if (engine === 'opencode') assert.ok(prepared.argv.includes('--pure') && prepared.argv.includes('--auto') && prepared.argv.includes('--dir') && prepared.argv.join(' ').includes('--print-logs --log-level ERROR'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('normalization requires a real vendor terminal, assistant text, and a zero exit', () => {
  const secret = 'sk-testsecretvalue123456';
  const cases: { engine: RealEngineKind; lines: string[]; exitCode: number | null; success: boolean; terminal?: string; reason?: string }[] = [
    { engine: 'pi', exitCode: 0, success: true, lines: [
      JSON.stringify({ type: 'session', id: 'sess-pi', cwd: '/tmp/hidden' }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'PO' } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'cc-switch-agentplan', model: 'glm-5.3-flash', stopReason: 'stop', content: [{ type: 'text', text: `PONG ${secret}` }], usage: { input: 3, output: 1 } } }),
      JSON.stringify({ type: 'agent_end', messages: [{ huge: true }] }),
      JSON.stringify({ type: 'agent_settled', aborted: false }),
    ] },
    { engine: 'pi', exitCode: 0, success: false, terminal: 'missing', lines: [JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'PONG' }] } })] },
    { engine: 'pi', exitCode: 0, success: false, terminal: 'truncated', lines: [JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: 'PONG' }] } }), JSON.stringify({ type: 'agent_end' })] },
    { engine: 'opencode', exitCode: 0, success: true, lines: [
      JSON.stringify({ type: 'text', sessionID: 'sess-oc', part: { type: 'text', text: 'PONG' } }),
      JSON.stringify({ type: 'step_finish', sessionID: 'sess-oc', part: { type: 'step-finish', reason: 'stop', tokens: { input: 2, output: 1 } } }),
    ] },
    { engine: 'opencode', exitCode: 0, success: false, lines: [JSON.stringify({ type: 'error', sessionID: 'sess-oc', error: { name: 'ProviderAuthError', data: { message: `token=${secret}` } } }), JSON.stringify({ type: 'text', part: { text: 'PONG' } }), JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } })] },
    { engine: 'grok', exitCode: 0, success: true, lines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-grok', model: 'grok-4.7', apiKeySource: secret, tools: ['bash'], skills: ['hidden'] }),
      JSON.stringify({ type: 'assistant', message: { model: 'grok-4.7', content: [{ type: 'text', text: 'PONG' }], usage: { input_tokens: 4, output_tokens: 1 } } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONG', session_id: 'sess-grok', usage: { input_tokens: 4, output_tokens: 1 } }),
    ] },
    { engine: 'grok', exitCode: 0, success: false, lines: [JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'nope' })] },
    { engine: 'codex', exitCode: 0, success: true, lines: [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'PONG' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: `cat ${secret}` } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }),
    ] },
    { engine: 'codex', exitCode: 0, success: false, lines: [JSON.stringify({ ok: true }), JSON.stringify({ type: 'turn.completed' })] },
    { engine: 'codex', exitCode: 2, success: false, lines: [JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'PONG' } }), JSON.stringify({ type: 'turn.completed' })] },
    { engine: 'pi', exitCode: 0, success: false, terminal: 'missing', lines: [
      JSON.stringify({ type: 'tool_execution_end', toolName: 'write', isError: false }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'PONG' }] } }),
      JSON.stringify({ type: 'agent_end' }),
    ] },
    { engine: 'pi', exitCode: 0, success: false, terminal: 'missing', lines: [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'pending', content: [{ type: 'text', text: 'PONG' }] } }),
      JSON.stringify({ type: 'agent_end' }),
      JSON.stringify({ type: 'agent_settled', aborted: false }),
    ] },
    { engine: 'opencode', exitCode: 0, success: true, lines: [
      JSON.stringify({ type: 'tool_use', sessionID: 'sess-oc', part: { type: 'tool', tool: 'write', state: { status: 'completed' } } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls', tokens: { input: 4, output: 1 } } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'PONG' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { input: 5, output: 2 } } }),
    ] },
    { engine: 'opencode', exitCode: 0, success: false, terminal: 'missing', lines: [
      JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'write', state: { status: 'completed' } } }),
      JSON.stringify({ type: 'text', part: { text: 'PONG' } }),
      JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls' } }),
    ] },
    { engine: 'opencode', exitCode: 0, success: false, terminal: 'error', lines: [
      JSON.stringify({ type: 'text', part: { text: 'PONG' } }),
      JSON.stringify({ type: 'step_finish', part: { reason: 'error' } }),
      JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }),
    ] },
    { engine: 'pi', exitCode: 0, success: false, terminal: 'error', reason: 'quota exceeded', lines: [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: `quota exceeded token=${secret}`, content: [{ type: 'text', text: 'PONG' }] } }),
      JSON.stringify({ type: 'agent_end' }),
    ] },
    { engine: 'pi', exitCode: 0, success: false, terminal: 'error', reason: 'unknown pi error', lines: [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: 'PONG' }] } }),
      JSON.stringify({ type: 'agent_end' }),
    ] },
    { engine: 'grok', exitCode: 0, success: false, terminal: 'error', reason: 'model rejected', lines: [
      JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: secret, tools: ['bash'] }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'PONG' }] } }),
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: `model rejected ${secret}`, errors: [{ message: 'quota exceeded' }] }),
    ] },
    { engine: 'grok', exitCode: 0, success: false, terminal: 'error', reason: 'unknown grok error', lines: [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'PONG' }] } }),
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: { unexpected: true } }),
    ] },
  ];
  for (const item of cases) {
    const normalizer = createNormalizer(item.engine);
    const emitted = item.lines.flatMap(line => normalizer.push(line));
    const done = normalizer.finish({ exitCode: item.exitCode, cancelled: false, truncated: false });
    const records = [...emitted, ...done.records];
    for (const record of records) parseWorkerRecord(record);
    const blob = JSON.stringify(records);
    assert.equal(blob.includes(secret), false, item.engine);
    assert.equal(done.evidence.terminal === 'success', item.success, `${item.engine} ${done.evidence.terminal}`);
    if (item.terminal) assert.equal(done.evidence.terminal, item.terminal);
    if (item.success) {
      assert.equal(records.at(-1)?.type, 'result');
      assert.equal(records.some(record => record.type === 'artifact' && record.name === 'result.md'), true);
      assert.match(done.evidence.assistantText, /PONG/);
    } else assert.equal(records.some(record => record.type === 'result'), false);
    if (item.reason) {
      assert.match(blob, new RegExp(item.reason));
      const last = records.at(-1);
      assert.equal(last?.type, 'log');
      if (last?.type === 'log') {
        assert.match(last.message, new RegExp(item.reason));
        assert.notEqual(last.message, `vendor terminal error exit ${item.exitCode}`);
      }
    }
  }
  const cancelled = createNormalizer('pi');
  cancelled.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'PONG' }] } }));
  cancelled.push(JSON.stringify({ type: 'agent_end' }));
  const stopped = cancelled.finish({ exitCode: null, cancelled: true, truncated: false });
  assert.equal(stopped.evidence.terminal, 'cancelled');
  assert.equal(stopped.records.some(record => record.type === 'result'), false);
});

test('tool steps stay recoverable until a real terminal stop', () => {
  const pi = createNormalizer('pi');
  const piLogs = [
    JSON.stringify({ type: 'tool_execution_start', toolName: 'write' }),
    JSON.stringify({ type: 'tool_execution_end', toolName: 'write', isError: true }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'retrying' }] } }),
    JSON.stringify({ type: 'tool_execution_end', toolName: 'write', isError: false }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'cc-switch-agentplan', model: 'glm-5.3-flash', stopReason: 'stop', content: [{ type: 'text', text: 'PONG' }], usage: { input: 8, output: 2 } } }),
    JSON.stringify({ type: 'agent_end' }),
  ].flatMap(line => pi.push(line));
  const piDone = pi.finish({ exitCode: 0, cancelled: false, truncated: false });
  assert.equal(piDone.evidence.terminal, 'success');
  assert.equal(piDone.evidence.assistantText, 'PONG');
  assert.equal([...piLogs, ...piDone.records].some(record => record.type === 'log' && record.message.includes('tool failed write')), true);
  const open = createNormalizer('opencode');
  const openLogs = [
    JSON.stringify({ type: 'tool_use', part: { tool: 'write', state: { status: 'error' } } }),
    JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls' } }),
    JSON.stringify({ type: 'text', part: { text: 'PONG' } }),
    JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }),
  ].flatMap(line => open.push(line));
  const openDone = open.finish({ exitCode: 0, cancelled: false, truncated: false });
  assert.equal(openDone.evidence.terminal, 'success');
  assert.equal([...openLogs, ...openDone.records].some(record => record.type === 'log' && record.message.includes('tool failed write')), true);
  const settled = createNormalizer('pi');
  settled.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'PONG' }] } }));
  settled.push(JSON.stringify({ type: 'agent_settled', aborted: false }));
  assert.equal(settled.finish({ exitCode: 0, cancelled: false, truncated: false }).evidence.terminal, 'success');
  const aborted = createNormalizer('pi');
  aborted.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'PONG' }] } }));
  aborted.push(JSON.stringify({ type: 'agent_end' }));
  aborted.push(JSON.stringify({ type: 'agent_settled', aborted: true }));
  assert.equal(aborted.finish({ exitCode: 0, cancelled: false, truncated: false }).evidence.terminal, 'error');
});

test('workspace must be absolute before a prompt file is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-cli-abs-'));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    mkdirSync('workspace');
    assert.throws(() => prepareCliAgentInput(input('.', 'pi')), (error: unknown) => error instanceof CliAgentInputError && error.field === 'workspace' && /absolute/.test(error.message));
    assert.throws(() => prepareCliAgentInput(input('workspace', 'grok')), (error: unknown) => error instanceof CliAgentInputError && error.field === 'workspace' && /absolute/.test(error.message));
    assert.equal(existsSync(join(dir, 'state')), false);
    assert.equal(existsSync(join(dir, 'workspace', 'state')), false);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('short instructions that match a cli name stay off argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-cli-short-'));
  try {
    const pi = prepareCliAgentInput(input(dir, 'pi', { instruction: 'pi' }));
    assert.equal(pi.stdin, 'pi');
    assert.equal(pi.argv[0], 'pi');
    assert.equal(pi.argv.slice(1).includes('pi'), false);
    assert.ok(pi.argv.includes('--print') && pi.argv.includes('--mode') && pi.argv.includes('json'));
    const grok = prepareCliAgentInput(input(dir, 'grok', { instruction: 'grok' }));
    assert.equal(grok.stdin, null);
    assert.equal(readFileSync(grok.promptPath, 'utf8'), 'grok');
    assert.equal(grok.argv[0], 'grok');
    assert.equal(grok.argv.slice(1).includes('grok'), false);
    assert.ok(grok.argv.includes('--prompt-file') && grok.argv.includes('--permission-mode'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stderr redaction waits for a secret split across chunks', () => {
  const secret = 'sk-testsecretvalue123456';
  const stored: string[] = [];
  const buffer = createRedactedLineBuffer(text => stored.push(text));
  const splitAt = secret.indexOf('secret');
  buffer.write(Buffer.from(`prefix ${secret.slice(0, splitAt)}`));
  assert.equal(stored.length, 0);
  buffer.write(Buffer.from(`${secret.slice(splitAt)} suffix\n`));
  buffer.write(Buffer.from('你'.slice(0, 1)));
  const tail = Buffer.from('你end');
  buffer.write(tail.subarray(0, 1));
  buffer.write(tail.subarray(1));
  buffer.flush();
  const blob = stored.join('');
  assert.equal(blob.includes(secret), false);
  assert.equal(blob.includes(secret.slice(0, splitAt)), false);
  assert.equal(blob.includes(secret.slice(splitAt)), false);
  assert.match(blob, /\[REDACTED\]/);
  assert.match(blob, /你end/);
  const huge = createRedactedLineBuffer(text => stored.push(text));
  huge.write(`${secret}${'a'.repeat(9000)}`);
  huge.flush();
  assert.equal(stored.join('').includes(secret), false);
});

test('overlong stderr drops the line instead of splitting a secret', () => {
  const fake = `sk-${'a'.repeat(48)}`;
  const input = `${'x'.repeat(8741)} ${fake} ${'x'.repeat(206)}`;
  assert.equal(input.length, 9000);
  const cut = 8744;
  assert.equal(`${input.slice(0, cut)}${input.slice(cut)}`.includes(fake), true);
  const stored: string[] = [];
  const split = createRedactedLineBuffer(text => stored.push(text));
  split.write(input.slice(0, cut));
  split.write(`${input.slice(cut)}\nkept-after\n`);
  split.flush();
  const overflow = stored.join('');
  assert.equal(overflow.includes(fake), false);
  assert.equal(overflow.includes('sk-'), false);
  assert.equal(overflow.includes('a'.repeat(48)), false);
  assert.equal(overflow.includes('x'.repeat(80)), false);
  assert.match(overflow, /\[stderr line truncated\]/);
  assert.match(overflow, /kept-after/);
  const whole = createRedactedLineBuffer(text => stored.push(text));
  whole.write(`${input}\nnext-line\n`);
  whole.flush();
  const joined = stored.join('');
  assert.equal(joined.includes(fake), false);
  assert.match(joined, /next-line/);
  const body = 'MIIFakeKeyBodyAAAA';
  const pem: string[] = [];
  const keys = createRedactedLineBuffer(text => pem.push(text));
  keys.write(`-----BEGIN PRIVATE KEY-----\n${body.slice(0, 6)}`);
  keys.write(`${body.slice(6)}\n-----END PRIVATE KEY-----\nkept-after\n`);
  keys.flush();
  const block = pem.join('');
  assert.equal(block.includes(body), false);
  assert.equal(block.includes('BEGIN PRIVATE KEY'), false);
  assert.match(block, /\[REDACTED\]/);
  assert.match(block, /kept-after/);
});

test('pi thinking level is rejected before launch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-cli-effort-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  try {
    assert.throws(() => prepareCliAgentInput(input(dir, 'pi', { effort: 'ultra' })), /thinking level|Effort/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('completed assistant streams retain bounded final evidence without changing vendor success', () => {
  for (const engine of ['opencode', 'codex'] as const) {
    const normalizer = createNormalizer(engine);
    for (let index = 0; index < 100; index += 1) {
      const text = `${index}:${'x'.repeat(9000)}${index === 99 ? 'FINAL_TAIL' : ''}`;
      normalizer.push(JSON.stringify(engine === 'opencode' ? { type: 'text', part: { text } } : { type: 'item.completed', item: { type: 'agent_message', text } }));
    }
    normalizer.push(JSON.stringify(engine === 'opencode' ? { type: 'step_finish', part: { reason: 'stop' } } : { type: 'turn.completed' }));
    const done = normalizer.finish({ exitCode: 0, cancelled: false, truncated: false });
    assert.equal(done.evidence.terminal, 'success');
    assert.ok(done.evidence.assistantText.length <= 30_000);
    assert.ok(done.evidence.assistantText.endsWith('FINAL_TAIL'));
    assert.ok(done.records.some(record => record.type === 'log' && /retained evidence clipped.*field=assistant_text/.test(record.message)));
    const artifact = done.records.find(record => record.type === 'artifact');
    assert.ok(artifact?.type === 'artifact');
    assert.ok(artifact.content.length <= 30_000);
    assert.ok(artifact.content.endsWith('FINAL_TAIL'));
    assert.match(artifact.content, /Earlier assistant text omitted/);
  }
});

test('oversized identifiers stay unknown and oversized error evidence is bounded and redacted', () => {
  const normalizer = createNormalizer('pi');
  normalizer.push(JSON.stringify({ type: 'session', id: 's'.repeat(9000) }));
  normalizer.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'm'.repeat(9000), stopReason: 'error', errorMessage: `quota exceeded sk-testsecretvalue123456 ${'x'.repeat(9000)}`, content: [{ type: 'text', text: 'PONG' }] } }));
  normalizer.push(JSON.stringify({ type: 'agent_end' }));
  const done = normalizer.finish({ exitCode: 0, cancelled: false, truncated: false });
  assert.equal(done.evidence.terminal, 'error');
  assert.equal(done.evidence.vendorSessionId, undefined);
  assert.equal(done.evidence.vendorModel, undefined);
  assert.equal(done.records.some(record => record.type === 'result'), false);
  for (const record of done.records) if (record.type === 'log') assert.ok(record.message.length <= 4000);
  const evidence = JSON.stringify(done);
  assert.match(evidence, /vendor_session_id limitCharacters=512/);
  assert.match(evidence, /vendor_model limitCharacters=512/);
  assert.match(evidence, /failure_detail limitCharacters=4000/);
  assert.match(evidence, /quota exceeded/);
  assert.doesNotMatch(evidence, /sk-testsecretvalue123456/);
});

test('retained text windows redact a whole credential before clipping through its boundary', () => {
  const normalizer = createNormalizer('pi');
  const secret = 'sk-testsecretvalue123456';
  const text = `${'a'.repeat(10000)} ${secret} ${'z'.repeat(29990)}`;
  normalizer.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } }));
  normalizer.push(JSON.stringify({ type: 'agent_end' }));
  const done = normalizer.finish({ exitCode: 0, cancelled: false, truncated: false });
  assert.equal(done.evidence.terminal, 'success');
  assert.doesNotMatch(JSON.stringify(done), /secretvalue123456|value123456/);
  assert.ok(done.evidence.assistantText.length <= 30000);
});

test('qodercli runs headless from stdin without user hooks, MCP or a saved session, and its stream is normalized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-qoder-'));
  try {
    const prepared = prepareCliAgentInput({ engine: 'qodercli', model: 'Qwen3.8-Flash', effort: 'xhigh', workspace: dir, instruction: 'qodercli', stateDir: join(dir, 'state') });
    assert.equal(prepared.argv[0], 'qodercli');
    assert.equal(prepared.stdin, 'qodercli', 'the prompt goes through stdin, never argv');
    assert.equal(prepared.argv.slice(1).includes('qodercli'), false);
    const argv = prepared.argv.join(' ');
    for (const flag of ['-p', '-o stream-json', '-m Qwen3.8-Flash', '--reasoning-effort xhigh', '--permission-mode bypass_permissions', '--strict-mcp-config', '--no-session-persistence']) assert.ok(argv.includes(flag), flag);
    assert.ok(prepared.argv.includes('--setting-sources') && prepared.argv[prepared.argv.indexOf('--setting-sources') + 1] === '');
    assert.equal(prepared.argv[prepared.argv.indexOf('-w') + 1], prepared.workspace);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const ok = createNormalizer('qodercli');
  const lines = [
    { type: 'system', subtype: 'hook_started', hook_name: 'session', session_id: 'sess-q' },
    { type: 'system', subtype: 'init', session_id: 'sess-q', cwd: '/w', tools: ['Bash'] },
    { type: 'assistant', message: { model: 'Qwen3.8-Flash', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'tool_use', name: 'Write', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'File created' }] } },
    { type: 'assistant', message: { model: 'Qwen3.8-Flash', stop_reason: 'end_turn', content: [{ type: 'text', text: 'DONE' }], usage: { input_tokens: 12, output_tokens: 3 } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'DONE', session_id: 'sess-q', usage: { input_tokens: 12, output_tokens: 3 } },
  ];
  const records = lines.flatMap(line => ok.push(JSON.stringify(line)));
  assert.ok(records.some(item => item.type === 'log' && /tool started Write/.test(item.message)));
  assert.equal(records.filter(item => item.type === 'progress').length, 1, 'hook events are not session starts');
  const done = ok.finish({ exitCode: 0, cancelled: false, truncated: false });
  assert.equal(done.evidence.terminal, 'success');
  assert.equal(done.evidence.vendorSessionId, 'sess-q');
  assert.equal(done.evidence.vendorModel, 'Qwen3.8-Flash');
  assert.deepEqual(done.evidence.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(done.records.find(item => item.type === 'result')?.summary, 'DONE');

  const failed = createNormalizer('qodercli');
  failed.push(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'model not available' }));
  const end = failed.finish({ exitCode: 1, cancelled: false, truncated: false });
  assert.equal(end.evidence.terminal, 'error');
  assert.ok(end.records.some(item => item.type === 'log' && /model not available/.test(item.message)));
});
