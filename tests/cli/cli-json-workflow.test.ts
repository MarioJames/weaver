import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRequest } from '../../src/cli/input';
import { parseCLI } from '../../src/cli/parse';
import { runCLI } from '../../src/cli/run';


test('revision, digest and review flags merge without constructing JSON and reject conflicts', () => {
  const argv = ['reviews', 'submit', '--task-id', 't', '--expected-revision', '7', '--manifest-digest', 'abc', '--decision', 'accepted', '--comment', '已验证 "引号"\n字面量\\n'];
  const options = parseCLI(argv);
  assert.deepEqual(makeRequest(options).args, { taskId: 't', expectedRevision: 7, manifestDigest: 'abc', decision: 'accepted', comment: '已验证 "引号"\n字面量\\n' });
  assert.throws(() => makeRequest(options, { expectedRevision: 6 }), /does not match/);
  assert.throws(() => makeRequest(options, { manifestDigest: 'old' }), /does not match/);
  for (const extra of [ ['--expected-revision', '-1'], ['--expected-revision', '1.2'], ['--expected-revision', '9007199254740992'], ['--decision', 'maybe'], ['--decision', 'accepted', '--decision', 'rejected'] ]) {
    assert.throws(() => parseCLI(['reviews', 'submit', ...extra]));
  }
  for (const extra of [['--manifest-digest', 'x'], ['--decision', 'accepted'], ['--comment-file', 'x'], ['--expected-revision', '1']]) {
    assert.throws(() => parseCLI(['tasks', 'get', ...extra]), /only valid/);
  }
  assert.throws(() => parseCLI(['tasks', 'wait', '--field', 'data.id']), /only valid/);
  assert.throws(() => parseCLI(['results', 'ack', '--field', 'data.id']), /only valid/);
  assert.throws(() => parseCLI(['tasks', 'get', '--field', 'data..id']), /--field/);
  assert.throws(() => parseCLI(['tasks', 'get', '--field', 'data.id', '--json']), /cannot be combined/);
  assert.throws(() => parseCLI(['tasks', 'get', '--field', 'data.id', '--output', 'text']), /cannot be combined/);
  assert.throws(() => makeRequest(options, { apiVersion: 'weaver.v1', command: 'reviews.submit', args: { decision: 'rejected' } }), /does not match/);
  assert.throws(() => parseCLI(['reviews', 'submit', '--comment', 'x', '--comment-file', 'x']), /cannot be combined/);
});

test('field reads and file-backed review round-trip unicode, newlines and quotes without shell JSON parsing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weaver-cli-json-'));
  const comment = '中文 "评审"\n真实换行，字面量 \\n 和 \\t';
  await writeFile(`${root}/comment.txt`, comment);
  const original = process.stdout.write;
  let output = '';
  const sent: Record<string, unknown>[] = [];
  let revision = 7;
  const runtime = { request: async (_dir: string, request: unknown) => {
    const value = request as Record<string, unknown>; sent.push(value);
    if (value.command === 'tasks.get') return { apiVersion: 'weaver.v1', ok: true, data: { revision, summary: comment } };
    if (value.command === 'tasks.results') return { apiVersion: 'weaver.v1', ok: true, data: { manifestDigest: 'abc', summary: comment } };
    revision++;
    return { apiVersion: 'weaver.v1', ok: true, data: { revision } };
  } };
  try {
    process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    const run = async (argv: string[]) => { output = ''; const code = await runCLI(argv, runtime); return { code, output }; };
    assert.deepEqual(await run(['tasks', 'get', '--field', 'data.revision']), { code: 0, output: '7\n' });
    assert.deepEqual(await run(['tasks', 'results', '--field', 'data.manifestDigest']), { code: 0, output: 'abc\n' });
    assert.equal((await run(['results', 'ack', '--task-id', 't', '--expected-revision', '7', '--manifest-digest', 'abc', '--command-id', 'ack'])).code, 0);
    assert.deepEqual(await run(['tasks', 'get', '--field', 'data.revision']), { code: 0, output: '8\n' });
    assert.equal((await run(['reviews', 'submit', '--task-id', 't', '--expected-revision', '8', '--manifest-digest', 'abc', '--decision', 'accepted', '--comment-file', `${root}/comment.txt`, '--command-id', 'review'])).code, 0);
    assert.deepEqual(sent.at(-1)?.args, { taskId: 't', expectedRevision: 8, manifestDigest: 'abc', decision: 'accepted', comment });
    for (const path of ['data.missing', 'data', 'data.__proto__']) {
      const result = await run(['tasks', 'get', '--field', path]);
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.output).error.code, 'INVALID_ARGUMENT');
    }
    const count = sent.length;
    const bad = await run(['reviews', 'submit', '--comment-file', `${root}/missing`]);
    assert.equal(bad.code, 1); assert.equal(sent.length, count);
    assert.match(bad.output, /could not be read/);
    for (const content of ['字'.repeat(4001), Buffer.from([0xff])]) {
      await writeFile(`${root}/bad.txt`, content);
      const invalid = await run(['reviews', 'submit', '--comment-file', `${root}/bad.txt`]);
      assert.equal(invalid.code, 1); assert.equal(sent.length, count);
      assert.equal(JSON.parse(invalid.output).error.code, 'INVALID_ARGUMENT');
    }
    const conflict = await run(['reviews', 'submit', '--comment-file', `${root}/comment.txt`, '--input', '{"comment":"different"}']);
    assert.equal(conflict.code, 1); assert.equal(sent.length, count);
  } finally { process.stdout.write = original; await rm(root, { recursive: true, force: true }); }
});

test('failed responses are never projected into success-looking scalar output', async () => {
  const original = process.stdout.write;
  let output = '';
  try {
    process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    assert.equal(await runCLI(['tasks', 'get', '--field', 'data.revision'], { request: async () => ({ apiVersion: 'weaver.v1', ok: false, error: { code: 'NOT_FOUND', message: 'missing' } }) }), 1);
    assert.equal(JSON.parse(output).error.code, 'NOT_FOUND');
  } finally { process.stdout.write = original; }
});

test('real zsh captures scalar fields and sends quoted-heredoc JSON and literal review files', async () => {
  const { spawnSync } = await import('node:child_process');
  const { readFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const directory = await mkdtemp(join(tmpdir(), 'weaver-cli-zsh-'));
  const comment = '中文 "引号"\n实际换行 / 字面量\\n';
  await writeFile(`${directory}/review.txt`, comment);
  await writeFile(`${directory}/cli.mjs`, `
    import { runCLI } from ${JSON.stringify(pathToFileURL(`${process.cwd()}/src/cli/run.ts`).href)};
    import { appendFile } from 'node:fs/promises';
    process.exitCode = await runCLI(process.argv.slice(2), { request: async (_dir, request) => {
      await appendFile(${JSON.stringify(`${directory}/requests.jsonl`)}, JSON.stringify(request)+'\\n');
      return { apiVersion: 'weaver.v1', ok: true, data: { revision: 8, manifestDigest: 'digest', summary: ${JSON.stringify(comment)} } };
    }});
  `);
  try {
    const result = spawnSync('zsh', ['-f', '-c', `
      cli() { "$1" --import tsx "$2" "\${@:3}"; }
      runner() { cli "$node_bin" "$wrapper" "$@"; }
      node_bin=$1
      wrapper=$2
      review_file=$3
      digest=$(runner tasks results --task-id task --field data.manifestDigest) || exit
      revision=$(runner tasks get --task-id task --field data.revision) || exit
      runner results ack --task-id task --manifest-digest "$digest" --expected-revision "$revision" --command-id ack || exit
      runner reviews submit --task-id task --manifest-digest "$digest" --expected-revision "$revision" --decision accepted --comment-file "$review_file" --command-id review || exit
      runner tasks complete --task-id task --command-id complete --input - <<'JSON'
{"outcome":"completed","summary":"中文 \\"引号\\"\\n第二行，字面量 \\\\n"}
JSON
    `, 'workflow', process.execPath, `${directory}/cli.mjs`, `${directory}/review.txt`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const requests = (await readFile(`${directory}/requests.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.length, 5);
    assert.deepEqual(requests[2].args, { taskId: 'task', expectedRevision: 8, manifestDigest: 'digest' });
    assert.equal(requests[3].args.comment, comment);
    assert.equal(requests[4].args.summary, '中文 "引号"\n第二行，字面量 \\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('engines models merges --engine and --refresh into the RPC body without --input and rejects a conflicting --input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weaver-cli-models-'));
  await writeFile(`${root}/same.json`, JSON.stringify({ engine: 'codex' }));
  await writeFile(`${root}/other.json`, JSON.stringify({ engine: 'claude' }));
  const original = process.stdout.write;
  let output = '';
  const sent: unknown[] = [];
  const runtime = { request: async (_dir: string, request: unknown) => { sent.push(request); return { apiVersion: 'weaver.v1', ok: true, data: { models: [] } }; } };
  try {
    process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    assert.equal(await runCLI(['engines', 'models', '--engine', 'codex'], runtime), 0);
    assert.equal(await runCLI(['engines', 'models', '--engine', 'codex', '--refresh'], runtime), 0);
    assert.equal(await runCLI(['engines', 'models', '--engine', 'codex', '--input', `${root}/same.json`], runtime), 0);
    assert.deepEqual(sent, [
      { method: 'listEngineModels', args: [{ engine: 'codex' }] },
      { method: 'listEngineModels', args: [{ engine: 'codex', refresh: true }] },
      { method: 'listEngineModels', args: [{ engine: 'codex' }] },
    ]);
    output = '';
    assert.equal(await runCLI(['engines', 'models', '--engine', 'codex', '--input', `${root}/other.json`], runtime), 1);
    assert.match(JSON.parse(output).error.message, /Input engine does not match CLI engine/);
    output = '';
    assert.equal(await runCLI(['engines', 'models'], runtime), 1);
    assert.match(JSON.parse(output).error.message, /requires --input/);
    assert.equal(sent.length, 3);
  } finally { process.stdout.write = original; await rm(root, { recursive: true, force: true }); }
});
