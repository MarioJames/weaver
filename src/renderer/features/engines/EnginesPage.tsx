import { EngineCleanup } from './EngineCleanup';
import { notifyError, useNotifyError } from '../../api/notify';
import { NamedSwitch } from '../../ui/NamedControls';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, ScanSearch } from 'lucide-react';
import { PageHeader, Surface } from '@lobehub/ui/dashboard';
import { Button, Skeleton, Tag, Text, Tooltip } from '@lobehub/ui/base-ui';
import { ENGINE_CATALOG, catalogEntry, type EngineProbeRecord } from '../../../shared/engines';
import { STALL_BLOCK_BY, VENDOR_BLOCK_BY, isQuotaBlock } from '../../../shared/policy/blocks';
import { type Block } from '../../../shared/contracts/policy';
import { dateText } from '../quota/quota-view';
import type { PolicyDraft, PolicyUpdate } from '../../policy/usePolicyDraft';
import { resumeWorker } from '../../policy/worker-resume';
import type { StallEngineState, StallHistoryEntry, StallSnapshot } from '../../api/client';
import type { EngineStallStatus } from '../../../shared/contracts/monitoring';
import { styles } from '../../ui/styles';
import { engineStyles } from './engines-style';
import { compactTime } from '../../format/timezone';
import { createStaticStyles } from 'antd-style';
import type { StatusTone } from '../../format/status-colors';
import { statusTagColor, tagColor } from '../../format/tag-colors';

const blockStyles = createStaticStyles(({ css, cssVar }) => ({
  row: css`display: flex; align-items: center; gap: 8px; min-width: 0; color: ${cssVar.colorTextSecondary}; font-size: ${cssVar.fontSizeSM}; > :not([data-block-reason]) { flex-shrink: 0; }`,
  reason: css`flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`,
}));

export function engineVersionText(version: string): string {
  return version.trim().replace(/\s+\([a-f\d]{7,40}\)$/i, '');
}

const PROBE: Record<string, { label: string; color?: string }> = {
  installed: { label: '已安装', color: tagColor('success') },
  missing: { label: '未找到', color: tagColor('neutral') },
  probe_failed: { label: '探测失败', color: tagColor('error') },
  loading: { label: '正在探测', color: tagColor('inProgress') },
  unknown: { label: '尚未探测', color: tagColor('neutral') },
};

function mergeProbes(current: EngineProbeRecord[], probe: EngineProbeRecord | null): EngineProbeRecord[] {
  const next = probe ? [...current.filter(item => item.id !== probe.id), probe] : current;
  return ENGINE_CATALOG.map(entry => next.find(item => item.id === entry.id)).filter((item): item is EngineProbeRecord => Boolean(item));
}

/** Penalty blocks are ordinary policy blocks; this `by` value is what tells them apart from a quota or manual pause. */
type EngineBlockState = StallEngineState & Partial<Pick<EngineStallStatus, 'blockedUntil'>>;
const STALL_HISTORY = 5;
const STALL_TASK_ID = 8;

/** The penalty ladder snapshot; when the read fails nothing is shown. */
function useStall() {
  const [snapshot, setSnapshot] = useState<StallSnapshot>();
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    try {
      const result = await window.weaver.getStall();
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
    {(history.length > 0 || state.needsAttention) && <details className={engineStyles.stallHistory}>
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
  useEffect(() => { void stall.load(); }, [stall.load]);
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
  /** A worker's own ban is lifted by the server (with what depends on it); a whole-engine or model ban is removed from the policy as before. */
  async function resume(id: string, block: Block) {
    if (!block.worker) { await change(id, doc => ({ ...doc, blocks: removeBlock(doc.blocks, block) })); return; }
    if (busyId) return;
    setBusyId(id);
    try { if (await resumeWorker(block.worker, policy)) void stall.load(); }
    finally { setBusyId(''); }
  }
  const saved = policy.snapshot?.config;
  const savedBlocks = policy.snapshot?.blocks ?? [];
  const unsupported = Object.entries(saved?.engines ?? {}).filter(([id]) => !catalogEntry(id));
  return <>
    <PageHeader title="引擎" description="本机已安装的 Agent CLI。这里的开关立即生效；账号、API 配置与额度在「账号与渠道」管理。" action={<Button icon={ScanSearch} loading={scanning} onClick={() => void scan()}>重新探测</Button>} />
    {!saved && policy.loading && <Skeleton.Text animated rows={6} />}
    {saved && <div className={engineStyles.cards}>
      {ENGINE_CATALOG.map(entry => {
        const probe = probes.find(item => item.id === entry.id);
        const record = saved.engines[entry.id];
        const status = probe?.status ?? (scanning ? 'loading' : 'unknown');
        const kindMismatch = Boolean(record && record.kind !== entry.kind);
        const enabled = record?.enabled === true;
        const blocked = busyId !== '' || (!enabled && (probe?.status !== 'installed' || kindMismatch));
        const reason = !enabled && probe?.status !== 'installed' ? '未在本机找到这个命令' : kindMismatch ? '已保存的类型与目录不一致' : '';
        const engineBlocks = savedBlocks.filter(block => block.engine === entry.id && !block.channel && !isQuotaBlock(block));
        return <Surface key={entry.id} aria-label={entry.id} title={entry.id} description={<span className={styles.row} style={{ gap: 6, flexWrap: 'nowrap' }}><Tag size="small" color={PROBE[status]?.color}>{PROBE[status]?.label ?? status}</Tag><Tooltip title={probe?.version || entry.command}><Text type="secondary" className={engineStyles.version}>{engineVersionText(probe?.version || entry.command)}</Text></Tooltip></span>}
          extra={<div className={engineStyles.enable}>{blocked && reason && <Tooltip title={reason}><Text type="secondary" data-switch-reason={entry.id} className={engineStyles.switchReason}>{reason}</Text></Tooltip>}<NamedSwitch aria-label={`启用 ${entry.id}`} size="small" checked={enabled} loading={busyId === entry.id} disabled={blocked} onChange={checked => void toggle(entry.id, checked)} /></div>}>
          <div className={engineStyles.cardBody}>
            <StallNotice state={stall.snapshot?.engines[entry.id]} now={stall.now} />
            <BlockList blocks={engineBlocks} state={stall.snapshot?.engines[entry.id]} now={stall.now} disabled={busyId !== '' || !record} onRemove={block => void resume(entry.id, block)} />
            {entry.id === 'opencode' && <EngineCleanup />}
            <div className={engineStyles.cardFoot}>
              {probe?.detail && status !== 'installed' && <Text type="secondary" className={`${styles.meta} ${styles.wrap}`}>{probe.detail}</Text>}
            </div>
          </div>
        </Surface>;
      })}
      {unsupported.map(([id, record]) => <Surface key={id} aria-label={id} title={id} description={<Tag size="small" color={tagColor('neutral')}>暂不支持探测</Tag>}>
        <Text type="secondary" className={styles.wrap}>类型 {record.kind}。这条记录原样保留，不能在这里启用。{record.enabled ? '当前为启用状态。' : ''}</Text>
      </Surface>)}
    </div>}
  </>;
}

/** One category, one bounded reason and one explicit recovery condition for every pause. */
export function engineBlockText(block: Block, now: number, state?: EngineBlockState) {
  const stall = block.by === STALL_BLOCK_BY;
  const category = stall ? `卡住惩罚${state?.level ? ` 第 ${state.level} 级` : ''}`
    : isQuotaBlock(block) ? '额度耗尽'
    : block.by === VENDOR_BLOCK_BY ? '限流'
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

/** Resume dispatch removes exactly one block: the one with the same engine, model and worker. Whole-engine, model and worker blocks of one engine are separate bans. */
export function removeBlock(blocks: Block[], target: Block): Block[] {
  return blocks.filter(item => !(item.engine === target.engine && item.channel === target.channel && item.model === target.model && item.worker === target.worker));
}

export function BlockList({ blocks, disabled, onRemove, now = Date.now(), state }: { blocks: Block[]; disabled: boolean; onRemove: (block: Block) => void; now?: number; state?: EngineBlockState }) {
  const active = blocks.filter(block => block.by === STALL_BLOCK_BY || !block.release_at || Date.parse(block.release_at) > now);
  if (!active.length) return null;
  return <section aria-label="派发限制" className={styles.tight}>
    {active.map(block => {
      const text = engineBlockText(block, now, state);
      return <div key={`${block.engine}:${block.model ?? ''}:${block.worker ?? ''}`} data-engine-block={block.engine} className={blockStyles.row}>
        <Tag size="small" color={statusTagColor(text.tone)}>{text.category}</Tag>
        <Tooltip title={text.fullReason}><span data-block-reason className={blockStyles.reason}>{block.worker ? `${block.worker} · ` : ''}{block.model ? `${block.model} · ` : ''}{text.reason}</span></Tooltip>
        <span>{text.release}</span>
        <Button size="small" icon={Play} aria-label="恢复派发" disabled={disabled} onClick={() => onRemove(block)}>恢复派发</Button>
      </div>;
    })}
  </section>;
}
