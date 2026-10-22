import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface RunFileIdentity {
  dev: number;
  ino: number;
}

export interface RunFilePaths {
  stdout: string;
  stderr: string;
  exit: string;
  exitTmp: string;
}

export interface CreatedRunFiles {
  paths: RunFilePaths;
  fds: { stdout: number; stderr: number };
  identity: { stdout: RunFileIdentity; stderr: RunFileIdentity };
  nonce: string;
}

/** Exit record written by the sh wrapper (§3.3). */
export interface ExitRecord {
  code: number;
  signal: string | null;
  pid: number;
  at: string;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Pre-create per-run log files (0600, parent dir 0700) and return open
 * write FDs plus fstat identity for the FD-anchored start (§3.1, §11.4).
 * Paths are namespaced by runId; the exit tmp file lives in the same
 * directory as the final exit file so rename is atomic.
 */
export function createRunFiles(stateDir: string, runId: string): CreatedRunFiles {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const paths: RunFilePaths = {
    stdout: join(stateDir, `stdout-${runId}.log`),
    stderr: join(stateDir, `stderr-${runId}.log`),
    exit: join(stateDir, `exit-${runId}.json`),
    exitTmp: join(stateDir, `exit-${runId}.tmp`),
  };
  const nonce = randomHex(16);
  // openSync with numeric flags: O_WRONLY|O_CREAT|O_APPEND|O_EXCL.
  // O_EXCL fails closed if a stale file exists from a previous attempt
  // instead of silently appending to it.
  const O_WRONLY = 1;
  const O_CREAT = 64;
  const O_APPEND = 1024;
  const O_EXCL = 128;
  const openAppendExcl = (path: string): { fd: number; identity: RunFileIdentity } => {
    const fd = openSync(path, O_WRONLY | O_CREAT | O_APPEND | O_EXCL, 0o600);
    const st = fstatSync(fd);
    return { fd, identity: { dev: st.dev, ino: st.ino } };
  };
  const stdout = openAppendExcl(paths.stdout);
  let stderr: { fd: number; identity: RunFileIdentity };
  try {
    stderr = openAppendExcl(paths.stderr);
  } catch (error) {
    closeSync(stdout.fd);
    throw error;
  }
  return {
    paths,
    fds: { stdout: stdout.fd, stderr: stderr.fd },
    identity: { stdout: stdout.identity, stderr: stderr.identity },
    nonce,
  };
}

/** Close FDs returned by createRunFiles (parent side after spawn). */
export function closeRunFiles(fds: { stdout: number; stderr: number }): void {
  for (const fd of [fds.stdout, fds.stderr]) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Read and validate an exit record. Returns undefined for: missing file,
 * stale .tmp residue, JSON parse failure, or runId/nonce mismatch (§3.3).
 * Never throws for those cases.
 */
export function readExitRecord(path: string, runId: string, nonce: string): ExitRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record['runId'] !== runId || record['nonce'] !== nonce) return undefined;
  if (typeof record['code'] !== 'number' || !Number.isInteger(record['code'])) return undefined;
  if (typeof record['pid'] !== 'number' || !Number.isInteger(record['pid'])) return undefined;
  if (typeof record['at'] !== 'string') return undefined;
  const signal = record['signal'];
  if (signal !== null && typeof signal !== 'string') return undefined;
  return { code: record['code'] as number, signal: signal as string | null, pid: record['pid'] as number, at: record['at'] as string };
}

export type LogIdentityCheck =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'truncated' | 'replaced'; detail?: string };

/**
 * Compare live log files against persisted fstat identity (§5.3, §11.2-11).
 * missing: path stat fails; replaced: dev/ino differs; truncated: size < offset.
 */
export function checkLogIdentity(
  paths: { stdout: string; stderr: string },
  identity: { stdout: RunFileIdentity; stderr: RunFileIdentity },
  minSizes: { stdout: number; stderr: number },
): LogIdentityCheck {
  for (const key of ['stdout', 'stderr'] as const) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(paths[key]);
    } catch {
      return { ok: false, reason: 'missing', detail: key };
    }
    if (st.dev !== identity[key].dev || st.ino !== identity[key].ino) {
      return { ok: false, reason: 'replaced', detail: key };
    }
    if (st.size < minSizes[key]) {
      return { ok: false, reason: 'truncated', detail: `${key}: size ${st.size} < offset ${minSizes[key]}` };
    }
  }
  return { ok: true };
}
