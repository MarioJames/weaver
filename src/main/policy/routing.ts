// Derived from skill-foundry agents-cooperation, revision 61989b1 (Apache-2.0).
// Weaver adaptation: pure policy only; no CLI, sessions, launch flags, or host reads.
import type { Availability, Block, Config, Dispatch, Issue, Owner, RouteOptions } from '../../shared/contracts/policy';
import { availabilityOf, coveringBlock, isBlockActive } from '../../shared/policy/availability';
import { VENDOR_BLOCK_BY, isEngineBlock } from '../../shared/policy/blocks';
import { EFFORTS, FREE_CHANNEL_INTERVAL_RANGE, JANITOR_INTERVAL_RANGE, JANITOR_TTL_RANGE, MAX_COMMAND_MINUTES_RANGE, QUOTA_INTERVAL_RANGE, hasQuotaProbe, isValidTimezone } from '../../shared/policy/settings';
import { WEIGHT_MAX, effectiveWeight } from '../../shared/policy/weights';
import { type Schema, lintSchema, validate } from "./json-schema";
import CONFIG_SCHEMA from "./config.schema.json";
import DEFAULT_CONFIG from "./config.default.json";
lintSchema(CONFIG_SCHEMA);
export const defaultConfig = (): Config => structuredClone(DEFAULT_CONFIG) as Config;
const SUPPORTED_POLICY_KINDS = ["claude", "codex", "opencode", "qodercli", "grok", "pi", "dsh"];
export const ENGINE_KINDS: string[] = CONFIG_SCHEMA.$defs?.engine?.properties?.kind?.enum ?? [];

export class PolicyError extends Error {
  constructor(message: string, public issues: Issue[] = []) { super(message); }
}
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
  if (c.herdr.max_command_minutes !== undefined && (c.herdr.max_command_minutes < MAX_COMMAND_MINUTES_RANGE.min || c.herdr.max_command_minutes > MAX_COMMAND_MINUTES_RANGE.max)) bad("$.herdr.max_command_minutes", `max_command_minutes must be ${MAX_COMMAND_MINUTES_RANGE.min}-${MAX_COMMAND_MINUTES_RANGE.max} minutes`);
  if (c.display?.timezone) {
    if (!isValidTimezone(c.display.timezone)) bad("$.display.timezone", `timezone ${c.display.timezone} is not an IANA timezone name Intl supports`);
  }
  if (c.free_channel_probe && (c.free_channel_probe.interval_minutes < FREE_CHANNEL_INTERVAL_RANGE.min || c.free_channel_probe.interval_minutes > FREE_CHANNEL_INTERVAL_RANGE.max)) bad("$.free_channel_probe.interval_minutes", `interval must be ${FREE_CHANNEL_INTERVAL_RANGE.min}-${FREE_CHANNEL_INTERVAL_RANGE.max} minutes`);
  if (c.janitor) {
    if (c.janitor.ttl_hours < JANITOR_TTL_RANGE.min || c.janitor.ttl_hours > JANITOR_TTL_RANGE.max) bad("$.janitor.ttl_hours", `ttl must be ${JANITOR_TTL_RANGE.min}-${JANITOR_TTL_RANGE.max} hours`);
    if (c.janitor.interval_hours < JANITOR_INTERVAL_RANGE.min || c.janitor.interval_hours > JANITOR_INTERVAL_RANGE.max) bad("$.janitor.interval_hours", `interval must be ${JANITOR_INTERVAL_RANGE.min}-${JANITOR_INTERVAL_RANGE.max} hours`);
  }
  for (const [id, worker] of Object.entries(c.workers)) {
    const at = `$.workers.${id}`;
    const kind = Object.hasOwn(c.engines, worker.engine) ? c.engines[worker.engine]?.kind : undefined;
    if (!kind) { bad(`${at}.engine`, `unknown engine ${worker.engine}`); continue; }
    checkEffort(at, worker.engine, worker.effort);
    if (!SUPPORTED_POLICY_KINDS.includes(kind)) bad(`${at}.engine`, `kind ${kind} has no migrated routing policy`);
  }
  return issues;
}

// ---- escalation ----
const stamp = (value: string) => Date.parse(value);
export const ENGINE_ALL_BLOCKED_REASON = "该引擎全部子 Agent 均被限流/额度耗尽";
/** The block that covers each enabled worker of the engine, or undefined when any of them is free (or the engine has none). `pool` holds live blocks only. */
function coveringEnabledWorkers(config: Config, pool: Block[], engine: string): Block[] | undefined {
  const workers = Object.entries(config.workers).filter(([, w]) => w.engine === engine && w.enabled);
  if (!workers.length) return undefined;
  const covering: Block[] = [];
  for (const [id, worker] of workers) {
    const hit = coveringBlock(pool, worker, id);
    if (!hit) return undefined;
    covering.push(hit);
  }
  return covering;
}
/**
 * The user's 「恢复派发」 for one worker: every block naming it goes (any source, any model), and so does the
 * whole-engine 「全部子 Agent 均被限流」 vendor block when the engine is no longer fully blocked without it. Other workers'
 * blocks and whole-engine or model blocks from any other writer stay. Returns the same array when nothing goes.
 */
export function withoutWorkerBlocks(config: Config, blocks: Block[], engine: string, worker: string, now: number): { blocks: Block[]; removed: number } {
  const kept = blocks.filter(b => b.worker !== worker);
  const derived = kept.find(b => isEngineBlock(b, engine) && b.by === VENDOR_BLOCK_BY && b.reason === ENGINE_ALL_BLOCKED_REASON);
  const rest = derived ? kept.filter(b => b !== derived) : kept;
  const stillAllBlocked = derived !== undefined && coveringEnabledWorkers(config, rest.filter(b => isBlockActive(b, now)), engine) !== undefined;
  const next = derived && !stillAllBlocked ? rest : kept;
  return next.length === blocks.length ? { blocks, removed: 0 } : { blocks: next, removed: blocks.length - next.length };
}
/**
 * When every enabled worker of an engine is kept out by an active block, the engine itself is out: add one
 * whole-engine vendor block released at the earliest release_at among the blocks that cover those workers.
 * A whole-engine vendor block written earlier is refreshed in place; one from any other source already says so
 * and stays untouched; an expired one is replaced so the engine never holds two. Returns the same array when
 * nothing changes.
 */
export function escalateEngineBlock(config: Config, blocks: Block[], engine: string, now: number): Block[] {
  if (!config.engines[engine]?.enabled) return blocks;
  const live = (b: Block) => isBlockActive(b, now);
  const wholeEngine = (b: Block) => isEngineBlock(b, engine);
  if (blocks.some(b => wholeEngine(b) && live(b) && b.by !== VENDOR_BLOCK_BY)) return blocks;
  const own = blocks.find(b => wholeEngine(b) && live(b));
  const pool = blocks.filter(b => live(b) && b !== own);
  const covering = coveringEnabledWorkers(config, pool, engine);
  if (!covering) return blocks;
  const releases = covering.flatMap(b => b.release_at ? [stamp(b.release_at)] : []);
  const release_at = releases.length ? new Date(Math.min(...releases)).toISOString() : undefined;
  const block: Block = { engine, reason: ENGINE_ALL_BLOCKED_REASON, since: own?.since ?? new Date(now).toISOString(), by: VENDOR_BLOCK_BY, ...(release_at ? { release_at } : {}) };
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
function previewSelection(config: Config, ownerId: string, workerId: string, warnings: string[]): Dispatch {
 const owner = config.owners[ownerId]!;
 const worker = config.workers[workerId]!;
 return {owner:ownerId,worker:workerId,engine:worker.engine,model:worker.model,effort:worker.effort,
  execution:'disabled',dispatch:'preview',warnings,weight:effectiveWeight(owner,workerId)};
}
function requireOwner(config: Config, blocks: Block[], id: string, what = "owner"): Owner {
  const owner = Object.hasOwn(config.owners,id) ? config.owners[id] : undefined;
  if (!owner) throw new PolicyError(`unknown ${what} ${id}`);
  const a = availabilityOf(config, blocks, owner);
  if (a.status !== "available") throw new PolicyError(`${what} ${id} unavailable: ${describeUnavailable(a)}`);
  return owner;
}
/** Why an engine never comes back for this task: the owner's earlier attempt on it did not succeed. */
export const EXCLUDED_ENGINE_REASON = "failed earlier in this retry chain";
/** Why a worker never comes back for this task: the owner's earlier attempt on it did not succeed. */
export const EXCLUDED_WORKER_REASON = "failed earlier in this retry chain";
/** Why a worker was passed over only because the policy caps its own concurrency: n running against a cap of max. */
export const WORKER_CAPACITY_REASON = "并发已满";
/** A worker's concurrency cap: a positive integer, or nothing when it carries none. */
export const workerCap = (worker: { max_parallel?: number } | undefined): number | undefined => {
  const cap = worker?.max_parallel;
  return cap !== undefined && Number.isSafeInteger(cap) && cap >= 1 ? cap : undefined;
};
export const workerCapacityText = (running: number, limit: number): string => `${WORKER_CAPACITY_REASON}（${running}/${limit}）`;
/**
 * An explicit worker, or the owner's least-loaded available worker relative to its weight:
 * the lowest (running + 1) / weight wins, ties go to the higher weight, then to list order.
 * Idle workers are tried by weight; under load, work spreads in proportion to the weights.
 * A worker with a max_parallel runs at most that many tasks at once across every owner; a worker at its cap is
 * skipped as 并发已满（n/max）, so the choice falls to another worker. When
 * every worker that could take the task is at its cap, the least-overloaded one is still selected and the
 * queue waits on its next free slot. A worker excluded by ID or by its engine is never selected.
 */
export function resolveDispatch(config: Config, blocks: Block[], opts: RouteOptions): Dispatch {
  const owner = requireOwner(config, blocks, opts.owner);
  const excluded = new Set(opts.excludeEngines ?? []);
  const excludedWorkers = new Set(opts.excludeWorkers ?? []);
  const capOf = (workerId: string): number | undefined => workerCap(config.workers[workerId]);
  if (opts.worker) {
    const worker = Object.hasOwn(config.workers,opts.worker) ? config.workers[opts.worker] : undefined;
    if (!worker) throw new PolicyError(`unknown worker ${opts.worker}`);
    if (excludedWorkers.has(opts.worker)) throw new PolicyError(`NO_ALTERNATIVE_WORKER: worker ${opts.worker} ${EXCLUDED_WORKER_REASON} (excluded: ${[...excludedWorkers].join(", ")})`, [{ path: `$.owners.${opts.owner}.workers`, message: `${opts.worker}: ${EXCLUDED_WORKER_REASON}` }]);
    if (excluded.has(worker.engine)) throw new PolicyError(`NO_ALTERNATIVE_ENGINE: worker ${opts.worker} runs on engine ${worker.engine}, which ${EXCLUDED_ENGINE_REASON} (excluded: ${[...excluded].join(", ")})`, [{ path: `$.owners.${opts.owner}.workers`, message: `${opts.worker}: ${EXCLUDED_ENGINE_REASON}` }]);
    const a = availabilityOf(config, blocks, worker, opts.worker);
    if (a.status !== "available") throw new PolicyError(`worker ${opts.worker} unavailable: ${describeUnavailable(a)}`);
    if (effectiveWeight(owner, opts.worker) === 0) throw new PolicyError(`worker ${opts.worker} unavailable: priority weight 0`);
    const warnings = owner.workers.includes(opts.worker) ? [] : [`worker ${opts.worker} 不在 owner ${opts.owner} 的 workers 列表中`];
    return { ...previewSelection(config, opts.owner, opts.worker, warnings), selected_by: "worker" };
  }
  const load = (id: string) => opts.workerLoad?.[id] ?? 0;
  const candidates = owner.workers
    .map((id, index) => ({ id, index, engine: config.workers[id]!.engine, weight: effectiveWeight(owner, id), running: load(id), availability: availabilityOf(config, blocks, config.workers[id]!, id) }));
  const atCap = (c: (typeof candidates)[number]) => {
    const cap = capOf(c.id);
    return cap !== undefined && c.running >= cap;
  };
  const reason = (c: (typeof candidates)[number]) => {
    const cap = atCap(c) ? capOf(c.id)! : undefined;
    return c.weight === 0 ? "priority weight 0"
      : excludedWorkers.has(c.id) ? "excluded for this dispatch"
      : c.availability.status !== "available" ? describeUnavailable(c.availability)
      : excluded.has(c.engine) ? EXCLUDED_ENGINE_REASON
      : cap !== undefined ? workerCapacityText(c.running, cap)
      : "available";
  };
  const available = candidates.filter(c => c.weight > 0 && c.availability.status === "available");
  const usable = available.filter(c => !excludedWorkers.has(c.id));
  // (a+1)/wa < (b+1)/wb, compared without division.
  const eligible = usable.filter(c => !excluded.has(c.engine) && !atCap(c))
    .sort((a, b) => (a.running + 1) * b.weight - (b.running + 1) * a.weight || b.weight - a.weight || a.index - b.index);
  const hit = eligible[0];
  if (!hit) {
    if (usable.length) {
      const deferred = usable.filter(c => !excluded.has(c.engine));
      if (deferred.length) {
        // Every worker that could run this task is at its own cap. Freeze the one closest to a free slot
        // (smallest running over cap, then the stronger weight, then the list order); the queue waits on it.
        const excess = (c: (typeof candidates)[number]) => c.running - capOf(c.id)!;
        const chosen = [...deferred].sort((a, b) => excess(a) - excess(b) || b.weight - a.weight || a.index - b.index)[0]!;
        return { ...previewSelection(config, opts.owner, chosen.id, []), selected_by: "weight", skipped: candidates.map(c => ({ worker: c.id, reason: reason(c) })), candidates: [] };
      }
      const detail = usable.map(c => `${c.id}: ${EXCLUDED_ENGINE_REASON}`).join("; ");
      throw new PolicyError(`NO_ALTERNATIVE_ENGINE: every available worker for owner ${opts.owner} is on an excluded engine (excluded: ${[...excluded].join(", ")}): ${detail}`, usable.map(c => ({ path: `$.owners.${opts.owner}.workers`, message: `${c.id}: ${EXCLUDED_ENGINE_REASON}` })));
    }
    if (available.length) throw new PolicyError(`NO_ALTERNATIVE_WORKER: every available worker for owner ${opts.owner} ${EXCLUDED_WORKER_REASON} (excluded: ${[...excludedWorkers].join(", ")}): ${available.map(c => `${c.id}: ${EXCLUDED_WORKER_REASON}`).join("; ")}`, available.map(c => ({ path: `$.owners.${opts.owner}.workers`, message: `${c.id}: ${EXCLUDED_WORKER_REASON}` })));
    const detail = candidates.map(c => `${c.id}: ${reason(c)}`).join("; ");
    throw new PolicyError(`no available worker for owner ${opts.owner}${detail ? `: ${detail}` : ""}`, candidates.map(c => ({ path: `$.owners.${opts.owner}.workers`, message: `${c.id}: ${reason(c)}` })));
  }
  const skipped = candidates.filter(c => !eligible.includes(c)).map(c => ({ worker: c.id, reason: reason(c) }));
  return { ...previewSelection(config, opts.owner, hit.id, []), selected_by: "weight", skipped, candidates: eligible.map(c => ({ worker: c.id, weight: c.weight, running: c.running })) };
}
