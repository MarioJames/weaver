import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createBackgroundParentAgent } from '../../src/main/im/parent-background';
import { ConfirmedParentCancellation, ParentTurnNotSubmitted, type ParentAgentSession } from '../../src/main/im/parent-agent';
import { bootIdentity, herdrServer, processStart, resourceRun, saveHostRecord, type HostRecord } from '../../src/main/im/parent-host-resources';

const proof = (value: unknown) => { if (process.env.WEAVER_IM_HOST_TEST_PROOF) appendFileSync(process.env.WEAVER_IM_HOST_TEST_PROOF, JSON.stringify(value) + '\n', { mode: 0o600 }); };
const root = process.env.WEAVER_IM_HOST_TEST_ROOT;
const releaseHostCommand = () => process.env.WEAVER_IM_HOST_TEST_STANDALONE === '1' ? [process.env.WEAVER_IM_HOST_TEST_BUNDLE!] : [process.execPath, process.env.WEAVER_IM_HOST_TEST_BUNDLE!];
const enabled = process.env.WEAVER_IM_BACKGROUND_HOST_TEST === '1' && !!root && !!process.env.WEAVER_IM_HOST_TEST_BUNDLE;
for (const engine of ['codex', 'claude'] as const) {
  test(`real background single-service ${engine} host: IPC ready, confirmed cancel, continuation, whole close`, { skip: !enabled, timeout: 60000 }, async () => {
    const dir = mkdtempSync(join(root!, 'h-'));
    const workspace = join(dir, 'ws'); mkdirSync(workspace);
    const bin = join(dir, 'bin'); mkdirSync(bin);
    copyFileSync(new URL(`../fixtures/parent/${engine}-fixture.mjs`, import.meta.url), join(bin, engine)); chmodSync(join(bin, engine), 0o700);
    const oldPath = process.env.PATH;
    const prefix = engine.toUpperCase();
    const marker = join(dir, 'marker');
    process.env.PATH = `${bin}:${oldPath}`;
    process.env[`${prefix}_FIXTURE_SCENARIO`] = 'abort'; process.env[`${prefix}_FIXTURE_MARKER`] = marker;
    const { defaultAsyncRunner } = await import('../../src/main/owner-host');
    const herdrCalls: string[] = [];
    const runner: typeof defaultAsyncRunner = request => {
      if (request.file === 'herdr' || request.file.endsWith('/herdr')) herdrCalls.push(request.args.join(' '));
      return defaultAsyncRunner(request);
    };
    let session: ParentAgentSession | undefined;
    let record: any;
    try {
      session = await createBackgroundParentAgent({ engineKind: engine, model: 'fixture-model', effort: 'low', workspace, instructions: 'Fixture only. No model.' }, { dataDir: dir }, { hostCommand: releaseHostCommand(), startupMs: 15000, runner });
      const registry = join(dir, 'im-host');
      const epoch = readdirSync(registry)[0]; record = JSON.parse(readFileSync(join(registry, epoch, 'record.json'), 'utf8'));
      proof({ case: engine, stage: 'ready', record });
      assert.equal(record.launchMode, 'background');
      assert.equal(record.lane, undefined); assert.equal(record.server, undefined); assert.equal(record.allocating, undefined);
      const properties = await resourceRun('systemctl', ['--user', 'show', record.unit, '-p', 'Type', '-p', 'ExitType', '-p', 'KillMode', '-p', 'Restart', '-p', 'RemainAfterExit', '-p', 'MemoryHigh', '-p', 'MemoryMax', '-p', 'StandardInput', '-p', 'StandardOutput', '-p', 'StandardError'], runner);
      assert.match(properties.stdout, /Type=exec/); assert.match(properties.stdout, /KillMode=control-group/); assert.match(properties.stdout, /Restart=no/);
      assert.match(properties.stdout, /StandardInput=null/); assert.match(properties.stdout, /StandardOutput=journal/); assert.match(properties.stdout, /StandardError=journal/);
      proof({ case: engine, properties: properties.stdout });
      assert.equal(record.boot, bootIdentity());
      const spawned = JSON.parse(readFileSync(marker, 'utf8').split('\n')[0]).spawnPid;
      assert.equal(readFileSync(`/proc/${spawned}/cgroup`, 'utf8').trim(), `0::${record.cgroup}`, 'engine must remain in the host unit');
      let unavailable = false; void session.unavailable!.then(() => { unavailable = true; });
      const beforeSubmit = new AbortController();
      const notSubmitted = session.send('must not execute', beforeSubmit.signal); beforeSubmit.abort();
      await assert.rejects(notSubmitted, ParentTurnNotSubmitted);
      assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 1);
      const abort = new AbortController();
      let delta!: () => void; const gotDelta = new Promise<void>(resolve => { delta = resolve; });
      let settled = false;
      const sending = session.send('first', abort.signal, () => delta()).finally(() => { settled = true; });
      await gotDelta; abort.abort();
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(settled, false, 'cancel waits for matching engine terminal');
      await assert.rejects(sending, ConfirmedParentCancellation);
      assert.equal(unavailable, false, 'confirmed cancel retains control');
      const chunks: string[] = [];
      assert.ok(await session.send('second', undefined, value => chunks.push(value)));
      assert.ok(chunks.length); assert.ok(!chunks.join('').includes('OLD'));
      assert.ok(await session.send('third'));
      assert.equal(processStart(record.mainPid), record.mainStart);
      await session.close();
      assert.equal(existsSync(`/proc/${record.mainPid}`), false);
      assert.equal(existsSync(`/proc/${spawned}`), false);
      assert.equal(existsSync(join('/sys/fs/cgroup', record.cgroup)), false);
      assert.deepEqual(readdirSync(registry), []); proof({ case: engine, stage: 'closed', unit: record.unit, hostAndEngineAbsent: true, cgroupAbsent: true });
      const unit = await resourceRun('systemctl', ['--user', 'show', record.unit, '-p', 'LoadState', '-p', 'ActiveState'], runner);
      assert.match(unit.stdout, /LoadState=not-found/);
      assert.deepEqual(herdrCalls, [], 'background launch and cleanup must never invoke Herdr');
    } finally {
      try { await session?.close(); }
      finally {
        process.env.PATH = oldPath;
        delete process.env[`${prefix}_FIXTURE_SCENARIO`]; delete process.env[`${prefix}_FIXTURE_MARKER`];
        // Never erase a failed-cleanup journal: it is the authority for exact recovery.
        if (!existsSync(join(dir, 'im-host')) || readdirSync(join(dir, 'im-host')).length === 0) rmSync(dir, { recursive: true });
      }
    }
  });
}

for (const failure of ['kill-host', 'engine-exit', 'bad-callback', 'close-failure', 'startup-failure', 'recovery'] as const) test(`real background host ${failure}: fence, exact cleanup and recovery`, { skip: !enabled, timeout: 60000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const dir = mkdtempSync(join(root!, 'h-'));
  const ws = join(dir, 'ws'); mkdirSync(ws);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  copyFileSync(new URL('../fixtures/parent/codex-fixture.mjs', import.meta.url), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o700);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  process.env.CODEX_FIXTURE_MARKER = join(dir, 'marker'); process.env.CODEX_FIXTURE_SCENARIO = 'default';
  let brokenClose = false;
  const { defaultAsyncRunner } = await import('../../src/main/owner-host');
  const herdrCalls: string[] = [];
  const runner: typeof defaultAsyncRunner = request => {
    if (request.file === 'herdr' || request.file.endsWith('/herdr')) herdrCalls.push(request.args.join(' '));
    if (request.file === 'herdr' || request.file.endsWith('/herdr')) return defaultAsyncRunner(request);
    if (brokenClose && request.file === 'systemctl' && request.args.includes('show')) return Promise.resolve({ code: 1, stdout: '', stderr: 'fixture inspection unavailable' });
    return defaultAsyncRunner(request);
  };
  const options = { dataDir: dir }, internals = { hostCommand: releaseHostCommand(), startupMs: 15000, runner };
  const input = { engineKind: 'codex' as const, model: 'fixture', effort: 'low', workspace: ws, instructions: 'No model. Fixture only.' };
  const readRecord = () => { const epochs = readdirSync(join(dir, 'im-host')); return JSON.parse(readFileSync(join(dir, 'im-host', epochs[0], 'record.json'), 'utf8')); };
  let session: ParentAgentSession | undefined, controller: ReturnType<typeof spawn> | undefined;
  try {
    if (failure === 'startup-failure') {
      process.env.CODEX_FIXTURE_SCENARIO = 'startup-failed';
      const outcome = await createBackgroundParentAgent(input, options, internals).then(
        (value): { ok: true; value: ParentAgentSession } => ({ ok: true, value }),
        (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
      );
      if (outcome.ok) {
        // Unexpected success still owns an exact live session: close it before failing.
        try { await outcome.value.close(); } catch { /* close failure still proves ownership */ }
        assert.fail('startup failure must reject, not resolve to ready');
      }
      assert.ok(outcome.error, 'startup failure must reject');
      assert.deepEqual(readdirSync(join(dir, 'im-host')), []);
      return;
    }
    if (failure === 'recovery') {
      const script = `import {createBackgroundParentAgent} from ${JSON.stringify(new URL('../../src/main/im/parent-background.ts', import.meta.url).href)}; await createBackgroundParentAgent(${JSON.stringify(input)},${JSON.stringify(options)},${JSON.stringify(internals)}); console.log('ready');`;
      controller = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((resolve, reject) => { controller!.stdout!.once('data', () => resolve()); controller!.once('exit', () => reject(new Error('fixture controller exited'))); });
      const old = readRecord(); proof({ case: failure, stage: 'old-ready', record: old });
      assert.equal(old.launchMode, 'background');
      const exit = once(controller, 'close'); controller.kill('SIGKILL'); await exit;
      session = await createBackgroundParentAgent(input, options, internals);
      assert.notEqual(readRecord().epoch, old.epoch);
      assert.equal(existsSync(`/proc/${old.mainPid}`), false);
    } else {
      session = await createBackgroundParentAgent(input, options, internals);
      const record = readRecord(); proof({ case: failure, stage: 'ready', record });
      if (failure === 'close-failure') {
        brokenClose = true; await assert.rejects(session.close());
        const second = await createBackgroundParentAgent(input, options, internals).then(
          (value): { ok: true; value: ParentAgentSession } => ({ ok: true, value }),
          (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
        );
        if (second.ok) {
          try { await second.value.close(); } catch { /* close failure still proves ownership */ }
          assert.fail('a failed close must fence the next launch, not resolve');
        }
        assert.ok(second.error, 'a failed close must fence the next launch');
        brokenClose = false;
      } else if (failure === 'bad-callback') {
        await assert.rejects(session.send('callback must fail', undefined, () => { throw new Error('fixture callback'); }));
      } else if (failure === 'engine-exit') {
        const pid = JSON.parse(readFileSync(join(dir, 'marker'), 'utf8').split('\n')[0]).spawnPid;
        assert.equal(readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim(), `0::${record.cgroup}`);
        process.kill(pid, 'SIGKILL');
      } else {
        const killed = await resourceRun('systemctl', ['--user', 'kill', '--kill-whom=main', '--signal=SIGKILL', record.unit]); assert.equal(killed.code, 0);
      }
      await Promise.race([session.unavailable!, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('unavailable missing')), 5000).unref())]);
      await assert.rejects(session.send('must not run'));
    }
    const closingRecord = readRecord();
    await session.close();
    proof({ case: failure, stage: 'closed', record: closingRecord, registryEmpty: readdirSync(join(dir, 'im-host')).length === 0 });
    assert.deepEqual(readdirSync(join(dir, 'im-host')), []);
    assert.deepEqual(herdrCalls, [], 'background launch and cleanup must never invoke Herdr');
  } finally {
    brokenClose = false; controller?.kill('SIGKILL');
    try { await session?.close(); }
    finally {
      process.env.PATH = oldPath; delete process.env.CODEX_FIXTURE_MARKER; delete process.env.CODEX_FIXTURE_SCENARIO;
      if (existsSync(join(dir, 'im-host')) && readdirSync(join(dir, 'im-host')).length === 0) rmSync(dir, { recursive: true });
    }
  }
});

test('legacy Herdr journal is recovered exactly: owned tab closed, live foreign owner refused', { skip: !enabled, timeout: 60000 }, async () => {
  const { defaultAsyncRunner, allocateHerdrLane } = await import('../../src/main/owner-host');
  const { once } = await import('node:events');
  const { spawn } = await import('node:child_process');
  // Short prefix: the private socket path must stay within the 100-byte bound.
  const dir = mkdtempSync(join(root!, 'h-'));
  const ws = join(dir, 'ws'); mkdirSync(ws);
  const registry = join(dir, 'im-host'); mkdirSync(registry, { mode: 0o700 });
  const oldPath = process.env.PATH;
  // Exactly this test's own tabs/epoch dirs, for precise teardown only. Unknown
  // resources are never swept: each entry is closed/removed by its own identity.
  const ownedTabs: string[] = [];
  const ownedEpochDirs: string[] = [];
  let session: ParentAgentSession | undefined;
  try {
    // A stale legacy record whose owner is dead: the background factory must
    // reclaim its exact owned tab through the legacy path, then start fresh.
    const { randomUUID } = await import('node:crypto');
    const epoch = randomUUID(), epochDir = join(registry, epoch); mkdirSync(epochDir, { mode: 0o700 });
    ownedEpochDirs.push(epochDir);
    const lane = await allocateHerdrLane({ workspace: ws, label: 'weaver-legacy-recovery-probe', asyncRunner: defaultAsyncRunner, receipt: () => {} });
    ownedTabs.push(lane.tabId!);
    const server = await herdrServer(defaultAsyncRunner);
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    assert.ok(typeof sleeper.pid === 'number');
    const ownerStart = processStart(sleeper.pid!)!;
    sleeper.kill('SIGKILL');
    // Await the real exit: manufacturing a dead owner while the PID still exists
    // would be correctly refused as a live owner.
    await once(sleeper, 'close');
    const stale: HostRecord = { version: 1, epoch, unit: `weaver-im-host-${epoch}.service`, createdAt: new Date().toISOString(), ownerPid: sleeper.pid!, ownerStart, boot: bootIdentity(), endpoint: join(epochDir, 's'), label: 'legacy', launched: true, server, lane: { workspaceId: lane.workspaceId, tabId: lane.tabId, paneId: lane.paneId, createdWorkspace: lane.createdWorkspace } };
    saveHostRecord(epochDir, stale);
    const bin = join(dir, 'bin'); mkdirSync(bin);
    copyFileSync(new URL('../fixtures/parent/codex-fixture.mjs', import.meta.url), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o700);
    process.env.PATH = `${bin}:${oldPath}`;
    process.env.CODEX_FIXTURE_MARKER = join(dir, 'marker'); process.env.CODEX_FIXTURE_SCENARIO = 'default';
    session = await createBackgroundParentAgent({ engineKind: 'codex', model: 'fixture', effort: 'low', workspace: ws, instructions: 'No model. Fixture only.' }, { dataDir: dir }, { hostCommand: releaseHostCommand(), startupMs: 15000 });
    try {
      assert.ok(!existsSync(epochDir), 'the stale legacy journal is gone after exact recovery');
      const tab = await resourceRun('herdr', ['--session', 'default', 'tab', 'get', lane.tabId!]);
      assert.equal(JSON.parse(tab.stdout || tab.stderr).error.code, 'tab_not_found', 'the exact owned legacy tab is closed');
      proof({ case: 'legacy-recovery', stage: 'recovered', tab: lane.tabId });
      await session.close();
    } finally { try { await session.close(); } catch { /* already closed */ } }
    // A legacy record whose owner is still alive must be refused without touching its tab.
    const epoch2 = randomUUID(), epochDir2 = join(registry, epoch2); mkdirSync(epochDir2, { mode: 0o700 });
    ownedEpochDirs.push(epochDir2);
    const lane2 = await allocateHerdrLane({ workspace: ws, label: 'weaver-legacy-live-probe', asyncRunner: defaultAsyncRunner, receipt: () => {} });
    ownedTabs.push(lane2.tabId!);
    const liveRecord: HostRecord = { version: 1, epoch: epoch2, unit: `weaver-im-host-${epoch2}.service`, createdAt: new Date().toISOString(), ownerPid: process.pid, ownerStart: processStart(process.pid)!, boot: bootIdentity(), endpoint: join(epochDir2, 's'), label: 'legacy-live', launched: true, server, lane: { workspaceId: lane2.workspaceId, tabId: lane2.tabId, paneId: lane2.paneId, createdWorkspace: lane2.createdWorkspace } };
    saveHostRecord(epochDir2, liveRecord);
    let liveSession: ParentAgentSession | undefined;
    try {
      const attempted = await createBackgroundParentAgent({ engineKind: 'codex', model: 'fixture', effort: 'low', workspace: ws, instructions: 'No model. Fixture only.' }, { dataDir: dir }, { hostCommand: releaseHostCommand(), startupMs: 15000 }).then(
        (value): { ok: true; value: ParentAgentSession } => ({ ok: true, value }),
        (error: unknown): { ok: false } => { assert.ok(error, 'live owner must be refused'); return { ok: false }; },
      );
      // Unexpected success still owns an exact live session: close it before failing.
      if (attempted.ok) liveSession = attempted.value;
      assert.equal(liveSession, undefined, 'a live foreign owner must be refused');
    } finally { try { await liveSession?.close(); } catch { /* already closed */ } }
    assert.ok(existsSync(epochDir2), 'an uncertain journal is never swept');
    const stillThere = await resourceRun('herdr', ['--session', 'default', 'tab', 'get', lane2.tabId!]);
    assert.ok(!JSON.parse(stillThere.stdout || stillThere.stderr).error, 'a live foreign tab is never closed');
    proof({ case: 'legacy-recovery', stage: 'live-refused', tab: lane2.tabId });
    // Explicit teardown of only this test's own fixture tab and epoch dir.
    await resourceRun('herdr', ['--session', 'default', 'tab', 'close', lane2.tabId!]);
    const gone = await resourceRun('herdr', ['--session', 'default', 'tab', 'get', lane2.tabId!]);
    assert.equal(JSON.parse(gone.stdout || gone.stderr).error.code, 'tab_not_found');
    rmSync(epochDir2, { recursive: true });
  } finally {
    // Precise recovery of only this test's own resources, even on assertion
    // failure: exact tabs by identity, exact epoch dirs by path. Never a sweep.
    try { await session?.close(); } catch { /* already closed */ }
    for (const tab of ownedTabs) {
      try { await resourceRun('herdr', ['--session', 'default', 'tab', 'close', tab]); } catch { /* already reclaimed */ }
    }
    for (const owned of ownedEpochDirs) {
      try { rmSync(owned, { recursive: true, force: true }); } catch { /* already reclaimed */ }
    }
    process.env.PATH = oldPath; delete process.env.CODEX_FIXTURE_MARKER; delete process.env.CODEX_FIXTURE_SCENARIO;
    if (existsSync(registry) && readdirSync(registry).length === 0) rmSync(dir, { recursive: true });
  }
});

test('late launch after revoked epoch cannot spawn a host or engine', { skip: !enabled, timeout: 15000 }, async () => {
  const { defaultAsyncRunner } = await import('../../src/main/owner-host');
  const dir = mkdtempSync(join(root!, 'h-'));
  const ws = join(dir, 'ws'); mkdirSync(ws);
  // A fixture engine on PATH proves whether the late launch really spawned anything.
  const bin = join(dir, 'bin'); mkdirSync(bin);
  copyFileSync(new URL('../fixtures/parent/codex-fixture.mjs', import.meta.url), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o700);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  const marker = join(dir, 'marker');
  process.env.CODEX_FIXTURE_MARKER = marker; process.env.CODEX_FIXTURE_SCENARIO = 'default';
  let command: string[] = [], record: any;
  try {
    const backgroundInput = { engineKind: 'codex' as const, model: 'fixture', effort: 'low', workspace: ws, instructions: 'No model. Fixture only.' };
    await assert.rejects(createBackgroundParentAgent(backgroundInput, { dataDir: dir }, {
      hostCommand: releaseHostCommand(), startupMs: 400,
      runner: async request => {
        if (request.file === 'systemd-run') {
          command = [request.file, ...request.args];
          const epoch = readdirSync(join(dir, 'im-host'))[0]; record = JSON.parse(readFileSync(join(dir, 'im-host', epoch, 'record.json'), 'utf8'));
          return { code: 0, stdout: '', stderr: '' };
        }
        return defaultAsyncRunner(request);
      },
    }));
    proof({ case: 'late-launch', record });
    assert.ok(command.length); assert.equal(existsSync(record.endpoint), false);
    // Replay only this task's captured, controlled launcher after the socket was revoked.
    // A skipped ExecCondition may still ACK 0, so the contract is the real lifecycle:
    // MainPID 0, no host process, no engine spawn, unit/cgroup/journal reclaimed.
    const delayed = await resourceRun(command[0], command.slice(1));
    proof({ case: 'late-launch', launcher: { code: delayed.code, stdout: String(delayed.stdout ?? '').slice(0, 500), stderr: String(delayed.stderr ?? '').slice(0, 500) } });
    const unitEnd = Date.now() + 8000;
    let unit = '';
    for (;;) {
      const shown = await resourceRun('systemctl', ['--user', 'show', record.unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlGroup']);
      unit = shown.stdout;
      if (/LoadState=not-found/.test(unit)) break;
      if (Date.now() > unitEnd) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(unit, /MainPID=0/, 'the revoked service never started a main process');
    assert.match(unit, /LoadState=not-found/, 'the collected transient unit leaves no journal surface');
    const cgroup = /ControlGroup=(.*)/.exec(unit)?.[1]?.trim();
    assert.ok(!cgroup || !existsSync(join('/sys/fs/cgroup', cgroup)), 'no cgroup survives the revoked launch');
    let spawned = false;
    try { spawned = readFileSync(marker, 'utf8').includes('spawnPid'); } catch { /* no fixture output at all */ }
    assert.equal(spawned, false, 'the late launch spawned no engine');
    assert.equal(existsSync(record.endpoint), false, 'the revoked socket stays revoked');
    assert.deepEqual(readdirSync(join(dir, 'im-host')), []);
  } finally {
    process.env.PATH = oldPath; delete process.env.CODEX_FIXTURE_MARKER; delete process.env.CODEX_FIXTURE_SCENARIO;
    // Preserve any uncertain receipt rather than sweeping unknown resources.
    if (existsSync(join(dir, 'im-host')) && readdirSync(join(dir, 'im-host')).length === 0) rmSync(dir, { recursive: true });
  }
});

test('real background host identity failure (wrong marker) rejects as protocol with exact cleanup', { skip: !enabled, timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(root!, 'h-'));
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  copyFileSync(new URL('../fixtures/parent/codex-fixture.mjs', import.meta.url), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o700);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  process.env.CODEX_FIXTURE_SCENARIO = 'identity-wrong'; process.env.CODEX_FIXTURE_MARKER = join(dir, 'marker');
  const { defaultAsyncRunner } = await import('../../src/main/owner-host');
  const herdrCalls: string[] = [];
  try {
    // The host performs the hidden identity turn after native startup; a wrong marker
    // must fail startup as protocol (never ready) and leave no host record behind.
    const outcome = await createBackgroundParentAgent({ engineKind: 'codex', model: 'fixture', effort: 'low', workspace, instructions: 'No model. Fixture only.' }, { dataDir: dir }, { hostCommand: releaseHostCommand(), startupMs: 15000, runner: async request => { if (request.file === 'herdr' || request.file.endsWith('/herdr')) herdrCalls.push(request.args.join(' ')); return defaultAsyncRunner(request); } }).then(
      (value): { ok: true; value: ParentAgentSession } => ({ ok: true, value }),
      (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
    );
    if (outcome.ok) {
      // Unexpected success still owns an exact live session: close it before failing.
      try { await outcome.value.close(); } catch { /* close failure still proves ownership */ }
      assert.fail('identity failure must reject, not resolve to ready');
    }
    assert.equal((outcome.error as any)?.reason, 'protocol');
    assert.deepEqual(readdirSync(join(dir, 'im-host')), []);
    assert.deepEqual(herdrCalls, []);
  } finally {
    process.env.PATH = oldPath; delete process.env.CODEX_FIXTURE_MARKER; delete process.env.CODEX_FIXTURE_SCENARIO;
    if (existsSync(join(dir, 'im-host')) && readdirSync(join(dir, 'im-host')).length === 0) rmSync(dir, { recursive: true });
  }
});

test('real background host startup abort revokes intent fast with exact cleanup', { skip: !enabled, timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(root!, 'h-'));
  const workspace = join(dir, 'ws'); mkdirSync(workspace);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  copyFileSync(new URL('../fixtures/parent/codex-fixture.mjs', import.meta.url), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o700);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  // identity-hang keeps the hidden identity turn pending deterministically: aborting
  // before any ready is then a real revocation, never a race with a fast default ready.
  process.env.CODEX_FIXTURE_MARKER = join(dir, 'marker'); process.env.CODEX_FIXTURE_SCENARIO = 'identity-hang';
  const { defaultAsyncRunner } = await import('../../src/main/owner-host');
  const herdrCalls: string[] = [];
  const controller = new AbortController();
  let session: ParentAgentSession | undefined;
  try {
    const started = Date.now();
    const pending = createBackgroundParentAgent({ engineKind: 'codex', model: 'fixture', effort: 'low', workspace, instructions: 'No model. Fixture only.' }, { dataDir: dir, signal: controller.signal }, { hostCommand: releaseHostCommand(), startupMs: 60000, runner: async request => { if (request.file === 'herdr' || request.file.endsWith('/herdr')) herdrCalls.push(request.args.join(' ')); return defaultAsyncRunner(request); } });
    // Gate on the real fixture/host handshake: only abort once the fixture engine has
    // spawned (hidden identity turn pending), so startup is deterministically in flight.
    const marker = join(dir, 'marker');
    const gateEnd = Date.now() + 15000;
    for (;;) {
      let spawned = false;
      try { spawned = readFileSync(marker, 'utf8').includes('spawnPid'); } catch { /* fixture not started yet */ }
      if (spawned) break;
      if (Date.now() > gateEnd) assert.fail('fixture engine never spawned; startup was not in flight');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    controller.abort();
    const outcome = await pending.then(
      (value): { ok: true; value: ParentAgentSession } => ({ ok: true, value }),
      (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
    );
    if (outcome.ok) {
      // Unexpected success still owns an exact live session: close it before failing.
      session = outcome.value;
      try { await session.close(); } catch { /* close failure still proves ownership, not a leak */ }
      session = undefined;
      assert.fail('startup abort must reject, not resolve to ready');
    }
    assert.match(String((outcome.error as any)?.reason ?? outcome.error), /aborted|cancel/i);
    assert.ok(Date.now() - started < 30000, 'startup abort stays far below the extended budget');
    assert.deepEqual(readdirSync(join(dir, 'im-host')), []);
    assert.deepEqual(herdrCalls, []);
    proof({ case: 'startup-abort', stage: 'aborted-clean' });
  } finally {
    try { await session?.close(); } catch { /* already closed */ }
    process.env.PATH = oldPath; delete process.env.CODEX_FIXTURE_MARKER; delete process.env.CODEX_FIXTURE_SCENARIO;
    if (existsSync(join(dir, 'im-host')) && readdirSync(join(dir, 'im-host')).length === 0) rmSync(dir, { recursive: true });
  }
});
