import { createServer, connect, type Socket } from 'node:net';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const TRANSPORT_TIMEOUT_MS = 15_000;
export const OWNER_LAUNCH_REQUEST_TIMEOUT_MS = 210_000;
const record = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
const shortText = (value:unknown, max:number):value is string => typeof value==='string' && !!value.trim() && value.length<=max;
/** Only a complete, cheap-validated launch envelope earns the fixed startup allowance. Authentication stays at the caller boundary. */
export function requestTimeoutMs(value:unknown):number {
  if(!record(value))return TRANSPORT_TIMEOUT_MS;
  if(value.method==='command'){
    if(Object.keys(value).length!==2||!Array.isArray(value.args)||value.args.length!==1)return TRANSPORT_TIMEOUT_MS;
    value=value.args[0];
  }
  if(!record(value)||value.apiVersion!=='weaver.v1'||!shortText(value.commandId,120)||!record(value.args))return TRANSPORT_TIMEOUT_MS;
  const args=value.args;
  if(!shortText(args.taskId,36)||! /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(args.taskId)||!Number.isSafeInteger(args.expectedRevision)||Number(args.expectedRevision)<0)return TRANSPORT_TIMEOUT_MS;
  if(value.command!=='owners.launch'&&!(value.command==='owners.switch'&&args.launch===true))return TRANSPORT_TIMEOUT_MS;
  if(value.command==='owners.switch'&&((args.expectedEpoch!==undefined&&(!Number.isSafeInteger(args.expectedEpoch)||Number(args.expectedEpoch)<0))||(args.reason!==undefined&&args.reason!=='manual'&&args.reason!=='idle')||(args.profileId!==undefined&&!shortText(args.profileId,120))))return TRANSPORT_TIMEOUT_MS;
  try{if(Buffer.byteLength(JSON.stringify(value))>128*1024)return TRANSPORT_TIMEOUT_MS;}catch{return TRANSPORT_TIMEOUT_MS;}
  return OWNER_LAUNCH_REQUEST_TIMEOUT_MS;
}
export interface Discovery { version: 1; instanceId: string; socketPath: string; tokenPath: string }
export class LocalIPCError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'LocalIPCError'; }
}
export function failure(code: string, message: string) {
  return { apiVersion: 'weaver.v1', commandId: null, ok: false, error: { code, message, retryable: code === 'APP_NOT_RUNNING' || code === 'TIMEOUT' } };
}
export async function readPrivateFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > MAX_FRAME_BYTES)
      throw new LocalIPCError('UNSAFE_ENDPOINT', 'Endpoint file ownership, permissions, or size are unsafe');
    const bytes = Buffer.alloc(MAX_FRAME_BYTES + 1);
    let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > MAX_FRAME_BYTES) throw new LocalIPCError('INVALID_REQUEST', 'Input exceeds the size limit');
    return bytes.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}
export async function readDiscovery(userData: string): Promise<{ discovery: Discovery; token: string }> {
  if (process.platform === 'win32') throw new LocalIPCError('UNSUPPORTED_PLATFORM', 'Local CLI transport requires Unix filesystem permissions');
  const base = resolve(userData);
  const baseInfo = await lstat(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink() || baseInfo.uid !== process.getuid?.() || (baseInfo.mode & 0o022))
    throw new LocalIPCError('UNSAFE_ENDPOINT', 'Application data directory is unsafe');
  const discovery = JSON.parse(await readPrivateFile(join(base, 'control.v1.json'))) as Discovery;
  if (discovery.version !== 1 || typeof discovery.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(discovery.instanceId) ||
      typeof discovery.socketPath !== 'string' || typeof discovery.tokenPath !== 'string')
    throw new LocalIPCError('UNSAFE_ENDPOINT', 'Invalid endpoint discovery');
  const directory = join(base, `control-${discovery.instanceId}`);
  if (discovery.socketPath !== join(directory, 'ipc.sock') || discovery.tokenPath !== join(directory, 'token'))
    throw new LocalIPCError('UNSAFE_ENDPOINT', 'Endpoint paths do not match their instance');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new LocalIPCError('UNSAFE_ENDPOINT', 'Endpoint directory is unsafe');
  const socket = await lstat(discovery.socketPath);
  if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077) !== 0)
    throw new LocalIPCError('UNSAFE_ENDPOINT', 'Endpoint socket is unsafe');
  const token = await readPrivateFile(discovery.tokenPath);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new LocalIPCError('UNSAFE_ENDPOINT', 'Invalid authentication token');
  return { discovery, token };
}

const STALE_PROBE_MS = 500;
interface StaleEndpoint { directory: string; socketPath: string; ino: number; dev: number }

/** Only a refused or missing socket file proves nobody is listening; anything else stays as-is. */
function socketIsDead(path: string): Promise<boolean> {
  return new Promise(resolvePromise => {
    const socket = connect(path);
    let settled = false;
    const finish = (stale: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(stale);
    };
    const timer = setTimeout(() => finish(false), STALE_PROBE_MS);
    socket.once('connect', () => finish(false));
    socket.once('close', () => finish(false));
    socket.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === 'ECONNREFUSED' || code === 'ENOENT');
    });
  });
}

/**
 * The endpoint a dead process left behind, or undefined unless the discovery file is private,
 * laid out for its own instance id, points at a socket nobody can reach, and owns nothing else.
 */
async function staleEndpoint(base: string, discoveryPath: string): Promise<StaleEndpoint | undefined> {
  let candidate: StaleEndpoint;
  try {
    const published = await lstat(discoveryPath);
    if (!published.isFile()) return;
    const value = JSON.parse(await readPrivateFile(discoveryPath)) as Discovery;
    if (value.version !== 1 || typeof value.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(value.instanceId) ||
        typeof value.socketPath !== 'string' || typeof value.tokenPath !== 'string') return;
    const directory = join(base, `control-${value.instanceId}`);
    if (value.socketPath !== join(directory, 'ipc.sock') || value.tokenPath !== join(directory, 'token')) return;
    candidate = { directory, socketPath: value.socketPath, ino: published.ino, dev: published.dev };
  } catch { return; }
  try {
    const info = await lstat(candidate.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return;
  } catch (error) {
    // The instance directory is gone, so nothing can be listening on a path inside it.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    return candidate;
  }
  return (await socketIsDead(candidate.socketPath)) ? candidate : undefined;
}

/**
 * An absent app never starts a worker. Another live app keeps its endpoint: startup stops with
 * ENDPOINT_EXISTS. Only an endpoint whose own socket is refused or missing is provably left over
 * by a dead process, so that discovery file and instance directory are cleared once and startup
 * continues.
 */
export async function startLocalIPC(userData: string, handle: (request: unknown) => unknown): Promise<{ close(): Promise<void> }> {
  if (process.platform === 'win32') throw new LocalIPCError('UNSUPPORTED_PLATFORM', 'Local CLI transport requires Unix filesystem permissions');
  const base = resolve(userData);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const baseInfo = await lstat(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink() || baseInfo.uid !== process.getuid?.() || (baseInfo.mode & 0o022))
    throw new LocalIPCError('UNSAFE_ENDPOINT', 'Application data directory is unsafe');
  const discoveryPath = join(base, 'control.v1.json');
  const stale = await staleEndpoint(base, discoveryPath);
  if (stale) {
    // Re-check the inode: a live instance may have republished the discovery while it was probed.
    const now = await lstat(discoveryPath).catch(() => undefined);
    if (now && now.ino === stale.ino && now.dev === stale.dev) await unlink(discoveryPath).catch(() => {});
    await rm(stale.directory, { recursive: true, force: true });
  }
  const instanceId = randomBytes(16).toString('hex');
  const directory = join(base, `control-${instanceId}`);
  await mkdir(directory, { mode: 0o700 });
  const socketPath = join(directory, 'ipc.sock');
  const tokenPath = join(directory, 'token');
  const token = randomBytes(32).toString('hex');
  const clients = new Set<Socket>();
  let published: { ino: number; dev: number } | undefined;
  let closed = false;
  const server = createServer(socket => {
    clients.add(socket);
    socket.on('error', () => {});
    let deadline = setTimeout(() => socket.destroy(), TRANSPORT_TIMEOUT_MS);
    socket.on('close', () => { clearTimeout(deadline); clients.delete(socket); });
    socket.setTimeout(TRANSPORT_TIMEOUT_MS, () => socket.destroy());
    let bytes = Buffer.alloc(0);
    let received = false;
    const reply = (value: unknown) => {
      if (socket.destroyed) return;
      let encoded: string;
      try { encoded = JSON.stringify(value) + '\n'; } catch { encoded = JSON.stringify(failure('INTERNAL_ERROR', 'Response could not be serialized')) + '\n'; }
      if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) encoded = JSON.stringify(failure('RESPONSE_TOO_LARGE', 'Response exceeds transport limit')) + '\n';
      socket.end(encoded);
    };
    socket.on('data', raw => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (received) return;
      if (bytes.length + chunk.length > MAX_FRAME_BYTES) { received = true; reply(failure('INVALID_REQUEST', 'Request exceeds transport limit')); return; }
      bytes = Buffer.concat([bytes, chunk]);
      const end = bytes.indexOf(10);
      if (end < 0) return;
      received = true;
      try {
        if (end !== bytes.length - 1) throw new LocalIPCError('INVALID_REQUEST', 'Only one request is permitted per connection');
        const frame = JSON.parse(bytes.subarray(0, end).toString('utf8'));
        if (frame.version !== 1 || typeof frame.token !== 'string' || frame.token.length !== token.length ||
            !timingSafeEqual(Buffer.from(frame.token), Buffer.from(token))) {
          reply(failure('UNAUTHORIZED', 'Local authentication failed')); return;
        }
        const allowance=requestTimeoutMs(frame.request);
        if(allowance!==TRANSPORT_TIMEOUT_MS){
          clearTimeout(deadline);deadline=setTimeout(()=>socket.destroy(),allowance);
          socket.setTimeout(allowance);
        }
        Promise.resolve().then(() => handle(frame.request)).then(reply, () => reply(failure('INTERNAL_ERROR', 'Command handler failed')));
      } catch { reply(failure('INVALID_REQUEST', 'Invalid transport request')); }
    });
  });
  server.maxConnections = 32;
  async function cleanup() {
    if (published) {
      try {
        const info = await lstat(discoveryPath);
        const current = JSON.parse(await readPrivateFile(discoveryPath));
        if (info.ino === published.ino && info.dev === published.dev && current.instanceId === instanceId) await unlink(discoveryPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { /* Never remove another instance's discovery. */ } }
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    if (Buffer.byteLength(socketPath) > 103) throw new LocalIPCError('ENDPOINT_PATH_TOO_LONG', 'Application data path is too long for a Unix socket');
    const secret = await open(tokenPath, 'wx', 0o600);
    try { await secret.writeFile(token); } finally { await secret.close(); }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', () => {});
    await chmod(socketPath, 0o600);
    const file = await open(discoveryPath, 'wx', 0o600);
    try {
      const info = await file.stat(); published = { ino: info.ino, dev: info.dev };
      await file.writeFile(JSON.stringify({ version: 1, instanceId, socketPath, tokenPath } satisfies Discovery));
      await file.sync();
    } finally { await file.close(); }
  } catch (error) {
    for (const client of clients) client.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup();
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LocalIPCError('ENDPOINT_EXISTS', 'Discovery already exists; another app or a stale endpoint must be resolved before startup');
    throw error;
  }
  return { async close() {
    if (closed) return; closed = true;
    for (const client of clients) client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup();
  } };
}
