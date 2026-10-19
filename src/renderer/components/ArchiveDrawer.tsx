import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { HTMLAttributes } from 'react';
import { Empty } from '@lobehub/ui';
import { Drawer, Input, Table, Tag, Text } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from '@lobehub/ui/base-ui';
import type { Task } from '../../shared/types';
import { ALL_OWNERS, archiveOutcome, archiveRows, archivedTasks, dispatchKind, ownerLabel, projectLabel, taskOwnerId } from '../task-view';
import { styles } from '../style';
import { AgentLabel } from './EngineIcon';
import { NamedSelect } from './NamedControls';

/** What the archive table shows per owner: who ran the work and which agent did it. */
export function archiveColumns(ownerKind?: (ownerId?: string) => string | undefined): TableColumnsType<Task> {
  return [
    { title: '任务', dataIndex: 'title', key: 'title', render: (_, task) => <Text strong className={styles.wrap}>{task.title}</Text> },
    {
      title: '负责人 → 工作代理',
      key: 'agents',
      render: (_, task) => <span className={styles.agentPair}>
        <AgentLabel kind={ownerKind?.(taskOwnerId(task))} name={ownerLabel(task)} />
        <span aria-hidden="true">→</span>
        <AgentLabel kind={dispatchKind(task)} name={task.dispatch?.worker ?? '未记录代理'} />
      </span>,
    },
    { title: '项目', key: 'project', render: (_, task) => <span className={styles.wrap}>{projectLabel(task) || '未记录项目'}</span> },
    {
      title: '结果',
      key: 'outcome',
      render: (_, task) => { const outcome = archiveOutcome(task); return <Tag size="small" color={outcome.color}>{outcome.label}</Tag>; },
    },
    { title: '结束于', key: 'ended', render: (_, task) => <Text type="secondary" className={styles.meta}>{new Date(task.updatedAt).toLocaleString()}</Text> },
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
  const [query, setQuery] = useState('');
  const [owner, setOwner] = useState(ALL_OWNERS);
  const rows = archiveRows(tasks, query, owner, now);
  /** Only owners with archived work are offered, so the select never leads to an empty table. */
  const owners = [ALL_OWNERS, ...new Set(archivedTasks(tasks, now).map(ownerLabel))].map(value => ({ value, label: value === ALL_OWNERS ? '全部' : value }));
  return <div className={styles.archiveBody}>
    <div className={styles.row}>
      <Input aria-label="搜索归档任务" placeholder="搜索标题、负责人、项目或任务 ID" value={query} onChange={event => setQuery(event.target.value)} className={styles.grow} />
      <NamedSelect aria-label="按负责人筛选归档任务" value={owner} options={owners} onChange={value => { if (typeof value === 'string') setOwner(value); }} />
    </div>
    {rows.length ? <Table<Task> columns={archiveColumns(ownerKind)} dataSource={rows} rowKey="id" pagination={false} size="small" scroll={{ x: true }}
      onRow={task => archiveRowProps(task, selected, onSelect)} /> :
      <Empty title="还没有归档任务" description="任务结束满一天后会出现在这里。" />}
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
