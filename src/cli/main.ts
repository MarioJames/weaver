#!/usr/bin/env node
import { realpathSync, writeSync } from 'node:fs';
import { connect } from 'node:net';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { failure, LocalIPCError, MAX_FRAME_BYTES, readDiscovery, TRANSPORT_TIMEOUT_MS } from '../main/local-ipc';
import { startRuntime } from '../main/runtime';

export const DEFAULT_WEB_PORT = 4737;
export type OutputFormat = 'json' | 'jsonl' | 'text';
export interface CatalogCommand {
  command: string;
  mutation: boolean;
  usage: string;
  inputFields?: { required: Record<string,string>; optional?: Record<string,string>; notes?: string };
  rpc?: { method: string; arity: 0 | 1 };
  local?: 'wait' | 'watch';
}

/** One known catalog. Words join with dots; `engines set-enabled` stays hyphenated. */
export const CLI_CATALOG: CatalogCommand[] = [
  { command: 'capabilities.get', mutation: false, usage: 'capabilities | capabilities get' },
  { command: 'sync.snapshot', mutation: false, usage: 'sync snapshot' },
  { command: 'sync.status', inputFields: {"required": {}, "optional": {"after": "integer"}}, mutation: false, usage: 'sync status [--input <json>]' },
  { command: 'owners.list', mutation: false, usage: 'owners list' },
  { command: 'owners.get', inputFields: {"required": {"ownerId": "UUID"}, "optional": {}}, mutation: false, usage: 'owners get --input <json>' },
  { command: 'owners.continuation.get', inputFields: {"required": {"taskId": "UUID"}, "optional": {}}, mutation: false, usage: 'owners continuation get --task-id <id>' },
  { command: 'owners.attach', inputFields: {"required": {"name": "string (1–120)", "profileId": "available owner profile ID"}, "optional": {"session": "unverified reference string", "pane": "unverified reference string"}}, mutation: true, usage: 'owners attach --input <json> --command-id <id>    json: name, profileId, optional session, optional pane. Metadata only; verified stays false.' },
  { command: 'owners.spawn', inputFields: {"required": {"name": "string (1–120)", "profileId": "available owner profile ID"}, "optional": {"provider": "mock (explicit fixture only); omitted registers manual external owner", "session": "unverified reference string (manual only)", "pane": "unverified reference string (manual only)"}}, mutation: true, usage: 'owners spawn --input <json> --command-id <id>    json: name, profileId. Logical registration; no owner model and no session.' },
  { command: 'owners.switch', inputFields: {"required": {"taskId": "UUID", "expectedRevision": "integer"}, "optional": {"expectedEpoch": "integer", "reason": "manual | idle", "profileId": "available owner profile ID"}}, mutation: true, usage: 'owners switch --task-id <id> --input <json> --command-id <id>' },
  { command: 'owners.continuation.configure', inputFields: {"required": {"taskId": "UUID", "expectedRevision": "integer", "idleRotationMinutes": "integer 1–10080 | null"}, "optional": {}}, mutation: true, usage: 'owners continuation configure --task-id <id> --input <json> --command-id <id>' },
  { command: 'tasks.create', inputFields: {"required": {"title": "string (1–160)", "instruction | goal": "string (1–16000)", "ownerId | ownerProfileId | owner": "one existing logical owner UUID, profile ID, or legacy OwnerRef"}, "optional": {"workspace": "nonempty path; omitted uses caller cwd", "ownerName": "string (1–120)", "ownerProvider": "mock only when intentionally using mock Owner", "acceptanceCriteria": "string[] (≤30; each ≤1000)", "constraints": "string[] (≤30; each ≤1000)"}}, mutation: true, usage: 'tasks create --input <json> --command-id <id>' },
  { command: 'tasks.retry', inputFields: {"required": {"taskId": "UUID"}, "optional": {}}, mutation: true, usage: 'tasks retry --task-id <id> --command-id <id>' },
  { command: 'tasks.cancel', inputFields: {"required": {"taskId": "UUID"}, "optional": {"expectedRevision": "integer"}}, mutation: true, usage: 'tasks cancel --task-id <id> --command-id <id>' },
  { command: 'tasks.get', inputFields: {"required": {"taskId": "UUID"}, "optional": {}}, mutation: false, usage: 'tasks get --task-id <id>' },
  { command: 'tasks.list', inputFields: {"required": {}, "optional": {"offset": "integer ≥0 (default 0)", "limit": "integer 1–100 (default 25)", "ownerId": "UUID"}}, mutation: false, usage: 'tasks list [--input <json>]' },
  { command: 'tasks.events', inputFields: {"required": {"taskId": "UUID"}, "optional": {"after": "event cursor UUID", "limit": "integer 1–100 (default 50)"}}, mutation: false, usage: 'tasks events --task-id <id> [--input <json>]' },
  { command: 'tasks.results', inputFields: {"required": {"taskId": "UUID"}, "optional": {}}, mutation: false, usage: 'tasks results --task-id <id>' },
  { command: 'tasks.wait', inputFields: {"required": {"--task-id": "UUID"}, "optional": {"--for": "seconds 1–600 (default 30)"}}, mutation: false, local: 'wait', usage: 'tasks wait --task-id <id> [--for <seconds>]' },
  { command: 'tasks.watch', inputFields: {"required": {"--task-id": "UUID"}, "optional": {"--for": "seconds 1–600 (default 30)"}}, mutation: false, local: 'watch', usage: 'tasks watch --task-id <id> [--for <seconds>]' },
  { command: 'packages.create', inputFields: {"required": {"taskId": "UUID", "scope": "string[1–30] (each ≤1000)", "acceptanceCriteria": "string[1–30] (each ≤1000)"}, "optional": {"expectedRevision": "integer"}}, mutation: true, usage: 'packages create --task-id <id> --input <json> --command-id <id>' },
  { command: 'packages.get', inputFields: {"required": {"packageId": "UUID"}, "optional": {}}, mutation: false, usage: 'packages get --input <json>' },
  { command: 'workers.spawn', inputFields: {"required": {"taskId": "UUID"}, "optional": {"expectedRevision": "integer", "packageId": "frozen package UUID", "owner": "profile ID (must match task owner)", "worker": "explicit worker ID (excludes class)", "class": "mechanical | routine | judgment (default routine)", "tag": "judgment domain tag", "provider": "mock-jsonl only for explicit fixture execution"}}, mutation: true, usage: 'workers spawn --task-id <id> [--input <json>] --command-id <id>' },
  { command: 'results.deliver', inputFields: {"required": {"taskId": "UUID"}, "optional": {}}, mutation: true, usage: 'results deliver --task-id <id> --command-id <id>' },
  { command: 'results.ack', inputFields: {"required": {"taskId": "UUID", "expectedRevision": "integer", "manifestDigest": "current manifest SHA-256"}, "optional": {}}, mutation: true, usage: 'results ack --task-id <id> --input <json> --command-id <id>' },
  { command: 'reviews.submit', inputFields: {"required": {"taskId": "UUID", "expectedRevision": "integer", "manifestDigest": "current manifest SHA-256", "decision": "accepted | rejected"}, "optional": {"comment": "string (≤4000)"}}, mutation: true, usage: 'reviews submit --task-id <id> --input <json> --command-id <id>' },
  { command: 'artifacts.read', inputFields: {"required": {"taskId": "UUID", "artifactId": "UUID"}, "optional": {}}, mutation: false, usage: 'artifacts read --task-id <id> --input <json>' },
  { command: 'operations.get', inputFields: {"required": {"commandId": "stable mutation command ID"}, "optional": {}}, mutation: false, usage: 'operations get --command-id <id>' },
  { command: 'observability.get', inputFields: {"required": {"taskId": "UUID"}, "optional": {"kind": "event kind"}}, mutation: false, usage: 'observability get --task-id <id>' },
  { command: 'observability.export', inputFields: {"required": {"taskId": "UUID"}, "optional": {"kind": "event kind"}}, mutation: false, usage: 'observability export --task-id <id>' },
  { command: 'policy.get', mutation: false, rpc: { method: 'getPolicy', arity: 0 }, usage: 'policy get' },
  { command: 'policy.validate', inputFields: {"required": {"engines": "engine map", "owners": "owner profile map", "workers": "worker profile map", "herdr": "runtime wait settings"}, "optional": {}, "notes": "Body is the full policy config; inspect policy get and src/main/policy/config.schema.json for exact schema."}, mutation: false, rpc: { method: 'validatePolicy', arity: 1 }, usage: 'policy validate --input <config.json>' },
  { command: 'policy.save', inputFields: {"required": {"revision": "current policy revision integer", "config": "full policy config", "blocks": "quota block array (≤500)"}, "optional": {}}, mutation: true, rpc: { method: 'savePolicy', arity: 1 }, usage: 'policy save --input <save.json>' },
  { command: 'policy.preview', inputFields: {"required": {"owner": "owner profile ID"}, "optional": {"worker": "explicit worker ID", "class": "mechanical | routine | judgment", "tag": "judgment domain tag", "runningCount": "integer ≥0"}}, mutation: false, rpc: { method: 'previewRoute', arity: 1 }, usage: 'policy preview --input <preview.json>' },
  { command: 'engines.scan', mutation: false, rpc: { method: 'scanEngines', arity: 0 }, usage: 'engines scan' },
  { command: 'engines.set-enabled', inputFields: {"required": {"id": "engine ID", "enabled": "boolean", "revision": "current policy revision integer"}, "optional": {}}, mutation: true, rpc: { method: 'setEngineEnabled', arity: 1 }, usage: 'engines set-enabled --input <toggle.json>' },
];

for (const item of CLI_CATALOG) item.inputFields ??= { required: {} };

const catalogHelp = CLI_CATALOG.map(item => `  ${item.usage}`).join('\n');
export const CLI_HELP = `Weaver local control plane

  weaver web [--port <0-65535>] [--data-dir <path>] [--no-open] [--dev] [--output json|jsonl|text]
  weaver <command> [--data-dir <path>] [--output json|jsonl|text] [--input <file|->] [--command-id <id>] [--task-id <id>] [--for <seconds>]

weaver web runs one foreground control plane: loopback HTTP on 127.0.0.1 and the authenticated Unix CLI socket. Closing a browser does not stop tasks. Ctrl+C stops new work and cancels workers this process started. Task and policy files are kept. Default data directory: $XDG_DATA_HOME/weaver or ~/.local/share/weaver.

If a client command reports APP_NOT_RUNNING, start: weaver web --no-open

--output json writes one weaver.v1 envelope and is the default. jsonl writes one JSON object per line. text writes a short status line. --json is an alias of --output json. --json together with --output is rejected. Errors use the same format. The command does not write extra stdout.

tasks create: an omitted workspace becomes this CLI process's working directory before the request is sent. An explicit path wins. A relative explicit path is resolved against that same caller directory. The server does not fill a workspace from its own directory. Real dispatch still requires the directory to exist.

tasks wait and tasks watch poll tasks get and tasks events. --for is 1 through 600 seconds and defaults to 30. They do not start a second scheduler.

Mutations need --command-id, except policy save and engines set-enabled, which send the JSON body shown in their usage. operations get reads that same --command-id. owners attach stores a name and profile plus optional caller labels. It does not contact a host. owners spawn does not start an owner model. capabilities.realExecution means the worker launcher is loaded, not that a model ran or a login was proven. mock-jsonl is an explicit provider. A real route does not fall back to mock.

${catalogHelp}

Engine scan is PATH plus --version. It does not call a model.`;

const WEB_HELP = `weaver web [--port <0-65535>] [--data-dir <path>] [--no-open] [--dev] [--output json|jsonl|text]

  --port      Loopback port from 0 through 65535. 0 picks a free port. Default ${DEFAULT_WEB_PORT}.
  --data-dir  State directory. Default $XDG_DATA_HOME/weaver or ~/.local/share/weaver.
  --no-open   Do not open a browser.
  --dev       Serve the UI with Vite on the same loopback origin.
  --output    json or jsonl prints one weaver.v1 envelope with the ready URL. The default is one URL line.
  --json      Alias of --output json. Rejected together with --output.

Binds 127.0.0.1 only. Prints the URL after stores and endpoints are ready.`;

export function defaultDataDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'weaver');
}
export interface CLIOptions {
  command?: string;
  commandId?: string;
  input?: string;
  taskId?: string;
  dataDir: string;
  output: OutputFormat;
  forSeconds?: number;
}
function positionals(argv: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    if (['--input', '--command-id', '--data-dir', '--task-id', '--port', '--output', '--for'].includes(arg)) i++;
  }
  return words;
}
function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new LocalIPCError('INVALID_ARGUMENT', 'Port must be an integer from 0 through 65535');
  const port = Number(value);
  if (port > 65535) throw new LocalIPCError('INVALID_ARGUMENT', 'Port must be an integer from 0 through 65535');
  return port;
}
function takeOutput(argv: string[], index: number): { format: OutputFormat; next: number } {
  const value = argv[index];
  if (value !== 'json' && value !== 'jsonl' && value !== 'text') throw new LocalIPCError('INVALID_ARGUMENT', '--output must be json, jsonl, or text');
  return { format: value, next: index };
}
function parseWeb(argv: string[]): { port: number; dataDir: string; open: boolean; dev: boolean; output: OutputFormat; outputExplicit: boolean } {
  let port = DEFAULT_WEB_PORT;
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
    if (arg === '--port') port = parsePort(value);
    else dataDir = resolve(value);
  }
  if (jsonAlias && seen.has('--output')) throw new LocalIPCError('INVALID_ARGUMENT', '--json cannot be combined with --output');
  if (jsonAlias) output = 'json';
  return { port, dataDir, open, dev, output, outputExplicit };
}
function catalogCommand(words: string[]): CatalogCommand | undefined {
  if (words.length === 1 && words[0] === 'capabilities') return CLI_CATALOG.find(item => item.command === 'capabilities.get');
  const joined = words.join('.');
  return CLI_CATALOG.find(item => item.command === joined || (words.length === 1 && item.command === words[0]));
}
export function parseCLI(argv: string[]): CLIOptions {
  const options: CLIOptions = { dataDir: defaultDataDir(), output: 'json' };
  const words: string[] = [];
  const seen = new Set<string>();
  let output: OutputFormat | undefined;
  let jsonAlias = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    if (seen.has(arg)) throw new LocalIPCError('INVALID_ARGUMENT', `Duplicate option ${arg}`);
    seen.add(arg);
    if (arg === '--json') { jsonAlias = true; continue; }
    if (arg === '--output') { output = takeOutput(argv, ++i).format; continue; }
    if (arg === '--for') {
      const value = argv[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 600) throw new LocalIPCError('INVALID_ARGUMENT', '--for must be a whole number of seconds from 1 through 600');
      options.forSeconds = Number(value);
      continue;
    }
    const key = ({ '--input': 'input', '--command-id': 'commandId', '--data-dir': 'dataDir', '--task-id': 'taskId' } as const)[arg as '--input'];
    if (!key) throw new LocalIPCError('INVALID_ARGUMENT', `Unknown option ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new LocalIPCError('INVALID_ARGUMENT', `Missing value for ${arg}`);
    options[key] = value;
  }
  if (jsonAlias && output) throw new LocalIPCError('INVALID_ARGUMENT', '--json cannot be combined with --output');
  options.output = output ?? 'json';
  if (words.length) {
    const item = catalogCommand(words);
    if (!item) throw new LocalIPCError('INVALID_ARGUMENT', 'Unknown command. Run weaver --help for the catalog.');
    options.command = item.command;
  }
  if (!options.command && !options.input) throw new LocalIPCError('INVALID_ARGUMENT', 'A command or --input envelope is required');
  if (options.input && CLI_CATALOG.find(item => item.command === options.command)?.local) throw new LocalIPCError('INVALID_ARGUMENT', 'tasks wait/watch do not accept --input; use --task-id and --for');
  if (options.forSeconds !== undefined && !CLI_CATALOG.find(item => item.command === options.command)?.local) throw new LocalIPCError('INVALID_ARGUMENT', '--for is only valid for tasks wait and tasks watch');
  options.dataDir = resolve(options.dataDir);
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
/** Fill tasks create workspace from the CLI caller cwd before the request is submitted. */
export function applyCallerWorkspace(request: Record<string, unknown>, cwd: string): void {
  if (request.command !== 'tasks.create') return;
  const args = request.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  const record = args as Record<string, unknown>;
  const workspace = record.workspace;
  if (workspace === undefined) record.workspace = cwd;
  else if (typeof workspace !== 'string' || workspace.trim() === '') throw new LocalIPCError('INVALID_ARGUMENT', 'Explicit workspace must be a nonempty path string');
  else if (!isAbsolute(workspace)) record.workspace = resolve(cwd, workspace);
}
function renderData(data: unknown): string {
  if (!data || typeof data !== 'object') return data === undefined ? '' : String(data);
  const record = data as Record<string, unknown>;
  if (typeof record.status === 'string' && typeof record.title === 'string') return `${record.id ?? ''} ${record.status} ${record.title}`.trim();
  if (Array.isArray(record.tasks)) return record.tasks.map(item => renderData(item)).join('\n') || 'No tasks';
  if (Array.isArray(record.owners)) return record.owners.map(item => { const owner = item as Record<string, unknown>; return `${owner.id ?? ''} ${owner.name ?? ''} ${owner.state ?? ''}`.trim(); }).join('\n') || 'No owners';
  if (Array.isArray(record.events)) return record.events.map(item => { const event = item as Record<string, unknown>; return `${event.kind ?? 'event'}: ${event.message ?? ''}`; }).join('\n') || 'No events';
  return JSON.stringify(data);
}
export function renderEnvelope(format: OutputFormat, envelope: { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown; apiVersion?: string; commandId?: string | null }): string {
  if (format !== 'text') return JSON.stringify(envelope);
  if (envelope.ok === false) return `${envelope.error?.code ?? 'ERROR'}: ${envelope.error?.message ?? 'Command failed'}`;
  return renderData(envelope.data);
}
function writeEnvelope(format: OutputFormat, envelope: { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown; apiVersion?: string; commandId?: string | null }): void {
  process.stdout.write(renderEnvelope(format, envelope) + '\n');
}
export async function sendRequest(dataDir: string, request: unknown, timeoutMs = TRANSPORT_TIMEOUT_MS): Promise<unknown> {
  const deadline = Date.now() + Math.min(TRANSPORT_TIMEOUT_MS, timeoutMs);
  if(timeoutMs <= 0) throw new LocalIPCError('TIMEOUT', 'Bounded wait deadline reached');
  let endpoint: Awaited<ReturnType<typeof readDiscovery>>;
  try { endpoint = await readDiscovery(dataDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; start weaver web --no-open');
    if (error instanceof LocalIPCError) throw error;
    throw new LocalIPCError('UNSAFE_ENDPOINT', 'Could not safely read the app endpoint');
  }
  const remaining = deadline - Date.now();
  if(remaining <= 0) throw new LocalIPCError('TIMEOUT', 'Bounded wait deadline reached');
  const frame = JSON.stringify({ version: 1, token: endpoint.token, request }) + '\n';
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new LocalIPCError('INVALID_ARGUMENT', 'Request exceeds transport limit');
  return new Promise((resolvePromise, reject) => {
    const socket = connect(endpoint.discovery.socketPath);
    let bytes = Buffer.alloc(0);
    let settled = false;
    const done = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolvePromise(value); };
    const timer = setTimeout(() => done(new LocalIPCError('TIMEOUT', 'App did not respond; a submitted command may still be running. Retry with the same command ID')), remaining);
    socket.once('connect', () => socket.write(frame));
    socket.on('error', error => done(new LocalIPCError(['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '') ? 'APP_NOT_RUNNING' : 'TRANSPORT_ERROR', 'Could not connect to weaver web')));
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
async function pollTask(options: CLIOptions, mode: 'wait' | 'watch'): Promise<number> {
  const deadline = Date.now() + (options.forSeconds ?? 30) * 1000;
  const request = (command:string,args:Record<string,unknown>) => sendRequest(options.dataDir, makeRequest({...options,command},args), deadline-Date.now());
  let after: string | undefined;
  for (;;) {
    const snapshot = await request('tasks.get', {}) as { ok: boolean; data?: { status?: string } };
    if (!snapshot.ok) { writeEnvelope(options.output, snapshot); return 1; }
    if (mode === 'watch') {
      let more: boolean;
      do {
        const events = await request('tasks.events', {limit:100,...(after?{after}:{})}) as {ok:boolean;data?:{events?:{id?:string;kind?:string;message?:string}[];nextCursor?:string|null;hasMore?:boolean}};
        if (!events.ok) { writeEnvelope(options.output, events); return 1; }
        for (const item of events.data?.events ?? []) {
          if (options.output === 'jsonl') writeEnvelope('jsonl', {apiVersion:'weaver.v1',commandId:null,ok:true,data:item});
          else if (options.output === 'text') process.stdout.write(`${item.kind ?? 'event'}: ${item.message ?? ''}\n`);
        }
        more = events.data?.hasMore === true;
        const next = events.data?.nextCursor ?? events.data?.events?.at(-1)?.id;
        if(more && (!next || next===after)) throw new LocalIPCError('INVALID_RESPONSE','Event pagination did not advance');
        if(next) after=next;
      } while(more);
    }
    if (['completed','failed','cancelled'].includes(snapshot.data?.status ?? '')) {
      writeEnvelope(options.output,snapshot);return 0;
    }
    const remaining=deadline-Date.now();
    if(remaining<=0)throw new LocalIPCError('TIMEOUT','Stopped polling before the task reached a terminal state');
    await new Promise(resolveWait=>setTimeout(resolveWait,Math.min(250,remaining)));
  }
}
/** Read a valid requested format before parsing can fail, independent of flag ordering. */
function requestedOutput(argv:string[]):OutputFormat {
  const values=argv.flatMap((arg,index)=>arg==='--output'?[argv[index+1]]:[]);
  if(values.some(value=>!['json','jsonl','text'].includes(value)))return 'json';
  return values.at(-1) as OutputFormat ?? 'json';
}
function startupFailure(error: unknown, port: number): LocalIPCError {
  if (error instanceof LocalIPCError) return error;
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return new LocalIPCError('EADDRINUSE', `127.0.0.1:${port} is already in use. Stop the other process or choose a free port with --port.`);
  const raw = error instanceof Error ? error.message : 'Weaver could not start';
  const message = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 400);
  return new LocalIPCError('STARTUP_FAILED', message || 'Weaver could not start');
}
function readyLine(url: string, port: number, format: OutputFormat): string {
  if (format === 'text') return url + '\n';
  return JSON.stringify({ apiVersion: 'weaver.v1', commandId: null, ok: true, data: { url, port } }) + '\n';
}
export async function runCLI(argv: string[]): Promise<number> {
  let commandId: string | undefined;
  let errorFormat: OutputFormat = requestedOutput(argv);
  try {
    if (argv.includes('--help')) {
      const rest=argv.filter(arg=>arg!=='--help');
      const words=positionals(rest);
      if(words[0]==='web') {
        const web=parseWeb(rest);
        if(web.output==='text')process.stdout.write(WEB_HELP+'\n');
        else writeEnvelope(web.output,{apiVersion:'weaver.v1',ok:true,data:{command:'web',mutation:false,usage:WEB_HELP}});
      } else {
        const item=words.length?catalogCommand(words):undefined;
        if(words.length&&!item)throw new LocalIPCError('INVALID_ARGUMENT','Unknown command. Run weaver --help for the catalog.');
        parseCLI(item?rest:['capabilities',...rest]);
        if(errorFormat==='text'||(!rest.includes('--output')&&!rest.includes('--json'))) {
          process.stdout.write(item?`${item.usage}\nMutation: ${item.mutation}\nInput fields: ${JSON.stringify(item.inputFields,null,2)}\n`:CLI_HELP+'\n');
        } else writeEnvelope(errorFormat,{apiVersion:'weaver.v1',ok:true,data:item??{catalog:CLI_CATALOG}});
      }
      return 0;
    }
    const words = positionals(argv);
    if (words[0] === 'web') {
      if (words.length !== 1) throw new LocalIPCError('INVALID_ARGUMENT', 'Unexpected web arguments');
      const web = parseWeb(argv);
      if (web.outputExplicit) errorFormat = web.output;
      let runtime;
      try { runtime = await startRuntime({ dataDir: web.dataDir, port: web.port, open: web.open, dev: web.dev }); }
      catch (error) { throw startupFailure(error, web.port); }
      writeSync(process.stdout.fd, readyLine(runtime.url, runtime.port, web.output));
      const stop = () => { void runtime.close(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await runtime.done;
      return 0;
    }
    const options = parseCLI(argv);
    errorFormat = options.output;
    commandId = options.commandId;
    const item = CLI_CATALOG.find(entry => entry.command === options.command);
    if (item?.local) {
      if (!options.taskId) throw new LocalIPCError('INVALID_ARGUMENT', `${item.usage} requires --task-id`);
      return await pollTask(options, item.local);
    }
    const rpc = item?.rpc;
    let request: Record<string, unknown>;
    if (rpc) {
      if (options.commandId || options.taskId) throw new LocalIPCError('INVALID_ARGUMENT', 'Policy and engine commands do not take command or task IDs');
      if (rpc.arity === 1) {
        if (!options.input) throw new LocalIPCError('INVALID_ARGUMENT', 'This command requires --input');
        request = { method: rpc.method, args: [await readInput(options.input)] };
      } else if (options.input) throw new LocalIPCError('INVALID_ARGUMENT', 'This command does not take --input');
      else request = { method: rpc.method, args: [] };
    } else {
      request = makeRequest(options, options.input ? await readInput(options.input) : {});
      applyCallerWorkspace(request, process.cwd());
      if (request.command === 'operations.get' && options.commandId) {
        const args = request.args;
        if (args && typeof args === 'object' && !Array.isArray(args) && (args as Record<string, unknown>).commandId === undefined) (args as Record<string, unknown>).commandId = options.commandId;
      }
      commandId = typeof request.commandId === 'string' ? request.commandId : undefined;
    }
    const response = await sendRequest(options.dataDir, request) as { ok: boolean };
    writeEnvelope(options.output, response);
    return response.ok ? 0 : 1;
  } catch (error) {
    const code = error instanceof LocalIPCError ? error.code : 'CLI_ERROR';
    const message = error instanceof LocalIPCError ? error.message : 'Could not complete the CLI request';
    writeEnvelope(errorFormat, { ...failure(code, message), commandId: commandId ?? null });
    return 1;
  }
}
function isDirectEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    // npm bin links and --preserve-symlinks-main may name the same file differently.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    // Imported hosts can supply a non-file argv[1]; importing must not run the CLI.
    return false;
  }
}
if (isDirectEntry()) {
  void runCLI(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
