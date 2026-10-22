import { openSync, closeSync, readdirSync, readlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable as ReadableImpl } from 'node:stream';
import { readFileSync, statSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { isRealEngineKind } from '../../workspace';
import { cgroupPath, processTree, readProcessSnapshots, unitOfCgroup } from '../../monitors/process-tree';

const VERIFY_MS = 5000;
const TERM_GRACE_MS = 1500;

export interface OwnedScope extends EventEmitter {
  readonly unit: string;
  pid?: number;
  /**
   * Pipe-mode child streams. In file mode (§3.1) the service holds no read
   * end; these are inert already-ended streams carrying no data. Consumers
   * must read the log files instead. Kept required so existing pipe-mode
   * callers are unaffected.
   */
  stdout: Readable;
  stderr: Readable;
  /** Writable child stdin; only present when startOwnedScope was called with keepStdinOpen. */
  stdin?: Writable;
  kill(signal?: NodeJS.Signals): boolean;
  /**
   * Detach without signalling the scope: stop internal timers/polling,
   * unref the ChildProcess (and any stdio pipe handles) and release them so
   * the service event loop can empty, remove listeners, and never emit again.
   * The worker scope itself keeps running.
   */
  detach(): void;
}

/** File-mode log anchors for startOwnedScope (§3.1): pre-created log FDs whose
 * fstat identity was persisted before spawn. The parent closes its own FD
 * copies right after spawn; the shell keeps the write FDs for its lifetime. */
export interface FileScopeFiles {
  stdoutFd: number;
  stderrFd: number;
  exitPath: string;
  exitTmpPath: string;
  runId: string;
  nonce: string;
}

/**
 * Fixed sh wrapper (§3.2). The engine runs as a background job with stdin
 * explicitly preserved (`"$@" 0<&0 <&8 8<&- &`); the shell never execs the
 * engine, only installs no-op traps, loops `wait` until the real engine status
 * is observed, then publishes the exit record with tmp+rename. runId/nonce and
 * paths arrive via environment (WEAVER_RUN_ID/WEAVER_RUN_NONCE/
 * WEAVER_EXIT_FILE/WEAVER_EXIT_TMP), never interpolated into the script.
 * The pre-saved fd 8 carries the real stdin on every POSIX sh (dash assigns
 * /dev/null to an async command's fd 0 before applying redirections); it is
 * closed in the engine (`8<&-`) so it never leaks to the engine process, and
 * the shell's own copy is closed right after the background start.
 */
export const FILE_SCOPE_SHELL_SCRIPT = [
  "trap ':' TERM INT HUP",
  // Anchor stdin before backgrounding: dash assigns /dev/null to an async
  // command's fd 0 before applying redirections, so a bare `0<&0` would only
  // duplicate /dev/null there (bash tolerates it). The pre-saved fd 8
  // carries the real stdin on every POSIX sh; `0<&0` is kept per spec.
  'exec 8<&0',
  '"$@" 0<&0 <&8 8<&- &',
  'child=$!',
  'exec 8<&-',
  'code=0',
  'while :; do',
  '  wait $child && { code=$?; break; } || code=$?',
  '  if kill -0 $child 2>/dev/null; then',
  '    continue',
  '  else',
  '    wait $child 2>/dev/null',
  '    status=$?',
  '    [ $status -ne 127 ] && code=$status',
  '    break',
  '  fi',
  'done',
  'printf \'{"runId":"%s","nonce":"%s","pid":%s,"code":%s,"signal":null,"at":"%s"}\\n\' "$WEAVER_RUN_ID" "$WEAVER_RUN_NONCE" "$child" "$code" "$(date -u +%FT%TZ)" > "$WEAVER_EXIT_TMP"',
  'mv -f "$WEAVER_EXIT_TMP" "$WEAVER_EXIT_FILE"',
  'exit $code',
].join('\n');

interface ScopeInfo {
  id?: string;
  active?: string;
  invocation?: string;
  cgroup?: string;
  mainPid?: number;
}

function systemctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('systemctl', ['--user', ...args], { timeout: 8000, windowsHide: true }, (error, stdout, stderr) => {
      const status = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolve({ code: status, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function parseShow(text: string): ScopeInfo {
  const info: ScopeInfo = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index < 0) continue;
    const key = line.slice(0, index);
    const value = line.slice(index + 1).trim();
    if (key === 'Id') info.id = value;
    else if (key === 'ActiveState') info.active = value;
    else if (key === 'InvocationID' && value) info.invocation = value;
    else if (key === 'ControlGroup' && value) info.cgroup = value;
    else if (key === 'MainPID' && /^[1-9]\d*$/.test(value)) info.mainPid = Number(value);
  }
  return info;
}

async function showScope(unit: string): Promise<ScopeInfo | undefined> {
  const result = await systemctl(['show', `${unit}.scope`, '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'InvocationID', '-p', 'ControlGroup', '-p', 'MainPID', '--no-pager']);
  if (result.code !== 0) return undefined;
  if (/^LoadState=not-found$/m.test(result.stdout) || !result.stdout.trim()) return undefined;
  return parseShow(result.stdout);
}

function cgroup(pid: number | undefined): string {
  if (!pid) return '';
  try { return readFileSync(`/proc/${pid}/cgroup`, 'utf8'); } catch { return ''; }
}

/** Test seam: unit tests inject a fake ChildProcess without touching systemd. */
let spawnImplForTests: typeof spawn | undefined;
export function __setSpawnImplForTests(fn: typeof spawn | undefined): void {
  spawnImplForTests = fn;
}

function owns(unit: string, info: ScopeInfo | undefined, invocation: string | undefined, pid: number | undefined): boolean {
  const marker = `${unit}.scope`;
  const group = `${info?.cgroup ?? ''}\n${cgroup(pid)}`;
  if (info?.id !== marker && !group.includes(marker)) return false;
  if (invocation && info?.invocation && info.invocation !== invocation) return false;
  return true;
}

/** Recover a persisted schedule or CLI run scope. Failure to verify ownership fails closed.
 * Verify any existing invocation, then stop matching launchers before the final inspection.
 * A collected/inactive scope is already clean; active CLI scopes need their exact invocation. */
export async function recoverOwnedScope(unit: string, invocation?: string): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Cannot verify persisted schedule process identity');
  const cli = /^weaver-cli-([a-z0-9]+)-[0-9a-f]{8}$/.exec(unit);
  const schedule = /^weaver-schedule-[0-9a-f-]{36}$/.test(unit);
  if (!schedule && !(cli && isRealEngineKind(cli[1]!))) throw new Error('Cannot verify persisted schedule process identity');
  const inspect = async (): Promise<ScopeInfo | undefined> => {
    const result = await systemctl(['show', `${unit}.scope`, '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'InvocationID', '--no-pager']);
    if (/^LoadState=not-found$/m.test(result.stdout)) return undefined;
    if (result.code !== 0 || !result.stdout.trim()) throw new Error(`Cannot inspect schedule scope ${unit}; restore the systemd user session and retry recovery`);
    const info = parseShow(result.stdout);
    if (!info.active) throw new Error(`Cannot inspect schedule scope ${unit}; ActiveState is missing`);
    if (info.id !== `${unit}.scope`) throw new Error(`Schedule scope ${unit} identity changed; manual ownership inspection required`);
    return info;
  };
  const verify = (info: ScopeInfo | undefined): boolean => {
    if (!info || ['inactive','failed'].includes(info.active ?? '')) return false;
    if (invocation && info.invocation !== invocation) throw new Error(`Schedule scope ${unit} identity changed; manual ownership inspection required`);
    // A replacement can reuse the visible unit name. Without the persisted invocation
    // there is no proof this active scope belongs to the schedule run, so never kill it.
    if (cli && (!invocation || !info.invocation)) throw new Error(`CLI schedule scope ${unit} identity is missing; manual ownership inspection required`);
    return true;
  };
  // Reject a replaced active scope before touching its launcher or descendants.
  verify(await inspect());
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
      // Only the exact unit can be ours; a similar prefix never grants ownership.
      if (argv[0]?.split('/').at(-1) === 'systemd-run' && argv.includes(`--unit=${unit}`)) process.kill(Number(entry), 'SIGKILL');
    } catch { /* Process may have exited while enumerating. */ }
  }
  const info = await inspect();
  if (!verify(info)) return;
  const killed = await systemctl(['kill', '-s', 'SIGKILL', '--kill-whom=all', `${unit}.scope`]);
  if (killed.code !== 0) {
    // The scope can collect between the ownership check and kill. A missing or
    // inactive scope is already clean; anything still active remains unverified.
    if (!verify(await inspect())) return;
    throw new Error(`Could not terminate schedule scope ${unit}`);
  }
  await systemctl(['stop', `${unit}.scope`]);
  const after = await inspect();
  if (verify(after)) throw new Error(`Schedule scope ${unit} remains active`);
}


export interface EscapedCleanup {
  /** Exact foreign scope units stopped because every process in them belonged to this worker. */
  units: string[];
  /** Descendants stopped individually because their scope could not be proven to be wholly theirs. */
  pids: number[];
}

function userScope(path: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  return path.startsWith('/user.slice/') && (path.includes(`/user@${uid}.service/`) || path.includes(`/user-${uid}.slice/`));
}

/**
 * Find descendants that left the worker's cgroup through another systemd scope. A scope is stopped only when
 * every process in it is one of those descendants; otherwise only the exact descendant pids are signalled,
 * never an unrelated process that happens to share the scope.
 */
export async function cleanupEscapedDescendants(rootPid: number | undefined, ownUnit: string, remembered: ReadonlyMap<number, string> = new Map()): Promise<EscapedCleanup> {
  if (process.platform !== 'linux' || (!rootPid && remembered.size === 0)) return { units: [], pids: [] };
  const table = readProcessSnapshots();
  const own = ownUnit.replace(/\.scope$/, '');
  const tree = rootPid ? processTree(rootPid, table).filter(process => process.pid !== rootPid) : [];
  const paths = new Map(table.map(process => [process.pid, cgroupPath(process.pid)]));
  const units = new Map<string, number[]>();
  const loose = new Set<number>();
  const seen = new Set<number>();
  const remember = (pid: number, unit: string | null, path: string | null): void => {
    if (seen.has(pid) || !unit || unit === own) return;
    seen.add(pid);
    if (!path || !userScope(path)) { loose.add(pid); return; }
    const list = units.get(unit);
    if (list) list.push(pid);
    else units.set(unit, [pid]);
  };
  for (const process of tree) remember(process.pid, unitOfCgroup(paths.get(process.pid) ?? null), paths.get(process.pid) ?? null);
  // A command can outlive the worker root; a sweep recorded it while the tree was still reachable.
  for (const [pid, unit] of remembered) {
    const path = paths.get(pid);
    if (path !== undefined && unitOfCgroup(path) === unit) remember(pid, unit, path);
  }
  if (!tree.length && !seen.size) return { units: [], pids: [] };
  const desc = new Set([...tree.map(process => process.pid), ...seen]);
  const cleaned: EscapedCleanup = { units: [], pids: [] };
  for (const [unit, members] of units) {
    const all = table.filter(process => unitOfCgroup(paths.get(process.pid) ?? null) === unit).map(process => process.pid);
    if (all.length && all.every(pid => desc.has(pid))) {
      // A command that ignores SIGTERM must not hold task cancellation for systemd's stop timeout.
      const killed = await systemctl(['kill', '-s', 'SIGKILL', '--kill-whom=all', `${unit}.scope`]);
      const stopped = await systemctl(['stop', `${unit}.scope`]);
      // --collect can make the stop report "not loaded" after the kill already emptied the scope.
      if (killed.code === 0 || stopped.code === 0) {
        cleaned.units.push(`${unit}.scope`);
        cleaned.pids.push(...members);
        continue;
      }
    }
    for (const pid of members) loose.add(pid);
  }
  for (const pid of loose) {
    try { process.kill(pid, 'SIGTERM'); cleaned.pids.push(pid); } catch { /* already gone */ }
  }
  if (loose.size) {
    await new Promise(resolve => setTimeout(resolve, 300));
    for (const pid of loose) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  cleaned.pids = [...new Set(cleaned.pids)];
  return cleaned;
}

/**
 * Remember descendants that already moved to a foreign user scope while the
 * worker root is still reachable. Reattached runs have no Sweep timer from
 * startOwnedScope, so they keep this map themselves for the final cleanup.
 */
export function rememberEscapedDescendants(rootPid: number | undefined, ownUnit: string, into: Map<number, string>): void {
  if (!rootPid || process.platform !== 'linux') return;
  try {
    const table = readProcessSnapshots();
    const own = ownUnit.replace(/\.scope$/, '');
    for (const process of processTree(rootPid, table)) {
      if (process.pid === rootPid) continue;
      const path = cgroupPath(process.pid);
      const foreign = unitOfCgroup(path ?? null);
      if (foreign && foreign !== own && path && userScope(path)) into.set(process.pid, foreign);
    }
  } catch { /* the next sweep or the live tree at stop covers it */ }
}

/** Three-state scope inspection (§11.2): present / absent / unknown.
 * Mirrors the inspect precedent inside recoverOwnedScope: LoadState=not-found
 * is absent; systemctl failure/timeout/empty output/missing fields are
 * unknown and must never be folded into absent. */
export type ScopeInspection =
  | { state: 'present'; active: string; invocation?: string; cgroup?: string }
  | { state: 'absent' }
  | { state: 'unknown'; error: string };

async function showForInspect(unit: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return systemctl(['show', `${unit}.scope`, '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'InvocationID', '-p', 'ControlGroup', '--no-pager']);
}

export async function inspectScope(unit: string): Promise<ScopeInspection> {
  if (process.platform !== 'linux') return { state: 'unknown', error: 'Owned CLI scope requires Linux systemd user sessions' };
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await showForInspect(unit);
  } catch (error) {
    return { state: 'unknown', error: `systemctl show ${unit}.scope failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (/^LoadState=not-found$/m.test(result.stdout)) return { state: 'absent' };
  if (result.code !== 0 || !result.stdout.trim()) {
    return { state: 'unknown', error: `systemctl show ${unit}.scope failed (code ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 500)}` };
  }
  const info = parseShow(result.stdout);
  if (info.id !== `${unit}.scope`) return { state: 'unknown', error: `Scope ${unit} identity changed; manual ownership inspection required` };
  if (!info.active) return { state: 'unknown', error: `Cannot inspect scope ${unit}; ActiveState is missing` };
  return { state: 'present', active: info.active, ...(info.invocation ? { invocation: info.invocation } : {}), ...(info.cgroup ? { cgroup: info.cgroup } : {}) };
}

/** True launcher scan shared with recoverOwnedScope: exact `--unit=<unit>`
 * systemd-run processes still alive in /proc. */
function findScopeLauncher(unit: string): boolean {
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
        if (argv[0]?.split('/').at(-1) === 'systemd-run' && argv.includes(`--unit=${unit}`)) return true;
      } catch {
        /* Process may have exited while enumerating. */
      }
    }
  } catch {
    /* /proc unreadable counts as inconclusive; caller treats via inspect. */
  }
  return false;
}

/**
 * Convergent absence check (§11.2-9): inspect → /proc launcher scan →
 * inspect. Returns true only when both inspections are absent with no
 * launcher in between; any unknown yields 'unknown'.
 */
export async function confirmScopeAbsent(unit: string): Promise<boolean | 'unknown'> {
  const first = await inspectScope(unit);
  if (first.state === 'unknown') return 'unknown';
  if (first.state === 'present') return false;
  if (findScopeLauncher(unit)) return false;
  const second = await inspectScope(unit);
  if (second.state === 'unknown') return 'unknown';
  if (second.state === 'present') return false;
  return true;
}

function readStarttime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    // Fields after comm: state(1) ppid(2) ... starttime is #22 overall,
    // i.e. index 19 after comm.
    return afterComm[19];
  } catch {
    return undefined;
  }
}

function fdAccessWritable(flagsLine: string): boolean {
  const match = /^flags:\s*([0-7]+)/m.exec(flagsLine);
  if (!match) return false;
  const accmode = parseInt(match[1]!, 8) & 0o3;
  return accmode === 0o1 || accmode === 0o2;
}

function cgroupPids(cgroup: string): number[] {
  // ControlGroup looks like `0::/user.slice/...`; map onto /sys/fs/cgroup.
  const rel = cgroup.includes('::') ? cgroup.slice(cgroup.indexOf('::') + 2) : cgroup;
  const root = `/sys/fs/cgroup${rel.startsWith('/') ? rel : `/${rel}`}`;
  const pids: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = `${dir}/${entry}`;
      if (entry === 'cgroup.procs') {
        try {
          for (const line of readFileSync(full, 'utf8').split('\n')) {
            if (/^\d+$/.test(line.trim())) pids.push(Number(line.trim()));
          }
        } catch {
          /* cgroup may vanish mid-scan */
        }
      } else if (entry !== '.' && entry !== '..') {
        try {
          if (statSync(full).isDirectory()) stack.push(full);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return pids;
}

/**
 * Positive-only FD evidence (§11.4): look for the run's unique log inode
 * held writable inside the expected unit's cgroup (including sub-cgroups).
 * PID starttime guards against reuse; InvocationID is read before and after
 * and must match. A hit returns that InvocationID; anything else (including
 * "not found") returns undefined and proves nothing about liveness.
 */
export async function findFdEvidence(
  unit: string,
  identity: { stdout: { dev: number; ino: number }; stderr: { dev: number; ino: number } },
): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  const before = await inspectScope(unit);
  if (before.state !== 'present' || !before.invocation || !before.cgroup) return undefined;
  const match = (dev: number, ino: number): boolean =>
    (dev === identity.stdout.dev && ino === identity.stdout.ino) || (dev === identity.stderr.dev && ino === identity.stderr.ino);
  type Hit = { pid: number; fd: number; starttime: string };
  let hit: Hit | undefined;
  for (const pid of cgroupPids(before.cgroup)) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const name of fds) {
      if (!/^\d+$/.test(name)) continue;
      const link = `/proc/${pid}/fd/${name}`;
      let st: { dev: number; ino: number };
      try {
        st = statSync(link);
      } catch {
        continue;
      }
      if (!match(st.dev, st.ino)) continue;
      let fdinfo: string;
      try {
        fdinfo = readFileSync(`/proc/${pid}/fdinfo/${name}`, 'utf8');
      } catch {
        continue;
      }
      if (!fdAccessWritable(fdinfo)) continue;
      const starttime = readStarttime(pid);
      if (starttime === undefined) continue;
      hit = { pid, fd: Number(name), starttime };
      break;
    }
    if (hit) break;
  }
  if (!hit) return undefined;
  const after = await inspectScope(unit);
  if (after.state !== 'present' || after.invocation !== before.invocation) return undefined;
  // Re-verify the same process still holds the same file: starttime guards
  // PID reuse, fstat guards fd recycling.
  if (readStarttime(hit.pid) !== hit.starttime) return undefined;
  try {
    const st = statSync(`/proc/${hit.pid}/fd/${hit.fd}`);
    if (!match(st.dev, st.ino)) return undefined;
  } catch {
    return undefined;
  }
  return after.invocation;
}

export type KillOwnedScopeResult = { ok: true } | { ok: false; reason: string; detail?: string };

/**
 * Kill primitive for file-mode scopes (§9.4 support): refuse unless the scope
 * is present with a matching invocation; unknown inspection refuses without
 * acting. SIGKILL is followed by stop; other signals only kill the cgroup.
 */
export async function killOwnedScope(unit: string, invocation: string | undefined, signal: NodeJS.Signals): Promise<KillOwnedScopeResult> {
  if (process.platform !== 'linux') return { ok: false, reason: 'unsupported-platform' };
  const info = await inspectScope(unit);
  if (info.state === 'absent') return { ok: false, reason: 'absent' };
  if (info.state === 'unknown') return { ok: false, reason: 'unknown', detail: info.error };
  if (!invocation || info.invocation !== invocation) {
    return { ok: false, reason: 'invocation-mismatch', detail: `expected ${invocation ?? '<missing>'}, scope has ${info.invocation ?? '<missing>'}` };
  }
  const killed = await systemctl(['kill', '-s', signal, '--kill-whom=all', `${unit}.scope`]);
  if (killed.code !== 0) {
    return { ok: false, reason: 'kill-failed', detail: (killed.stderr || killed.stdout).trim().slice(0, 500) };
  }
  if (signal === 'SIGKILL') {
    const stopped = await systemctl(['stop', `${unit}.scope`]);
    if (stopped.code !== 0) {
      return { ok: false, reason: 'stop-failed', detail: (stopped.stderr || stopped.stdout).trim().slice(0, 500) };
    }
  }
  return { ok: true };
}

/** One systemd user scope around a fixed argv. Descendants stay in the cgroup and die with it. */
export function startOwnedScope(options: { command: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string | null; stdinPath?: string; unit: string; keepStdinOpen?: boolean; detached?: boolean; files?: FileScopeFiles }): OwnedScope {
  if (options.keepStdinOpen && (options.stdin !== null || options.stdinPath !== undefined)) throw new Error('keepStdinOpen requires stdin: null and no stdinPath');
  if (options.files && options.keepStdinOpen) throw new Error('File-mode scope does not support keepStdinOpen');
  if (options.files && options.stdin !== null && options.stdinPath === undefined) throw new Error('File-mode scope requires stdin from a prompt file or null');
  if (process.platform !== 'linux') throw new Error('Owned CLI scope requires Linux systemd user sessions');
  const handle = new EventEmitter() as OwnedScope;
  let invocation: string | undefined;
  let cancelRequested = false;
  let childClosed = false;
  let forceKill = false;
  let escalate: (() => void) | undefined;
  const startupDeadline = Date.now() + VERIFY_MS;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let closed = false;
  let detached = false;
  let stopPromise: Promise<void> | undefined;
  const unit = options.unit;
  const files = options.files;
  let promptFd: number | undefined;
  try { if(options.stdinPath)promptFd=openSync(options.stdinPath,'r'); } catch(error) { throw new Error(`Prompt delivery failed: ${String(error)}`); }
  // File mode wraps the engine in the fixed sh shell (§3.2); runId/nonce and
  // paths travel via environment, never interpolated into the script string.
  const scopeEnv: NodeJS.ProcessEnv = files
    ? { ...options.env, WEAVER_RUN_ID: files.runId, WEAVER_RUN_NONCE: files.nonce, WEAVER_EXIT_FILE: files.exitPath, WEAVER_EXIT_TMP: files.exitTmpPath }
    : options.env;
  const scopeCommand: readonly string[] = files ? ['sh', '-c', FILE_SCOPE_SHELL_SCRIPT, 'sh', ...options.command] : options.command;
  let child: ChildProcessWithoutNullStreams;
  const spawnFn = spawnImplForTests ?? spawn;
  try { child = spawnFn('systemd-run', [
    '--user', '--scope', '--collect', '--quiet', `--unit=${unit}`, `--working-directory=${options.cwd}`,
    '-p', 'MemoryHigh=8G', '-p', 'MemoryMax=10G', '-p', 'KillMode=control-group',
    '--', ...scopeCommand,
  ], { cwd: options.cwd, env: scopeEnv, shell: false, windowsHide: true, detached: options.detached ?? false, stdio: [promptFd ?? (files ? 'ignore' : 'pipe'), files ? files.stdoutFd : 'pipe', files ? files.stderrFd : 'pipe'] }) as ChildProcessWithoutNullStreams;
  } finally {
    if(promptFd!==undefined)closeSync(promptFd);
    // The child holds its own duplicates of the log FDs; close our copies so
    // the service never retains a write end and EOF/unlink behave correctly.
    if(files){ try{closeSync(files.stdoutFd);}catch{/* already closed */} try{closeSync(files.stderrFd);}catch{/* already closed */} }
  }
  (handle as { unit: string }).unit = unit;
  handle.pid = child.pid;
  if (files) {
    // No pipe read ends exist in file mode; expose inert already-ended
    // streams so the handle shape stays stable for pipe-mode callers.
    const inert = (): Readable => new ReadableImpl({ read() { this.push(null); } });
    handle.stdout = inert();
    handle.stderr = inert();
  } else {
    handle.stdout = child.stdout;
    handle.stderr = child.stderr;
  }
  // Remember foreign scopes while the process tree is still reachable: a command can outlive its vendor CLI.
  const rememberedEscapes = new Map<number, string>();
  const rememberEscapes = () => rememberEscapedDescendants(child.pid, unit, rememberedEscapes);
  const escapedTimer = setInterval(rememberEscapes, 3000);
  escapedTimer.unref?.();
  if (promptFd !== undefined) { /* inherited read-only prompt file */ }
  else if (files) { /* file mode: stdin is the prompt fd or ignore; nothing to write */ }
  else if (options.keepStdinOpen) {
    handle.stdin = child.stdin;
    child.stdin.on('error', error => handle.emit('error', new Error(`Scope stdin failed: ${error.message}`)));
  }
  else if (options.stdin === null) child.stdin.end();
  else {
    child.stdin.on('error', error => handle.emit('error', new Error(`Prompt delivery failed: ${error.message}`)));
    child.stdin.end(options.stdin);
  }
  let verifyStopped = false;
  let verifyInFlight = false;
  let verifyTimer: ReturnType<typeof setInterval> | undefined;
  let verifyDeadline: ReturnType<typeof setTimeout> | undefined;
  let verifyImmediate: NodeJS.Immediate | undefined;
  const stopVerify = () => {
    verifyStopped = true;
    if (verifyTimer) clearInterval(verifyTimer);
    if (verifyDeadline) clearTimeout(verifyDeadline);
    verifyTimer = undefined;
    verifyDeadline = undefined;
  };
  const verify = () => {
    if (detached || verifyStopped || verifyInFlight) return;
    verifyInFlight = true;
    void showScope(unit).then(info => {
      if (detached || verifyStopped) return;
      if (info?.invocation) { invocation ??= info.invocation; handle.emit('identity', invocation); }
      if (info?.mainPid && info.mainPid !== handle.pid) handle.emit('pid', (handle.pid = info.mainPid));
      // Keep observing until the manager has published InvocationID: an early
      // activation frame can already match the unit name without an identity.
      if (owns(unit, info, invocation, child.pid) && info?.invocation) stopVerify();
    }).catch(() => { /* show failures stay inside this turn */ }).finally(() => { verifyInFlight = false; });
  };
  verifyTimer = setInterval(verify, 50);
  // Let every constructor listener attach before the first asynchronous observation;
  // a systemd scope can otherwise start and finish inside one fast turn.
  verifyImmediate = setImmediate(verify);
  const live = (info: ScopeInfo | undefined): boolean => info?.active === 'active' || info?.active === 'activating' || info?.active === 'deactivating';
  const finish = () => {
    if (closed || detached) return;
    closed = true;
    clearInterval(escapedTimer);
    stopVerify();
    handle.emit('close', exitCode, exitSignal);
  };
  const requireOwned = (info: ScopeInfo | undefined) => {
    if (!owns(unit, info, invocation, child.pid)) {
      handle.emit('error', new Error(`Refusing to stop scope ${unit}: ownership did not match`));
      throw new Error(`CLI scope ${unit} still active`);
    }
    if (info?.invocation) { invocation ??= info.invocation; handle.emit('identity', info.invocation); }
  };
  const stop = (signal: NodeJS.Signals): Promise<void> => {
    if (signal === 'SIGKILL') { forceKill = true; escalate?.(); }
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      clearInterval(escapedTimer);
      let reportedCleanup = false;
      const cleanEscaped = async () => {
        if (reportedCleanup) return;
        const cleaned = await cleanupEscapedDescendants(child.pid, unit, rememberedEscapes);
        if (cleaned.units.length || cleaned.pids.length) {
          reportedCleanup = true;
          handle.emit('cleanup', cleaned);
        }
      };
      // Before the worker scope is torn down, capture descendants that moved themselves elsewhere.
      await cleanEscaped();
      let info = await showScope(unit);
      let killedLauncher = false;
      // A missing scope is not terminal while systemd-run can still register it.
      // Failed launches converge on child.close; a stalled launcher gets its existing
      // startup verification deadline, then only that owned child is terminated.
      while (!live(info) && !childClosed) {
        if (Date.now() >= startupDeadline && !killedLauncher) {
          killedLauncher = true;
          child.kill('SIGKILL');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        info = await showScope(unit);
      }
      if (!live(info)) return;
      requireOwned(info);
      // The command may have taken a new cgroup while the scope was starting; re-check once it is live.
      await cleanEscaped();
      if (forceKill) await systemctl(['kill', '-s', 'SIGKILL', '--kill-whom=all', `${unit}.scope`]);
      else {
        await systemctl(['kill', '-s', 'SIGTERM', '--kill-whom=all', `${unit}.scope`]);
        if (!forceKill) await new Promise<void>(resolve => {
          const timer = setTimeout(() => { escalate = undefined; resolve(); }, TERM_GRACE_MS);
          escalate = () => { clearTimeout(timer); escalate = undefined; resolve(); };
        });
        const after = await showScope(unit);
        if (live(after)) {
          requireOwned(after);
          await systemctl(['kill', '-s', 'SIGKILL', '--kill-whom=all', `${unit}.scope`]);
        }
      }
      const beforeStop = await showScope(unit);
      if (live(beforeStop)) requireOwned(beforeStop);
      await systemctl(['stop', `${unit}.scope`]);
      let last = await showScope(unit);
      if (live(last)) {
        await new Promise(resolve => setTimeout(resolve, 300));
        last = await showScope(unit);
      }
      if (live(last)) {
        handle.emit('error', new Error(`CLI scope ${unit} still active after stop`));
        throw new Error(`CLI scope ${unit} still active after stop`);
      }
    })().catch(error => {
      stopVerify();
      throw error;
    });
    return stopPromise;
  };
  const afterStop = (signal: NodeJS.Signals) => {
    if (detached) return;
    void stop(signal).then(() => finish()).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!detached && !/still active/.test(message)) handle.emit('error', error instanceof Error ? error : new Error(message));
    });
  };
  verifyDeadline = setTimeout(() => {
    if (detached || verifyStopped || closed || child.exitCode !== null || exitCode !== null) {
      stopVerify();
      return;
    }
    stopVerify();
    if (!cgroup(child.pid).includes(`${unit}.scope`)) {
      cancelRequested = true;
      handle.emit('error', new Error(`CLI scope ${unit} did not own the launched process`));
      void stop('SIGKILL').catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        if (!detached && !/still active/.test(message)) handle.emit('error', error instanceof Error ? error : new Error(message));
      });
    }
  }, VERIFY_MS);
  handle.kill = signal => {
    const requested = signal ?? 'SIGTERM';
    if (detached || closed || (cancelRequested && (requested !== 'SIGKILL' || forceKill))) return false;
    cancelRequested = true;
    exitSignal = requested;
    void stop(exitSignal).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!detached && !/still active/.test(message)) handle.emit('error', error instanceof Error ? error : new Error(message));
    });
    return true;
  };
  handle.detach = () => {
    if (detached) return;
    detached = true;
    clearInterval(escapedTimer);
    stopVerify();
    if (verifyImmediate !== undefined) {
      clearImmediate(verifyImmediate);
      verifyImmediate = undefined;
    }
    // Release stdio pipe handles without signalling the worker, then unref
    // the launcher handle itself so a detached run never keeps the loop alive.
    try { (child.stdout as unknown as { unref?: () => void } | null)?.unref?.(); } catch { /* ignore */ }
    try { (child.stderr as unknown as { unref?: () => void } | null)?.unref?.(); } catch { /* ignore */ }
    try { (child.stdin as unknown as { unref?: () => void } | null)?.unref?.(); } catch { /* ignore */ }
    try { child.unref(); } catch { /* ignore */ }
    try { (child.stdout as unknown as { removeAllListeners?: () => void } | null)?.removeAllListeners?.(); } catch { /* ignore */ }
    try { (child.stderr as unknown as { removeAllListeners?: () => void } | null)?.removeAllListeners?.(); } catch { /* ignore */ }
    try { (child.stdin as unknown as { removeAllListeners?: () => void } | null)?.removeAllListeners?.(); } catch { /* ignore */ }
    try { child.removeAllListeners('exit'); } catch { /* ignore */ }
    try { child.removeAllListeners('close'); } catch { /* ignore */ }
    try { child.removeAllListeners('error'); } catch { /* ignore */ }
    // Destroy parent-side streams (file mode: inert; pipe mode: read ends).
    // Child listeners are already removed so this emits nothing on the child.
    try { (child.stdout as unknown as { destroy?: () => void } | null)?.destroy?.(); } catch { /* ignore */ }
    try { (child.stderr as unknown as { destroy?: () => void } | null)?.destroy?.(); } catch { /* ignore */ }
    try { (handle.stdout as unknown as { destroy?: () => void })?.destroy?.(); } catch { /* ignore */ }
    try { (handle.stderr as unknown as { destroy?: () => void })?.destroy?.(); } catch { /* ignore */ }
    try { (handle.stdin as unknown as { destroy?: () => void })?.destroy?.(); } catch { /* ignore */ }
    handle.removeAllListeners();
  };
  child.on('error', error => {
    if (detached) return;
    stopVerify();
    handle.emit('error', error);
    exitCode = exitCode ?? 1;
    afterStop('SIGKILL');
  });
  // systemd-run can exit while a background descendant still holds its pipes.
  // Start cgroup cleanup on exit for every scope: without this the non-detached
  // success path waits for 'close', which never arrives while a descendant
  // holds stdout/stderr, leaking the launcher and its descendants. 'close'
  // still publishes the final event only after the streams drain and the scope
  // is reclaimed; output is never destroyed to force an earlier close.
  child.on('exit', (code, signal) => {
    if (detached) return;
    childClosed = true;
    exitCode = code;
    if (!exitSignal && signal) exitSignal = signal;
    stopVerify();
    void stop(cancelRequested ? exitSignal ?? 'SIGTERM' : 'SIGTERM').catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!detached && !/still active/.test(message)) handle.emit('error', error instanceof Error ? error : new Error(message));
    });
  });
  child.on('close', (code, signal) => {
    if (detached) return;
    childClosed = true;
    exitCode = code;
    if (!exitSignal && signal) exitSignal = signal;
    stopVerify();
    afterStop(cancelRequested ? exitSignal ?? 'SIGTERM' : 'SIGTERM');
  });
  return handle;
}

/** Test helper: read one cgroup line. Not used for containment decisions outside scope.ts. */
export function processInScope(pid: number, unit: string): boolean {
  return cgroup(pid).includes(`${unit}.scope`);
}

export interface LineOverflow {
  phase: 'complete' | 'unterminated';
  limitBytes: number;
  observedBytes: number;
}

export function decodeLines(push: (line: string) => void, overflow: (detail: LineOverflow) => void): { write(chunk: Buffer): void; end(): void } {
  const limitBytes = 8 * 1024 * 1024;
  let decoder = new StringDecoder('utf8');
  let parts: string[] = [];
  let observedBytes = 0;
  let skipping = false;
  let ended = false;
  const reset = () => {
    decoder = new StringDecoder('utf8');
    parts = [];
    observedBytes = 0;
  };
  const append = (text: string) => {
    observedBytes += Buffer.byteLength(text);
    if (observedBytes <= limitBytes) {
      if (text) parts.push(text);
    }
    else parts = [];
  };
  const report = (phase: LineOverflow['phase']) => overflow({ phase, limitBytes, observedBytes });
  return {
    write(chunk) {
      if (ended) return;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        if (!skipping) {
          // Decode bounded slices even if a caller supplies one huge chunk.
          // Retain at most one permitted line, and only count any excess.
          for (let cursor = offset; cursor < end; cursor += 64 * 1024) {
            append(decoder.write(chunk.subarray(cursor, Math.min(cursor + 64 * 1024, end))));
          }
          if (newline >= 0) append(decoder.end());
          if (observedBytes > limitBytes) {
            report(newline >= 0 ? 'complete' : 'unterminated');
            skipping = newline < 0;
            reset();
          } else if (newline >= 0) {
            const line = parts.join('');
            reset();
            push(line);
          }
        }
        if (newline < 0) return;
        if (skipping) {
          skipping = false;
          reset();
        }
        offset = newline + 1;
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (!skipping) {
        append(decoder.end());
        if (observedBytes > limitBytes) report('unterminated');
        else {
          const line = parts.join('');
          if (line.trim()) push(line);
        }
      }
      reset();
    },
  };
}
