import { ENGINE_CATALOG } from '../../../shared/engines';
import { CHANNEL_CONFIG_MAX_BYTES } from '../../../shared/contracts/channels';
import type { Channel, ChannelConfiguration, ImportChannelsInput, ImportChannelsResult, SaveChannelInput } from '../../../shared/contracts/channels';
import type { EngineQuotaRecord } from '../../../shared/contracts/quota';
import type { Config } from '../../../shared/contracts/policy';

export const directApiAllowed = (kind: string): boolean => kind !== 'qoder' && kind !== 'qodercli';
export const subscriptionAllowed = (kind: string): boolean => ENGINE_CATALOG.some(entry => entry.kind === kind) && kind !== 'pi' && kind !== 'dsh';

export function channelUsers(config: Config, channel: string): string[] {
  return [
    ...Object.entries(config.owners).filter(([, role]) => role.channel === channel).map(([id]) => `父 Agent ${id}`),
    ...Object.entries(config.workers).filter(([, role]) => role.channels.includes(channel)).map(([id]) => `子 Agent ${id}`),
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
