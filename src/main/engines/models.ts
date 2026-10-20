import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { catalogEntry, type EngineModel, type EngineModelList, type EngineModelListInput } from '../../shared/engines';
import { findEngineExecutable, runCapture, type CaptureResult } from './probe';

export const NO_LIST_MESSAGE = '该引擎不提供模型列表，请手动填写';
const MAX_MODELS = 500;
const CACHE_MS = 60_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,199}$/;
const CLAUDE_ALIASES: EngineModel[] = [
  { id: 'sonnet', hint: '别名，跟随 Claude Code 当前的 Sonnet' },
  { id: 'opus', hint: '别名，跟随 Claude Code 当前的 Opus' },
  { id: 'haiku', hint: '别名，跟随 Claude Code 当前的 Haiku' },
];
/** Names Claude Code 2.1.x ships for its current families; `claude` has no command that lists models. */
const CLAUDE_KNOWN = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const CLAUDE_ENV_MODELS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'];

/** One command per engine that can list its models without calling one. */
interface ListCommand { args: string[]; source: string; timeoutMs: number; maxBytes: number; parse: (stdout: string) => EngineModel[] }

const cleanLines = (text: string): string[] => text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const unique = (models: EngineModel[]): EngineModel[] => {
  const seen = new Set<string>();
  return models.filter(model => NAME.test(model.id) && !seen.has(model.id) && seen.add(model.id)).slice(0, MAX_MODELS);
};

/** `opencode models`: one `provider/model` per line. */
export function parseOpencodeModels(stdout: string): EngineModel[] {
  return unique(cleanLines(stdout).filter(line => /^[^\s/]+\/\S+$/.test(line)).map(line => ({ id: line })));
}

/** `pi --list-models`: a table whose first two columns are provider and model; the model is addressed as `provider/model`. */
export function parsePiModels(stdout: string): EngineModel[] {
  const rows = cleanLines(stdout).map(line => line.split(/\s+/));
  const header = rows.findIndex(row => row[0] === 'provider' && row[1] === 'model');
  if (header < 0) return [];
  const columns = rows[header]!;
  const index = (name: string) => columns.indexOf(name);
  return unique(rows.slice(header + 1).filter(row => row.length >= 2).map(row => {
    const context = index('context') >= 0 ? row[index('context')] : undefined;
    const thinking = index('thinking') >= 0 ? row[index('thinking')] : undefined;
    const hint = [context ? `${context} 上下文` : '', thinking === 'yes' ? '支持思考' : ''].filter(Boolean).join(' · ');
    return { id: `${row[0]}/${row[1]}`, ...(hint ? { hint } : {}) };
  }));
}

/** `grok models`: a `Available models:` section of `*`/`-` bullets, the default marked in parentheses. */
export function parseGrokModels(stdout: string): EngineModel[] {
  const lines = cleanLines(stdout);
  const start = lines.findIndex(line => /^available models:?$/i.test(line));
  const models: EngineModel[] = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    const match = /^[*-]\s+(\S+)(?:\s+\((default)\))?$/.exec(line);
    if (!match) break;
    models.push({ id: match[1]!, ...(match[2] ? { hint: '默认' } : {}) });
  }
  return unique(models);
}

/** `codex debug models`: the catalog the CLI itself offers in `/model`; models it hides from that menu are left out. */
export function parseCodexModels(stdout: string): EngineModel[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return []; }
  const list = (parsed as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  return unique(list.flatMap((item): EngineModel[] => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (typeof row.slug !== 'string' || row.visibility !== 'list') return [];
    const description = typeof row.description === 'string' ? row.description.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    return [{ id: row.slug, ...(typeof row.display_name === 'string' && row.display_name !== row.slug ? { label: row.display_name } : {}), ...(description ? { hint: description } : {}) }];
  }));
}

/** `qodercli --list-models`: a `MODEL` header and then one name per line. */
export function parseQoderModels(stdout: string): EngineModel[] {
  const lines = cleanLines(stdout);
  return unique(lines.slice(lines[0]?.toUpperCase() === 'MODEL' ? 1 : 0).filter(line => !/\s/.test(line)).map(line => ({ id: line })));
}

const LISTERS: Record<string, ListCommand> = {
  opencode: { args: ['models'], source: 'opencode models', timeoutMs: 20_000, maxBytes: 256 * 1024, parse: parseOpencodeModels },
  pi: { args: ['--list-models'], source: 'pi --list-models', timeoutMs: 20_000, maxBytes: 256 * 1024, parse: parsePiModels },
  grok: { args: ['models'], source: 'grok models', timeoutMs: 20_000, maxBytes: 64 * 1024, parse: parseGrokModels },
  codex: { args: ['debug', 'models'], source: 'codex debug models', timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024, parse: parseCodexModels },
  qodercli: { args: ['--list-models'], source: 'qodercli --list-models', timeoutMs: 30_000, maxBytes: 64 * 1024, parse: parseQoderModels },
};

async function readSettings(dir: string): Promise<Record<string, unknown>> {
  const file = path.join(dir, 'settings.json');
  try {
    if ((await stat(file)).size > 512 * 1024) return {};
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/**
 * Claude Code has no list command, so offer what it documents (aliases and current names) and what this machine has
 * configured: the `model` and `availableModels` settings, `modelSettings` keys, and the model-name variables of the env block
 * (cc-switch fills those in for a third-party provider). Only model names are taken; no other value is read out.
 */
export async function claudeKnownModels(env: NodeJS.ProcessEnv): Promise<EngineModel[]> {
  const settings = await readSettings(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || homedir(), '.claude'));
  const configured: EngineModel[] = [];
  const add = (value: unknown, hint: string) => { if (typeof value === 'string' && NAME.test(value.trim())) configured.push({ id: value.trim(), hint }); };
  add(settings.model, '本机 settings.json 的当前模型');
  if (Array.isArray(settings.availableModels)) for (const item of settings.availableModels.slice(0, 50)) add(item, '本机 settings.json 允许的模型');
  if (settings.modelSettings && typeof settings.modelSettings === 'object' && !Array.isArray(settings.modelSettings)) for (const key of Object.keys(settings.modelSettings).slice(0, 50)) add(key, '本机 settings.json 已配置的模型');
  const block = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env as Record<string, unknown> : {};
  for (const key of CLAUDE_ENV_MODELS) add(block[key], `本机 settings.json 的 ${key}`);
  return unique([...configured, ...CLAUDE_ALIASES, ...CLAUDE_KNOWN.map(id => ({ id, hint: 'Claude Code 内置模型名' }))]);
}

export function parseModelListInput(value: unknown): EngineModelListInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型列表参数必须是对象');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['engine', 'refresh'].includes(key))) throw new Error('模型列表参数包含未知字段');
  if (typeof raw.engine !== 'string' || !catalogEntry(raw.engine)) throw new Error('该引擎不在支持范围内');
  if (raw.refresh !== undefined && typeof raw.refresh !== 'boolean') throw new Error('refresh 必须是布尔值');
  return { engine: raw.engine, ...(raw.refresh ? { refresh: true } : {}) };
}

export interface ModelListerOptions {
  pathEnv?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Tests inject recorded command output here. */
  run?: (executable: string, args: readonly string[], timeoutMs: number, maxBytes: number, env: NodeJS.ProcessEnv) => Promise<CaptureResult>;
  find?: (command: string, pathEnv: string) => Promise<string | undefined>;
}

/**
 * Lists the models an installed engine offers. Only the engines' own list commands run, with fixed arguments and without
 * a shell; none of them calls a model. Results are cached for a minute per engine, and concurrent calls share one run.
 */
export class EngineModelLister {
  private readonly cache = new Map<string, { at: number; list: EngineModelList }>();
  private readonly inflight = new Map<string, Promise<EngineModelList>>();
  constructor(private readonly options: ModelListerOptions = {}) {}

  list(input: EngineModelListInput): Promise<EngineModelList> {
    const key = input.engine;
    const clock = (this.options.now ?? (() => new Date()))().getTime();
    const hit = this.cache.get(key);
    if (!input.refresh && hit && clock - hit.at < CACHE_MS) return Promise.resolve(hit.list);
    const active = this.inflight.get(key);
    if (active) return active;
    const job = this.execute(input).then(list => {
      if (list.status === 'ok' || list.status === 'unsupported') this.cache.set(key, { at: clock, list });
      return list;
    }).finally(() => { if (this.inflight.get(key) === job) this.inflight.delete(key); });
    this.inflight.set(key, job);
    return job;
  }

  private async execute(input: EngineModelListInput): Promise<EngineModelList> {
    const entry = catalogEntry(input.engine);
    const fetchedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const base = { engine: input.engine, fetchedAt, models: [] as EngineModel[] };
    if (!entry) return { ...base, status: 'unsupported', source: '', message: NO_LIST_MESSAGE };
    const env = { ...(this.options.env ?? process.env) };
    delete env.ELECTRON_RUN_AS_NODE;
    if (entry.kind === 'claude') {
      return { ...base, status: 'ok', source: 'Claude Code 无列表命令，用内置名称与 settings.json 已配置的模型', models: await claudeKnownModels(env) };
    }
    const lister = LISTERS[entry.kind];
    if (!lister) return { ...base, status: 'unsupported', source: '', message: NO_LIST_MESSAGE };
    const pathEnv = this.options.pathEnv ?? process.env.PATH ?? '';
    const executable = await (this.options.find ?? findEngineExecutable)(entry.command, pathEnv);
    if (!executable) return { ...base, status: 'unavailable', source: lister.source, message: `未在本机找到 ${entry.command}，请手动填写` };
    env.PATH = pathEnv;
    const result = await (this.options.run ?? runCapture)(executable, lister.args, lister.timeoutMs, lister.maxBytes, env);
    if (result.error) return { ...base, status: 'failed', source: lister.source, message: `${lister.source} 无法运行` };
    if (result.timedOut) return { ...base, status: 'failed', source: lister.source, message: `${lister.source} 超时，请稍后重试或手动填写` };
    if (result.overflow) return { ...base, status: 'failed', source: lister.source, message: `${lister.source} 输出过大，无法解析` };
    if (result.code !== 0) return { ...base, status: 'failed', source: lister.source, message: `${lister.source} 退出码 ${result.code ?? '未知'}` };
    const models = lister.parse(result.stdout);
    if (!models.length) return { ...base, status: 'failed', source: lister.source, message: `${lister.source} 没有返回可用模型，请手动填写` };
    return { ...base, status: 'ok', source: lister.source, models };
  }
}
