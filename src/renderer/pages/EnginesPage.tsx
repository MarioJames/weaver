import { HelloCheck } from './RolesPage';
import { notifyError, useNotifyError } from '../notify';
import { NamedSwitch } from '../components/NamedControls';
import { ModelPicker } from '../components/ModelPicker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RefreshCw, ScanSearch } from 'lucide-react';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import { ActionIcon, Button, Input, Progress, Skeleton, Tag, Text, Tooltip } from '@lobehub/ui/base-ui';
import { ENGINE_CATALOG, catalogEntry, engineDisableConflict, type EngineProbeRecord } from '../../shared/engines';
import type { EngineQuotaRecord, QuotaEngine, QuotaWindow } from '../../shared/quota';
import { QUOTA_KINDS, quotaRefreshEnabled, type Block, type Engine } from '../../main/policy/routing';
import { acceptQuotaPolicy, dateText, quotaPercentText, quotaProgressPercent, quotaRecordStale, quotaRecoveryText, quotaRetryMs, quotaStatusText, quotaNextUpdateMs, quotaCountText, quotaVisibleWindows, quotaThirdParty } from '../quota-view';
import type { PolicyDraft, PolicyUpdate } from '../usePolicyDraft';
import type { RendererAPI, StallEngineState, StallHistoryEntry, StallSnapshot } from '../client';
import { styles } from '../style';
import { TimeText } from '../components/TimeText';
import { compactTime } from '../timezone';
import { createStaticStyles } from 'antd-style';
import type { StatusTone } from '../status-colors';

const blockStyles = createStaticStyles(({ css, cssVar }) => ({
  row: css`display: flex; align-items: center; gap: 8px; min-width: 0; color: ${cssVar.colorTextSecondary}; font-size: ${cssVar.fontSizeSM}; > :not([data-block-reason]) { flex-shrink: 0; }`,
  reason: css`flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`,
}));

export function engineVersionText(version: string): string {
  return version.trim().replace(/\s+\([a-f\d]{7,40}\)$/i, '');
}

const engineStyles = createStaticStyles(({ css, cssVar }) => ({
  cards: css`display: grid; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); align-items: start; gap: 16px; min-inline-size: 0;`,
  enable: css`display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-inline-size: 0; max-inline-size: 190px; > :last-child { flex-shrink: 0; }`,
  version: css`white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-inline-size: 0;`,
  switchReason: css`color: ${cssVar.colorTextSecondary}; font-size: ${cssVar.fontSizeSM}; min-inline-size: 0; overflow: hidden; text-align: end; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;`,
}));

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
type EngineBlockState = StallEngineState & { blockedUntil?: string | null };
const STALL_BY = 'weaver-stall';
const STALL_HISTORY = 5;
const STALL_TASK_ID = 8;

/** Quota observations live in the main process; reading them never calls a provider, so polling is cheap. */
function useQuota(policy: PolicyDraft, onTick?: () => void) {
  const [records, setRecords] = useState<EngineQuotaRecord[]>([]);
  const [busy, setBusy] = useState<QuotaEngine | null>(null);
  const [feedback, setFeedback] = useState<{ engine: QuotaEngine; text: string; error: boolean }>();
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const tick = useRef(onTick);
  tick.current = onTick;
  const load = useCallback(async () => {
    if (!window.weaver) { notifyError('控制面不可用，请通过 weaver web 打开页面。'); return; }
    try {
      const result = await window.weaver.getQuota();
      if (mounted.current) { setRecords(result.records); setNow(Date.now()); }
    } catch (error) { if (mounted.current) notifyError(error, '额度读取失败'); }
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
      if (mounted.current) notifyError(error, '刷新失败');
    } finally { if (mounted.current) setBusy(null); }
  }
  return { records, busy, feedback, now, refresh, load };
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

export function StallNotice({ state }: { state?: StallEngineState; block?: Block; now: number }) {
  if (!state) return null;
  const history = state.history.slice(-STALL_HISTORY);
  if (!state.needsAttention && !history.length) return null;
  return <section aria-label="惩罚暂停" className={styles.tight}>
    {(history.length > 0 || state.needsAttention) && <details className={styles.stallHistory}>
      <summary>记录</summary>
      {state.needsAttention && <Text type="secondary" className={styles.meta}>{stallAttentionText(state)}</Text>}
      {history.map((entry, index) => <Text key={`${entry.at}:${entry.level}:${index}`} type="secondary" className={styles.meta}>{stallHistoryText(entry)}</Text>)}
    </details>}
  </section>;
}

export function EnginesPage({ policy }: { policy: PolicyDraft }) {
  const [probes, setProbes] = useState<EngineProbeRecord[]>([]);
  const [scanning, setScanning] = useState(false);
  useNotifyError(policy.loadError, '配置读取失败');
  const [busyId, setBusyId] = useState('');
  const stall = useStall();
  const quota = useQuota(policy, stall.load);
  const scan = useCallback(async () => {
    if (!window.weaver) { notifyError('控制面不可用，请通过 weaver web 打开页面。'); return; }
    setScanning(true);
    try { setProbes((await window.weaver.scanEngines()).probes); }
    catch (error) { notifyError(error, '引擎探测失败'); }
    finally { setScanning(false); }
  }, []);
  useEffect(() => { void scan(); }, [scan]);
  const report = (_id: string, error?: unknown) => { if(error !== undefined) notifyError(error, '操作失败'); };
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
    {!saved && policy.loading && <Skeleton.Text animated rows={6} />}
    {saved && <div className={engineStyles.cards}>
      {ENGINE_CATALOG.map(entry => {
        const probe = probes.find(item => item.id === entry.id);
        const record = saved.engines[entry.id];
        const status = probe?.status ?? (scanning ? 'loading' : 'unknown');
        const kindMismatch = Boolean(record && record.kind !== entry.kind);
        const enabled = record?.enabled === true;
        const conflict = engineDisableConflict(saved, entry.id);
        const blocked = busyId !== '' || (enabled ? Boolean(conflict) : probe?.status !== 'installed' || kindMismatch);
        const roles = [Object.values(saved.owners).some(owner => owner.enabled && owner.engine === entry.id) ? '父 Agent' : '', Object.values(saved.workers).some(worker => worker.enabled && worker.engine === entry.id) ? '子 Agent' : ''].filter(Boolean);
        const reason = enabled && conflict ? `仍启用的${roles.join(' / ')}，请先停用。` : !enabled && probe?.status !== 'installed' ? '未在本机找到这个命令' : kindMismatch ? '已保存的类型与目录不一致' : '';
        const kind = record?.kind ?? entry.kind;
        const engineBlocks = savedBlocks.filter(block => block.engine === entry.id);
        return <Surface key={entry.id} aria-label={entry.id} title={entry.id} description={<span className={styles.row} style={{ gap: 6, flexWrap: 'nowrap' }}><Tag size="small" color={PROBE[status]?.color}>{PROBE[status]?.label ?? status}</Tag><Tooltip title={probe?.version || entry.command}><Text type="secondary" className={engineStyles.version}>{engineVersionText(probe?.version || entry.command)}</Text></Tooltip></span>}
          extra={<div className={engineStyles.enable}>{blocked && reason && <Tooltip title={reason}><Text type="secondary" data-switch-reason={entry.id} className={engineStyles.switchReason}>{reason}</Text></Tooltip>}<NamedSwitch aria-label={`启用 ${entry.id}`} size="small" checked={enabled} loading={busyId === entry.id} disabled={blocked} onChange={checked => void toggle(entry.id, checked)} /></div>}>
          <div className={styles.cardBody}>
            <StallNotice state={stall.snapshot?.engines[entry.id]} now={stall.now} />
            {isQuotaKind(kind) ? <QuotaSummary engine={kind} record={quota.records.find(item => item.engine === kind)} now={quota.now} busy={quota.busy} policyBusy={policy.busy} feedback={quota.feedback?.engine === kind ? quota.feedback : undefined} onRefresh={() => void quota.refresh(kind)} />
              : <Text type="secondary" className={styles.meta}>未提供原生额度接口。</Text>}
            {(record || status === 'installed') && <EngineModelProbe id={entry.id} />}
            <BlockList blocks={engineBlocks} state={stall.snapshot?.engines[entry.id]} now={stall.now} disabled={busyId !== '' || !record} onRemove={block => void change(entry.id, doc => ({ ...doc, blocks: doc.blocks.filter(item => !(item.engine === block.engine && item.model === block.model)) }))} />
            <div className={styles.cardFoot}>
              <div className={styles.spread}>
                <Text>主动刷新额度</Text>
                <Tooltip title={isQuotaKind(kind) ? '按设置页的间隔自动刷新；额度耗尽时自动暂停派发，恢复后自动解除。' : '这个引擎没有额度接口。'}>
                  <span><NamedSwitch aria-label={`${entry.id} 主动刷新额度`} size="small" checked={record ? quotaRefreshEnabled(record) : false} disabled={!record || !isQuotaKind(kind) || busyId !== ''} onChange={checked => void setEngine(entry.id, { quota_refresh: checked })} /></span>
                </Tooltip>
              </div>
              {probe?.detail && status !== 'installed' && <Text type="secondary" className={`${styles.meta} ${styles.wrap}`}>{probe.detail}</Text>}
            </div>
          </div>
        </Surface>;
      })}
      {unsupported.map(([id, record]) => <Surface key={id} aria-label={id} title={id} description={<Tag size="small">暂不支持探测</Tag>}>
        <Text type="secondary" className={styles.wrap}>类型 {record.kind}。这条记录原样保留，不能在这里启用。{record.enabled ? '当前为启用状态。' : ''}</Text>
      </Surface>)}
    </div>}
  </>;
}

/** One category, one bounded reason and one explicit recovery condition for every pause. */
export function engineBlockText(block: Block, now: number, state?: EngineBlockState) {
  const stall = block.by === STALL_BY;
  const category = stall ? `卡住惩罚${state?.level ? ` 第 ${state.level} 级` : ''}`
    : block.by?.startsWith('weaver-quota:') ? '额度耗尽'
    : block.by === 'weaver-vendor-limit' ? /^(?:额度耗尽|quota)|FreeUsageLimitError|GoUsageLimitError/i.test(block.reason) ? '额度耗尽' : '限流'
    : '手动暂停';
  const fullReason = block.reason.replace(/\s+/g, ' ').trim();
  const plain = fullReason.replace(/^(?:限流|额度耗尽)：\s*/, '');
  const reason = plain.length > 120 ? `${plain.slice(0,119)}…` : plain;
  const deadline = block.release_at ?? (stall && state?.level && state.level <= 2 ? state.blockedUntil : undefined);
  const time = deadline ? Date.parse(deadline) : NaN;
  let release = '需手动恢复';
  if (Number.isFinite(time) && time > now) {
    release = `${compactTime(time, now)} 自动解除`;
  } else if (stall && state && state.level >= 1 && state.level <= 2) release = '探测通过后解除';
  const tone: StatusTone = category === '手动暂停' ? 'default' : 'warning';
  return { category, reason, fullReason, release, tone };
}

export function BlockList({ blocks, disabled, onRemove, now = Date.now(), state }: { blocks: Block[]; disabled: boolean; onRemove: (block: Block) => void; now?: number; state?: EngineBlockState }) {
  const active = blocks.filter(block => block.by === STALL_BY || !block.release_at || Date.parse(block.release_at) > now);
  if (!active.length) return null;
  return <section aria-label="派发限制" className={styles.tight}>
    {active.map(block => {
      const text = engineBlockText(block, now, state);
      return <div key={`${block.engine}:${block.model ?? ''}`} data-engine-block={block.engine} className={blockStyles.row}>
        <Tag size="small" color={text.tone}>{text.category}</Tag>
        <Tooltip title={text.fullReason}><span data-block-reason className={blockStyles.reason}>{block.model ? `${block.model} · ` : ''}{text.reason}</span></Tooltip>
        <span>{text.release}</span>
        <Tooltip title="恢复派发"><ActionIcon size="small" icon={Play} aria-label="恢复派发" disabled={disabled} onClick={() => onRemove(block)} /></Tooltip>
      </div>;
    })}
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
      {quotaVisibleWindows(record).map(window => <QuotaWindowRow key={window.id} window={window} />)}
      {!record.windows.length && record.status !== 'unknown' && <Text type="secondary" className={styles.meta}>{record.detail}</Text>}
      {quotaRecoveryText(record) && record.status !== 'unknown' && <Text type="secondary" className={styles.meta}>{quotaRecoveryText(record)}</Text>}
      <Text type="secondary" className={styles.meta}>{record.observedAt ? <>{stale ? '已过期 · ' : ''}<TimeText value={record.observedAt} now={now} /> 观测</> : record.checkedAt ? <><TimeText value={record.checkedAt} now={now} /> 检查</> : '尚未刷新'}</Text>
    </>}
    {feedback && !feedback.error && !(record && quotaThirdParty(record)) && <Text role="status" type={feedback.error ? 'danger' : 'secondary'} className={styles.meta}>{feedback.text}</Text>}
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
    {window.resetsAt && <Text type="secondary" className={styles.meta}><TimeText value={window.resetsAt} /> 重置</Text>}
  </div>;
}

function EngineModelProbe({ id }: { id: string }) {
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState(id === 'zcode' ? 'auto' : 'high');
  return <details><summary>模型探测</summary><div className={styles.tight}>
    <ModelPicker engine={id} value={model} label={`${id} 探测模型`} onChange={setModel} placeholder="例如：provider/model" />
    <Input aria-label={`${id} 探测强度`} value={effort} placeholder="例如：high" onChange={event => setEffort(event.target.value)} />
    <HelloCheck id={`engine:${id}`} record={{ engine: id, model, effort }} />
  </div></details>;
}
