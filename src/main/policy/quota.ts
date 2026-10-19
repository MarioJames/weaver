import type { EngineQuotaRecord, QuotaEngine, QuotaRefreshInput, QuotaRefreshResult, QuotaSnapshot } from '../../shared/quota';
import { quotaRefreshEnabled, type Block, type Config } from './routing';
import type { PolicyStore } from './store';
import { object } from '../../shared/validation';

const ENGINES: QuotaEngine[] = ['codex', 'claude', 'grok'];
const LABELS: Record<QuotaEngine, string> = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok' };
export const QUOTA_CAPABILITIES = {
  engines: ENGINES,
  get: { command: 'quota.get', rpc: 'getQuota', network: false },
  refresh: { command: 'quota.refresh', rpc: 'refreshQuota', updatesPolicyBlocks: true, inference: false },
};

/** Distinct quota kinds of enabled engines that opted into scheduled refresh. */
export function quotaRefreshTargets(config: Config): QuotaEngine[] {
  const kinds = new Set(Object.values(config.engines).filter(engine => engine.enabled && quotaRefreshEnabled(engine)).map(engine => engine.kind));
  return ENGINES.filter(engine => kinds.has(engine));
}

export function parseQuotaRefresh(value: unknown): QuotaRefreshInput {
  const raw = object(value);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).some(key => key !== 'engine')) throw new Error('Unknown quota refresh field');
  if (!Object.hasOwn(raw, 'engine')) return {};
  if (typeof raw.engine !== 'string' || !ENGINES.includes(raw.engine as QuotaEngine)) throw new Error('Invalid quota engine; use codex, claude, or grok');
  return { engine: raw.engine as QuotaEngine };
}

export class QuotaPolicyConflict extends Error {
  readonly code = 'QUOTA_POLICY_CONFLICT';
  constructor() {
    super('An expired manual or external block prevents automatic quota blocking; update the existing policy block and refresh again');
    this.name = 'QuotaPolicyConflict';
  }
}

/** No deadline is safer than releasing a still-exhausted account on a partial reset. */
function releaseAt(record: EngineQuotaRecord, now: number): string | undefined {
  if (record.statusBasis === 'account_restriction') return undefined;
  const exhausted = record.windows.filter(window => window.scope === 'account' && (window.resetsAt === null || !Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) > now) && (
    (window.usedPercent !== null && window.usedPercent >= 100) ||
    (window.remaining === 0 && ((window.total !== null && window.total > 0) || (window.used !== null && window.used > 0)))
  ));
  if (!exhausted.length) return undefined;
  const resets = exhausted.map(window => window.resetsAt === null ? NaN : Date.parse(window.resetsAt));
  if (resets.some(reset => !Number.isFinite(reset) || reset <= now)) return undefined;
  return new Date(Math.max(...resets)).toISOString();
}

/** Synchronous read/merge/save after the asynchronous probe preserves intervening policy edits. */
export function applyQuotaSnapshot(store: PolicyStore, quota: QuotaSnapshot, input: QuotaRefreshInput, now = Date.now()): QuotaRefreshResult {
  const current = store.snapshot();
  let blocks = current.blocks;
  for (const record of quota.records) {
    if ((input.engine !== undefined && record.engine !== input.engine) || record.stale || !record.checkedAt || !record.observedAt) continue;
    if (record.status !== 'available' && record.status !== 'exhausted') continue;
    const source = `weaver-quota:${record.engine}`;
    for (const [id, engine] of Object.entries(current.config.engines)) {
      // An engine whose quota is not tracked would never get a fresh observation to release the block.
      if (engine.kind !== record.engine || !quotaRefreshEnabled(engine)) continue;
      const existing = blocks.find(block => block.engine === id && block.model === undefined);
      if (existing && existing.by !== source) {
        if (record.status === 'exhausted' && existing.release_at && Date.parse(existing.release_at) <= now) throw new QuotaPolicyConflict();
        continue;
      }
      if (record.status === 'available') {
        if (existing) blocks = blocks.filter(block => block !== existing);
        continue;
      }
      const release_at = releaseAt(record, now);
      const block: Block = {
        engine: id, by: source, reason: `${LABELS[record.engine]} account quota exhausted`,
        since: existing?.since ?? new Date(now).toISOString(),
        ...(release_at ? { release_at } : {}),
      };
      if (existing) blocks = blocks.map(item => item === existing ? block : item);
      else blocks = [...blocks, block];
    }
  }
  const fields: (keyof Block)[] = ['engine', 'model', 'reason', 'since', 'release_at', 'by'];
  const policyChanged = blocks.length !== current.blocks.length || blocks.some((block, index) => fields.some(field => block[field] !== current.blocks[index]?.[field]));
  const snapshot = policyChanged ? store.save({ revision: current.revision, config: current.config, blocks }) : current;
  return { ...quota, snapshot, policyChanged };
}
