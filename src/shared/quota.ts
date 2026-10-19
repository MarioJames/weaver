import type { PolicySnapshot } from './policy';

export const QUOTA_FRESH_MS = 300_000;

export type QuotaEngine = 'codex' | 'claude' | 'grok';
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

export interface QuotaSnapshot { records: EngineQuotaRecord[] }
export interface QuotaRefreshInput { engine?: QuotaEngine }
export interface QuotaRefreshResult extends QuotaSnapshot { snapshot: PolicySnapshot; policyChanged: boolean }
