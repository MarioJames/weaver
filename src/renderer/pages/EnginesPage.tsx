import { NamedSwitch } from '../components/NamedControls';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, RefreshCw, ScanSearch } from 'lucide-react';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import { ActionIcon, Alert, Button, Input, Modal, Progress, Skeleton, Tag, Text, Tooltip } from '@lobehub/ui/base-ui';
import { ENGINE_CATALOG, catalogEntry, engineDisableConflict, type EngineProbeRecord } from '../../shared/engines';
import type { EngineQuotaRecord, QuotaEngine, QuotaWindow } from '../../shared/quota';
import { QUOTA_KINDS, quotaRefreshEnabled, type Block, type Engine } from '../../main/policy/routing';
import { acceptQuotaPolicy, dateText, quotaPercentText, quotaProgressPercent, quotaRecordStale, quotaRecoveryText, quotaRetryMs, quotaStatusText, quotaNextUpdateMs, quotaCountText } from '../quota-view';
import type { PolicyDraft, PolicyUpdate } from '../usePolicyDraft';
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

/** Quota observations live in the main process; reading them never calls a provider, so polling is cheap. */
function useQuota(policy: PolicyDraft) {
  const [records, setRecords] = useState<EngineQuotaRecord[]>([]);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<QuotaEngine | null>(null);
  const [feedback, setFeedback] = useState<{ engine: QuotaEngine; text: string; error: boolean }>();
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const load = useCallback(async () => {
    if (!window.weaver) { setLoadError('控制面不可用，请通过 weaver web 打开页面。'); return; }
    try {
      const result = await window.weaver.getQuota();
      if (mounted.current) { setRecords(result.records); setLoadError(''); setNow(Date.now()); }
    } catch (error) { if (mounted.current) setLoadError(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => void load(), 30_000);
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

export function EnginesPage({ policy }: { policy: PolicyDraft }) {
  const [probes, setProbes] = useState<EngineProbeRecord[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pausing, setPausing] = useState<string>();
  const quota = useQuota(policy);
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
    try { await policy.commit(update); } catch (error) { report(id, error); } finally { setBusyId(''); }
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
    <PageHeader title="引擎" description="本机已安装的 Agent CLI。这里的开关和暂停都立即生效。" action={<Button icon={ScanSearch} loading={scanning} onClick={() => void scan()}>重新探测</Button>} />
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
        return <Surface key={entry.id} aria-label={entry.id} className={styles.card} title={entry.id} description={<span className={styles.row} style={{ gap: 6 }}><Tag size="small" color={PROBE[status]?.color}>{PROBE[status]?.label ?? status}</Tag><Text type="secondary" className={styles.wrap}>{probe?.version || entry.command}</Text></span>}
          extra={<Tooltip title={blocked && reason ? reason : enabled ? '停用' : '启用'}><span><NamedSwitch aria-label={`启用 ${entry.id}`} checked={enabled} loading={busyId === entry.id} disabled={blocked} onChange={checked => void toggle(entry.id, checked)} /></span></Tooltip>}>
          <div className={styles.cardBody}>
            {isQuotaKind(kind) ? <QuotaSummary engine={kind} record={quota.records.find(item => item.engine === kind)} now={quota.now} busy={quota.busy} policyBusy={policy.busy} feedback={quota.feedback?.engine === kind ? quota.feedback : undefined} onRefresh={() => void quota.refresh(kind)} />
              : <Text type="secondary" className={styles.meta}>免费模型，不探测额度。</Text>}
            <BlockList blocks={engineBlocks} disabled={busyId !== '' || !record} onPause={() => setPausing(entry.id)} onRemove={block => void change(entry.id, doc => ({ ...doc, blocks: doc.blocks.filter(item => !(item.engine === block.engine && item.model === block.model)) }))} />
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
    <PauseDialog engine={pausing} onClose={() => setPausing(undefined)} onPause={async block => { await policy.commit(doc => ({ ...doc, blocks: [...doc.blocks.filter(item => !(item.engine === block.engine && item.model === undefined)), block] })); }} />
  </>;
}

function BlockList({ blocks, disabled, onPause, onRemove }: { blocks: Block[]; disabled: boolean; onPause: () => void; onRemove: (block: Block) => void }) {
  const now = Date.now();
  const active = blocks.filter(block => !block.release_at || Date.parse(block.release_at) > now);
  const engineLevel = active.some(block => block.model === undefined);
  return <section aria-label="派发限制" className={styles.tight}>
    {active.map(block => <div key={`${block.engine}:${block.model ?? ''}`} className={styles.spread} style={{ flexWrap: 'nowrap' }}>
      <span className={styles.tight}>
        <span className={styles.row} style={{ gap: 6 }}><Tag size="small" color="warning">{block.by?.startsWith('weaver-quota:') ? '额度耗尽' : '已暂停'}</Tag><Text className={styles.wrap}>{block.model ? `模型 ${block.model}` : '整台引擎'}</Text></span>
        <Text type="secondary" className={styles.meta}>{block.by?.startsWith('weaver-quota:') ? '额度恢复后自动解除' : block.reason}{block.release_at ? ` · ${dateText(block.release_at)} 恢复` : ' · 需手动恢复'}</Text>
      </span>
      <Tooltip title="恢复派发"><ActionIcon size="small" icon={Play} aria-label="恢复派发" disabled={disabled} onClick={() => onRemove(block)} /></Tooltip>
    </div>)}
    {!engineLevel && <Button size="small" icon={Pause} disabled={disabled} onClick={onPause}>暂停派发</Button>}
  </section>;
}

function PauseDialog({ engine, onClose, onPause }: { engine?: string; onClose: () => void; onPause: (block: Block) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (engine) { setReason(''); setUntil(''); setError(''); } }, [engine]);
  const releaseAt = until ? new Date(until) : undefined;
  const invalid = releaseAt !== undefined && (!Number.isFinite(releaseAt.getTime()) || releaseAt.getTime() <= Date.now());
  async function submit() {
    if (!engine || busy || invalid) return;
    setBusy(true); setError('');
    try {
      await onPause({ engine, reason: reason.trim() || '手动暂停', since: new Date().toISOString(), ...(releaseAt ? { release_at: releaseAt.toISOString() } : {}) });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <Modal open={engine !== undefined} title={`暂停派发 ${engine ?? ''}`} okText="暂停" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: invalid }} onCancel={() => { if (!busy) onClose(); }} onOk={() => void submit()}>
    <div className={styles.stack}>
      <Text type="secondary">暂停期间不会把新任务派给这个引擎，已在运行的任务不受影响。</Text>
      <label className={styles.tight}><Text>原因</Text><Input aria-label="暂停原因" value={reason} placeholder="例如：额度紧张，先让给其他引擎" onChange={event => setReason(event.target.value)} /></label>
      <label className={styles.tight}><Text>恢复时间</Text><Input aria-label="恢复时间" type="datetime-local" value={until} onChange={event => setUntil(event.target.value)} /><Text type={invalid ? 'danger' : 'secondary'} className={styles.meta}>{invalid ? '恢复时间需要晚于现在。' : '留空表示需要手动恢复。'}</Text></label>
      {error && <Text role="alert" type="danger">{error}</Text>}
    </div>
  </Modal>;
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
