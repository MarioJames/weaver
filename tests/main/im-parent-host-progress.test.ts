import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBackgroundParentAgent } from '../../src/main/im/parent-background';
import { ConfirmedParentCancellation } from '../../src/main/im/parent-agent';
import type { AsyncRunner } from '../../src/main/owner-host';

function fakeRunnerFactory() {
  let child: ChildProcess | undefined;
  const invocation = `inv-${randomUUID()}`;
  const runner: AsyncRunner = async ({ file, args }) => {
    if (file === 'systemd-run') {
      const idx = args.indexOf('--');
      const cmd = args.slice(idx + 1);
      child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', () => {});
      return { code: 0, stdout: '', stderr: '' };
    }
    if (file === 'systemctl' && args[1] === 'show') {
      const alive = !!child && child.exitCode === null && child.signalCode === null;
      if (!alive) return { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive', stderr: '' };
      const unit = args[2];
      return {
        code: 0,
        stdout: `Id=${unit}\nLoadState=loaded\nActiveState=active\nInvocationID=${invocation}\nMainPID=${child!.pid}\nControlGroup=/fake`,
        stderr: '',
      };
    }
    if (file === 'systemctl' && args[1] === 'stop') {
      const current = child;
      child = undefined;
      if (current) {
        try { current.kill('SIGKILL'); } catch { /* already gone */ }
        try { await once(current, 'close'); } catch { /* already gone */ }
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected external call: ${file} ${args.join(' ')}`);
  };
  return { runner, getChild: () => child };
}

const CLI_MAIN = new URL('../../src/cli/main.ts', import.meta.url).pathname;

function setupDshBin(scenario = 'default'): { dir: string; workspace: string; marker: string; previousPath: string; previousScenario?: string; previousMarker?: string } {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-prog-'));
  chmodSync(dir, 0o700);
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  copyFileSync(new URL('../fixtures/parent/dsh-fixture.mjs', import.meta.url), join(dir, 'dsh'));
  chmodSync(join(dir, 'dsh'), 0o700);
  const marker = join(dir, 'marker');
  const previousPath = process.env.PATH ?? '';
  const previousScenario = process.env.DSH_FIXTURE_SCENARIO;
  const previousMarker = process.env.DSH_FIXTURE_MARKER;
  process.env.PATH = `${dir}:${dirname(process.execPath)}:${previousPath}`;
  process.env.DSH_FIXTURE_SCENARIO = scenario;
  process.env.DSH_FIXTURE_MARKER = marker;
  return { dir, workspace, marker, previousPath, previousScenario, previousMarker };
}

function teardownDshBin(harness: { dir: string; previousPath: string; previousScenario?: string; previousMarker?: string }) {
  process.env.PATH = harness.previousPath;
  if (harness.previousScenario === undefined) delete process.env.DSH_FIXTURE_SCENARIO;
  else process.env.DSH_FIXTURE_SCENARIO = harness.previousScenario;
  if (harness.previousMarker === undefined) delete process.env.DSH_FIXTURE_MARKER;
  else process.env.DSH_FIXTURE_MARKER = harness.previousMarker;
  rmSync(harness.dir, { recursive: true, force: true });
}

// Minimal fake host speaking the private newline-JSON protocol. The trailing
// __weaver-im-parent-host endpoint epoch argv (appended by parent-background)
// satisfies the ownership cmdline check in inspectHostUnit.
function fakeHostScript(): string {
  return `
const net = require('node:net');
const endpoint = process.argv[2], epoch = process.argv[3];
const mode = process.env.FAKE_HOST_MODE || '';
const sock = net.connect(endpoint);
let buf = '';
const send = (f) => sock.write(JSON.stringify(Object.assign({}, f, { epoch })) + '\\n');
let turn = 0;
let aborted = false;
sock.on('connect', () => send({ id: 0, type: 'hello', pid: process.pid }));
sock.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line) continue;
    let fr; try { fr = JSON.parse(line); } catch { process.exit(1); }
    onFrame(fr);
  }
});
sock.on('error', () => {});
function onFrame(fr) {
  if (fr.type === 'init' && fr.id === 0) { send({ id: 0, type: 'ready' }); return; }
  if (fr.type === 'prepare') {
    turn = fr.id;
    aborted = false;
    if (mode === 'unsubmitted') {
      send({ id: fr.id, type: 'progress', kind: 'tool', name: 'early' });
      return;
    }
    send({ id: fr.id, type: 'prepared' });
    return;
  }
  if (fr.type === 'submit') {
    if (mode === 'illegal-kind') { send({ id: fr.id, type: 'progress', kind: 'bogus', name: 'x' }); return; }
    if (mode === 'illegal-name') { send({ id: fr.id, type: 'progress', kind: 'tool', name: 123 }); return; }
    if (mode === 'abort-discard') {
      send({ id: fr.id, type: 'progress', kind: 'stage', name: '开始' });
      send({ id: fr.id, type: 'delta', text: 'hi' });
      return;
    }
    if (mode === 'no-onprogress') {
      send({ id: fr.id, type: 'progress', kind: 'tool', name: 'shell' });
      send({ id: fr.id, type: 'delta', text: 'hello' });
      send({ id: fr.id, type: 'result', text: 'hello' });
      return;
    }
    if (mode === 'callback-throws') {
      send({ id: fr.id, type: 'progress', kind: 'tool', name: 'shell' });
      send({ id: fr.id, type: 'delta', text: 'hello' });
      send({ id: fr.id, type: 'result', text: 'hello' });
      return;
    }
    return;
  }
  if (fr.type === 'abort') {
    if (mode === 'abort-discard') {
      aborted = true;
      // Progress after cancel must be discarded by the service, never delivered and never lost.
      send({ id: fr.id, type: 'progress', kind: 'tool', name: 'late' });
      send({ id: fr.id, type: 'cancelled' });
      return;
    }
    send({ id: fr.id, type: 'cancelled' });
    return;
  }
  if (fr.type === 'close') { process.exit(0); return; }
}
`;
}

async function launchFakeHost(mode: string, dataDir: string) {
  const { runner } = fakeRunnerFactory();
  const previous = process.env.FAKE_HOST_MODE;
  process.env.FAKE_HOST_MODE = mode;
  try {
    const session = await createBackgroundParentAgent(
      { engineKind: 'codex', model: 'fixture', effort: 'low', workspace: dataDir, instructions: 'Fixture only.' },
      { dataDir },
      { hostCommand: [process.execPath, '-e', fakeHostScript()], startupMs: 15000, runner },
    );
    return { session, restore: () => {
      if (previous === undefined) delete process.env.FAKE_HOST_MODE;
      else process.env.FAKE_HOST_MODE = previous;
    } };
  } catch (error) {
    if (previous === undefined) delete process.env.FAKE_HOST_MODE;
    else process.env.FAKE_HOST_MODE = previous;
    throw error;
  }
}

test('dsh 开始与工具进度经宿主边界到达 onProgress', { timeout: 30000 }, async () => {
  const harness = setupDshBin();
  const dataDir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-prog-data-'));
  const { runner } = fakeRunnerFactory();
  let session: Awaited<ReturnType<typeof createBackgroundParentAgent>> | undefined;
  try {
    session = await createBackgroundParentAgent(
      { engineKind: 'dsh', model: 'deepseek-flash', effort: 'high', workspace: harness.workspace, instructions: 'Fixture only. No model.' },
      { dataDir },
      { hostCommand: [process.execPath, '--import', 'tsx', CLI_MAIN], startupMs: 20000, runner },
    );
    const deltas: string[] = [];
    const progress: Array<{ kind: string; name: string }> = [];
    const result = await session.send('第一轮', undefined, chunk => deltas.push(chunk), { onProgress: event => progress.push({ ...event }) });
    assert.equal(result, '你好，世界');
    assert.ok(deltas.length > 0);
    assert.deepEqual(progress, [
      { kind: 'stage', name: '开始' },
      { kind: 'tool', name: 'bash' },
    ]);
  } finally {
    try { await session?.close(); } catch { /* exact cleanup owns errors */ }
    teardownDshBin(harness);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('宿主把过长的工具标签截断后再发 progress 帧', { timeout: 30000 }, async () => {
  const harness = setupDshBin('long-tool');
  const dataDir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-prog-long-data-'));
  const { runner } = fakeRunnerFactory();
  let session: Awaited<ReturnType<typeof createBackgroundParentAgent>> | undefined;
  try {
    session = await createBackgroundParentAgent(
      { engineKind: 'dsh', model: 'deepseek-flash', effort: 'high', workspace: harness.workspace, instructions: 'Fixture only. No model.' },
      { dataDir },
      { hostCommand: [process.execPath, '--import', 'tsx', CLI_MAIN], startupMs: 20000, runner },
    );
    const progress: Array<{ kind: string; name: string }> = [];
    assert.equal(await session.send('第一轮', undefined, undefined, { onProgress: event => progress.push({ ...event }) }), '你好，世界');
    assert.deepEqual(progress, [
      { kind: 'stage', name: '开始' },
      { kind: 'tool', name: 'x'.repeat(64) },
    ]);
    assert.ok(!JSON.stringify(progress).includes('SECRET'), JSON.stringify(progress));
  } finally {
    try { await session?.close(); } catch { /* exact cleanup owns errors */ }
    teardownDshBin(harness);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('abort 后进度被丢弃且不触发 lost', { timeout: 30000 }, async () => {
  const dataDir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-prog-abort-'));
  const { session, restore } = await launchFakeHost('abort-discard', dataDir);
  try {
    const progress: Array<{ kind: string; name: string }> = [];
    const deltas: string[] = [];
    const controller = new AbortController();
    const sending = session.send('hi', controller.signal, chunk => deltas.push(chunk), { onProgress: event => progress.push({ ...event }) });
    // Wait for the pre-abort progress to arrive, then abort the turn.
    const end = Date.now() + 5000;
    while (progress.length === 0 && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(progress.length, 1);
    assert.deepEqual(progress[0], { kind: 'stage', name: '开始' });
    controller.abort();
    await assert.rejects(sending, ConfirmedParentCancellation);
    // The late progress sent by the fake host after abort must not arrive.
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(progress, [{ kind: 'stage', name: '开始' }]);
    // Control is retained after a confirmed cancellation: no lost.
    let unavailable = false;
    void session.unavailable!.then(() => { unavailable = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(unavailable, false);
    await session.close();
  } finally {
    try { await session.close(); } catch { /* already closed */ }
    restore();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('未 submitted 的 progress 帧触发 lost', { timeout: 30000 }, async () => {
  const dataDir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-prog-unsub-'));
  const { session, restore } = await launchFakeHost('unsubmitted', dataDir);
  try {
    let unavailable = false;
    void session.unavailable!.then(() => { unavailable = true; });
    await assert.rejects(session.send('hi', undefined, undefined, { onProgress: () => {} }));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(unavailable, true);
  } finally {
    try { await session.close(); } catch { /* lost already tore down */ }
    restore();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const mode of ['illegal-kind', 'illegal-name'] as const) {
  test(`非法 progress 帧触发 lost (${mode})`, { timeout: 30000 }, async () => {
    const dataDir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-prog-illegal-'));
    const { session, restore } = await launchFakeHost(mode, dataDir);
    try {
      let unavailable = false;
      void session.unavailable!.then(() => { unavailable = true; });
      await assert.rejects(session.send('hi', undefined, undefined, { onProgress: () => {} }));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(unavailable, true);
    } finally {
      try { await session.close(); } catch { /* lost already tore down */ }
      restore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

test('不传 onProgress 时行为不变：进度被忽略，正文照常到达', { timeout: 30000 }, async () => {
  const dataDir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-prog-noopt-'));
  const { session, restore } = await launchFakeHost('no-onprogress', dataDir);
  try {
    const deltas: string[] = [];
    const result = await session.send('hi', undefined, chunk => deltas.push(chunk));
    assert.equal(result, 'hello');
    assert.deepEqual(deltas, ['hello']);
    let unavailable = false;
    void session.unavailable!.then(() => { unavailable = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(unavailable, false);
    await session.close();
  } finally {
    try { await session.close(); } catch { /* exact cleanup */ }
    restore();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('onProgress 回调抛错只吞掉，不影响正文 turn', { timeout: 30000 }, async () => {
  const dataDir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-prog-throw-'));
  const { session, restore } = await launchFakeHost('callback-throws', dataDir);
  try {
    const deltas: string[] = [];
    const result = await session.send('hi', undefined, chunk => deltas.push(chunk), {
      onProgress: () => { throw new Error('progress callback boom'); },
    });
    assert.equal(result, 'hello');
    assert.deepEqual(deltas, ['hello']);
    let unavailable = false;
    void session.unavailable!.then(() => { unavailable = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(unavailable, false);
    await session.close();
  } finally {
    try { await session.close(); } catch { /* exact cleanup */ }
    restore();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dsh 进度经后台宿主到达 ImService 卡片并收口只剩答案', { timeout: 30000 }, async () => {
  const harness = setupDshBin();
  const dataDir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-prog-svc-data-'));
  const serviceDir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-prog-svc-'));
  const { runner } = fakeRunnerFactory();
  const { ImService } = await import('../../src/main/im/service');
  const chunks: string[] = [];
  const cards: unknown[] = [];
  let handlers!: import('../../src/main/im/channel').ImChannelHandlers;
  const factory: import('../../src/main/im/channel').ImChannelFactory = (_c, h) => {
    handlers = h;
    return {
      connect: async () => {},
      close: async () => {},
      state: () => 'connected' as const,
      send: async () => {},
      retireCard: async () => {},
      stream: async (_to, producer) => {
        const id = 'om_bot1';
        await producer({
          messageId: id,
          append: async (text: string) => { chunks.push(text); },
          setContent: async (text: string) => { chunks.push(`[setContent]${text}`); },
        });
        return id;
      },
      updateCard: async (id, card) => { cards.push({ id, card }); },
    };
  };
  const policy = () => ({
    revision: 0,
    config: {
      version: 1,
      engines: { dsh: { enabled: true, kind: 'dsh' } },
      owners: { main: { enabled: true, engine: 'dsh', model: 'deepseek-flash', effort: 'high', workers: [], max_parallel: 1 } },
      workers: {}, herdr: { max_wait_minutes: 30 },
    },
    blocks: [], activeBlocks: [], owners: {}, workers: {}, execution: 'disabled',
  }) as any;
  const parentFactory = (input: any, opts?: { signal?: AbortSignal }) =>
    createBackgroundParentAgent(input, { dataDir, signal: opts?.signal }, { hostCommand: [process.execPath, '--import', 'tsx', CLI_MAIN], startupMs: 20000, runner });
  const service = new ImService({ dataDir: serviceDir, policy, parentFactory: parentFactory as any, channelFactory: factory });
  try {
    await service.save({ expectedRevision: 0, config: { enabled: true, appId: 'cli_test', appSecret: 'CANARY_SECRET', allowedOpenIds: ['ou_a'], engine: 'dsh', model: 'deepseek-flash', effort: 'high', workspaces: [harness.workspace], idleTimeoutMinutes: 1 } as any });
    for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve));
    const now = Date.now();
    handlers.message({
      messageId: 'om_progress1', chatId: 'oc_a', chatType: 'p2p', senderId: 'ou_a', senderType: 'user',
      content: '你好', rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: false,
      createTime: now,
      raw: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_a' } },
        message: { message_id: 'om_progress1', chat_id: 'oc_a', chat_type: 'p2p', message_type: 'text', create_time: String(now), content: JSON.stringify({ text: '你好' }) },
      },
    } as any);
    for (let i = 0; i < 400; i++) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 1500));
    const streamed = chunks.filter(c => !c.startsWith('[setContent]')).join('');
    assert.equal(streamed, '*深度思考中……*\n*工具调用中……*\n*调用结束*\n\n你好，世界', JSON.stringify(chunks));
    assert.ok(!streamed.includes('bash'), JSON.stringify(chunks));
    assert.ok(!streamed.includes('⏺'), JSON.stringify(chunks));
    assert.ok(!chunks.join('').includes('步骤'), JSON.stringify(chunks));
    assert.equal(chunks.at(-1), '[setContent]你好，世界');
    assert.equal((cards as unknown[]).length, 1);
  } finally {
    await service.close().catch(() => {});
    teardownDshBin(harness);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(serviceDir, { recursive: true, force: true });
  }
});
