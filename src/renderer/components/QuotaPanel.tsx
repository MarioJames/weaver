import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Progress, Skeleton, Text } from '@lobehub/ui/base-ui';
import type { EngineQuotaRecord, QuotaEngine, QuotaRefreshResult, QuotaWindow } from '../../shared/quota';
import { QUOTA_FRESH_MS } from '../../shared/quota';
import type { PolicyDraft } from '../usePolicyDraft';
import { styles } from '../style';
import { quotaStyles } from './quota.style';

const ENGINES: QuotaEngine[] = ['codex', 'claude', 'grok'];
const ENGINE_NAMES: Record<QuotaEngine, string> = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok' };
const SOURCE_NAMES: Record<string, string> = {
  codex_usage: 'Codex 订阅用量',
  claude_oauth_usage: 'Claude Code 订阅用量',
  grok_cli_billing: 'Grok CLI 订阅账期',
};
const STATUS_NAMES: Record<EngineQuotaRecord['status'], string> = {
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
export function quotaStatusText(record: EngineQuotaRecord, stale = record.stale): string {
  const label = STATUS_NAMES[record.status];
  return stale && (record.status === 'available' || record.status === 'exhausted') ? `上次观测：${label}` : label;
}
/** The existing draft owns acceptance. A quota response never replaces a dirty or newer policy. */
export function acceptQuotaPolicy(policy: Pick<PolicyDraft, 'dirty' | 'snapshot' | 'applyServerSnapshot'>, result: QuotaRefreshResult): string {
  if (policy.dirty) return '额度已刷新，未保存草稿已保留。自动阻断可能已更新；请重新加载后核对，直接保存可能发生版本冲突。';
  if (policy.snapshot && result.snapshot.revision < policy.snapshot.revision) return '额度已刷新；页面已有更新的策略版本，继续保留当前配置。';
  if (!policy.applyServerSnapshot(result.snapshot)) return '额度已刷新，当前草稿已保留。请重新加载策略后核对自动阻断，避免保存冲突。';
  return result.policyChanged ? '额度已刷新，自动来源阻断已同步；人工/历史阻断保留。' : '额度已刷新，自动来源阻断无变化；人工/历史阻断保留。';
}
function dateText(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '未知';
}
function recoveryText(record: EngineQuotaRecord): string {
  if (record.status === 'unauthenticated') return '请在原生 CLI 中确认登录后手动刷新。Weaver 不会登录、刷新凭据或切换账户。';
  if (record.status === 'unsupported') return '当前已有认证无法用于此额度读取。请核对原生 CLI 的订阅登录方式；Weaver 不会改动认证。';
  if (record.status === 'error') return '接口可能暂不可用。冷却结束后可手动重试；下方旧观测不代表本次查询成功。';
  if (record.status === 'unknown') return '尚不能确认账户额度，未知值不会按 0 处理。';
  return '';
}

export function QuotaPanel({ policy }: { policy: PolicyDraft }) {
  const [records, setRecords] = useState<EngineQuotaRecord[]>([]);
  const [busy, setBusy] = useState<'cache' | 'all' | QuotaEngine | null>('cache');
  const [cacheError, setCacheError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false);
  const request = useRef(0);
  const inFlight = useRef(false);
  const currentPolicy = useRef(policy);
  currentPolicy.current = policy;
  const current = (id: number) => mounted.current && id === request.current;
  const load = useCallback(async () => {
    if (inFlight.current) return;
    const id = ++request.current;
    inFlight.current = true; setBusy('cache'); setCacheError('');
    try {
      if (!window.weaver) throw new Error('控制面不可用，请通过 weaver web 打开页面。');
      const result = await window.weaver.getQuota();
      if (current(id)) { setRecords(result.records); setNow(Date.now()); }
    } catch (error) {
      if (current(id)) setCacheError(error instanceof Error ? error.message : String(error));
    } finally {
      if (current(id)) { inFlight.current = false; setBusy(null); }
    }
  }, []);
  useEffect(() => {
    mounted.current = true; void load();
    return () => { mounted.current = false; request.current += 1; inFlight.current = false; };
  }, [load]);
  useEffect(() => {
    const delay = quotaNextUpdateMs(records, now);
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [records, now]);

  async function refresh(engine?: QuotaEngine) {
    if (inFlight.current || currentPolicy.current.busy || currentPolicy.current.loading) return;
    const selected = engine ? records.filter(record => record.engine === engine) : records;
    if (selected.some(record => quotaRetryMs(record, Date.now()) > 0)) return;
    const id = ++request.current;
    inFlight.current = true; setBusy(engine ?? 'all'); setRefreshError(''); setFeedback('');
    try {
      if (!window.weaver) throw new Error('控制面不可用，请通过 weaver web 打开页面。');
      const result = await window.weaver.refreshQuota(engine ? { engine } : {});
      if (!current(id)) return;
      setRecords(result.records); setCacheError(''); setNow(Date.now());
      setFeedback(acceptQuotaPolicy(currentPolicy.current, result));
    } catch (error) {
      if (current(id)) {
        setRefreshError(error instanceof Error ? error.message : String(error));
        setRecords(previous => previous.map(record => !engine || record.engine === engine ? { ...record, stale: true } : record));
      }
    } finally {
      if (current(id)) { inFlight.current = false; setBusy(null); }
    }
  }
  const cooling = records.some(record => quotaRetryMs(record, now) > 0);
  const policyBusy = policy.busy || policy.loading;
  return <section aria-label="订阅额度" className={quotaStyles.panel} aria-busy={busy !== null}>
    <div className={styles.spread}>
      <Text as="h2" className={quotaStyles.title} strong>订阅额度</Text>
      <div className={styles.row}>
        <Button size="small" loading={busy === 'cache'} disabled={busy !== null} onClick={() => void load()}>读取额度缓存</Button>
        <Button size="small" loading={busy === 'all'} disabled={busy !== null || policyBusy || cooling} onClick={() => void refresh()}>刷新三家额度</Button>
      </div>
    </div>
    <Text type="secondary" className={quotaStyles.note}>刷新会查询三家非公开额度接口并同步自动来源阻断，人工/历史阻断保留；不会调用模型。额度观测不保证模型可运行。</Text>
    {cacheError && <div role="alert" className={styles.stack}><Text type="danger">额度缓存读取失败：{cacheError}</Text>{records.length > 0 && <Text type="secondary">下方保留上次读取的缓存，请核对观测时间。</Text>}<Button size="small" disabled={busy !== null} onClick={() => void load()}>重试读取额度缓存</Button></div>}
    {refreshError && <div role="alert" className={styles.stack}><Text type="danger">额度刷新未完成：{refreshError}</Text><Text type="secondary">保留下方上次读取的数据。请核对策略或在冷却结束后重试刷新。</Text></div>}
    {feedback && <Text role="status" className={styles.wrap}>{feedback}</Text>}
    {cooling && <Text type="secondary" role="status">部分接口正在冷却，三家刷新暂不可用；其余未冷却的接口可单独刷新。</Text>}
    <div className={styles.engines}>
      {ENGINES.map(engine => {
        const record = records.find(item => item.engine === engine);
        const retry = quotaRetryMs(record, now);
        const stale = record ? quotaRecordStale(record, now) : true;
        return <section key={engine} aria-label={`${ENGINE_NAMES[engine]} 额度`} className={quotaStyles.provider}>
          <div className={styles.spread}>
            <div className={styles.row}><Text strong>{ENGINE_NAMES[engine]}</Text>{record && <Text type={record.status === 'error' || record.status === 'exhausted' ? 'warning' : 'secondary'}>{quotaStatusText(record, stale)}</Text>}</div>
            <Button size="small" aria-label={`刷新 ${ENGINE_NAMES[engine]} 额度`} loading={busy === engine} disabled={busy !== null || policyBusy || retry > 0} onClick={() => void refresh(engine)}>刷新</Button>
          </div>
          {!record ? busy === 'cache' ? <Skeleton.Text rows={1} /> : <Text type="secondary">尚未读取额度缓存。可重试读取缓存或手动刷新。</Text> : <>
            <Text className={styles.wrap}>{stale ? '上次接口说明：' : ''}{record.detail}</Text>
            {stale && <Text type="warning">{record.observedAt ? '缓存已过期，下方保留上次成功观测，请勿当成本次可用额度。' : '尚无成功观测，当前额度未知。'}</Text>}
            {record.windows.length ? <div className={quotaStyles.windows}>{record.windows.map(window => <QuotaWindowRow key={window.id} window={window} stale={quotaWindowStale(window, stale, now)} />)}</div> : <Text type="secondary">没有可确认的额度窗口。</Text>}
            {recoveryText(record) && <Text type="secondary" className={quotaStyles.note}>{recoveryText(record)}</Text>}
            <Text type="secondary" className={quotaStyles.note}>来源：{SOURCE_NAMES[record.source] ?? '未知来源'} · 非公开接口</Text>
            <Text type="secondary" className={quotaStyles.note}>上次检查：{dateText(record.checkedAt)} · 上次成功观测：{dateText(record.observedAt)}</Text>
            {retry > 0 && <Text role="status" type="secondary" className={quotaStyles.note}>冷却中，{Math.ceil(retry / 1000)} 秒后可重试（{dateText(record.retryAt)}）。</Text>}
          </>}
        </section>;
      })}
    </div>
  </section>;
}

function QuotaWindowRow({ window, stale }: { window: QuotaWindow; stale: boolean }) {
  const percent = quotaProgressPercent(window);
  const hasPercent = window.unit === 'percent' || known(window.usedPercent) || known(window.remainingPercent);
  return <div className={quotaStyles.window}>
    <Text strong className={styles.wrap}>{window.label}</Text>
    {stale && <Text type="warning" className={quotaStyles.note}>历史观测，已过期，待刷新。</Text>}
    <Text type="secondary" className={quotaStyles.note}>{quotaScopeText(window)}{window.durationMinutes !== null ? ` · 窗口 ${window.durationMinutes} 分钟` : ''}</Text>
    {hasPercent && <Text className={quotaStyles.numbers}>已用 {quotaPercentText(window.usedPercent)} · 剩余 {quotaPercentText(window.remainingPercent)}</Text>}
    {percent !== null && <Progress size="small" percent={percent} showInfo={false} aria-label={`${window.label} ${stale ? '历史观测' : '观测'}已用比例`} aria-valuetext={`已用 ${quotaPercentText(window.usedPercent)}${stale ? '，缓存已过期' : ''}`} />}
    {window.unit !== 'percent' && <Text className={quotaStyles.numbers}>已用 {quotaCountText(window.used, window.unit)} · 总量 {quotaCountText(window.total, window.unit)} · 剩余 {quotaCountText(window.remaining, window.unit)}</Text>}
    <Text type="secondary" className={quotaStyles.note}>重置时间：{dateText(window.resetsAt)}</Text>
  </div>;
}
