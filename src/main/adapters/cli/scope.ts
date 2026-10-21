import { openSync, closeSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const VERIFY_MS = 5000;
const TERM_GRACE_MS = 1500;

export interface OwnedScope extends EventEmitter {
  readonly unit: string;
  pid?: number;
  stdout: Readable;
  stderr: Readable;
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

/** Recover a persisted, UUID-named run scope. Failure to verify ownership fails closed.
 * Verify any existing invocation, then stop matching launchers before the final inspection. */
export async function recoverOwnedScope(unit: string, invocation?: string): Promise<void> {
  if (process.platform !== 'linux' || !/^weaver-schedule-[0-9a-f-]{36}$/.test(unit)) throw new Error('Cannot verify persisted schedule process identity');
  const inspect = async (): Promise<ScopeInfo | undefined> => {
    const result = await systemctl(['show', `${unit}.scope`, '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'InvocationID', '--no-pager']);
    if (/^LoadState=not-found$/m.test(result.stdout)) return undefined;
    if (result.code !== 0 || !result.stdout.trim()) throw new Error(`Cannot inspect schedule scope ${unit}; restore the systemd user session and retry recovery`);
    const info = parseShow(result.stdout);
    if (!info.active) throw new Error(`Cannot inspect schedule scope ${unit}; ActiveState is missing`);
    if (info.id !== `${unit}.scope` || invocation && info.invocation !== invocation) throw new Error(`Schedule scope ${unit} identity changed; manual ownership inspection required`);
    return info;
  };
  // Reject a replaced scope before touching its launcher or descendants.
  await inspect();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
      if (argv[0]?.split('/').at(-1) === 'systemd-run' && argv.includes(`--unit=${unit}`)) process.kill(Number(entry), 'SIGKILL');
    } catch { /* Process may have exited while enumerating. */ }
  }
  const info = await inspect();
  if (!info || ['inactive','failed'].includes(info.active ?? '')) return;
  const killed = await systemctl(['kill', '-s', 'SIGKILL', '--kill-whom=all', `${unit}.scope`]);
  if (killed.code !== 0) throw new Error(`Could not terminate schedule scope ${unit}`);
  await systemctl(['stop', `${unit}.scope`]);
  const after = await inspect();
  if (after && !['inactive','failed'].includes(after.active ?? '')) throw new Error(`Schedule scope ${unit} remains active`);
}

/** One systemd user scope around a fixed argv. Descendants stay in the cgroup and die with it. */
export function startOwnedScope(options: { command: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string | null; stdinPath?: string; unit: string; detached?: boolean }): OwnedScope {
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
  if (promptFd !== undefined) { /* inherited read-only prompt file */ }
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
  verifyTimer = setInterval(() => {
    if (verifyStopped || verifyInFlight) return;
    verifyInFlight = true;
    void showScope(unit).then(info => {
      if (verifyStopped) return;
      if (info?.invocation) { invocation ??= info.invocation; handle.emit('identity', invocation); }
      if (info?.mainPid) handle.pid = info.mainPid;
      if (owns(unit, info, invocation, child.pid)) stopVerify();
    }).catch(() => { /* show failures stay inside this turn */ }).finally(() => { verifyInFlight = false; });
  }, 50);
  const live = (info: ScopeInfo | undefined): boolean => info?.active === 'active' || info?.active === 'activating' || info?.active === 'deactivating';
  const finish = () => {
    if (closed) return;
    closed = true;
    stopVerify();
    handle.emit('close', exitCode, exitSignal);
  };
  const requireOwned = (info: ScopeInfo | undefined) => {
    if (!owns(unit, info, invocation, child.pid)) {
      handle.emit('error', new Error(`Refusing to stop scope ${unit}: ownership did not match`));
      throw new Error(`CLI scope ${unit} still active`);
    }
    if (info?.invocation) invocation ??= info.invocation;
  };
  const stop = (signal: NodeJS.Signals): Promise<void> => {
    if (signal === 'SIGKILL') { forceKill = true; escalate?.(); }
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
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
  // systemd-run can exit while a background descendant still holds its pipes. Start
  // cgroup cleanup on exit; only publish close after the streams themselves close.
  if (options.detached) child.on('exit', (code, signal) => {
    childClosed = true;
    exitCode = code;
    if (!exitSignal && signal) exitSignal = signal;
    stopVerify();
    void stop(cancelRequested ? exitSignal ?? 'SIGTERM' : 'SIGTERM').catch(error => {
      handle.emit('error', error instanceof Error ? error : new Error(String(error)));
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
