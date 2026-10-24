export const CHANNEL_CONFIG_MAX_BYTES = 128 * 1024;
import type { EngineQuotaRecord } from './quota';
import type { PolicySnapshot } from './policy';
export interface Channel { engine: string; label: string; enabled: boolean; kind: 'subscription' | 'api'; quota_refresh?: boolean; provider?: string; baseUrl?: string; protocol?: 'anthropic' | 'openai' | 'openai-responses' }
/** Private native configuration; never serialize into policy or dispatch. */
export interface ChannelSecret { config?: string; apiKey?: string; authDir?: string }
export interface ChannelConfiguration { quota?: EngineQuotaRecord; hasApiKey: boolean; hasConfig: boolean; hasCredentials: boolean; detail?: string }
export interface ChannelsSnapshot { policy: PolicySnapshot; configurations: Record<string, ChannelConfiguration> }
export interface SaveChannelInput { revision: number; id?: string; channel: Channel; config?: string; apiKey?: string }
export interface DeleteChannelInput { revision: number; id: string }
export interface ImportChannelsInput { replaceExisting?: boolean; revision: number; engine?: string; sourceDir?: string }
export interface RefreshChannelQuotaInput { channel: string }
