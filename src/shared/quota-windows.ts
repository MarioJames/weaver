import type { QuotaWindow } from './contracts/quota';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Numeric exhaustion only. Callers determine account/model scope and observation freshness. */
export function quotaWindowExhausted(window: QuotaWindow): boolean {
  return finite(window.usedPercent) && window.usedPercent >= 100
    || window.remainingPercent === 0
    || window.remaining === 0
    || finite(window.used) && finite(window.total) && window.total > 0 && window.used >= window.total;
}
