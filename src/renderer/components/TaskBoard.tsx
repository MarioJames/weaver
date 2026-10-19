import { Children, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Empty, Icon } from '@lobehub/ui';
import { Button, Skeleton, Tag, Text } from '@lobehub/ui/base-ui';
import { ChevronDown, ChevronRight, ChevronUp, Clock, Folder, Loader2, X } from 'lucide-react';
import type { Task } from '../../shared/types';
import { displayLog } from '../log-view';
import type { FilterDimension, FilterOption, TaskSelection, TaskTimeRange } from '../task-view';
import { FILTER_DIMENSIONS, TASK_COLUMNS, TIME_RANGES, applyTaskFilters, columnize, compactTaskTime, dispatchKind, emptySelection, filterLabels, filterOptions, filterSummary, hasFilters, isOpenTask, nonArchived, readEndedExpanded, readFiltersCollapsed, readTaskFilters, resolveSelection, selectedEntries, toggleOption, workspaceGroups, writeEndedExpanded, writeFiltersCollapsed, writeTaskFilters } from '../task-view';
import { DISPLAY_LABELS, DISPLAY_TONES, displayStatus } from '../status-colors';
import type { DisplayStatus } from '../status-colors';
import { styles } from '../style';
import { AgentFacts } from './AgentFacts';
import { EngineIcon } from './EngineIcon';

/** Every card has a shared status tag; dispatching states also carry a spinner and activity. */
function cardStatus(task: Task): { label: string; color?: string; spin: boolean } {
  const status = displayStatus(task);
  const tone = DISPLAY_TONES[status];
  return { label: DISPLAY_LABELS[status], color: tone === 'default' ? undefined : tone, spin: status === 'running' || status === 'cancelling' };
}

const spinner = <Icon icon={Loader2} spin size="small" />;
const ENDED_BODY_ID = 'board-ended';
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** One checkable chip: label, optional brand/dot, and how many tasks in scope carry it. */
export function FacetChip({ checked, label, count, icon, tone, title, onClick }: { checked: boolean; label: string; count?: number; icon?: ReactNode; tone?: string; title?: string; onClick: () => void }) {
  return <button type="button" className={styles.facetChip} aria-pressed={checked} title={title} onClick={onClick}>
    {tone && <span className={styles.facetDot} data-tone={tone} aria-hidden="true" />}
    {icon}
    <span className={styles.facetChipLabel}>{label}</span>
    {count !== undefined && <span className={`${styles.facetChipCount} ${styles.numbers}`}>{count}</span>}
  </button>;
}

/** A single-line row of chips; whatever does not fit collapses behind 「更多」, which expands only this row. */
function FacetRow({ label, size, children }: { label: string; size: number; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const chips = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(size);
  const overflow = visibleCount < size;
  useIsomorphicLayoutEffect(() => {
    const element = row.current;
    const list = chips.current;
    if (!element || !list) return;
    const measure = () => {
      const widths = Array.from(list.children, child => child.getBoundingClientRect().width);
      const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
      const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
      if (total <= list.clientWidth) { setVisibleCount(size); return; }
      const available = list.clientWidth;
      let used = 0;
      let count = 0;
      for (const width of widths) {
        const next = used + (count ? gap : 0) + width;
        if (next > available) break;
        used = next;
        count++;
      }
      setVisibleCount(count);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    Array.from(list.children).forEach(child => observer.observe(child));
    return () => observer.disconnect();
  }, [size, children]);
  return <div className={styles.facetRow}>
    <span className={styles.facetLabel}>{label}</span>
    <div ref={row} className={styles.facetValues}>
      <div ref={chips} className={styles.facetChips} data-expanded={expanded}>
        {size ? Children.toArray(children).map((child, index) => <span key={index} className={styles.facetItem}
          data-hidden={!expanded && index >= visibleCount} aria-hidden={!expanded && index >= visibleCount} inert={!expanded && index >= visibleCount}>{child}</span>) :
          <span className={styles.facetEmpty}>暂无</span>}
      </div>
      <button type="button" className={`${styles.facetChip} ${styles.facetMore}`} data-visible={overflow}
        aria-hidden={!overflow} inert={!overflow} aria-expanded={expanded} aria-label={`${label} ${expanded ? '收起' : '更多'}`}
        onClick={() => setExpanded(!expanded)}>
        {expanded ? '收起' : '更多'}<Icon icon={expanded ? ChevronUp : ChevronDown} size="small" />
      </button>
    </div>
  </div>;
}

/** The brand behind a chip: parents by their policy engine, sub agents by their dispatch engine, directories by a folder. */
function optionIcon(dimension: FilterDimension, option: FilterOption, ownerKind?: (ownerId?: string) => string | undefined) {
  if (dimension === 'status') return undefined;
  if (dimension === 'workspace') return <Icon icon={Folder} size="small" />;
  return <EngineIcon kind={dimension === 'owner' ? ownerKind?.(option.ownerProfile ?? option.value) : option.kind} />;
}

/**
 * The facet block: 时间 scopes everything, the other rows OR within and AND across.
 * It is persistent content: the 已选 row is always present, so choosing never moves the board.
 */
export function TaskFacets({ board, selection, collapsed, now, ownerKind, onChange, onCollapse }: { board: Task[]; selection: TaskSelection; collapsed: boolean; now: number; ownerKind?: (ownerId?: string) => string | undefined; onChange: (selection: TaskSelection) => void; onCollapse: (collapsed: boolean) => void }) {
  const options = Object.fromEntries(FILTER_DIMENSIONS.map(dimension => [dimension, filterOptions(board, dimension, selection, now)])) as Record<FilterDimension, FilterOption[]>;
  const entries = selectedEntries(selection, options);
  if (collapsed) return <div className={styles.facets} role="group" aria-label="任务筛选">
    <div className={styles.facetSelected}>
      <span className={styles.facetSummary}>{filterSummary(selection, options)}</span>
      <Button size="small" type="text" icon={ChevronDown} aria-expanded={false} onClick={() => onCollapse(false)}>展开筛选</Button>
    </div>
  </div>;
  return <div className={styles.facets} role="group" aria-label="任务筛选">
    <FacetRow label="时间" size={TIME_RANGES.length}>
      {TIME_RANGES.map(range => <FacetChip key={range.value} checked={selection.time === range.value} label={range.label}
        count={applyTaskFilters(board, { ...selection, time: range.value as TaskTimeRange }, undefined, now).length}
        onClick={() => onChange({ ...selection, time: range.value })} />)}
    </FacetRow>
    {FILTER_DIMENSIONS.map(dimension => <FacetRow key={dimension} label={filterLabels[dimension]} size={options[dimension].length}>
      {options[dimension].map(option => <FacetChip key={option.value} checked={selection[dimension].includes(option.value)} label={option.label} count={option.count}
        tone={dimension === 'status' ? DISPLAY_TONES[option.value as DisplayStatus] : undefined}
        icon={optionIcon(dimension, option, ownerKind)} title={dimension === 'workspace' ? option.value : undefined}
        onClick={() => onChange({ ...selection, [dimension]: toggleOption(selection[dimension], option.value) })} />)}
    </FacetRow>)}
    <div className={styles.facetSelected}>
      <div className={styles.facetSelectedDetails} data-active={hasFilters(selection)} aria-hidden={!hasFilters(selection)} inert={!hasFilters(selection)}>
        <span>已选：</span>
        <span className={styles.facetSelectedList}>
          {selection.time !== 'today' && <button type="button" className={styles.facetChip} aria-label={`移除 ${TIME_RANGES.find(range => range.value === selection.time)?.label}`} onClick={() => onChange({ ...selection, time: 'today' })}>
            时间：{TIME_RANGES.find(range => range.value === selection.time)?.label}<Icon icon={X} size="small" />
          </button>}
          {entries.map(entry => <button key={`${entry.dimension}:${entry.value}`} type="button" className={styles.facetChip} aria-label={`移除 ${entry.label}`}
            onClick={() => onChange({ ...selection, [entry.dimension]: selection[entry.dimension].filter(value => value !== entry.value) })}>
            {entry.label}<Icon icon={X} size="small" />
          </button>)}
        </span>
        <Button size="small" type="text" disabled={!hasFilters(selection)} onClick={() => onChange(emptySelection())}>清除全部</Button>
      </div>
      <Button size="small" type="text" icon={ChevronUp} aria-expanded onClick={() => onCollapse(true)}>收起</Button>
    </div>
  </div>;
}

export function TaskBoard({ tasks, selected, loading, onSelect, ownerKind, filters, onFiltersChange, now = Date.now() }: { filters?: TaskSelection; onFiltersChange?: (selection: TaskSelection) => void; tasks: Task[]; selected?: string; loading: boolean; onSelect: (id: string) => void; ownerKind?: (ownerId?: string) => string | undefined; now?: number }) {
  const [stored, setStored] = useState(readTaskFilters);
  const [ended, setEnded] = useState(readEndedExpanded);
  const [collapsed, setCollapsed] = useState(readFiltersCollapsed);
  const [expandedLanes, setExpandedLanes] = useState<string[]>([]);
  if (loading && !tasks.length) return <div role="status" className={styles.stack}><Skeleton animated /><Text type="secondary">正在加载本地任务…</Text></div>;
  if (!tasks.length) return <Empty title="还没有任务" description="从右上角新建第一个任务。" />;
  const selection = resolveSelection(filters ?? stored, tasks, now);
  const board = nonArchived(tasks, now);
  const visible = applyTaskFilters(board, selection, undefined, now);
  const columns = columnize(visible);
  const olderOpenWork = !visible.length && selection.time === 'today' &&
    applyTaskFilters(board, { ...selection, time: 'all' }, undefined, now).some(isOpenTask);
  const update = (next: TaskSelection) => {
    setStored(next);
    onFiltersChange?.(next);
    writeTaskFilters(next);
  };
  const collapse = (next: boolean) => {
    setCollapsed(next);
    writeFiltersCollapsed(next);
  };
  /** 已结束 starts folded: its count is the whole story until someone asks for more. */
  const toggleEnded = () => {
    const next = !ended;
    setEnded(next);
    writeEndedExpanded(next);
  };
  const card = (task: Task) => {
    const tag = cardStatus(task);
    const latest = task.events.at(-1);
    return <button key={task.id} type="button" className={styles.taskCard} aria-current={selected === task.id ? 'true' : undefined} onClick={() => onSelect(task.id)}>
      <span className={styles.cardTitle}>
        {task.dispatch?.worker && <Tag className={styles.cardTag} title={task.dispatch.worker} size="small" icon={<EngineIcon kind={dispatchKind(task)} />}>{task.dispatch.worker}</Tag>}
        <strong className={styles.cardTitleText}>{task.title}</strong>
      </span>
      <span className={styles.cardStatus}>
        <Tag size="small" color={tag.color} icon={tag.spin ? spinner : displayStatus(task) === 'scheduled' ? <Icon icon={Clock} size="small" /> : undefined}>{tag.label}</Tag>
        {tag.spin && <Text type="secondary" className={styles.cardActivity} title={displayLog(latest?.message ?? '等待首次调度')}>{displayLog(latest?.message ?? '等待首次调度')}</Text>}
      </span>
      <span className={styles.cardMeta}>
        <time className={styles.cardTime} dateTime={task.updatedAt} title={new Date(task.updatedAt).toLocaleString('zh-CN')}>{compactTaskTime(task.updatedAt, now)}</time>
        <AgentFacts compact task={task} ownerKind={ownerKind} />
      </span>
    </button>;
  };
  return <section aria-label="任务看板" className={styles.board}>
    <TaskFacets board={board} selection={selection} collapsed={collapsed} now={now} ownerKind={ownerKind} onChange={update} onCollapse={collapse} />
    {!visible.length && <Empty title="没有匹配的任务" description={olderOpenWork ? '今天没有任务，还有更早的未结束任务。' : undefined} action={<div className={styles.row}>
      <Button size="small" onClick={() => update(emptySelection())}>清除筛选</Button>
      {olderOpenWork && <Button size="small" onClick={() => update({ ...selection, time: 'all' })}>查看全部</Button>}
    </div>} />}
    {visible.length > 0 && <>
    <Text type="secondary" className={styles.boardScrollHint}>左右滚动查看其他状态列</Text>
    <div className={styles.columns} aria-label="任务状态列" role="region" tabIndex={0} aria-busy={loading}>
      {TASK_COLUMNS.map((column, index) => {
        const items = columns[index];
        const expanded = expandedLanes.includes(column.key);
        const groups = workspaceGroups(expanded ? items : items.slice(0, 20));
        /** Only 已结束 folds; the columns with live work are always in view. */
        const foldable = column.key === 'closed';
        const shown = !foldable || ended || !items.length;
        const count = <>
          <strong>{column.label}</strong>
          <span className={`${styles.numbers} ${styles.columnCount}`}>{items.length}</span>
        </>;
        return <div key={column.key} id={shown && foldable ? ENDED_BODY_ID : undefined} className={styles.column} data-status-column={column.key} data-collapsed={!shown}>
          <header className={styles.columnHead}>
            {foldable && items.length > 0 ? <button type="button" className={styles.fold} aria-expanded={shown} aria-controls={shown ? ENDED_BODY_ID : undefined} onClick={toggleEnded}>
              <Icon icon={shown ? ChevronDown : ChevronRight} size="small" />
              {count}
            </button> : count}
          </header>
          {shown && <>
            {groups.map(group => <div key={group.workspace} className={styles.workspaceGroup}>
              {groups.length > 1 && <h3 className={styles.workspaceHeading} title={group.workspace || group.label}>
                <Icon icon={Folder} size="small" />
                <span className={styles.workspaceName}>{group.label}</span>
                <span className={styles.numbers}>{group.tasks.length}</span>
              </h3>}
              {group.tasks.map(task => card(task))}
            </div>)}
            {!items.length && <Text type="secondary" className={styles.meta}>暂无任务</Text>}
            {items.length > 20 && <Button size="small" type="text" aria-expanded={expanded} onClick={() => setExpandedLanes(current => expanded ? current.filter(key => key !== column.key) : [...current, column.key])}>
              {expanded ? '收起' : `查看全部 ${items.length}`}
            </Button>}
          </>}
        </div>;
      })}
    </div>
    </>}
  </section>;
}
