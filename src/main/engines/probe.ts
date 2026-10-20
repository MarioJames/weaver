import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ENGINE_CATALOG, catalogEntry, type EngineProbeRecord, type ProbeStatus } from '../../shared/engines';

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_OUTPUT = 8_192;
const KILL_GRACE_MS = 200;
const ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'PATHEXT', 'COMSPEC'];

export interface ProbeOptions {
  pathEnv?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

function probeEnv(pathEnv: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: pathEnv };
  for (const key of ENV_KEYS) if (source[key]) env[key] = source[key];
  return env;
}

/** Locate a catalog command on PATH. Never consults the shell. */
export async function findExecutable(command: string, pathEnv: string): Promise<string | undefined> {
  if (!ENGINE_CATALOG.some(entry => entry.command === command)) throw new Error('Command is outside the probe allowlist');
  if (command.includes('/') || command.includes('\\') || command.includes('..')) throw new Error('Command is outside the probe allowlist');
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      try {
        await access(candidate, constants.X_OK);
        const info = await lstat(candidate);
        if (!info.isFile() && !info.isSymbolicLink()) continue;
        const resolved = await realpath(candidate);
        const resolvedInfo = await lstat(resolved);
        if (!resolvedInfo.isFile()) continue;
        return resolved;
      } catch { /* try the next directory */ }
    }
  }
  return undefined;
}

function clip(value: string): string {
  const cleaned = value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
  const line = cleaned.split(/\n/).map(item => item.trim()).find(Boolean) ?? '';
  return line.replace(/\s+/g, ' ').slice(0, 200);
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-pid, signal); } catch { /* this probe group is already gone */ }
  }
  try { child.kill(signal); } catch { /* the direct child is already gone */ }
}

export interface CaptureResult { code: number | null; timedOut: boolean; overflow: boolean; stdout: string; stderr: string; error?: string }

/** Runs one allowlisted executable with fixed arguments, no shell and no stdin, bounded in time and output. */
export function runCapture(executable: string, args: readonly string[], timeoutMs: number, maxOutputBytes: number, env: NodeJS.ProcessEnv): Promise<CaptureResult> {
  return new Promise(resolve => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let exitCode: number | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let reapArmed = false;
    const options: SpawnOptions = {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
    };
    const child = spawn(executable, [...args], options);
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signalGroup(child, 'SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, timedOut, overflow, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), error });
    };
    const reap = () => {
      if (reapArmed || settled) return;
      reapArmed = true;
      signalGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup(child, 'SIGKILL');
        finish(exitCode);
      }, KILL_GRACE_MS);
    };
    const take = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.length >= maxOutputBytes) return current;
      const next: Buffer<ArrayBufferLike> = Buffer.concat([current, chunk]);
      if (next.length <= maxOutputBytes) return next;
      overflow = true;
      reap();
      return next.subarray(0, maxOutputBytes);
    };
    child.stdout?.on('data', chunk => { stdout = take(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    child.stderr?.on('data', chunk => { stderr = take(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    const timer = setTimeout(() => {
      timedOut = true;
      reap();
    }, timeoutMs);
    child.on('error', error => finish(null, error.message));
    child.on('exit', code => { exitCode = code; reap(); });
    child.on('close', code => finish(code ?? exitCode));
  });
}

function record(entry: (typeof ENGINE_CATALOG)[number], status: ProbeStatus, probedAt: string, extra: Partial<EngineProbeRecord> = {}): EngineProbeRecord {
  return { id: entry.id, kind: entry.kind, command: entry.command, status, probedAt, authenticated: false, modelUsable: false, ...extra };
}

function runVersion(executable: string, timeoutMs: number, maxOutputBytes: number, env: NodeJS.ProcessEnv): Promise<CaptureResult> {
  return runCapture(executable, ['--version'], timeoutMs, maxOutputBytes, env);
}

/** Read-only PATH plus `--version` probe. One in-flight probe per engine; never starts a model session. */
export class EngineProber {
  private inflight = new Map<string, Promise<EngineProbeRecord>>();
  constructor(private readonly options: ProbeOptions = {}) {}

  probeOne(id: string): Promise<EngineProbeRecord> {
    const current = this.inflight.get(id);
    if (current) return current;
    const job = this.execute(id).finally(() => { if (this.inflight.get(id) === job) this.inflight.delete(id); });
    this.inflight.set(id, job);
    return job;
  }

  scan(): Promise<EngineProbeRecord[]> {
    return Promise.all(ENGINE_CATALOG.map(entry => this.probeOne(entry.id)));
  }

  private async execute(id: string): Promise<EngineProbeRecord> {
    const entry = catalogEntry(id);
    const probedAt = (this.options.now ?? (() => new Date()))().toISOString();
    if (!entry) return { id, kind: 'unknown', command: id, status: 'probe_failed', probedAt, detail: 'Engine is outside the probe allowlist', authenticated: false, modelUsable: false };
    const pathEnv = this.options.pathEnv ?? process.env.PATH ?? '';
    const executable = await findExecutable(entry.command, pathEnv);
    if (!executable) return record(entry, 'missing', probedAt);
    const result = await runVersion(executable, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS, this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT, probeEnv(pathEnv, this.options.env ?? process.env));
    if (result.error) return record(entry, 'probe_failed', probedAt, { path: executable, detail: result.error });
    if (result.timedOut) return record(entry, 'probe_failed', probedAt, { path: executable, detail: 'Version probe timed out' });
    if (result.overflow) return record(entry, 'probe_failed', probedAt, { path: executable, detail: 'Version output exceeded the limit' });
    if (result.code !== 0) return record(entry, 'probe_failed', probedAt, { path: executable, detail: `Version probe exited ${result.code ?? 'without a code'}` });
    const version = clip(result.stdout) || clip(result.stderr);
    if (!version) return record(entry, 'probe_failed', probedAt, { path: executable, detail: 'Version command succeeded without a usable version' });
    return record(entry, 'installed', probedAt, { path: executable, version });
  }
}
