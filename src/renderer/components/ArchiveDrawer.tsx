import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { HTMLAttributes } from 'react';
import { Empty } from '@lobehub/ui';
import { Drawer, Table, Tag, Text } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from '@lobehub/ui/base-ui';
import type { Task } from '../../shared/types';
import type { FilterDimension, TaskSelection } from '../task-view';
import { TIME_RANGES, archiveRows, archivedTasks, compactTaskTime, dispatchKind, facetOptions, filterLabels, ownerLabel, projectLabel, taskOwnerId } from '../task-view';
import { DISPLAY_LABELS, DISPLAY_TONES, displayStatus } from '../status-colors';
import { styles } from '../style';
import { AgentLabel } from './EngineIcon';
import { NamedSelect } from './NamedControls';

/** What the archive table shows per owner: who ran the work and which agent did it. */
export function archiveColumns(ownerKind?: (ownerId?: string) => string | undefined, now: number = Date.now()): TableColumnsType<Task> {
  return [
    { title: '任务', dataIndex: 'title', key: 'title', render: (_, task) => <Text strong className={styles.wrap}>{task.title}</Text> },
    {
      title: '父 Agent → 子 Agent',
      key: 'agents',
      render: (_, task) => <span className={styles.agentPair}>
        <AgentLabel kind={ownerKind?.(taskOwnerId(task))} name={ownerLabel(task)} />
        <span aria-hidden="true">→</span>
        <AgentLabel kind={dispatchKind(task)} name={task.dispatch?.worker ?? '未记录子 Agent'} />
      </span>,
    },
    { title: '工作目录', key: 'project', render: (_, task) => <span className={styles.archiveDirectory} title={task.dispatch?.workspace || task.workspace}>{projectLabel(task) || '未记录工作目录'}</span> },
    {
      title: '结果',
      key: 'outcome',
      render: (_, task) => { const status = displayStatus(task); const tone = DISPLAY_TONES[status]; return <Tag size="small" color={tone === 'default' ? undefined : tone}>{DISPLAY_LABELS[status]}</Tag>; },
    },
    { title: '结束于', key: 'ended', render: (_, task) => <time className={styles.cardTime} dateTime={task.updatedAt} title={new Date(task.updatedAt).toLocaleString('zh-CN')}>{compactTaskTime(task.updatedAt, now)}</time> },
  ];
}

/** The whole row opens the record, and it answers to the keyboard because the row is the only control here. */
export function archiveRowProps(task: Task, selected: string | undefined, onSelect: (id: string) => void): HTMLAttributes<HTMLTableRowElement> {
  const open = () => onSelect(task.id);
  return {
    className: styles.archiveRow,
    tabIndex: 0,
    'aria-current': selected === task.id ? 'true' : undefined,
    onClick: open,
    onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    },
  };
}

/**
 * The archive's content, outside the drawer shell: a Drawer portals its body, which is
 * invisible to a server render — and the table it mounts needs the bundled app's module graph.
 */
export function ArchiveList({ tasks, selected, onSelect, ownerKind, now = Date.now() }: { tasks: Task[]; selected?: string; onSelect: (id: string) => void; ownerKind?: (ownerId?: string) => string | undefined; now?: number }) {
  /** The archive spans all time unless narrowed: it already holds only work the board has aged out. */
  const [selection, setSelection] = useState<TaskSelection>({ status: [], owner: [], worker: [], workspace: [], time: 'all' });
  const rows = archiveRows(tasks, selection, now);
  const archived = archivedTasks(tasks, now);
  /** Only values with archived work in the chosen range are offered, so a select never leads to an empty table. */
  const filterClassNames = { trigger: styles.archiveFilterTrigger, value: styles.archiveFilterValue };
  const multi = (dimension: FilterDimension) => <NamedSelect classNames={filterClassNames} key={dimension} mode="multiple" allowClear prefix={`${filterLabels[dimension]}：`} aria-label={`按${filterLabels[dimension]} 筛选归档任务`} placeholder="全部" value={selection[dimension]}
    labelRender={option => <span className={styles.archiveFilterLabel} title={String(option.label)}>{option.label}</span>}
    options={facetOptions(archived, dimension, selection, now).map(option => ({ value: option.value, label: `${option.label} ${option.count}` }))}
    onChange={value => setSelection({ ...selection, [dimension]: Array.isArray(value) ? value.map(String) : [] })} />;
  return <div className={styles.archiveBody}>
    <div className={styles.archiveFilters}>
      <NamedSelect classNames={filterClassNames} aria-label="按时间筛选归档任务" placeholder="时间" value={selection.time} options={TIME_RANGES.map(range => ({ value: range.value, label: `时间：${range.label}` }))}
        onChange={value => { if (typeof value === 'string') setSelection({ ...selection, time: TIME_RANGES.find(range => range.value === value)?.value ?? 'all' }); }} />
      {multi('owner')}
      {multi('worker')}
      {multi('status')}
    </div>
    {rows.length ? <Table<Task> columns={archiveColumns(ownerKind, now)} dataSource={rows} rowKey="id" pagination={false} size="small" scroll={{ x: true }}
      onRow={task => archiveRowProps(task, selected, onSelect)} /> :
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
