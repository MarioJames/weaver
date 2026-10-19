import { NamedInputNumber } from './NamedControls';
import { Plus, X } from 'lucide-react';
import { ActionIcon, Button, DropdownMenu, Tag, Text } from '@lobehub/ui/base-ui';
import { Form } from '@lobehub/ui/base-ui/form';
import { activeBlocks, availabilityOf, type Block, type Config, type Owner } from '../../main/policy/routing';
import { DEFAULT_WEIGHT, WEIGHT_MAX, appendWorker, withWorkerWeight, withoutListedWorker, workerWeight } from '../policy-edit';
import { styles } from '../style';
import { scheduleStyles } from './owner-schedule-style';

/** Why dispatch would skip this worker right now, as a short tag. */
export function workerStatusTag(config: Config, blocks: Block[], workerId: string, weight: number): { label: string; color?: string } | undefined {
  const worker = config.workers[workerId];
  if (!worker) return { label: '引用不存在', color: 'error' };
  if (weight === 0) return { label: '不派发' };
  const availability = availabilityOf(config, activeBlocks({ version: 1, blocks }, Date.now()), worker);
  if (availability.status === 'disabled') return { label: '停用' };
  if (availability.status === 'engine_disabled') return { label: '引擎未启用' };
  if (availability.status === 'blocked') return { label: '已限制', color: 'warning' };
  return undefined;
}

const PRESETS = [{ label: '不派发', value: 0 }, { label: '默认', value: DEFAULT_WEIGHT }, { label: '最高', value: WEIGHT_MAX }];

export function OwnerScheduleFields({ config, blocks, record, update }: { config: Config; blocks: Block[]; record: Owner; update: (next: Owner) => void }) {
  const available = Object.keys(config.workers).filter(id => !record.workers.includes(id));
  // Shown in dispatch order: weight first, list order for ties.
  const ordered = record.workers.map((id, index) => ({ id, index, weight: workerWeight(record, id) })).sort((a, b) => b.weight - a.weight || a.index - b.index);
  // A titled section rather than a Form.Field: the add button sits beside the title, and a label element would forward clicks on the title to it.
  return <section aria-label="子 Agent" className={styles.tight}>
    <div className={styles.spread} style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
      <Form.Title title="子 Agent" desc="派发按权重分摊：空闲时先给权重高的，并发时按权重比例分配到各子 Agent；跳过停用或受限的子 Agent。权重为 0–10 的整数，默认 5；0 表示不派给它。" />
      <DropdownMenu placement="bottomRight" items={available.length ? available.map(id => ({ key: id, label: id, desc: [config.workers[id]?.engine, config.workers[id]?.model].filter(Boolean).join(' · '), onClick: () => { const next = appendWorker(record.workers, available, id); if (next) update({ ...record, workers: next }); } })) : [{ key: 'none', label: '没有可添加的子 Agent', disabled: true }]}>
        <Button size="small" icon={Plus}>添加子 Agent</Button>
      </DropdownMenu>
    </div>
    <div className={styles.stack}>
      <Text className={scheduleStyles.heading}>权重</Text>
      <div className={styles.listRows}>{ordered.map(({ id, weight }) => {
        const status = workerStatusTag(config, blocks, id, weight);
        return <div key={id} className={`${styles.listRow} ${scheduleStyles.row}`}>
          <span className={styles.row} style={{ minInlineSize: 0 }}><Text className={styles.wrap}>{id}</Text>{status && <Tag size="small" color={status.color}>{status.label}</Tag>}</span>
          <span className={scheduleStyles.controls}>
            <NamedInputNumber aria-label={`${id} 的权重`} size="small" min={0} max={WEIGHT_MAX} step={1} precision={0} value={weight} style={{ inlineSize: 72 }} onChange={value => update(withWorkerWeight(record, id, typeof value === 'number' ? value : DEFAULT_WEIGHT))} />
            <span role="group" aria-label={`${id} 权重预设`} className={scheduleStyles.presets}>{PRESETS.map(preset => <Button key={preset.value} size="small" type="text" aria-pressed={weight === preset.value} aria-label={`${id} ${preset.label}`} onClick={() => update(withWorkerWeight(record, id, preset.value))}>{preset.label}</Button>)}</span>
            <ActionIcon size="small" icon={X} aria-label={`移除 ${id}`} onClick={() => update(withoutListedWorker(record, id))} />
          </span>
        </div>;
      })}</div>
      {!record.workers.length && <Text type="danger">还没有子 Agent。启用的父 Agent 至少需要一个可用的子 Agent。</Text>}
    </div>
  </section>;
}
