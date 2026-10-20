import type { Engine, FreeChannelProbeSettings, QuotaSettings } from '../contracts/policy';

/** The single kind -> legal effort table; kinds not listed accept any non-empty string. */
export const EFFORTS: Record<string, string[]> = {
  zcode: ["auto"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max"],
  grok: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  qodercli: ["auto", "none", "low", "medium", "high", "xhigh", "max", "ultracode"],
};
/** Kinds with a native account quota probe. Other kinds have no native quota probe; this does not imply a free route. */
export const QUOTA_KINDS = ["codex", "claude", "grok"] as const;
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
