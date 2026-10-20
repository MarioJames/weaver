import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { embeddedApp } from '../main/embedded';
import { LocalIPCError, failure } from '../main/local-ipc';
import type { OutputFormat } from './main';

export type ServerAction = 'status' | 'start' | 'stop' | 'install' | 'uninstall';
export const SERVER_ACTIONS: readonly ServerAction[] = ['status', 'start', 'stop', 'install', 'uninstall'];
export const SERVICE_NAME = 'weaver.service';
export const LAUNCHD_LABEL = 'dev.weaver.server';
export const UNIT_MARKER = 'Managed by weaver server install';

const START_TIMEOUT_SECONDS = 20;
const STOP_TIMEOUT_SECONDS = 60;
const POLL_MS = 200;
const PROBE_MS = 2_000;
const LOG_TAIL_LINES = 20;
const LOG_TAIL_CHARS = 2_000;

export const SERVER_HELP = `weaver server <status|start|stop|install|uninstall> [--port <0-65535>] [--data-dir <path>] [--output json|text] [--force] [--timeout <seconds>]

Runs the Weaver control plane in the background, so a client keeps its endpoint after the command that started it returns. Port default 4737; data directory default $XDG_DATA_HOME/weaver or ~/.local/share/weaver.

  status     Report this data directory's server: running with pid, url, port, workers and service state, or stopped. Either way the exit code is 0.
  start      Start a background server and wait until it reports ready. A systemd or launchd service installed for the same port and data directory is started instead of spawning; otherwise this command detaches weaver web --no-open and appends its output to <data-dir>/server.log. --timeout is seconds, default 20.
  stop       Send SIGTERM to that server and wait for it to go away. Refused while workers are running unless --force, because stopping cancels them. --timeout is seconds, default 60.
  install    Install a user service that starts the server at login and keeps it running: ~/.config/systemd/user/weaver.service on Linux, ~/Library/LaunchAgents/dev.weaver.server.plist on macOS. Needs the standalone weaver executable.
  uninstall  Remove the service file weaver installed. A running server is left alone; on macOS running workers refuse the removal unless --force.

stop is a clean drain, so a service that only restarts on failure does not bring the server back. --output json is the default and writes one weaver.v1 envelope; text writes one line. Errors use the same format and exit 1.`;

export interface Envelope { apiVersion: string; commandId: string | null; ok: boolean; data?: unknown; error?: { code: string; message: string; retryable?: boolean } }
export interface ServerInfo {
  pid: number;
  url: string;
  port: number;
  dataDir: string;
  version: string;
  startedAt: string;
  runningWorkers: number;
  managedBy: 'systemd' | 'launchd' | null;
}
export interface ServiceState { installed: boolean; manager: 'systemd' | 'launchd' | null; path: string }
export interface RunResult { code: number | null; stdout: string; stderr: string }
export interface ServerArgs { action: ServerAction; port: number; dataDir: string; output: OutputFormat; force: boolean; timeoutMs: number }

/** Everything this module reaches outside itself, so tests never touch systemctl, launchd, or a real home. */
export interface ServerEnv {
  platform: string;
  home: string;
  env: Record<string, string | undefined>;
  uid: number;
  pid: number;
  standalone: boolean;
  execPath: string;
  execArgv: readonly string[];
  entryPath: string;
  cwd: string;
  defaultPort: number;
  defaultDataDir: string;
  request(dataDir: string, payload: unknown, timeoutMs: number): Promise<Envelope>;
  output(format: OutputFormat, envelope: Envelope): void;
  run(file: string, args: readonly string[]): Promise<RunResult>;
  spawnServer(command: readonly string[], dataDir: string, logPath: string): Promise<{ code: number | null }>;
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const succeed = (data: unknown): Envelope => ({ apiVersion: 'weaver.v1', commandId: null, ok: true, data });
const text = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function runText(result: RunResult): string {
  const detail = (result.stderr || result.stdout).trim().replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return detail ? detail.slice(0, 400) : `exit ${result.code ?? 'signal'}`;
}

export function serverEnv(links: { request: ServerEnv['request']; output: ServerEnv['output']; defaultPort: number; defaultDataDir: string }, overrides: Partial<ServerEnv> = {}): ServerEnv {
  const base: ServerEnv = {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    uid: process.getuid?.() ?? 0,
    pid: process.pid,
    standalone: Boolean(embeddedApp()),
    execPath: process.execPath,
    execArgv: process.execArgv,
    entryPath: process.argv[1] ?? '',
    cwd: process.cwd(),
    defaultPort: links.defaultPort,
    defaultDataDir: links.defaultDataDir,
    request: links.request,
    output: links.output,
    run: (file, args) => new Promise<RunResult>(resolveRun => {
      const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => { stdout += chunk; });
      child.stderr?.on('data', chunk => { stderr += chunk; });
      child.on('error', error => resolveRun({ code: null, stdout, stderr: error.message }));
      child.on('close', code => resolveRun({ code, stdout, stderr }));
    }),
    spawnServer: async (command, dataDir, logPath) => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const log = openSync(logPath, 'a', 0o600);
      try {
        const child = spawn(command[0]!, [...command.slice(1)], { cwd: process.cwd(), detached: true, stdio: ['ignore', log, log], shell: false });
        child.unref();
        return await new Promise<{ code: number | null }>(resolveSpawn => {
          child.on('error', () => resolveSpawn({ code: null }));
          child.on('close', code => resolveSpawn({ code }));
        });
      } finally { closeSync(log); }
    },
    kill: pid => { process.kill(pid, 'SIGTERM'); },
    sleep: ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
    now: () => Date.now(),
  };
  return { ...base, ...overrides };
}

/** A standalone executable runs itself; a checkout reruns this CLI entry with the same loader flags. */
export function selfCommand(args: readonly string[], env: ServerEnv): string[] {
  return env.standalone ? [env.execPath, ...args] : [env.execPath, ...env.execArgv, env.entryPath, ...args];
}
export function webArgs(port: number, dataDir: string): string[] {
  return ['web', '--no-open', '--port', String(port), '--data-dir', dataDir];
}
export function serverLogPath(dataDir: string): string {
  return join(dataDir, 'server.log');
}

const UNQUOTED = /^[A-Za-z0-9_@+=:,./-]+$/;
/** systemd doubles % for its own specifiers and needs quotes around anything else. */
export function systemdQuote(value: string): string {
  const escaped = value.replace(/%/g, '%%');
  if (escaped && UNQUOTED.test(escaped)) return escaped;
  return `"${escaped.replace(/[\\"]/g, '\\$&')}"`;
}
function systemdEnvironment(name: string, value: string): string {
  const assignment = `${name}=${value}`;
  return `Environment=${UNQUOTED.test(assignment) ? assignment : `"${assignment.replace(/[\\"]/g, '\\$&')}"`}`;
}

export function systemdUnit(command: readonly string[], env: ServerEnv): string {
  return [
    `# ${UNIT_MARKER}`,
    '[Unit]',
    'Description=Weaver local control plane',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${command.map(systemdQuote).join(' ')}`,
    systemdEnvironment('WEAVER_SERVICE', 'systemd'),
    systemdEnvironment('PATH', env.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'),
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function xmlPair(key: string, value: string): string[] {
  return [`  <key>${key}</key>`, `  <string>${xmlText(value)}</string>`];
}

export function launchdPlist(command: readonly string[], env: ServerEnv, logPath: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- ${UNIT_MARKER} -->`,
    '<plist version="1.0">',
    '<dict>',
    ...xmlPair('Label', LAUNCHD_LABEL),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...command.map(value => `    <string>${xmlText(value)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...xmlPair('PATH', env.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').map(line => `  ${line}`),
    ...xmlPair('WEAVER_SERVICE', 'launchd').map(line => `  ${line}`),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    ...xmlPair('StandardOutPath', logPath),
    ...xmlPair('StandardErrorPath', logPath),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Reverse of systemdQuote: enough of systemd's parser to read back a unit this command wrote. */
export function systemdTokens(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote === '"') {
      if (char === '\\') { current += line[++i] ?? ''; continue; }
      if (char === '"') { quote = undefined; continue; }
      current += char;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === '\\') { current += line[++i] ?? ''; started = true; continue; }
    if (char === ' ' || char === '\t') {
      if (started) { out.push(current.replace(/%%/g, '%')); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) out.push(current.replace(/%%/g, '%'));
  return out;
}

function xmlUnescape(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
export function plistStrings(content: string): string[] {
  return [...content.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => xmlUnescape(match[1]!));
}
/** The strings of the ProgramArguments array, in order. */
export function plistProgramArguments(content: string): string[] {
  const key = content.indexOf('<key>ProgramArguments</key>');
  const start = key < 0 ? -1 : content.indexOf('<array>', key);
  const end = start < 0 ? -1 : content.indexOf('</array>', start);
  return end < 0 ? [] : plistStrings(content.slice(start, end));
}

function readFileOrNull(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return; }
}
function marked(content: string | undefined): boolean {
  return content !== undefined && content.includes(UNIT_MARKER);
}

export function servicePath(env: ServerEnv): { manager: 'systemd' | 'launchd'; path: string } | undefined {
  if (env.platform === 'linux') return { manager: 'systemd', path: join(env.env.XDG_CONFIG_HOME || join(env.home, '.config'), 'systemd', 'user', SERVICE_NAME) };
  if (env.platform === 'darwin') return { manager: 'launchd', path: join(env.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`) };
  return;
}
function serviceState(env: ServerEnv): ServiceState {
  const layout = servicePath(env);
  if (!layout) return { installed: false, manager: null, path: '' };
  return { installed: marked(readFileOrNull(layout.path)), manager: layout.manager, path: layout.path };
}
/** The port and data directory an installed unit starts, so `start` can reuse the service. */
function unitValues(state: ServiceState): { port: number; dataDir: string } | undefined {
  const content = readFileOrNull(state.path);
  if (!marked(content)) return;
  let args: string[];
  if (state.manager === 'systemd') {
    const line = content!.split('\n').find(entry => entry.startsWith('ExecStart='));
    if (!line) return;
    args = systemdTokens(line.slice('ExecStart='.length));
  } else {
    args = plistProgramArguments(content!);
  }
  const flag = (name: string) => { const at = args.lastIndexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const port = flag('--port');
  const dataDir = flag('--data-dir');
  if (!port || !dataDir || !/^\d+$/.test(port)) return;
  return { port: Number(port), dataDir: resolve(dataDir) };
}

function isServerInfo(value: unknown): value is ServerInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isInteger(record.pid) && typeof record.url === 'string' && Number.isInteger(record.port) && typeof record.dataDir === 'string' &&
    typeof record.version === 'string' && typeof record.startedAt === 'string' && Number.isInteger(record.runningWorkers) &&
    (record.managedBy === null || record.managedBy === 'systemd' || record.managedBy === 'launchd');
}

type Probe = { state: 'running'; info: ServerInfo } | { state: 'stopped' } | { state: 'error'; code: string; message: string };

async function probeServer(env: ServerEnv, dataDir: string, timeoutMs = PROBE_MS): Promise<Probe> {
  let envelope: Envelope;
  try { envelope = await env.request(dataDir, { method: 'serverInfo', args: [] }, timeoutMs); }
  catch (error) {
    const code = error instanceof LocalIPCError ? error.code : 'TRANSPORT_ERROR';
    if (code === 'APP_NOT_RUNNING') return { state: 'stopped' };
    return { state: 'error', code, message: text(error) };
  }
  if (envelope.ok !== true) {
    return { state: 'error', code: envelope.error?.code ?? 'INTERNAL_ERROR', message: envelope.error?.message ?? 'Weaver returned an error' };
  }
  if (!isServerInfo(envelope.data)) return { state: 'error', code: 'INVALID_RESPONSE', message: 'Weaver returned an unexpected serverInfo record' };
  return { state: 'running', info: envelope.data };
}

function logTail(path: string): string {
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { return ''; }
  const tail = raw.split('\n').filter(Boolean).slice(-LOG_TAIL_LINES).join('\n');
  const clean = tail.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > LOG_TAIL_CHARS ? clean.slice(-LOG_TAIL_CHARS) : clean;
}

/** Waits for serverInfo, giving up early when the detached child exits or the deadline passes. */
async function waitForServer(env: ServerEnv, args: ServerArgs, exit?: { exited: boolean; code: number | null }): Promise<Envelope> {
  const logPath = serverLogPath(args.dataDir);
  const deadline = env.now() + args.timeoutMs;
  for (;;) {
    const probe = await probeServer(env, args.dataDir);
    if (probe.state === 'running') return succeed({ status: 'running', ...probe.info });
    if (exit?.exited) {
      const tail = logTail(logPath);
      return failure('SERVER_START_FAILED', `The server process exited (code ${exit.code ?? 'signal'}) before Weaver was ready.${tail ? ` Last output: ${tail}` : ''}`);
    }
    if (env.now() + POLL_MS >= deadline) return failure('SERVER_START_TIMEOUT', `Weaver did not report ready within ${Math.round(args.timeoutMs / 1000)}s.`);
    await env.sleep(POLL_MS);
  }
}

export async function serverStatus(env: ServerEnv, args: ServerArgs): Promise<Envelope> {
  const service = serviceState(env);
  const probe = await probeServer(env, args.dataDir);
  if (probe.state === 'running') return succeed({ status: 'running', ...probe.info, service });
  if (probe.state === 'stopped') return succeed({ status: 'stopped', service });
  return failure(probe.code, probe.message);
}

export async function serverStart(env: ServerEnv, args: ServerArgs): Promise<Envelope> {
  const current = await probeServer(env, args.dataDir);
  if (current.state === 'running') return succeed({ status: 'running', alreadyRunning: true, ...current.info });
  if (current.state === 'error') return failure(current.code, current.message);
  const service = serviceState(env);
  const managed = service.installed ? unitValues(service) : undefined;
  if (managed && managed.port === args.port && managed.dataDir === args.dataDir) {
    const launch = service.manager === 'systemd'
      ? await env.run('systemctl', ['--user', 'start', SERVICE_NAME])
      : await env.run('launchctl', ['kickstart', `gui/${env.uid}/${LAUNCHD_LABEL}`]);
    if (launch.code !== 0) return failure('SERVER_START_FAILED', `${service.manager === 'systemd' ? `systemctl --user start ${SERVICE_NAME}` : `launchctl kickstart gui/${env.uid}/${LAUNCHD_LABEL}`} failed: ${runText(launch)}`);
    return waitForServer(env, args);
  }
  const logPath = serverLogPath(args.dataDir);
  const watch = { exited: false, code: null as number | null };
  void env.spawnServer(selfCommand(webArgs(args.port, args.dataDir), env), args.dataDir, logPath).then(result => { watch.exited = true; watch.code = result.code; });
  return waitForServer(env, args, watch);
}

export async function serverStop(env: ServerEnv, args: ServerArgs): Promise<Envelope> {
  const current = await probeServer(env, args.dataDir);
  if (current.state === 'stopped') return succeed({ status: 'stopped', alreadyStopped: true });
  if (current.state === 'error') return failure(current.code, current.message);
  const { pid, runningWorkers } = current.info;
  if (runningWorkers > 0 && !args.force) return failure('SERVER_BUSY', `${runningWorkers} ${runningWorkers === 1 ? 'worker is' : 'workers are'} still running and stopping cancels them. Pass --force to stop anyway.`);
  if (!Number.isInteger(pid) || pid <= 0 || pid === env.pid) return failure('SERVER_STOP_FAILED', `Refusing to signal server pid ${pid}.`);
  try { env.kill(pid); } catch (error) { return failure('SERVER_STOP_FAILED', `Could not signal pid ${pid}: ${text(error)}`); }
  const deadline = env.now() + args.timeoutMs;
  for (;;) {
    const probe = await probeServer(env, args.dataDir);
    if (probe.state === 'stopped') return succeed({ status: 'stopped', pid });
    if (env.now() + POLL_MS >= deadline) return failure('SERVER_STOP_TIMEOUT', `Weaver was still running ${Math.round(args.timeoutMs / 1000)}s after SIGTERM to pid ${pid}.`);
    await env.sleep(POLL_MS);
  }
}

function writeUnit(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temp = `${path}.weaver-${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* A file that was never written needs no cleanup. */ }
    throw error;
  }
}

export async function serverInstall(env: ServerEnv, args: ServerArgs): Promise<Envelope> {
  if (!env.standalone) return failure('SERVER_INSTALL_UNSUPPORTED', 'weaver server install needs the installed standalone weaver; use weaver server start from a checkout.');
  const layout = servicePath(env);
  if (!layout) return failure('SERVER_INSTALL_UNSUPPORTED', `weaver server install does not support the ${env.platform} platform.`);
  const command = selfCommand(webArgs(args.port, args.dataDir), env);
  const content = layout.manager === 'systemd' ? systemdUnit(command, env) : launchdPlist(command, env, serverLogPath(args.dataDir));
  const existing = readFileOrNull(layout.path);
  if (existing !== undefined && !marked(existing) && !args.force)
    return failure('SERVER_UNIT_EXISTS', `A service file weaver did not install already exists at ${layout.path}. Pass --force to replace it.`);
  try { writeUnit(layout.path, content); }
  catch (error) { return failure('SERVER_INSTALL_FAILED', `Could not write ${layout.path}: ${text(error)}`); }
  const service: ServiceState = { installed: true, manager: layout.manager, path: layout.path };
  if (layout.manager === 'systemd') {
    for (const step of [['--user', 'daemon-reload'], ['--user', 'enable', SERVICE_NAME]]) {
      const result = await env.run('systemctl', step);
      if (result.code !== 0) return failure('SERVER_INSTALL_FAILED', `systemctl ${step.join(' ')} failed: ${runText(result)}`);
    }
  }
  const current = await probeServer(env, args.dataDir);
  if (current.state === 'running') {
    if (current.info.managedBy === layout.manager) return succeed({ ...service, running: 'managed', ...current.info });
    return succeed({ ...service, running: 'unmanaged', hint: 'weaver server stop && weaver server start' });
  }
  if (current.state === 'error') return succeed({ ...service, running: 'unknown', error: { code: current.code, message: current.message } });
  const launch = layout.manager === 'systemd'
    ? await env.run('systemctl', ['--user', 'start', SERVICE_NAME])
    : await env.run('launchctl', ['bootstrap', `gui/${env.uid}`, layout.path]);
  if (launch.code !== 0) {
    const label = layout.manager === 'systemd' ? `systemctl --user start ${SERVICE_NAME}` : `launchctl bootstrap gui/${env.uid}`;
    return failure('SERVER_INSTALL_FAILED', `${label} failed: ${runText(launch)}`);
  }
  const waited = await waitForServer(env, args);
  if (!waited.ok) return waited;
  return succeed({ ...service, running: 'started', ...(waited.data as object) });
}

export async function serverUninstall(env: ServerEnv, args: ServerArgs): Promise<Envelope> {
  const layout = servicePath(env);
  if (!layout) return failure('SERVER_INSTALL_UNSUPPORTED', `weaver server uninstall does not support the ${env.platform} platform.`);
  const existing = readFileOrNull(layout.path);
  if (existing === undefined) return succeed({ installed: false, manager: layout.manager, path: layout.path });
  if (!marked(existing)) return succeed({ installed: false, manager: layout.manager, path: layout.path, note: 'That file was not installed by weaver and was left in place.' });
  if (layout.manager === 'launchd') {
    const current = await probeServer(env, args.dataDir);
    const workers = current.state === 'running' ? current.info.runningWorkers : 0;
    if (workers > 0 && !args.force) return failure('SERVER_BUSY', `${workers} ${workers === 1 ? 'worker is' : 'workers are'} running under ${LAUNCHD_LABEL}. Pass --force to remove the service anyway.`);
    const result = await env.run('launchctl', ['bootout', `gui/${env.uid}/${LAUNCHD_LABEL}`]);
    if (result.code !== 0) return failure('SERVER_UNINSTALL_FAILED', `launchctl bootout gui/${env.uid}/${LAUNCHD_LABEL} failed: ${runText(result)}`);
  } else {
    const result = await env.run('systemctl', ['--user', 'disable', SERVICE_NAME]);
    if (result.code !== 0) return failure('SERVER_UNINSTALL_FAILED', `systemctl --user disable ${SERVICE_NAME} failed: ${runText(result)}`);
  }
  try { unlinkSync(layout.path); }
  catch (error) { return failure('SERVER_UNINSTALL_FAILED', `Could not remove ${layout.path}: ${text(error)}`); }
  if (layout.manager === 'systemd') {
    const reload = await env.run('systemctl', ['--user', 'daemon-reload']);
    if (reload.code !== 0) return failure('SERVER_UNINSTALL_FAILED', `systemctl --user daemon-reload failed: ${runText(reload)}`);
  }
  const running = await probeServer(env, args.dataDir);
  return succeed({ installed: false, manager: layout.manager, path: layout.path, running: running.state === 'running' });
}

export async function serverAction(env: ServerEnv, args: ServerArgs): Promise<Envelope> {
  switch (args.action) {
    case 'status': return serverStatus(env, args);
    case 'start': return serverStart(env, args);
    case 'stop': return serverStop(env, args);
    case 'install': return serverInstall(env, args);
    case 'uninstall': return serverUninstall(env, args);
  }
}

export function parseServer(argv: readonly string[], words: readonly string[], env: ServerEnv): ServerArgs {
  const action = words[1] as ServerAction | undefined;
  const usage = `Usage: weaver server <${SERVER_ACTIONS.join('|')}> [--port <0-65535>] [--data-dir <path>] [--output json|text] [--force] [--timeout <seconds>]`;
  if (words.length !== 2 || !action || !SERVER_ACTIONS.includes(action)) throw new LocalIPCError('INVALID_ARGUMENT', usage);
  let port = env.defaultPort;
  let dataDir = env.defaultDataDir;
  let output: OutputFormat = 'json';
  let force = false;
  let seconds: number | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === 'server' || arg === action) continue;
    if (!arg.startsWith('--')) throw new LocalIPCError('INVALID_ARGUMENT', `Unexpected argument ${arg}`);
    if (seen.has(arg)) throw new LocalIPCError('INVALID_ARGUMENT', `Duplicate option ${arg}`);
    seen.add(arg);
    if (arg === '--force') { force = true; continue; }
    if (arg === '--output') {
      const value = argv[++i];
      if (value !== 'json' && value !== 'text') throw new LocalIPCError('INVALID_ARGUMENT', '--output must be json or text');
      output = value;
      continue;
    }
    if (arg !== '--port' && arg !== '--data-dir' && arg !== '--timeout') throw new LocalIPCError('INVALID_ARGUMENT', `Unknown option ${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new LocalIPCError('INVALID_ARGUMENT', `Missing value for ${arg}`);
    i++;
    if (arg === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new LocalIPCError('INVALID_ARGUMENT', 'Port must be an integer from 0 through 65535');
      port = Number(value);
    } else if (arg === '--data-dir') dataDir = resolve(value);
    else {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 600) throw new LocalIPCError('INVALID_ARGUMENT', '--timeout must be a whole number of seconds from 1 through 600');
      seconds = Number(value);
    }
  }
  const fallback = action === 'stop' ? STOP_TIMEOUT_SECONDS : START_TIMEOUT_SECONDS;
  return { action: action!, port, dataDir, output, force, timeoutMs: (seconds ?? fallback) * 1000 };
}

function renderServerText(envelope: Envelope): string {
  const data = envelope.data as (ServerInfo & { status?: string; service?: ServiceState; alreadyRunning?: boolean; alreadyStopped?: boolean; running?: string; installed?: boolean; path?: string; manager?: string }) | undefined;
  if (!data) return '';
  if (data.status === 'running') return `running ${data.url} pid ${data.pid} workers ${data.runningWorkers}${data.managedBy ? ` managed by ${data.managedBy}` : ''}${data.alreadyRunning ? ' (already running)' : ''}`;
  if (data.status === 'stopped') return data.alreadyStopped ? 'stopped (already stopped)' : 'stopped';
  if (data.running) return `${data.manager} service at ${data.path}: ${data.running}`;
  if (typeof data.installed === 'boolean') return `${data.installed ? 'installed' : 'not installed'} ${data.manager ?? ''} ${data.path ?? ''}`.trim();
  return JSON.stringify(data);
}

export async function runServer(argv: readonly string[], words: readonly string[], env: ServerEnv): Promise<number> {
  const args = parseServer(argv, words, env);
  const envelope = await serverAction(env, args);
  env.output(args.output, args.output === 'text' ? { ...envelope, data: renderServerText(envelope) } : envelope);
  return envelope.ok ? 0 : 1;
}
