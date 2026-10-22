import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { LocalIPCError } from '../../src/main/local-ipc';
import { TASK_STATUSES } from '../../src/main/application/tasks/status';
import { makeRequest } from '../../src/cli/input';
import { parseCLI } from '../../src/cli/parse';
import { CLI_HELP } from '../../src/cli/catalog';
import { CLI_TASK_STATUSES } from '../../src/cli/task-status';

test('the CLI status list matches the server contract', () => {
  assert.deepEqual([...CLI_TASK_STATUSES], [...TASK_STATUSES]);
});

test('tasks list parses --status as a trimmed, deduplicated list and merges --input', () => {
  const options = parseCLI(['tasks', 'list', '--status', ' running, queued ,running,']);
  assert.deepEqual(options.status, ['running', 'queued']);
  assert.deepEqual(makeRequest(options).args, { status: ['running', 'queued'] });

  const single = parseCLI(['tasks', 'list', '--status', 'running']);
  assert.deepEqual(makeRequest(single, { status: 'running' }).args, { status: ['running'] });
  assert.deepEqual(makeRequest(single, { status: ['running'] }).args, { status: ['running'] });
  assert.deepEqual(makeRequest(parseCLI(['tasks', 'list', '--input', '{"status":["running","queued"]}']), { status: ['running', 'queued'] }).args, { status: ['running', 'queued'] });

  assert.throws(() => makeRequest(single, { status: 'queued' }), /Input status does not match CLI status/);
  assert.throws(() => makeRequest(single, { status: ['queued'] }), /Input status does not match CLI status/);
});

test('CLI rejects invalid --status values and other commands', () => {
  for (const argv of [
    ['tasks', 'list', '--status', 'unknown'],
    ['tasks', 'list', '--status', 'running,bogus'],
    ['tasks', 'list', '--status', ''],
    ['tasks', 'list', '--status', ' , , '],
    ['tasks', 'list', '--status'],
    ['tasks', 'get', '--task-id', 't', '--status', 'running'],
    ['tasks', 'create', '--status', 'running'],
    ['tasks', 'list', '--status', 'running', '--status', 'queued'],
  ]) {
    assert.throws(() => parseCLI(argv), (error: unknown) => error instanceof LocalIPCError && error.code === 'INVALID_ARGUMENT', argv.join(' '));
  }

  for (const argv of [
    ['tasks', 'list', '--status', 'unknown'],
    ['tasks', 'list', '--status', ''],
  ]) {
    assert.throws(() => parseCLI(argv), /queued.*running.*cancelling.*completed.*failed.*cancelled/);
  }
});

test('command help lists status and the long help explains the two-stage query', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'tasks', 'list', '--help', '--output', 'json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout).data;
  assert.match(data.usage, /--status queued,running/);
  assert.match(data.inputFields.optional.status, /TaskStatus/);
  assert.match(data.inputFields.optional.status, /filtered before pagination/);
  assert.match(data.cliOptions['--status'], /tasks list only/);

  assert.match(CLI_HELP, /--status <status\[,status\]>/);
  assert.match(CLI_HELP, /tasks list --status running --view brief/);
  assert.match(CLI_HELP, /tasks get --task-id <id>/);
  assert.match(CLI_HELP, /tasks events --task-id <id>/);
  assert.match(CLI_HELP, /tasks health --task-id <id>/);
});
