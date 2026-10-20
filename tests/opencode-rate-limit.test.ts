import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../src/main/manager';
import { TaskStore } from '../src/main/store';
import { classifyVendorError } from '../src/main/adapters/cli/vendor-errors';
import { startCliAgent } from '../src/main/adapters/cli';

const SAMPLE = readFileSync(new URL('./fixtures/opencode-ratelimit-stderr.txt', import.meta.url), 'utf8');
const API_ERROR = 'timestamp=2026-10-19T14:09:10.177Z level=ERROR run=9f54ce89 message="stream error" providerID=opencode modelID=glm-5.3-flash-free small=true agent=title mode=primary error.error="AI_APICallError: Internal server error"\n';

async function run(stderr: string, sleepMs = 60000) {
  const { CommandHandler } = await import('../src/main/commands');
  const { PolicyStore } = await import('../src/main/policy/store');
  const dir = mkdtempSync(join(tmpdir(),'weaver-rl-'));
  const previous = process.env.PATH;
  writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(join(dir, 'systemctl'), '#!/bin/sh\necho ActiveState=inactive\n', { mode: 0o700 });
  writeFileSync(join(dir, 'stderr.txt'), stderr);
  writeFileSync(join(dir, 'opencode'), `#!${process.execPath}\nconst fs=require('fs');fs.readFileSync(0);fs.writeFileSync(2,fs.readFileSync(${JSON.stringify(join(dir, 'stderr.txt'))}));setTimeout(()=>{},${sleepMs});`, { mode: 0o700 });
  process.env.PATH = dir + ':' + previous;
  const kills: string[] = [];
  const agents: ReturnType<typeof startCliAgent>[] = [];
  const store = new TaskStore(join(dir,'weaver.db'));
  const manager = new TaskManager(store, { id: 'opencode', canLaunchReal: () => true, start: task => { const a = startCliAgent({ engine: 'opencode', model: 'opencode/glm-5.3-flash-free', effort: 'max', workspace: dir, stateDir: join(dir, 'state'), instruction: task.instruction }); const kill = a.kill.bind(a); a.kill = signal => { kills.push(String(signal ?? 'SIGTERM')); return kill(signal); }; agents.push(a); return a; } });
  const policy = new PolicyStore(join(dir,'weaver.db'));
  const handler = new CommandHandler(manager, policy);
  const task = manager.create({ title: 'rl', instruction: 'fake only', workspace: dir, owner: { name: 'o', transport: 'herdr-visible', session: 's', pane: 'p' } });
  task.dispatch = { execution: 'real', adapter: 'opencode', engineKind: 'opencode', engine: 'opencode', model: 'opencode/glm-5.3-flash-free', effort: 'max', owner: 'o', worker: 'w', maxParallel: 2, workspace: dir };
  store.put(task);
  manager.start(task.id);
  return { dir, kills, agents, store, policy, handler, id: task.id, done: async () => { handler.draining = true; for (const a of agents) { const closed = new Promise(r => a.once('close', r)); try { process.kill(a.pid!, 'SIGKILL'); await Promise.race([closed, new Promise(r => setTimeout(r, 3000))]); } catch {} } await new Promise(r => setTimeout(r, 100)); process.env.PATH = previous; rmSync(dir, { recursive: true, force: true }); } };
}
async function until(cond: () => boolean, ms = 8000) { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 25)); }

test('opencode rate-limit sample on stderr fails the attempt, blocks the engine and stops the scope', async () => {
  const h = await run(SAMPLE);
  try {
    await until(() => h.store.get(h.id).status === 'failed');
    const failure = h.store.get(h.id).failure;
    assert.equal(h.store.get(h.id).status, 'failed');
    assert.equal(failure?.kind, 'rate_limit');
    assert.match(failure?.message ?? '', /Rate limit exceeded/);
    assert.match(failure?.vendorError ?? '', /Rate limit exceeded/);
    h.handler.pump();
    const block = h.policy.snapshot().blocks.find(b => b.engine === 'opencode');
    assert.equal(block?.by, 'weaver-vendor-limit');
    assert.match(block?.reason ?? '', /Rate limit/);
    const delta = Date.parse(block!.release_at!) - Date.now();
    assert.ok(delta > 9 * 60000 && delta <= 10 * 60000, String(delta));
    // The failure must ask the owned scope to stop (the fake systemctl cannot really stop it).
    assert.ok(h.kills.length >= 1, 'scope kill requested');
  } finally { await h.done(); }
});

test('generic AI_APICallError and non-limit ERROR lines never fail the attempt or block the engine', async () => {
  assert.equal(classifyVendorError('opencode', API_ERROR), undefined);
  assert.equal(classifyVendorError('opencode', 'AI_APICallError: Internal server error'), undefined);
  assert.equal(classifyVendorError('opencode', 'AI_APICallError: Rate limit exceeded. Please try again later.')?.kind, 'rate_limit');
  assert.equal(classifyVendorError('opencode', 'AI_APICallError: FreeUsageLimitError')?.kind, 'quota');
  const h = await run(API_ERROR);
  try {
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(h.store.get(h.id).status, 'running');
    assert.equal(h.store.get(h.id).failure, undefined);
    h.handler.pump();
    assert.equal(h.policy.snapshot().blocks.length, 0);
    h.store.get(h.id);
  } finally { await h.done(); }
});
