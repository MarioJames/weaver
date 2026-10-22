import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { LocalIPCError } from '../../src/main/local-ipc';
import { makeRequest } from '../../src/cli/input';
import { parseCLI } from '../../src/cli/parse';

test('tasks get/list parse --view and --fields into request args', () => {
  const list = parseCLI(['tasks', 'list', '--view', 'brief', '--fields', 'id,status,title']);
  assert.equal(list.view, 'brief');
  assert.deepEqual(list.fields, ['id', 'status', 'title']);
  assert.deepEqual(makeRequest(list).args, { view: 'brief', fields: ['id', 'status', 'title'] });

  const get = parseCLI(['tasks', 'get', '--task-id', 't', '--view', 'full', '--fields', 'id, status,title']);
  assert.deepEqual(makeRequest(get).args, { taskId: 't', view: 'full', fields: ['id', 'status', 'title'] });

  const fromInput = parseCLI(['tasks', 'list', '--input', '{"view":"brief","fields":["id","status"]}']);
  assert.deepEqual(fromInput.fields, undefined);
  assert.deepEqual(makeRequest(fromInput, { view: 'brief', fields: ['id', 'status'] }).args, { view: 'brief', fields: ['id', 'status'] });
});

test('CLI view/fields reject conflicts, empty values and other commands', () => {
  const options = parseCLI(['tasks', 'list', '--view', 'brief', '--fields', 'id,status']);
  assert.throws(() => makeRequest(options, { view: 'full' }), /Input view does not match CLI view/);
  assert.throws(() => makeRequest(options, { fields: ['id', 'title'] }), /Input fields does not match CLI fields/);
  assert.deepEqual(makeRequest(options, { view: 'brief', fields: ['id', 'status'] }).args, { view: 'brief', fields: ['id', 'status'] });

  for (const argv of [
    ['tasks', 'list', '--view', 'compact'],
    ['tasks', 'list', '--fields', ''],
    ['tasks', 'list', '--fields', ' , , '],
    ['tasks', 'list', '--fields', ','],
    ['tasks', 'list', '--view'],
    ['tasks', 'get', '--fields', 'id', '--fields', 'status'],
    ['tasks', 'create', '--view', 'brief'],
    ['tasks', 'get', '--fields', 'id', '--field', 'data.revision'],
  ]) {
    assert.throws(() => parseCLI(argv), (error: unknown) => error instanceof LocalIPCError && error.code === 'INVALID_ARGUMENT', argv.join(' '));
  }
});

test('command help lists view and fields for tasks get and list', () => {
  for (const words of [['tasks', 'list'], ['tasks', 'get']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...words, '--help', '--output', 'json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.command, words.join('.'));
    assert.match(data.usage, /--view full\|brief/);
    assert.match(data.usage, /--fields/);
    assert.equal(data.inputFields.optional.view, 'full (default) | brief');
    assert.match(data.inputFields.optional.fields, /top-level task field/);
    assert.match(JSON.stringify(data.cliOptions), /--view/);
    assert.match(JSON.stringify(data.cliOptions), /--fields/);
  }
});
