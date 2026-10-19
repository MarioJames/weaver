import { DEFAULT_WEIGHT, WEIGHT_MAX, type Config, type Owner, type Worker } from '../main/policy/routing';

export { DEFAULT_WEIGHT, WEIGHT_MAX };

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
  if (!weights || !Object.hasOwn(weights, workerId)) return DEFAULT_WEIGHT;
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

/** The default (5) and a cleared value omit the key. Other integers are stored, including values the schema still has to reject. */
export function withWorkerWeight(owner: Owner, workerId: string, weight: number): Owner {
  const weights = { ...(owner.worker_weights ?? {}) };
  if (!Number.isInteger(weight) || weight === DEFAULT_WEIGHT) delete weights[workerId];
  else weights[workerId] = weight;
  return withWeights(owner, Object.keys(weights).length ? weights : undefined);
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


export function blankOwner(config: Config): Owner {
  return { enabled: false, engine: Object.keys(config.engines)[0] ?? '', model: '', effort: 'high', workers: Object.keys(config.workers).slice(0, 1), max_parallel: 1 };
}

export function blankWorker(config: Config): Worker {
  return { enabled: false, engine: Object.keys(config.engines)[0] ?? '', model: '', effort: 'high', description: '' };
}


/** Point the ID editor at the record actually on screen. This does not rename. */
export function syncRoleEditor(ids: readonly string[], selected: string): { selected: string; pendingId: string } {
  const current = selected && ids.includes(selected) ? selected : ids[0] ?? '';
  return { selected: current, pendingId: current };
}


export function roleDeleteImpact(config: Config, section: RoleSection, id: string): { title: string; detail: string } {
  if (section === 'workers') {
    const owners = Object.entries(config.owners).filter(([, owner]) => owner.workers.includes(id)).map(([ownerId]) => ownerId);
    return {
      title: `删除子 Agent ${id}`,
      detail: owners.length ? `保存后会从这些父 Agent的子 Agent列表中移除：${owners.join('、')}。取消不改草稿。` : '没有父 Agent引用这条子 Agent。取消不改草稿。',
    };
  }
  return { title: `删除父 Agent ${id}`, detail: '只从草稿移除这条父 Agent，子 Agent配置保留。取消不改草稿。' };
}
