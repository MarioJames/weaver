import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { redactSecrets } from '../../shared/redact';
import type { RunningCommand } from '../../shared/contracts/monitoring';

/** One /proc entry reduced to what CPU and command detection need. Never carries the environment. */
export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  argv: string[];
  state: string;
  /** utime + stime in clock ticks. */
  utime: number;
  stime: number;
  /** The kernel's start time in clock ticks since boot. */
  startTicks: number;
  /** Test seam: an injected snapshot can state the epoch start directly instead of deriving it from /proc/stat. */
  startedAtMs?: number;
}

export interface TreeObservation {
  /** Cumulative CPU of the root and every descendant, or null when the root cannot be read. */
  cpuNs: number | null;
  command: RunningCommand | null;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'mksh', 'ash', 'busybox']);
/** Command launchers the vendor CLIs sometimes exec without a shell. Shell-run commands need no entry here. */
const COMMAND_LAUNCHERS = new Set([
  'docker', 'docker-compose', 'podman', 'podman-compose', 'buildah', 'nerdctl',
  'pnpm', 'npm', 'npx', 'yarn', 'bun', 'bunx', 'corepack',
  'cargo', 'rustc', 'go', 'make', 'gmake', 'cmake', 'ninja', 'gradle', 'gradlew', 'mvn', 'mvnw',
  'pytest', 'tox', 'nox', 'uv', 'pip', 'pip3', 'poetry', 'deno',
  'systemd-run', 'terraform', 'tofu', 'kubectl', 'helm', 'ansible', 'ansible-playbook',
  'rsync', 'ssh', 'scp', 'git', 'sleep',
]);
/** LSP / language-service executables are vendor residents, not worker commands. */
const SERVICE_BINARIES = new Set([
  'gopls', 'rust-analyzer', 'clangd', 'clang-tidy', 'pyright-langserver', 'pylsp', 'jedi-language-server',
  'typescript-language-server', 'tsserver', 'vscode-json-language-server', 'vscode-css-language-server',
  'vscode-html-language-server', 'volar-language-server', 'vue-language-server', 'svelte-language-server',
  'sourcekit-lsp', 'jdtls', 'zls', 'solargraph', 'ruby-lsp', 'yamlls', 'lua-language-server',
  'bash-language-server', 'docker-langserver', 'intelephense', 'omnisharp', 'metals', 'hls', 'ocamllsp',
]);
/** MCP servers may be node/python/npx processes; their argv names the protocol or server. */
const SERVICE_ARGUMENT = /(?:^|[\s/_.@=-])(?:mcp(?:[-_]?server)?|model[-_]?context[-_]?protocol|language[-_]?server|lsp)(?:$|[\s/_.@=-])/i;
const SECRET_FLAG = /(--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|credential|authorization)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi;
const SECRET_ENV = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*=)(\S+)/g;
const SUMMARY_MAX = 300;

let cachedHz: number | undefined;
/** Kernel clock ticks per second; 100 is the Linux default and only a fallback. */
export function clockTicks(): number {
  if (cachedHz !== undefined) return cachedHz;
  try {
    const value = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 }).trim());
    cachedHz = Number.isFinite(value) && value > 0 ? value : 100;
  } catch { cachedHz = 100; }
  return cachedHz;
}

/** Epoch milliseconds of boot, from /proc/stat, so a process start tick can become a wall-clock start. */
export function bootTimeMs(): number | null {
  try {
    const match = /^btime\s+(\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
    return match ? Number(match[1]) * 1000 : null;
  } catch { return null; }
}

function argvOf(pid: number, comm: string): string[] {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    while (argv.length && argv[argv.length - 1] === '') argv.pop();
    if (argv.length) return argv;
  } catch { /* raced with exit */ }
  return comm ? [comm] : [];
}

/** One synchronous /proc scan. Callers on a tick share it across tasks. */
export function readProcessSnapshots(): ProcessSnapshot[] {
  const snapshots: ProcessSnapshot[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let stat: string;
    try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { continue; }
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const state = fields[0] ?? '';
    if (state === 'Z') continue;
    const ppid = Number(fields[1]);
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(startTicks)) continue;
    snapshots.push({ pid, ppid, argv: argvOf(pid, comm), state, utime, stime, startTicks });
  }
  return snapshots;
}

/** pid -> children, preserving the snapshot order. */
export function childrenIndex(snapshots: readonly ProcessSnapshot[]): Map<number, ProcessSnapshot[]> {
  const index = new Map<number, ProcessSnapshot[]>();
  for (const process of snapshots) {
    const list = index.get(process.ppid);
    if (list) list.push(process);
    else index.set(process.ppid, [process]);
  }
  return index;
}

/** The root and every live descendant reachable by ppid, breadth first. */
export function processTree(rootPid: number, snapshots: readonly ProcessSnapshot[]): ProcessSnapshot[] {
  const byParent = childrenIndex(snapshots);
  const byPid = new Map(snapshots.map(process => [process.pid, process]));
  const root = byPid.get(rootPid);
  if (!root) return [];
  const found: ProcessSnapshot[] = [];
  const queue: ProcessSnapshot[] = [root];
  const seen = new Set<number>();
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current.pid)) continue;
    seen.add(current.pid);
    found.push(current);
    for (const child of byParent.get(current.pid) ?? []) queue.push(child);
  }
  return found;
}

/** Cumulative CPU (ns) of the root and all descendants, including ones moved to another cgroup. */
export function processTreeCpuNs(rootPid: number, snapshots: readonly ProcessSnapshot[], hz = clockTicks()): number | null {
  const tree = processTree(rootPid, snapshots);
  if (!tree.length) return null;
  let ticks = 0;
  for (const process of tree) ticks += process.utime + process.stime;
  return Math.round((ticks * 1_000_000_000) / hz);
}

function isShell(process: ProcessSnapshot): boolean {
  return SHELLS.has(basename(process.argv[0] ?? '').toLowerCase());
}

function isService(process: ProcessSnapshot): boolean {
  const name = basename(process.argv[0] ?? '').toLowerCase();
  if (SERVICE_BINARIES.has(name)) return true;
  return SERVICE_ARGUMENT.test(process.argv.join(' '));
}

function isCommandLauncher(process: ProcessSnapshot): boolean {
  return COMMAND_LAUNCHERS.has(basename(process.argv[0] ?? '').toLowerCase());
}

/** A shell with an actual command string or script, not an idle persistent shell. */
function isShellCommand(process: ProcessSnapshot): boolean {
  return isShell(process) && process.argv.length > 1;
}

/**
 * Command roots under the vendor CLI. The direct child of the worker root is the vendor CLI itself;
 * every deeper process is considered only when it is run by a shell or is a known command launcher.
 * MCP/LSP/language-service processes and their whole subtree are vendor residents and are ignored.
 * Shell wrappers yield to their command child, so `bash -c 'docker build'` reports `docker build`.
 */
function commandCandidates(rootPid: number, snapshots: readonly ProcessSnapshot[]): ProcessSnapshot[] {
  const byParent = childrenIndex(snapshots);
  const candidates: ProcessSnapshot[] = [];
  const visit = (pid: number, insideShell: boolean, insideCommand: boolean): void => {
    for (const process of byParent.get(pid) ?? []) {
      if (isService(process)) continue;
      const shell = isShell(process);
      if (shell && isShellCommand(process) && !insideCommand) candidates.push(process);
      else if (!shell && !insideCommand && (insideShell || isCommandLauncher(process))) candidates.push(process);
      // A shell wrapper never suppresses its children; a real command does.
      visit(process.pid, insideShell || shell, insideCommand || (!shell && (insideShell || isCommandLauncher(process))));
    }
  };
  visit(rootPid, false, false);
  const shells = new Set(candidates.filter(isShellCommand).map(process => process.pid));
  return candidates.filter(process => !shells.has(process.pid) || !candidates.some(other => other !== process && isDescendant(process.pid, other.pid, snapshots)));
}

function isDescendant(ancestorPid: number, pid: number, snapshots: readonly ProcessSnapshot[]): boolean {
  const byPid = new Map(snapshots.map(process => [process.pid, process]));
  let cursor = byPid.get(pid);
  const seen = new Set<number>();
  while (cursor && !seen.has(cursor.pid)) {
    seen.add(cursor.pid);
    if (cursor.ppid === ancestorPid) return true;
    cursor = byPid.get(cursor.ppid);
  }
  return false;
}

/** argv0 and arguments only, bounded and stripped of credential-shaped values. */
export function commandSummary(argv: readonly string[]): string {
  const text = argv.map(part => part.replace(/\s+/g, ' ')).join(' ');
  const safe = redactSecrets(text.replace(SECRET_ENV, '$1[REDACTED]').replace(SECRET_FLAG, '$1[REDACTED]'));
  return safe.length <= SUMMARY_MAX ? safe : `${safe.slice(0, SUMMARY_MAX - 1)}…`;
}

/** The oldest live command under the worker root, or null. StartedAt uses /proc start ticks unless injected. */
export function observeProcessTree(rootPid: number, snapshots: readonly ProcessSnapshot[], now: number, hz = clockTicks(), boot = bootTimeMs()): TreeObservation {
  const cpuNs = processTreeCpuNs(rootPid, snapshots, hz);
  if (cpuNs === null) return { cpuNs: null, command: null };
  const candidate = commandCandidates(rootPid, snapshots).sort((a, b) => a.startTicks - b.startTicks || a.pid - b.pid)[0];
  if (!candidate) return { cpuNs, command: null };
  const startedAtMs = candidate.startedAtMs ?? (boot === null ? null : boot + (candidate.startTicks * 1000) / hz);
  const elapsedMs = startedAtMs === null ? 0 : Math.max(0, Math.round(now - startedAtMs));
  return {
    cpuNs,
    command: {
      pid: candidate.pid,
      summary: commandSummary(candidate.argv.length ? candidate.argv : [basename(candidate.argv[0] ?? 'command')]),
      startedAt: new Date(startedAtMs ?? now).toISOString(),
      elapsedMs,
    },
  };
}

/** The cgroup v2 path of a pid, or null when it cannot be read. */
export function cgroupPath(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n')[0] ?? '';
    const index = line.indexOf('::');
    return index < 0 ? null : line.slice(index + 2).trim() || null;
  } catch { return null; }
}

/** The unit whose scope a cgroup path names; null outside systemd scopes. */
export function unitOfCgroup(path: string | null): string | null {
  const name = path?.split('/').at(-1) ?? '';
  return name.endsWith('.scope') ? name.slice(0, -'.scope'.length) : null;
}

/** The unit whose scope a pid belongs to, from its own cgroup line; null outside systemd scopes. */
export function cgroupUnit(pid: number): string | null {
  return unitOfCgroup(cgroupPath(pid));
}

/** True when the pid's own cgroup names this scope; a cheap guard against a reused pid. */
export function pidInScope(pid: number, unit: string): boolean {
  return cgroupUnit(pid) === unit.replace(/\.scope$/, '');
}
