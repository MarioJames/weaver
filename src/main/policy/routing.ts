// Derived from skill-foundry agents-cooperation, revision 61989b1 (Apache-2.0).
// Weaver adaptation: pure policy only; no CLI, sessions, launch flags, or host reads.
import { type Issue, type Schema, lintSchema, validate } from "./json-schema";
import CONFIG_SCHEMA from "./config.schema.json";
import DEFAULT_CONFIG from "./config.default.json";
lintSchema(CONFIG_SCHEMA);
export const defaultConfig = (): Config => structuredClone(DEFAULT_CONFIG) as Config;
/** The single kind -> legal effort table; kinds not listed accept any non-empty string. */
export const EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max"],
  grok: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  qodercli: ["auto", "none", "low", "medium", "high", "xhigh", "max", "ultracode"],
};
const SUPPORTED_POLICY_KINDS = ["claude", "codex", "opencode", "qodercli", "grok", "pi"];
export const ENGINE_KINDS: string[] = CONFIG_SCHEMA.$defs?.engine?.properties?.kind?.enum ?? [];

/** Reserved class tags: a worker carrying one is a free worker picked by resolve --class; every other tag is a domain tag. */
export const CLASS_TAGS = ["mechanical", "routine"];
export const CLASSES = [...CLASS_TAGS, "judgment"];
const isFree = (worker: Worker) => CLASS_TAGS.some(t => worker.tags?.includes(t));

export class PolicyError extends Error {
  constructor(message: string, public issues: Issue[] = []) { super(message); }
}
export interface Engine { enabled: boolean; kind: string; native_subagents?: boolean }
export interface Owner { enabled: boolean; engine: string; model: string; effort: string; workers: string[]; max_parallel: number; worker_weights?: Record<string, number>; only_engine?: string }
/** Omitted weights are 100. This is priority within one tier, not a probability. */
export function effectiveWeight(owner: Owner, workerId: string): number {
  const weights = owner.worker_weights;
  if (!weights || !Object.hasOwn(weights, workerId)) return 100;
  return weights[workerId]!;
}
export interface Worker { enabled: boolean; engine: string; model: string; effort: string; description?: string; tags?: string[] }
export interface Herdr { max_wait_minutes: number }
export interface Config { version: 1; chatgpt_review?: boolean; engines: Record<string, Engine>; owners: Record<string, Owner>; workers: Record<string, Worker>; herdr: Herdr }
/** Effective automatic ChatGPT review switch. Only boolean false disables it; a missing field stays enabled. Non-booleans are schema errors and are not coerced. */
export function chatgptReviewEnabled(config: { chatgpt_review?: unknown }): boolean {
  return config.chatgpt_review !== false;
}
export interface Block { engine: string; model?: string; reason: string; since: string; release_at?: string; by?: string }
export interface State { version: 1; blocks: Block[] }
export interface Availability { status: "available" | "disabled" | "engine_disabled" | "blocked"; engine?: string; model?: string; reason?: string; release_at?: string }

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
        if (!Number.isInteger(weight) || weight < 0 || weight > 1000) bad(atWeight, "weight must be an integer from 0 to 1000");
      }
    }
    if (owner.only_engine !== undefined && !Object.hasOwn(c.engines, owner.only_engine)) bad(`${at}.only_engine`, `unknown engine ${owner.only_engine}`);
    if (!owner.enabled) continue;
    if (engine && !engine.enabled) bad(`${at}.engine`, `engine ${owner.engine} is disabled`);
    const other = owned.get(owner.engine);
    if (other) bad(at, `engine ${owner.engine} already has enabled owner ${other}`);
    else owned.set(owner.engine, id);
    const hasWorker = owner.workers.some(workerId => { const worker = c.workers[workerId]; return worker?.enabled && c.engines[worker.engine]?.enabled; });
    if (!hasWorker) bad(`${at}.workers`, "enabled owner needs at least one enabled worker on an enabled engine");
  }
  // Kinds that can host native sub-agents come from the schema (engine.then), not from a second table here.
  const nativeKinds: string[] = schema.$defs?.engine?.then?.properties?.kind?.enum ?? [];
  for (const [id, worker] of Object.entries(c.workers)) {
    const at = `$.workers.${id}`;
    const kind = Object.hasOwn(c.engines, worker.engine) ? c.engines[worker.engine]?.kind : undefined;
    if (!kind) { bad(`${at}.engine`, `unknown engine ${worker.engine}`); continue; }
    checkEffort(at, worker.engine, worker.effort);
    if (worker.enabled && !c.engines[worker.engine]?.enabled) bad(`${at}.engine`, `engine ${worker.engine} is disabled`);
    if (CLASS_TAGS.every(t => worker.tags?.includes(t))) bad(`${at}.tags`, `a worker cannot carry both ${CLASS_TAGS.join(" and ")}`);
    if (!SUPPORTED_POLICY_KINDS.includes(kind) && !nativeKinds.includes(kind)) bad(`${at}.engine`, `kind ${kind} has no migrated routing policy`);
  }
  return issues;
}

// ---- availability ----
const stamp = (value: string) => Date.parse(value);
export function activeBlocks(state: State, now: number): Block[] {
  return state.blocks.filter(b => !b.release_at || stamp(b.release_at) > now);
}
export function availabilityOf(config: Config, blocks: Block[], entity: Owner | Worker): Availability {
  if (!entity.enabled) return { status: "disabled" };
  if (!config.engines[entity.engine]?.enabled) return { status: "engine_disabled" };
  const hit = blocks.find(b => b.engine === entity.engine && (b.model === undefined || b.model === entity.model));
  if (hit) return { status: "blocked", engine: hit.engine, ...(hit.model ? { model: hit.model } : {}), reason: hit.reason, ...(hit.release_at ? { release_at: hit.release_at } : {}) };
  return { status: "available" };
}
const describeUnavailable = (a: Availability) =>
  a.status === "blocked" ? `blocked (${a.model ? `${a.engine}/${a.model}` : a.engine}: ${a.reason}${a.release_at ? `, release_at ${a.release_at}` : ""})` : a.status;
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
 owner: string; worker: string; engine: string; model: string; effort: string;
 execution: 'disabled'; dispatch: 'preview'; warnings: string[];
 selected_by?: string; class?: string; skipped?: {worker:string; reason:string}[];
 peer_suggestion?: {owner:string; reason:string};
 /** Effective priority of the selected worker. Omitted config means 100. */
 weight?: number;
 /** Owner pin in force for this selection. Absent when the owner is not pinned. */
 only_engine?: string;
}
function previewSelection(config: Config, ownerId: string, workerId: string, warnings: string[]): Dispatch {
 const owner = config.owners[ownerId]!;
 const worker = config.workers[workerId]!;
 return {owner:ownerId,worker:workerId,engine:worker.engine,model:worker.model,effort:worker.effort,
  execution:'disabled',dispatch:'preview',warnings,weight:effectiveWeight(owner,workerId),
  ...(owner.only_engine ? { only_engine: owner.only_engine } : {})};
}
function exclusionReason(owner: Owner, workerId: string, worker: Worker): string | undefined {
  if (effectiveWeight(owner, workerId) === 0) return "priority weight 0";
  if (owner.only_engine && worker.engine !== owner.only_engine) return `fixed engine ${owner.only_engine}`;
  return undefined;
}
function requireOwner(config: Config, blocks: Block[], id: string, what = "owner"): Owner {
  const owner = Object.hasOwn(config.owners,id) ? config.owners[id] : undefined;
  if (!owner) throw new PolicyError(`unknown ${what} ${id}`);
  const a = availabilityOf(config, blocks, owner);
  if (a.status !== "available") throw new PolicyError(`${what} ${id} unavailable: ${describeUnavailable(a)}`);
  return owner;
}
/** The tag is another available enabled owner's strength and the owner's own native workers lack it: suggest handing the package over via assign. */
function peerSuggestion(config: Config, blocks: Block[], owner: Owner, listed: Worker[], tag: string): { owner: string; reason: string } | undefined {
  if (listed.some(w => w.engine === owner.engine && w.tags?.includes(tag))) return undefined;
  for (const [id, other] of Object.entries(config.owners)) {
    if (other.engine === owner.engine || availabilityOf(config, blocks, other).status !== "available") continue;
    if (Object.values(config.workers).some(w => w.engine === other.engine && !isFree(w) && w.tags?.includes(tag))) {
      return { owner: id, reason: `${tag} 是 ${id} 侧 worker 的强项，可经 assign 交给该 owner` };
    }
  }
  return undefined;
}
export interface RouteOptions { owner: string; worker?: string; class?: string; tag?: string }
export function resolveDispatch(config: Config, blocks: Block[], opts: RouteOptions): Dispatch {
  const owner = requireOwner(config, blocks, opts.owner);
  if (opts.worker) {
    if (opts.class !== undefined || opts.tag !== undefined) throw new PolicyError("--worker cannot be combined with --class or --tag");
    const worker = Object.hasOwn(config.workers,opts.worker) ? config.workers[opts.worker] : undefined;
    if (!worker) throw new PolicyError(`unknown worker ${opts.worker}`);
    const a = availabilityOf(config, blocks, worker);
    if (a.status !== "available") throw new PolicyError(`worker ${opts.worker} unavailable: ${describeUnavailable(a)}`);
    const excluded = exclusionReason(owner, opts.worker, worker);
    if (excluded) throw new PolicyError(`worker ${opts.worker} unavailable: ${excluded}`);
    const warnings = owner.workers.includes(opts.worker) ? [] : [`worker ${opts.worker} 不在 owner ${opts.owner} 的 workers 列表中`];
    return { ...previewSelection(config, opts.owner, opts.worker, warnings), selected_by: "worker" };
  }
  const cls = opts.class;
  if (cls === undefined || !CLASSES.includes(cls)) throw new PolicyError(cls === undefined ? `--class is required (${CLASSES.join("|")}) unless --worker is given` : `--class must be one of ${CLASSES.join("|")}`);
  if (opts.tag !== undefined) {
    if (cls !== "judgment") throw new PolicyError("--tag is only valid with --class judgment");
    if (CLASS_TAGS.includes(opts.tag)) throw new PolicyError(`--tag ${opts.tag} is a class tag; use --class ${opts.tag}`);
  }
  const all = owner.workers.map(id => ({ id, worker: config.workers[id]!, availability: availabilityOf(config, blocks, config.workers[id]!) }));
  const paid = all.filter(c => !isFree(c.worker));
  const skipReason = (c: (typeof all)[number]) => c.availability.status !== "available" ? describeUnavailable(c.availability) : (exclusionReason(owner, c.id, c.worker) ?? describeUnavailable(c.availability));
  const eligible = (c: (typeof all)[number]) => c.availability.status === "available" && !exclusionReason(owner, c.id, c.worker);
  // Attempt order stays class, then tag, then native, then declared order.
  // Weight reorders only inside the list being added. A higher weight cannot cross into an earlier tier.
  const sequence: { c: (typeof all)[number]; by: "class" | "tag" | "native" | "order" }[] = [];
  const ordered = (list: typeof all) => list
    .map((c, index) => ({ c, index }))
    .sort((a, b) => effectiveWeight(owner, b.c.id) - effectiveWeight(owner, a.c.id) || owner.workers.indexOf(a.c.id) - owner.workers.indexOf(b.c.id) || a.index - b.index)
    .map(item => item.c);
  const add = (list: typeof all, by: "class" | "tag" | "native" | "order") => ordered(list).forEach(c => { if (!sequence.some(s => s.c === c)) sequence.push({ c, by }); });
  if (cls === "mechanical") add(all.filter(c => c.worker.tags?.includes("mechanical")), "class");
  if (cls !== "judgment") add(all.filter(c => c.worker.tags?.includes("routine")), "class");
  if (opts.tag !== undefined) {
    add(paid.filter(c => c.worker.engine !== owner.engine && c.worker.tags?.includes(opts.tag!)), "tag");
    add(paid.filter(c => c.worker.engine === owner.engine), "native");
  }
  add(paid, "order");
  const hit = sequence.find(s => eligible(s.c));
  if (!hit) {
    const considered = sequence.map(s => s.c);
    const detail = considered.map(c => `${c.id}: ${skipReason(c)}`).join("; ");
    throw new PolicyError(`no available worker for owner ${opts.owner} (class ${cls})${detail ? `: ${detail}` : ""}`, considered.map(c => ({ path: `$.owners.${opts.owner}.workers`, message: `${c.id}: ${skipReason(c)}` })));
  }
  const warnings: string[] = [];
  if (hit.by === "native" && sequence.some(s => s.by === "tag")) warnings.push(`带 ${opts.tag} 标签的异构候选不可用，已回落到本引擎原生 worker`);
  if (hit.by === "order") {
    if (cls !== "judgment") warnings.push("无可用免费 worker，已按 judgment 回退");
    else if (opts.tag !== undefined) warnings.push(`无可用的 ${opts.tag} 标签候选，已按顺序回退`);
  }
  const skipped = sequence.slice(0, sequence.indexOf(hit)).filter(s => !eligible(s.c)).map(s => ({ worker: s.c.id, reason: skipReason(s.c) }));
  const suggestion = hit.by === "native" && opts.tag !== undefined ? peerSuggestion(config, blocks, owner, paid.map(c => c.worker), opts.tag) : undefined;
  return { ...previewSelection(config, opts.owner, hit.c.id, warnings), class: cls, selected_by: hit.by, skipped, ...(suggestion ? { peer_suggestion: suggestion } : {}) };
}
