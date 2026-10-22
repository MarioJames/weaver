import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, lutimes, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  JANITOR_PREFIXES, TempJanitor, createViteOptimizerTracker, removeViteTempDirs, waitForTreeQuiet,
  type JanitorStore,
} from '../../src/main/janitor';
import type { JanitorSweepResult } from '../../src/shared/contracts/janitor';
import type { JanitorSettings } from '../../src/shared/contracts/policy';
import { JANITOR_DEFAULTS, janitorSettings } from '../../src/shared/policy/settings';
import { defaultConfig, validateConfig } from '../../src/main/policy/routing';
import { PolicyStore } from '../../src/main/policy/store';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-22T00:00:00Z');

function memoryStore(): JanitorStore & { runs: JanitorSweepResult[] } {
  const runs: JanitorSweepResult[] = [];
  return { runs, load: () => [...runs].reverse(), save: result => { runs.push(result); } };
}

async function rootFor(t: { after(fn: () => Promise<void> | void): void }): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wv-janitor-root-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function setAge(path: string, at: number): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await setAge(join(path, entry.name), at);
    else if (!entry.isSymbolicLink()) await utimes(join(path, entry.name), new Date(at), new Date(at));
  }
  await utimes(path, new Date(at), new Date(at));
}

async function staleDir(root: string, name: string, now: number, ageMs = 25 * HOUR, nested = true): Promise<string> {
  const path = join(root, name);
  await mkdir(path);
  if (nested) await writeFile(join(path, 'cache.txt'), 'x'.repeat(64));
  await setAge(path, now - ageMs);
  return path;
}

function options(root: string, overrides: {
  settings?: () => JanitorSettings;
  store?: JanitorStore;
  now?: () => number;
  activeDataDirs?: () => Iterable<string>;
  platform?: NodeJS.Platform;
  uid?: number | null;
  ttlMs?: number;
  intervalMs?: number;
  watchIntervalMs?: number;
} = {}) {
  const store = overrides.store ?? memoryStore();
  return {
    store,
    janitor: new TempJanitor({
      tmpRoot: root,
      prefixes: JANITOR_PREFIXES,
      uid: overrides.uid === undefined ? (typeof process.getuid === 'function' ? process.getuid() : null) : overrides.uid,
      platform: overrides.platform ?? process.platform,
      now: overrides.now ?? (() => NOW),
      ttlMs: overrides.ttlMs,
      intervalMs: overrides.intervalMs,
      watchIntervalMs: overrides.watchIntervalMs,
      activeDataDirs: overrides.activeDataDirs,
      settings: overrides.settings ?? (() => ({ ...JANITOR_DEFAULTS })),
      store,
    }),
  };
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('janitor defaults and allow-list stay narrow', () => {
  assert.deepEqual(janitorSettings({}), { enabled: true, ttl_hours: 24, interval_hours: 6 });
  assert.deepEqual(janitorSettings({ janitor: { enabled: false, ttl_hours: 2, interval_hours: 1 } }), { enabled: false, ttl_hours: 2, interval_hours: 1 });
  for (const prefix of ['wv-', 'weaver-cli-', 'weaver-policy-', 'weaver-owner-']) assert.ok((JANITOR_PREFIXES as readonly string[]).includes(prefix), prefix);
  assert.equal((JANITOR_PREFIXES as readonly string[]).includes('weaver-'), false, 'plain weaver- task scratch is not ours to delete');
});

test('janitor settings round-trip through the policy store and invalid ranges are rejected', async t => {
  const config = defaultConfig();
  assert.deepEqual(validateConfig(config), []);
  assert.deepEqual(config.janitor, { enabled: true, ttl_hours: 24, interval_hours: 6 });
  config.janitor = { enabled: true, ttl_hours: 0, interval_hours: 0 };
  assert.deepEqual(validateConfig(config).map(issue => issue.path).sort(), ['$.janitor.interval_hours', '$.janitor.ttl_hours']);
  const root = await rootFor(t);
  const store = new PolicyStore(join(root, 'weaver.db'));
  const saved = structuredClone(store.snapshot().config);
  saved.janitor = { enabled: false, ttl_hours: 2, interval_hours: 1 };
  store.save({ revision: 0, config: saved, blocks: [] });
  assert.deepEqual(store.snapshot().config.janitor, { enabled: false, ttl_hours: 2, interval_hours: 1 });
});

test('a sweep removes only allow-listed, own, stale, unused directories and never follows symlinks', async t => {
  const root = await rootFor(t);
  const outside = join(root, 'outside-target');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'keep');
  await utimes(outside, new Date(NOW - 25 * HOUR), new Date(NOW - 25 * HOUR));

  const stale = await staleDir(root, 'wv-old', NOW);
  const fresh = await staleDir(root, 'wv-fresh', NOW, 1 * HOUR);
  const foreign = await staleDir(root, 'weaver-scratch', NOW);
  const active = await staleDir(root, 'wv-active', NOW);
  const link = join(root, 'wv-link');
  await symlink(outside, link, 'dir');
  const insideLink = join(stale, 'outside-link');
  await symlink(outside, insideLink, 'dir');
  await lutimes(insideLink, new Date(NOW - 25 * HOUR), new Date(NOW - 25 * HOUR));
  await utimes(stale, new Date(NOW - 25 * HOUR), new Date(NOW - 25 * HOUR));
  const broken = join(root, 'wv-broken');
  await symlink(join(root, 'missing'), broken, 'dir');

  const store = memoryStore();
  const { janitor } = options(root, { store, activeDataDirs: () => [active] });
  const result = await janitor.sweep();

  assert.equal(existsSync(stale), false, 'stale, owned, unused directory is removed');
  for (const kept of [fresh, foreign, active, outside]) assert.equal(existsSync(kept), true, `${kept} must stay`);
  assert.equal(existsSync(link), true, 'a symlink is never removed');
  assert.equal((await lstat(broken)).isSymbolicLink(), true, 'a broken symlink is never followed or removed');
  assert.equal(existsSync(outside), true, 'a symlink inside a removed tree never deletes its target');

  const byName = new Map(result.entries.map(entry => [entry.name, entry]));
  assert.equal(byName.get('wv-old')?.action, 'removed');
  assert.equal(byName.get('wv-fresh')?.code, 'fresh');
  assert.equal(byName.get('wv-active')?.code, 'active-data-dir');
  assert.equal(byName.get('wv-link')?.code, 'symlink');
  assert.equal(byName.has('weaver-scratch'), false, 'foreign prefixes are not candidates');
  assert.equal(result.removed, 1);
  assert.equal(result.scanned, 5);
  assert.equal(store.runs.length, 1);
  assert.deepEqual(janitor.status().history.map(item => item.finishedAt), [result.finishedAt]);
});

test('dry run reports removals without deleting and is recorded', async t => {
  const root = await rootFor(t);
  const stale = await staleDir(root, 'wv-dry', NOW);
  const store = memoryStore();
  const { janitor } = options(root, { store });
  const dry = await janitor.sweep({ dryRun: true });
  assert.equal(existsSync(stale), true, 'dry run deletes nothing');
  assert.equal(dry.dryRun, true);
  assert.equal(dry.removed, 1);
  assert.equal(dry.entries.find(entry => entry.name === 'wv-dry')?.action, 'would-remove');
  const real = await janitor.sweep();
  assert.equal(existsSync(stale), false);
  assert.equal(real.removed, 1);
  assert.deepEqual(store.runs.map(item => item.dryRun), [true, false]);
});

test('a directory owned by another uid is kept', async t => {
  const root = await rootFor(t);
  const stale = await staleDir(root, 'wv-other-owner', NOW);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const { janitor } = options(root, { uid: uid + 1 });
  const result = await janitor.sweep();
  assert.equal(existsSync(stale), true);
  assert.equal(result.entries.find(entry => entry.name === 'wv-other-owner')?.code, 'foreign-owner');
});

test('TTL comes from settings and a future or fresh mtime is kept', async t => {
  const root = await rootFor(t);
  const stale = await staleDir(root, 'wv-three-hours', NOW, 3 * HOUR);
  const fresh = await staleDir(root, 'wv-one-hour', NOW, 1 * HOUR);
  const future = await staleDir(root, 'wv-future', NOW, -2 * HOUR);
  const { janitor } = options(root, { settings: () => ({ enabled: true, ttl_hours: 2, interval_hours: 1 }) });
  const result = await janitor.sweep();
  assert.equal(existsSync(stale), false, 'older than the configured 2 hour TTL is removed');
  assert.equal(existsSync(fresh), true, 'newer than the TTL is kept');
  assert.equal(existsSync(future), true, 'a future mtime is not stale');
  assert.equal(result.entries.find(entry => entry.name === 'wv-one-hour')?.code, 'fresh');
});

test('unreadable or over-bounded trees are left for manual review', async t => {
  const root = await rootFor(t);
  const deep = await staleDir(root, 'wv-large', NOW, 25 * HOUR, false);
  for (let i = 0; i < 6; i++) await writeFile(join(deep, `f-${i}`), 'x');
  await setAge(deep, NOW - 25 * HOUR);
  const janitorWithBounds = new TempJanitor({
    tmpRoot: root, prefixes: ['wv-'], uid: typeof process.getuid === 'function' ? process.getuid() : null,
    platform: process.platform, now: () => NOW, ttlMs: 24 * HOUR, maxEntries: 3,
  });
  const result = await janitorWithBounds.sweep();
  assert.equal(existsSync(deep), true);
  assert.equal(result.entries.find(entry => entry.name === 'wv-large')?.code, 'too-large');
});

test('the scheduler honors enabled, disable and the configured interval', async t => {
  const root = await rootFor(t);
  const enabledStore = memoryStore();
  const enabled = options(root, { store: enabledStore, platform: 'win32', settings: () => ({ enabled: true, ttl_hours: 24, interval_hours: 6 }), now: () => Date.now(), intervalMs: 25, watchIntervalMs: 10 });
  enabled.janitor.start();
  try { await delay(220); } finally { enabled.janitor.stop(); }
  assert.ok(enabledStore.runs.length >= 2, `expected repeated sweeps, got ${enabledStore.runs.length}`);
  assert.equal(enabled.janitor.status().started, false);

  const kept = await staleDir(root, 'wv-disabled-stale', NOW);
  const disabledStore = memoryStore();
  const disabled = options(root, { store: disabledStore, settings: () => ({ enabled: false, ttl_hours: 24, interval_hours: 6 }), now: () => Date.now(), intervalMs: 25, watchIntervalMs: 10 });
  disabled.janitor.start();
  try { await delay(80); } finally { disabled.janitor.stop(); }
  assert.equal(disabledStore.runs.length, 0, 'disabled cleanup sweeps nothing');
  assert.equal(existsSync(kept), true, 'a stale directory survives while cleanup is disabled');
});

test('a directory in use by a live cwd or open file is kept', { skip: process.platform !== 'linux' }, async t => {
  const root = await rootFor(t);
  const cwdDir = await staleDir(root, 'wv-busy-cwd', NOW);
  const fdDir = await staleDir(root, 'wv-busy-fd', NOW);
  const openFile = join(fdDir, 'open.txt');
  const children: ChildProcess[] = [];
  t.after(() => { for (const child of children) child.kill('SIGKILL'); });
  const cwdChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: cwdDir, stdio: 'ignore' });
  const fdChild = spawn(process.execPath, ['-e', 'require("node:fs").openSync(process.argv[1], "a"); setTimeout(() => {}, 60000)', openFile], { stdio: 'ignore' });
  children.push(cwdChild, fdChild);
  assert.ok(cwdChild.pid && fdChild.pid);
  for (let i = 0; i < 100; i++) {
    const cwd = await readlink(`/proc/${cwdChild.pid}/cwd`).catch(() => '');
    const fds = await readdir(`/proc/${fdChild.pid}/fd`).catch(() => [] as string[]);
    let seesFile = false;
    for (const fd of fds) {
      const target = await readlink(`/proc/${fdChild.pid}/fd/${fd}`).catch(() => '');
      if (target === openFile) seesFile = true;
    }
    if (cwd === cwdDir && seesFile) break;
    await delay(20);
  }
  const { janitor } = options(root);
  const result = await janitor.sweep();
  assert.equal(existsSync(cwdDir), true, 'the cwd of a live process is kept');
  assert.equal(existsSync(fdDir), true, 'an open file target of a live process is kept');
  assert.equal(result.entries.find(entry => entry.name === 'wv-busy-cwd')?.code, 'in-use');
  assert.equal(result.entries.find(entry => entry.name === 'wv-busy-fd')?.code, 'in-use');
});

test('waitForTreeQuiet detects a late write and removeViteTempDirs only removes processing caches', async t => {
  const root = await rootFor(t);
  const cache = join(root, 'vite');
  await mkdir(join(cache, 'deps_temp_late'), { recursive: true });
  await writeFile(join(cache, 'deps_temp_late', 'a.js'), 'a');
  const writes = (async () => {
    await delay(80);
    await writeFile(join(cache, 'deps_temp_late', 'b.js'), 'b'.repeat(1024));
  })();
  assert.equal(await waitForTreeQuiet(cache, { pollMs: 20, quietMs: 100, timeoutMs: 2_000 }), true);
  await writes;
  const committed = join(cache, 'deps');
  await mkdir(committed, { recursive: true });
  await writeFile(join(committed, 'keep.js'), 'keep');
  const removed = await removeViteTempDirs(cache);
  assert.deepEqual(removed.map(path => basename(path)), ['deps_temp_late']);
  assert.equal(existsSync(join(committed, 'keep.js')), true, 'the committed cache is never removed');
  assert.equal(existsSync(join(cache, 'deps_temp_late')), false);
});

test('the optimizer tracker waits for an in-flight build', async () => {
  const tracker = createViteOptimizerTracker();
  assert.equal(await tracker.waitForStart(10), false);
  tracker.plugin.buildStart();
  assert.equal(tracker.active(), 1);
  const idle = tracker.waitForIdle({ pollMs: 10, quietMs: 30, timeoutMs: 1_000 });
  setTimeout(() => tracker.plugin.closeBundle(), 20);
  assert.equal(await idle, true);
  assert.equal(tracker.active(), 0);
});
