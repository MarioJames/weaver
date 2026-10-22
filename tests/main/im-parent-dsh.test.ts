import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  ConfirmedParentCancellation,
  ParentAgentError,
  createParentAgent,
  spawnOwnedParentProcess,
  type ParentAgentSession,
  type ParentProcess,
  type ParentProcessLauncher,
} from '../../src/main/im/parent-agent';

const FIXTURE = new URL('../fixtures/parent/dsh-fixture.mjs', import.meta.url).pathname;
const sessions = new Set<ParentAgentSession>();

interface Harness {
  dir: string;
  workspace: string;
  extra: string;
  marker: string;
  previousPath: string;
}

function setup(name: string, scenario: string): Harness {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), `weaver-im-dsh-${name}-`));
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  const extra = join(dir, 'extra'); mkdirSync(extra);
  copyFileSync(FIXTURE, join(dir, 'dsh')); chmodSync(join(dir, 'dsh'), 0o755);
  const harness = { dir, workspace, extra, marker: join(dir, 'marker.ndjson'), previousPath: process.env.PATH ?? '' };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.DSH_FIXTURE_SCENARIO = scenario;
  process.env.DSH_FIXTURE_MARKER = harness.marker;
  return harness;
}

const launch: ParentProcessLauncher = (command, cwd, extra) => spawn(command[0], command.slice(1), {
  cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extra },
});
const ownedLaunch: ParentProcessLauncher = (command, cwd, extra) => spawnOwnedParentProcess(command, cwd, { ...process.env, ...extra });

function input(harness: Harness, over: Record<string, unknown> = {}) {
  return {
    engineKind: 'dsh' as const,
    model: 'deepseek-flash',
    effort: 'high',
    workspace: harness.workspace,
    additionalWorkspaces: [harness.extra],
    instructions: `BOOTSTRAP-ROOTS ${JSON.stringify([realpathSync(harness.workspace), realpathSync(harness.extra)])}`,
    ...over,
  };
}

function markers(harness: Harness): Array<Record<string, any>> {
  if (!existsSync(harness.marker)) return [];
  return readFileSync(harness.marker, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
}

async function until(predicate: () => boolean, label: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`condition not reached: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

async function teardown(harness: Harness): Promise<void> {
  for (const session of sessions) await session.close().catch(() => {});
  sessions.clear();
  process.env.PATH = harness.previousPath;
  for (const key of ['DSH_FIXTURE_SCENARIO', 'DSH_FIXTURE_MARKER']) delete process.env[key];
  for (const entry of markers(harness)) if (typeof entry.pid === 'number') await until(() => gone(entry.pid), 'dsh fixture exit', 3000);
  for (const entry of markers(harness)) if (typeof entry.toolPid === 'number') {
    if (!gone(entry.toolPid)) { try { process.kill(entry.toolPid, 'SIGKILL'); } catch { /* raced with exit */ } }
    await until(() => gone(entry.toolPid), 'dsh tool exit', 3000);
  }
  for (const entry of markers(harness)) if (typeof entry.overlayPath === 'string') rmSync(entry.overlayPath, { force: true });
  rmSync(harness.dir, { recursive: true, force: true });
}

const waits = { startupMs: 3000, turnMs: 3000, closeMs: 1000 };

test('dsh resumes the persisted session across per-turn children and streams only public text', async () => {
  const harness = setup('multi', 'default');
  try {
    const session = await createParentAgent(input(harness), { launch, ...waits });
    sessions.add(session);
    const firstDeltas: string[] = [];
    assert.equal(await session.send('第一轮', undefined, chunk => firstDeltas.push(chunk)), '你好，世界');
    assert.deepEqual(firstDeltas, ['你好，', '世界']);
    assert.ok(!firstDeltas.join('').includes('SECRET'));

    const secondDeltas: string[] = [];
    assert.equal(await session.send('第二轮', undefined, chunk => secondDeltas.push(chunk)), '你好，世界');
    assert.deepEqual(secondDeltas, ['你好，', '世界']);

    const spawns = markers(harness).filter(entry => entry.event === 'spawn');
    assert.equal(spawns.length, 2);
    assert.equal(new Set(spawns.map(entry => entry.pid)).size, 2, 'each turn is a separate native dsh child');
    const first = spawns[0]!;
    const second = spawns[1]!;
    assert.equal(first.adopted, undefined);
    assert.equal(second.adopted, first.sessionId);
    assert.equal(second.sessionId, first.sessionId);

    for (const spawn of spawns) {
      const argv = spawn.argv as string[];
      assert.deepEqual(argv.slice(0, 3), ['--profile', 'headless', '--patch']);
      assert.equal(argv[4], '--json');
      assert.equal(spawn.cwd, realpathSync(harness.workspace));
      assert.match(String(spawn.overlay), /model:\s*"deepseek-flash"/);
      assert.match(String(spawn.overlay), /reasoningEffort:\s*"high"/);
      assert.match(String(spawn.overlay), /mode:\s*workspace-write/);
      assert.match(String(spawn.overlay), /policy:\s*ask/);
      assert.match(String(spawn.overlay), /id: credentials[\s\S]*?disabled: false/);
      assert.ok(!argv.some(arg => arg === '--add-dir' || arg === '--cwd' || arg.includes(harness.extra)));
    }
    const tasks = markers(harness).filter(entry => entry.event === 'task');
    assert.match(String(tasks[0]!.task), /BOOTSTRAP-ROOTS/);
    assert.ok(String(tasks[0]!.task).includes(JSON.stringify([realpathSync(harness.workspace), realpathSync(harness.extra)])));
    assert.equal(tasks[1]!.task, '第二轮');
    assert.ok(!String(first.overlay).includes('DEEPSEEK_API_KEY'));

    await session.close();
    assert.ok(!existsSync(String(first.overlayPath)), 'close removes the private overlay directory');
    await until(() => gone(Number(first.pid)) && gone(Number(second.pid)), 'all dsh children gone');
    await assert.rejects(session.send('第三轮'), /closed/);
  } finally { await teardown(harness); }
});

test('dsh cancellation is confirmed only by the real child exit and keeps the same session', async () => {
  const harness = setup('abort', 'abort');
  try {
    const session = await createParentAgent(input(harness), { launch, ...waits });
    sessions.add(session);
    assert.equal(await session.send('第一轮'), '你好，世界');
    const controller = new AbortController();
    const deltas: string[] = [];
    const pending = session.send('取消', controller.signal, chunk => { deltas.push(chunk); controller.abort(); });
    await assert.rejects(pending, error => error instanceof ConfirmedParentCancellation && error.name === 'AbortError');
    const aborted = markers(harness).filter(entry => entry.event === 'spawn').at(-1)!;
    await until(() => gone(Number(aborted.pid)), 'aborted child exited before the send settled');
    assert.ok(markers(harness).some(entry => entry.event === 'signal' && entry.pid === aborted.pid && entry.signal === 'SIGTERM'));
    assert.equal(await session.send('第二轮'), '你好，世界');
    const spawns = markers(harness).filter(entry => entry.event === 'spawn');
    assert.equal(spawns.length, 3);
    assert.equal(spawns[2]!.adopted, spawns[0]!.sessionId);
    await session.close();
  } finally { await teardown(harness); }
});

test('dsh close terminates a SIGTERM-ignoring child, rejects the live turn and removes the overlay', async () => {
  const harness = setup('close', 'abort-ignore');
  try {
    const session = await createParentAgent(input(harness), { launch, ...waits });
    sessions.add(session);
    let delta!: () => void;
    const gotDelta = new Promise<void>(resolve => { delta = resolve; });
    const pending = session.send('取消', undefined, () => delta());
    await gotDelta;
    const spawn = markers(harness).filter(entry => entry.event === 'spawn').at(-1)!;
    await session.close();
    await assert.rejects(pending, error => error instanceof ParentAgentError && error.reason === 'closed');
    await until(() => gone(Number(spawn.pid)), 'SIGKILL fallback removed the child');
    assert.ok(!existsSync(String(spawn.overlayPath)), 'close removes the private overlay after the child is gone');
    await assert.rejects(session.send('第三轮'), /closed/);
  } finally { await teardown(harness); }
});

test('dsh auth failures expose only the auth reason, never vendor text', async () => {
  const harness = setup('auth', 'auth');
  try {
    const session = await createParentAgent(input(harness), { launch, ...waits });
    sessions.add(session);
    await assert.rejects(session.send('问题'), (error: unknown) => {
      assert.ok(error instanceof ParentAgentError);
      assert.equal(error.reason, 'auth');
      assert.ok(!/401|authentication|credential/i.test(error.message));
      return true;
    });
    await session.close();
  } finally { await teardown(harness); }
});

test('two chats keep distinct persisted sessions and private overlays', async () => {
  const harness = setup('isolation', 'default');
  try {
    const first = await createParentAgent(input(harness), { launch, ...waits });
    const second = await createParentAgent(input(harness), { launch, ...waits });
    sessions.add(first); sessions.add(second);
    assert.equal(await first.send('第一轮'), '你好，世界');
    assert.equal(await second.send('第一轮'), '你好，世界');
    assert.equal(await first.send('第二轮'), '你好，世界');
    assert.equal(await second.send('第二轮'), '你好，世界');
    const spawns = markers(harness).filter(entry => entry.event === 'spawn');
    assert.equal(spawns.length, 4);
    assert.notEqual(spawns[0]!.sessionId, spawns[1]!.sessionId);
    assert.equal(spawns[2]!.sessionId, spawns[0]!.sessionId);
    assert.equal(spawns[3]!.sessionId, spawns[1]!.sessionId);
    assert.notEqual(spawns[0]!.overlayPath, spawns[1]!.overlayPath);
    await first.close(); await second.close();
    assert.ok(!existsSync(String(spawns[0]!.overlayPath)));
    assert.ok(!existsSync(String(spawns[1]!.overlayPath)));
  } finally { await teardown(harness); }
});

test('dsh refuses a mismatched resumed session and a run without a final event', async () => {
  const wrong = setup('wrong-session', 'wrong-session');
  try {
    const session = await createParentAgent(input(wrong), { launch, ...waits });
    sessions.add(session);
    assert.equal(await session.send('第一轮'), '你好，世界');
    await assert.rejects(session.send('第二轮'), /different session|protocol/);
    await assert.rejects(session.send('第三轮'), /closed|unavailable/);
    await session.close();
  } finally { await teardown(wrong); }

  const missing = setup('missing-final', 'missing-final');
  try {
    const session = await createParentAgent(input(missing), { launch, ...waits });
    sessions.add(session);
    await assert.rejects(session.send('问题'), /final event|protocol/);
    await session.close();
  } finally { await teardown(missing); }
});

test('dsh cancel reclaims a tool descendant before confirming and resumes the same session', async () => {
  const harness = setup('tree-cancel', 'abort-tree');
  try {
    const session = await createParentAgent(input(harness), { launch, ...waits });
    sessions.add(session);
    const controller = new AbortController();
    let requested = false;
    const pending = session.send('取消', controller.signal, () => { if (!requested) { requested = true; controller.abort(); } });
    await assert.rejects(pending, error => error instanceof ConfirmedParentCancellation);
    const tool = markers(harness).find(entry => entry.event === 'tool');
    assert.ok(tool && typeof tool.toolPid === 'number', 'the fixture starts a real tool descendant');
    assert.equal(gone(tool.toolPid), true, 'the tool descendant stopped before cancellation settled');
    const aborted = markers(harness).filter(entry => entry.event === 'spawn').at(-1)!;
    assert.equal(gone(Number(aborted.pid)), true, 'the per-turn dsh child also stopped');

    process.env.DSH_FIXTURE_SCENARIO = 'default';
    assert.equal(await session.send('第二轮'), '你好，世界');
    const resumed = markers(harness).filter(entry => entry.event === 'spawn').at(-1)!;
    assert.equal(resumed.adopted, aborted.sessionId);
    await session.close();
  } finally { await teardown(harness); }
});

test('dsh close during a live turn reclaims the tool tree and rejects the send', async () => {
  const harness = setup('tree-close', 'abort-tree');
  try {
    const session = await createParentAgent(input(harness), { launch, ...waits });
    sessions.add(session);
    const pending = session.send('取消');
    await until(() => markers(harness).some(entry => entry.event === 'tool'), 'tool descendant');
    const tool = markers(harness).find(entry => entry.event === 'tool')!;
    const running = markers(harness).filter(entry => entry.event === 'spawn').at(-1)!;
    await session.close();
    await assert.rejects(pending, error => error instanceof ParentAgentError && error.reason === 'closed');
    assert.equal(gone(tool.toolPid), true, 'close removes the tool descendant');
    assert.equal(gone(Number(running.pid)), true, 'close removes the live dsh child');
    assert.ok(!existsSync(String(running.overlayPath)), 'close removes the overlay after the tree is gone');
  } finally { await teardown(harness); }
});

test('cancelling one owned dsh tree leaves an independent live session untouched', async () => {
  const harness = setup('tree-isolation', 'abort-tree');
  try {
    const first = await createParentAgent(input(harness), { launch: ownedLaunch, ...waits });
    const second = await createParentAgent(input(harness), { launch: ownedLaunch, ...waits });
    sessions.add(first); sessions.add(second);
    const firstAbort = new AbortController();
    const firstPending = first.send('取消一', firstAbort.signal);
    await until(() => markers(harness).some(entry => entry.event === 'tool'), 'first tool descendant');
    const secondAbort = new AbortController();
    const secondPending = second.send('取消二', secondAbort.signal);
    await until(() => markers(harness).filter(entry => entry.event === 'tool').length === 2, 'second tool descendant');
    const [firstTool, secondTool] = markers(harness).filter(entry => entry.event === 'tool');
    firstAbort.abort();
    await assert.rejects(firstPending, error => error instanceof ConfirmedParentCancellation);
    assert.equal(gone(firstTool!.toolPid), true, 'the cancelled tree is fully stopped');
    assert.equal(gone(secondTool!.toolPid), false, 'the other session tree is still alive');

    await second.close();
    await assert.rejects(secondPending, error => error instanceof ParentAgentError && error.reason === 'closed');
    await until(() => gone(secondTool!.toolPid), 'second tree stopped by its own close');
    await first.close();
  } finally { await teardown(harness); }
});

class FakeTree extends EventEmitter implements ParentProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: PassThrough;
  readonly signals: Array<NodeJS.Signals | undefined> = [];
  alive = true;
  constructor(writeFailure = false) {
    super();
    this.stdin = new PassThrough();
    if (writeFailure) this.stdin.write = (() => { throw new Error('fixture stdin failure'); }) as typeof this.stdin.write;
  }
  kill(signal?: NodeJS.Signals): boolean { this.signals.push(signal); return true; }
  killTree(signal?: NodeJS.Signals): boolean { this.signals.push(signal); return true; }
  treeAlive(): boolean { return this.alive; }
}

function fakeAgentInput(): { dir: string; input: Record<string, unknown>; previousPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-im-dsh-fake-'));
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  copyFileSync(FIXTURE, join(dir, 'dsh')); chmodSync(join(dir, 'dsh'), 0o755);
  const previousPath = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
  return { dir, input: { engineKind: 'dsh', model: 'deepseek-flash', effort: 'high', workspace, instructions: 'fixture only' }, previousPath };
}

function overlayFromCommand(command: string[]): string {
  const index = command.indexOf('--patch');
  assert.notEqual(index, -1, 'launch argv carries the exact --patch overlay file');
  const patch = command[index + 1];
  assert.ok(typeof patch === 'string' && patch.length > 0, 'launch argv carries the exact --patch overlay file');
  return dirname(patch);
}

test('a turn timeout with an unconfirmed forced kill keeps the overlay and resource for a close retry', async () => {
  const fake = new FakeTree();
  const agent = fakeAgentInput();
  let captured: string[] | undefined;
  const captureLaunch: ParentProcessLauncher = command => {
    captured ??= [...command];
    return fake;
  };
  let session: ParentAgentSession | undefined;
  try {
    session = await createParentAgent(agent.input as never, { launch: captureLaunch, startupMs: 1000, turnMs: 40, closeMs: 40 });
    const pending = session.send('超时');
    const overlay = overlayFromCommand(captured!);
    await assert.rejects(pending, error => error instanceof ParentAgentError && error.reason === 'engine' && /timed out/.test(error.message));
    assert.deepEqual(fake.signals.filter(Boolean), ['SIGTERM', 'SIGKILL']);
    await assert.rejects(session.close(), /did not exit|did not stop/);
    assert.ok(existsSync(overlay), 'the private overlay remains while the tree is not proven stopped');
    fake.alive = false;
    await session.close();
    assert.ok(!existsSync(overlay), 'a close retry removes the overlay only after the tree is gone');
  } finally {
    try { await session?.close(); } catch { /* the test already proved the ownership path */ }
    fake.alive = false;
    process.env.PATH = agent.previousPath;
    rmSync(agent.dir, { recursive: true, force: true });
  }
});

test('a stdin write failure settles the send but keeps the live process for a close retry', async () => {
  const fake = new FakeTree(true);
  const agent = fakeAgentInput();
  let captured: string[] | undefined;
  const captureLaunch: ParentProcessLauncher = command => {
    captured ??= [...command];
    return fake;
  };
  let session: ParentAgentSession | undefined;
  try {
    session = await createParentAgent(agent.input as never, { launch: captureLaunch, startupMs: 1000, turnMs: 5000, closeMs: 40 });
    const pending = session.send('写入失败');
    const overlay = overlayFromCommand(captured!);
    await assert.rejects(pending, error => error instanceof ParentAgentError && error.reason === 'engine');
    assert.ok(fake.signals.includes('SIGTERM') && fake.signals.includes('SIGKILL'));
    await assert.rejects(session.close(), /did not exit|did not stop/);
    assert.ok(existsSync(overlay), 'a failed close keeps the exact resource and overlay');
    fake.alive = false;
    await session.close();
    assert.ok(!existsSync(overlay));
  } finally {
    try { await session?.close(); } catch { /* the test already proved the ownership path */ }
    fake.alive = false;
    process.env.PATH = agent.previousPath;
    rmSync(agent.dir, { recursive: true, force: true });
  }
});

test('a launch failure leaves no live ownership and close removes the overlay', async () => {
  const agent = fakeAgentInput();
  let captured: string[] | undefined;
  let session: ParentAgentSession | undefined;
  try {
    const failing: ParentProcessLauncher = command => {
      captured ??= [...command];
      throw new Error('fixture spawn failure');
    };
    session = await createParentAgent(agent.input as never, { launch: failing, startupMs: 1000, turnMs: 1000, closeMs: 40 });
    const pending = session.send('启动失败');
    const overlay = overlayFromCommand(captured!);
    await assert.rejects(pending, error => error instanceof ParentAgentError && error.reason === 'engine' && /could not start/.test(error.message));
    await session.close();
    assert.ok(!existsSync(overlay));
  } finally {
    try { await session?.close(); } catch { /* no native process was created */ }
    process.env.PATH = agent.previousPath;
    rmSync(agent.dir, { recursive: true, force: true });
  }
});
