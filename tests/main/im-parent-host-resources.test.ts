import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bootIdentity, cleanupHostRecord, inspectHostUnit, processStart, readHostRecords, saveHostRecord, type HostRecord } from '../../src/main/im/parent-host-resources';
import { createHerdrParentAgent } from '../../src/main/im/parent-herdr';
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
      errors.push(await createHerdrParentAgent({ engineKind: 'codex', model: 'fixture', effort: 'low', workspace: dir, instructions: 'fixture only' }, { dataDir }, { runner }).then(() => undefined, error => error));
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
