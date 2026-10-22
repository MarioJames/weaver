import test from 'node:test';
import assert from 'node:assert/strict';
import { CLI_CATALOG } from '../../src/cli/catalog';
import { applyCallerWorkspace, makeRequest } from '../../src/cli/input';
import { parseCLI } from '../../src/cli/parse';
import { runCLI } from '../../src/cli/run';
import type { PollRuntime } from '../../src/cli/poll-task';

const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const verbs = ['list', 'get', 'create', 'update', 'delete', 'enable', 'disable', 'run', 'cancel', 'runs'];
const reads = new Set(['list', 'get', 'runs']);

async function invoke(argv: string[], request?: PollRuntime['request']) {
  let stdout = '';
  const original = process.stdout.write;
  try {
    process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
    const code = await runCLI(argv, request ? { request } : {});
    return { code, stdout };
  } finally { process.stdout.write = original; }
}

test('schedule catalog exposes every logical command, both spellings and exact input/help contracts', async () => {
  const root = await invoke(['--help', '--output', 'json']);
  assert.equal(root.code, 0);
  const catalog = JSON.parse(root.stdout).data.catalog;
  for (const verb of verbs) {
    const name = `schedules.${verb}`;
    assert.equal(parseCLI(['schedules', verb]).command, name);
    assert.equal(parseCLI([name]).command, name);
    const row = catalog.find((entry: { command: string }) => entry.command === name);
    assert.ok(row, name);
    assert.equal(row.mutation, !reads.has(verb));
    assert.equal(row.rpc, undefined);
    assert.ok(row.inputFields.required);
    assert.ok(row.inputFields.optional);
    for (const words of [['schedules', verb], [name]]) {
      const help = await invoke([...words, '--help', '--output', 'jsonl']);
      assert.equal(help.code, 0, help.stdout);
      assert.equal(help.stdout.trim().split('\n').length, 1);
      assert.deepEqual(JSON.parse(help.stdout).data.inputFields, row.inputFields);
    }
    const text = await invoke(['schedules', verb, '--help']);
    assert.equal(text.code, 0);
    assert.match(text.stdout, new RegExp(`schedules ${verb}`));
    assert.match(text.stdout, /Input fields:/);
  }
  assert.ok(catalog.find((entry: { command: string }) => entry.command === 'schedules.cancel').inputFields.required.runId);
  assert.ok(CLI_CATALOG.find(entry => entry.command === 'schedules.update')!.inputFields!.required.expectedRevision);
  assert.ok(CLI_CATALOG.find(entry => entry.command === 'schedules.run')!.inputFields!.optional!.expectedRevision);
  assert.ok(JSON.parse(root.stdout).data.cliOptions['--schedule-id']);
  assert.ok(catalog.find((entry: { command: string }) => entry.command === 'schedules.runs').inputFields.optional.runId);
});

test('schedule convenience flags enforce command scope, UUIDs and input conflicts', () => {
  for (const verb of ['get', 'update', 'delete', 'enable', 'disable', 'run', 'cancel', 'runs']) {
    const options = parseCLI(['schedules', verb, '--schedule-id', id]);
    assert.deepEqual(makeRequest(options, { scheduleId: id }).args, { scheduleId: id });
    assert.throws(() => makeRequest(options, { scheduleId: other }), /does not match CLI schedule ID/);
    assert.throws(() => makeRequest(options, { apiVersion: 'weaver.v1', command: `schedules.${verb}`, args: { scheduleId: other } }), /does not match CLI schedule ID/);
  }
  for (const words of [['tasks', 'get'], ['quota', 'get'], ['schedules', 'list'], ['schedules', 'create']]) {
    assert.throws(() => parseCLI([...words, '--schedule-id', id]), /--schedule-id is only valid/);
  }
  assert.throws(() => parseCLI(['schedules', 'get', '--schedule-id']), /Missing value/);
  assert.throws(() => parseCLI(['schedules', 'get', '--schedule-id', id, '--schedule-id', id]), /Duplicate option/);
  assert.throws(() => parseCLI(['schedules', 'get', '--schedule-id', 'not-a-uuid']), /must be a UUID/);
  assert.throws(() => parseCLI(['schedules', 'cancel', '--expected-revision', '1']), /only valid/);
  const update = parseCLI(['schedules', 'update', '--schedule-id', id, '--expected-revision', '3', '--command-id', 'update-1']);
  const body = { expectedRevision: 3, patch: { enabled: false } };
  const expected = { ...body, scheduleId: id };
  const first = makeRequest(update, body);
  assert.deepEqual(first.args, expected);
  assert.equal(first.commandId, 'update-1');
  assert.deepEqual(makeRequest(update, body), first);
  assert.throws(() => makeRequest(update, { ...body, expectedRevision: 2 }), /does not match CLI expectedRevision/);
});

test('schedule commands reach the real CLI request/output path without RPC wrapping', async () => {
  for (const format of ['json', 'jsonl', 'text']) {
    let sent: unknown;
    const result = await invoke(['schedules', 'cancel', '--schedule-id', id, '--input', JSON.stringify({ runId: other }), '--command-id', 'cancel-1', '--output', format], async (_directory, request) => {
      sent = request;
      return { apiVersion: 'weaver.v1', commandId: 'cancel-1', ok: true, data: { id: other, status: 'cancelled' } };
    });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(sent, { apiVersion: 'weaver.v1', command: 'schedules.cancel', commandId: 'cancel-1', args: { scheduleId: id, runId: other } });
    if (format === 'text') assert.match(result.stdout, /cancelled/);
    else {
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.commandId, 'cancel-1');
      assert.equal(envelope.data.status, 'cancelled');
      if (format === 'jsonl') assert.equal(result.stdout.trim().split('\n').length, 1);
    }
  }
  const conflict = await invoke(['schedules', 'get', '--schedule-id', id, '--input', JSON.stringify({ scheduleId: other }), '--output', 'text'], async () => { assert.fail('invalid input must not reach transport'); });
  assert.equal(conflict.code, 1);
  assert.match(conflict.stdout, /^INVALID_ARGUMENT:/);
});

test('only schedule creation gets caller workspace defaults; task inheritance remains intact', () => {
  for (const kind of ['script', 'agent']) {
    const request = { command: 'schedules.create', args: { kind } };
    applyCallerWorkspace(request, '/tmp/caller');
    assert.equal((request.args as Record<string, unknown>).workspace, undefined);
  }
  const relative = { command: 'schedules.create', args: { workspace: 'project' } };
  applyCallerWorkspace(relative, '/tmp/caller');
  assert.equal(relative.args.workspace, '/tmp/caller/project');
  const blank = { command: 'schedules.create', args: { workspace: '' } };
  applyCallerWorkspace(blank, '/tmp/caller');
  assert.equal(blank.args.workspace, '');
  const builtin = { command: 'schedules.update', args: { scheduleId: id, patch: { enabled: false } } };
  applyCallerWorkspace(builtin, '/tmp/caller');
  assert.deepEqual(builtin.args, { scheduleId: id, patch: { enabled: false } });
  const inherited = { command: 'tasks.create', args: { parentTaskId: other } };
  applyCallerWorkspace(inherited, '/tmp/caller');
  assert.deepEqual(inherited.args, { parentTaskId: other });
});


test('a full schedule envelope preserves the caller command ID and resolves caller workspace', async () => {
  const envelope = { apiVersion: 'weaver.v1', command: 'schedules.create', commandId: 'create-envelope-1', args: { name: 'Check', kind: 'script', timing: { mode: 'interval', seconds: 60 }, script: { command: 'pwd', timeoutSeconds: 10 } } };
  let sent: unknown;
  const result = await invoke(['--input', JSON.stringify(envelope)], async (_directory, request) => {
    sent = request;
    return { apiVersion: 'weaver.v1', commandId: 'create-envelope-1', ok: true, data: { id, revision: 1 } };
  });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(sent, { ...envelope });
  assert.equal(JSON.parse(result.stdout).commandId, 'create-envelope-1');
  const conflict = await invoke(['schedules.create', '--command-id', 'other-command', '--input', JSON.stringify(envelope)], async () => { assert.fail('conflicting IDs must not reach transport'); });
  assert.equal(conflict.code, 1);
  assert.match(JSON.parse(conflict.stdout).error.message, /command ID does not match/);
});


test('runId history detail uses the existing schedules.runs envelope and preserves full output', async () => {
  const detail = { runs: [{ id: other, scheduleId: id, status: 'succeeded', output: 'full detail\nsecond line', truncated: false }], total: 1 };
  let sent: unknown;
  const result = await invoke(['schedules.runs', '--schedule-id', id, '--input', JSON.stringify({ runId: other }), '--output', 'json'], async (_directory, request) => {
    sent = request;
    return { apiVersion: 'weaver.v1', ok: true, data: detail };
  });
  assert.equal(result.code, 0, result.stdout);
  const envelope = sent as Record<string, unknown>;
  assert.equal(envelope.command, 'schedules.runs');
  assert.equal(envelope.method, undefined);
  assert.deepEqual(envelope.args, { runId: other, scheduleId: id });
  assert.deepEqual(JSON.parse(result.stdout).data, detail);
});
