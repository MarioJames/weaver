import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHerdrParentAgent } from '../../src/main/im/parent-herdr';
import { ConfirmedParentCancellation, ParentTurnNotSubmitted, type ParentAgentSession } from '../../src/main/im/parent-agent';
import { bootIdentity, processStart, resourceRun } from '../../src/main/im/parent-host-resources';

const proof = (value: unknown) => { if (process.env.WEAVER_IM_HOST_TEST_PROOF) appendFileSync(process.env.WEAVER_IM_HOST_TEST_PROOF, JSON.stringify(value) + '\n', { mode: 0o600 }); };
const root = process.env.WEAVER_IM_HOST_TEST_ROOT;
const releaseHostCommand = () => process.env.WEAVER_IM_HOST_TEST_STANDALONE === '1' ? [process.env.WEAVER_IM_HOST_TEST_BUNDLE!] : [process.execPath, process.env.WEAVER_IM_HOST_TEST_BUNDLE!];
const enabled = process.env.WEAVER_IM_HERDR_HOST_TEST === '1' && !!root && !!process.env.WEAVER_IM_HOST_TEST_BUNDLE;
for (const engine of ['codex', 'claude'] as const) {
  test(`real Herdr single-service ${engine} host: IPC ready, confirmed cancel, continuation, whole close`, { skip: !enabled, timeout: 60000 }, async () => {
    const dir = mkdtempSync(join(root!, 'h-'));
    const workspace = join(dir, 'ws'); mkdirSync(workspace);
    const bin = join(dir, 'bin'); mkdirSync(bin);
    copyFileSync(new URL(`../fixtures/parent/${engine}-fixture.mjs`, import.meta.url), join(bin, engine)); chmodSync(join(bin, engine), 0o700);
    const oldPath = process.env.PATH;
    const prefix = engine.toUpperCase();
    const marker = join(dir, 'marker');
    process.env.PATH = `${bin}:${oldPath}`;
    process.env[`${prefix}_FIXTURE_SCENARIO`] = 'abort'; process.env[`${prefix}_FIXTURE_MARKER`] = marker;
    let session: ParentAgentSession | undefined;
    let record: any;
    try {
      session = await createHerdrParentAgent({ engineKind: engine, model: 'fixture-model', effort: 'low', workspace, instructions: 'Fixture only. No model.' }, { dataDir: dir }, { hostCommand: releaseHostCommand(), startupMs: 15000 });
      const registry = join(dir, 'im-host');
      const epoch = readdirSync(registry)[0]; record = JSON.parse(readFileSync(join(registry, epoch, 'record.json'), 'utf8'));
      proof({ case: engine, stage: 'ready', record });
      const properties = await resourceRun('systemctl', ['--user', 'show', record.unit, '-p', 'Type', '-p', 'ExitType', '-p', 'KillMode', '-p', 'Restart', '-p', 'RemainAfterExit', '-p', 'MemoryHigh', '-p', 'MemoryMax']);
      assert.match(properties.stdout, /Type=exec/); assert.match(properties.stdout, /ExitType=main/); assert.match(properties.stdout, /KillMode=control-group/); assert.match(properties.stdout, /Restart=no/);
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
      assert.deepEqual(readdirSync(registry), []); proof({ case: engine, stage: 'closed', unit: record.unit, tab: record.lane.tabId, hostAndEngineAbsent: true, cgroupAbsent: true });
      const tab = await resourceRun('herdr', ['--session', 'default', 'tab', 'get', record.lane.tabId]);
      assert.equal(JSON.parse(tab.stdout || tab.stderr).error.code, 'tab_not_found');
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

for (const failure of ['kill-host', 'engine-exit', 'close-pane', 'bad-callback', 'close-failure', 'startup-failure', 'recovery'] as const) test(`real host ${failure}: fence, exact cleanup and recovery`, { skip: !enabled, timeout: 60000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const dir = mkdtempSync(join(root!, 'h-'));
  const ws = join(dir, 'ws'); mkdirSync(ws);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  copyFileSync(new URL('../fixtures/parent/codex-fixture.mjs', import.meta.url), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o700);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  process.env.CODEX_FIXTURE_MARKER = join(dir, 'marker'); process.env.CODEX_FIXTURE_SCENARIO = 'default';
  const input = { engineKind: 'codex' as const, model: 'fixture', effort: 'low', workspace: ws, instructions: 'No model. Fixture only.' };
  let brokenClose = false;
  const { defaultAsyncRunner } = await import('../../src/main/owner-host');
  const runner: typeof defaultAsyncRunner = request => {
    if (request.file === 'herdr' && request.args.includes('run')) {
      const epoch = readdirSync(join(dir, 'im-host'))[0];
      proof({ case: failure, stage: 'launch-intent', record: JSON.parse(readFileSync(join(dir, 'im-host', epoch, 'record.json'), 'utf8')) });
    }
    return brokenClose && request.file === 'herdr' && request.args.includes('get') ? Promise.resolve({ code: 1, stdout: '', stderr: 'fixture close unavailable' }) : defaultAsyncRunner(request);
  };
  const options = { dataDir: dir }, internals = { hostCommand: releaseHostCommand(), startupMs: 15000, runner };
  const readRecord = () => { const epochs = readdirSync(join(dir, 'im-host')); return JSON.parse(readFileSync(join(dir, 'im-host', epochs[0], 'record.json'), 'utf8')); };
  let session: ParentAgentSession | undefined, controller: ReturnType<typeof spawn> | undefined;
  try {
    if (failure === 'startup-failure') {
      process.env.CODEX_FIXTURE_SCENARIO = 'startup-failed';
      await assert.rejects(createHerdrParentAgent(input, options, internals));
      assert.deepEqual(readdirSync(join(dir, 'im-host')), []);
      return;
    }
    if (failure === 'recovery') {
      const script = `import {createHerdrParentAgent} from ${JSON.stringify(new URL('../../src/main/im/parent-herdr.ts', import.meta.url).href)}; await createHerdrParentAgent(${JSON.stringify(input)},${JSON.stringify(options)},${JSON.stringify(internals)}); console.log('ready');`;
      controller = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((resolve, reject) => { controller!.stdout!.once('data', () => resolve()); controller!.once('exit', () => reject(new Error('fixture controller exited'))); });
      const old = readRecord(); proof({ case: failure, stage: 'old-ready', record: old });
      const exit = once(controller, 'close'); controller.kill('SIGKILL'); await exit;
      session = await createHerdrParentAgent(input, options, internals);
      assert.notEqual(readRecord().epoch, old.epoch);
      const tab = await resourceRun('herdr', ['--session', 'default', 'tab', 'get', old.lane.tabId]);
      assert.equal(JSON.parse(tab.stdout || tab.stderr).error.code, 'tab_not_found');
      assert.equal(existsSync(`/proc/${old.mainPid}`), false);
    } else {
      session = await createHerdrParentAgent(input, options, internals);
      const record = readRecord(); proof({ case: failure, stage: 'ready', record });
      if (failure === 'close-failure') {
        brokenClose = true; await assert.rejects(session.close());
        await assert.rejects(createHerdrParentAgent(input, options, internals));
        brokenClose = false;
      } else if (failure === 'bad-callback') {
        await assert.rejects(session.send('callback must fail', undefined, () => { throw new Error('fixture callback'); }));
      } else if (failure === 'engine-exit') {
        const pid = JSON.parse(readFileSync(join(dir, 'marker'), 'utf8').split('\n')[0]).spawnPid;
        assert.equal(readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim(), `0::${record.cgroup}`);
        process.kill(pid, 'SIGKILL');
      } else if (failure === 'kill-host') {
        const killed = await resourceRun('systemctl', ['--user', 'kill', '--kill-whom=main', '--signal=SIGKILL', record.unit]); assert.equal(killed.code, 0);
      } else {
        const closed = await resourceRun('herdr', ['--session', 'default', 'pane', 'close', record.lane.paneId]); assert.equal(closed.code, 0);
      }
      await Promise.race([session.unavailable!, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('unavailable missing')), 5000).unref())]);
      await assert.rejects(session.send('must not run'));
    }
    const closingRecord = readRecord();
    await session.close();
    proof({ case: failure, stage: 'closed', record: closingRecord, registryEmpty: readdirSync(join(dir, 'im-host')).length === 0 });
    assert.deepEqual(readdirSync(join(dir, 'im-host')), []);
  } finally {
    brokenClose = false; controller?.kill('SIGKILL');
    try { await session?.close(); }
    finally {
      process.env.PATH = oldPath; delete process.env.CODEX_FIXTURE_MARKER; delete process.env.CODEX_FIXTURE_SCENARIO;
      if (existsSync(join(dir, 'im-host')) && readdirSync(join(dir, 'im-host')).length === 0) rmSync(dir, { recursive: true });
    }
  }
});

test('late launch after revoked epoch cannot spawn a host or engine', { skip: !enabled, timeout: 15000 }, async () => {
  const { defaultAsyncRunner } = await import('../../src/main/owner-host');
  const dir = mkdtempSync(join(root!, 'h-'));
  const ws = join(dir, 'ws'); mkdirSync(ws);
  let command = '', record: any;
  try {
    await assert.rejects(createHerdrParentAgent({ engineKind: 'codex', model: 'fixture', effort: 'low', workspace: ws, instructions: 'Never submit to any model.' }, { dataDir: dir }, {
      hostCommand: releaseHostCommand(), startupMs: 400,
      runner: async request => {
        if (request.file === 'herdr' && request.args.includes('run')) {
          command = request.args.at(-1)!;
          const epoch = readdirSync(join(dir, 'im-host'))[0]; record = JSON.parse(readFileSync(join(dir, 'im-host', epoch, 'record.json'), 'utf8'));
          return { code: 0, stdout: '', stderr: '' };
        }
        return defaultAsyncRunner(request);
      },
    }));
    proof({ case: 'late-launch', record });
    assert.ok(command); assert.equal(existsSync(record.endpoint), false);
    // Replay only this task's captured, controlled launcher after the tab and authorization were removed.
    const delayed = await resourceRun('/bin/sh', ['-c', command]);
    proof({ case: 'late-launch', launcher: delayed });
    assert.equal(delayed.code, 1);
    assert.match(delayed.stderr, /Finished with result: exec-condition/, 'the revoked service is skipped before MainPID can start');
    const unit = await resourceRun('systemctl', ['--user', 'show', record.unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID']);
    assert.match(unit.stdout, /LoadState=not-found/); assert.match(unit.stdout, /MainPID=0/);
    assert.deepEqual(readdirSync(join(dir, 'im-host')), []);
  } finally {
    // Preserve any uncertain receipt rather than sweeping unknown resources.
    if (existsSync(join(dir, 'im-host')) && readdirSync(join(dir, 'im-host')).length === 0) rmSync(dir, { recursive: true });
  }
});
