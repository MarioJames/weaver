import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParentAgentError, parentFailureReason, prepareParentAgentInput } from '../../src/main/im/parent-agent';
import { imInstructions, validateImInstructionBudget } from '../../src/main/im/bootstrap';
import { PARENT_TEXT_MAX } from '../../src/main/im/limits';
import { IM_ENGINE_KINDS, imEngineEffortAllowed, imEngineEfforts, isImEngineKind } from '../../src/shared/im-engines';

const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'im-engines-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('the shared IM engine list is exactly the seven installed catalog kinds, never mock-jsonl', () => {
  assert.deepEqual([...IM_ENGINE_KINDS].sort(), ['claude', 'codex', 'dsh', 'grok', 'opencode', 'pi', 'qodercli']);
  for (const kind of IM_ENGINE_KINDS) assert.equal(isImEngineKind(kind), true);
  assert.equal(isImEngineKind('mock-jsonl'), false);
  assert.equal(isImEngineKind('zed'), false);
  assert.equal(imEngineEfforts('opencode'), undefined);
  assert.equal(imEngineEfforts('claude')?.includes('xhigh'), true);
  assert.deepEqual(imEngineEfforts('dsh'), ['off', 'low', 'high', 'max']);
});

test('parent preparation accepts every enabled engine effort and keeps OpenCode variant free-form', () => {
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  const efforts: Record<string, string> = { claude: 'xhigh', codex: 'xhigh', opencode: 'provider-variant', pi: 'max', grok: 'xhigh', qodercli: 'ultracode', dsh: 'high' };
  for (const kind of IM_ENGINE_KINDS) {
    const prepared = prepareParentAgentInput({ engineKind: kind, model: kind === 'opencode' ? 'provider/model' : 'fixture-model', effort: efforts[kind]!, workspace, instructions: 'fixture' });
    assert.equal(prepared.engineKind, kind);
  }
  assert.throws(() => prepareParentAgentInput({ engineKind: 'mock-jsonl' as never, model: 'm', effort: 'high', workspace, instructions: 'x' }), (error: unknown) => error instanceof ParentAgentError && error.reason === 'invalid_input');
  assert.throws(() => prepareParentAgentInput({ engineKind: 'claude', model: 'm', effort: 'ultracode', workspace, instructions: 'x' }), /effort/);
  assert.equal(imEngineEffortAllowed('opencode', 'a'.repeat(32)), true);
  assert.equal(imEngineEffortAllowed('opencode', 'a'.repeat(33)), false);
});

test('the bootstrap budget reserves the longest supported kind, qodercli, without truncating instructions', () => {
  const epoch = '00000000-0000-0000-0000-000000000000';
  const paths = [join(dir, "项目 'quoted' \\ path 😀")];
  for (const kind of IM_ENGINE_KINDS) {
    const text = imInstructions('/data', kind, epoch, paths);
    assert.ok(text.includes(JSON.stringify(paths)));
    assert.ok(text.includes(`engineKind=${kind}`));
    assert.ok(text.length <= PARENT_TEXT_MAX);
  }
  const base = imInstructions('/data', 'claude', epoch, paths);
  const dataDir = '/data' + 'x'.repeat(PARENT_TEXT_MAX - base.length);
  assert.equal(imInstructions(dataDir, 'claude', epoch, paths).length, PARENT_TEXT_MAX);
  assert.throws(() => validateImInstructionBudget(dataDir, paths), { code: 'IM_BOOTSTRAP_TOO_LARGE' }, 'the save budget must use qodercli, the longest kind');
  assert.throws(() => imInstructions(dataDir, 'qodercli', epoch, paths), { code: 'IM_BOOTSTRAP_TOO_LARGE' });
});

test('auth failures are classified only from bounded text and never expose vendor payloads', () => {
  assert.equal(parentFailureReason('authentication failed: invalid api key'), 'auth');
  assert.equal(parentFailureReason('401 unauthorized'), 'auth');
  assert.equal(parentFailureReason('model backend exploded'), 'engine');
});
