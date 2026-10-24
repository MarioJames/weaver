import type { EngineQuotaRecord, QuotaRefreshResult, QuotaWindow } from '../../../shared/contracts/quota';
import { QUOTA_FRESH_MS } from '../../../shared/contracts/quota';
import { THIRD_PARTY_DETAIL } from '../../../shared/contracts/quota';
import type { PolicyDraft } from '../../policy/usePolicyDraft';
import { compactTime } from '../../format/timezone';

export const STATUS_NAMES: Record<EngineQuotaRecord['status'], string> = {
  available: '观测到可用额度', exhausted: '账户额度耗尽', unknown: '额度未知',
  unauthenticated: '登录状态不可用', unsupported: '当前认证方式不支持', error: '额度查询失败',
};

function known(value: number | null): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
export function quotaPercentText(value: number | null): string { return known(value) ? `${value}%` : '未知'; }
export function quotaProgressPercent(window: QuotaWindow): number | null {
  return known(window.usedPercent) ? Math.min(100, window.usedPercent) : null;
}
export function quotaScopeText(window: QuotaWindow): string {
  if (window.scope === 'account') return '账户范围';
  if (window.scope === 'model') return `模型范围：${window.model || '未返回模型名'}`;
  return `范围未确认${window.model ? ` · 模型 ${window.model}` : ''}`;
}
export function quotaCountText(value: number | null, unit: QuotaWindow['unit']): string {
  if (!known(value)) return '未知';
  return `${value}${unit === 'usd' ? ' USD' : unit === 'credits' ? ' credits' : unit === 'requests' ? ' 次请求' : '%'}`;
}
export function quotaRetryMs(record: EngineQuotaRecord | undefined, now: number): number {
  const deadline = record?.retryAt ? Date.parse(record.retryAt) : NaN;
  return Number.isFinite(deadline) ? Math.max(0, deadline - now) : 0;
}
export function quotaWindowStale(window: QuotaWindow, recordStale: boolean, now: number): boolean {
  return recordStale || window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
}
export function quotaRecordStale(record: EngineQuotaRecord, now: number): boolean {
  const observed = record.observedAt ? Date.parse(record.observedAt) : NaN;
  if (record.stale || !Number.isFinite(observed) || now - observed >= QUOTA_FRESH_MS) return true;
  if (record.statusBasis === 'account_restriction') return false;
  const measured = record.windows.filter(window => window.scope === 'account' && window.usedPercent !== null);
  return measured.length > 0 && measured.every(window => quotaWindowStale(window, false, now));
}
/** Wake only for local deadlines; this timer never performs an RPC or provider request. */
export function quotaNextUpdateMs(records: EngineQuotaRecord[], now: number): number | null {
  const waits: number[] = [];
  for (const record of records) {
    const retry = quotaRetryMs(record, now);
    if (retry > 0) waits.push(Math.min(1000, retry));
    if (quotaRecordStale(record, now)) continue;
    const freshUntil = Date.parse(record.observedAt!) + QUOTA_FRESH_MS;
    if (freshUntil > now) waits.push(freshUntil - now);
    for (const window of record.windows) {
      const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      if (reset > now) waits.push(reset - now);
    }
  }
  return waits.length ? Math.min(2_147_483_647, ...waits) : null;
}
/** The engine's CLI is switched to another provider (for example by cc-switch), so there is no native quota to read. */
export function quotaThirdParty(record: Pick<EngineQuotaRecord, 'status' | 'detail'>): boolean {
  return record.status === 'unsupported' && record.detail === THIRD_PARTY_DETAIL;
}
export function quotaStatusText(record: EngineQuotaRecord, stale = record.stale): string {
  if (quotaThirdParty(record)) return '第三方供应商';
  const label = STATUS_NAMES[record.status];
  return stale && (record.status === 'available' || record.status === 'exhausted') ? `上次观测：${label}` : label;
}
/** The existing draft owns acceptance. A quota response never replaces a dirty or newer policy. */
export function acceptQuotaPolicy(policy: Pick<PolicyDraft, 'dirty' | 'snapshot' | 'applyServerSnapshot'>, result: QuotaRefreshResult): string {
  const kept = '额度已刷新，未保存的修改已保留。自动限制可能已变化，请重新加载后再保存，避免版本冲突。';
  if (policy.dirty) return kept;
  if (policy.snapshot && result.snapshot.revision < policy.snapshot.revision) return '额度已刷新，页面已有更新的策略版本。';
  if (!policy.applyServerSnapshot(result.snapshot)) return kept;
  return result.policyChanged ? '额度已刷新，已按额度更新自动限制。' : '额度已刷新。';
}
/** A timestamp as compact project-zone text: HH:mm today, MM-DD HH:mm otherwise. */
export function dateText(value: string | null, now: number = Date.now(), zone?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '未知';
  return compactTime(value, now, zone);
}
export function quotaRecoveryText(record: EngineQuotaRecord): string {
  // OpenCode Go windows share the opencode kind with free and third-party routes: a 100% Go
  // plan window never pauses the engine, and limits keep arriving through model feedback.
  if (record.engine === 'opencode' && record.status === 'exhausted') return 'Go 套餐窗口已耗尽；这不代表余额、免费模型或其他路线不可用。实际限额按对应模型反馈处理。';
  if (record.engine === 'opencode' && record.status === 'unauthenticated') return '额度读取本身不切换账号。请在「账号登录与切换」或 OpenCode 中重新连接 OpenCode Go 后手动刷新。';
  if (record.engine === 'opencode' && record.status === 'unsupported') return '免费模型与按量余额没有官方只读额度接口；连接 OpenCode Go 后可查看套餐窗口。额度读取本身不切换账号。';
  if (record.status === 'unauthenticated') return '请在原生 CLI 中确认登录后手动刷新。Weaver 不会登录、刷新凭据或切换账户。';
  if (quotaThirdParty(record)) return '用量由供应商统计。切回官方订阅后可再次刷新；Weaver 不会改动 cc-switch 或 CLI 配置。';
  if (record.status === 'unsupported') return '当前已有认证无法用于此额度读取。请核对原生 CLI 的订阅登录方式；Weaver 不会改动认证。';
  if (record.status === 'error') return '接口可能暂不可用。冷却结束后可手动重试；下方旧观测不代表本次查询成功。';
  if (record.status === 'unknown') return '尚不能确认账户额度，未知值不会按 0 处理。';
  return '';
}

/** Windows shown under the quota state on engine cards. */
export function quotaVisibleWindows(record: EngineQuotaRecord): QuotaWindow[] { return record.status === 'unknown' ? [] : record.windows; }
