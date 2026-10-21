import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hostWire, type HostFrame } from '../../src/main/im/parent-host-wire';

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Host fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
for (const engine of ['codex', 'claude']) test(`${engine} internal host proves non-submission and retains context after confirmed abort`, { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-'));
  chmodSync(dir, 0o700);
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  copyFileSync(new URL(`../fixtures/parent/${engine}-fixture.mjs`, import.meta.url), join(dir, engine)); chmodSync(join(dir, engine), 0o700);
  const endpoint = join(dir, 's'), epoch = randomUUID(), marker = join(dir, 'marker');
  const frames: HostFrame[] = [];
  let wire!: ReturnType<typeof hostWire>;
  const server = createServer(socket => { wire = hostWire(socket, epoch, frame => frames.push(frame), () => {}); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve)); chmodSync(endpoint, 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../../src/cli/main.ts', import.meta.url).pathname, '__weaver-im-parent-host', endpoint, epoch], { stdio: ['pipe', 'ignore', 'pipe'] });
  const exit = once(child, 'close');
  const prefix = engine.toUpperCase();
  try {
    await until(() => frames.some(frame => frame.type === 'hello'));
    wire.send({ type: 'init', id: 0, input: { engineKind: engine, model: 'fixture', effort: 'low', workspace, instructions: 'Fixture only.' }, env: { PATH: `${dir}:${dirname(process.execPath)}`, [`${prefix}_FIXTURE_MARKER`]: marker, [`${prefix}_FIXTURE_SCENARIO`]: 'abort' } });
    await until(() => frames.some(frame => frame.type === 'ready'));
    wire.send({ type: 'prepare', id: 1, text: 'must never execute' }); wire.send({ type: 'abort', id: 1 });
    await until(() => frames.some(frame => frame.type === 'not-submitted' && frame.id === 1));
    assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 1, 'only process-start marker exists');
    wire.send({ type: 'prepare', id: 2, text: 'first submitted' });
    await until(() => frames.some(frame => frame.type === 'prepared' && frame.id === 2)); wire.send({ type: 'submit', id: 2 });
    await until(() => frames.some(frame => frame.type === 'delta' && frame.id === 2)); wire.send({ type: 'abort', id: 2 });
    await until(() => frames.some(frame => frame.type === 'cancelled' && frame.id === 2));
    // A delayed old abort must not affect the next pending turn.
    wire.send({ type: 'prepare', id: 3, text: 'second submitted' }); wire.send({ type: 'abort', id: 2 });
    await until(() => frames.some(frame => frame.type === 'prepared' && frame.id === 3)); wire.send({ type: 'submit', id: 3 });
    await until(() => frames.some(frame => frame.type === 'result' && frame.id === 3));
    assert.ok(!frames.filter(frame => frame.id === 3 && frame.type === 'delta').some(frame => String(frame.text).includes('OLD')));
    wire.send({ type: 'close', id: 0 });
    await exit;
  } finally {
    child.stdin.end(); child.kill('SIGKILL'); await exit;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid internal host entry exits safely before ordinary CLI or application initialization', async () => {
  const { spawnSync } = await import('node:child_process');
  const { readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'entry-'));
  try {
    const result = spawnSync(process.execPath, ['--import', new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href, new URL('../../src/cli/main.ts', import.meta.url).pathname, '__weaver-im-parent-host', 'invalid'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true }); }
});

test('reusing a not-submitted outcome as a new signal reason cannot forge host proof', async () => {
  const { abortReason, ParentTurnNotSubmitted } = await import('../../src/main/im/parent-agent');
  const signal = AbortSignal.abort(new ParentTurnNotSubmitted());
  assert.equal(abortReason(signal) instanceof ParentTurnNotSubmitted, false);
});

for (const invalid of ['foreign-epoch', 'oversized']) test(`private IPC rejects ${invalid} without exposing a frame`, async () => {
  const { connect } = await import('node:net');
  const { HOST_FRAME_MAX } = await import('../../src/main/im/parent-host-wire');
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wire-'));
  const endpoint = join(dir, 's'), epoch = randomUUID();
  let failures = 0, received = 0;
  const server = createServer(socket => { hostWire(socket, epoch, () => received++, () => failures++); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  const client = connect(endpoint); client.on('error', () => {}); const closed = once(client, 'close');
  try {
    await once(client, 'connect');
    client.write(invalid === 'foreign-epoch' ? JSON.stringify({ type: 'ready', id: 0, epoch: randomUUID() }) + '\n' : 'x'.repeat(HOST_FRAME_MAX + 1));
    await closed; assert.equal(received, 0); assert.equal(failures, 1);
  } finally { client.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); }
});

test('startup failures cross the host boundary as a fixed reason, never vendor text', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-start-'));
  chmodSync(dir, 0o700);
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  copyFileSync(new URL('../fixtures/parent/claude-fixture.mjs', import.meta.url), join(dir, 'claude')); chmodSync(join(dir, 'claude'), 0o700);
  const endpoint = join(dir, 's'), epoch = randomUUID();
  const frames: HostFrame[] = [];
  let wire!: ReturnType<typeof hostWire>;
  const server = createServer(socket => { wire = hostWire(socket, epoch, frame => frames.push(frame), () => {}); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve)); chmodSync(endpoint, 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../../src/cli/main.ts', import.meta.url).pathname, '__weaver-im-parent-host', endpoint, epoch], { stdio: ['pipe', 'ignore', 'pipe'] });
  const exit = once(child, 'close');
  try {
    await until(() => frames.some(frame => frame.type === 'hello'));
    wire.send({ type: 'init', id: 0, input: { engineKind: 'claude', model: 'fixture', effort: 'low', workspace, instructions: 'Fixture only.' }, env: { PATH: `${dir}:${dirname(process.execPath)}`, CLAUDE_FIXTURE_SCENARIO: 'startup-failed', CLAUDE_FIXTURE_MARKER: join(dir, 'marker') } });
    await until(() => frames.some(frame => frame.type === 'failed'));
    const failed = frames.find(frame => frame.type === 'failed')!;
    assert.equal(failed.reason, 'protocol');
    assert.equal(frames.some(frame => frame.type === 'ready'), false);
    assert.ok(!JSON.stringify(frames).includes('Fixture only.'), 'the host failure frame does not echo instructions');
  } finally {
    child.stdin.end(); child.kill('SIGKILL'); await exit;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turn auth failures keep the auth reason across the host boundary', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-auth-'));
  chmodSync(dir, 0o700);
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  copyFileSync(new URL('../fixtures/parent/pi-fixture.mjs', import.meta.url), join(dir, 'pi')); chmodSync(join(dir, 'pi'), 0o700);
  const endpoint = join(dir, 's'), epoch = randomUUID();
  const frames: HostFrame[] = [];
  let wire!: ReturnType<typeof hostWire>;
  const server = createServer(socket => { wire = hostWire(socket, epoch, frame => frames.push(frame), () => {}); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve)); chmodSync(endpoint, 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../../src/cli/main.ts', import.meta.url).pathname, '__weaver-im-parent-host', endpoint, epoch], { stdio: ['pipe', 'ignore', 'pipe'] });
  const exit = once(child, 'close');
  try {
    await until(() => frames.some(frame => frame.type === 'hello'));
    wire.send({ type: 'init', id: 0, input: { engineKind: 'pi', model: 'fixture-model', effort: 'high', workspace, instructions: 'Fixture only.' }, env: { PATH: `${dir}:${dirname(process.execPath)}`, PI_FIXTURE_SCENARIO: 'auth', PI_FIXTURE_MARKER: join(dir, 'marker') } });
    await until(() => frames.some(frame => frame.type === 'ready'));
    wire.send({ type: 'prepare', id: 1, text: 'authenticate' });
    await until(() => frames.some(frame => frame.type === 'prepared' && frame.id === 1));
    wire.send({ type: 'submit', id: 1 });
    await until(() => frames.some(frame => frame.type === 'error' && frame.id === 1));
    const error = frames.find(frame => frame.type === 'error' && frame.id === 1)!;
    assert.equal(error.reason, 'auth');
    assert.ok(!JSON.stringify(error).includes('401'));
    wire.send({ type: 'close', id: 0 });
    await exit;
  } finally {
    child.stdin.end(); child.kill('SIGKILL'); await exit;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode mid-turn engine death still delivers the terminal error frame', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-oc-death-'));
  chmodSync(dir, 0o700);
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  copyFileSync(new URL('../fixtures/parent/opencode-fixture.mjs', import.meta.url), join(dir, 'opencode')); chmodSync(join(dir, 'opencode'), 0o700);
  const endpoint = join(dir, 's'), epoch = randomUUID();
  const frames: HostFrame[] = [];
  let wire!: ReturnType<typeof hostWire>;
  const server = createServer(socket => { wire = hostWire(socket, epoch, frame => frames.push(frame), () => {}); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve)); chmodSync(endpoint, 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../../src/cli/main.ts', import.meta.url).pathname, '__weaver-im-parent-host', endpoint, epoch], { stdio: ['pipe', 'ignore', 'pipe'] });
  const exit = once(child, 'close');
  try {
    await until(() => frames.some(frame => frame.type === 'hello'));
    wire.send({ type: 'init', id: 0, input: { engineKind: 'opencode', model: 'fixture-provider/fixture-model', effort: 'high', workspace, instructions: 'Fixture only.' }, env: { PATH: `${dir}:${dirname(process.execPath)}`, OPENCODE_FIXTURE_SCENARIO: 'midturn-exit', OPENCODE_FIXTURE_MARKER: join(dir, 'marker') } });
    await until(() => frames.some(frame => frame.type === 'ready'));
    wire.send({ type: 'prepare', id: 1, text: 'die mid-turn' });
    await until(() => frames.some(frame => frame.type === 'prepared' && frame.id === 1));
    wire.send({ type: 'submit', id: 1 });
    await until(() => frames.some(frame => (frame.type === 'error' || frame.type === 'result') && frame.id === 1));
    const terminal = frames.find(frame => (frame.type === 'error' || frame.type === 'result') && frame.id === 1)!;
    assert.equal(terminal.type, 'error');
    assert.equal(terminal.reason, 'engine');
    await exit;
  } finally {
    child.stdin.end(); child.kill('SIGKILL'); await exit;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
test('opencode engine failure keeps the auth reason across the host boundary', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'wh-oc-auth-'));
  chmodSync(dir, 0o700);
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  copyFileSync(new URL('../fixtures/parent/opencode-fixture.mjs', import.meta.url), join(dir, 'opencode')); chmodSync(join(dir, 'opencode'), 0o700);
  const endpoint = join(dir, 's'), epoch = randomUUID();
  const frames: HostFrame[] = [];
  let wire!: ReturnType<typeof hostWire>;
  const server = createServer(socket => { wire = hostWire(socket, epoch, frame => frames.push(frame), () => {}); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve)); chmodSync(endpoint, 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../../src/cli/main.ts', import.meta.url).pathname, '__weaver-im-parent-host', endpoint, epoch], { stdio: ['pipe', 'ignore', 'pipe'] });
  const exit = once(child, 'close');
  try {
    await until(() => frames.some(frame => frame.type === 'hello'));
    wire.send({ type: 'init', id: 0, input: { engineKind: 'opencode', model: 'fixture-provider/fixture-model', effort: 'high', workspace, instructions: 'Fixture only.' }, env: { PATH: `${dir}:${dirname(process.execPath)}`, OPENCODE_FIXTURE_SCENARIO: 'auth', OPENCODE_FIXTURE_MARKER: join(dir, 'marker') } });
    await until(() => frames.some(frame => frame.type === 'ready'));
    wire.send({ type: 'prepare', id: 1, text: 'authenticate' });
    await until(() => frames.some(frame => frame.type === 'prepared' && frame.id === 1));
    wire.send({ type: 'submit', id: 1 });
    await until(() => frames.some(frame => frame.type === 'error' && frame.id === 1));
    const error = frames.find(frame => frame.type === 'error' && frame.id === 1)!;
    assert.equal(error.reason, 'auth');
    assert.ok(!JSON.stringify(error).includes('not authenticated'));
    wire.send({ type: 'close', id: 0 });
    await exit;
  } finally {
    child.stdin.end(); child.kill('SIGKILL'); await exit;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
