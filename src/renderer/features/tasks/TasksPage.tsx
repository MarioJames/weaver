import { notifyError } from '../../api/notify';
import { useEffect, useRef, useState } from 'react';
import { Archive, Plus } from 'lucide-react';
import { PageHeader } from '@lobehub/ui/dashboard';
import { Button, Drawer, Skeleton } from '@lobehub/ui/base-ui';
import { command } from '../../api/commands';
import type { OwnerInstance } from '../../../shared/contracts/owners';
import type { Task } from '../../../shared/contracts/tasks';
import { createTask, notifySaveDraftFailure, taskUpdateArgs, updateTask } from './task-create';
import { ownerProfileOf, recentWorkspaces, withOwnerProfiles } from './task-view';
import { archivedTasks } from './task-archive';
import { readTaskFilters } from './task-persistence';
import { ArchiveDrawer } from './ArchiveDrawer';
import { EditTaskDialog } from './EditTaskDialog';
import { NewTaskDialog } from './NewTaskDialog';
import { TaskBoard } from './TaskBoard';
import { TaskDetail } from './TaskDetail';
import type { useWorkbench } from './useWorkbench';

export function TasksPage({ work, ownerKind, freeChannel }: { work: ReturnType<typeof useWorkbench>; ownerKind?: (ownerId?: string) => string | undefined; freeChannel?: (workerId?: string) => boolean }) {
  const [filters, setFilters] = useState(readTaskFilters);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [selected, setSelected] = useState<string>();
  const detailTitleRef = useRef<HTMLSpanElement>(null);
  const newTaskRef = useRef<HTMLButtonElement | HTMLAnchorElement>(null);
  const [owners, setOwners] = useState<OwnerInstance[]>([]);
  useEffect(() => {
    let current = true;
    void command<{ owners: OwnerInstance[] }>('owners.list', {}).then(result => {
      if (current) { setOwners(result.owners); }
    }).catch(error => { if (current) notifyError(error, '资料读取失败'); });
    return () => { current = false; };
  }, [work.tasks]);
  const tasks = withOwnerProfiles(work.tasks, owners);
  const task = tasks.find(item => item.id === selected);
  const [detail, setDetail] = useState<Task>();
  const [detailAttempt, setDetailAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    if (!task) { setDetail(undefined); return; }
    void window.weaver.getTask(task.id).then(value => {
      if (current) setDetail(value);
    }).catch(error => { if (current) notifyError(error, '任务详情读取失败', { label: '重试', run: () => setDetailAttempt(value => value + 1) }); });
    return () => { current = false; };
  }, [task?.id, task?.revision, task?.updatedAt, detailAttempt]);
  const fullTask = detail?.id === task?.id ? detail : undefined;
  useEffect(() => { setEditing(false); }, [task?.id]);
  const now = Date.now();
  const archived = archivedTasks(tasks, now).length;
  return <>
    <PageHeader title="任务" description="创建、执行和验收都记录在同一条任务里。" action={<>
      <Button ref={newTaskRef} type="primary" icon={Plus} disabled={work.busy || !work.caps || work.loading} onClick={() => setCreating(true)}>新建任务</Button>
      <Button icon={Archive} disabled={!work.caps || work.loading} onClick={() => setArchiving(true)}>归档 {work.loading ? <span role="status" aria-label="正在加载归档数量">…</span> : archived}</Button>
    </>} />
    <TaskBoard filters={filters} onFiltersChange={setFilters} now={now} tasks={tasks} selected={selected} loading={work.loading} onSelect={setSelected} ownerKind={ownerKind} freeChannel={freeChannel} />
    <ArchiveDrawer now={now} tasks={tasks} selected={selected} open={archiving} onClose={() => setArchiving(false)} onSelect={setSelected} ownerKind={ownerKind} />
    <Drawer open={!!task} title={<span ref={detailTitleRef} tabIndex={-1}>任务详情</span>} afterOpenChange={open => { if (open) detailTitleRef.current?.focus({ preventScroll: true }); }} placement="right" width="min(960px, 92vw)" onClose={() => setSelected(undefined)}>
      {task && !fullTask && <div role="status" aria-label="正在加载任务详情"><Skeleton animated /></div>}
      {task && fullTask && <TaskDetail key={task.id} task={{...fullTask, owner: task.owner}} tasks={tasks} onSelect={setSelected} busy={work.busy || !work.caps} action={work.action} ownerKind={ownerKind} freeChannel={freeChannel}
        onStart={id => void work.action(() => window.weaver.startTask(id))} onEdit={() => setEditing(true)}
        onCancel={id => void work.action(() => window.weaver.cancelTask(id))}
        onRetry={id => void work.action(async () => { const next = await command<{ id: string }>('tasks.retry', { taskId: id }, true); setSelected(next.id); })} />}
    </Drawer>
    {task && fullTask && <EditTaskDialog open={editing} task={fullTask} profile={ownerProfileOf(task, owners)} busy={work.busy} recentWorkspaces={recentWorkspaces(tasks, 5)} close={() => setEditing(false)}
      /** Saving uses the revision read when the dialog opened, and failures report on their own overlay instead of the generic control-plane error. */
      save={(input, start, expectedRevision) => work.action(() => updateTask(taskUpdateArgs({ id: fullTask.id, revision: expectedRevision }, input, ownerProfileOf(task, owners)), start, {
        update: args => command('tasks.update', args, true),
        start: id => window.weaver.startTask(id),
        startFailed: (id, error) => notifyError(error, '草稿已保存，启动失败', { label: '重试启动', run: () => { void work.action(() => window.weaver.startTask(id)); } }),
      }), notifySaveDraftFailure)} />}
    <NewTaskDialog open={creating} busy={work.busy} recentWorkspaces={recentWorkspaces(tasks, 5)} close={() => setCreating(false)} onClosed={() => newTaskRef.current?.focus()}
      create={(input, start) => work.action(() => createTask(input, start, {
        create: value => command<{ id: string }>('tasks.create', { ...value }, true),
        start: id => window.weaver.startTask(id),
        // The new parent Agent is on the board at once: it is selected, its 父 Agent filter is set, and the splitting notice points at it.
        select: id => {
          setSelected(id);
          setFilters(current => current.owner.includes(id) ? current : { ...current, owner: [...current.owner, id] });
        },
        startFailed: (id, error) => notifyError(error, '任务已创建，启动失败', { label: '重试启动', run: () => { void work.action(() => window.weaver.startTask(id)); } }),
      }))} />
  </>;
}
