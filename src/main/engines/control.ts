import type { PolicySnapshot } from '../../shared/policy';
import { catalogEntry, type EngineProbeRecord } from '../../shared/engines';
import { object } from '../../shared/validation';
import type { PolicyStore } from '../policy/store';
import type { EngineProber } from './probe';

export function parseEngineToggle(value: unknown): { id: string; enabled: boolean; revision: number } {
  const raw = object(value);
  if (Object.keys(raw).some(key => !['id', 'enabled', 'revision'].includes(key))) throw new EngineControlError('Unknown engine toggle field');
  if (typeof raw.id !== 'string' || typeof raw.enabled !== 'boolean' || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) throw new EngineControlError('Invalid engine toggle');
  return { id: raw.id, enabled: raw.enabled, revision: Number(raw.revision) };
}

export class EngineControlError extends Error {
  constructor(message: string) { super(message); this.name = 'EngineControlError'; }
}

/** PolicyStore is the only enablement authority. Probing never writes, and enabling never creates roles. */
export async function applyEngineEnabled(store: PolicyStore, prober: EngineProber, input: { id: string; enabled: boolean; revision: number }): Promise<{ snapshot: PolicySnapshot; probe: EngineProbeRecord | null }> {
  const entry = catalogEntry(input.id);
  if (!entry) throw new EngineControlError('Engine is outside the supported catalog');
  const current = store.snapshot();
  if (input.revision !== current.revision) throw new EngineControlError('Settings changed; reload before saving');
  const config = structuredClone(current.config);
  const owners = structuredClone(config.owners);
  const workers = structuredClone(config.workers);
  let probe: EngineProbeRecord | null = null;
  if (input.enabled) {
    const existing = config.engines[entry.id];
    if (existing && existing.kind !== entry.kind) {
      throw new EngineControlError(`Saved engine ${entry.id} kind ${existing.kind} does not match catalog kind ${entry.kind}; it was not probed or converted`);
    }
    probe = await prober.probeOne(entry.id);
    if (store.snapshot().revision !== input.revision) throw new EngineControlError('Settings changed; reload before saving');
    if (probe.status !== 'installed') throw new EngineControlError(probe.detail ?? 'Engine is not installed; it was not enabled');
    config.engines[entry.id] = existing
      ? { ...existing, enabled: true }
      : { enabled: true, kind: entry.kind };
  } else {
    const existing = config.engines[entry.id];
    if (!existing) throw new EngineControlError('Engine has no saved record to disable');
    config.engines[entry.id] = { ...existing, enabled: false };
  }
  if (JSON.stringify(config.owners) !== JSON.stringify(owners) || JSON.stringify(config.workers) !== JSON.stringify(workers)) {
    throw new EngineControlError('Engine enablement must not change owner or worker records');
  }
  const snapshot = store.save({ revision: input.revision, config, blocks: current.blocks }, { allowEngineEnable: true });
  return { snapshot, probe };
}
