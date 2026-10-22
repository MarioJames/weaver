import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLI_CATALOG, CLI_HELP, CLI_VALUE_OPTIONS } from '../../src/cli/catalog';
import { makeRequest } from '../../src/cli/input';
import { readOwnerCredential } from '../../src/cli/owner-identity';
import { parseCLI } from '../../src/cli/parse';
import { runCLI } from '../../src/cli/run';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'a'.repeat(64);

async function credentialFile(root: string, value: unknown = { version: 1, ownerId: OWNER_ID, token: TOKEN }, name = 'owner.json'): Promise<string> {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function capture(run: () => Promise<number>): Promise<{ code: number; output: string }> {
  const original = process.stdout.write;
  let output = '';
  try {
    process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    return { code: await run(), output };
  } finally {
    process.stdout.write = original;
  }
}

test('--owner-file is a global value option, resolved once, and duplicates or missing values fail', () => {
  const options = parseCLI(['tasks', 'get', '--task-id', 't', '--owner-file', 'cred.json']);
  assert.equal(options.command, 'tasks.get');
  assert.equal(options.ownerFile, resolve('cred.json'));
  assert.throws(() => parseCLI(['tasks', 'get', '--owner-file', 'a', '--owner-file', 'b']), /Duplicate option --owner-file/);
  assert.throws(() => parseCLI(['tasks', 'get', '--owner-file']), /Missing value for --owner-file/);
  assert.equal(parseCLI(['tasks', 'wait', '--task-id', 't', '--owner-file', 'cred.json']).command, 'tasks.wait');
});

test('the credential reader enforces the private file contract without echoing its body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wv-owner-'));
  try {
    const good = await credentialFile(root);
    assert.deepEqual(await readOwnerCredential(good), { ownerId: OWNER_ID, token: TOKEN });

    const unsafe = await credentialFile(root, { version: 1, ownerId: OWNER_ID, token: TOKEN }, 'unsafe.json');
    await chmod(unsafe, 0o644);
    await assert.rejects(readOwnerCredential(unsafe), (error: { code: string; message: string }) => {
      assert.equal(error.code, 'UNSAFE_ENDPOINT');
      assert.ok(!error.message.includes(TOKEN), 'the token must never appear in an error');
      return true;
    });

    const link = join(root, 'link.json');
    await symlink(good, link);
    await assert.rejects(readOwnerCredential(link), { code: 'UNSAFE_ENDPOINT' });

    await assert.rejects(readOwnerCredential(join(root, 'missing.json')), (error: { code: string; message: string }) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /not found/);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });

    for (const value of [
      'not json',
      { version: 2, ownerId: OWNER_ID, token: TOKEN },
      { version: 1, ownerId: 'not-a-uuid', token: TOKEN },
      { version: 1, ownerId: OWNER_ID, token: TOKEN.toUpperCase() },
      { version: 1, ownerId: OWNER_ID },
    ]) {
      const path = join(root, `bad-${String(Math.random()).slice(2)}.json`);
      await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
      await chmod(path, 0o600);
      await assert.rejects(readOwnerCredential(path), (error: { code: string; message: string }) => {
        assert.equal(error.code, 'INVALID_ARGUMENT');
        assert.ok(!error.message.includes(TOKEN));
        return true;
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('logical requests carry ownerAuth at the top level, never in args, and conflicts fail closed', () => {
  const options = parseCLI(['tasks', 'get', '--task-id', 't']);
  const auth = { ownerId: OWNER_ID, token: TOKEN };
  const request = makeRequest(options, {}, auth);
  assert.deepEqual(request.ownerAuth, auth);
  assert.deepEqual(request.args, { taskId: 't' });
  assert.equal((request.args as Record<string, unknown>).ownerAuth, undefined);

  const added = makeRequest(options, { apiVersion: 'weaver.v1', command: 'tasks.get', args: { taskId: 't' } }, auth);
  assert.deepEqual(added.ownerAuth, auth);
  assert.deepEqual(added.args, { taskId: 't' });
  assert.equal(typeof added.commandId, 'string');

  const carried = makeRequest(options, { apiVersion: 'weaver.v1', command: 'tasks.get', args: {}, ownerAuth: auth }, auth);
  assert.deepEqual(carried.ownerAuth, auth);

  assert.throws(
    () => makeRequest(options, { apiVersion: 'weaver.v1', command: 'tasks.get', args: {}, ownerAuth: { ...auth, token: 'b'.repeat(64) } }, auth),
    (error: { code: string; message: string }) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /conflicts with --owner-file/);
      assert.ok(!error.message.includes(TOKEN));
      assert.ok(!error.message.includes('b'.repeat(64)));
      return true;
    },
  );
  assert.throws(() => makeRequest(options, { ownerAuth: auth }, auth), /top level, not in args/);
  assert.throws(() => makeRequest(options, { apiVersion: 'weaver.v1', command: 'tasks.get', args: { ownerAuth: auth } }), /top level, not in args/);
});

test('a credential file is validated before any request, while direct RPC validates but does not attach it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wv-owner-'));
  try {
    const good = await credentialFile(root);
    const sent: Record<string, unknown>[] = [];
    const runtime = { request: async (_dir: string, request: unknown) => { sent.push(request as Record<string, unknown>); return { apiVersion: 'weaver.v1', ok: true, data: {} }; } };

    let result = await capture(() => runCLI(['tasks', 'get', '--task-id', 't', '--owner-file', good], runtime));
    assert.equal(result.code, 0);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].ownerAuth, { ownerId: OWNER_ID, token: TOKEN });
    assert.deepEqual(sent[0].args, { taskId: 't' });

    result = await capture(() => runCLI(['policy', 'get', '--owner-file', good], runtime));
    assert.equal(result.code, 0);
    assert.deepEqual(sent[1], { method: 'getPolicy', args: [] });

    const unsafe = await credentialFile(root, { version: 1, ownerId: OWNER_ID, token: TOKEN }, 'unsafe.json');
    await chmod(unsafe, 0o644);
    result = await capture(() => runCLI(['tasks', 'get', '--task-id', 't', '--owner-file', unsafe], runtime));
    assert.equal(result.code, 1);
    assert.equal(sent.length, 2);
    assert.equal(JSON.parse(result.output).error.code, 'UNSAFE_ENDPOINT');
    assert.ok(!result.output.includes(TOKEN));

    result = await capture(() => runCLI(['capabilities', '--owner-file', join(root, 'missing.json')], runtime));
    assert.equal(result.code, 1);
    assert.equal(sent.length, 2);
    assert.equal(JSON.parse(result.output).error.code, 'INVALID_ARGUMENT');

    const conflict = join(root, 'conflict.json');
    await writeFile(conflict, JSON.stringify({ apiVersion: 'weaver.v1', command: 'tasks.get', args: {}, ownerAuth: { ownerId: OWNER_ID, token: 'b'.repeat(64) } }));
    result = await capture(() => runCLI(['tasks', 'get', '--input', conflict, '--owner-file', good], runtime));
    assert.equal(result.code, 1);
    assert.equal(sent.length, 2);
    assert.match(JSON.parse(result.output).error.message, /conflicts with --owner-file/);
    assert.ok(!result.output.includes(TOKEN));
    assert.ok(!result.output.includes('b'.repeat(64)));

    const envelope = join(root, 'envelope.json');
    await writeFile(envelope, JSON.stringify({ apiVersion: 'weaver.v1', command: 'tasks.get', args: { taskId: 't' } }));
    result = await capture(() => runCLI(['tasks', 'get', '--input', envelope, '--owner-file', good], runtime));
    assert.equal(result.code, 0);
    assert.deepEqual(sent[2].ownerAuth, { ownerId: OWNER_ID, token: TOKEN });
    assert.deepEqual(sent[2].args, { taskId: 't' });

    const same = join(root, 'same.json');
    await writeFile(same, JSON.stringify({ apiVersion: 'weaver.v1', command: 'tasks.get', args: {}, ownerAuth: { ownerId: OWNER_ID, token: TOKEN } }));
    result = await capture(() => runCLI(['tasks', 'get', '--input', same, '--owner-file', good], runtime));
    assert.equal(result.code, 0);
    assert.deepEqual(sent[3].ownerAuth, { ownerId: OWNER_ID, token: TOKEN });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tasks wait and watch send the same ownerAuth on every get, events and health poll', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wv-owner-'));
  try {
    const good = await credentialFile(root);
    const auth = { ownerId: OWNER_ID, token: TOKEN };
    const runPoll = async (mode: 'wait' | 'watch') => {
      const calls: Record<string, unknown>[] = [];
      let snapshots = 0;
      const runtime = { request: async (_dir: string, request: unknown) => {
        const value = request as Record<string, unknown>;
        calls.push(value);
        if (value.command === 'tasks.get') {
          snapshots++;
          return { apiVersion: 'weaver.v1', ok: true, data: { id: 't', title: 'Fixture', status: snapshots === 1 ? 'running' : 'completed' } };
        }
        if (value.command === 'tasks.health') return { apiVersion: 'weaver.v1', ok: true, data: { state: 'working' } };
        if (value.command === 'tasks.events') return { apiVersion: 'weaver.v1', ok: true, data: { events: [], nextCursor: null, hasMore: false } };
        throw new Error(`unexpected ${String(value.command)}`);
      } };
      const result = await capture(() => runCLI(['tasks', mode, '--task-id', 't', '--for', '5', '--owner-file', good], runtime));
      assert.equal(result.code, 0, result.output);
      assert.ok(calls.some(call => call.command === 'tasks.get'));
      assert.ok(calls.some(call => call.command === 'tasks.health'));
      if (mode === 'watch') assert.ok(calls.some(call => call.command === 'tasks.events'));
      for (const call of calls) {
        assert.deepEqual(call.ownerAuth, auth);
        assert.equal((call.args as Record<string, unknown>).ownerAuth, undefined);
      }
    };
    await runPoll('wait');
    await runPoll('watch');

    let requests = 0;
    const noRequests = { request: async () => { requests++; return { apiVersion: 'weaver.v1', ok: true, data: {} }; } };
    const missing = await capture(() => runCLI(['tasks', 'wait', '--task-id', 't', '--for', '1', '--owner-file', join(root, 'absent.json')], noRequests));
    assert.equal(missing.code, 1);
    assert.equal(requests, 0);
    assert.equal(JSON.parse(missing.output).error.code, 'INVALID_ARGUMENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('help and the owners attach contract describe the credential path without exposing a token', () => {
  assert.match(CLI_HELP, /\[--owner-file <path>\]/);
  assert.match(CLI_HELP, /ownerAuth/);
  assert.match(CLI_HELP, /credentialPath/);
  assert.match(CLI_HELP, /not tenant or per-owner isolation/);
  assert.match(String(CLI_VALUE_OPTIONS['--owner-file']), /credential/i);
  const attach = CLI_CATALOG.find(item => item.command === 'owners.attach');
  assert.ok(attach);
  assert.ok(attach!.inputFields!.optional?.ownerId);
  assert.match(attach!.usage, /credentialPath/);
  assert.match(attach!.usage, /optional ownerId/);
});
