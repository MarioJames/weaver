import { createServer, connect, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Process-level singleton lock for a Weaver data directory.
 *
 * Why not flock: Node 22 ships no flock API (no fs.flock), so an flock-based
 * lock would need a native addon or a helper binary. Worse, flock semantics
 * are wrong for this job: an flock is tied to the open file description, so a
 * forked/duped copy (worker child, daemon double-fork) keeps the lock alive
 * after the owner dies, and CLOEXEC discipline has to be enforced manually on
 * every spawn path. A listening Unix socket has neither problem: the kernel
 * releases the bound address when the last holder process dies (including
 * SIGKILL), and libuv creates sockets with SOCK_CLOEXEC while Node's
 * child_process only passes the configured stdio fds, so the listening fd can
 * never leak into a worker (see tests/main/instance-lock.test.ts).
 *
 * Linux: listen on an abstract-namespace socket whose name is derived from the
 * realpath hash of the data directory. Abstract sockets live in the kernel
 * network namespace, leave no filesystem residue, and a second listen fails
 * with EADDRINUSE while any holder is alive.
 *
 * Other Unix platforms: listen on a filesystem socket under the data
 * directory. A leftover socket file from a dead process also fails to bind,
 * so a failed bind is followed by a connect probe: connect success means a
 * live holder (INSTANCE_LOCKED), refused/missing means residue (remove once
 * and retry a single time), anything else stays conservative (INSTANCE_LOCKED).
 */
export class InstanceLockError extends Error {
  readonly code = 'INSTANCE_LOCKED';
  constructor(message = 'Another process holds the instance lock for this data directory') {
    super(message);
    this.name = 'InstanceLockError';
  }
}

export interface InstanceLock {
  release(): Promise<void>;
}

/** Stable lock identity for a data directory (realpath + uid hashed). Exported for tests. */
export async function instanceLockKey(dataDir: string): Promise<string> {
  const base = resolve(dataDir);
  const real = await realpath(base).catch(() => base);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const digest = createHash('sha256').update(`${uid}:${real}`).digest('hex').slice(0, 32);
  return `weaver-lock-${digest}`;
}

function listenOn(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      server.on('error', () => {});
      resolvePromise();
    });
  });
}

function toRelease(server: Server): InstanceLock {
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await new Promise<void>((resolvePromise, reject) => {
        server.close(error => (error ? reject(error) : resolvePromise()));
      });
    },
  };
}

async function acquireAbstractSocket(name: string): Promise<InstanceLock> {
  const server = createServer();
  try {
    // Leading NUL byte selects the Linux abstract namespace (no filesystem node).
    await listenOn(server, `\0${name}`);
  } catch (error) {
    server.close(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
      throw new InstanceLockError();
    throw error;
  }
  return toRelease(server);
}

function probeSocket(path: string, timeoutMs = 500): Promise<'live' | 'dead' | 'unknown'> {
  return new Promise(resolvePromise => {
    const socket = connect(path);
    let settled = false;
    const finish = (state: 'live' | 'dead' | 'unknown') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(state);
    };
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    socket.once('connect', () => finish('live'));
    socket.once('close', () => finish('unknown'));
    socket.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'dead' : 'unknown');
    });
  });
}

async function acquireFileSocket(base: string): Promise<InstanceLock> {
  const socketPath = join(base, 'instance.lock.sock');
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = createServer();
    try {
      await listenOn(server, socketPath);
      return toRelease(server);
    } catch (error) {
      server.close(() => {});
      if (attempt > 0) throw toLocked(error);
      const state = await probeSocket(socketPath);
      if (state !== 'dead') throw toLocked(error);
      // Residue from a dead holder: remove once and retry a single time.
      await rm(socketPath, { force: true });
    }
  }
  throw new InstanceLockError();
}

function toLocked(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE' || code === 'EACCES') return new InstanceLockError();
  return error;
}

/**
 * Acquire the singleton lock for dataDir. Rejects with InstanceLockError
 * (code INSTANCE_LOCKED) when another live process holds it. The kernel
 * releases the lock when this process dies, including SIGKILL.
 */
export async function acquireInstanceLock(dataDir: string): Promise<InstanceLock> {
  const base = resolve(dataDir);
  await mkdir(base, { recursive: true, mode: 0o700 });
  if (process.platform === 'linux') return acquireAbstractSocket(await instanceLockKey(base));
  return acquireFileSocket(base);
}
