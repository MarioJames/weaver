import { roleEngine } from '../../shared/policy/channels';
// Derived from skill-foundry agents-cooperation, revision 61989b1 (Apache-2.0).
// Weaver adaptation: pure policy only; no CLI, sessions, launch flags, or host reads.
import type { Availability, Block, Config, Dispatch, Issue, Owner, RouteOptions } from '../../shared/contracts/policy';
import { availabilityOf, coveringBlock, isBlockActive } from '../../shared/policy/availability';
import { ENGINE_ALL_BLOCKED_REASON, VENDOR_BLOCK_BY, isEngineBlock } from '../../shared/policy/blocks';
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
  for (const [id, channel] of Object.entries(c.channels)) {
    if (['__proto__','constructor','prototype'].includes(id)) bad(`$.channels.${id}`, 'Reserved channel id');
    if (!Object.hasOwn(c.engines,channel.engine)) bad(`$.channels.${id}.engine`, 'Engine is not configured');
    if ((['pi','dsh'].includes(c.engines[channel.engine]?.kind ?? '')) && channel.kind !== 'api') bad(`$.channels.${id}.kind`, 'This engine requires an API channel');
    if (channel.kind === 'subscription' && (channel.provider !== undefined || channel.protocol !== undefined || channel.baseUrl !== undefined)) bad(`$.channels.${id}`, 'Subscription cannot carry API fields');
    if (channel.baseUrl !== undefined) { try { const url=new URL(channel.baseUrl); if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); } catch { bad(`$.channels.${id}.baseUrl`, 'Expected HTTP(S) URL without credentials, query or fragment'); } }
  }
  for (const [section, roles] of [['owners',c.owners],['workers',c.workers]] as const) for (const [id, role] of Object.entries(roles)) if (!Object.hasOwn(c.channels,role.channel)) bad(`$.${section}.${id}.channel`, `Unknown channel ${role.channel}`);
  if (issues.length) return issues;
  const owned = new Map<string, string>();
  for (const [id, owner] of Object.entries(c.owners)) {
    const at = `$.owners.${id}`;
    const engine = Object.hasOwn(c.engines, roleEngine(c, owner)) ? c.engines[roleEngine(c, owner)] : undefined;
    if (!engine) bad(`${at}.engine`, `unknown engine ${roleEngine(c, owner)}`);
    else checkEffort(at, roleEngine(c, owner), owner.effort);
    owner.workers.forEach((worker, i) => { if (!Object.hasOwn(c.workers, worker)) bad(`${at}.workers[${i}]`, `unknown worker ${worker}`); });
    if (owner.worker_weights) {
      for (const [workerId, weight] of Object.entries(owner.worker_weights)) {
        const atWeight = `${at}.worker_weights[${JSON.stringify(workerId)}]`;
        if (!owner.workers.includes(workerId)) bad(atWeight, `weight key ${workerId} is not in this owner's workers`);
        if (!Number.isInteger(weight) || weight < 0 || weight > WEIGHT_MAX) bad(atWeight, `weight must be an integer from 0 to ${WEIGHT_MAX}`);
      }
    }
    if (!owner.enabled) continue;
    const other = owned.get(owner.channel);
    if (other) bad(at, `engine ${roleEngine(c, owner)} already has enabled owner ${other}`);
    else owned.set(owner.channel, id);
    const hasWorker = owner.workers.some(workerId => c.workers[workerId]?.enabled);
    if (!hasWorker) bad(`${at}.workers`, "enabled owner needs at least one enabled worker");
  }
  for (const [id, channel] of Object.entries(c.channels)) {
    if (channel.quota_refresh === true && (channel.kind !== 'subscription' || !hasQuotaProbe(c.engines[channel.engine]!.kind))) bad(`$.channels.${id}.quota_refresh`, 'Channel has no native quota probe');
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
    const kind = Object.hasOwn(c.engines, roleEngine(c, worker)) ? c.engines[roleEngine(c, worker)]?.kind : undefined;
    if (!kind) { bad(`${at}.engine`, `unknown engine ${roleEngine(c, worker)}`); continue; }
    checkEffort(at, roleEngine(c, worker), worker.effort);
    if (!SUPPORTED_POLICY_KINDS.includes(kind)) bad(`${at}.engine`, `kind ${kind} has no migrated routing policy`);
  }
  return issues;
}

// ---- escalation ----
const stamp = (value: string) => Date.parse(value);
export { ENGINE_ALL_BLOCKED_REASON } from '../../shared/policy/blocks';
/** The block that covers each enabled worker of the engine, or undefined when any of them is free (or the engine has none). `pool` holds live blocks only. */
function coveringEnabledWorkers(config: Config, pool: Block[], engine: string, channel?: string): Block[] | undefined {
  const workers = Object.entries(config.workers).filter(([, w]) => roleEngine(config, w) === engine && w.enabled && (channel === undefined || w.channel === channel));
  if (!workers.length) return undefined;
  const covering: Block[] = [];
  for (const [id, worker] of workers) {
    const hit = coveringBlock(pool, worker, id, config);
    if (!hit) return undefined;
    covering.push(hit);
  }
  return covering;
}
/** Clear this worker's blocks and derived channel pauses that its recovery invalidates. */
export function withoutWorkerBlocks(config: Config, blocks: Block[], engine: string, worker: string, now: number): { blocks: Block[]; removed: number } {
  let next = blocks.filter(b => b.worker !== worker);
  for (const derived of next.filter(b => b.engine === engine && b.worker === undefined && b.model === undefined && b.by === VENDOR_BLOCK_BY && b.reason === ENGINE_ALL_BLOCKED_REASON)) {
    const rest=next.filter(b=>b!==derived);
    if (!coveringEnabledWorkers(config, rest.filter(b=>isBlockActive(b,now)), engine, derived.channel)) next=rest;
  }
  return next.length === blocks.length ? { blocks, removed: 0 } : { blocks: next, removed: blocks.length - next.length };
}
/** Vendor limits aggregate within a channel; an account's blocked pool cannot pause another account. */
export function escalateEngineBlock(config: Config, blocks: Block[], engine: string, now: number): Block[] {
  if (!Object.hasOwn(config.engines,engine)) return blocks;
  const live=(b:Block)=>isBlockActive(b,now);
  if(blocks.some(b=>isEngineBlock(b,engine)&&live(b))) return blocks;
  let next=blocks;
  for(const [channelId,channel] of Object.entries(config.channels)) {
    if(channel.engine!==engine||!channel.enabled) continue;
    const same=(b:Block)=>b.engine===engine&&b.channel===channelId&&b.worker===undefined&&b.model===undefined;
    const own=next.find(b=>same(b)&&live(b));
    if(own&&own.by!==VENDOR_BLOCK_BY) continue;
    const covering=coveringEnabledWorkers(config,next.filter(b=>live(b)&&b!==own),engine,channelId);
    if(!covering)continue;
    const releases=covering.flatMap(b=>b.release_at?[stamp(b.release_at)]:[]);
    const release_at=releases.length?new Date(Math.min(...releases)).toISOString():undefined;
    const block:Block={engine,channel:channelId,reason:ENGINE_ALL_BLOCKED_REASON,since:own?.since??new Date(now).toISOString(),by:VENDOR_BLOCK_BY,...(release_at?{release_at}:{})};
    if(own){if(own.release_at!==release_at||own.reason!==block.reason)next=next.map(b=>b===own?block:b);}
    else next=[...next.filter(b=>!same(b)),block];
  }
  return next;
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
 return {owner:ownerId,worker:workerId,channel:worker.channel,engine:roleEngine(config, worker),model:worker.model,effort:worker.effort,
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
  const excludedChannels = new Set(opts.excludeChannels ?? []);
  const excludedWorkers = new Set(opts.excludeWorkers ?? []);
  const capOf = (workerId: string): number | undefined => workerCap(config.workers[workerId]);
  if (opts.worker) {
    const worker = Object.hasOwn(config.workers,opts.worker) ? config.workers[opts.worker] : undefined;
    if (!worker) throw new PolicyError(`unknown worker ${opts.worker}`);
    if (excludedWorkers.has(opts.worker)) throw new PolicyError(`NO_ALTERNATIVE_WORKER: worker ${opts.worker} ${EXCLUDED_WORKER_REASON} (excluded: ${[...excludedWorkers].join(", ")})`, [{ path: `$.owners.${opts.owner}.workers`, message: `${opts.worker}: ${EXCLUDED_WORKER_REASON}` }]);
    if (excludedChannels.has(worker.channel)) throw new PolicyError(`NO_ALTERNATIVE_CHANNEL: channel ${worker.channel} failed earlier in this retry chain`);
    if (excluded.has(roleEngine(config, worker))) throw new PolicyError(`NO_ALTERNATIVE_ENGINE: worker ${opts.worker} runs on engine ${roleEngine(config, worker)}, which ${EXCLUDED_ENGINE_REASON} (excluded: ${[...excluded].join(", ")})`, [{ path: `$.owners.${opts.owner}.workers`, message: `${opts.worker}: ${EXCLUDED_ENGINE_REASON}` }]);
    const a = availabilityOf(config, blocks, worker, opts.worker);
    if (a.status !== "available") throw new PolicyError(`worker ${opts.worker} unavailable: ${describeUnavailable(a)}`);
    if (effectiveWeight(owner, opts.worker) === 0) throw new PolicyError(`worker ${opts.worker} unavailable: priority weight 0`);
    const warnings = owner.workers.includes(opts.worker) ? [] : [`worker ${opts.worker} 不在 owner ${opts.owner} 的 workers 列表中`];
    return { ...previewSelection(config, opts.owner, opts.worker, warnings), selected_by: "worker" };
  }
  const load = (id: string) => opts.workerLoad?.[id] ?? 0;
  const candidates = owner.workers
    .map((id, index) => ({ id, index, channel: config.workers[id]!.channel, engine: roleEngine(config, config.workers[id]!), weight: effectiveWeight(owner, id), running: load(id), availability: availabilityOf(config, blocks, config.workers[id]!, id) }));
  const atCap = (c: (typeof candidates)[number]) => {
    const cap = capOf(c.id);
    return cap !== undefined && c.running >= cap;
  };
  const reason = (c: (typeof candidates)[number]) => {
    const cap = atCap(c) ? capOf(c.id)! : undefined;
    return c.weight === 0 ? "priority weight 0"
      : excludedWorkers.has(c.id) ? "excluded for this dispatch"
      : c.availability.status !== "available" ? describeUnavailable(c.availability)
      : excluded.has(c.engine) || excludedChannels.has(c.channel) ? EXCLUDED_ENGINE_REASON
      : cap !== undefined ? workerCapacityText(c.running, cap)
      : "available";
  };
  const available = candidates.filter(c => c.weight > 0 && c.availability.status === "available");
  const usable = available.filter(c => !excludedWorkers.has(c.id));
  // (a+1)/wa < (b+1)/wb, compared without division.
  const eligible = usable.filter(c => !excluded.has(c.engine) && !excludedChannels.has(c.channel) && !atCap(c))
    .sort((a, b) => (a.running + 1) * b.weight - (b.running + 1) * a.weight || b.weight - a.weight || a.index - b.index);
  const hit = eligible[0];
  if (!hit) {
    if (usable.length) {
      const deferred = usable.filter(c => !excluded.has(c.engine) && !excludedChannels.has(c.channel));
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
