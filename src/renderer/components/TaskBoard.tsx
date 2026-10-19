import { useState } from 'react';
import { Empty, Icon } from '@lobehub/ui';
import { Input, Segmented, Skeleton, Tag, Text } from '@lobehub/ui/base-ui';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { Task } from '../../shared/types';
import { redactLog } from '../log-view';
import { ALL_OWNERS, COLLAPSED_LANES_KEY, OWNER_FILTER_KEY, TASK_COLUMNS, dispatchKind, filterByOwner, filterTasks, ownerFacets, ownerLabel, ownerLanes, projectLabel, readCollapsedLanes, resolveOwnerFilter, reviewLabel, statusLabels, taskColumn, taskOwnerId } from '../task-view';
import type { OwnerLane } from '../task-view';
import { styles } from '../style';
import { AgentLabel, EngineIcon } from './EngineIcon';

/** Closed tasks say how they ended; open ones are already described by their column. */
function outcome(task: Task): { label: string; color?: string; spin?: boolean } | undefined {
  if (task.status === 'failed') return { label: statusLabels.failed, color: 'error' };
  if (task.status === 'cancelled') return { label: statusLabels.cancelled };
  if (task.status === 'cancelling') return { label: statusLabels.cancelling, color: 'warning', spin: true };
  if (task.status === 'completed' && task.reviewState) return { label: reviewLabel(task), color: task.reviewState === 'accepted' ? 'success' : 'warning' };
  if (task.status === 'running') return { label: statusLabels.running, color: 'processing', spin: true };
  if (task.scheduled) return { label: '排队中', color: 'processing', spin: true };
  return undefined;
}

function readStoredOwner(): string {
  try { return localStorage.getItem(OWNER_FILTER_KEY) || ALL_OWNERS; } catch { return ALL_OWNERS; }
}

const spinner = <Icon icon={Loader2} spin size="small" />;

/** Lane header counts: what is moving, what waits for review, and how big the lane is. */
function laneCountText(lane: OwnerLane): string {
  return `${TASK_COLUMNS[1].label} ${lane.counts[1]} · ${TASK_COLUMNS[2].label} ${lane.counts[2]} · 共 ${lane.total}`;
}

export function TaskBoard({ tasks, selected, loading, onSelect, ownerKind }: { tasks: Task[]; selected?: string; loading: boolean; onSelect: (id: string) => void; ownerKind?: (ownerId?: string) => string | undefined }) {
  const [query, setQuery] = useState('');
  const [owner, setOwner] = useState(readStoredOwner);
  const [collapsed, setCollapsed] = useState(readCollapsedLanes);
  const resolvedOwner = resolveOwnerFilter(owner, tasks);
  const visible = filterByOwner(filterTasks(tasks, 'all', query), resolvedOwner);
  if (loading && !tasks.length) return <div role="status" className={styles.stack}><Skeleton animated /><Text type="secondary">正在加载本地任务…</Text></div>;
  if (!tasks.length) return <Empty title="还没有任务" description="从右上角新建第一个任务。" />;
  const lanes = ownerLanes(visible);
  /** An isolated owner filter always shows its lane, even when it is folded for the full board. */
  const isOpen = (laneOwner: string) => resolvedOwner !== ALL_OWNERS || !collapsed[laneOwner];
  const toggleLane = (laneOwner: string) => {
    const next = { ...collapsed, [laneOwner]: !isOpen(laneOwner) };
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_LANES_KEY, JSON.stringify(next)); } catch { /* The fold stays for this session only. */ }
  };
  const card = (task: Task) => {
    const tag = outcome(task);
    const project = projectLabel(task);
    const latest = task.events.at(-1);
    const ownerIconKind = ownerKind?.(taskOwnerId(task));
    return <button key={task.id} type="button" className={styles.taskCard} aria-current={selected === task.id ? 'true' : undefined} onClick={() => onSelect(task.id)}>
      <span className={styles.spread} style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <strong className={styles.wrap}>{task.title}</strong>
        {tag && <Tag size="small" color={tag.color} icon={tag.spin ? spinner : undefined}>{tag.label}</Tag>}
      </span>
      {task.status === 'running' && <Text type="secondary" className={styles.meta} ellipsis>{redactLog(latest?.message ?? '等待首次调度')}</Text>}
      <Text type="secondary" className={`${styles.meta} ${styles.wrap}`}>
        {ownerIconKind || task.dispatch ? <AgentLabel kind={ownerIconKind} name={ownerLabel(task)} /> : ownerLabel(task)}
        {task.dispatch ? <> → <AgentLabel kind={dispatchKind(task)} name={task.dispatch.worker} /></> : ''}
        {project ? ` · ${project}` : ''}
      </Text>
      <Text type="secondary" className={styles.meta}>{new Date(task.updatedAt).toLocaleString()}</Text>
    </button>;
  };
  return <section aria-label="任务看板" className={styles.board}>
    <div className={styles.row}>
      <Input aria-label="搜索任务" placeholder="搜索标题、负责人、项目或任务 ID" value={query} onChange={event => setQuery(event.target.value)} style={{ maxInlineSize: 360 }} />
      <div role="group" aria-label="按负责人筛选">
        <Segmented size="small" value={resolvedOwner} options={ownerFacets(tasks).map(facet => {
          const kind = facet.value === ALL_OWNERS ? undefined : ownerKind?.(facet.value);
          return { value: facet.value, icon: kind ? <EngineIcon kind={kind} /> : undefined, label: `${facet.label} ${facet.count}` };
        })}
          onChange={value => { setOwner(value); try { localStorage.setItem(OWNER_FILTER_KEY, value); } catch { /* Selection stays for this session only. */ } }} />
      </div>
    </div>
    {!lanes.length ? <Text type="secondary" className={styles.meta} style={{ padding: 8 }}>没有匹配的任务</Text> :
      <div className={styles.lanes} aria-busy={loading}>
        {lanes.map((lane, index) => {
          const open = isOpen(lane.owner);
          return <section key={lane.owner} aria-label={`${lane.owner} 的任务`} className={styles.lane}>
            <header className={styles.laneHead}>
              <button type="button" className={styles.laneToggle} aria-expanded={open} aria-controls={`owner-lane-${index}`} onClick={() => toggleLane(lane.owner)}>
                <EngineIcon kind={ownerKind?.(lane.owner)} size={16} />
                <span className={styles.wrap}>{lane.owner}</span>
                <Icon icon={open ? ChevronDown : ChevronRight} size="small" />
              </button>
              <Text type="secondary" className={`${styles.meta} ${styles.numbers}`}>{laneCountText(lane)}</Text>
            </header>
            {open && <div className={styles.laneBody} id={`owner-lane-${index}`}>
              {TASK_COLUMNS.map(column => {
                const items = lane.tasks.filter(task => taskColumn(task) === column.key).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
                return <div key={column.key} className={styles.laneColumn}>
                  <header className={styles.laneColHead}>
                    <Text strong>{column.label}</Text>
                    <Text type="secondary" className={styles.numbers}>{items.length}</Text>
                  </header>
                  {items.map(task => card(task))}
                  {!items.length && <Text type="secondary" className={styles.meta} aria-hidden="true">—</Text>}
                </div>;
              })}
            </div>}
          </section>;
        })}
      </div>}
  </section>;
}
