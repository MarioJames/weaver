import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { LocalIPCError } from '../../main/local-ipc';
import { sendRequest } from '../client';
import { writeEnvelope, type OutputFormat } from '../output';
import { DEFAULT_WEB_PORT, defaultDataDir, parsePort, takeOutput } from '../parse';

export const WEB_HELP = `weaver web [--port <0-65535>] [--data-dir <path>] [--no-open] [--dev] [--output json|jsonl|text]

  --port      Loopback port from 0 through 65535. 0 picks a free port. Default ${DEFAULT_WEB_PORT}.
  --data-dir  State directory. Default $XDG_DATA_HOME/weaver or ~/.local/share/weaver.
  --no-open   Do not open a browser.
  --dev       Serve the UI with Vite on the same loopback origin.
  --output    json or jsonl prints one weaver.v1 envelope with the ready URL. The default is one URL line.
  --json      Alias of --output json. Rejected together with --output.

Binds 127.0.0.1 only. Prints the URL after stores and endpoints are ready.`;

export function parseWeb(argv: string[]): { port: number; portExplicit: boolean; dataDir: string; open: boolean; dev: boolean; output: OutputFormat; outputExplicit: boolean } {
  let port = DEFAULT_WEB_PORT;
  let portExplicit = false;
  let dataDir = defaultDataDir();
  let open = true;
  let dev = false;
  let output: OutputFormat = 'text';
  let outputExplicit = false;
  let jsonAlias = false;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'web') continue;
    if (!arg.startsWith('--')) throw new LocalIPCError('INVALID_ARGUMENT', `Unexpected argument ${arg}`);
    if (seen.has(arg)) throw new LocalIPCError('INVALID_ARGUMENT', `Duplicate option ${arg}`);
    seen.add(arg);
    if (arg === '--no-open') { open = false; continue; }
    if (arg === '--dev') { dev = true; continue; }
    if (arg === '--json') { jsonAlias = true; outputExplicit = true; continue; }
    if (arg === '--output') {
      output = takeOutput(argv, ++i).format;
      outputExplicit = true;
      continue;
    }
    if (arg !== '--port' && arg !== '--data-dir') throw new LocalIPCError('INVALID_ARGUMENT', `Unknown option ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new LocalIPCError('INVALID_ARGUMENT', `Missing value for ${arg}`);
    if (arg === '--port') { port = parsePort(value); portExplicit = true; }
    else dataDir = resolve(value);
  }
  if (jsonAlias && seen.has('--output')) throw new LocalIPCError('INVALID_ARGUMENT', '--json cannot be combined with --output');
  if (jsonAlias) output = 'json';
  return { port, portExplicit, dataDir, open, dev, output, outputExplicit };
}
function startupFailure(error: unknown, port: number): LocalIPCError {
  if (error instanceof LocalIPCError) return error;
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return new LocalIPCError('EADDRINUSE', `127.0.0.1:${port} is already in use. Stop the other process or choose a free port with --port.`);
  const raw = error instanceof Error ? error.message : 'Weaver could not start';
  const message = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 400);
  return new LocalIPCError('STARTUP_FAILED', message || 'Weaver could not start');
}
function readyLine(url: string, port: number, format: OutputFormat, extra: Record<string, unknown> = {}): string {
  if (format === 'text') return url + '\n';
  return JSON.stringify({ apiVersion: 'weaver.v1', commandId: null, ok: true, data: { url, port, ...extra } }) + '\n';
}
type RunningInfo = { data: { url: string; port: number } & Record<string, unknown> };
async function checkRunning(dataDir: string): Promise<RunningInfo | undefined> {
  try {
    const response = await sendRequest(dataDir, { method: 'serverInfo', args: [] }, 2000) as { ok?: boolean; data?: unknown };
    const info = response.ok === true && response.data && typeof response.data === 'object' ? response.data as RunningInfo['data'] : undefined;
    if (typeof info?.url === 'string' && info.url && typeof info.port === 'number' && Number.isInteger(info.port) && info.port > 0) return { data: info };
  } catch { /* unreadable endpoints fall through to a normal start */ }
  return undefined;
}
/** `weaver web --help`: the text, or one envelope carrying the usage. */
export function writeWebHelp(rest: string[]): void {
  const web = parseWeb(rest);
  if (web.output === 'text') process.stdout.write(WEB_HELP + '\n');
  else writeEnvelope(web.output, { apiVersion: 'weaver.v1', ok: true, data: { command: 'web', mutation: false, usage: WEB_HELP } });
}

/**
 * Foreground signal wiring for `weaver web`. The first SIGINT/SIGTERM starts the runtime's close once; every
 * further signal joins that same promise instead of calling close again. The exit code comes from the real
 * close result — `done` settles earlier than close, so awaiting it alone would turn a failed shutdown into a
 * fake success. A close failure is reported as a static line (the runtime already logs the concrete cause) and
 * a non-zero exit code. Whether shutdown succeeds or fails, this run's signal listeners are removed on the way
 * out and none of the awaited rejections stays unhandled.
 */
export async function runForegroundShutdown(runtime: { done: Promise<void>; close(): Promise<void> }): Promise<number> {
  let closing: Promise<void> | undefined;
  const closeOnce = (): Promise<void> => { closing ??= runtime.close(); return closing; };
  const onSignal = (): void => { void closeOnce().catch(() => { /* the outcome is read below from `closing`. */ }); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await runtime.done;
    if (closing !== undefined) {
      try { await closing; }
      catch { writeSync(process.stderr.fd, 'Weaver stopped, but shutdown reported an error\n'); return 1; }
    }
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/** Run the service in the foreground. The runtime is loaded here, so client commands never pull in the server. */
export async function runWeb(argv: string[], words: string[], setErrorFormat: (format: OutputFormat) => void): Promise<number> {
  if (words.length !== 1) throw new LocalIPCError('INVALID_ARGUMENT', 'Unexpected web arguments');
  const web = parseWeb(argv);
  if (web.outputExplicit) setErrorFormat(web.output);
  const running = await checkRunning(web.dataDir);
  if (running) {
    const extra: Record<string, unknown> = { alreadyRunning: true };
    if (web.portExplicit && running.data.port !== web.port) extra.note = `A Weaver service is already running on port ${running.data.port}; using its URL instead of the requested port ${web.port}`;
    if (web.open) (await import('../../main/runtime')).openBrowser(running.data.url);
    writeSync(process.stdout.fd, readyLine(running.data.url, running.data.port, web.output, extra));
    return 0;
  }
  let runtime;
  try { runtime = await (await import('../../main/runtime')).startRuntime({ dataDir: web.dataDir, port: web.port, open: web.open, dev: web.dev }); }
  catch (error) { throw startupFailure(error, web.port); }
  writeSync(process.stdout.fd, readyLine(runtime.url, runtime.port, web.output));
  return await runForegroundShutdown(runtime);
}
