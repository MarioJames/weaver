import { useState } from 'react';
import { Empty } from '@lobehub/ui';
import { Input, Progress, Skeleton, Tag, Text } from '@lobehub/ui/base-ui';
import type { Task } from '../../shared/types';
import { TASK_COLUMNS, filterTasks, reviewLabel, statusLabels, taskColumn } from '../task-view';
import { styles } from '../style';

/** Closed tasks say how they ended; open ones are already described by their column. */
function outcome(task: Task): { label: string; color?: string } | undefined {
  if (task.status === 'failed') return { label: statusLabels.failed, color: 'error' };
  if (task.status === 'cancelled') return { label: statusLabels.cancelled };
  if (task.status === 'cancelling') return { label: statusLabels.cancelling, color: 'warning' };
  if (task.status === 'completed' && task.reviewState) return { label: reviewLabel(task), color: task.reviewState === 'accepted' ? 'success' : 'warning' };
  if (task.scheduled) return { label: '排队中', color: 'processing' };
  return undefined;
}

export function TaskBoard({ tasks, selected, loading, onSelect }: { tasks: Task[]; selected?: string; loading: boolean; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const visible = filterTasks(tasks, 'all', query);
  if (loading && !tasks.length) return <div role="status" className={styles.stack}><Skeleton animated /><Text type="secondary">正在加载本地任务…</Text></div>;
  if (!tasks.length) return <Empty title="还没有任务" description="从右上角新建第一个任务。" />;
  return <section aria-label="任务看板" className={styles.board}>
    <Input aria-label="搜索任务" placeholder="搜索标题、负责人或任务 ID" value={query} onChange={event => setQuery(event.target.value)} style={{ maxInlineSize: 360 }} />
    <div className={styles.lanes} aria-busy={loading}>
      {TASK_COLUMNS.map(column => {
        const items = visible.filter(task => taskColumn(task) === column.key).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return <section key={column.key} aria-label={column.label} className={styles.lane}>
          <header className={styles.laneHead}><Text strong>{column.label}</Text><Text type="secondary" className={styles.numbers}>{items.length}</Text></header>
          <div className={styles.laneBody}>
            {!items.length && <Text type="secondary" className={styles.meta} style={{ padding: 8 }}>{query.trim() ? '没有匹配的任务' : '暂无'}</Text>}
            {items.map(task => {
              const tag = outcome(task);
              return <button key={task.id} type="button" className={styles.taskCard} aria-current={selected === task.id ? 'true' : undefined} onClick={() => onSelect(task.id)}>
                <span className={styles.spread} style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <strong className={styles.wrap}>{task.title}</strong>
                  {tag && <Tag size="small" color={tag.color}>{tag.label}</Tag>}
                </span>
                {task.status === 'running' && <Progress aria-label={`${task.title} 执行进度`} percent={task.progress} size="small" />}
                <Text type="secondary" className={`${styles.meta} ${styles.wrap}`}>{task.owner.name}{task.dispatch ? ` → ${task.dispatch.worker}` : ''}</Text>
                <Text type="secondary" className={styles.meta}>{new Date(task.updatedAt).toLocaleString()}</Text>
              </button>;
            })}
          </div>
        </section>;
      })}
    </div>
  </section>;
}
