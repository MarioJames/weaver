import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { LocalIPCError, MAX_FRAME_BYTES } from '../main/local-ipc';
import type { CatalogCommand } from './catalog';
import { applyOwnerAuth, rejectOwnerAuthArg, type OwnerAuth } from './owner-identity';
import type { CLIOptions } from './parse';

/** --input is a JSON file, "-" for stdin, or the JSON object itself when it starts with "{". */
export async function readInput(path: string): Promise<unknown> {
  if (path.trimStart().startsWith('{')) {
    if (Buffer.byteLength(path) > MAX_FRAME_BYTES - 1024) throw new LocalIPCError('INVALID_ARGUMENT', 'Input exceeds transport limit');
    try { return JSON.parse(path); } catch { throw new LocalIPCError('INVALID_ARGUMENT', 'Inline --input must be valid JSON'); }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const add = (chunk: Buffer) => { size += chunk.length; if (size > MAX_FRAME_BYTES - 1024) throw new LocalIPCError('INVALID_ARGUMENT', 'Input exceeds transport limit'); chunks.push(chunk); };
  if (path === '-') {
    for await (const chunk of process.stdin) add(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  } else {
    let file;
    try { file = await open(path, 'r'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new LocalIPCError('INVALID_ARGUMENT', code === 'ENOENT' ? `Input file not found: ${path}. Pass a JSON file, - for stdin, or the JSON object itself.` : `Input file could not be read (${code ?? 'error'}): ${path}`);
    }
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
/** Read review text literally; never parse it as JSON or expand shell escapes. */
export async function readCommentFile(path: string): Promise<string> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch { throw new LocalIPCError('INVALID_ARGUMENT', `Comment file could not be read: ${path}`); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16000) throw new LocalIPCError('INVALID_ARGUMENT', 'Comment file must be a regular UTF-8 text file of at most 4000 characters');
    // Bound the read even if another process grows the file after stat.
    const buffer = Buffer.alloc(16001);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    let comment: string;
    try { comment = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
    catch { throw new LocalIPCError('INVALID_ARGUMENT', 'Comment file must contain valid UTF-8 text'); }
    if (length > 16000 || comment.length > 4000) throw new LocalIPCError('INVALID_ARGUMENT', 'Comment file exceeds 4000 characters');
    return comment;
  } finally { await file.close(); }
}
/** Put one convenience flag into request args, refusing to overwrite a different --input value. */
export function mergeArg(envelope: Record<string, unknown>, key: string, value: unknown, label: string): void {
  const args = envelope.args ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new LocalIPCError('INVALID_ARGUMENT', 'Request args must be an object');
  const record = args as Record<string, unknown>;
  if (key in record && record[key] !== value) throw new LocalIPCError('INVALID_ARGUMENT', `Input ${label} does not match CLI ${label}`);
  envelope.args = { ...record, [key]: value };
}
export function makeRequest(options: CLIOptions, input: unknown = {}, ownerAuth?: OwnerAuth): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LocalIPCError('INVALID_ARGUMENT', 'Input must be a JSON object');
  const object = input as Record<string, unknown>;
  const isEnvelope = 'apiVersion' in object || 'command' in object;
  const envelope: Record<string, unknown> = isEnvelope ? { ...object } : { apiVersion: 'weaver.v1', command: options.command, args: object };
  if (options.command && isEnvelope && envelope.command !== options.command) throw new LocalIPCError('INVALID_ARGUMENT', 'Input command does not match CLI command');
  const requestArgs = envelope.args;
  if (requestArgs && typeof requestArgs === 'object' && !Array.isArray(requestArgs)) rejectOwnerAuthArg(requestArgs as Record<string, unknown>);
  if (options.commandId && envelope.commandId && envelope.commandId !== options.commandId) throw new LocalIPCError('INVALID_ARGUMENT', 'Input command ID does not match CLI command ID');
  envelope.commandId = options.commandId || envelope.commandId || randomUUID();
  if (options.scheduleId !== undefined) mergeArg(envelope, 'scheduleId', options.scheduleId, 'schedule ID');
  if (options.taskId) mergeArg(envelope, 'taskId', options.taskId, 'task ID');
  if (options.engine !== undefined) mergeArg(envelope, 'engine', options.engine, 'engine');
  if (options.worker !== undefined) mergeArg(envelope, 'worker', options.worker, 'worker');
  if (options.cancel) mergeArg(envelope, 'cancel', true, 'cancel');
 if (options.refresh) mergeArg(envelope, 'refresh', true, 'refresh');
  for (const key of ['expectedRevision', 'manifestDigest', 'decision', 'comment'] as const) {
    if (options[key] !== undefined) mergeArg(envelope, key, options[key], key);
  }
  applyOwnerAuth(envelope, ownerAuth);
  return envelope;
}
/** Caller cwd convenience: tasks.create roots default to it (children inherit); schedules.create stays optional. */
export function applyCallerWorkspace(request: Record<string, unknown>, cwd: string): void {
  const args = request.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  const record = args as Record<string, unknown>;
  if (request.command === 'schedules.create') {
    // An omitted schedule workspace stays omitted so creation is not bound to the caller repo;
    // an explicit blank string passes through for the server to normalize to unspecified.
    // Only a non-blank relative path uses the CLI convenience resolution; absolute paths,
    // null and non-string values pass through untouched so the server reports the real error.
    const workspace = record.workspace;
    if (typeof workspace === 'string' && workspace.trim() !== '' && !isAbsolute(workspace)) record.workspace = resolve(cwd, workspace);
    return;
  }
  if (request.command !== 'tasks.create') return;
  const workspace = record.workspace;
  if (workspace === undefined) { if (record.parentTaskId === undefined) record.workspace = cwd; }
  else if (typeof workspace !== 'string' || workspace.trim() === '') throw new LocalIPCError('INVALID_ARGUMENT', 'Explicit workspace must be a nonempty path string');
  else if (!isAbsolute(workspace)) record.workspace = resolve(cwd, workspace);
}

/** The request one CLI invocation sends: a direct RPC call for policy, engine, quota and probe commands, otherwise a weaver.v1 command envelope. */
export async function buildRequest(options: CLIOptions, item: CatalogCommand | undefined, ownerAuth?: OwnerAuth): Promise<Record<string, unknown>> {
  const rpc = item?.rpc;
  let request: Record<string, unknown>;
  if (rpc) {
    if (options.commandId || options.taskId) throw new LocalIPCError('INVALID_ARGUMENT', 'Policy, engine, quota, probe, and janitor commands do not take command or task IDs');
    if (rpc.arity === 1) {
      if (!options.input && item!.command !== 'quota.refresh' && item!.command !== 'workers.probe' && item!.command !== 'janitor.sweep' && !(item!.command === 'engines.models' && options.engine !== undefined)) throw new LocalIPCError('INVALID_ARGUMENT', 'This command requires --input');
      const body = options.input ? await readInput(options.input) : {};
      if (body && typeof body === 'object' && !Array.isArray(body)) rejectOwnerAuthArg(body as Record<string, unknown>);
      if (options.worker !== undefined || options.engine !== undefined || options.refresh || options.dryRun) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LocalIPCError('INVALID_ARGUMENT', 'Input must be a JSON object');
        // Same merge and conflict rule as makeRequest: a flag never overwrites a different --input value.
        const holder: Record<string, unknown> = { args: body };
        if (options.worker !== undefined) mergeArg(holder, 'worker', options.worker, 'worker');
        if (options.engine !== undefined) mergeArg(holder, 'engine', options.engine, 'engine');
        if (options.refresh) mergeArg(holder, 'refresh', true, 'refresh');
        if (options.dryRun) mergeArg(holder, 'dryRun', true, 'dry run');
        request = { method: rpc.method, args: [holder.args] };
      } else request = { method: rpc.method, args: [body] };
    } else if (options.input) throw new LocalIPCError('INVALID_ARGUMENT', 'This command does not take --input');
    else request = { method: rpc.method, args: [] };
  } else {
    request = makeRequest(options, options.input ? await readInput(options.input) : {}, ownerAuth);
    applyCallerWorkspace(request, process.cwd());
    if (request.command === 'operations.get' && options.commandId) {
      const args = request.args;
      if (args && typeof args === 'object' && !Array.isArray(args) && (args as Record<string, unknown>).commandId === undefined) (args as Record<string, unknown>).commandId = options.commandId;
    }
  }
  return request;
}
