import { useState } from 'react';
import { Empty, Icon } from '@lobehub/ui';
import type { DropdownMenuCheckboxItem } from '@lobehub/ui/base-ui';
import { Button, DropdownMenu, Input, Skeleton, Tag, Text } from '@lobehub/ui/base-ui';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { Task } from '../../shared/types';
import { redactLog } from '../log-view';
import type { FilterDimension, FilterOption, TaskSelection } from '../task-view';
import { FILTER_DIMENSIONS, TASK_COLUMNS, applyTaskFilters, columnize, emptySelection, filterButtonLabel, filterOptions, filterTasks, hasFilters, nonArchived, readEndedExpanded, readTaskFilters, resolveSelection, reviewLabel, statusLabels, toggleOption, writeEndedExpanded, writeTaskFilters } from '../task-view';
import { styles } from '../style';
import { AgentFacts } from './AgentFacts';
import { EngineIcon } from './EngineIcon';

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

const spinner = <Icon icon={Loader2} spin size="small" />;
const ENDED_BODY_ID = 'board-ended';

/** A choice only the curious should have to look for: nothing live behind it and not already picked. */
const isQuiet = (option: FilterOption, chosen: string[]) => option.open === 0 && !chosen.includes(option.value);

/** The brand behind a choice: owners by their policy engine, engines by their kind, workers by their dispatch engine. */
function optionIcon(dimension: FilterDimension, option: FilterOption, ownerKind?: (ownerId?: string) => string | undefined) {
  return <EngineIcon kind={dimension === 'owner' ? ownerKind?.(option.value) : option.kind} />;
}

/**
 * One dimension's checklist. The menu portals its rows, so this builder is also what a
 * server render and a test can see: chosen values stay listed even when their work is done.
 */
export function filterItems(dimension: FilterDimension, options: FilterOption[], chosen: string[], onToggle: (value: string) => void, ownerKind?: (ownerId?: string) => string | undefined): DropdownMenuCheckboxItem[] {
  return options.filter(option => !isQuiet(option, chosen)).map(option => ({
    type: 'checkbox',
    key: option.value,
    checked: chosen.includes(option.value),
    /** Multi-select: a menu that closes on the first tick would make an OR across choices impossible. */
    closeOnClick: false,
    icon: optionIcon(dimension, option, ownerKind),
    label: option.label,
    extra: <Text type="secondary" className={styles.numbers}>{option.open}</Text>,
    onCheckedChange: () => onToggle(option.value),
  }));
}

/** Under the list: how many choices are hidden, and the way to see them. */
export function filterReveal(options: FilterOption[], chosen: string[], onReveal: () => void) {
  const quiet = options.filter(option => isQuiet(option, chosen));
  if (!quiet.length) return undefined;
  return <Button size="small" type="text" block onClick={onReveal}>显示全部 {quiet.length}</Button>;
}

export function TaskBoard({ tasks, selected, loading, onSelect, ownerKind, now = Date.now() }: { tasks: Task[]; selected?: string; loading: boolean; onSelect: (id: string) => void; ownerKind?: (ownerId?: string) => string | undefined; now?: number }) {
  const [query, setQuery] = useState('');
  const [stored, setStored] = useState(readTaskFilters);
  const [ended, setEnded] = useState(readEndedExpanded);
  const [revealed, setRevealed] = useState<Record<FilterDimension, boolean>>({ owner: false, engine: false, worker: false });
  if (loading && !tasks.length) return <div role="status" className={styles.stack}><Skeleton animated /><Text type="secondary">正在加载本地任务…</Text></div>;
  if (!tasks.length) return <Empty title="还没有任务" description="从右上角新建第一个任务。" />;
  const selection = resolveSelection(stored, tasks, now);
  const board = nonArchived(tasks, now);
  const visible = filterTasks(applyTaskFilters(board, selection), 'all', query);
  const columns = columnize(visible);
  const choose = (dimension: FilterDimension, values: string[]) => {
    const next: TaskSelection = { ...selection, [dimension]: values };
    setStored(next);
    writeTaskFilters(next);
  };
  /** 已结束 starts folded: its count is the whole story until someone asks for more. */
  const toggleEnded = () => {
    const next = !ended;
    setEnded(next);
    writeEndedExpanded(next);
  };
  const card = (task: Task) => {
    const tag = outcome(task);
    const latest = task.events.at(-1);
    return <button key={task.id} type="button" className={styles.taskCard} aria-current={selected === task.id ? 'true' : undefined} onClick={() => onSelect(task.id)}>
      <span className={styles.spread} style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <strong className={styles.wrap}>{task.title}</strong>
        {tag && <Tag size="small" color={tag.color} icon={tag.spin ? spinner : undefined}>{tag.label}</Tag>}
      </span>
      {task.status === 'running' && <Text type="secondary" className={styles.meta} ellipsis>{redactLog(latest?.message ?? '等待首次调度')}</Text>}
      <AgentFacts compact task={task} ownerKind={ownerKind} />
      <Text type="secondary" className={styles.meta}>{new Date(task.updatedAt).toLocaleString()}</Text>
    </button>;
  };
  return <section aria-label="任务看板" className={styles.board}>
    <div className={styles.row}>
      <Input aria-label="搜索任务" placeholder="搜索标题、负责人、项目或任务 ID" value={query} onChange={event => setQuery(event.target.value)} style={{ maxInlineSize: 360 }} />
      {FILTER_DIMENSIONS.map(dimension => {
        const options = filterOptions(board, dimension, selection, now);
        const chosen = selection[dimension];
        return <DropdownMenu key={dimension} trigger="click" placement="bottomLeft"
          items={filterItems(dimension, options, chosen, value => choose(dimension, toggleOption(chosen, value)), ownerKind)}
          footer={revealed[dimension] ? undefined : filterReveal(options, chosen, () => setRevealed({ ...revealed, [dimension]: true }))}>
          <Button size="small" type={chosen.length ? 'fill' : 'default'} icon={ChevronDown} iconPosition="end">{filterButtonLabel(dimension, options, chosen)}</Button>
        </DropdownMenu>;
      })}
      {hasFilters(selection) && <Button size="small" type="text" onClick={() => { setStored(emptySelection()); writeTaskFilters(emptySelection()); }}>清除</Button>}
    </div>
    {!visible.length ? <Text type="secondary" className={styles.meta} style={{ padding: 8 }}>没有匹配的任务</Text> :
      <div className={styles.columns} aria-busy={loading}>
        {TASK_COLUMNS.map((column, index) => {
          const items = columns[index];
          /** Only 已结束 folds; the columns with live work are always in view. */
          const foldable = column.key === 'closed';
          const shown = !foldable || ended;
          const count = <>
            <Text strong>{column.label}</Text>
            <Text type="secondary" className={styles.numbers}>{items.length}</Text>
          </>;
          return <div key={column.key} id={shown && foldable ? ENDED_BODY_ID : undefined} className={styles.column}>
            <header className={styles.columnHead}>
              {foldable ? <button type="button" className={styles.fold} aria-expanded={shown} aria-controls={shown ? ENDED_BODY_ID : undefined} onClick={toggleEnded}>
                <Icon icon={shown ? ChevronDown : ChevronRight} size="small" />
                {count}
              </button> : count}
            </header>
            {shown && <>
              {items.map(task => card(task))}
              {!items.length && <Text type="secondary" className={styles.meta} aria-hidden="true">—</Text>}
            </>}
          </div>;
        })}
      </div>}
  </section>;
}
