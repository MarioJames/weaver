import type { Config } from './policy';

/** Fixed allowlist. Discovery never accepts a caller-supplied command. */
export const ENGINE_CATALOG = [
  { id: 'claude', kind: 'claude', command: 'claude' },
  { id: 'codex', kind: 'codex', command: 'codex' },
  { id: 'grok', kind: 'grok', command: 'grok' },
  { id: 'opencode', kind: 'opencode', command: 'opencode' },
  { id: 'pi', kind: 'pi', command: 'pi' },
  { id: 'qoder', kind: 'qodercli', command: 'qodercli' },
  { id: 'gemini', kind: 'gemini', command: 'gemini' },
] as const;

export type CatalogEngine = (typeof ENGINE_CATALOG)[number];
export type ProbeStatus = 'missing' | 'probe_failed' | 'installed';

export interface EngineProbeRecord {
  id: string;
  kind: string;
  command: string;
  status: ProbeStatus;
  path?: string;
  version?: string;
  probedAt: string;
  detail?: string;
  /** Version output is not an authentication or model-usability proof. */
  authenticated: false;
  modelUsable: false;
}

/** Per-engine adapter readiness. Install probes and EXECUTION_BOUNDARY stay separate; a probe is not a completed run. */
export interface EngineReadiness {
  id: string;
  kind: string;
  installed: boolean;
  enabled: boolean;
  ownerConfigured: boolean;
  workerConfigured: boolean;
  adapterStatus: 'real' | 'deferred' | 'not_implemented';
  /** True only when this real-adapter engine is enabled and an enabled worker uses it. */
  realExecution: boolean;
  probe: EngineProbeRecord;
}

const REAL_ADAPTER_KINDS = new Set(['opencode', 'pi', 'grok', 'codex']);

function adapterStatusFor(kind: string): EngineReadiness['adapterStatus'] {
  if (kind === 'claude') return 'deferred';
  if (REAL_ADAPTER_KINDS.has(kind)) return 'real';
  return 'not_implemented';
}

export const EXECUTION_BOUNDARY = {
  discovery: 'path-and-readonly-version',
  enablementAuthority: 'policy.engines.enabled',
  probeIsNotAuthority: true,
  roleAutoCreate: false,
  realAdapter: 'opencode|pi|grok|codex',
  deferredAdapter: 'claude',
  mockExecution: 'explicit-in-task-detail',
  authenticated: false,
  modelUsable: false,
} as const;
export type ExecutionBoundary = typeof EXECUTION_BOUNDARY;

export function catalogEntry(id: string): CatalogEngine | undefined {
  return ENGINE_CATALOG.find(entry => entry.id === id);
}

/** Enabled owners or workers block disable. Records stay; nothing is cascaded. */
export function engineDisableConflict(config: Config, id: string): string | undefined {
  const owners = Object.entries(config.owners).filter(([, owner]) => owner.enabled && owner.engine === id).map(([key]) => key);
  const workers = Object.entries(config.workers).filter(([, worker]) => worker.enabled && worker.engine === id).map(([key]) => key);
  if (!owners.length && !workers.length) return undefined;
  const parts = [
    owners.length ? `启用的负责人 ${owners.join('、')}` : '',
    workers.length ? `启用的工作代理 ${workers.join('、')}` : '',
  ].filter(Boolean);
  return `不能停用引擎 ${id}：仍有${parts.join('，')}。请先单独停用这些角色并保存。引擎记录和角色配置都保留，不会级联停用或删除。`;
}

export function engineReadiness(probe: EngineProbeRecord, config: Config): EngineReadiness {
  const stored = Object.hasOwn(config.engines, probe.id) ? config.engines[probe.id] : undefined;
  const kind = stored?.kind ?? probe.kind;
  const adapterStatus = adapterStatusFor(kind);
  return {
    id: probe.id,
    kind,
    installed: probe.status === 'installed',
    enabled: stored?.enabled === true,
    ownerConfigured: Object.values(config.owners).some(owner => owner.engine === probe.id),
    workerConfigured: Object.values(config.workers).some(worker => worker.engine === probe.id),
    adapterStatus,
    realExecution: adapterStatus === 'real' && stored?.enabled === true && Object.values(config.workers).some(worker => worker.enabled && worker.engine === probe.id),
    probe,
  };
}

export function readinessFor(probes: EngineProbeRecord[], config: Config): EngineReadiness[] {
  return probes.map(probe => engineReadiness(probe, config));
}

/** One worker route to greet: an engine id from the saved policy plus the model and effort to call. */
export interface HelloInput { engine: string; model: string; effort: string }
/** model is what the vendor reported answering, when it says; it can differ from the requested name. */
export interface HelloResult { ok: boolean; reply?: string; model?: string; error?: string; durationMs: number; checkedAt: string }
/** A greeting runs longer than one HTTP request may wait, so it is started and then polled. */
export interface HelloJob { id: string; status: 'running' | 'done'; startedAt: string; result?: HelloResult }
