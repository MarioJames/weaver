import { NamedInputNumber } from '../../ui/NamedControls';
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { ActionIcon, Button, DropdownMenu, Tag, Text } from '@lobehub/ui/base-ui';
import { Form } from '@lobehub/ui/base-ui/form';
import { activeBlocks, availabilityOf, manualPauseOf } from '../../../shared/policy/availability';
import { type Block, type Config, type Owner } from '../../../shared/contracts/policy';
import { blockOf, blockText, pauseOfBlock } from '../probes/probe-view';
import { DEFAULT_WEIGHT, WEIGHT_MAX, appendWorker, withWorkerWeight, withoutListedWorker, workerParallelText, workerWeight } from '../../policy/policy-edit';
import { statusTagColor, tagColor } from '../../format/tag-colors';
import { FreeChannelTag } from '../../ui/FreeChannelTag';
import { styles } from '../../ui/styles';
import { scheduleStyles } from './owner-schedule-style';

/**
 * Why this worker's weight cannot be edited. A disabled worker or engine is never dispatched, and neither is a worker
 * kept out by an exhausted quota or by any block without a release time: nobody lifts those but the user, so the saved
 * weight stays as it is and applies again once dispatch is resumed. Blocks that lift themselves (a rate limit with its
 * release time, a stall penalty, a probe's ban) do not lock editing.
 */
export function workerWeightLock(config: Config, workerId: string, blocks: Block[] = [], now: number = Date.now()): { label: string; hint: string; paused?: true } | undefined {
  const worker = config.workers[workerId];
  if (!worker) return undefined;
  if (!worker.enabled) return { label: '子 Agent 已停用', hint: '该子 Agent 已在「子 Agent」页停用，权重保持不变，重新启用后继续生效。' };
  if (!config.engines[worker.engine]?.enabled) return { label: '引擎已停用', hint: `引擎 ${worker.engine} 已停用，权重保持不变，重新启用后继续生效。` };
  const pause = manualPauseOf(config, blocks, workerId, now);
  if (!pause) return undefined;
  const reason = pause.block.reason.replace(/\s+/g, ' ').trim() || '未说明原因';
  const recovery = `没有自动解除时间；在引擎页或子 Agent 页点「恢复派发」，恢复后权重继续生效，已保存的权重保持不变。`;
  return pause.kind === 'quota'
    ? { label: '额度耗尽', hint: `${reason}。额度耗尽后${recovery}`, paused: true }
    : { label: '已暂停 · 需手动恢复', hint: `${reason}。该暂停${recovery}`, paused: true };
}

/** Why dispatch would skip this worker right now, as a short tag. Colors come from the shared semantic scheme in format/tag-colors. */
export function workerStatusTag(config: Config, blocks: Block[], workerId: string, weight: number): { label: string; color?: string; hint?: string; reason?: string } | undefined {
  const worker = config.workers[workerId];
  if (!worker) return { label: '引用不存在', color: tagColor('error') };
  const lock = workerWeightLock(config, workerId, blocks);
  if (lock) return lock.paused ? { label: lock.label, hint: lock.hint, color: statusTagColor('warning') } : lock;
  if (weight === 0) return { label: '不派发' };
  const availability = availabilityOf(config, activeBlocks({ version: 1, blocks }, Date.now()), worker, workerId);
  if (availability.status !== 'blocked') return undefined;
  // A pause written by the penalty ladders or the free probe says what kind it is; any other block stays a plain restriction.
  const hit = blockOf(blocks, worker, Date.now(), workerId);
  const pause = pauseOfBlock(hit);
  const reason = hit ? blockText(hit) : availability.reason;
  return { label: pause?.label ?? '已限制', color: statusTagColor(pause?.tone ?? 'warning'), hint: reason, reason };
}

const PRESETS = [{ label: '不派发', value: 0 }, { label: '默认', value: DEFAULT_WEIGHT }, { label: '最高', value: WEIGHT_MAX }];

export function OwnerScheduleFields({ config, blocks, record, savedRecord, update }: { config: Config; blocks: Block[]; record: Owner; savedRecord?: Owner; update: (next: Owner) => void }) {
  const available = Object.keys(config.workers).filter(id => !record.workers.includes(id));
  const [initialRecord] = useState(record);
  // Re-sort only when saved values change. Draft additions follow the existing rows.
  const baseline = savedRecord ?? initialRecord;
  const savedOrder = [...baseline.workers].sort((a, b) => workerWeight(baseline, b) - workerWeight(baseline, a));
  const ids = [...savedOrder.filter(id => record.workers.includes(id)), ...record.workers.filter(id => !savedOrder.includes(id))];
  const ordered = ids.map(id => ({ id, weight: workerWeight(record, id) }));
  // A titled section rather than a Form.Field: the add button sits beside the title, and a label element would forward clicks on the title to it.
  return <section aria-label="子 Agent" className={styles.tight}>
    <div className={styles.spread} style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
      <Form.Title title="子 Agent" desc="派发按权重分摊：空闲时先给权重高的，并发时按权重比例分配到各子 Agent；跳过停用或受限的子 Agent。权重为 0–10 的整数，默认 5；0 表示不派给它。" />
      <DropdownMenu placement="bottomRight" items={available.length ? available.map(id => ({ key: id, label: id, desc: [config.workers[id]?.engine, config.workers[id]?.model].filter(Boolean).join(' · '), onClick: () => { const next = appendWorker(record.workers, available, id); if (next) update({ ...record, workers: next }); } })) : [{ key: 'none', label: '没有可添加的子 Agent', disabled: true }]}>
        <Button size="small" icon={Plus}>添加子 Agent</Button>
      </DropdownMenu>
    </div>
    <div className={styles.stack}>
      <div className={`${scheduleStyles.listRows} ${scheduleStyles.list}`}>
        <div className={scheduleStyles.columns}><Text className={scheduleStyles.heading}>权重</Text></div>
        {ordered.map(({ id, weight }) => {
        const status = workerStatusTag(config, blocks, id, weight);
        const locked = workerWeightLock(config, id, blocks) !== undefined;
        return <div key={id} data-locked={locked || undefined} className={`${scheduleStyles.listRow} ${scheduleStyles.row}`}>
          <span className={`${styles.row} ${scheduleStyles.name}`} style={{ minInlineSize: 0 }}><Text className={styles.wrap} type={locked ? 'secondary' : undefined}>{id}</Text>{config.workers[id]?.free_channel && <FreeChannelTag />}{workerParallelText(config.workers[id]) && <Tag size="small" color={tagColor('neutral')} title="该子 Agent 同时运行的任务数上限，超出的任务排队">{workerParallelText(config.workers[id])}</Tag>}{status && <Tag size="small" color={status.color} title={status.hint}>{status.label}</Tag>}{status?.reason && <span className={scheduleStyles.reason} title={status.reason}>{status.reason}</span>}</span>
          <span className={scheduleStyles.controls}>
            <NamedInputNumber aria-label={`${id} 的权重`} size="small" disabled={locked} min={0} max={WEIGHT_MAX} step={1} precision={0} value={weight} style={{ inlineSize: 72 }} onChange={value => update(withWorkerWeight(record, id, typeof value === 'number' ? value : DEFAULT_WEIGHT))} />
            <span role="group" aria-label={`${id} 权重预设`} className={scheduleStyles.presets} data-locked={locked || undefined}>{PRESETS.map(preset => <Button key={preset.value} size="small" type="text" disabled={locked} aria-pressed={weight === preset.value} aria-label={`${id} ${preset.label}`} onClick={() => update(withWorkerWeight(record, id, preset.value))}>{preset.label}</Button>)}</span>
            <ActionIcon size="small" icon={X} aria-label={`移除 ${id}`} onClick={() => update(withoutListedWorker(record, id))} />
          </span>
        </div>;
      })}</div>
      {!record.workers.length && <Text type="danger">还没有子 Agent。启用的父 Agent 至少需要一个可用的子 Agent。</Text>}
    </div>
  </section>;
}
