import { roleEngine } from './policy/channels';
import type { Config } from './contracts/policy';

/** Fixed allowlist. Discovery never accepts a caller-supplied command. */
export const ENGINE_CATALOG = [
  { id: 'claude', kind: 'claude', command: 'claude' },
  { id: 'codex', kind: 'codex', command: 'codex' },
  { id: 'grok', kind: 'grok', command: 'grok' },
  { id: 'opencode', kind: 'opencode', command: 'opencode' },
  { id: 'pi', kind: 'pi', command: 'pi' },
  { id: 'qoder', kind: 'qodercli', command: 'qodercli' },
  { id: 'dsh', kind: 'dsh', command: 'dsh' },
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

const REAL_ADAPTER_KINDS = new Set(['claude', 'opencode', 'pi', 'grok', 'codex', 'qodercli', 'dsh']);

function adapterStatusFor(kind: string): EngineReadiness['adapterStatus'] {
  if (REAL_ADAPTER_KINDS.has(kind)) return 'real';
  return 'not_implemented';
}

export const EXECUTION_BOUNDARY = {
  discovery: 'path-and-readonly-version',
  enablementAuthority: 'policy.engines.enabled',
  probeIsNotAuthority: true,
  roleAutoCreate: false,
  /** The same list adapterStatusFor answers 'real' with, so the published fact cannot drift from it. */
  realAdapter: [...REAL_ADAPTER_KINDS].join('|'),
  deferredAdapter: '',
  mockExecution: 'explicit-in-task-detail',
  authenticated: false,
  modelUsable: false,
} as const;
export type ExecutionBoundary = typeof EXECUTION_BOUNDARY;

export function catalogEntry(id: string): CatalogEngine | undefined {
  return ENGINE_CATALOG.find(entry => entry.id === id);
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
    ownerConfigured: Object.values(config.owners).some(owner => roleEngine(config, owner) === probe.id),
    workerConfigured: Object.values(config.workers).some(worker => roleEngine(config, worker) === probe.id),
    adapterStatus,
    realExecution: adapterStatus === 'real' && stored?.enabled === true && Object.values(config.workers).some(worker => worker.enabled && roleEngine(config, worker) === probe.id),
    probe,
  };
}

export function readinessFor(probes: EngineProbeRecord[], config: Config): EngineReadiness[] {
  return probes.map(probe => engineReadiness(probe, config));
}

/** One worker route to greet: an engine id from the saved policy plus the model and effort to call. */
export interface HelloInput { channel: string; engine: string; model: string; effort: string }
/** model is what the vendor reported answering, when it says; it can differ from the requested name. */
export interface HelloResult { ok: boolean; reply?: string; model?: string; error?: string; durationMs: number; checkedAt: string }
/** A greeting runs longer than one HTTP request may wait, so it is started and then polled. */
export interface HelloJob { id: string; status: 'running' | 'done'; startedAt: string; result?: HelloResult }

/** A model name an engine accepts for `--model`. */
export interface EngineModel { id: string; label?: string; hint?: string }

/**
 * ok: the list came from the engine (or its documented built-in names).
 * unsupported: the CLI has no way to list models, so the user types one.
 * unavailable: the command is not installed.
 * failed: the list command ran but did not produce a list.
 */
export type EngineModelStatus = 'ok' | 'unsupported' | 'unavailable' | 'failed';
export interface EngineModelList {
  engine: string;
  status: EngineModelStatus;
  /** Where the names come from, in words a person can check, for example the exact command. */
  source: string;
  models: EngineModel[];
  message?: string;
  fetchedAt: string;
}
export interface EngineModelListInput { channel?: string; engine: string; refresh?: boolean }
