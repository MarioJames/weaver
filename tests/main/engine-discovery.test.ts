import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ENGINE_KINDS, defaultConfig, validateConfig } from '../../src/main/policy/routing';
import { availabilityOf } from '../../src/shared/policy/availability';
import { ENGINE_CATALOG, engineReadiness, EXECUTION_BOUNDARY, type EngineProbeRecord } from '../../src/shared/engines';
import { EngineProber } from '../../src/main/engines/probe';

test('pi is a fixed catalog engine and only claude and codex advertise native subagents', () => {
  const pi = ENGINE_CATALOG.find(entry => entry.id === 'pi');
  assert.equal(ENGINE_CATALOG.length, 7);
  assert.equal(pi?.kind, 'pi');
  assert.equal(pi?.command, 'pi');
  const dsh = ENGINE_CATALOG.find(entry => entry.id === 'dsh');
  assert.equal(dsh?.kind, 'dsh');
  assert.equal(dsh?.command, 'dsh');
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

test('legacy engine flags do not prevent enabled channel roles from routing', () => {
  const config = defaultConfig();
  config.workers.grok_worker.enabled = true;
  assert.deepEqual(validateConfig(config), []);
  config.engines.claude.enabled = false;
  assert.deepEqual(validateConfig(config), []);
  assert.equal(availabilityOf(config, [], config.owners.claude_owner).status, 'available');
  assert.equal(availabilityOf(config, [], config.workers.claude_worker, 'claude_worker').status, 'available');
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


test('readiness follows channel enablement and diagnoses missing adapters separately',()=>{
 const config=defaultConfig();
 config.engines.claude.enabled=false;
 const probe:EngineProbeRecord={id:'claude',kind:'claude',command:'claude',status:'installed',probedAt:new Date().toISOString(),authenticated:false,modelUsable:false};
 assert.equal(engineReadiness(probe,config).realExecution,true);
 assert.equal(EXECUTION_BOUNDARY.enablementAuthority,'policy.channels.enabled');
 assert.equal(engineReadiness({...probe,status:'missing'},config).installed,false);
 assert.equal(engineReadiness({...probe,status:'missing'},config).realExecution,false);
 config.channels.default_claude.enabled=false;
 assert.equal(engineReadiness(probe,config).realExecution,false);
 config.channels.default_claude.enabled=true;
 config.engines.claude.kind='unknown' as never;
 assert.equal(engineReadiness(probe,config).adapterStatus,'not_implemented');
 assert.equal(engineReadiness(probe,config).realExecution,false);
});
