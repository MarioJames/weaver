import { CLASS_TAGS, type Block, type Config, type Owner, type Worker } from '../main/policy/routing';

export type RoleSection = 'owners' | 'workers';

const ID = /^[a-z][a-z0-9_]{0,39}$/;
const WORKER_ID = /^[a-z][a-z0-9_]{0,32}_worker$/;

export function roleIdError(section: RoleSection, id: string, config: Config, currentId?: string): string {
  if (section === 'workers' ? !WORKER_ID.test(id) : !ID.test(id)) {
    return section === 'workers' ? '示例：research_worker。以小写字母开头，并以 _worker 结尾。' : '示例：codex_owner。以小写字母开头，只含小写字母、数字和下划线。';
  }
  if (id !== currentId && Object.hasOwn(config[section], id)) return '这个 ID 已经存在';
  return '';
}

function renameKey<T>(record: Record<string, T>, from: string, to: string): Record<string, T> {
  if (from === to || !Object.hasOwn(record, from)) return record;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) next[key === from ? to : key] = structuredClone(value);
  return next;
}

export function workerWeight(owner: Owner, workerId: string): number {
  const weights = owner.worker_weights;
  if (!weights || !Object.hasOwn(weights, workerId)) return 100;
  return weights[workerId]!;
}

function withWeights(owner: Owner, weights: Record<string, number> | undefined): Owner {
  const next: Owner = { ...owner };
  if (weights && Object.keys(weights).length) next.worker_weights = weights;
  else delete next.worker_weights;
  return next;
}

function remapWeights(weights: Record<string, number> | undefined, map: (key: string) => string | undefined): Record<string, number> | undefined {
  if (!weights) return undefined;
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(weights)) {
    const mapped = map(key);
    if (mapped) next[mapped] = value;
  }
  return Object.keys(next).length ? next : undefined;
}

/** 100 and a cleared value omit the key. Other integers are stored, including values the schema still has to reject. */
export function withWorkerWeight(owner: Owner, workerId: string, weight: number): Owner {
  const weights = { ...(owner.worker_weights ?? {}) };
  if (!Number.isInteger(weight) || weight === 100) delete weights[workerId];
  else weights[workerId] = weight;
  return withWeights(owner, Object.keys(weights).length ? weights : undefined);
}

export function withOnlyEngine(owner: Owner, engine: string | undefined): Owner {
  const next: Owner = { ...owner };
  if (engine) next.only_engine = engine;
  else delete next.only_engine;
  return next;
}

export function withoutListedWorker(owner: Owner, workerId: string): Owner {
  return withWeights(
    { ...owner, workers: owner.workers.filter(id => id !== workerId) },
    remapWeights(owner.worker_weights, key => key === workerId ? undefined : key),
  );
}

export function renameRole(config: Config, section: RoleSection, from: string, to: string): Config {
  if (from === to) return config;
  if (section === 'workers') {
    return {
      ...config,
      workers: renameKey(config.workers, from, to),
      owners: Object.fromEntries(Object.entries(config.owners).map(([id, owner]) => [id, withWeights(
        { ...owner, workers: owner.workers.map(worker => worker === from ? to : worker) },
        remapWeights(owner.worker_weights, key => key === from ? to : key),
      )])),
    };
  }
  return { ...config, owners: renameKey(config.owners, from, to) };
}

export function renameEngine(config: Config, from: string, to: string): Config {
  if (from === to || !Object.hasOwn(config.engines, from)) return config;
  return {
    ...config,
    engines: renameKey(config.engines, from, to),
    owners: Object.fromEntries(Object.entries(config.owners).map(([id, owner]) => {
      const next: Owner = { ...owner, engine: owner.engine === from ? to : owner.engine };
      return [id, owner.only_engine === from ? withOnlyEngine(next, to) : next];
    })),
    workers: Object.fromEntries(Object.entries(config.workers).map(([id, worker]) => [id, { ...worker, engine: worker.engine === from ? to : worker.engine }])),
  };
}

export function removeEngine(config: Config, id: string): Config {
  if (!Object.hasOwn(config.engines, id)) return config;
  const engines = { ...config.engines };
  delete engines[id];
  return {
    ...config,
    engines,
    owners: Object.fromEntries(Object.entries(config.owners).map(([ownerId, owner]) => [ownerId, owner.only_engine === id ? withOnlyEngine(owner, undefined) : owner])),
  };
}

export function removeRole(config: Config, section: RoleSection, id: string): Config {
  if (section === 'workers') {
    const workers = { ...config.workers };
    delete workers[id];
    return {
      ...config,
      workers,
      owners: Object.fromEntries(Object.entries(config.owners).map(([ownerId, owner]) => [ownerId, withoutListedWorker(owner, id)])),
    };
  }
  const owners = { ...config.owners };
  delete owners[id];
  return { ...config, owners };
}

/** Ignore a stale add after the owner or the candidate list changes. */
export function appendWorker(workers: readonly string[], available: readonly string[], add: string | undefined): string[] | undefined {
  if (!add || !available.includes(add) || workers.includes(add)) return undefined;
  return [...workers, add];
}

export function moveWorker(workers: string[], index: number, direction: -1 | 1): string[] {
  const next = workers.slice();
  const target = index + direction;
  if (target < 0 || target >= next.length) return workers;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function blankOwner(config: Config): Owner {
  return { enabled: false, engine: Object.keys(config.engines)[0] ?? '', model: '', effort: 'high', workers: Object.keys(config.workers).slice(0, 1), max_parallel: 1 };
}

export function blankWorker(config: Config): Worker {
  return { enabled: false, engine: Object.keys(config.engines)[0] ?? '', model: '', effort: 'high', tags: [], description: '' };
}

export function blankBlock(engine: string, now = new Date()): Block {
  return { engine, reason: '', since: now.toISOString() };
}

/** Point the ID editor at the record actually on screen. This does not rename. */
export function syncRoleEditor(ids: readonly string[], selected: string): { selected: string; pendingId: string } {
  const current = selected && ids.includes(selected) ? selected : ids[0] ?? '';
  return { selected: current, pendingId: current };
}

export function tagChoices(existing: readonly string[] | undefined): string[] {
  return [...new Set([...(existing ?? []), ...CLASS_TAGS])];
}

export function roleDeleteImpact(config: Config, section: RoleSection, id: string): { title: string; detail: string } {
  if (section === 'workers') {
    const owners = Object.entries(config.owners).filter(([, owner]) => owner.workers.includes(id)).map(([ownerId]) => ownerId);
    return {
      title: `删除工作代理 ${id}`,
      detail: owners.length ? `保存后会从这些负责人的优先顺序和优先权重中移除引用：${owners.join('、')}。取消不改草稿。` : '没有负责人引用这条工作代理。取消不改草稿。',
    };
  }
  return { title: `删除负责人 ${id}`, detail: '只从草稿移除这条负责人，工作代理配置保留。取消不改草稿。' };
}

export function screenPolicyDraft(configValue: unknown, blocksValue: unknown): { ok: true; config: Config; blocks: Block[] } | { ok: false; error: string } {
  if (!configValue || typeof configValue !== 'object' || Array.isArray(configValue)) return { ok: false, error: '策略必须是对象。' };
  if (!Array.isArray(blocksValue)) return { ok: false, error: '配额必须是数组。' };
  const blocks: Block[] = [];
  for (const [index, raw] of blocksValue.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `第 ${index + 1} 条配额不是对象。` };
    const row = raw as Record<string, unknown>;
    if (typeof row.engine !== 'string' || typeof row.reason !== 'string' || typeof row.since !== 'string') return { ok: false, error: `第 ${index + 1} 条配额缺少引擎、原因或开始时间。` };
    for (const key of ['model', 'release_at', 'by'] as const) {
      if (row[key] !== undefined && typeof row[key] !== 'string') return { ok: false, error: `第 ${index + 1} 条配额的 ${key} 必须是文本。` };
    }
    const block: Block = { engine: row.engine, reason: row.reason, since: row.since };
    if (typeof row.model === 'string') block.model = row.model;
    if (typeof row.release_at === 'string') block.release_at = row.release_at;
    if (typeof row.by === 'string') block.by = row.by;
    blocks.push(block);
  }
  return { ok: true, config: configValue as Config, blocks };
}

export async function acceptPolicyJson(configValue: unknown, blocksValue: unknown, validate: (config: unknown) => Promise<{ path: string; message: string }[]>): Promise<{ ok: true; config: Config; blocks: Block[] } | { ok: false; error: string }> {
  const screened = screenPolicyDraft(configValue, blocksValue);
  if (!screened.ok) return screened;
  const issues = await validate(screened.config);
  if (issues.length) return { ok: false, error: issues.map(issue => `${issue.path}: ${issue.message}`).join('\n') };
  return screened;
}
