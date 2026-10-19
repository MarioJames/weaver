import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { HelloInput, HelloJob, HelloResult } from '../../shared/engines';

const PROMPT = 'Reply with exactly: hi';
const SYSTEM = 'You are a connectivity check. Reply with one short line. Never use tools.';
const TEXT_MAX = 500;
const OUTPUT_CAP = 1024 * 1024;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,199}$/;
const EFFORT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const HELLO_TIMEOUT_MS = 120_000;

type Parsed = { reply?: string; error?: string; model?: string };
type Json = Record<string, any>;

function jsonLines(stdout: string): Json[] {
  const out: Json[] = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try { out.push(JSON.parse(text)); } catch { /* vendor noise */ }
  }
  return out;
}

/** Some CLIs wrap the provider's JSON error in text ("Internal error: {...}"); show the provider's own message. */
function innerMessage(text: string): string {
  const start = text.indexOf('{');
  if (start < 0) return text;
  try {
    const inner = JSON.parse(text.slice(start)) as { message?: unknown; error?: { message?: unknown } };
    const message = typeof inner.message === 'string' ? inner.message : typeof inner.error?.message === 'string' ? inner.error.message : undefined;
    return message ?? text;
  } catch { return text; }
}

/** claude / qodercli / grok print mode: a result object, or an error event. */
function parseResultObject(stdout: string): Parsed {
  const lines = jsonLines(stdout);
  for (const value of [...lines].reverse()) {
    if (typeof value.result === 'string') {
      const models = Object.keys(value.modelUsage ?? {});
      const model = models.length === 1 ? models[0] : undefined;
      return value.is_error === true ? { error: value.result, model } : { reply: value.result, model };
    }
  }
  const error = [...lines].reverse().find(value => value.type === 'error' && typeof value.message === 'string');
  return error ? { error: innerMessage(error.message) } : {};
}

function parseCodex(stdout: string): Parsed {
  let reply: string | undefined;
  let error: string | undefined;
  for (const value of jsonLines(stdout)) {
    if (value.type === 'item.completed' && value.item?.type === 'agent_message' && typeof value.item.text === 'string') reply = value.item.text;
    if (value.type === 'error' && typeof value.message === 'string') error = value.message;
    if (value.type === 'turn.failed') error = value.error?.message ?? error ?? 'turn failed';
  }
  return reply ? { reply } : { error };
}

function parseOpencode(stdout: string): Parsed {
  let reply = '';
  let error: string | undefined;
  for (const value of jsonLines(stdout)) {
    if (value.type === 'text' && typeof value.part?.text === 'string') reply += value.part.text;
    if (value.type === 'error') error = value.error?.data?.message ?? value.error?.message ?? value.message ?? 'error';
  }
  return reply.trim() ? { reply } : { error };
}

/** pi json mode: the last assistant message carries text, the vendor model, or an error stop. */
function parsePi(stdout: string): Parsed {
  let last: Json | undefined;
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const value = node as Json;
    if (value.role === 'assistant' && Array.isArray(value.content)) last = value;
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  jsonLines(stdout).forEach(visit);
  if (!last) return {};
  const text = last.content.filter((part: Json) => part?.type === 'text' && typeof part.text === 'string').map((part: Json) => part.text).join('');
  const model = typeof last.responseModel === 'string' ? last.responseModel : typeof last.model === 'string' ? last.model : undefined;
  if (last.stopReason === 'error' || last.stopReason === 'aborted') return { error: last.errorMessage ?? `stop: ${last.stopReason}`, model };
  return text.trim() ? { reply: text, model } : { model };
}

/**
 * The lightest call each CLI offers that still goes through its login, account and model:
 * one prompt, no tools, no MCP, no hooks/plugins/user settings where the CLI allows it, no saved session.
 * Worker execution keeps its own adapters; this is a reachability check only.
 */
export const HELLO_ENGINES: Record<string, { command: string; argv: (model: string, effort: string) => string[]; parse: (stdout: string) => Parsed }> = {
  claude: { command: 'claude', parse: parseResultObject, argv: (model, effort) => ['-p', PROMPT, '--model', model, '--effort', effort, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--system-prompt', SYSTEM, '--no-session-persistence'] },
  codex: { command: 'codex', parse: parseCodex, argv: (model, effort) => ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--model', model, '-c', `model_reasoning_effort="${effort}"`, PROMPT] },
  grok: { command: 'grok', parse: parseResultObject, argv: (model, effort) => ['-p', PROMPT, '-m', model, '--reasoning-effort', effort, '--output-format', 'json', '--max-turns', '1', '--disable-web-search', '--no-subagents', '--system-prompt-override', SYSTEM] },
  opencode: { command: 'opencode', parse: parseOpencode, argv: (model, effort) => ['run', '--pure', '--format', 'json', '-m', model, '--variant', effort, PROMPT] },
  pi: { command: 'pi', parse: parsePi, argv: (model, effort) => ['-p', '--mode', 'json', '--model', model, '--thinking', effort, '--no-tools', '--no-mcp', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-session', '--system-prompt', SYSTEM, PROMPT] },
  // qodercli reports every model as the placeholder "qfmodel", so its vendor model is not shown.
  qodercli: { command: 'qodercli', parse: stdout => ({ ...parseResultObject(stdout), model: undefined }), argv: (model, effort) => ['-p', PROMPT, '-m', model, '--reasoning-effort', effort, '-o', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--system-prompt', SYSTEM, '--no-session-persistence'] },
};

/** Structural child process; tests inject a fake. */
export interface HelloProcess {
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: string, listener: (...args: any[]) => void): unknown;
}
export type SpawnPrint = (command: string, argv: string[], cwd: string) => HelloProcess;

const spawnPrint: SpawnPrint = (command, argv, cwd) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(command, argv, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
};

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

type Outcome = Omit<HelloResult, 'durationMs' | 'checkedAt'>;

/**
 * Runs the engine's lightest one-shot call in an empty scratch directory and
 * reports whether the model answered. This is a real model call; it proves
 * the route works now, not that it will keep working.
 */
export function sayHi(route: HelloInput & { kind: string }, deps: { root: string; timeoutMs?: number; signal?: AbortSignal; spawn?: SpawnPrint }): Promise<HelloResult> {
  const started = Date.now();
  const timeoutMs = deps.timeoutMs ?? HELLO_TIMEOUT_MS;
  const done = (result: Outcome): HelloResult => ({ ...result, durationMs: Date.now() - started, checkedAt: new Date().toISOString() });
  const engine = HELLO_ENGINES[route.kind];
  if (!engine) return Promise.resolve(done({ ok: false, error: `${route.kind} 还没有接入，无法探测。` }));
  // Values become CLI arguments; a leading "-" would be read as a flag.
  if (!MODEL.test(route.model) || route.model.includes('..')) return Promise.resolve(done({ ok: false, error: '模型名称包含不支持的字符。' }));
  if (!EFFORT.test(route.effort)) return Promise.resolve(done({ ok: false, error: '推理强度包含不支持的字符。' }));
  const scratch = join(deps.root, `hello-${randomBytes(4).toString('hex')}`);
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  let child: HelloProcess;
  try {
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    child = (deps.spawn ?? spawnPrint)(engine.command, engine.argv(route.model, route.effort), scratch);
  } catch (error) {
    cleanup();
    return Promise.resolve(done({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer | string) => { if (stdout.length < OUTPUT_CAP) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer | string) => { if (stderr.length < 4000) stderr += chunk.toString(); });
    const stop = () => child.kill('SIGTERM');
    deps.signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    let finished = false;
    const finish = (code: number | null, spawnError?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', stop);
      cleanup();
      if (timedOut) { resolve(done({ ok: false, error: `等待回复超时（${Math.round(timeoutMs / 1000)} 秒），已停止进程。` })); return; }
      if (spawnError) { resolve(done({ ok: false, error: (spawnError as NodeJS.ErrnoException).code === 'ENOENT' ? `找不到命令 ${engine.command}，确认已安装并在 PATH 中。` : spawnError.message })); return; }
      const parsed = engine.parse(stdout);
      if (code === 0 && parsed.reply?.trim() && !parsed.error) { resolve(done({ ok: true, reply: clip(parsed.reply), model: parsed.model })); return; }
      const stderrLine = stderr.trim().split('\n').filter(Boolean).at(-1) ?? '';
      resolve(done({ ok: false, model: parsed.model, error: clip(parsed.error || stderrLine || `进程退出码 ${code ?? '未知'}，没有回复。`) }));
    };
    // Output can still be in flight when the process closes; wait for the stream to drain, briefly.
    let ended = false;
    let exit: number | null | undefined;
    child.stdout.once('end', () => { ended = true; if (exit !== undefined) finish(exit); });
    child.once('error', (error: Error) => finish(1, error));
    child.once('close', (code: number | null) => { exit = code; if (ended) finish(code); else setTimeout(() => finish(code), 1000); });
  });
}

/**
 * A greeting can outlast one HTTP request (15 s), so it runs as a job the page polls.
 * At most `limit` run at once; finished jobs are kept for `keepMs` and then forgotten.
 */
export class HelloJobs {
  private jobs = new Map<string, { job: HelloJob; finishedAt?: number }>();
  constructor(private readonly run: (route: HelloInput) => Promise<HelloResult>, private readonly limit = 3, private readonly keepMs = 10 * 60_000, private readonly now = () => Date.now()) {}
  private prune(): void {
    for (const [id, entry] of this.jobs) if (entry.finishedAt !== undefined && this.now() - entry.finishedAt > this.keepMs) this.jobs.delete(id);
  }
  running(): number { return [...this.jobs.values()].filter(entry => entry.job.status === 'running').length; }
  start(route: HelloInput): HelloJob {
    this.prune();
    if (this.running() >= this.limit) throw new Error(`已有 ${this.limit} 个探测在运行，等其中一个结束再试。`);
    const job: HelloJob = { id: randomBytes(8).toString('hex'), status: 'running', startedAt: new Date(this.now()).toISOString() };
    const entry: { job: HelloJob; finishedAt?: number } = { job };
    this.jobs.set(job.id, entry);
    const settle = (result: HelloResult) => { entry.job = { ...job, status: 'done', result }; entry.finishedAt = this.now(); };
    this.run(route).then(settle, error => settle({ ok: false, error: error instanceof Error ? error.message : String(error), durationMs: 0, checkedAt: new Date(this.now()).toISOString() }));
    return { ...job };
  }
  get(id: string): HelloJob | undefined {
    this.prune();
    const entry = this.jobs.get(id);
    return entry ? structuredClone(entry.job) : undefined;
  }
}
