import { resolve } from 'node:path';
import { LocalIPCError } from '../../main/local-ipc';
import type { OutputFormat } from '../output';
import type { Envelope, ServerAction, ServerArgs, ServerEnv, ServerInfo, ServiceState } from './env';
import { serverInstall, serverStart, serverStatus, serverStop, serverUninstall } from './lifecycle';

export const SERVER_ACTIONS: readonly ServerAction[] = ['status', 'start', 'stop', 'install', 'uninstall'];
const START_TIMEOUT_SECONDS = 20;
const STOP_TIMEOUT_SECONDS = 60;

export const SERVER_HELP = `weaver server <status|start|stop|install|uninstall> [--port <0-65535>] [--data-dir <path>] [--output json|text] [--force] [--cancel-workers] [--timeout <seconds>]

Runs the Weaver control plane in the background, so a client keeps its endpoint after the command that started it returns. Port default 4737; data directory default $XDG_DATA_HOME/weaver or ~/.local/share/weaver.

  status     Report this data directory's server: running with pid, url, port, workers and service state, or stopped. Either way the exit code is 0.
  start      Start a background server and wait until it reports ready. A systemd or launchd service installed for the same port and data directory is started instead of spawning; otherwise this command detaches weaver web --no-open and appends its output to <data-dir>/server.log. --timeout is seconds, default 20.
  stop       Send SIGTERM to that server and wait for it to go away. Running workers keep running and reattach automatically after restart. --cancel-workers cancels running workers first (command-id server-stop-cancel-<taskId>) and waits until none remain; when --timeout expires it fails without signalling. --timeout is seconds, default 60.
  install    Install a user service that starts the server at login and keeps it running: ~/.config/systemd/user/weaver.service on Linux, ~/Library/LaunchAgents/dev.weaver.server.plist on macOS. Needs the standalone weaver executable.
  uninstall  Remove the service file weaver installed. A running server is left alone; on macOS running workers keep running and reattach, unless --cancel-workers cancels them first.

stop is a clean drain, so a service that only restarts on failure does not bring the server back. --output json is the default and writes one weaver.v1 envelope; text writes one line. Errors use the same format and exit 1.`;

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
  const usage = `Usage: weaver server <${SERVER_ACTIONS.join('|')}> [--port <0-65535>] [--data-dir <path>] [--output json|text] [--force] [--cancel-workers] [--timeout <seconds>]`;
  if (words.length !== 2 || !action || !SERVER_ACTIONS.includes(action)) throw new LocalIPCError('INVALID_ARGUMENT', usage);
  let port = env.defaultPort;
  let dataDir = env.defaultDataDir;
  let output: OutputFormat = 'json';
  let force = false;
  let cancelWorkers = false;
  let seconds: number | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === 'server' || arg === action) continue;
    if (!arg.startsWith('--')) throw new LocalIPCError('INVALID_ARGUMENT', `Unexpected argument ${arg}`);
    if (seen.has(arg)) throw new LocalIPCError('INVALID_ARGUMENT', `Duplicate option ${arg}`);
    seen.add(arg);
    if (arg === '--force') { force = true; continue; }
    if (arg === '--cancel-workers') { cancelWorkers = true; continue; }
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
  return { action: action!, port, dataDir, output, force, cancelWorkers, timeoutMs: (seconds ?? fallback) * 1000 };
}

function renderServerText(envelope: Envelope): string {
  const data = envelope.data as (ServerInfo & { status?: string; service?: ServiceState; alreadyRunning?: boolean; alreadyStopped?: boolean; running?: string; installed?: boolean; path?: string; manager?: string; workers?: number; note?: string; cancelledWorkers?: number }) | undefined;
  if (!data) return '';
  if (data.status === 'running') return `running ${data.url} pid ${data.pid} workers ${data.runningWorkers}${data.managedBy ? ` managed by ${data.managedBy}` : ''}${data.alreadyRunning ? ' (already running)' : ''}`;
  if (data.status === 'stopped') {
    if (data.alreadyStopped) return 'stopped (already stopped)';
    if (typeof data.cancelledWorkers === 'number') return `stopped (cancelled ${data.cancelledWorkers} ${data.cancelledWorkers === 1 ? 'worker' : 'workers'} first)`;
    return typeof data.workers === 'number' && data.workers > 0 ? `stopped (${data.workers} ${data.workers === 1 ? 'worker keeps' : 'workers keep'} running and reattach after restart)` : 'stopped';
  }
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
