import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Duplex } from 'node:stream';
import { MAX_FRAME_BYTES, TRANSPORT_TIMEOUT_MS } from './local-ipc';
import { parseRpcBody, RpcError, statusFor } from './rpc';

export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': [
  "frame-ancestors 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; '),
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface HttpRuntime {
  port: number;
  close(): Promise<void>;
}

function header(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new RpcError('INVALID_REQUEST', 'Repeated header is not allowed');
  return value;
}

function jsonType(value: string | undefined): boolean {
  if (!value) return false;
  const [type, ...params] = value.split(';').map(part => part.trim()).filter(Boolean);
  return type.toLowerCase() === 'application/json' && params.length <= 1 && params.every(part => /^charset=utf-8$/i.test(part));
}

function applyHeaders(res: ServerResponse, type?: string, length?: number): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (type) res.setHeader('content-type', type);
  if (length !== undefined) res.setHeader('content-length', length);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.headersSent) return;
  const payload = JSON.stringify(body);
  applyHeaders(res, 'application/json; charset=utf-8', Buffer.byteLength(payload));
  res.writeHead(status);
  res.end(payload);
}

function fail(res: ServerResponse, code: string, message: string): void {
  send(res, statusFor(code), { error: { code, message } });
}

function contained(rootReal: string, rawUrl: string): string | null {
  const pathOnly = rawUrl.split('?')[0]?.split('#')[0] ?? '/';
  if (pathOnly.includes('\\') || pathOnly.includes('\0') || /%2e|%2f|%5c|%00/i.test(pathOnly)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(pathOnly); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes('%')) return null;
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) return null;
  const relative = parts.length === 0 ? 'index.html' : parts.join(sep);
  const full = resolve(rootReal, relative);
  if (full !== rootReal && !full.startsWith(rootReal + sep)) return null;
  if (!MIME[extname(full).toLowerCase()]) return null;
  return full;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_FRAME_BYTES) throw new RpcError('PAYLOAD_TOO_LARGE', 'Request exceeds transport limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export async function startHttpServer(options: {
  port: number;
  staticRoot?: string;
  allowUpgrade?: boolean;
  prepare?: (server: Server, port: number) => Promise<void>;
  delegate?: (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;
  call: (method: string, args: unknown[]) => Promise<unknown>;
}): Promise<HttpRuntime> {
  let rootReal: string | undefined;
  if (options.staticRoot) {
    try { rootReal = await realpath(options.staticRoot); } catch { rootReal = undefined; }
  }
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = TRANSPORT_TIMEOUT_MS;
  server.headersTimeout = TRANSPORT_TIMEOUT_MS;
  server.timeout = TRANSPORT_TIMEOUT_MS;
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => { server.removeAllListeners('error'); server.on('error', () => {}); resolve(); });
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : options.port;
  const origin = `http://127.0.0.1:${port}`;
  const expectedHost = `127.0.0.1:${port}`;
  try {
    if (options.prepare) await options.prepare(server, port);
  } catch (error) {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  const upgrades = new Set<Duplex>();
  server.prependListener('upgrade', (req, socket) => {
    socket.on('error', () => {});
    upgrades.add(socket);
    socket.on('close', () => upgrades.delete(socket));
    const protocol = singleHeader(req.headers['sec-websocket-protocol']);
    const allowed = options.allowUpgrade === true
      && singleHeader(req.headers.host) === expectedHost
      && singleHeader(req.headers.origin) === origin
      && (protocol === 'vite-hmr' || protocol === 'vite-ping');
    if (!allowed) {
      delete req.headers['sec-websocket-protocol'];
      socket.destroy();
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      let host: string | undefined;
      let requestOrigin: string | undefined;
      let site: string | undefined;
      try {
        host = header(req.headers.host);
        requestOrigin = header(req.headers.origin);
        site = header(req.headers['sec-fetch-site']);
      } catch (error) {
        fail(res, error instanceof RpcError ? error.code : 'INVALID_REQUEST', error instanceof RpcError ? error.message : 'Invalid header');
        return;
      }
      if (host !== expectedHost) { fail(res, 'INVALID_HOST', 'Host must be the loopback endpoint'); req.resume(); return; }
      if (site !== undefined && site !== 'same-origin' && site !== 'none') { fail(res, 'INVALID_FETCH_SITE', 'Sec-Fetch-Site contradicts this origin'); req.resume(); return; }
      if (requestOrigin !== undefined && site === 'none') { fail(res, 'INVALID_FETCH_SITE', 'Sec-Fetch-Site contradicts Origin'); req.resume(); return; }
      const rawUrl = req.url ?? '/';
      const pathOnly = rawUrl.split('?')[0] ?? '/';
      if (pathOnly === '/api/rpc') {
        if (req.method !== 'POST') { fail(res, 'METHOD_NOT_ALLOWED', 'Only POST is accepted'); req.resume(); return; }
        if (requestOrigin !== origin) { fail(res, 'INVALID_ORIGIN', 'Origin must be this loopback endpoint'); req.resume(); return; }
        if (site !== undefined && site !== 'same-origin') { fail(res, 'INVALID_FETCH_SITE', 'Sec-Fetch-Site contradicts this origin'); req.resume(); return; }
        if (!jsonType(header(req.headers['content-type']))) { fail(res, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'); req.resume(); return; }
        const declared = header(req.headers['content-length']);
        if (declared !== undefined && Number(declared) > MAX_FRAME_BYTES) { fail(res, 'PAYLOAD_TOO_LARGE', 'Request exceeds transport limit'); req.resume(); return; }
        const bytes = await readBody(req);
        let parsed: unknown;
        try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new RpcError('INVALID_REQUEST', 'Request must be JSON'); }
        const { method, args } = parseRpcBody(parsed);
        const result = await options.call(method, args);
        send(res, 200, { result });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 'NOT_FOUND', 'Not found'); req.resume(); return; }
      if (requestOrigin !== undefined && requestOrigin !== origin) { fail(res, 'INVALID_ORIGIN', 'Origin must be this loopback endpoint'); req.resume(); return; }
      if (options.delegate && (req.method === 'GET' || req.method === 'HEAD')) {
        options.delegate(req, res, () => {
          if (!res.writableEnded && !res.headersSent) fail(res, 'NOT_FOUND', 'Not found');
        });
        return;
      }
      const file = rootReal ? contained(rootReal, rawUrl) : null;
      if (!file) { fail(res, 'NOT_FOUND', 'Not found'); return; }
      let info: Awaited<ReturnType<typeof stat>>;
      try { info = await stat(file); } catch { fail(res, 'NOT_FOUND', 'Not found'); return; }
      if (!info.isFile()) { fail(res, 'NOT_FOUND', 'Not found'); return; }
      const real = await realpath(file);
      if (real !== rootReal && !real.startsWith(rootReal + sep)) { fail(res, 'NOT_FOUND', 'Not found'); return; }
      applyHeaders(res, MIME[extname(real).toLowerCase()], info.size);
      res.writeHead(200);
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(real);
      void pipeline(stream, res).catch(() => {
        stream.destroy();
        if (!res.writableEnded) res.destroy();
      });
    } catch (error) {
      if (error instanceof RpcError) { fail(res, error.code, error.message); return; }
      console.error(error instanceof Error ? error.message : 'Request failed');
      fail(res, 'INTERNAL_ERROR', 'Request failed');
    }
  }

  return { port, async close() {
    for (const socket of upgrades) socket.destroy();
    upgrades.clear();
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    if (!server.listening) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, TRANSPORT_TIMEOUT_MS);
      server.close(() => { clearTimeout(timer); resolve(); });
    });
  } };
}
