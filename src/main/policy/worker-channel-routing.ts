import type { Block, Config } from '../../shared/contracts/policy';
import { randomInt } from 'node:crypto';
import { QUOTA_FRESH_MS, type EngineQuotaRecord } from '../../shared/contracts/quota';
import { quotaWindowExhausted } from '../../shared/quota-windows';
import { availabilityOf, isBlockActive } from '../../shared/policy/availability';
import { parseProviderTimestamp } from '../quota/timestamps';
export interface ChannelRoutingContext {
  now: number;
  quotas: readonly EngineQuotaRecord[];
  credentialsReady?: (channel: string) => boolean;
  pickIndex?: (length: number) => number;
}
export interface WorkerChannelCandidate {
  channel: string;
  eligible: boolean;
  reason: string;
  observedAt?: string;
}
const REASON_TEXT: Readonly<Record<string, string>> = {
  CHANNEL_MISSING: '账号不存在', CHANNEL_EXCLUDED: '账号已排除', WORKER_DISABLED: 'Worker 已停用',
  CHANNEL_DISABLED: '账号已停用', ENGINE_DISABLED: '引擎已停用', BLOCKED: '账号受策略限制',
  ENGINE_MISMATCH: '账号池的引擎不一致', UNSUPPORTED_POOL: '账号池不支持此渠道或模型',
  CONTEXT_MISSING: '尚未取得额度观测', CREDENTIALS_NOT_READY: '账号认证未就绪',
  QUOTA_ENGINE_MISMATCH: '未取得对应引擎的额度', QUOTA_MISSING: '尚未取得账号额度',
  QUOTA_SOURCE_MISMATCH: '尚未取得可信额度', QUOTA_NOT_AVAILABLE: '额度尚未确认可用',
  QUOTA_UNAUTHENTICATED: '账号认证未就绪', QUOTA_ACCOUNT_RESTRICTED: '账号受额度限制',
  QUOTA_STALE: '额度已过期，请刷新', QUOTA_TIME_INVALID: '额度时间无效，请刷新',
  QUOTA_TIME_FUTURE: '额度时间异常，请刷新', QUOTA_WINDOWS_EXPIRED: '额度窗口已过期，请刷新',
  QUOTA_WINDOW_EXHAUSTED: '额度窗口已耗尽', QUOTA_5H_EXHAUSTED: '5小时窗口已耗尽',
  QUOTA_WEEK_EXHAUSTED: '周窗口已耗尽', QUOTA_MONTH_EXHAUSTED: '月窗口已耗尽',
};

/** Translate only our own reason codes; never expose vendor detail or labels. */
export function channelRoutingReason(reason: string): string {
  return REASON_TEXT[reason] ?? '暂无可用账号';
}

export class ChannelSelectionError extends Error {
  readonly code = 'NO_ELIGIBLE_CHANNEL';
  constructor(public readonly candidates: WorkerChannelCandidate[], reason?: string) {
    const detail = [...new Set(candidates.filter(candidate => !candidate.eligible).map(candidate => channelRoutingReason(candidate.reason)))].join('；');
    super(reason === 'FROZEN_CHANNEL_NOT_MEMBER' ? '固定账号不在当前账号池中' : `${reason === 'FROZEN_CHANNEL_UNAVAILABLE' ? '固定账号不可用' : '暂无可用账号'}${detail ? `：${detail}` : ''}`);
    this.name = 'ChannelSelectionError';
  }
}
// Keep only source identifiers here so this pure selector does not load native credential adapters.
const TRUSTED_SOURCES: Readonly<Record<string, readonly string[] | undefined>> = {
  codex: ['codex_usage'], claude: ['claude_oauth_usage'], grok: ['grok_cli_billing'],
  opencode: ['opencode_go_usage', 'opencode_console_status'],
};

export function workerChannelCandidates(config: Config, blocks: Block[], workerId: string, context?: ChannelRoutingContext, excludeChannels: readonly string[] = []): WorkerChannelCandidate[] {
  return channelCandidates(config, blocks, workerId, context, excludeChannels);
}

function channelCandidates(config: Config, blocks: Block[], workerId: string, context: ChannelRoutingContext | undefined, excludeChannels: readonly string[], frozenChannel?: string): WorkerChannelCandidate[] {
  const worker = Object.hasOwn(config.workers, workerId) ? config.workers[workerId] : undefined;
  if (!worker) return [];
  const channels = [...new Set(worker.channels)];
  const multiple = channels.length > 1;
  const now = context?.now ?? Date.now();
  const liveBlocks = blocks.filter(block => isBlockActive(block, now));
  const engines = new Set(channels.map(id => config.channels[id]?.engine));
  return channels.filter(channel => frozenChannel === undefined || channel === frozenChannel).map(channel => {
    const reject = (reason: string): WorkerChannelCandidate => ({ channel, eligible: false, reason });
    const binding = Object.hasOwn(config.channels, channel) ? config.channels[channel] : undefined;
    if (!binding) return reject('CHANNEL_MISSING');
    if (excludeChannels.includes(channel)) return reject('CHANNEL_EXCLUDED');
    // Pass a concrete route, never the pool: quota and block decisions belong to this account.
    const availability = availabilityOf(config, liveBlocks, {
      channel, model: worker.model, enabled: worker.enabled, free_channel: worker.free_channel,
    }, workerId);
    if (availability.status !== 'available') {
      const reasons = { disabled: 'WORKER_DISABLED', channel_disabled: 'CHANNEL_DISABLED', engine_disabled: 'ENGINE_DISABLED', blocked: 'BLOCKED' } as const;
      return reject(reasons[availability.status]);
    }
    const eligible = (): WorkerChannelCandidate => ({ channel, eligible: true, reason: 'ELIGIBLE' });
    if (multiple && engines.size !== 1) return reject('ENGINE_MISMATCH');
    const engine = Object.hasOwn(config.engines, binding.engine) ? config.engines[binding.engine] : undefined;
    if (!engine?.enabled) return reject('ENGINE_DISABLED');
    const sources = TRUSTED_SOURCES[engine.kind];
    const supportsQuota = binding.kind === 'subscription' && sources
      && (engine.kind !== 'opencode' || worker.model.startsWith('opencode-go/'));
    if (!supportsQuota || (multiple && worker.free_channel === true)) return multiple ? reject('UNSUPPORTED_POOL') : eligible();
    // A single account needs no positive quota proof, but trustworthy live limits still apply.
    const unproven = (reason: string) => multiple ? reject(reason) : eligible();
    if (!context || !Number.isFinite(context.now)) return unproven('CONTEXT_MISSING');
    if (multiple && context.credentialsReady?.(channel) !== true) return reject('CREDENTIALS_NOT_READY');
    const record = context.quotas.find(quota => quota.channel === channel && quota.engine === engine.kind);
    if (!record) return unproven(context.quotas.some(quota => quota.channel === channel) ? 'QUOTA_ENGINE_MISMATCH' : 'QUOTA_MISSING');
    if (!sources.includes(record.source)) return unproven('QUOTA_SOURCE_MISMATCH');
    if (record.stale) return unproven('QUOTA_STALE');
    const checked = parseProviderTimestamp(record.checkedAt);
    const observed = parseProviderTimestamp(record.observedAt);
    if (checked === null || observed === null) return unproven('QUOTA_TIME_INVALID');
    if (checked > now || observed > now) return unproven('QUOTA_TIME_FUTURE');
    if (now - observed >= QUOTA_FRESH_MS) return unproven('QUOTA_STALE');
    if (record.statusBasis === 'account_restriction' && record.status === 'exhausted') return reject('QUOTA_ACCOUNT_RESTRICTED');
    const applicable = record.windows.filter(window => window.scope === 'account'
      || window.scope === 'model' && window.model === worker.model);
    const expired = (window: EngineQuotaRecord['windows'][number]) => {
      const reset = parseProviderTimestamp(window.resetsAt);
      return reset !== null && reset <= now;
    };
    const exhausted = applicable.find(window => !expired(window) && quotaWindowExhausted(window));
    if (exhausted) {
      const reason = exhausted.durationMinutes === 300 ? 'QUOTA_5H_EXHAUSTED'
        : exhausted.durationMinutes === 10080 ? 'QUOTA_WEEK_EXHAUSTED'
        : exhausted.durationMinutes === 43200 ? 'QUOTA_MONTH_EXHAUSTED' : 'QUOTA_WINDOW_EXHAUSTED';
      return reject(reason);
    }
    if (multiple && applicable.some(expired)) return reject('QUOTA_WINDOWS_EXPIRED');
    if (multiple && record.status !== 'available') return reject(record.status === 'unauthenticated' ? 'QUOTA_UNAUTHENTICATED' : 'QUOTA_NOT_AVAILABLE');
    return { channel, eligible: true, reason: 'ELIGIBLE', observedAt: record.observedAt! };
  });
}
export function selectWorkerChannel(config: Config, blocks: Block[], workerId: string, context?: ChannelRoutingContext, options?: {excludeChannels?: readonly string[]; frozenChannel?: string}): string {
  const candidates = channelCandidates(config, blocks, workerId, context, options?.excludeChannels ?? [], options?.frozenChannel);
  if (options?.frozenChannel !== undefined) {
    const frozen = candidates.find(candidate => candidate.channel === options.frozenChannel);
    if (!frozen) throw new ChannelSelectionError(candidates, 'FROZEN_CHANNEL_NOT_MEMBER');
    if (!frozen.eligible) throw new ChannelSelectionError(candidates, 'FROZEN_CHANNEL_UNAVAILABLE');
    return frozen.channel;
  }
  const eligible = candidates.filter(candidate => candidate.eligible);
  if (!eligible.length) throw new ChannelSelectionError(candidates);
  if (eligible.length === 1) return eligible[0]!.channel;
  const index = (context?.pickIndex ?? randomInt)(eligible.length);
  if (!Number.isInteger(index) || index < 0 || index >= eligible.length) throw new RangeError('INVALID_PICK_INDEX');
  return eligible[index]!.channel;
}
