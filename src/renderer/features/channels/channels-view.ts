import { ENGINE_CATALOG } from '../../../shared/engines';
import { CHANNEL_CONFIG_MAX_BYTES } from '../../../shared/contracts/channels';
import type { Channel, ChannelConfiguration, ChannelsSnapshot, ImportChannelsInput, ImportChannelsResult, SaveChannelInput } from '../../../shared/contracts/channels';
import type { EngineQuotaRecord } from '../../../shared/contracts/quota';
import type { Config } from '../../../shared/contracts/policy';
import { quotaCountText, quotaPercentText, quotaRecordStale, quotaTightestWindow, quotaWindowShortLabel } from '../quota/quota-view';

export const directApiAllowed = (kind: string): boolean => kind !== 'qoder' && kind !== 'qodercli';
export const subscriptionAllowed = (kind: string): boolean => ENGINE_CATALOG.some(entry => entry.kind === kind) && kind !== 'pi' && kind !== 'dsh';

export function channelUsers(config: Config, channel: string): string[] {
  const references = channelReferences(config, channel);
  return [
    ...references.owners.map(id => `父 Agent ${id}`),
    ...references.workers.map(id => `子 Agent ${id}`),
  ];
}

/** Empty key keeps the secret. Config clearing is explicit, never an effect of opening the editor. */
export function channelSaveInput(revision: number, id: string | undefined, channel: Channel, apiKey: string, config: string, replaceConfig: boolean): SaveChannelInput {
  if (channel.kind === 'subscription') {
    const { provider: _provider, baseUrl: _url, protocol: _protocol, ...metadata } = channel;
    return { revision, ...(id ? { id } : {}), channel: metadata };
  }
  return { revision, ...(id ? { id } : {}), channel, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(replaceConfig ? { config } : {}) };
}

/** Apply only server channel changes to a policy draft; role edits and untouched channels survive. */
export function mergeChannelPolicy(draft: Config, before: Config, after: Config): Config {
  const channels = { ...draft.channels };
  for (const id of Object.keys(before.channels)) if (!Object.hasOwn(after.channels, id)) delete channels[id];
  for (const [id, channel] of Object.entries(after.channels)) {
    if (JSON.stringify(channel) !== JSON.stringify(before.channels[id])) channels[id] = structuredClone(channel);
  }
  return { ...draft, channels };
}

/** Native subscription usage must prove the exact channel; API records never borrow official quota. */
export function channelQuota(id: string, channel: Channel, configuration?: ChannelConfiguration): EngineQuotaRecord | undefined {
  return channel.kind === 'subscription' && configuration?.quota?.channel === id ? configuration.quota : undefined;
}

/** Replacement is opt-in: a normal import never overwrites a CLI-renewed managed grant. */
export function channelImportInput(revision: number, engine: string, sourceDir: string, replaceExisting: boolean): ImportChannelsInput {
  return { revision, ...(engine !== 'all' ? { engine } : {}), ...(sourceDir.trim() ? { sourceDir: sourceDir.trim() } : {}), ...(replaceExisting ? { replaceExisting: true } : {}) };
}

/** The shared storage limit applies to UTF-8 bytes, including CJK and pasted credentials. */
export function channelContentError(value: string): string {
  return new TextEncoder().encode(value).byteLength > CHANNEL_CONFIG_MAX_BYTES ? `内容不能超过 ${CHANNEL_CONFIG_MAX_BYTES / 1024} KiB。` : '';
}

/** Report this import receipt, rather than inferring outcomes from the current account list. */
export function channelImportNotice(result: ImportChannelsResult['importResult']): string {
  const counts = `新增 ${result.added}、已有 ${result.existing}、更新 ${result.updated} 条。`;
  const empty = result.added + result.existing + result.updated === 0 ? '未发现可导入项。' : '';
  const notFound = result.notFound.length ? `未发现可导入配置：${result.notFound.join('、')}。` : '';
  const failures = result.failures.length ? `部分引擎导入失败：${result.failures.map(issue => `${issue.engine}：${issue.message}`).join('；')}。请修正来源或选择失败引擎后重试；普通导入会保留已有账号。` : '';
  return `${counts}${empty}${notFound}${failures}`;
}

export interface ChannelReferences { owners: string[]; workers: string[] }

/** Every role that names this channel, split so each reference can link to its own page. */
export function channelReferences(config: Config, channel: string): ChannelReferences {
  return {
    owners: Object.entries(config.owners).filter(([, role]) => role.channel === channel).map(([id]) => id),
    workers: Object.entries(config.workers).filter(([, role]) => role.channels.includes(channel)).map(([id]) => id),
  };
}

export interface ChannelMetric { value: string; hint: string; tone?: 'warning' }
export interface ChannelMetrics { total: ChannelMetric; subscriptions: ChannelMetric; api: ChannelMetric; quota: ChannelMetric }

/** The four page metrics. Quota freshness uses the same five-minute rule as every quota surface. */
export function channelMetrics(config: Config, snapshot?: ChannelsSnapshot, now = Date.now()): ChannelMetrics {
  const entries = Object.entries(config.channels);
  const subscriptions = entries.filter(([, channel]) => channel.kind === 'subscription');
  const api = entries.filter(([, channel]) => channel.kind === 'api');
  const enabled = entries.filter(([, channel]) => channel.enabled).length;
  const enabledSubscriptions = subscriptions.filter(([, channel]) => channel.enabled).length;
  const enabledApi = api.filter(([, channel]) => channel.enabled).length;
  let available = 0;
  let unauthenticated = 0;
  for (const [id, channel] of subscriptions) {
    const configuration = snapshot?.configurations[id];
    const record = channelQuota(id, channel, configuration);
    if (!configuration?.hasCredentials || record?.status === 'unauthenticated') unauthenticated++;
    if (record?.status === 'available' && !quotaRecordStale(record, now)) available++;
  }
  return {
    total: { value: String(entries.length), hint: `启用 ${enabled}` },
    subscriptions: { value: String(subscriptions.length), hint: `启用 ${enabledSubscriptions}` },
    api: { value: String(api.length), hint: `启用 ${enabledApi}` },
    quota: {
      value: `${available} / ${subscriptions.length}`,
      hint: `未登录 ${unauthenticated}`,
      ...(subscriptions.length > 0 && available === 0 ? { tone: 'warning' as const } : {}),
    },
  };
}

export interface ChannelQuotaHeadline { text: string; tone?: 'warning' | 'danger' }

/**
 * The one-line quota summary beside a channel name: the tightest measured window,
 * or the state that prevents a meaningful reading. Text says the reason, so color is secondary.
 */
export function channelQuotaHeadline(id: string, channel: Channel, configuration: ChannelConfiguration | undefined, now = Date.now()): ChannelQuotaHeadline {
  if (channel.kind === 'api') return { text: '无官方订阅额度' };
  if (!configuration) return { text: '尚无额度观测' };
  if (!configuration.hasCredentials) return { text: '未登录', tone: 'warning' };
  const record = channelQuota(id, channel, configuration);
  if (!record) return { text: '尚无额度观测' };
  const stale = quotaRecordStale(record, now);
  const prefix = stale ? '上次观测 · ' : '';
  switch (record.status) {
    case 'error': return { text: '额度查询失败', tone: 'danger' };
    case 'unauthenticated': return { text: '未登录', tone: 'warning' };
    case 'exhausted': return { text: `${prefix}额度耗尽`, tone: 'warning' };
    case 'unsupported': return { text: '无原生额度' };
    case 'unknown': return { text: '额度未知' };
    case 'available': {
      const tightest = quotaTightestWindow(record);
      if (!tightest) return { text: `${prefix}额度可用` };
      const label = quotaWindowShortLabel(tightest);
      if (tightest.usedPercent !== null) return { text: `${prefix}${label} 已用 ${quotaPercentText(tightest.usedPercent)}` };
      if (tightest.remaining !== null) return { text: `${prefix}${label} 剩余 ${quotaCountText(tightest.remaining, tightest.unit)}` };
      return { text: `${prefix}${label} 额度可用` };
    }
  }
}

export interface ChannelDraft {
  id?: string;
  /** The values this draft started from; used only to decide whether SaveBar belongs on screen. */
  initial: Channel;
  channel: Channel;
  apiKey: string;
  nativeConfig: string;
  replaceConfig: boolean;
  uploadError: string;
}

export function channelDraftFor(channel: Channel, id?: string): ChannelDraft {
  return { ...(id ? { id } : {}), initial: structuredClone(channel), channel: structuredClone(channel), apiKey: '', nativeConfig: '', replaceConfig: false, uploadError: '' };
}

const channelFingerprint = (channel: Channel): string => JSON.stringify(Object.entries(channel).sort(([left], [right]) => left.localeCompare(right)));

export function channelDraftDirty(draft: ChannelDraft | undefined): boolean {
  if (!draft) return false;
  return channelFingerprint(draft.channel) !== channelFingerprint(draft.initial)
    || draft.apiKey !== '' || draft.nativeConfig !== '' || draft.replaceConfig || draft.uploadError !== '';
}

export function channelProtocols(kind: string): { value: NonNullable<Channel['protocol']>; label: string }[] {
  if (kind === 'claude' || kind === 'dsh') return [{ value: 'anthropic', label: 'Anthropic Messages' }];
  if (kind === 'codex') return [{ value: 'openai-responses', label: 'OpenAI Responses' }];
  return [
    { value: 'openai-responses', label: 'OpenAI Responses' },
    { value: 'openai', label: 'OpenAI Chat Completions' },
    { value: 'anthropic', label: 'Anthropic Messages' },
  ];
}

export function channelDefaultProtocol(kind: string): NonNullable<Channel['protocol']> {
  return kind === 'claude' || kind === 'dsh' ? 'anthropic' : 'openai-responses';
}

/** A save is possible only when the visible fields are complete and every secret stays within its limit. */
export function channelDraftCanSave(draft: ChannelDraft, editing: boolean, allowedEngines: string[], kind: string): boolean {
  const channel = draft.channel;
  const protocols = channelProtocols(kind);
  const protocolValid = !channel.protocol || protocols.some(option => option.value === channel.protocol);
  const configError = draft.replaceConfig ? channelContentError(draft.nativeConfig) : '';
  const keyError = channel.kind === 'api' ? channelContentError(draft.apiKey) : '';
  return (editing || allowedEngines.includes(channel.engine))
    && !configError && !keyError && protocolValid && !draft.uploadError
    && !!channel.label.trim() && !!channel.engine
    && (channel.kind !== 'api' || !directApiAllowed(kind) || !!channel.provider?.trim());
}
