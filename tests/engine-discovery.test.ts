import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ENGINE_KINDS, availabilityOf, defaultConfig, validateConfig } from '../src/main/policy/routing';
import { PolicyStore } from '../src/main/policy/store';
import { ENGINE_CATALOG } from '../src/shared/engines';
import { EngineProber } from '../src/main/engines/probe';
import { applyEngineEnabled, parseEngineToggle } from '../src/main/engines/control';

test('pi is a fixed catalog engine and only claude and codex advertise native subagents', () => {
  const pi = ENGINE_CATALOG.find(entry => entry.id === 'pi');
  assert.equal(ENGINE_CATALOG.length, 7);
  assert.equal(pi?.kind, 'pi');
  assert.equal(pi?.command, 'pi');
});

test('gemini is not offered by the catalog or the policy schema', () => {
  const offered: string[] = ENGINE_CATALOG.flatMap(entry => [entry.id, entry.kind, entry.command]);
  assert.equal(offered.includes('gemini'), false);
  assert.equal(ENGINE_KINDS.includes('gemini'), false);
});

function bin(name: string, body: string): { root: string; pathEnv: string } {
  const root = mkdtempSync(join(tmpdir(), 'weaver-cli-'));
  const file = join(root, name);
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return { root, pathEnv: root };
}

test('path discovery reports installed, missing, nonzero and timeout without a shell', async () => {
  const installed = bin('codex', '');
  const args = join(installed.root, 'args.txt');
  writeFileSync(join(installed.root, 'codex'), `#!/bin/sh\nprintf '%s\\n' "$#" "$1" > ${JSON.stringify(args)}\necho "codex 1.2.3"\n`, { mode: 0o755 });
  chmodSync(join(installed.root, 'codex'), 0o755);
  const prober = new EngineProber({ pathEnv: installed.pathEnv, timeoutMs: 1000, env: { SECRET_TOKEN: 'super-secret', PATH: installed.pathEnv } });
  try {
    const found = await prober.probeOne('codex');
    assert.equal(found.status, 'installed');
    assert.equal(found.version, 'codex 1.2.3');
    assert.equal(found.authenticated, false);
    assert.equal(found.modelUsable, false);
    assert.ok(found.path?.endsWith('/codex'));
    assert.equal(readFileSync(args, 'utf8'), '1\n--version\n');
    const missing = await prober.probeOne('pi');
    assert.equal(missing.status, 'missing');
    assert.equal(missing.path, undefined);
  } finally { rmSync(installed.root, { recursive: true, force: true }); }

  const failed = bin('claude', '#!/bin/sh\necho "nope" >&2\nexit 2\n');
  try {
    const result = await new EngineProber({ pathEnv: failed.pathEnv, timeoutMs: 1000 }).probeOne('claude');
    assert.equal(result.status, 'probe_failed');
    assert.match(result.detail ?? '', /exited 2/);
    assert.equal(result.authenticated, false);
  } finally { rmSync(failed.root, { recursive: true, force: true }); }

  const hung = bin('grok', '#!/bin/sh\nexec /bin/sleep 30\n');
  try {
    const started = Date.now();
    const result = await new EngineProber({ pathEnv: hung.pathEnv, timeoutMs: 200 }).probeOne('grok');
    assert.equal(result.status, 'probe_failed');
    assert.match(result.detail ?? '', /timed out/);
    assert.ok(Date.now() - started < 5_000);
  } finally { rmSync(hung.root, { recursive: true, force: true }); }
});

test('overlapping scans share one version probe per command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-cli-'));
  const count = join(root, 'count');
  writeFileSync(count, '0');
  writeFileSync(join(root, 'opencode'), `#!/bin/sh\nn=$(cat ${JSON.stringify(count)})\necho $((n+1)) > ${JSON.stringify(count)}\nsleep 0.4\necho "opencode 0.1"\n`, { mode: 0o755 });
  chmodSync(join(root, 'opencode'), 0o755);
  try {
    const prober = new EngineProber({ pathEnv: root, timeoutMs: 2000 });
    const [left, right] = await Promise.all([prober.scan(), prober.scan()]);
    assert.equal(left.find(item => item.id === 'opencode')?.status, 'installed');
    assert.equal(right.find(item => item.id === 'opencode')?.status, 'installed');
    assert.equal(readFileSync(count, 'utf8').trim(), '1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enabling an installed engine does not create or enable roles and preserves them on disable', async () => {
  const installed = bin('pi', '#!/bin/sh\necho "pi 0.9 ${SECRET_TOKEN:-clean}"\n');
  const root = mkdtempSync(join(tmpdir(), 'weaver-policy-'));
  try {
    const store = new PolicyStore(join(root,'weaver.db'));
    const before = store.snapshot();
    const prober = new EngineProber({ pathEnv: installed.pathEnv, timeoutMs: 1000, env: { SECRET_TOKEN: 'super-secret', PATH: installed.pathEnv } });
    const enabled = await applyEngineEnabled(store, prober, { id: 'pi', enabled: true, revision: before.revision });
    assert.equal(enabled.probe?.status, 'installed');
    assert.equal(enabled.probe?.version?.includes('super-secret'), false);
    assert.equal(enabled.probe?.version?.includes('clean'), true);
    assert.deepEqual(enabled.snapshot.config.owners, before.config.owners);
    assert.deepEqual(enabled.snapshot.config.workers, before.config.workers);
    assert.equal(enabled.snapshot.config.engines.pi.enabled, true);
    assert.equal(enabled.snapshot.config.engines.pi.kind, 'pi');
    const disabled = await applyEngineEnabled(store, prober, { id: 'pi', enabled: false, revision: enabled.snapshot.revision });
    assert.equal(disabled.snapshot.config.engines.pi.enabled, false);
    assert.deepEqual(disabled.snapshot.config.owners, before.config.owners);
    assert.deepEqual(disabled.snapshot.config.workers, before.config.workers);
    assert.equal(disabled.probe, null);
  } finally {
    rmSync(installed.root, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed probe and stale revision block enablement without writing, while an engine with enabled roles can always be disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-policy-'));
  const absent = mkdtempSync(join(tmpdir(), 'weaver-cli-'));
  try {
    const store = new PolicyStore(join(root,'weaver.db'));
    const prober = new EngineProber({ pathEnv: absent, timeoutMs: 300 });
    await assert.rejects(() => applyEngineEnabled(store, prober, { id: 'opencode', enabled: true, revision: 0 }), /not installed|missing|Version/);
    assert.equal(store.snapshot().revision, 0);
    assert.equal(store.snapshot().config.engines.opencode.enabled, false);
    // Disabling never asks the roles on the engine to be disabled first; they stay enabled and just stop being scheduled.
    const off = await applyEngineEnabled(store, prober, { id: 'claude', enabled: false, revision: 0 });
    assert.equal(off.snapshot.revision, 1);
    assert.equal(store.snapshot().config.owners.claude_owner.enabled, true);
    assert.equal(store.snapshot().config.workers.claude_worker.enabled, true);
    assert.equal(store.snapshot().config.engines.claude.enabled, false);
    assert.equal(store.snapshot().owners.claude_owner.status, 'engine_disabled');
    assert.equal(store.snapshot().workers.claude_worker.status, 'engine_disabled');
    store.save({ revision: 1, config: store.snapshot().config, blocks: [] });
    await assert.rejects(() => applyEngineEnabled(store, prober, { id: 'grok', enabled: false, revision: 1 }), /reload/);
    assert.equal(store.snapshot().revision, 2);
    assert.equal(store.snapshot().config.engines.grok.enabled, false);
    assert.throws(() => parseEngineToggle({ id: 'grok', enabled: true, revision: 1, argv: ['grok'] }), /Unknown/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(absent, { recursive: true, force: true });
  }
});

test('an enabled role on a disabled engine is valid: it is simply not scheduled', () => {
  const config = defaultConfig();
  config.workers.grok_worker.enabled = true;
  assert.deepEqual(validateConfig(config), []);
  config.engines.claude.enabled = false;
  assert.deepEqual(validateConfig(config), []);
  assert.equal(availabilityOf(config, [], config.owners.claude_owner).status, 'engine_disabled');
  assert.equal(availabilityOf(config, [], config.workers.claude_worker, 'claude_worker').status, 'engine_disabled');
});

test('version probe stops descendants that keep the pipes open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-cli-'));
  const parent = join(root, 'parent.pid');
  const child = join(root, 'child.pid');
  writeFileSync(join(root, 'opencode'), `#!/bin/sh\necho $$ > ${JSON.stringify(parent)}\n/bin/sleep 30 &\necho $! > ${JSON.stringify(child)}\nexit 0\n`, { mode: 0o755 });
  chmodSync(join(root, 'opencode'), 0o755);
  const killNoted = () => {
    for (const file of [parent, child]) {
      if (!existsSync(file)) continue;
      const pid = Number(readFileSync(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  };
  try {
    const started = Date.now();
    const result = await new EngineProber({ pathEnv: root, timeoutMs: 100 }).probeOne('opencode');
    assert.notEqual(result.status, 'installed');
    const pids = [parent, child].map(file => Number(readFileSync(file, 'utf8')));
    const deadline = Math.min(Date.now() + 250, started + 1_000);
    while (pids.some(executable) && Date.now() < deadline) await delay(10);
    for (const pid of pids) assert.equal(executable(pid), false, `probe descendant ${pid} is still executable`);
    assert.ok(Date.now() - started < 1_000, 'descendant must not hold the probe open or remain executable');
  } finally { killNoted(); rmSync(root, { recursive: true, force: true }); }
});

test('version text drops controls and rejects an empty success', async () => {
  const colored = bin('claude', '#!/bin/sh\nprintf \'\\033[31mclaude 9.9.9\\033[0m\\n\'\n');
  try {
    const result = await new EngineProber({ pathEnv: colored.pathEnv, timeoutMs: 1000 }).probeOne('claude');
    assert.equal(result.status, 'installed');
    assert.equal(result.version, 'claude 9.9.9');
  } finally { rmSync(colored.root, { recursive: true, force: true }); }

  const empty = bin('codex', '#!/bin/sh\nexit 0\n');
  try {
    const result = await new EngineProber({ pathEnv: empty.pathEnv, timeoutMs: 1000 }).probeOne('codex');
    assert.equal(result.status, 'probe_failed');
    assert.equal(result.version, undefined);
    assert.match(result.detail ?? '', /usable version/);
  } finally { rmSync(empty.root, { recursive: true, force: true }); }
});

test('policy save cannot enable an engine, and a mismatched kind is not probed or converted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-policy-'));
  const marker = join(root, 'probed');
  const trap = bin('grok', `#!/bin/sh\necho probed > ${JSON.stringify(marker)}\necho "grok 1.0"\n`);
  try {
    const store = new PolicyStore(join(root,'weaver.db'));
    const enabled = structuredClone(store.snapshot().config);
    enabled.engines.grok.enabled = true;
    assert.throws(() => store.save({ revision: 0, config: enabled, blocks: [] }), /probe toggle/);
    assert.equal(store.snapshot().config.engines.grok.enabled, false);
    assert.equal(store.snapshot().revision, 0);
    const blocked = structuredClone(store.snapshot().config);
    blocked.engines.claude.enabled = false;
    // Policy save may disable an engine whose roles are still enabled; only enabling stays behind the probe toggle.
    store.save({ revision: 0, config: blocked, blocks: [] });
    assert.equal(store.snapshot().config.engines.claude.enabled, false);
    assert.equal(store.snapshot().config.owners.claude_owner.enabled, true);
    const preserved = structuredClone(store.snapshot().config);
    preserved.engines.pi = { enabled: false, kind: 'pi' };
    preserved.engines.grok.kind = 'claude';
    const saved = store.save({ revision: 1, config: preserved, blocks: [] });
    await assert.rejects(() => applyEngineEnabled(store, new EngineProber({ pathEnv: trap.pathEnv, timeoutMs: 1000 }), { id: 'grok', enabled: true, revision: saved.revision }), /does not match|not probed/);
    assert.equal(existsSync(marker), false);
    assert.equal(store.snapshot().config.engines.grok.kind, 'claude');
    assert.equal(store.snapshot().config.engines.grok.enabled, false);
    assert.equal(store.snapshot().config.engines.pi?.kind, 'pi');
    assert.equal(store.snapshot().config.engines.pi?.enabled, false);
    await assert.rejects(() => applyEngineEnabled(store, new EngineProber({ pathEnv: trap.pathEnv, timeoutMs: 500 }), { id: 'pi', enabled: true, revision: store.snapshot().revision }), /not installed/);
    assert.equal(store.snapshot().config.engines.pi?.kind, 'pi');
    assert.equal(store.snapshot().config.engines.pi?.enabled, false);
    await assert.rejects(() => applyEngineEnabled(store, new EngineProber({ pathEnv: trap.pathEnv, timeoutMs: 500 }), { id: 'cursor', enabled: true, revision: store.snapshot().revision }), /outside the supported catalog/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(trap.root, { recursive: true, force: true });
  }
});

function executable(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // comm may contain spaces or parentheses. The state follows its final ')'.
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  }
  return true;
}
