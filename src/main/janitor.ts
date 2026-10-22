import { lstat, readdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { JanitorSweepEntry, JanitorSweepResult, JanitorSweepSummary, JanitorStatus } from '../shared/contracts/janitor';
import type { JanitorSettings } from '../shared/contracts/policy';
import { JANITOR_DEFAULTS, janitorSettings } from '../shared/policy/settings';

/**
 * Directory names Weaver itself creates under the OS temp root. Deliberately narrow: a plain
 * `weaver-` prefix is where people and agents keep task scratch, so only the dedicated
 * short test/runtime prefixes are cleaned. Tests use `wv-`; the other entries are reserved
 * for Weaver-owned scratch that may appear in future or older builds.
 */
export const JANITOR_PREFIXES = ['wv-', 'weaver-cli-', 'weaver-policy-', 'weaver-owner-'] as const;

const HOUR_MS = 3_600_000;
/** How many candidate entries one record keeps; older sweeps are pruned in storage. */
export const JANITOR_ENTRY_LIMIT = 1_000;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_QUIET_MS = 300;
const DEFAULT_SETTLE_TIMEOUT_MS = 30_000;
const DEFAULT_WATCH_MS = 60_000;

type ProcessCheck = 'linux' | 'skipped' | 'unavailable';

interface ProcessUse { path: string; pid: number; kind: 'cwd' | 'fd' }

export interface JanitorStore {
  load(): JanitorSweepResult[];
  save(result: JanitorSweepResult): void;
}

export interface JanitorOptions {
  /** The directory whose direct children are candidates. Defaults to os.tmpdir(). Tests inject an isolated root. */
  tmpRoot?: string;
  prefixes?: readonly string[];
  /** Owner uid candidates must match. Defaults to the current process uid when the platform exposes one. */
  uid?: number | null;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Data directories of running Weaver runtimes in this process; the /proc check covers other processes. */
  activeDataDirs?: () => Iterable<string>;
  settings?: () => JanitorSettings;
  store?: JanitorStore;
  log?: (message: string) => void;
  /** Test hooks for the schedule and the stale threshold; production uses the policy values. */
  ttlMs?: number;
  intervalMs?: number;
  watchIntervalMs?: number;
  maxDepth?: number;
  maxEntries?: number;
  procRoot?: string;
}

interface TreeState {
  mtimeMs: number;
  bytes: number;
  files: number;
  missing?: boolean;
  problem?: 'too-large' | 'too-deep' | 'unreadable';
  problemPath?: string;
}

function within(candidate: string, target: string): boolean {
  return target === candidate || target.startsWith(candidate + sep);
}

function stripDeleted(target: string): string {
  return target.endsWith(' (deleted)') ? target.slice(0, -' (deleted)'.length) : target;
}

/** Read cwd and open-file targets once, so every candidate is checked against the same live snapshot. */
async function processUses(procRoot: string): Promise<{ uses: ProcessUse[]; check: ProcessCheck }> {
  let pids: string[];
  try { pids = await readdir(procRoot); }
  catch { return { uses: [], check: 'unavailable' }; }
  const uses: ProcessUse[] = [];
  for (const name of pids) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const base = join(procRoot, name);
    const cwd = await readlink(join(base, 'cwd')).catch(() => undefined);
    if (cwd) uses.push({ path: stripDeleted(cwd), pid, kind: 'cwd' });
    let fds: string[];
    try { fds = await readdir(join(base, 'fd')); }
    catch { continue; }
    for (const fd of fds) {
      const target = await readlink(join(base, 'fd', fd)).catch(() => undefined);
      if (target) uses.push({ path: stripDeleted(target), pid, kind: 'fd' });
    }
  }
  return { uses, check: 'linux' };
}

/**
 * The newest mtime under one candidate plus a bounded size/count fingerprint. Symlinks are
 * lstat'ed but never entered, and a tree beyond the entry/depth bound is reported instead of
 * being treated as stale.
 */
async function treeState(root: string, maxDepth: number, maxEntries: number): Promise<TreeState> {
  let rootInfo;
  try { rootInfo = await lstat(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mtimeMs: 0, bytes: 0, files: 0, missing: true }; return { mtimeMs: 0, bytes: 0, files: 0, problem: 'unreadable' }; }
  if (rootInfo.isSymbolicLink()) return { mtimeMs: rootInfo.mtimeMs, bytes: rootInfo.size, files: 1, problem: 'unreadable', problemPath: root };
  const state: TreeState = { mtimeMs: rootInfo.mtimeMs, bytes: rootInfo.size, files: 1 };
  const stack: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  let seen = 1;
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try { entries = await readdir(current.path, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { ...state, problem: 'unreadable', problemPath: current.path };
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > maxEntries) return { ...state, problem: 'too-large', problemPath: current.path };
      const path = join(current.path, entry.name);
      let info;
      try { info = await lstat(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return { ...state, problem: 'unreadable', problemPath: path };
      }
      state.mtimeMs = Math.max(state.mtimeMs, info.mtimeMs);
      state.bytes += info.size;
      state.files += 1;
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (current.depth + 1 >= maxDepth) return { ...state, problem: 'too-deep', problemPath: path };
        stack.push({ path, depth: current.depth + 1 });
      }
    }
  }
  return state;
}

function ageText(ageMs: number): string {
  const hours = ageMs / HOUR_MS;
  return hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.max(0, Math.round(ageMs / 60_000))}m`;
}

/**
 * Wait until a dev cache tree stops changing. Vite's dependency optimizer closes without awaiting
 * its in-flight Rolldown write, so `vite.close()` can resolve while files are still landing; removing
 * the data directory at that point leaves the optimizer to recreate a partial `vite/deps_temp_*`
 * tree afterwards. The cache is written only by that optimizer, so a quiet tree means its write is done.
 */
export async function waitForTreeQuiet(root: string, options: { pollMs?: number; quietMs?: number; timeoutMs?: number; maxDepth?: number; maxEntries?: number } = {}): Promise<boolean> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
  let previous = await treeState(root, options.maxDepth ?? DEFAULT_MAX_DEPTH, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  if (previous.missing) return true;
  let stableSince = Date.now();
  for (;;) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, pollMs));
    const current = await treeState(root, options.maxDepth ?? DEFAULT_MAX_DEPTH, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    if (current.missing) return true;
    if (current.mtimeMs !== previous.mtimeMs || current.bytes !== previous.bytes || current.files !== previous.files) {
      previous = current;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= quietMs) return true;
  }
}

/** Remove unfinished optimizer processing directories after the cache has gone quiet. Symlinks are skipped. */
export async function removeViteTempDirs(cacheDir: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(cacheDir, { withFileTypes: true }); }
  catch { return []; }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!/^deps(?:_.+)?_temp_/.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const path = join(cacheDir, entry.name);
    try { await rm(path, { recursive: true, force: true }); removed.push(path); }
    catch { /* A concurrent cleanup or a still-open file keeps the rest for the janitor. */ }
  }
  return removed;
}

/**
 * Tracks Vite's dependency-optimizer builds. `vite.close()` asks the optimizer to cancel but does not
 * await an in-flight Rolldown write, so the cache can keep growing after close resolves. These hooks
 * let the runtime wait for that write to finish before the data directory is removed.
 */
export interface ViteOptimizerTracker {
  readonly plugin: { name: string; buildStart(): void; closeBundle(): void };
  active(): number;
  builds(): number;
  waitForStart(timeoutMs: number): Promise<boolean>;
  waitForIdle(options?: { pollMs?: number; quietMs?: number; timeoutMs?: number }): Promise<boolean>;
}

export function createViteOptimizerTracker(): ViteOptimizerTracker {
  let active = 0;
  let total = 0;
  const tracker: ViteOptimizerTracker = {
    plugin: {
      name: 'weaver-optimizer-settle',
      buildStart() { active += 1; total += 1; },
      closeBundle() { if (active > 0) active -= 1; },
    },
    active: () => active,
    builds: () => total,
    async waitForStart(timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      if (active > 0) return true;
      while (Date.now() < deadline) {
        await new Promise(resolveTimeout => setTimeout(resolveTimeout, 25));
        if (active > 0) return true;
      }
      return false;
    },
    async waitForIdle(options: { pollMs?: number; quietMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
      const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
      const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
      const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
      let stableSince = active === 0 ? Date.now() : null;
      for (;;) {
        if (active > 0) stableSince = null;
        else if (stableSince === null) stableSince = Date.now();
        else if (Date.now() - stableSince >= quietMs) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(resolveTimeout => setTimeout(resolveTimeout, pollMs));
      }
    },
  };
  return tracker;
}

/**
 * The runtime's source-side fix for the Vite cache race: close first, wait for any optimizer write
 * that close left running, then drop partial `deps_temp_*` caches. A pending dependency scan can
 * start its build shortly after close, so give it a bounded window to appear before deciding.
 */
export async function settleViteCache(
  cacheDir: string | undefined,
  options: { tracker?: ViteOptimizerTracker; startGraceMs?: number; log?: (message: string) => void } = {},
): Promise<void> {
  if (!cacheDir) return;
  const log = options.log ?? (() => {});
  const tracker = options.tracker;
  if (tracker) {
    const started = tracker.builds() > 0 || await tracker.waitForStart(options.startGraceMs ?? 1_500);
    if (started) {
      const idle = await tracker.waitForIdle();
      if (!idle) { log(`dev optimizer did not go idle; leaving late writes to the temp janitor`); return; }
    }
  }
  const quiet = await waitForTreeQuiet(cacheDir);
  if (!quiet) { log(`dev cache ${cacheDir} did not settle; leaving late writes to the temp janitor`); return; }
  const removed = await removeViteTempDirs(cacheDir);
  if (removed.length) log(`removed ${removed.length} unfinished dev cache director${removed.length === 1 ? 'y' : 'ies'}`);
}

/**
 * Periodic cleanup of stale Weaver-owned temp directories. The sweep is deliberately conservative:
 * a candidate must match an allow-listed prefix, be a real directory owned by the current uid, be
 * unused by any live process (or any runtime data directory), and have a newest recursive mtime
 * older than the TTL. Symlinks are never followed or removed.
 */
export class TempJanitor {
  private readonly tmpRoot: string;
  private readonly prefixes: string[];
  private readonly uid: number | null;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly activeDataDirs: () => Iterable<string>;
  private readonly settingsOf: () => JanitorSettings;
  private readonly store?: JanitorStore;
  private readonly log: (message: string) => void;
  private readonly ttlOverride?: number;
  private readonly intervalOverride?: number;
  private readonly watchMs: number;
  private readonly maxDepth: number;
  private readonly maxEntries: number;
  private readonly procRoot: string;
  private timer?: NodeJS.Timeout;
  private running = false;
  private started = false;
  private nextSweepAt: number | null = null;
  private lastSweepAt: number | null = null;
  private readonly localHistory: JanitorSweepResult[] = [];

  constructor(options: JanitorOptions = {}) {
    this.tmpRoot = resolve(options.tmpRoot ?? tmpdir());
    this.prefixes = (options.prefixes ?? JANITOR_PREFIXES).filter(prefix => typeof prefix === 'string' && prefix.length >= 2);
    this.uid = options.uid === undefined ? (typeof process.getuid === 'function' ? process.getuid() : null) : options.uid;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => Date.now());
    this.activeDataDirs = options.activeDataDirs ?? (() => []);
    this.settingsOf = options.settings ?? (() => ({ ...JANITOR_DEFAULTS }));
    this.store = options.store;
    this.log = options.log ?? (() => {});
    this.ttlOverride = options.ttlMs;
    this.intervalOverride = options.intervalMs;
    this.watchMs = options.watchIntervalMs ?? DEFAULT_WATCH_MS;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.procRoot = options.procRoot ?? '/proc';
  }

  /** Run at startup, then keep an interval that follows the current policy settings. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastSweepAt = null;
    this.schedule(0);
  }

  stop(): void {
    this.started = false;
    this.nextSweepAt = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.tick(); }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  /** Wake at least once a minute so a policy edit (disable or a new interval) is honored promptly. */
  private scheduleCheck(): void {
    const waitMs = Math.min(this.watchMs, this.intervalMs());
    if (this.lastSweepAt === null) { this.nextSweepAt = this.now(); this.schedule(0); return; }
    this.nextSweepAt = this.lastSweepAt + this.intervalMs();
    this.schedule(Math.max(0, Math.min(waitMs, this.nextSweepAt - this.now())));
  }

  private intervalMs(): number {
    const hours = this.settingsOf().interval_hours;
    return this.intervalOverride ?? (Number.isFinite(hours) ? Math.max(1, hours) : JANITOR_DEFAULTS.interval_hours) * HOUR_MS;
  }

  private ttlMs(): number {
    const hours = this.settingsOf().ttl_hours;
    return this.ttlOverride ?? (Number.isFinite(hours) ? Math.max(1, hours) : JANITOR_DEFAULTS.ttl_hours) * HOUR_MS;
  }

  private async tick(): Promise<void> {
    if (!this.started) return;
    if (this.running) { this.schedule(1_000); return; }
    const settings = this.settingsOf();
    if (!settings.enabled) {
      // A policy save can re-enable cleanup without a restart; check back cheaply instead of sweeping.
      this.nextSweepAt = null;
      this.schedule(this.watchMs);
      return;
    }
    if (this.lastSweepAt !== null && this.now() < this.lastSweepAt + this.intervalMs()) { this.scheduleCheck(); return; }
    try { await this.sweep(); }
    catch (error) { this.log(`sweep failed: ${error instanceof Error ? error.message : String(error)}`); }
    this.scheduleCheck();
  }

  /** Sweep now. `dryRun` reports the same decisions without deleting anything. On demand this ignores `enabled`. */
  async sweep(options: { dryRun?: boolean } = {}): Promise<JanitorSweepResult> {
    if (this.running) throw new Error('A janitor sweep is already running');
    this.running = true;
    const now = this.now();
    const ttlMs = this.ttlMs();
    const dryRun = options.dryRun === true;
    const entries: JanitorSweepEntry[] = [];
    let scanned = 0;
    let removed = 0;
    let removable = 0;
    let skipped = 0;
    let failed = 0;
    let omitted = 0;
    const record = (entry: JanitorSweepEntry) => {
      if (entries.length >= JANITOR_ENTRY_LIMIT) { omitted += 1; return; }
      entries.push(entry);
    };
    try {
      const processState = this.platform === 'linux' ? await processUses(this.procRoot) : { uses: [], check: 'skipped' as const };
      const active = [...this.activeDataDirs()].map(path => resolve(path));
      let names: string[];
      try { names = await readdir(this.tmpRoot); }
      catch (error) {
        const result: JanitorSweepResult = {
          version: 1, startedAt: new Date(now).toISOString(), finishedAt: new Date(this.now()).toISOString(),
          dryRun, tmpRoot: this.tmpRoot, prefixes: [...this.prefixes], ttlMs, scanned: 0, removed: 0, skipped: 0, failed: 0,
          entries: [], omitted: 0,
        };
        this.log(`cannot read ${this.tmpRoot}: ${error instanceof Error ? error.message : String(error)}`);
        this.persist(result);
        return result;
      }
      for (const name of names.sort()) {
        const prefix = this.prefixes.find(item => name.startsWith(item));
        if (!prefix) continue;
        scanned += 1;
        const path = join(this.tmpRoot, name);
        let info;
        try { info = await lstat(path); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const entry: JanitorSweepEntry = { name, path, action: 'skipped', code: code === 'ENOENT' ? 'gone' : 'unreadable', reason: code === 'ENOENT' ? 'disappeared during the sweep' : `could not stat: ${error instanceof Error ? error.message : String(error)}`, newestMtime: null, ageMs: null };
          skipped += 1; record(entry); continue;
        }
        const skip = (code: string, reason: string, newestMtime: string | null = null, ageMs: number | null = null) => {
          skipped += 1;
          record({ name, path, action: 'skipped', code, reason, newestMtime, ageMs });
        };
        if (info.isSymbolicLink()) { skip('symlink', 'symbolic links are never followed or removed'); continue; }
        if (!info.isDirectory()) { skip('not-directory', 'only directories are cleaned'); continue; }
        if (this.uid !== null && info.uid !== this.uid) { skip('foreign-owner', `owned by uid ${info.uid}, not the current uid ${this.uid}`); continue; }
        if (active.some(dir => within(path, dir) || within(dir, path))) { skip('active-data-dir', 'it is a running Weaver data directory'); continue; }
        if (processState.check === 'unavailable') { skip('process-check-unavailable', '/proc could not be read, so live-process use cannot be ruled out'); continue; }
        const use = processState.uses.find(item => within(path, item.path));
        if (use) { skip('in-use', `used by live process ${use.pid} (${use.kind === 'cwd' ? 'working directory' : 'open file'})`); continue; }
        const state = await treeState(path, this.maxDepth, this.maxEntries);
        if (state.problem) {
          skip(state.problem, state.problem === 'too-large' ? `more than ${this.maxEntries} entries, left for manual review`
            : state.problem === 'too-deep' ? `deeper than ${this.maxDepth} levels, left for manual review`
            : `could not read ${state.problemPath ?? 'the tree'}`, null, null);
          continue;
        }
        const ageMs = now - state.mtimeMs;
        const newestMtime = new Date(state.mtimeMs).toISOString();
        if (ageMs < ttlMs) { skip('fresh', `newest mtime is ${ageText(Math.max(0, ageMs))} old, below the ${ageText(ttlMs)} TTL`, newestMtime, Math.max(0, ageMs)); continue; }
        if (dryRun) {
          removable += 1;
          record({ name, path, action: 'would-remove', code: 'stale', reason: `stale for ${ageText(ageMs)} and unused`, newestMtime, ageMs });
          continue;
        }
        const recheck = await treeState(path, this.maxDepth, this.maxEntries);
        if (recheck.problem || recheck.missing || recheck.mtimeMs !== state.mtimeMs || recheck.bytes !== state.bytes || recheck.files !== state.files) {
          skip('changed', 'the directory changed while the sweep was deciding', newestMtime, ageMs);
          continue;
        }
        try {
          const still = await lstat(path);
          if (!still.isDirectory() || still.isSymbolicLink()) { skip('changed', 'the directory was replaced during the sweep', newestMtime, ageMs); continue; }
          await rm(path, { recursive: true, force: false });
          removed += 1;
          record({ name, path, action: 'removed', code: 'stale', reason: `stale for ${ageText(ageMs)} and unused`, newestMtime, ageMs });
        } catch (error) {
          failed += 1;
          record({ name, path, action: 'failed', code: 'remove-failed', reason: error instanceof Error ? error.message : String(error), newestMtime, ageMs });
        }
      }
    } finally {
      this.running = false;
    }
    const result: JanitorSweepResult = {
      version: 1,
      startedAt: new Date(now).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
      dryRun, tmpRoot: this.tmpRoot, prefixes: [...this.prefixes], ttlMs,
      scanned, removed: dryRun ? removable : removed,
      skipped, failed, entries, omitted,
    };
    this.lastSweepAt = this.now();
    this.persist(result);
    this.log(`${dryRun ? 'dry run: ' : ''}${result.removed} removable, ${skipped} skipped, ${failed} failed of ${scanned} candidate(s) under ${this.tmpRoot}`);
    return result;
  }

  status(): JanitorStatus {
    let records: JanitorSweepResult[];
    try { records = this.store ? this.store.load() : [...this.localHistory].reverse(); }
    catch (error) {
      this.log(`sweep history could not be read: ${error instanceof Error ? error.message : String(error)}`);
      records = [...this.localHistory].reverse();
    }
    // Keep the IPC response inside its frame budget: the newest record is always complete, older ones
    // fall back to a summary once their entries would no longer fit.
    let budget = 600 * 1024;
    const history: (JanitorSweepResult | JanitorSweepSummary)[] = records.map((record, index) => {
      const size = JSON.stringify(record).length;
      if (index === 0 || size <= budget) { budget -= size; return record; }
      return { summary: true, startedAt: record.startedAt, finishedAt: record.finishedAt, dryRun: record.dryRun, tmpRoot: record.tmpRoot, scanned: record.scanned, removed: record.removed, skipped: record.skipped, failed: record.failed, omitted: record.omitted };
    });
    return {
      settings: this.settingsOf(),
      started: this.started,
      nextSweepAt: this.nextSweepAt === null ? null : new Date(this.nextSweepAt).toISOString(),
      history,
    };
  }

  private persist(result: JanitorSweepResult): void {
    this.localHistory.push(result);
    if (this.localHistory.length > 50) this.localHistory.shift();
    try { this.store?.save(result); }
    catch (error) { this.log(`sweep record could not be saved: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
