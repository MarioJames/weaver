import { NamedSwitch } from '../components/NamedControls';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RefreshCw, ScanSearch } from 'lucide-react';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import { ActionIcon, Alert, Button, Progress, Skeleton, Tag, Text, Tooltip } from '@lobehub/ui/base-ui';
import { ENGINE_CATALOG, catalogEntry, engineDisableConflict, type EngineProbeRecord } from '../../shared/engines';
import type { EngineQuotaRecord, QuotaEngine, QuotaWindow } from '../../shared/quota';
import { QUOTA_KINDS, quotaRefreshEnabled, type Block, type Engine } from '../../main/policy/routing';
import { acceptQuotaPolicy, dateText, quotaPercentText, quotaProgressPercent, quotaRecordStale, quotaRecoveryText, quotaRetryMs, quotaStatusText, quotaNextUpdateMs, quotaCountText } from '../quota-view';
import type { PolicyDraft, PolicyUpdate } from '../usePolicyDraft';
import type { RendererAPI, StallEngineState, StallHistoryEntry, StallSnapshot } from '../client';
import { styles } from '../style';

const PROBE: Record<string, { label: string; color?: string }> = {
  installed: { label: '已安装', color: 'success' },
  missing: { label: '未找到' },
  probe_failed: { label: '探测失败', color: 'error' },
  loading: { label: '正在探测', color: 'processing' },
  unknown: { label: '尚未探测' },
};

function mergeProbes(current: EngineProbeRecord[], probe: EngineProbeRecord | null): EngineProbeRecord[] {
  const next = probe ? [...current.filter(item => item.id !== probe.id), probe] : current;
  return ENGINE_CATALOG.map(entry => next.find(item => item.id === entry.id)).filter((item): item is EngineProbeRecord => Boolean(item));
}

const isQuotaKind = (kind: string): kind is QuotaEngine => (QUOTA_KINDS as readonly string[]).includes(kind);

/** Penalty blocks are ordinary policy blocks; this `by` value is what tells them apart from a quota or manual pause. */
const STALL_BY = 'weaver-stall';
const STALL_HISTORY = 5;
const STALL_TASK_ID = 8;

/** Quota observations live in the main process; reading them never calls a provider, so polling is cheap. */
function useQuota(policy: PolicyDraft, onTick?: () => void) {
  const [records, setRecords] = useState<EngineQuotaRecord[]>([]);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<QuotaEngine | null>(null);
  const [feedback, setFeedback] = useState<{ engine: QuotaEngine; text: string; error: boolean }>();
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const tick = useRef(onTick);
  tick.current = onTick;
  const load = useCallback(async () => {
    if (!window.weaver) { setLoadError('控制面不可用，请通过 weaver web 打开页面。'); return; }
    try {
      const result = await window.weaver.getQuota();
      if (mounted.current) { setRecords(result.records); setLoadError(''); setNow(Date.now()); }
    } catch (error) { if (mounted.current) setLoadError(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load().then(() => tick.current?.());
    const timer = setInterval(() => void load().then(() => tick.current?.()), 30_000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [load]);
  useEffect(() => {
    const delay = quotaNextUpdateMs(records, now);
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [records, now]);
  async function refresh(engine: QuotaEngine) {
    if (busy || policyRef.current.busy || !window.weaver) return;
    setBusy(engine); setFeedback(undefined);
    try {
      const result = await window.weaver.refreshQuota({ engine });
      if (!mounted.current) return;
      setRecords(result.records); setNow(Date.now());
      setFeedback({ engine, text: acceptQuotaPolicy(policyRef.current, result), error: false });
    } catch (error) {
      if (mounted.current) setFeedback({ engine, text: `刷新失败：${error instanceof Error ? error.message : String(error)}`, error: true });
    } finally { if (mounted.current) setBusy(null); }
  }
  return { records, loadError, busy, feedback, now, refresh, load };
}

/** The stall RPC is an optional capability: an older control plane has no `getStall`, and then nothing is shown. */
function useStall() {
  const [snapshot, setSnapshot] = useState<StallSnapshot>();
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    const getStall = (window.weaver as Partial<RendererAPI> | undefined)?.getStall;
    if (!getStall) return;
    try {
      const result = await getStall();
      if (mounted.current) { setSnapshot(result); setNow(Date.now()); }
    } catch { if (mounted.current) setSnapshot(undefined); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return { snapshot, now, load };
}

function stallTasks(tasks: string[]): string {
  return tasks.map(task => task.slice(0, STALL_TASK_ID)).join('、');
}

/** A penalty line belongs to the engine only while its penalty block is still in force. */
function activeStallBlock(blocks: Block[], now: number): Block | undefined {
  return blocks.find(block => block.by === STALL_BY && (!block.release_at || Date.parse(block.release_at) > now));
}

function stallReleaseText(block: Block, now: number): string {
  const release = block.release_at ? Date.parse(block.release_at) : NaN;
  if (!Number.isFinite(release) || release <= now) return '待探测解封';
  return `${new Date(release).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 自动解除`;
}

function stallHistoryText(entry: StallHistoryEntry): string {
  const parts = [dateText(entry.at), `第 ${entry.level} 级`];
  if (entry.tasks.length) parts.push(`任务 ${stallTasks(entry.tasks)}`);
  if (entry.probe) parts.push(entry.probe.ok ? `探测正常 ${entry.probe.ms}ms` : `探测失败${entry.probe.error ? `：${entry.probe.error}` : ''}`);
  return parts.join(' · ');
}

function stallAttentionText(state: StallEngineState): string {
  const last = state.history.at(-1);
  if (!last) return `最近触发 ${dateText(state.lastTriggerAt ?? null)}。查看后点「恢复派发」解除。`;
  const tasks = last.tasks.length ? ` · 任务 ${stallTasks(last.tasks)}` : '';
  const minutes = last.stalledMinutes === undefined ? '' : ` · 已卡住 ${last.stalledMinutes} 分钟`;
  return `${dateText(last.at)} 第 ${last.level} 级${tasks}${minutes}。查看后点「恢复派发」解除。`;
}

export function StallNotice({ state, block, now }: { state?: StallEngineState; block?: Block; now: number }) {
  if (!state) return null;
  const history = state.history.slice(-STALL_HISTORY);
  if (!block && !state.needsAttention && !history.length) return null;
  return <section aria-label="惩罚暂停" className={styles.tight}>
    {state.needsAttention && <Alert type="warning" title="多个工作代理卡住，已停止自动恢复" description={stallAttentionText(state)} />}
    {state.level >= 1 && block && <div className={styles.row} style={{ gap: 6 }}>
      <Tag size="small" color="warning">{`惩罚暂停 · 第 ${state.level} 级`}</Tag>
      <Text type="secondary" className={styles.meta}>{stallReleaseText(block, now)}</Text>
    </div>}
    {history.length > 0 && <details className={styles.stallHistory}>
      <summary>记录</summary>
      {history.map((entry, index) => <Text key={`${entry.at}:${entry.level}:${index}`} type="secondary" className={styles.meta}>{stallHistoryText(entry)}</Text>)}
    </details>}
  </section>;
}

export function EnginesPage({ policy }: { policy: PolicyDraft }) {
  const [probes, setProbes] = useState<EngineProbeRecord[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const stall = useStall();
  const quota = useQuota(policy, stall.load);
  const scan = useCallback(async () => {
    if (!window.weaver) { setScanError('控制面不可用，请通过 weaver web 打开页面。'); return; }
    setScanning(true); setScanError('');
    try { setProbes((await window.weaver.scanEngines()).probes); }
    catch (error) { setScanError(error instanceof Error ? error.message : String(error)); }
    finally { setScanning(false); }
  }, []);
  useEffect(() => { void scan(); }, [scan]);
  const report = (id: string, error?: unknown) => setErrors(current => ({ ...current, [id]: error === undefined ? '' : error instanceof Error ? error.message : String(error) }));
  /** Every control on this page takes effect immediately; a draft on another page is kept and receives the same change. */
  async function change(id: string, update: PolicyUpdate) {
    if (busyId) return;
    setBusyId(id); report(id);
    try { await policy.commit(update); void stall.load(); } catch (error) { report(id, error); } finally { setBusyId(''); }
  }
  async function toggle(id: string, enabled: boolean) {
    if (!window.weaver || !policy.snapshot || busyId) return;
    setBusyId(id); report(id);
    try {
      const result = await window.weaver.setEngineEnabled({ id, enabled, revision: policy.snapshot.revision });
      setProbes(current => mergeProbes(current, result.probe));
      policy.rebase(result.snapshot, doc => ({ ...doc, config: { ...doc.config, engines: { ...doc.config.engines, [id]: { ...doc.config.engines[id]!, enabled } } } }));
    } catch (error) { report(id, error); }
    finally { setBusyId(''); }
  }
  const setEngine = (id: string, patch: Partial<Engine>) => change(id, doc => ({ ...doc, config: { ...doc.config, engines: { ...doc.config.engines, [id]: { ...doc.config.engines[id]!, ...patch } } } }));
  const saved = policy.snapshot?.config;
  const savedBlocks = policy.snapshot?.blocks ?? [];
  const unsupported = Object.entries(saved?.engines ?? {}).filter(([id]) => !catalogEntry(id));
  return <>
    <PageHeader title="引擎" description="本机已安装的 Agent CLI。这里的开关立即生效；是否派发还看额度是否自动暂停了这台引擎。" action={<Button icon={ScanSearch} loading={scanning} onClick={() => void scan()}>重新探测</Button>} />
    {scanError && <Alert type="error" title="引擎探测失败" description={scanError} action={<Button size="small" onClick={() => void scan()}>重试</Button>} />}
    {quota.loadError && <Alert type="error" title="额度读取失败" description={quota.loadError} action={<Button size="small" onClick={() => void quota.load()}>重试</Button>} />}
    {policy.loadError && <Alert type="error" title="配置读取失败" description={policy.loadError} action={<Button size="small" onClick={() => void policy.load(true)}>重新读取</Button>} />}
    {!saved && policy.loading && <Skeleton.Text animated rows={6} />}
    {saved && <div className={styles.cards}>
      {ENGINE_CATALOG.map(entry => {
        const probe = probes.find(item => item.id === entry.id);
        const record = saved.engines[entry.id];
        const status = probe?.status ?? (scanning ? 'loading' : 'unknown');
        const kindMismatch = Boolean(record && record.kind !== entry.kind);
        const enabled = record?.enabled === true;
        const conflict = engineDisableConflict(saved, entry.id);
        const blocked = busyId !== '' || (enabled ? Boolean(conflict) : probe?.status !== 'installed' || kindMismatch);
        const reason = enabled && conflict ? conflict : !enabled && probe?.status !== 'installed' ? '未在本机找到这个命令' : kindMismatch ? '已保存的类型与目录不一致' : '';
        const kind = record?.kind ?? entry.kind;
        const engineBlocks = savedBlocks.filter(block => block.engine === entry.id);
        const penaltyBlock = activeStallBlock(engineBlocks, stall.now);
        return <Surface key={entry.id} aria-label={entry.id} className={styles.card} title={entry.id} description={<span className={styles.row} style={{ gap: 6 }}><Tag size="small" color={PROBE[status]?.color}>{PROBE[status]?.label ?? status}</Tag><Text type="secondary" className={styles.wrap}>{probe?.version || entry.command}</Text></span>}
          extra={<Tooltip title={blocked && reason ? reason : enabled ? '停用' : '启用'}><span><NamedSwitch aria-label={`启用 ${entry.id}`} checked={enabled} loading={busyId === entry.id} disabled={blocked} onChange={checked => void toggle(entry.id, checked)} /></span></Tooltip>}>
          <div className={styles.cardBody}>
            <StallNotice state={stall.snapshot?.engines[entry.id]} block={penaltyBlock} now={stall.now} />
            {isQuotaKind(kind) ? <QuotaSummary engine={kind} record={quota.records.find(item => item.engine === kind)} now={quota.now} busy={quota.busy} policyBusy={policy.busy} feedback={quota.feedback?.engine === kind ? quota.feedback : undefined} onRefresh={() => void quota.refresh(kind)} />
              : <Text type="secondary" className={styles.meta}>免费模型，不探测额度。</Text>}
            <BlockList blocks={engineBlocks} disabled={busyId !== '' || !record} onRemove={block => void change(entry.id, doc => ({ ...doc, blocks: doc.blocks.filter(item => !(item.engine === block.engine && item.model === block.model)) }))} />
            <div className={styles.cardFoot}>
              <div className={styles.spread}>
                <Text>主动刷新额度</Text>
                <Tooltip title={isQuotaKind(kind) ? '按设置页的间隔自动刷新；额度耗尽时自动暂停派发，恢复后自动解除。' : '这个引擎没有额度接口。'}>
                  <span><NamedSwitch aria-label={`${entry.id} 主动刷新额度`} size="small" checked={record ? quotaRefreshEnabled(record) : false} disabled={!record || !isQuotaKind(kind) || busyId !== ''} onChange={checked => void setEngine(entry.id, { quota_refresh: checked })} /></span>
                </Tooltip>
              </div>
              {errors[entry.id] && <Text role="alert" type="danger" className={styles.meta}>{errors[entry.id]}</Text>}
              {probe?.detail && status !== 'installed' && <Text type="secondary" className={`${styles.meta} ${styles.wrap}`}>{probe.detail}</Text>}
            </div>
          </div>
        </Surface>;
      })}
      {unsupported.map(([id, record]) => <Surface key={id} aria-label={id} className={styles.card} title={id} description={<Tag size="small">暂不支持探测</Tag>}>
        <Text type="secondary" className={styles.wrap}>类型 {record.kind}。这条记录原样保留，不能在这里启用。{record.enabled ? '当前为启用状态。' : ''}</Text>
      </Surface>)}
    </div>}
  </>;
}

function BlockList({ blocks, disabled, onRemove }: { blocks: Block[]; disabled: boolean; onRemove: (block: Block) => void }) {
  const now = Date.now();
  const active = blocks.filter(block => !block.release_at || Date.parse(block.release_at) > now);
  if (!active.length) return null;
  return <section aria-label="派发限制" className={styles.tight}>
    {active.map(block => <div key={`${block.engine}:${block.model ?? ''}`} className={styles.spread} style={{ flexWrap: 'nowrap' }}>
      <span className={styles.tight}>
        <span className={styles.row} style={{ gap: 6 }}><Tag size="small" color="warning">{block.by?.startsWith('weaver-quota:') ? '额度耗尽' : '已暂停'}</Tag><Text className={styles.wrap}>{block.model ? `模型 ${block.model}` : '整台引擎'}</Text></span>
        <Text type="secondary" className={styles.meta}>{block.by?.startsWith('weaver-quota:') ? '额度恢复后自动解除' : block.reason}{block.release_at ? ` · ${dateText(block.release_at)} 恢复` : ' · 需手动恢复'}</Text>
      </span>
      <Tooltip title="恢复派发"><ActionIcon size="small" icon={Play} aria-label="恢复派发" disabled={disabled} onClick={() => onRemove(block)} /></Tooltip>
    </div>)}
  </section>;
}

function QuotaSummary({ engine, record, now, busy, policyBusy, feedback, onRefresh }: { engine: QuotaEngine; record?: EngineQuotaRecord; now: number; busy: QuotaEngine | null; policyBusy: boolean; feedback?: { text: string; error: boolean }; onRefresh: () => void }) {
  const retry = quotaRetryMs(record, now);
  const stale = record ? quotaRecordStale(record, now) : true;
  const tone = record?.status === 'exhausted' || record?.status === 'error' ? 'warning' : 'secondary';
  return <section aria-label={`${engine} 额度`} className={styles.tight}>
    <div className={styles.spread}>
      <Text type={tone}>{record ? quotaStatusText(record, stale) : '读取中'}</Text>
      <Tooltip title={retry > 0 ? `冷却中，${Math.ceil(retry / 1000)} 秒后可刷新` : '刷新额度'}>
        <ActionIcon size="small" icon={RefreshCw} aria-label={`刷新 ${engine} 额度`} loading={busy === engine} disabled={busy !== null || policyBusy || retry > 0} onClick={onRefresh} />
      </Tooltip>
    </div>
    {!record ? <Skeleton.Text rows={1} /> : <>
      {record.windows.map(window => <QuotaWindowRow key={window.id} window={window} />)}
      {!record.windows.length && record.status !== 'unknown' && <Text type="secondary" className={styles.meta}>{record.detail}</Text>}
      {quotaRecoveryText(record) && record.status !== 'unknown' && <Text type="secondary" className={styles.meta}>{quotaRecoveryText(record)}</Text>}
      <Text type="secondary" className={styles.meta}>{record.observedAt ? `${stale ? '已过期 · ' : ''}${dateText(record.observedAt)} 观测` : record.checkedAt ? `${dateText(record.checkedAt)} 检查` : '尚未刷新'}</Text>
    </>}
    {feedback && <Text role="status" type={feedback.error ? 'danger' : 'secondary'} className={styles.meta}>{feedback.text}</Text>}
  </section>;
}

function QuotaWindowRow({ window }: { window: QuotaWindow }) {
  const percent = quotaProgressPercent(window);
  const amount = window.unit === 'percent' ? `已用 ${quotaPercentText(window.usedPercent)}` : `剩余 ${quotaCountText(window.remaining, window.unit)} / ${quotaCountText(window.total, window.unit)}`;
  return <div className={styles.quotaWindow}>
    <div className={styles.spread}>
      <Text className={styles.meta}>{window.label}{window.scope === 'model' && window.model ? ` · ${window.model}` : ''}</Text>
      <Text className={`${styles.meta} ${styles.numbers}`}>{amount}</Text>
    </div>
    {percent !== null && <Progress size="small" percent={percent} showInfo={false} status={percent >= 100 ? 'exception' : undefined} aria-label={`${window.label} 已用比例`} />}
    {window.resetsAt && <Text type="secondary" className={styles.meta}>{dateText(window.resetsAt)} 重置</Text>}
  </div>;
}
