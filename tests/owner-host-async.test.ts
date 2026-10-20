import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchOwnerAsync, closeOwnerHostAsync, defaultAsyncRunner, OwnerLaunchError, type AsyncRunner, type OwnerLaunchInput, type RunnerInput, type RunnerResult } from '../src/main/owner-host';

const create = JSON.stringify({ result: { workspace: { workspace_id: 'exact-workspace' }, root_pane: { pane_id: 'different:pane' } } });
const ok = (stdout = ''): RunnerResult => ({ code: 0, stdout, stderr: '' });
const input: OwnerLaunchInput = { taskId: '1234abcd-1111-4111-8111-111111111111', epoch: 2, title: '😀'.repeat(50), workspace: '/fake/project/', engineKind: 'codex', model: 'explicit-model', effort: 'high', prompt: 'private prompt', pathEnv: '', herdrPath: '/fake/herdr' };
function fixture(overrides: Partial<Record<string, RunnerResult | Error>> = {}, calls: (RunnerInput & { signal?: AbortSignal })[] = []): AsyncRunner {
  return async request => {
    calls.push(request);
    const action = request.args[0] === '--help' ? 'help' : request.args[3];
    const result = overrides[action] ?? ok(action === 'create' ? create : '');
    if (result instanceof Error) throw result;
    return result;
  };
}
const failure = (pattern: RegExp) => (error: unknown) => error instanceof OwnerLaunchError && error.code === 'OWNER_LAUNCH_FAILED' && pattern.test(error.message);

test('async codex launch preserves exact IDs, explicit argv, unicode labels and budgets', async () => {
  const calls: RunnerInput[] = [];
  const host = await launchOwnerAsync({ ...input, asyncRunner: fixture({}, calls) });
  assert.deepEqual(host, { session: 'default', workspaceId: 'exact-workspace', paneId: 'different:pane', agentName: 'owner-1234abcd-2' });
  assert.deepEqual(calls.map(call => call.timeout), [30000, 70000, 60000, 15000]);
  assert.deepEqual(calls[0].args.slice(4, 8), ['--cwd', '/fake/project/', '--label', 'project']);
  assert.deepEqual(calls[1].args, ['--session', 'default', 'agent', 'start', host.agentName, '--kind', 'codex', '--pane', 'different:pane', '--timeout', '60000', '--', '-m', 'explicit-model', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(calls[2].args, ['--session', 'default', 'agent', 'prompt', 'different:pane', input.prompt]);
  assert.deepEqual(calls[3].args, ['--session', 'default', 'agent', 'rename', 'different:pane', '--clear']);
  assert.equal(calls.length, 4);
});

test('async rename --clear failure is cosmetic and never closes the workspace', async () => {
  for (const rename of [{ code: 1, stdout: '', stderr: 'refused' }, ok('{"error":{"message":"gone"}}'), new Error('rename exploded')]) {
    const calls: RunnerInput[] = [];
    const host = await launchOwnerAsync({ ...input, asyncRunner: fixture({ rename }, calls) });
    assert.deepEqual(host, { session: 'default', workspaceId: 'exact-workspace', paneId: 'different:pane', agentName: 'owner-1234abcd-2' });
    assert.equal(calls.at(-1)!.args[3], 'rename');
    assert.equal(calls.some(call => call.args[3] === 'close'), false);
  }
});

test('async Claude help is best effort and controls only effort support', async () => {
  for (const help of [ok('--effort <level>'), ok('usage'), new Error('probe failed')]) {
    const calls: RunnerInput[] = [];
    await launchOwnerAsync({ ...input, engineKind: 'claude', claudePath: '/fake/claude', asyncRunner: fixture({ help }, calls) });
    assert.deepEqual(calls[1].args, ['--help']);
    assert.deepEqual(calls[2].args.slice(12), help instanceof Error || help.stdout === 'usage' ? ['--model', 'explicit-model'] : ['--model', 'explicit-model', '--effort', 'high']);
  }
});

test('async protocol failures preserve step context and close only the documented workspace', async () => {
  for (const [action, result, pattern] of [
    ['create', ok('bad JSON'), /workspace create returned unparseable JSON/],
    ['create', new Error('create exploded'), /workspace create failed: create exploded/],
    ['start', ok('{"error":{"code":"rejected","message":"not ready"}}'), /agent start failed \(exit 0\): rejected: not ready/],
    ['start', ok('malformed JSON'), /agent start returned unparseable JSON/],
    ['prompt', ok('malformed JSON'), /agent prompt returned unparseable JSON/],
    ['start', new Error('start exploded'), /agent start failed: start exploded/],
    ['prompt', { code: 143, stdout: '', stderr: 'timed out' }, /agent prompt failed.*timed out/],
  ] as const) {
    const calls: RunnerInput[] = [];
    await assert.rejects(launchOwnerAsync({ ...input, asyncRunner: fixture({ [action]: result }, calls) }), failure(pattern));
    const closes = calls.filter(call => call.args[3] === 'close');
    assert.equal(closes.length, action === 'create' ? 0 : 1);
    if (closes.length) assert.deepEqual(closes[0].args, ['--session', 'default', 'workspace', 'close', 'exact-workspace']);
  }
});

test('async failed cleanup appends evidence without replacing original launch failure', async () => {
  for (const close of [ok('malformed cleanup JSON'), new Error('close exploded'), ok('{"error":{"message":"close rejected"}}'), { code: 1, stdout: '', stderr: 'busy' }]) {
    await assert.rejects(launchOwnerAsync({ ...input, asyncRunner: fixture({ start: new Error('original'), close }) }), failure(/agent start failed: original; herdr workspace close cleanup also failed/));
  }
});

test('async missing pane cleans exact workspace, but missing workspace never guesses from pane', async () => {
  for (const [stdout, count] of [[JSON.stringify({ result: { workspace: { workspace_id: 'exact-workspace' } } }), 1], [JSON.stringify({ result: { root_pane: { pane_id: 'different:pane' } } }), 0]] as const) {
    const calls: RunnerInput[] = [];
    await assert.rejects(launchOwnerAsync({ ...input, asyncRunner: fixture({ create: ok(stdout) }, calls) }), failure(/workspace create returned no/));
    assert.equal(calls.filter(call => call.args[3] === 'close').length, count);
  }
});

test('preabort has no effects; abort during each owned step still allows fresh cleanup', async () => {
  const pre = new AbortController(); pre.abort();
  const calls: RunnerInput[] = [];
  await assert.rejects(launchOwnerAsync({ ...input, signal: pre.signal, asyncRunner: fixture({}, calls) }), failure(/aborted/));
  assert.equal(calls.length, 0);
  for (const target of ['create', 'help', 'start', 'prompt']) {
    const controller = new AbortController();
    const seen: (RunnerInput & { signal?: AbortSignal })[] = [];
    const run = fixture({}, seen);
    await assert.rejects(launchOwnerAsync({ ...input, engineKind: 'claude', claudePath: '/fake/claude', signal: controller.signal, asyncRunner: async request => {
      const result = await run(request);
      if (request.args[3] === target || (target === 'help' && request.args[0] === '--help')) controller.abort();
      return result;
    } }), failure(/aborted/));
    const close = seen.at(-1)!;
    assert.equal(close.args[3], 'close'); assert.equal(close.signal, undefined); assert.equal(close.timeout, 15000);
  }
});

test('a terminated workspace create with an exact resource receipt is still cleaned up', async () => {
  const calls: RunnerInput[] = [];
  await assert.rejects(launchOwnerAsync({ ...input, asyncRunner: fixture({ create: { code: 143, stdout: create, stderr: 'workspace create timed out' } }, calls) }), failure(/workspace create failed.*timed out/));
  assert.deepEqual(calls.at(-1)!.args, ['--session', 'default', 'workspace', 'close', 'exact-workspace']);
});

test('explicit close validates exact identity and closes no other resource', async () => {
  const host = await launchOwnerAsync({ ...input, asyncRunner: fixture() });
  const calls: RunnerInput[] = [];
  await closeOwnerHostAsync(host, { herdrPath: '/fake/herdr', asyncRunner: fixture({}, calls) });
  assert.deepEqual(calls[0].args, ['--session', 'default', 'workspace', 'close', 'exact-workspace']);
  await assert.rejects(closeOwnerHostAsync({ ...host, session: ' ' }, { asyncRunner: fixture({}, calls) }), failure(/Exact owner/));
  await assert.rejects(closeOwnerHostAsync({ ...host, workspaceId: '' }, { asyncRunner: fixture({}, calls) }), failure(/Exact owner/));
  assert.equal(calls.length, 1);
});

test('default async process runner stays nonblocking, bounds evidence and terminates on timeout or abort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-owner-host-'));
  try {
    const executable = join(dir, 'fake-herdr');
    writeFileSync(executable, `#!${process.execPath}\nconst action=process.argv[5]; if(action==='create') console.log(${JSON.stringify(create)}); else if(action==='start') setTimeout(()=>{},500);\n`, { mode: 0o755 });
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 20);
    const host = await launchOwnerAsync({ ...input, herdrPath: executable });
    clearTimeout(timer);
    assert.equal(timerFired, true); assert.equal(host.workspaceId, 'exact-workspace');
    const evidence = await defaultAsyncRunner({ file: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(200000));process.stderr.write("y".repeat(200000))'], timeout: 2000 });
    assert.equal(evidence.code, 0); assert.equal(evidence.stdout.length, 65536); assert.equal(evidence.stderr.length, 65536);
    for (const abort of [false, true]) {
      const controller = new AbortController();
      const result = defaultAsyncRunner({ file: process.execPath, args: ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},100)'], timeout: abort ? 2000 : 150, signal: controller.signal });
      const abortTimer = abort ? setTimeout(() => controller.abort(), 150) : undefined;
      const stopped = await result;
      clearTimeout(abortTimer);
      assert.equal(stopped.code, 143); assert.match(stopped.stderr, abort ? /aborted/ : /timed out/);
    }
    // A timeout/abort in the real child path must still close the known workspace.
    for (const abort of [false, true]) {
      const controller = new AbortController();
      const seen: (RunnerInput & { signal?: AbortSignal })[] = [];
      await assert.rejects(launchOwnerAsync({ ...input, herdrPath: executable, signal: controller.signal, asyncRunner: request => {
        seen.push(request);
        if (request.args[3] === 'start' && abort) setTimeout(() => controller.abort(), 30);
        return defaultAsyncRunner({ ...request, timeout: request.args[3] === 'start' ? 100 : request.timeout });
      } }), failure(abort ? /agent start failed.*aborted/ : /agent start failed.*timed out/));
      assert.equal(seen.at(-1)!.args[3], 'close');
      assert.equal(seen.at(-1)!.signal, undefined);
    }
    const missing = await defaultAsyncRunner({ file: join(dir, 'missing'), args: [], timeout: 100 });
    assert.equal(missing.code, 127);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
