import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerRecord } from '../../shared/types';
import type { HelloInput, HelloResult } from '../../shared/engines';
import type { StartCliAgent } from '../adapters/launch';
import type { ManagedProcess } from '../adapters/worker';
import { isRealEngineKind } from '../workspace';

const PROMPT = 'Say hi in one short sentence. Do not read or change any files and do not run any tools.';
const TEXT_MAX = 500;

export function parseHelloInput(value: unknown): HelloInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Probe input must be an object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['engine', 'model', 'effort'].includes(key))) throw new Error('Unknown probe field');
  for (const key of ['engine', 'model', 'effort'] as const) {
    if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > 200) throw new Error(`Probe ${key} is required`);
  }
  return { engine: raw.engine as string, model: raw.model as string, effort: raw.effort as string };
}

function clip(text: string): string {
  const line = text.trim();
  return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX)}…` : line;
}

/**
 * Starts the worker's CLI once with a one-line greeting in an empty scratch
 * directory and reports whether it answered. This is a real model call; it
 * proves the route works now, not that it will keep working.
 */
export function sayHi(route: HelloInput & { kind: string }, deps: { launch: StartCliAgent | undefined; root: string; timeoutMs?: number; signal?: AbortSignal }): Promise<HelloResult> {
  const started = Date.now();
  const done = (result: Omit<HelloResult, 'durationMs' | 'checkedAt'>): HelloResult => ({ ...result, durationMs: Date.now() - started, checkedAt: new Date().toISOString() });
  if (route.kind === 'claude') return Promise.resolve(done({ ok: false, error: 'Claude Code 的真实执行尚未接入，无法探测。' }));
  if (!isRealEngineKind(route.kind)) return Promise.resolve(done({ ok: false, error: `${route.kind} 还没有执行适配，无法探测。` }));
  if (!deps.launch) return Promise.resolve(done({ ok: false, error: '真实执行启动器未加载。' }));
  const scratch = join(deps.root, `hello-${randomBytes(4).toString('hex')}`);
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  let child: ManagedProcess;
  try {
    mkdirSync(join(scratch, 'workspace'), { recursive: true, mode: 0o700 });
    child = deps.launch({ engine: route.kind, model: route.model, effort: route.effort, workspace: join(scratch, 'workspace'), stateDir: join(scratch, 'state'), instruction: PROMPT, name: 'say-hi', role: 'worker' });
  } catch (error) {
    cleanup();
    return Promise.resolve(done({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
  return new Promise(resolve => {
    let reply = '';
    let lastLog = '';
    let stderr = '';
    let timedOut = false;
    let buffer = '';
    const read = (line: string) => {
      if (!line.trim()) return;
      try {
        const record = JSON.parse(line) as WorkerRecord;
        if (record.type === 'result') reply = record.summary;
        else if (record.type === 'log') lastLog = record.message;
      } catch { /* the launcher only writes JSON lines */ }
    };
    child.stdout.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(read);
    });
    child.stderr.on('data', (chunk: Buffer | string) => { if (stderr.length < 4000) stderr += chunk.toString(); });
    const stop = () => child.kill('SIGTERM');
    deps.signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, deps.timeoutMs ?? 120_000);
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', stop);
      read(buffer);
      cleanup();
      if (timedOut) resolve(done({ ok: false, error: `等待回复超时（${Math.round((deps.timeoutMs ?? 120_000) / 1000)} 秒），已停止进程。` }));
      else if (code === 0 && reply.trim()) resolve(done({ ok: true, reply: clip(reply) }));
      else resolve(done({ ok: false, reply: reply ? clip(reply) : undefined, error: clip(stderr.trim().split('\n').at(-1) || lastLog || `进程退出码 ${code ?? '未知'}，没有回复。`) }));
    };
    // Output can still be in flight when the process closes; wait for the stream to drain, briefly.
    let ended = false;
    let exit: number | null | undefined;
    child.stdout.once('end', () => { ended = true; if (exit !== undefined) finish(exit); });
    child.once('error', (error: Error) => { lastLog = error.message; finish(1); });
    child.once('close', (code: number | null) => { exit = code; if (ended) finish(code); else setTimeout(() => finish(code), 1000); });
  });
}
