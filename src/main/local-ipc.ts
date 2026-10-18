import { createServer, type Socket } from 'node:net';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const TRANSPORT_TIMEOUT_MS = 15_000;
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

/** An absent app never starts a worker. A stale discovery file must be removed manually. */
export async function startLocalIPC(userData: string, handle: (request: unknown) => unknown): Promise<{ close(): Promise<void> }> {
  if (process.platform === 'win32') throw new LocalIPCError('UNSUPPORTED_PLATFORM', 'Local CLI transport requires Unix filesystem permissions');
  const base = resolve(userData);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const baseInfo = await lstat(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink() || baseInfo.uid !== process.getuid?.() || (baseInfo.mode & 0o022))
    throw new LocalIPCError('UNSAFE_ENDPOINT', 'Application data directory is unsafe');
  const instanceId = randomBytes(16).toString('hex');
  const directory = join(base, `control-${instanceId}`);
  await mkdir(directory, { mode: 0o700 });
  const socketPath = join(directory, 'ipc.sock');
  const tokenPath = join(directory, 'token');
  const discoveryPath = join(base, 'control.v1.json');
  const token = randomBytes(32).toString('hex');
  const clients = new Set<Socket>();
  let published: { ino: number; dev: number } | undefined;
  let closed = false;
  const server = createServer(socket => {
    clients.add(socket);
    socket.on('error', () => {});
    const deadline = setTimeout(() => socket.destroy(), TRANSPORT_TIMEOUT_MS);
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
