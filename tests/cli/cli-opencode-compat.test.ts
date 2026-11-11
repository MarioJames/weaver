import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLaunchSpec } from '../../src/main/adapters/cli/argv';
import { CliAgentInputError, prepareCliAgentInput, startCliAgent } from '../../src/main/adapters/cli';
import { cliChildEnv } from '../../src/main/adapters/cli/launch';
import { spawnPrint } from '../../src/main/engines/hello';
import { createNormalizer } from '../../src/main/adapters/cli/normalize';
import { OpencodeVersionError, opencodeMajor } from '../../src/main/adapters/cli/opencode-version';
import { touchLater, writeFakeOpencode } from '../helpers/fake-opencode';

const instruction = 'MARKER-do-not-put-this-on-argv Reply PONG only.';
const spec = (over: Record<string, unknown> = {}) => buildLaunchSpec({ engine: 'opencode', model: 'opencode/glm-5.3-flash-free', effort: 'max', workspace: '/work/space', instruction, promptPath: '/p', sessionDir: '/s', leaderSocket: '/l', overlayPath: '/o', ...over } as Parameters<typeof buildLaunchSpec>[0]);

function withPath<T>(dirs: string[], body: () => T): T {
  const previous = process.env.PATH;
  process.env.PATH = `${dirs.join(':')}:${previous}`;
  try { return body(); } finally { process.env.PATH = previous; }
}
function tmp(): string { return mkdtempSync(join(tmpdir(), 'weaver-opencode-compat-')); }

test('v1 keeps the exact pre-v2 argv, including variant, --pure and --dir', () => {
  assert.deepEqual(spec({ opencodeMajor: 1 }).argv, ['opencode', 'run', '--format', 'json', '--model', 'opencode/glm-5.3-flash-free', '--variant', 'max', '--pure', '--auto', '--print-logs', '--log-level', 'ERROR', '--dir', '/work/space']);
  assert.equal(spec({ opencodeMajor: 1 }).stdin, instruction);
  assert.deepEqual(spec({ opencodeMajor: 1, effort: '' }).argv.slice(4, 8), ['--model', 'opencode/glm-5.3-flash-free', '--variant', ''], 'an empty effort is passed through exactly as before');
});

test('v2 folds the variant into --model#variant and drops --variant, --pure, --dir and the log flags', () => {
  const v2 = spec({ opencodeMajor: 2 });
  assert.deepEqual(v2.argv, ['opencode', 'run', '--format', 'json', '--model', 'opencode/glm-5.3-flash-free#max', '--auto', '--standalone']);
  assert.equal(v2.stdin, instruction);
  for (const removed of ['--variant', '--pure', '--dir', '--print-logs', '--log-level']) assert.equal(v2.argv.includes(removed), false, removed);
  assert.equal(v2.argv.some(arg => arg.includes('/work/space')), false, 'the workspace is the child cwd, not an argument');
});

test('v2 without an effort sends the bare model with no # suffix', () => {
  assert.deepEqual(spec({ opencodeMajor: 2, effort: '' }).argv, ['opencode', 'run', '--format', 'json', '--model', 'opencode/glm-5.3-flash-free', '--auto', '--standalone']);
});

test('opencode refuses to build argv without a detected major version', () => {
  assert.throws(() => spec(), /major version/);
  assert.throws(() => spec({ opencodeMajor: 3 }), /v1 and v2/);
});

test('major version is read from opencode --version for both output styles', () => {
  const dir = tmp();
  try {
    writeFakeOpencode(dir, { version: '1.19.3' });
    assert.equal(opencodeMajor(dir), 1);
    const dir2 = tmp();
    try {
      writeFakeOpencode(dir2, { version: 'opencode v2.2.6' });
      assert.equal(opencodeMajor(dir2), 2);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('version probe failures are explicit errors, never a silent branch', () => {
  const empty = tmp();
  const cases: [string, { version: string; exit?: number } | null, RegExp][] = [
    ['missing binary', null, /not found on PATH/],
    ['non-zero exit', { version: 'boom', exit: 3 }, /--version failed/],
    ['unparseable output', { version: 'banana', exit: 0 }, /could not read a version/],
    ['unsupported major', { version: '3.0.1' }, /supports opencode v1 and v2/],
    ['pre-1.0', { version: '0.9.0' }, /supports opencode v1 and v2/],
  ];
  try {
    for (const [name, fake, pattern] of cases) {
      const dir = tmp();
      try {
        if (fake) writeFakeOpencode(dir, fake);
        assert.throws(() => opencodeMajor(fake ? dir : empty), (error: unknown) => error instanceof OpencodeVersionError && pattern.test(error.message), name);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('the probe result is cached per binary and refreshed when the binary changes', () => {
  const dir = tmp();
  const count = join(dir, 'count.txt');
  try {
    const file = writeFakeOpencode(dir, { version: '1.19.3', countFile: count });
    assert.equal(opencodeMajor(dir), 1);
    assert.equal(opencodeMajor(dir), 1);
    assert.equal(readFileSync(count, 'utf8').split('\n').filter(Boolean).length, 1, 'second call is served from the cache');
    writeFakeOpencode(dir, { version: 'opencode v2.2.6', countFile: count });
    touchLater(file);
    assert.equal(opencodeMajor(dir), 2, 'an upgraded binary at the same path is probed again');
    assert.equal(readFileSync(count, 'utf8').split('\n').filter(Boolean).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function input(dir: string, over: Record<string, unknown> = {}) {
  return { engine: 'opencode' as const, model: 'opencode/glm-5.3-flash-free', effort: 'max', workspace: dir, instruction, stateDir: join(dir, 'state'), ...over };
}

test('prepareCliAgentInput picks v1 or v2 argv from the opencode on PATH', () => {
  const work = tmp();
  const v1 = tmp();
  const v2 = tmp();
  try {
    writeFakeOpencode(v1, { version: '1.19.3' });
    writeFakeOpencode(v2, { version: 'opencode v2.2.6' });
    const real = realpathSync(work);
    const one = withPath([v1], () => prepareCliAgentInput(input(work)));
    assert.deepEqual(one.argv, ['opencode', 'run', '--format', 'json', '--model', 'opencode/glm-5.3-flash-free', '--variant', 'max', '--pure', '--auto', '--print-logs', '--log-level', 'ERROR', '--dir', real]);
    const two = withPath([v2], () => prepareCliAgentInput(input(work)));
    assert.deepEqual(two.argv, ['opencode', 'run', '--format', 'json', '--model', 'opencode/glm-5.3-flash-free#max', '--auto', '--standalone']);
    assert.equal(two.workspace, real, 'the child cwd that replaces --dir');
    assert.equal(two.stdin, instruction);
    assert.equal(two.argv.some(arg => arg.includes('MARKER-do-not-put-this-on-argv')), false);
  } finally { for (const dir of [work, v1, v2]) rmSync(dir, { recursive: true, force: true }); }
});

test('prepareCliAgentInput reports an undetectable opencode before writing any run state', () => {
  const work = tmp();
  const bad = tmp();
  try {
    writeFakeOpencode(bad, { version: 'banana' });
    assert.throws(() => withPath([bad], () => prepareCliAgentInput(input(work))), (error: unknown) => error instanceof CliAgentInputError && error.field === 'engine' && /opencode/.test(error.message) && /could not read a version/.test(error.message));
    mkdirSync(join(work, 'state'), { recursive: true });
    assert.deepEqual(readdirSync(join(work, 'state')), [], 'no prompt file is left behind');
  } finally { for (const dir of [work, bad]) rmSync(dir, { recursive: true, force: true }); }
});

/** Fake systemd-run/systemctl so startCliAgent runs the fake opencode directly, in the cwd the launcher chose. */
function installFakeScope(dir: string): void {
  writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(join(dir, 'systemctl'), '#!/bin/sh\necho ActiveState=inactive\n', { mode: 0o700 });
}
async function runAgent(bin: string, work: string): Promise<{ summary: string; evidence: unknown }> {
  const agent = withPath([bin], () => startCliAgent(input(work)));
  agent.on('error', () => {});
  let out = '';
  agent.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  await new Promise(resolve => agent.once('close', resolve));
  const result = out.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(item => item.type === 'result');
  return { summary: result?.summary ?? '', evidence: agent.evidence };
}

test('a v2 run executes in the workspace as cwd with the model#variant argv', async () => {
  const work = tmp();
  const bin = tmp();
  try {
    installFakeScope(bin);
    writeFakeOpencode(bin, { version: 'opencode v2.2.6' });
    const { summary } = await runAgent(bin, work);
    const seen = JSON.parse(summary) as { argv: string[]; cwd: string; pwd: string; stdin: string };
    assert.equal(seen.cwd, realpathSync(work));
    assert.equal(seen.pwd, realpathSync(work), 'v2 reads $PWD, so it must name the workspace, not the server directory');
    assert.notEqual(seen.pwd, process.env.PWD);
    assert.deepEqual(seen.argv, ['run', '--format', 'json', '--model', 'opencode/glm-5.3-flash-free#max', '--auto', '--standalone']);
    assert.equal(seen.stdin, instruction);
  } finally { for (const dir of [work, bin]) rmSync(dir, { recursive: true, force: true }); }
});

test('a v1 run still passes --dir and runs in the same workspace cwd', async () => {
  const work = tmp();
  const bin = tmp();
  try {
    installFakeScope(bin);
    writeFakeOpencode(bin, { version: '1.19.3' });
    const { summary } = await runAgent(bin, work);
    const seen = JSON.parse(summary) as { argv: string[]; cwd: string };
    assert.equal(seen.cwd, realpathSync(work));
    assert.equal(seen.argv[seen.argv.indexOf('--dir') + 1], realpathSync(work));
    assert.ok(seen.argv.includes('--variant') && seen.argv.includes('--pure'));
  } finally { for (const dir of [work, bin]) rmSync(dir, { recursive: true, force: true }); }
});

test('a captured OpenCode v2.2.6 JSON event stream normalizes to a successful run', () => {
  const lines = readFileSync(join(import.meta.dirname, '../fixtures/opencode-v2-run.jsonl'), 'utf8').split('\n').filter(Boolean);
  const normalizer = createNormalizer('opencode');
  for (const line of lines) normalizer.push(line);
  assert.equal(normalizer.sessionId(), 'ses_e3638a454ffedpSOJmWgl5CmeV');
  const finished = normalizer.finish({ exitCode: 0, cancelled: false, truncated: false });
  assert.equal(finished.evidence.terminal, 'success');
  assert.ok(finished.records.some(item => item.type === 'result' && item.summary === 'MOCK_REPLY_OK'));
});

test('a v2 error event ({error:{type,message}}) fails the run with its message', () => {
  const normalizer = createNormalizer('opencode');
  const records = normalizer.push(JSON.stringify({ type: 'error', timestamp: 1, sessionID: 'ses_x', error: { type: 'provider.no-route', message: 'Model unavailable: nosuchprovider/nosuchmodel' } }));
  assert.ok(records.some(item => item.type === 'log' && item.message === 'Model unavailable: nosuchprovider/nosuchmodel'));
  const finished = normalizer.finish({ exitCode: 1, cancelled: false, truncated: false });
  assert.equal(finished.evidence.terminal, 'error');
});

test('the child environment pins PWD to the workspace for opencode only and never leaks the Electron node flag', () => {
  const previous = { PWD: process.env.PWD, flag: process.env.ELECTRON_RUN_AS_NODE };
  process.env.PWD = '/some/other/server/dir';
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const opencode = cliChildEnv({ engine: 'opencode', workspace: '/work/space' });
    assert.equal(opencode.PWD, '/work/space');
    assert.equal(opencode.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(cliChildEnv({ engine: 'opencode', workspace: '/work/space', env: { PWD: '/x', KEEP: 'y' } }).KEEP, 'y');
    assert.equal(cliChildEnv({ engine: 'codex', workspace: '/work/space' }).PWD, '/some/other/server/dir', 'other engines are untouched');
  } finally {
    if (previous.PWD === undefined) delete process.env.PWD; else process.env.PWD = previous.PWD;
    if (previous.flag === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previous.flag;
  }
});

test('hello spawns opencode with PWD set to its scratch directory despite a stale inherited PWD', async () => {
  const bin = tmp();
  const scratch = tmp();
  const previous = process.env.PWD;
  process.env.PWD = '/some/other/server/dir';
  try {
    writeFakeOpencode(bin, { version: 'opencode v2.2.6' });
    const child = spawnPrint('opencode', ['run'], scratch, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    await new Promise(resolve => child.once('close', resolve));
    const text = out.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(item => item.type === 'text')?.part.text;
    assert.equal(JSON.parse(text).pwd, scratch);
  } finally {
    if (previous === undefined) delete process.env.PWD; else process.env.PWD = previous;
    for (const dir of [bin, scratch]) rmSync(dir, { recursive: true, force: true });
  }
});
