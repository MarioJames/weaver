import type { EngineQuotaRecord, QuotaEngine, QuotaRefreshInput, QuotaRefreshResult, QuotaSnapshot } from '../../shared/contracts/quota';
import { quotaRefreshEnabled } from '../../shared/policy/settings';
import { type Block, type Config } from '../../shared/contracts/policy';
import { PolicyBlockService } from './blocks';
import type { PolicyStore } from './store';
import { quotaBlockBy } from '../../shared/policy/blocks';
import { object } from '../../shared/validation';
import { rpcForCommand } from '../../shared/contracts/rpc';

const ENGINES: QuotaEngine[] = ['codex', 'claude', 'grok', 'opencode'];
const LABELS: Record<QuotaEngine, string> = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok', opencode: 'OpenCode Go' };
export const QUOTA_CAPABILITIES = {
  engines: ENGINES,
  get: { command: 'quota.get', rpc: rpcForCommand('quota.get').method, network: false },
  refresh: { command: 'quota.refresh', rpc: rpcForCommand('quota.refresh').method, updatesPolicyBlocks: false, inference: false },
};

/** Distinct quota kinds of enabled engines that opted into scheduled refresh. */
export function quotaRefreshTargets(config: Config): QuotaEngine[] {
  const kinds = new Set(Object.values(config.channels).filter(channel => channel.enabled && config.engines[channel.engine]?.enabled && quotaRefreshEnabled(channel,config.engines[channel.engine]?.kind)).map(channel => config.engines[channel.engine]!.kind));
  return ENGINES.filter(engine => kinds.has(engine));
}

export function parseQuotaRefresh(value: unknown): QuotaRefreshInput {
  const raw = object(value);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).some(key => key !== 'engine' && key !== 'channel')) throw new Error('Unknown quota refresh field');
  if (raw.engine !== undefined && (typeof raw.engine !== 'string' || !ENGINES.includes(raw.engine as QuotaEngine))) throw new Error('Invalid quota engine; use codex, claude, grok, or opencode');
  if (raw.channel !== undefined && (typeof raw.channel !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(raw.channel))) throw new Error('Invalid quota channel');
  return { ...(raw.engine !== undefined ? { engine: raw.engine as QuotaEngine } : {}), ...(raw.channel !== undefined ? {channel:raw.channel as string} : {}) };
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
  const update = new PolicyBlockService(() => store).update(current => {
    let blocks = current.blocks;
    for (const record of quota.records) {
      // OpenCode Go windows share the opencode kind with free and third-party routes, so a
      // 100% Go plan window must not pause the whole engine. The record stays display-only;
      // actual limits keep flowing through the existing vendor/model failure path.
      if (record.engine === 'opencode') continue;
      if ((input.engine !== undefined && record.engine !== input.engine) || record.stale || !record.checkedAt || !record.observedAt) continue;
      if (record.status !== 'available' && record.status !== 'exhausted') continue;
      const source = quotaBlockBy(record.engine);
      for (const [channelId, channel] of Object.entries(current.config.channels)) {
        if(channel.kind !== 'subscription' || (input.channel !== undefined && channelId !== input.channel)) continue;
        if(record.channel === undefined || record.channel !== channelId) continue;
        const id=channel.engine; const engine=current.config.engines[id]!;
        // An engine whose quota is not tracked would never get a fresh observation to release the block.
        if (engine.kind !== record.engine || !quotaRefreshEnabled(channel,engine.kind)) continue;
        const existing = blocks.find(block => block.engine === id && (block.channel === channelId || block.channel === undefined) && block.model === undefined && block.worker === undefined);
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
          engine: id, channel: channelId, by: source, reason: `${LABELS[record.engine]} account quota exhausted`,
          since: existing?.since ?? new Date(now).toISOString(),
          ...(release_at ? { release_at } : {}),
        };
        if (existing) blocks = blocks.map(item => item === existing ? block : item);
        else blocks = [...blocks, block];
      }
    }
    const fields: (keyof Block)[] = ['engine', 'channel', 'model', 'worker', 'reason', 'since', 'release_at', 'by'];
    const policyChanged = blocks.length !== current.blocks.length || blocks.some((block, index) => fields.some(field => block[field] !== current.blocks[index]?.[field]));
    return policyChanged ? blocks : undefined;
  });
  return { ...quota, snapshot: update.snapshot, policyChanged: update.saved };
}
