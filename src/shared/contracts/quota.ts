import type { PolicySnapshot } from './policy';

export const QUOTA_FRESH_MS = 300_000;

export type QuotaEngine = 'codex' | 'claude' | 'grok' | 'opencode';
export type QuotaStatus = 'available' | 'exhausted' | 'unknown' | 'unauthenticated' | 'unsupported' | 'error';

export interface QuotaWindow {
  id: string;
  label: string;
  scope: 'account' | 'model' | 'unknown';
  model: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  durationMinutes: number | null;
  used: number | null;
  total: number | null;
  remaining: number | null;
  unit: 'percent' | 'credits' | 'requests' | 'usd';
}

export interface EngineQuotaRecord {
  channel?: string;
  engine: QuotaEngine;
  status: QuotaStatus;
  /** Independent account restriction; included quota-window resets cannot release it. */
  statusBasis?: 'account_restriction';
  source: string;
  checkedAt: string | null;
  observedAt: string | null;
  stale: boolean;
  windows: QuotaWindow[];
  detail: string;
  retryAt: string | null;
}

export interface QuotaSchedule { enabled: boolean; intervalMinutes: number; lastRunAt: string | null; nextRunAt: string | null }
export interface QuotaSnapshot { records: EngineQuotaRecord[]; schedule?: QuotaSchedule }
export interface QuotaRefreshInput { engine?: QuotaEngine; channel?: string }
export interface QuotaRefreshResult extends QuotaSnapshot { snapshot: PolicySnapshot; policyChanged: boolean }

/** Shown for an engine whose CLI is switched to a third-party provider (for example by cc-switch). The renderer matches on this exact text. */
export const THIRD_PARTY_DETAIL = '当前使用第三方供应商（如 cc-switch 配置），无原生额度可查';
