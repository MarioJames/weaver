#!/usr/bin/env node
import { connect } from 'node:net';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { failure, LocalIPCError, MAX_FRAME_BYTES, readDiscovery, TRANSPORT_TIMEOUT_MS } from '../main/local-ipc';

export function defaultUserData(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'weaver-desktop');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'weaver-desktop');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'weaver-desktop');
}
export interface CLIOptions { command?: string; commandId?: string; input?: string; taskId?: string; userData: string }
export function parseCLI(argv: string[]): CLIOptions {
  const options: CLIOptions = { userData: defaultUserData() };
  const words: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    if (seen.has(arg)) throw new LocalIPCError('INVALID_ARGUMENT', `Duplicate option ${arg}`);
    seen.add(arg);
    if (arg === '--json' || arg === '--no-input') continue;
    const key = ({ '--input': 'input', '--command-id': 'commandId', '--user-data': 'userData', '--task-id': 'taskId' } as const)[arg as '--input'];
    if (!key) throw new LocalIPCError('INVALID_ARGUMENT', `Unknown option ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new LocalIPCError('INVALID_ARGUMENT', `Missing value for ${arg}`);
    options[key] = value;
  }
  if (words.length === 1 && words[0] === 'capabilities') options.command = 'capabilities.get';
  else if (words.length === 2) options.command = words.join('.');
  else if (words.length === 1 && /^[a-z]+\.[a-z]+$/.test(words[0])) options.command = words[0];
  else if (words.length !== 0) throw new LocalIPCError('INVALID_ARGUMENT', 'Use a command such as tasks create or capabilities');
  if (!options.command && !options.input) throw new LocalIPCError('INVALID_ARGUMENT', 'A command or --input envelope is required');
  options.userData = resolve(options.userData);
  return options;
}
async function readInput(path: string): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const add = (chunk: Buffer) => { size += chunk.length; if (size > MAX_FRAME_BYTES - 1024) throw new LocalIPCError('INVALID_ARGUMENT', 'Input exceeds transport limit'); chunks.push(chunk); };
  if (path === '-') {
    for await (const chunk of process.stdin) add(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  } else {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_FRAME_BYTES - 1024) throw new LocalIPCError('INVALID_ARGUMENT', 'Input must be a regular JSON file within transport limit');
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) { const { bytesRead } = await file.read(buffer); if (!bytesRead) break; add(Buffer.from(buffer.subarray(0, bytesRead))); }
    } finally { await file.close(); }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new LocalIPCError('INVALID_ARGUMENT', 'Input must contain valid JSON'); }
}
export function makeRequest(options: CLIOptions, input: unknown = {}): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LocalIPCError('INVALID_ARGUMENT', 'Input must be a JSON object');
  const object = input as Record<string, unknown>;
  const isEnvelope = 'apiVersion' in object || 'command' in object;
  const envelope: Record<string, unknown> = isEnvelope ? { ...object } : { apiVersion: 'weaver.v1', command: options.command, args: object };
  if (options.command && isEnvelope && envelope.command !== options.command) throw new LocalIPCError('INVALID_ARGUMENT', 'Input command does not match CLI command');
  if (options.commandId && envelope.commandId && envelope.commandId !== options.commandId) throw new LocalIPCError('INVALID_ARGUMENT', 'Input command ID does not match CLI command ID');
  envelope.commandId = options.commandId || envelope.commandId || randomUUID();
  if (options.taskId) {
    const args = envelope.args ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new LocalIPCError('INVALID_ARGUMENT', 'Request args must be an object');
    if ('taskId' in args && args.taskId !== options.taskId) throw new LocalIPCError('INVALID_ARGUMENT', 'Input task ID does not match CLI task ID');
    envelope.args = { ...args, taskId: options.taskId };
  }
  return envelope;
}
export async function sendRequest(userData: string, request: unknown): Promise<unknown> {
  let endpoint: Awaited<ReturnType<typeof readDiscovery>>;
  try { endpoint = await readDiscovery(userData); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; open the desktop app first');
    if (error instanceof LocalIPCError) throw error;
    throw new LocalIPCError('UNSAFE_ENDPOINT', 'Could not safely read the app endpoint');
  }
  const frame = JSON.stringify({ version: 1, token: endpoint.token, request }) + '\n';
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new LocalIPCError('INVALID_ARGUMENT', 'Request exceeds transport limit');
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint.discovery.socketPath);
    let bytes = Buffer.alloc(0);
    let settled = false;
    const done = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => done(new LocalIPCError('TIMEOUT', 'App did not respond; a submitted command may still be running. Retry with the same command ID')), TRANSPORT_TIMEOUT_MS);
    socket.once('connect', () => socket.write(frame));
    socket.on('error', error => done(new LocalIPCError(['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '') ? 'APP_NOT_RUNNING' : 'TRANSPORT_ERROR', 'Could not connect to the desktop app')));
    socket.on('data', raw => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (bytes.length + chunk.length > MAX_FRAME_BYTES) return done(new LocalIPCError('INVALID_RESPONSE', 'App response exceeds transport limit'));
      bytes = Buffer.concat([bytes, chunk]);
      const end = bytes.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(bytes.subarray(0, end).toString('utf8'));
        if (end !== bytes.length - 1 || response.apiVersion !== 'weaver.v1' || typeof response.ok !== 'boolean') throw new Error();
        done(undefined, response);
      } catch { done(new LocalIPCError('INVALID_RESPONSE', 'App returned an invalid response')); }
    });
    socket.once('close', () => { if (!settled) done(new LocalIPCError('TRANSPORT_ERROR', 'App disconnected; a submitted command may still be running')); });
  });
}
export async function runCLI(argv: string[]): Promise<number> {
  let commandId: string | undefined;
  try {
    const options = parseCLI(argv);
    const request = makeRequest(options, options.input ? await readInput(options.input) : {});
    commandId = typeof request.commandId === 'string' ? request.commandId : undefined;
    const response = await sendRequest(options.userData, request) as { ok: boolean };
    process.stdout.write(JSON.stringify(response) + '\n');
    return response.ok ? 0 : 1;
  } catch (error) {
    const code = error instanceof LocalIPCError ? error.code : 'CLI_ERROR';
    const message = error instanceof LocalIPCError ? error.message : 'Could not complete the CLI request';
    process.stdout.write(JSON.stringify({ ...failure(code, message), commandId: commandId ?? null }) + '\n');
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCLI(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
