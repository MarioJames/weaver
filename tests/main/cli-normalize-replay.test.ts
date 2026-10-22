import test from 'node:test';
import assert from 'node:assert/strict';
import { createNormalizer } from '../../src/main/adapters/cli/normalize';
import { decodeLines } from '../../src/main/adapters/cli/scope';
import type { RealEngineKind, WorkerRecord } from '../../src/shared/contracts/tasks';

interface Sample {
  engine: RealEngineKind;
  name: string;
  lines: string[];
}

const J = (value: unknown): string => JSON.stringify(value);

function samples(): Sample[] {
  return [
    {
      engine: 'pi',
      name: 'success with session, usage and a failed tool',
      lines: [
        J({ type: 'session', id: 'sess-pi-1' }),
        J({ type: 'agent_start' }),
        J({ type: 'tool_execution_start', toolName: 'read' }),
        J({ type: 'tool_execution_end', toolName: 'read', isError: true }),
        J({ type: 'message_end', message: { role: 'assistant', provider: 'cc-switch-agentplan', model: 'glm-5.3-flash', stopReason: 'stop', content: [{ type: 'text', text: 'PONG' }], usage: { input: 3, output: 1 } } }),
        J({ type: 'agent_end', messages: [{ huge: true }] }),
        J({ type: 'agent_settled', aborted: false }),
      ],
    },
    {
      engine: 'pi',
      name: 'quota failure',
      lines: [
        J({ type: 'session', id: 'sess-pi-2' }),
        J({ type: 'message_end', message: { role: 'assistant', provider: 'cc-switch-agentplan', model: 'glm-5.3-flash', stopReason: 'error', errorMessage: 'quota exceeded for glm-5.3-flash', content: [{ type: 'text', text: 'PONG' }], usage: { input: 3, output: 0 } } }),
        J({ type: 'agent_end' }),
      ],
    },
    {
      engine: 'opencode',
      name: 'success with session, usage and a failed tool',
      lines: [
        J({ type: 'text', sessionID: 'sess-oc-1', part: { type: 'text', text: 'PONG' } }),
        J({ type: 'tool_use', sessionID: 'sess-oc-1', part: { type: 'tool', tool: 'write', state: { status: 'error' } } }),
        J({ type: 'step_finish', sessionID: 'sess-oc-1', part: { reason: 'stop', tokens: { input: 2, output: 1 } } }),
      ],
    },
    {
      engine: 'opencode',
      name: 'auth failure',
      lines: [
        J({ type: 'error', sessionID: 'sess-oc-2', error: { name: 'ProviderAuthError', data: { message: 'invalid api key' } } }),
        J({ type: 'text', sessionID: 'sess-oc-2', part: { type: 'text', text: 'PONG' } }),
        J({ type: 'step_finish', sessionID: 'sess-oc-2', part: { reason: 'stop' } }),
      ],
    },
    {
      engine: 'grok',
      name: 'success with session, usage and a failed tool-shaped message',
      lines: [
        J({ type: 'system', subtype: 'init', session_id: 'sess-grok-1', model: 'grok-4.7', tools: ['bash'] }),
        J({ type: 'assistant', message: { model: 'grok-4.7', content: [{ type: 'text', text: 'PONG' }], usage: { input_tokens: 4, output_tokens: 1 } } }),
        J({ type: 'result', subtype: 'success', is_error: false, result: 'PONG', session_id: 'sess-grok-1', usage: { input_tokens: 4, output_tokens: 1 } }),
      ],
    },
    {
      engine: 'grok',
      name: 'result failure',
      lines: [
        J({ type: 'system', subtype: 'init', session_id: 'sess-grok-2', model: 'grok-4.7' }),
        J({ type: 'result', subtype: 'error', is_error: true, result: 'rate limit hit', session_id: 'sess-grok-2' }),
      ],
    },
    {
      engine: 'codex',
      name: 'success with thread, usage and a failed command tool',
      lines: [
        J({ type: 'thread.started', thread_id: 'thread-1' }),
        J({ type: 'item.completed', item: { type: 'command_execution', command: 'exit 1' } }),
        J({ type: 'item.completed', item: { type: 'agent_message', text: 'PONG' } }),
        J({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }),
      ],
    },
    {
      engine: 'codex',
      name: 'turn failure',
      lines: [
        J({ type: 'thread.started', thread_id: 'thread-2' }),
        J({ type: 'turn.failed', error: { message: 'upstream 429 rate limit' } }),
      ],
    },
    {
      engine: 'qodercli',
      name: 'success with session, usage and a tool call',
      lines: [
        J({ type: 'system', subtype: 'init', session_id: 'sess-qo-1' }),
        J({ type: 'assistant', message: { model: 'qoder-x', content: [{ type: 'tool_use', name: 'bash' }, { type: 'text', text: 'PONG' }], usage: { input_tokens: 6, output_tokens: 3 } } }),
        J({ type: 'result', subtype: 'success', is_error: false, result: 'PONG', session_id: 'sess-qo-1', usage: { input_tokens: 6, output_tokens: 3 } }),
      ],
    },
    {
      engine: 'qodercli',
      name: 'result failure',
      lines: [
        J({ type: 'system', subtype: 'init', session_id: 'sess-qo-2' }),
        J({ type: 'result', subtype: 'error', is_error: true, result: 'quota gone', session_id: 'sess-qo-2' }),
      ],
    },
    {
      engine: 'dsh',
      name: 'success with session, usage and a failed tool_result',
      lines: [
        J({ type: 'session', sessionId: 'sess-dsh-1' }),
        J({ type: 'status', phase: 'turn_start' }),
        J({ type: 'tool_call', callId: 'c1', tool: 'bash' }),
        J({ type: 'tool_result', callId: 'c1', status: 'error' }),
        J({ type: 'status', phase: 'step_end', usage: { input_tokens: 7, output_tokens: 2 } }),
        J({ type: 'final', text: 'PONG' }),
        J({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }),
      ],
    },
    {
      engine: 'dsh',
      name: 'turn error failure',
      lines: [
        J({ type: 'session', sessionId: 'sess-dsh-2' }),
        J({ type: 'status', phase: 'turn_start' }),
        J({ type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { code: 'E_CONN', message: 'boom' } } }),
      ],
    },
  ];
}

function onlinePush(engine: RealEngineKind, lines: string[]): { records: WorkerRecord[]; finish: ReturnType<ReturnType<typeof createNormalizer>['finish']>; sessionId: string | undefined } {
  const normalizer = createNormalizer(engine);
  const records: WorkerRecord[] = [];
  for (const line of lines) records.push(...normalizer.push(line));
  const finish = normalizer.finish({ exitCode: 0, cancelled: false, truncated: false });
  return { records, finish, sessionId: normalizer.sessionId() };
}

function replayPush(engine: RealEngineKind, lines: string[], chunkBytes = 7): { records: WorkerRecord[]; finish: ReturnType<ReturnType<typeof createNormalizer>['finish']>; sessionId: string | undefined } {
  const bytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  const normalizer = createNormalizer(engine);
  const records: WorkerRecord[] = [];
  const overflows: unknown[] = [];
  const decoder = decodeLines(
    line => {
      records.push(...normalizer.push(line));
    },
    detail => {
      overflows.push(detail);
    },
  );
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) decoder.write(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)));
  decoder.end();
  assert.equal(overflows.length, 0, `${engine}: replay slices must not overflow`);
  const finish = normalizer.finish({ exitCode: 0, cancelled: false, truncated: false });
  return { records, finish, sessionId: normalizer.sessionId() };
}

test('six engines: online push and byte-concat/small-slice/decodeLines replay are equivalent', () => {
  for (const sample of samples()) {
    const online = onlinePush(sample.engine, sample.lines);
    const replayed = replayPush(sample.engine, sample.lines);
    assert.deepEqual(replayed.records, online.records, `${sample.engine} ${sample.name}: records differ`);
    assert.deepEqual(replayed.finish.records, online.finish.records, `${sample.engine} ${sample.name}: finish records differ`);
    assert.deepEqual(replayed.finish.evidence, online.finish.evidence, `${sample.engine} ${sample.name}: finish evidence differs`);
    assert.equal(replayed.sessionId, online.sessionId, `${sample.engine} ${sample.name}: sessionId differs`);
  }
});

test('dsh replay from a middle offset is not equal to a full replay (must restart from byte 0)', () => {
  const sample = samples().find(entry => entry.engine === 'dsh' && entry.name.startsWith('success'))!;
  const full = replayPush('dsh', sample.lines);
  // Replay starting after the tool_call line: the tool_result loses its tool name.
  const skipBytes = Buffer.byteLength(`${sample.lines.slice(0, 3).join('\n')}\n`, 'utf8');
  const bytes = Buffer.from(`${sample.lines.join('\n')}\n`, 'utf8');
  const normalizer = createNormalizer('dsh');
  const records: WorkerRecord[] = [];
  const decoder = decodeLines(
    line => {
      records.push(...normalizer.push(line));
    },
    () => {},
  );
  decoder.write(bytes.subarray(skipBytes));
  decoder.end();
  assert.notDeepEqual(records, full.records, 'a mid-offset dsh replay must resolve tool_result generically');
});

test('finish matrix: cancelled wins, null exit is missing, pi needs sessionClosed and stop', () => {
  const piSuccess = samples().find(entry => entry.engine === 'pi' && entry.name.startsWith('success'))!.lines;
  const pushAll = (engine: RealEngineKind, lines: string[]) => {
    const normalizer = createNormalizer(engine);
    for (const line of lines) normalizer.push(line);
    return normalizer;
  };
  // Cancelled wins over an otherwise successful run.
  assert.equal(pushAll('pi', piSuccess).finish({ exitCode: 0, cancelled: true, truncated: false }).evidence.terminal, 'cancelled');
  // A null exit code is missing even with complete vendor output.
  assert.equal(pushAll('pi', piSuccess).finish({ exitCode: null, cancelled: false, truncated: false }).evidence.terminal, 'missing');
  // Truncation wins over vendor output.
  assert.equal(pushAll('pi', piSuccess).finish({ exitCode: 0, cancelled: false, truncated: true }).evidence.terminal, 'truncated');
  // A vendor error with a zero exit is still an error.
  const piFailure = samples().find(entry => entry.engine === 'pi' && entry.name.includes('quota'))!.lines;
  assert.equal(pushAll('pi', piFailure).finish({ exitCode: 0, cancelled: false, truncated: false }).evidence.terminal, 'error');
  // Pi without agent_end is missing even with stopReason stop.
  const piNoEnd = [J({ type: 'session', id: 's' }), J({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'PONG' }] } })];
  assert.equal(pushAll('pi', piNoEnd).finish({ exitCode: 0, cancelled: false, truncated: false }).evidence.terminal, 'missing');
  // Pi stopReason length is truncated.
  const piLength = [J({ type: 'message_end', message: { role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: 'PONG' }] } }), J({ type: 'agent_end' })];
  assert.equal(pushAll('pi', piLength).finish({ exitCode: 0, cancelled: false, truncated: false }).evidence.terminal, 'truncated');
});
