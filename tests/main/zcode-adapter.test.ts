import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkerRecord } from '../../src/shared/validation';
import { buildLaunchSpec } from '../../src/main/adapters/cli/argv';
import { prepareCliAgentInput } from '../../src/main/adapters/cli';
import { createNormalizer } from '../../src/main/adapters/cli/normalize';
import { HELLO_ENGINES } from '../../src/main/engines/hello';
import type { CliAgentInput } from '../../src/main/adapters/cli';

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', name), 'utf8');
}

test('zcode launch spec uses the flags verified in zcode 0.16.9 and never invents a model flag', () => {
  const spec = buildLaunchSpec({ engine: 'zcode', model: 'account:zai-start-plan/GLM-5.3-Flash', effort: 'auto', workspace: '/tmp/not-checked', instruction: 'Reply with exactly: hi', promptPath: '/tmp/prompt.txt', sessionDir: '/tmp/pi-session', leaderSocket: '/tmp/leader.sock' });
  assert.equal(spec.stdin, null);
  assert.deepEqual(spec.argv, ['zcode', '--prompt', 'Reply with exactly: hi', '--output-format', 'stream-json', '--mode', 'yolo']);
  assert.equal(spec.argv.includes('--model'), false);
  assert.equal(spec.argv.includes('--permission-mode'), false);
});

test('zcode agent prep is accepted like other real engines and keeps the prompt off the log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-zcode-adapter-'));
  try {
    const input: CliAgentInput = { engine: 'zcode', model: 'account:zai-start-plan/GLM-5.3-Flash', effort: 'auto', workspace: dir, instruction: 'MARKER-zcode-instruction', stateDir: join(dir, 'state') };
    const prepared = prepareCliAgentInput(input);
    assert.equal(prepared.argv[0], 'zcode');
    assert.equal(prepared.stdin, null);
    // Unlike the stdin/file engines, zcode headless has only --prompt <text> on argv.
    const at = prepared.argv.indexOf('--prompt');
    assert.equal(at >= 0, true);
    assert.equal(prepared.argv[at + 1], 'MARKER-zcode-instruction');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recorded zcode failure stream normalizes to a vendor error without a result', () => {
  const failedLine = fixture('zcode-stream-turn-failed.ndjson').trim();
  const failedStderr = fixture('zcode-stream-turn-failed-stderr.txt').trim();
  const normalizer = createNormalizer('zcode');
  const emitted = failedLine.split('\n').map(line => normalizer.push(line)).flat();
  const done = normalizer.finish({ exitCode: 1, cancelled: false, truncated: false });
  const records = [...emitted, ...done.records];
  for (const record of records) parseWorkerRecord(record);
  assert.equal(done.evidence.terminal, 'error');
  assert.equal(done.evidence.vendorSessionId, 'sess_3a9052bf-fe72-48a1-98d9-16c898f6ca79');
  assert.equal(done.evidence.assistantText, '');
  assert.equal(records.some(record => record.type === 'result'), false);
  assert.ok(records.some(record => record.type === 'log' && record.message.includes('Select a model before continuing')));
  // The stderr summary stays available for the launcher's vendor-error classification.
  assert.match(failedStderr, /^Error: Model creation failed \(traceId: /);
});

test('unrelated zcode stream events never fabricate a terminal', () => {
  for (const line of ['{"type":"turn.started","seq":1,"sessionId":"s"}', '{"type":"message.delta","payload":{"text":"hi"},"sessionId":"s"}', 'vendor noise without json']) {
    const normalizer = createNormalizer('zcode');
    normalizer.push(line);
    const done = normalizer.finish({ exitCode: 0, cancelled: false, truncated: false });
    assert.equal(done.evidence.terminal, 'missing');
    assert.equal(done.evidence.assistantText, '');
  }
});

// The stream-json success shape comes from reading the runPrompt summary writer in the
// zcode 0.16.9 bundle (a trailing {type:"result",...,response} object), not from a live
// verified run: the account providers could not materialize in standalone sessions here.
test('a zcode result summary owns the success terminal with the bounded response', () => {
  const normalizer = createNormalizer('zcode');
  const emitted = [
    JSON.stringify({ type: 'turn.started', seq: 1, sessionId: 'sess-v', traceId: 't-1' }),
    JSON.stringify({ type: 'result', sessionId: 'sess-v', eventCount: 7, response: 'hi', projection: { status: 'completed', turnCount: 1 } }),
  ].map(line => normalizer.push(line)).flat();
  const done = normalizer.finish({ exitCode: 0, cancelled: false, truncated: false });
  const records = [...emitted, ...done.records];
  for (const record of records) parseWorkerRecord(record);
  assert.equal(done.evidence.terminal, 'success');
  assert.equal(done.evidence.vendorSessionId, 'sess-v');
  assert.equal(done.evidence.assistantText, 'hi');
  assert.equal(records.some(record => record.type === 'result'), true);
  assert.ok(records.some(record => record.type === 'artifact' && record.name === 'result.md'));
});

test('a zcode result envelope without a usable response is an error, not a hang', () => {
  const normalizer = createNormalizer('zcode');
  normalizer.push(JSON.stringify({ type: 'result', sessionId: 'sess-x', response: '' }));
  const done = normalizer.finish({ exitCode: 0, cancelled: false, truncated: false });
  assert.equal(done.evidence.terminal, 'error');
  assert.equal(done.evidence.assistantText, '');
});

test('zcode hello probe parses the single-object json output and an empty stream defers to stderr', () => {
  assert.deepEqual(HELLO_ENGINES.zcode!.parse('{"sessionId":"s","response":"hi","projection":{"status":"completed"}}'), { reply: 'hi' });
  assert.ok(HELLO_ENGINES.zcode!.parse('not json').error);
  assert.deepEqual(HELLO_ENGINES.zcode!.parse(''), {});
  assert.deepEqual(HELLO_ENGINES.zcode!.argv('account:zai-start-plan/GLM-5.3-Flash', 'auto'), ['--prompt', 'Reply with exactly: hi', '--output-format', 'json', '--mode', 'yolo']);
});
