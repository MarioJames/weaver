import { connect } from 'node:net';
import { LocalIPCError, MAX_FRAME_BYTES, readDiscovery, requestTimeoutMs } from '../main/local-ipc';

/** One request over the authenticated Unix socket of the running service in `dataDir`. */
export async function sendRequest(dataDir: string, request: unknown, timeoutMs = requestTimeoutMs(request)): Promise<unknown> {
  const deadline = Date.now() + Math.min(requestTimeoutMs(request), timeoutMs);
  if(timeoutMs <= 0) throw new LocalIPCError('TIMEOUT', 'Bounded wait deadline reached');
  let endpoint: Awaited<ReturnType<typeof readDiscovery>>;
  try { endpoint = await readDiscovery(dataDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LocalIPCError('APP_NOT_RUNNING', 'Weaver is not running; run weaver server start');
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
    socket.on('error', error => done(new LocalIPCError(['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '') ? 'APP_NOT_RUNNING' : 'TRANSPORT_ERROR', 'Weaver is not running; run weaver server start')));
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
