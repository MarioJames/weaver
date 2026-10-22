import { openSync, closeSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { isRealEngineKind } from '../../workspace';
import { cgroupPath, processTree, readProcessSnapshots, unitOfCgroup } from '../../monitors/process-tree';

const VERIFY_MS = 5000;
const TERM_GRACE_MS = 1500;

export interface OwnedScope extends EventEmitter {
  readonly unit: string;
  pid?: number;
  stdout: Readable;
  stderr: Readable;
  /** Writable child stdin; only present when startOwnedScope was called with keepStdinOpen. */
  stdin?: Writable;
  kill(signal?: NodeJS.Signals): boolean;
}

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
  if (!rootPid || process.platform !== 'linux') return { units: [], pids: [] };
  const table = readProcessSnapshots();
  const own = ownUnit.replace(/\.scope$/, '');
  const tree = processTree(rootPid, table).filter(process => process.pid !== rootPid);
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

/** One systemd user scope around a fixed argv. Descendants stay in the cgroup and die with it. */
export function startOwnedScope(options: { command: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string | null; stdinPath?: string; unit: string; keepStdinOpen?: boolean; detached?: boolean }): OwnedScope {
  if (options.keepStdinOpen && (options.stdin !== null || options.stdinPath !== undefined)) throw new Error('keepStdinOpen requires stdin: null and no stdinPath');
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
  let stopPromise: Promise<void> | undefined;
  const unit = options.unit;
  let promptFd: number | undefined;
  try { if(options.stdinPath)promptFd=openSync(options.stdinPath,'r'); } catch(error) { throw new Error(`Prompt delivery failed: ${String(error)}`); }
  let child: ChildProcessWithoutNullStreams;
  try { child = spawn('systemd-run', [
    '--user', '--scope', '--collect', '--quiet', `--unit=${unit}`, `--working-directory=${options.cwd}`,
    '-p', 'MemoryHigh=8G', '-p', 'MemoryMax=10G', '-p', 'KillMode=control-group',
    '--', ...options.command,
  ], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: options.detached ?? false, stdio: [promptFd ?? 'pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  } finally { if(promptFd!==undefined)closeSync(promptFd); }
  (handle as { unit: string }).unit = unit;
  handle.pid = child.pid;
  handle.stdout = child.stdout;
  handle.stderr = child.stderr;
  // Remember foreign scopes while the process tree is still reachable: a command can outlive its vendor CLI.
  const rememberedEscapes = new Map<number, string>();
  const rememberEscapes = () => {
    if (process.platform !== 'linux' || !child.pid) return;
    try {
      const table = readProcessSnapshots();
      for (const process of processTree(child.pid, table)) {
        if (process.pid === child.pid) continue;
        const path = cgroupPath(process.pid);
        const foreign = unitOfCgroup(path ?? null);
        if (foreign && foreign !== unit.replace(/\.scope$/, '') && path && userScope(path)) rememberedEscapes.set(process.pid, foreign);
      }
    } catch { /* the next sweep or the live tree at stop covers it */ }
  };
  const escapedTimer = setInterval(rememberEscapes, 3000);
  escapedTimer.unref?.();
  if (promptFd !== undefined) { /* inherited read-only prompt file */ }
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
  const stopVerify = () => {
    verifyStopped = true;
    if (verifyTimer) clearInterval(verifyTimer);
    if (verifyDeadline) clearTimeout(verifyDeadline);
  };
  const verify = () => {
    if (verifyStopped || verifyInFlight) return;
    verifyInFlight = true;
    void showScope(unit).then(info => {
      if (verifyStopped) return;
      if (info?.invocation) { invocation ??= info.invocation; handle.emit('identity', invocation); }
      if (info?.mainPid) handle.pid = info.mainPid;
      // Keep observing until the manager has published InvocationID: an early
      // activation frame can already match the unit name without an identity.
      if (owns(unit, info, invocation, child.pid) && info?.invocation) stopVerify();
    }).catch(() => { /* show failures stay inside this turn */ }).finally(() => { verifyInFlight = false; });
  };
  verifyTimer = setInterval(verify, 50);
  // Let every constructor listener attach before the first asynchronous observation;
  // a systemd scope can otherwise start and finish inside one fast turn.
  setImmediate(verify);
  const live = (info: ScopeInfo | undefined): boolean => info?.active === 'active' || info?.active === 'activating' || info?.active === 'deactivating';
  const finish = () => {
    if (closed) return;
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
    void stop(signal).then(() => finish()).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/still active/.test(message)) handle.emit('error', error instanceof Error ? error : new Error(message));
    });
  };
  verifyDeadline = setTimeout(() => {
    if (verifyStopped || closed || child.exitCode !== null || exitCode !== null) {
      stopVerify();
      return;
    }
    stopVerify();
    if (!cgroup(child.pid).includes(`${unit}.scope`)) {
      cancelRequested = true;
      handle.emit('error', new Error(`CLI scope ${unit} did not own the launched process`));
      void stop('SIGKILL').catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        if (!/still active/.test(message)) handle.emit('error', error instanceof Error ? error : new Error(message));
      });
    }
  }, VERIFY_MS);
  handle.kill = signal => {
    const requested = signal ?? 'SIGTERM';
    if (closed || (cancelRequested && (requested !== 'SIGKILL' || forceKill))) return false;
    cancelRequested = true;
    exitSignal = requested;
    void stop(exitSignal).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/still active/.test(message)) handle.emit('error', error instanceof Error ? error : new Error(message));
    });
    return true;
  };
  child.on('error', error => {
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
    childClosed = true;
    exitCode = code;
    if (!exitSignal && signal) exitSignal = signal;
    stopVerify();
    void stop(cancelRequested ? exitSignal ?? 'SIGTERM' : 'SIGTERM').catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/still active/.test(message)) handle.emit('error', error instanceof Error ? error : new Error(message));
    });
  });
  child.on('close', (code, signal) => {
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
