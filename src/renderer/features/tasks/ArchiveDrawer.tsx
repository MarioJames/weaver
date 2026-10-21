import { useEffect, useLayoutEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { HTMLAttributes } from 'react';
import { Empty } from '@lobehub/ui';
import { Drawer, Table, Tag, Text } from '@lobehub/ui/base-ui';
import type { SelectProps, TableColumnsType } from '@lobehub/ui/base-ui';
import type { Task } from '../../../shared/contracts/tasks';
import type { FilterDimension, TaskSelection } from './task-filters';
import { rootIndex } from './task-filters';
import { cardOwner, dispatchKind, projectLabel, taskOwnerId, taskTitle } from './task-view';
import { statusTagColor } from '../../format/tag-colors';
import { ARCHIVE_PAGE_SIZES, ARCHIVE_PAGE_SIZE, ARCHIVE_PAGINATION_BAR, ARCHIVE_SIZE_CHANGER_LABEL, ARCHIVE_TABLE_WIDTH, applyArchivePage, archivePageSizeOptions, archiveScrollY, archiveTotalLabel, archivedTasks, clampArchivePage, resetArchivePage } from './task-archive';
import type { ArchivePager } from './task-archive';
import { TIME_RANGES, ARCHIVE_ALL_VALUE, archiveRowValues, archiveRows, archiveSelectOptions, facetOptions, filterAriaLabel, filterLabels, foldedTriggerValue } from './task-filters';
import { DISPLAY_LABELS, DISPLAY_TONES, displayStatus } from '../../format/status-colors';
import { taskStyles } from './task-style';
import { AgentLabel } from '../../ui/EngineIcon';
import { NamedSelect } from '../../ui/NamedControls';
import { TimeText } from '../../ui/TimeText';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The pager row the Table mounts under its body (its `lobe-table` prefix plus `pagination-wrapper`). */
const PAGER_SELECTOR = '.lobe-table-pagination-wrapper';

/**
 * The room the drawer leaves the table, kept live — together with the height of the pager the table
 * mounts inside that room, because a narrow drawer wraps it onto a second line and the body yields again.
 */
function useArchiveHeights(): [React.Ref<HTMLDivElement>, { available: number | undefined; pager: number }] {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [heights, setHeights] = useState<{ available: number | undefined; pager: number }>({ available: undefined, pager: ARCHIVE_PAGINATION_BAR });
  useIsomorphicLayoutEffect(() => {
    if (!host) return;
    const pager = host.querySelector<HTMLElement>(PAGER_SELECTOR);
    const measure = () => setHeights(current => {
      const next = { available: host.clientHeight, pager: Math.max(ARCHIVE_PAGINATION_BAR, pager?.offsetHeight ?? 0) };
      return current.available === next.available && current.pager === next.pager ? current : next;
    });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    if (pager) observer.observe(pager);
    return () => observer.disconnect();
  }, [host]);
  return [setHost, heights];
}

/** What the archive table shows per owner: who ran the work and which agent did it. */
export function archiveColumns(ownerKind?: (ownerId?: string) => string | undefined, now: number = Date.now(), rootOf?: (id: string) => Task | undefined): TableColumnsType<Task> {
  return [
    { title: '任务', dataIndex: 'title', key: 'title', width: 220, render: (_, task) => <Text strong className={taskStyles.archiveCell} title={taskTitle(task)}>{taskTitle(task)}</Text> },
    {
      title: '父 Agent → 子 Agent',
      key: 'agents',
      width: 250,
      render: (_, task) => {
        const owner = cardOwner(task, rootOf);
        return <span className={taskStyles.agentPair} title={owner.title}>
          <AgentLabel kind={ownerKind?.(taskOwnerId(task))} name={owner.name} />
          <span aria-hidden="true">→</span>
          <AgentLabel kind={dispatchKind(task)} name={task.dispatch?.worker ?? '未记录子 Agent'} />
        </span>;
      },
    },
    { title: '工作目录', key: 'project', width: 110, render: (_, task) => <span className={taskStyles.archiveDirectory} title={task.dispatch?.workspace || task.workspace}>{projectLabel(task) || '未记录工作目录'}</span> },
    {
      title: '结果',
      key: 'outcome',
      width: 80,
      render: (_, task) => { const status = displayStatus(task); return <Tag size="small" color={statusTagColor(DISPLAY_TONES[status])}>{DISPLAY_LABELS[status]}</Tag>; },
    },
    { title: '结束于', key: 'ended', width: 120, render: (_, task) => <TimeText className={taskStyles.cardTime} value={task.updatedAt} now={now} /> },
  ];
}

/** The whole row opens the record, and it answers to the keyboard because the row is the only control here. */
export function archiveRowProps(task: Task, selected: string | undefined, onSelect: (id: string) => void): HTMLAttributes<HTMLTableRowElement> {
  const open = () => onSelect(task.id);
  return {
    className: taskStyles.archiveRow,
    tabIndex: 0,
    'aria-current': selected === task.id ? 'true' : undefined,
    onClick: open,
    onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    },
  };
}

/**
 * The archive's page-size picker, replacing the library's own: it keeps every prop the pager gives
 * the default Select and only relabels the options, so the row looks and sizes exactly as before.
 */
export function ArchivePageSizeChanger({ options, ...props }: SelectProps) {
  return <NamedSelect aria-label={ARCHIVE_SIZE_CHANGER_LABEL} {...props} options={archivePageSizeOptions(options ?? [])} />;
}

/**
 * The archive's content, outside the drawer shell: a Drawer portals its body, which is
 * invisible to a server render — and the table it mounts needs the bundled app's module graph.
 */
export function ArchiveList({ tasks, selected, onSelect, ownerKind, now = Date.now() }: { tasks: Task[]; selected?: string; onSelect: (id: string) => void; ownerKind?: (ownerId?: string) => string | undefined; now?: number }) {
  /** The archive spans all time unless narrowed: it already holds only work the board has aged out. */
  const [selection, setSelection] = useState<TaskSelection>({ status: [], owner: [], worker: [], workspace: [], time: 'all' });
  const [pager, setPager] = useState<ArchivePager>({ page: 1, pageSize: ARCHIVE_PAGE_SIZE });
  const rows = archiveRows(tasks, selection, now);
  /** Filtering pages a different list, so it starts over; live updates only move the reader when their page is gone. */
  const choose = (next: TaskSelection) => { setSelection(next); setPager(resetArchivePage); };
  const [tableRef, room] = useArchiveHeights();
  const rootOf = (id: string) => rootIndex(tasks).get(id);
  const page = clampArchivePage(pager.page, rows.length, pager.pageSize);
  useEffect(() => { if (page !== pager.page) setPager(current => ({ ...current, page })); }, [page, pager.page]);
  const archived = archivedTasks(tasks, now);
  /** Only values with archived work in the chosen range are offered, so a select never leads to an empty table. */
  const filterClassNames = { trigger: taskStyles.archiveFilterTrigger, value: taskStyles.archiveFilterValue, prefix: taskStyles.archiveFilterPrefix, clear: taskStyles.archiveFilterClear };
  const multi = (dimension: FilterDimension) => {
    const chosen = selection[dimension];
    const options = facetOptions(archived, dimension, selection, now, tasks);
    const labelOf = (value: string) => options.find(option => option.value === value)?.label ?? value;
    return <NamedSelect classNames={filterClassNames} key={dimension} mode="multiple" allowClear prefix={`${filterLabels[dimension]}：`} aria-label={filterAriaLabel(filterLabels[dimension])} placeholder="全部"
      value={chosen.length ? chosen : [ARCHIVE_ALL_VALUE]}
      labelRender={option => {
        const value = String(option.value);
        if (value === ARCHIVE_ALL_VALUE) return null;
        const view = foldedTriggerValue(chosen, value, labelOf);
        if (view.hidden) return null;
        const text = String(option.label);
        return <>
          <span className={taskStyles.archiveFilterLabel} title={text}>{text}</span>
          {view.extra > 0 && <span className={taskStyles.archiveFilterMore} title={view.extraTitle}>+{view.extra}</span>}
        </>;
      }}
      options={archiveSelectOptions(archived, dimension, selection, now, tasks)}
      onChange={value => choose({ ...selection, [dimension]: archiveRowValues(chosen, Array.isArray(value) ? value.map(String) : []) })} />;
  };
  return <div className={taskStyles.archiveBody}>
    <div className={taskStyles.archiveFilters}>
      <NamedSelect classNames={filterClassNames} aria-label="按时间筛选归档任务" placeholder="时间" value={selection.time} options={TIME_RANGES.map(range => ({ value: range.value, label: `时间：${range.label}` }))}
        onChange={value => { if (typeof value === 'string') choose({ ...selection, time: TIME_RANGES.find(range => range.value === value)?.value ?? 'all' }); }} />
      {multi('owner')}
      {multi('worker')}
      {multi('status')}
    </div>
    {rows.length ? <div ref={tableRef} className={taskStyles.archiveTable}>
      {/* Virtual rows: only the ones in view are mounted, so the body needs a numeric height. */}
      <Table<Task> virtual columns={archiveColumns(ownerKind, now, rootOf)} dataSource={rows} rowKey="id" size="small" classNames={{ pagination: { root: taskStyles.archivePager } }}
        pagination={{ current: page, pageSize: pager.pageSize, pageSizeOptions: ARCHIVE_PAGE_SIZES, showSizeChanger: true, showTotal: archiveTotalLabel, components: { sizeChanger: ArchivePageSizeChanger }, onChange: (next, size) => setPager(current => applyArchivePage(current, rows.length, next, size)) }}
        scroll={{ x: ARCHIVE_TABLE_WIDTH, y: archiveScrollY(room.available, room.pager) }}
        onRow={task => archiveRowProps(task, selected, onSelect)} />
    </div> :
      <Empty title={archived.length ? "没有匹配的归档任务" : "还没有归档任务"} description={archived.length ? "调整时间、父 Agent、子 Agent 或状态。" : "任务结束满一天后会出现在这里。"} />}
  </div>;
}

/**
 * Finished work that has aged off the board. A derived view over the same tasks: nothing is
 * stored, hidden or deleted here, so a reopened task returns to the board by itself.
 */
export function ArchiveDrawer({ open, onClose, ...rest }: { tasks: Task[]; selected?: string; open: boolean; onClose: () => void; onSelect: (id: string) => void; ownerKind?: (ownerId?: string) => string | undefined; now?: number }) {
  /** The archive stays open under the detail drawer: closing the record returns to the list. */
  return <Drawer open={open} title="归档任务" placement="right" width="min(880px, 92vw)" onClose={onClose}>
    <ArchiveList {...rest} />
  </Drawer>;
}
