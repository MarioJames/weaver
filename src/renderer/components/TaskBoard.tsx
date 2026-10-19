import { useState } from 'react';
import { Empty } from '@lobehub/ui';
import { Input, Segmented, Skeleton, Text } from '@lobehub/ui/base-ui';
import type { Task } from '../../shared/types';
import { filterTasks, reviewLabel, statusLabels, type TaskFilter } from '../task-view';
import { styles } from '../style';

export function TaskBoard({ tasks, selected, loading, onSelect }: { tasks: Task[]; selected?: string; loading: boolean; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TaskFilter>('all');
  const visible = filterTasks(tasks, filter, query);
  return <section aria-label="任务列表" className={styles.stack}>
    <Input aria-label="搜索任务" placeholder="标题、Owner 或任务 ID" value={query} onChange={event => setQuery(event.target.value)} />
    <Segmented aria-label="任务筛选" block size="small" value={filter} onChange={setFilter} options={[{ value: 'all', label: '全部' }, { value: 'active', label: '进行中' }, { value: 'review', label: '待验收' }, { value: 'closed', label: '已结束' }]} />
    <div aria-busy={loading} className={styles.stack}>
      {loading && !tasks.length ? <div role="status" className={styles.stack}><Skeleton animated /><Text type="secondary">正在加载本地任务…</Text></div>
        : !visible.length ? <Empty description={tasks.length ? '没有符合筛选的任务' : '从上方创建第一个任务。'} title={tasks.length ? '没有匹配结果' : '还没有任务'} />
          : visible.map(task => <button key={task.id} type="button" aria-current={selected === task.id ? 'true' : undefined} className={styles.item} onClick={() => onSelect(task.id)}>
            <span className={styles.spread}><Text>{statusLabels[task.status]}</Text><Text type="secondary" className={styles.meta}>{task.progress}%</Text></span>
            <strong className={styles.wrap}>{task.title}</strong>
            <Text type="secondary" className={styles.meta}>{task.owner.name} · {task.status === 'completed' ? reviewLabel(task) : new Date(task.createdAt).toLocaleString()}</Text>
          </button>)}
    </div>
  </section>;
}
