import type { Engine, FreeChannelProbeSettings, JanitorSettings, QuotaSettings } from '../contracts/policy';

/** The single kind -> legal effort table; kinds not listed accept any non-empty string. */
export const EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max"],
  grok: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  qodercli: ["auto", "none", "low", "medium", "high", "xhigh", "max", "ultracode"],
  dsh: ["off", "low", "high", "max"],
};
/** Kinds with a native account quota probe. Other kinds have no native quota probe; this does not imply a free route. */
export const QUOTA_KINDS = ["codex", "claude", "grok", "opencode"] as const;
export const hasQuotaProbe = (kind: string) => (QUOTA_KINDS as readonly string[]).includes(kind);
/** Missing means on for kinds with a quota probe, off otherwise. */
export function quotaRefreshEnabled(engine: Engine): boolean {
  return engine.quota_refresh ?? hasQuotaProbe(engine.kind);
}
export const QUOTA_INTERVAL_RANGE = { min: 5, max: 1440 } as const;
export function quotaSettings(config: { quota?: QuotaSettings }): QuotaSettings {
  return config.quota ?? { auto_refresh: true, interval_minutes: 15 };
}
export const FREE_CHANNEL_INTERVAL_RANGE = { min: 5, max: 1440 } as const;
/** A single command may run this long before health calls it suspect; Weaver never stops it on this setting. */
export const MAX_COMMAND_MINUTES_DEFAULT = 30;
export const MAX_COMMAND_MINUTES_RANGE = { min: 1, max: 1440 } as const;
/** The effective bound: a missing key (older policy) means the default, never a migration. */
export function maxCommandMinutes(config: { herdr?: { max_command_minutes?: unknown } }): number {
  const value = config.herdr?.max_command_minutes;
  return typeof value === 'number' && Number.isInteger(value) && value >= MAX_COMMAND_MINUTES_RANGE.min && value <= MAX_COMMAND_MINUTES_RANGE.max
    ? value
    : MAX_COMMAND_MINUTES_DEFAULT;
}
export const JANITOR_DEFAULTS: JanitorSettings = { enabled: true, ttl_hours: 24, interval_hours: 6 };
export const JANITOR_TTL_RANGE = { min: 1, max: 8760 } as const;
export const JANITOR_INTERVAL_RANGE = { min: 1, max: 168 } as const;
/** Stored janitor settings; a missing section means the documented defaults. */
export function janitorSettings(config: { janitor?: JanitorSettings }): JanitorSettings {
  return config.janitor ?? { ...JANITOR_DEFAULTS };
}
export function freeChannelProbeSettings(config: { free_channel_probe?: FreeChannelProbeSettings }): FreeChannelProbeSettings {
  return config.free_channel_probe ?? { enabled: true, interval_minutes: 10 };
}
/** An IANA timezone name Intl can format; empty keeps the browser's zone. */
export function isValidTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat(undefined, { timeZone: value }); return true; } catch { return false; }
}
/** Effective automatic ChatGPT review switch. Only boolean false disables it; a missing field stays enabled. Non-booleans are schema errors and are not coerced. */
export function chatgptReviewEnabled(config: { chatgpt_review?: unknown }): boolean {
  return config.chatgpt_review !== false;
}
