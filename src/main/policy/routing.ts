import { validateProxy } from '../../shared/proxy';
// Derived from skill-foundry agents-cooperation, revision 61989b1 (Apache-2.0).
// Weaver adaptation: pure policy only; no CLI, sessions, launch flags, or host reads.
import { type Issue, type Schema, lintSchema, validate } from "./json-schema";
import CONFIG_SCHEMA from "./config.schema.json";
import DEFAULT_CONFIG from "./config.default.json";
lintSchema(CONFIG_SCHEMA);
export const defaultConfig = (): Config => structuredClone(DEFAULT_CONFIG) as Config;
/** The single kind -> legal effort table; kinds not listed accept any non-empty string. */
export const EFFORTS: Record<string, string[]> = {
  zcode: ["auto"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max"],
  grok: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  qodercli: ["auto", "none", "low", "medium", "high", "xhigh", "max", "ultracode"],
};
const SUPPORTED_POLICY_KINDS = ["claude", "codex", "opencode", "qodercli", "grok", "pi", "zcode"];
export const ENGINE_KINDS: string[] = CONFIG_SCHEMA.$defs?.engine?.properties?.kind?.enum ?? [];

export class PolicyError extends Error {
  constructor(message: string, public issues: Issue[] = []) { super(message); }
}
export interface Engine { enabled: boolean; kind: string; quota_refresh?: boolean }
/** Kinds with a native account quota probe. Other kinds have no native quota probe; this does not imply a free route. */
export const QUOTA_KINDS = ["codex", "claude", "grok"] as const;
const hasQuotaProbe = (kind: string) => (QUOTA_KINDS as readonly string[]).includes(kind);
/** Missing means on for kinds with a quota probe, off otherwise. */
export function quotaRefreshEnabled(engine: Engine): boolean {
  return engine.quota_refresh ?? hasQuotaProbe(engine.kind);
}
export interface QuotaSettings { auto_refresh: boolean; interval_minutes: number }
export const QUOTA_INTERVAL_RANGE = { min: 5, max: 1440 } as const;
export function quotaSettings(config: { quota?: QuotaSettings }): QuotaSettings {
  return config.quota ?? { auto_refresh: true, interval_minutes: 15 };
}
/** Scheduled live probes of free_channel workers; missing means enabled every 10 minutes. */
export interface FreeChannelProbeSettings { enabled: boolean; interval_minutes: number }
export const FREE_CHANNEL_INTERVAL_RANGE = { min: 5, max: 1440 } as const;
export function freeChannelProbeSettings(config: { free_channel_probe?: FreeChannelProbeSettings }): FreeChannelProbeSettings {
  return config.free_channel_probe ?? { enabled: true, interval_minutes: 10 };
}
export interface Owner { proxy?: string; enabled: boolean; engine: string; model: string; effort: string; workers: string[]; max_parallel: number; worker_weights?: Record<string, number> }
/** Weights are integers 0..10. Omitted means 5 (the middle). Higher is tried first; 0 never dispatches. This is priority, not a probability. */
export const WEIGHT_MAX = 10;
export const DEFAULT_WEIGHT = 5;
export function effectiveWeight(owner: Owner, workerId: string): number {
  const weights = owner.worker_weights;
  if (!weights || !Object.hasOwn(weights, workerId)) return DEFAULT_WEIGHT;
  return weights[workerId]!;
}
export interface Worker { proxy?: string; free_channel?: boolean; enabled: boolean; engine: string; model: string; effort: string; description?: string }
export interface Herdr { max_wait_minutes: number }
/** Rendering preferences; missing means follow the browser. */
export interface Display { timezone?: string }
export interface Config { version: 1; chatgpt_review?: boolean; quota?: QuotaSettings; free_channel_probe?: FreeChannelProbeSettings; display?: Display; engines: Record<string, Engine>; owners: Record<string, Owner>; workers: Record<string, Worker>; herdr: Herdr }
/** An IANA timezone name Intl can format; empty keeps the browser's zone. */
export function isValidTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat(undefined, { timeZone: value }); return true; } catch { return false; }
}
/** Effective automatic ChatGPT review switch. Only boolean false disables it; a missing field stays enabled. Non-booleans are schema errors and are not coerced. */
export function chatgptReviewEnabled(config: { chatgpt_review?: unknown }): boolean {
  return config.chatgpt_review !== false;
}
/** A block with `worker` keeps only that worker out; without it the block covers the whole engine (or one model of it). */
export interface Block { engine: string; model?: string; worker?: string; reason: string; since: string; release_at?: string; by?: string }
export interface State { version: 1; blocks: Block[] }
export interface Availability { status: "available" | "disabled" | "engine_disabled" | "blocked"; engine?: string; model?: string; worker?: string; reason?: string; release_at?: string }

// ---- config validation ----
export function validateConfig(config: unknown, schema: Schema = CONFIG_SCHEMA): Issue[] {
  const issues = validate(schema, config);
  if (issues.length) return issues;
  const c = config as Config;
  const bad = (path: string, message: string) => issues.push({ path, message });
  const checkEffort = (path: string, engineId: string, effort: string) => {
    const kind = c.engines[engineId]?.kind;
    const allowed = kind ? EFFORTS[kind] : undefined;
    if (allowed && !allowed.includes(effort)) bad(`${path}.effort`, `${kind} effort must be one of ${allowed.join("|")}`);
  };
  for (const [section, records] of [["owners", c.owners], ["workers", c.workers]] as const) {
    for (const [id, role] of Object.entries(records)) {
      try { validateProxy(role.proxy); } catch (error) { bad(`$.${section}.${id}.proxy`, (error as Error).message); }
    }
  }
  const owned = new Map<string, string>();
  for (const [id, owner] of Object.entries(c.owners)) {
    const at = `$.owners.${id}`;
    const engine = Object.hasOwn(c.engines, owner.engine) ? c.engines[owner.engine] : undefined;
    if (!engine) bad(`${at}.engine`, `unknown engine ${owner.engine}`);
    else checkEffort(at, owner.engine, owner.effort);
    owner.workers.forEach((worker, i) => { if (!Object.hasOwn(c.workers, worker)) bad(`${at}.workers[${i}]`, `unknown worker ${worker}`); });
    if (owner.worker_weights) {
      for (const [workerId, weight] of Object.entries(owner.worker_weights)) {
        const atWeight = `${at}.worker_weights[${JSON.stringify(workerId)}]`;
        if (!owner.workers.includes(workerId)) bad(atWeight, `weight key ${workerId} is not in this owner's workers`);
        if (!Number.isInteger(weight) || weight < 0 || weight > WEIGHT_MAX) bad(atWeight, `weight must be an integer from 0 to ${WEIGHT_MAX}`);
      }
    }
    if (!owner.enabled) continue;
    const other = owned.get(owner.engine);
    if (other) bad(at, `engine ${owner.engine} already has enabled owner ${other}`);
    else owned.set(owner.engine, id);
    const hasWorker = owner.workers.some(workerId => c.workers[workerId]?.enabled);
    if (!hasWorker) bad(`${at}.workers`, "enabled owner needs at least one enabled worker");
  }
  for (const [id, engine] of Object.entries(c.engines)) {
    if (engine.quota_refresh === true && !hasQuotaProbe(engine.kind)) bad(`$.engines.${id}.quota_refresh`, `kind ${engine.kind} has no quota probe`);
  }
  if (c.quota && (c.quota.interval_minutes < QUOTA_INTERVAL_RANGE.min || c.quota.interval_minutes > QUOTA_INTERVAL_RANGE.max)) bad("$.quota.interval_minutes", `interval must be ${QUOTA_INTERVAL_RANGE.min}-${QUOTA_INTERVAL_RANGE.max} minutes`);
  if (c.display?.timezone) {
    if (!isValidTimezone(c.display.timezone)) bad("$.display.timezone", `timezone ${c.display.timezone} is not an IANA timezone name Intl supports`);
  }
  if (c.free_channel_probe && (c.free_channel_probe.interval_minutes < FREE_CHANNEL_INTERVAL_RANGE.min || c.free_channel_probe.interval_minutes > FREE_CHANNEL_INTERVAL_RANGE.max)) bad("$.free_channel_probe.interval_minutes", `interval must be ${FREE_CHANNEL_INTERVAL_RANGE.min}-${FREE_CHANNEL_INTERVAL_RANGE.max} minutes`);
  for (const [id, worker] of Object.entries(c.workers)) {
    const at = `$.workers.${id}`;
    const kind = Object.hasOwn(c.engines, worker.engine) ? c.engines[worker.engine]?.kind : undefined;
    if (!kind) { bad(`${at}.engine`, `unknown engine ${worker.engine}`); continue; }
    checkEffort(at, worker.engine, worker.effort);
    if (!SUPPORTED_POLICY_KINDS.includes(kind)) bad(`${at}.engine`, `kind ${kind} has no migrated routing policy`);
  }
  return issues;
}

// ---- availability ----
const stamp = (value: string) => Date.parse(value);
export function activeBlocks(state: State, now: number): Block[] {
  return state.blocks.filter(b => !b.release_at || stamp(b.release_at) > now);
}
/** The block that keeps a role out, if any. A worker-scoped block reaches only the worker it names, never an owner or a sibling. */
export function coveringBlock(blocks: Block[], entity: Owner | Worker, workerId?: string): Block | undefined {
  return blocks.find(b => b.engine === entity.engine
    && (b.worker === undefined || b.worker === workerId)
    && (b.model === undefined || b.model === entity.model)
    && !("free_channel" in entity && entity.free_channel === true && b.by?.startsWith("weaver-quota:")));
}
/** workerId is the policy key of a worker; omit it for owners, which no worker-scoped block can reach. */
export function availabilityOf(config: Config, blocks: Block[], entity: Owner | Worker, workerId?: string): Availability {
  if (!entity.enabled) return { status: "disabled" };
  if (!config.engines[entity.engine]?.enabled) return { status: "engine_disabled" };
  const hit = coveringBlock(blocks, entity, workerId);
  if (hit) return { status: "blocked", engine: hit.engine, ...(hit.model ? { model: hit.model } : {}), ...(hit.worker ? { worker: hit.worker } : {}), reason: hit.reason, ...(hit.release_at ? { release_at: hit.release_at } : {}) };
  return { status: "available" };
}
/** Written by vendor rate-limit / quota failures; the only source the engine-level escalation may rewrite. */
export const VENDOR_BLOCK_SOURCE = "weaver-vendor-limit";
export const ENGINE_ALL_BLOCKED_REASON = "该引擎全部子 Agent 均被限流/额度耗尽";
/**
 * When every enabled worker of an engine is kept out by an active block, the engine itself is out: add one
 * whole-engine vendor block released at the earliest release_at among the blocks that cover those workers.
 * A whole-engine vendor block written earlier is refreshed in place; one from any other source already says so
 * and stays untouched; an expired one is replaced so the engine never holds two. Returns the same array when
 * nothing changes.
 */
export function escalateEngineBlock(config: Config, blocks: Block[], engine: string, now: number): Block[] {
  if (!config.engines[engine]?.enabled) return blocks;
  const live = (b: Block) => !b.release_at || stamp(b.release_at) > now;
  const wholeEngine = (b: Block) => b.engine === engine && b.model === undefined && b.worker === undefined;
  if (blocks.some(b => wholeEngine(b) && live(b) && b.by !== VENDOR_BLOCK_SOURCE)) return blocks;
  const own = blocks.find(b => wholeEngine(b) && live(b));
  const pool = blocks.filter(b => live(b) && b !== own);
  const workers = Object.entries(config.workers).filter(([, w]) => w.engine === engine && w.enabled);
  if (!workers.length) return blocks;
  const covering: Block[] = [];
  for (const [id, worker] of workers) {
    const hit = coveringBlock(pool, worker, id);
    if (!hit) return blocks;
    covering.push(hit);
  }
  const releases = covering.flatMap(b => b.release_at ? [stamp(b.release_at)] : []);
  const release_at = releases.length ? new Date(Math.min(...releases)).toISOString() : undefined;
  const block: Block = { engine, reason: ENGINE_ALL_BLOCKED_REASON, since: own?.since ?? new Date(now).toISOString(), by: VENDOR_BLOCK_SOURCE, ...(release_at ? { release_at } : {}) };
  if (own) return own.release_at === release_at && own.reason === block.reason ? blocks : blocks.map(b => b === own ? block : b);
  const stale = blocks.find(wholeEngine);
  return [...blocks.filter(b => b !== stale), block];
}
const describeUnavailable = (a: Availability) =>
  a.status === "blocked" ? `blocked (${a.model ? `${a.engine}/${a.model}` : a.worker ? `${a.engine} worker ${a.worker}` : a.engine}: ${a.reason}${a.release_at ? `, release_at ${a.release_at}` : ""})` : a.status;
/** --release-at: an ISO 8601 timestamp with timezone (returned as given), or +<n>m|h|d counted from now (n >= 1). */
export function parseReleaseAt(value: string, now: number): string {
  const relative = /^\+([1-9][0-9]*)([mhd])$/.exec(value);
  if (relative) {
    const date = new Date(now + Number(relative[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"]);
    if (!Number.isFinite(date.getTime())) throw new PolicyError("release time out of range");
    return date.toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(stamp(value))) {
    throw new PolicyError(`invalid --release-at ${value}; use ISO 8601 with timezone or +<n>m|h|d`);
  }
  return value;
}

// ---- resolve ----
export interface Dispatch {
 proxy?: string;
 owner: string; worker: string; engine: string; model: string; effort: string;
 execution: 'disabled'; dispatch: 'preview'; warnings: string[];
 selected_by?: 'worker' | 'weight'; skipped?: {worker:string; reason:string}[];
 /** Effective weight of the selected worker. Omitted config means 5. */
 weight?: number;
 /** Dispatchable workers in the order they would be chosen, with the running count the choice used. */
 candidates?: {worker:string; weight:number; running:number}[];
}
function previewSelection(config: Config, ownerId: string, workerId: string, warnings: string[]): Dispatch {
 const owner = config.owners[ownerId]!;
 const worker = config.workers[workerId]!;
 return {proxy:worker.proxy,owner:ownerId,worker:workerId,engine:worker.engine,model:worker.model,effort:worker.effort,
  execution:'disabled',dispatch:'preview',warnings,weight:effectiveWeight(owner,workerId)};
}
function requireOwner(config: Config, blocks: Block[], id: string, what = "owner"): Owner {
  const owner = Object.hasOwn(config.owners,id) ? config.owners[id] : undefined;
  if (!owner) throw new PolicyError(`unknown ${what} ${id}`);
  const a = availabilityOf(config, blocks, owner);
  if (a.status !== "available") throw new PolicyError(`${what} ${id} unavailable: ${describeUnavailable(a)}`);
  return owner;
}
export interface RouteOptions { owner: string; worker?: string; /** Running tasks per worker, across all owners. */ workerLoad?: Record<string, number>; /** Engines whose attempt already failed or was cancelled earlier in this task's retry chain. */ excludeEngines?: string[]; /** Workers that must not be chosen, for example the one a queued task was frozen to before it was blocked. */ excludeWorkers?: string[] }
/** Why an engine never comes back for this task: the owner's earlier attempt on it did not succeed. */
export const EXCLUDED_ENGINE_REASON = "failed earlier in this retry chain";
/**
 * An explicit worker, or the owner's least-loaded available worker relative to its weight:
 * the lowest (running + 1) / weight wins, ties go to the higher weight, then to list order.
 * Idle workers are tried by weight; under load, work spreads in proportion to the weights.
 * A worker on an excluded engine is never selected, so a retry always changes engine.
 */
export function resolveDispatch(config: Config, blocks: Block[], opts: RouteOptions): Dispatch {
  const owner = requireOwner(config, blocks, opts.owner);
  const excluded = new Set(opts.excludeEngines ?? []);
  const excludedWorkers = new Set(opts.excludeWorkers ?? []);
  if (opts.worker) {
    const worker = Object.hasOwn(config.workers,opts.worker) ? config.workers[opts.worker] : undefined;
    if (!worker) throw new PolicyError(`unknown worker ${opts.worker}`);
    if (excluded.has(worker.engine)) throw new PolicyError(`NO_ALTERNATIVE_ENGINE: worker ${opts.worker} runs on engine ${worker.engine}, which ${EXCLUDED_ENGINE_REASON} (excluded: ${[...excluded].join(", ")})`, [{ path: `$.owners.${opts.owner}.workers`, message: `${opts.worker}: ${EXCLUDED_ENGINE_REASON}` }]);
    if (excludedWorkers.has(opts.worker)) throw new PolicyError(`worker ${opts.worker} unavailable: excluded for this dispatch`);
    const a = availabilityOf(config, blocks, worker, opts.worker);
    if (a.status !== "available") throw new PolicyError(`worker ${opts.worker} unavailable: ${describeUnavailable(a)}`);
    if (effectiveWeight(owner, opts.worker) === 0) throw new PolicyError(`worker ${opts.worker} unavailable: priority weight 0`);
    const warnings = owner.workers.includes(opts.worker) ? [] : [`worker ${opts.worker} 不在 owner ${opts.owner} 的 workers 列表中`];
    return { ...previewSelection(config, opts.owner, opts.worker, warnings), selected_by: "worker" };
  }
  const load = (id: string) => opts.workerLoad?.[id] ?? 0;
  const candidates = owner.workers
    .map((id, index) => ({ id, index, engine: config.workers[id]!.engine, weight: effectiveWeight(owner, id), running: load(id), availability: availabilityOf(config, blocks, config.workers[id]!, id) }));
  const reason = (c: (typeof candidates)[number]) => c.weight === 0 ? "priority weight 0" : excludedWorkers.has(c.id) ? "excluded for this dispatch" : c.availability.status !== "available" ? describeUnavailable(c.availability) : excluded.has(c.engine) ? EXCLUDED_ENGINE_REASON : "available";
  const usable = candidates.filter(c => c.weight > 0 && c.availability.status === "available" && !excludedWorkers.has(c.id));
  // (a+1)/wa < (b+1)/wb, compared without division.
  const eligible = usable.filter(c => !excluded.has(c.engine))
    .sort((a, b) => (a.running + 1) * b.weight - (b.running + 1) * a.weight || b.weight - a.weight || a.index - b.index);
  const hit = eligible[0];
  if (!hit) {
    if (usable.length) {
      const detail = usable.map(c => `${c.id}: ${EXCLUDED_ENGINE_REASON}`).join("; ");
      throw new PolicyError(`NO_ALTERNATIVE_ENGINE: every available worker for owner ${opts.owner} is on an excluded engine (excluded: ${[...excluded].join(", ")}): ${detail}`, usable.map(c => ({ path: `$.owners.${opts.owner}.workers`, message: `${c.id}: ${EXCLUDED_ENGINE_REASON}` })));
    }
    const detail = candidates.map(c => `${c.id}: ${reason(c)}`).join("; ");
    throw new PolicyError(`no available worker for owner ${opts.owner}${detail ? `: ${detail}` : ""}`, candidates.map(c => ({ path: `$.owners.${opts.owner}.workers`, message: `${c.id}: ${reason(c)}` })));
  }
  const skipped = candidates.filter(c => !eligible.includes(c)).map(c => ({ worker: c.id, reason: reason(c) }));
  return { ...previewSelection(config, opts.owner, hit.id, []), selected_by: "weight", skipped, candidates: eligible.map(c => ({ worker: c.id, weight: c.weight, running: c.running })) };
}
