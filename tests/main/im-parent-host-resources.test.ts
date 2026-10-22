import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bootIdentity, cleanupHostRecord, inspectHostUnit, processStart, readHostRecords, saveHostRecord, type HostRecord } from '../../src/main/im/parent-host-resources';
import { createBackgroundParentAgent } from '../../src/main/im/parent-background';
import { ParentAgentError } from '../../src/main/im/parent-agent';
import type { AsyncRunner } from '../../src/main/owner-host';

function setup() {
  const root = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'res-'));
  const epoch = randomUUID(), dir = join(root, epoch); mkdirSync(dir, { mode: 0o700 });
  const record: HostRecord = { version: 1, epoch, unit: `weaver-im-host-${epoch}.service`, ownerPid: process.pid, ownerStart: processStart(process.pid)!, boot: bootIdentity(), endpoint: join(dir, 's'), createdAt: new Date().toISOString(), label: 'fixture', launched: true, invocation: 'expected', lane: { workspaceId: 'own-w', tabId: 'own-t', paneId: 'own-p', createdWorkspace: false } };
  saveHostRecord(dir, record);
  return { root, dir, record };
}
test('replaced unit invocation cannot close a lane or signal the replacement', async () => {
  const h = setup(); const mutations: string[][] = [];
  const runner: AsyncRunner = async ({ file, args }) => {
    if (file === 'systemctl' && args.includes('show')) return { code: 0, stdout: `Id=${h.record.unit}\nLoadState=loaded\nActiveState=active\nInvocationID=replacement\nMainPID=1\nControlGroup=/replacement`, stderr: '' };
    mutations.push(args); throw new Error('unexpected mutation');
  };
  try {
    await assert.rejects(cleanupHostRecord(h.dir, h.record, runner), /ownership or cleanup/);
    assert.deepEqual(mutations, []); assert.ok(existsSync(h.dir)); assert.equal(readHostRecords(h.root)[0].record.closing, true);
  } finally { rmSync(h.root, { recursive: true }); }
});
test('missing unit does not bypass exact Herdr cleanup; failed close retains tombstone', async () => {
  const h = setup(); let stops = 0;
  const runner: AsyncRunner = async ({ file, args }) => {
    if (file === 'systemctl' && args.includes('show')) return { code: 1, stdout: 'LoadState=not-found\nActiveState=inactive', stderr: '' };
    if (file === 'systemctl') stops++;
    return { code: 1, stdout: '', stderr: 'unavailable' };
  };
  try {
    await assert.rejects(cleanupHostRecord(h.dir, h.record, runner));
    assert.equal(stops, 0); assert.ok(existsSync(h.dir));
  } finally { rmSync(h.root, { recursive: true }); }
});
test('crash during allocation without a receipt fails closed rather than guessing a tab', async () => {
  const h = setup(); delete h.record.lane; h.record.launched = false; h.record.allocating = true;
  const runner: AsyncRunner = async () => ({ code: 1, stdout: 'LoadState=not-found', stderr: '' });
  try { await assert.rejects(cleanupHostRecord(h.dir, h.record, runner)); assert.ok(existsSync(h.dir)); }
  finally { rmSync(h.root, { recursive: true }); }
});
test('an unproven live main process cannot be claimed solely by a matching random unit name', async () => {
  const h = setup(); delete h.record.invocation;
  const runner: AsyncRunner = async () => ({ code: 0, stdout: `Id=${h.record.unit}\nLoadState=loaded\nActiveState=active\nInvocationID=abc\nMainPID=${process.pid}\nControlGroup=/fixture`, stderr: '' });
  try { await assert.rejects(inspectHostUnit(h.record, runner)); }
  finally { rmSync(h.root, { recursive: true }); }
});


function setupBackground() {
  const root = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'resbg-'));
  const epoch = randomUUID(), dir = join(root, epoch); mkdirSync(dir, { mode: 0o700 });
  const record: HostRecord = { version: 1, epoch, unit: `weaver-im-host-${epoch}.service`, ownerPid: process.pid, ownerStart: processStart(process.pid)!, boot: bootIdentity(), endpoint: join(dir, 's'), createdAt: new Date().toISOString(), label: 'fixture-bg', launched: true, launchMode: 'background', invocation: 'expected-bg' };
  saveHostRecord(dir, record);
  return { root, dir, record };
}

test('background record recycles the exact unit with zero Herdr calls', async () => {
  const h = setupBackground(); const calls: string[][] = []; const stops: string[][] = []; let shows = 0;
  const runner: AsyncRunner = async ({ file, args }) => {
    calls.push([file, ...args]);
    if (file === 'systemctl' && args.includes('show')) {
      shows++;
      if (shows <= 2) return { code: 0, stdout: `Id=${h.record.unit}\nLoadState=loaded\nActiveState=active\nInvocationID=expected-bg\nMainPID=1\nControlGroup=/weaver-test-nonexistent-bg`, stderr: '' };
      return { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive', stderr: '' };
    }
    if (file === 'systemctl' && args.includes('stop')) { stops.push(args); return { code: 0, stdout: '', stderr: '' }; }
    throw new Error(`unexpected external call: ${file} ${args.join(' ')}`);
  };
  try {
    await cleanupHostRecord(h.dir, h.record, runner);
    assert.ok(calls.every(call => call[0] !== 'herdr'), 'background cleanup must not touch Herdr');
    assert.equal(stops.length, 1); assert.ok(stops[0].includes(h.record.unit));
    assert.ok(!existsSync(h.dir));
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test('background record with a replaced invocation cannot signal the replacement', async () => {
  const h = setupBackground(); const calls: string[][] = []; const stops: string[][] = [];
  const runner: AsyncRunner = async ({ file, args }) => {
    calls.push([file, ...args]);
    if (file === 'systemctl' && args.includes('show')) return { code: 0, stdout: `Id=${h.record.unit}\nLoadState=loaded\nActiveState=active\nInvocationID=replacement\nMainPID=1\nControlGroup=/replacement`, stderr: '' };
    if (file === 'systemctl' && args.includes('stop')) stops.push(args);
    throw new Error('unexpected mutation');
  };
  try {
    await assert.rejects(cleanupHostRecord(h.dir, h.record, runner), /ownership or cleanup/);
    assert.ok(calls.every(call => call[0] !== 'herdr'));
    assert.deepEqual(stops, []); assert.ok(existsSync(h.dir));
  } finally { rmSync(h.root, { recursive: true }); }
});

test('unknown launch mode is rejected before any side effect', async () => {
  const h = setup();
  (h.record as unknown as Record<string, unknown>).launchMode = 'herdr-remote';
  saveHostRecord(h.dir, h.record);
  let calls = 0;
  const runner: AsyncRunner = async () => { calls++; throw new Error('must not run'); };
  try {
    await assert.rejects(cleanupHostRecord(h.dir, h.record, runner), /ownership or cleanup/);
    assert.equal(calls, 0); assert.ok(existsSync(h.dir));
    const reread = JSON.parse(readFileSync(join(h.dir, 'record.json'), 'utf8')) as HostRecord;
    assert.equal(reread.closing, undefined, 'rejected mode must not mutate the journal');
  } finally { rmSync(h.root, { recursive: true }); }
});

test('background mode with legacy lane/server/allocating fields is rejected before any side effect', async () => {
  const variants: Array<(record: HostRecord) => void> = [
    record => { record.lane = { workspaceId: 'own-w', tabId: 'own-t', paneId: 'own-p', createdWorkspace: false }; },
    record => { record.server = { socket: '/tmp/stale.sock', identity: 'stale' }; },
    record => { record.launched = false; record.allocating = true; },
  ];
  for (const mutate of variants) {
    const h = setupBackground(); mutate(h.record); saveHostRecord(h.dir, h.record);
    let calls = 0;
    const runner: AsyncRunner = async () => { calls++; throw new Error('must not run'); };
    try {
      await assert.rejects(cleanupHostRecord(h.dir, h.record, runner), /ownership or cleanup/);
      assert.equal(calls, 0); assert.ok(existsSync(h.dir));
      const reread = JSON.parse(readFileSync(join(h.dir, 'record.json'), 'utf8')) as HostRecord;
      assert.equal(reread.closing, undefined, 'contradictory mode must not mutate the journal');
    } finally { rmSync(h.root, { recursive: true }); }
  }
});

test('legacy launched record without a lane still fails closed', async () => {
  const h = setup(); delete h.record.lane; h.record.launched = true;
  const runner: AsyncRunner = async () => ({ code: 0, stdout: 'LoadState=not-found\nActiveState=inactive', stderr: '' });
  try { await assert.rejects(cleanupHostRecord(h.dir, h.record, runner), /ownership or cleanup/); assert.ok(existsSync(h.dir)); }
  finally { rmSync(h.root, { recursive: true }); }
});

test('readHostRecords accepts background but rejects unknown or contradictory modes', async () => {
  const good = setupBackground();
  try { assert.equal(readHostRecords(good.root)[0].record.launchMode, 'background'); }
  finally { rmSync(good.root, { recursive: true }); }
  const badMode = setup();
  (badMode.record as unknown as Record<string, unknown>).launchMode = 'herdr-remote';
  saveHostRecord(badMode.dir, badMode.record);
  try { assert.throws(() => readHostRecords(badMode.root), /ownership or cleanup/); }
  finally { rmSync(badMode.root, { recursive: true }); }
  const mixed = setupBackground();
  mixed.record.lane = { workspaceId: 'own-w', tabId: 'own-t', paneId: 'own-p', createdWorkspace: false };
  saveHostRecord(mixed.dir, mixed.record);
  try { assert.throws(() => readHostRecords(mixed.root), /ownership or cleanup/); }
  finally { rmSync(mixed.root, { recursive: true }); }
});

test('overlong private socket preflight remains invalid_input on retry and leaves no epoch directory', async () => {
  const dir = mkdtempSync(join(process.env.WEAVER_PARENT_TEST_TMPDIR ?? tmpdir(), 'pre-'));
  const dataDir = join(dir, 'long-'.repeat(12));
  const root = join(dataDir, 'im-host');
  let calls = 0;
  const runner: AsyncRunner = async () => { calls++; throw Error('external launch must not run'); };
  const errors: unknown[] = [], leftovers: string[][] = [];
  try {
    assert.ok(Buffer.byteLength(join(root, '0'.repeat(36), 's')) > 100);
    for (let attempt = 0; attempt < 2; attempt++) {
      errors.push(await createBackgroundParentAgent({ engineKind: 'codex', model: 'fixture', effort: 'low', workspace: dir, instructions: 'fixture only' }, { dataDir }, { runner }).then(() => undefined, error => error));
      leftovers.push(readdirSync(root));
    }
    assert.equal(calls, 0, 'preflight must not invoke Herdr, systemd or the engine');
    assert.deepEqual(errors.map(error => error instanceof ParentAgentError ? error.reason : (error as NodeJS.ErrnoException)?.code), ['invalid_input', 'invalid_input']);
    for (const error of errors) {
      assert.ok(error instanceof ParentAgentError);
      assert.equal(error.message, 'Bot host private socket path is too long');
      assert.equal(error.message.includes(dir), false);
    }
    assert.deepEqual(leftovers, [[], []], 'the private root stays but has no epoch, journal or socket');
    assert.equal(statSync(root).mode & 0o777, 0o700);
  } finally { rmSync(dir, { recursive: true }); }
});
