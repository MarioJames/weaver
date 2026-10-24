import type { FreeChannelStatus, FreeWorkerStatus } from '../../../shared/contracts/monitoring';
import { activeBlocks, coveringBlock } from '../../../shared/policy/availability';
import { FREE_PROBE_BLOCK_BY, STALL_BLOCK_BY, VENDOR_BLOCK_BY } from '../../../shared/policy/blocks';
import { type Block, type Config, type Owner, type Worker } from '../../../shared/contracts/policy';
import { dateText } from '../quota/quota-view';
import type { StatusTone } from '../../format/status-colors';

/** Consecutive passing probes that lift a top-level stall penalty (same value as the monitor). */
export const PROBE_PASSES_NEEDED = 3;
/** How many probes the panel lists, newest first. */
export const PROBE_HISTORY_SHOWN = 5;

export type ProbeHistoryRecord = FreeWorkerStatus['history'][number];

/** The pause a block puts on a route, as a status tag. Only blocks written by the penalty ladders and the free probe are named; anything else stays a plain restriction. */
export function pauseOfBlock(block: Pick<Block, 'by'> | undefined): { label: string; tone: StatusTone } | undefined {
  if (block?.by === FREE_PROBE_BLOCK_BY) return { label: '免费额度用完', tone: 'orange' };
  if (block?.by === STALL_BLOCK_BY || block?.by === VENDOR_BLOCK_BY) return { label: '暂时不可用', tone: 'warning' };
  return undefined;
}

/** The active block that keeps one worker or owner out, found the way the router finds it. Pass the worker's policy key for a worker: a worker-scoped block reaches only the worker it names, never an owner or a sibling. */
export function blockOf(blocks: Block[], entity: Owner | Worker, now: number, workerId: string | undefined, config: Config): Block | undefined {
  return coveringBlock(activeBlocks({ version: 1, blocks }, now), entity, workerId, config);
}

/** Reason plus the recovery time when the block names one: the same line in tag hints and list notes. */
export function blockText(block: Pick<Block, 'reason' | 'release_at'>): string {
  return `${block.reason || '未说明原因'}${block.release_at ? `，${dateText(block.release_at)} 恢复` : ''}`;
}

export type ProbeStateKey = 'idle' | 'never' | 'healthy' | 'temporary' | 'quota' | 'attention' | 'restricted';
export interface ProbeStateView { key: ProbeStateKey; label: string; tone: StatusTone; detail?: string }

/** One worker's state as a person reads it: a tag and one explanatory line. Order matters: the open question outranks everything else. */
export function probeStateView(status: FreeWorkerStatus | undefined): ProbeStateView {
  if (!status) return { key: 'idle', label: '未参与探测', tone: 'default', detail: '启用该子 Agent、渠道及其引擎并保存后，才会定时探测。' };
  if (!status.probed) return { key: 'idle', label: '未参与探测', tone: 'default', detail: '该子 Agent、渠道或其引擎已停用，不会探测。' };
  if (status.mode === 'quota') {
    const release = status.availability.release_at ?? status.blockedUntil;
    return { key: 'quota', label: '免费额度用完', tone: 'orange', detail: release ? `预计 ${dateText(release)} 恢复` : '等待探测成功后恢复' };
  }
  if (status.needsAttention) {
    const passed = status.probeSuccesses > 0 ? `，已连续成功 ${status.probeSuccesses}/${PROBE_PASSES_NEEDED} 次` : '';
    return { key: 'attention', label: '需要人工处理', tone: 'error', detail: `连续探测失败，已暂停派发；连续成功 ${PROBE_PASSES_NEEDED} 次后自动恢复${passed}。` };
  }
  if (status.mode === 'stall' || status.mode === 'rate_limit') {
    const kind = status.mode === 'stall' ? '惩罚' : '限流';
    const wait = status.availability.release_at ?? status.blockedUntil;
    return { key: 'temporary', label: `暂时不可用 · ${kind}第 ${status.level} 级`, tone: 'warning', detail: wait ? `将于 ${dateText(wait)} 再次探测` : '等待探测成功后恢复' };
  }
  if (status.availability.status === 'blocked') return { key: 'restricted', label: '已限制', tone: 'warning', detail: '该路线被其他来源暂停，探测不会解除它。' };
  if (!status.history.length) return { key: 'never', label: '从未探测', tone: 'default', detail: '可立即探测一次。' };
  return { key: 'healthy', label: '正常', tone: 'success' };
}

/** `850 毫秒` / `3.2 秒`: a probe is a round trip, not a stopwatch. */
export function probeDurationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '耗时未知';
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

/** The most recent probe record of a worker; history is stored oldest first. */
export function lastProbeOf(status: FreeWorkerStatus | undefined): ProbeHistoryRecord | undefined {
  return status?.history.at(-1);
}

/** Latest records, newest first. */
export function recentProbes(status: FreeWorkerStatus | undefined, limit: number = PROBE_HISTORY_SHOWN): ProbeHistoryRecord[] {
  return status ? status.history.slice(-limit).reverse() : [];
}

/** What a history line says beyond its outcome: the bounded error, then what the answer did to the policy. */
export function probeNoteText(record: ProbeHistoryRecord): string {
  return [record.probe.error, record.message].filter((part): part is string => !!part).join(' · ');
}

/** When the worker is probed next: its own recovery deadline, else the next scheduled round. */
export function nextProbeText(status: FreeWorkerStatus | undefined, schedule: FreeChannelStatus['schedule'] | undefined): string {
  if (!status?.probed) return '不参与探测';
  if (status.nextProbeAt) return dateText(status.nextProbeAt);
  if (schedule && !schedule.enabled) return '定时探测已关闭';
  return schedule?.nextRunAt ? dateText(schedule.nextRunAt) : '待定';
}

/** Settings: when the scheduled round last ran and runs next. */
export function probeScheduleText(schedule: FreeChannelStatus['schedule'] | undefined, enabled: boolean): string {
  if (!enabled) return '已关闭，只能在子 Agent 页手动探测。';
  if (!schedule?.nextRunAt) return '按下方间隔向免费渠道子 Agent 发送简短问候，会消耗少量额度。';
  return `下次 ${dateText(schedule.nextRunAt)} · ${schedule.lastRunAt ? `上次 ${dateText(schedule.lastRunAt)}` : '尚未运行'}`;
}
