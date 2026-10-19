import { NamedSelect, NamedInputNumber } from './NamedControls';
import { useState } from 'react';
import { Button, Text } from '@lobehub/ui/base-ui';
import { Form } from '@lobehub/ui/base-ui/form';
import type { Config, Owner } from '../../main/policy/routing';
import { appendWorker, moveWorker, withOnlyEngine, withWorkerWeight, withoutListedWorker, workerWeight } from '../policy-edit';
import { styles } from '../style';

export function OwnerScheduleFields({ config, record, update }: { config: Config; record: Owner; update: (next: Owner) => void }) {
  const [add, setAdd] = useState<string>();
  const available = Object.keys(config.workers).filter(id => !record.workers.includes(id));
  const pending = appendWorker(record.workers, available, add);
  return <>
    <Form.Field label="固定单一引擎" desc="选定后，自动派发、指定工作代理和排队重试都只能用这台引擎。它不可用时不会改派到别的引擎。">
      <div className={styles.row}>
        <NamedSelect aria-label="固定单一引擎" value={record.only_engine} placeholder="不固定" options={Object.keys(config.engines).map(id => ({ value: id, label: `${id}${config.engines[id]?.enabled ? '' : ' · 未启用'}` }))} onChange={value => { if (typeof value === 'string') update(withOnlyEngine(record, value)); }} />
        <Button disabled={!record.only_engine} onClick={() => update(withOnlyEngine(record, undefined))}>清除固定</Button>
      </div>
    </Form.Field>
    <Form.Field label="工作代理与同类优先权重" required desc="类别和标签仍先决定候选。同一层级内，优先权重更大的先尝试，相同权重才按上面的顺序。0 表示这个负责人不派给该工作代理。这是优先级，不是随机概率。">
      <div className={styles.stack}>{record.workers.map((id, index) => <div key={`${id}-${index}`} className={styles.row}>
        <Text className={styles.grow}>{index + 1}. {id}{Object.hasOwn(config.workers, id) ? '' : '（引用不存在）'}</Text>
        <NamedInputNumber aria-label={`${id} 的优先权重`} min={0} max={1000} step={1} value={workerWeight(record, id)} onChange={value => update(withWorkerWeight(record, id, typeof value === 'number' ? value : 100))} />
        <Button size="small" aria-label={`上移 ${id}`} disabled={index === 0} onClick={() => update({ ...record, workers: moveWorker(record.workers, index, -1) })}>上移</Button>
        <Button size="small" aria-label={`下移 ${id}`} disabled={index === record.workers.length - 1} onClick={() => update({ ...record, workers: moveWorker(record.workers, index, 1) })}>下移</Button>
        <Button size="small" aria-label={`移除引用 ${id}`} onClick={() => update(withoutListedWorker(record, id))}>移除</Button>
      </div>)}
        {!record.workers.length && <Text type="danger">还没有工作代理。启用的负责人至少需要一个已启用、且引擎已启用的工作代理。权重为 0 或固定引擎暂时不可用时仍可保存，预览会说明没有候选。</Text>}
        <div className={styles.row}><NamedSelect aria-label="加入顺序的工作代理" value={pending ? add : undefined} placeholder="选择工作代理" options={available.map(id => ({ value: id, label: id }))} onChange={value => setAdd(typeof value === 'string' ? value : undefined)} /><Button disabled={!pending} onClick={() => { if (!pending) return; update({ ...record, workers: pending }); setAdd(undefined); }}>添加引用</Button></div>
      </div>
    </Form.Field>
  </>;
}
