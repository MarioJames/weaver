import { notifyError } from '../notify';
import { useEffect, useRef, useState } from 'react';
import { Archive, Plus } from 'lucide-react';
import { PageHeader } from '@lobehub/ui/dashboard';
import { Button, Drawer } from '@lobehub/ui/base-ui';
import { command } from '../commands';
import type { OwnerInstance } from '../../shared/commands';
import { archivedTasks, readTaskFilters, withOwnerProfiles } from '../task-view';
import { ArchiveDrawer } from '../components/ArchiveDrawer';
import { NewTaskDialog } from '../components/NewTaskDialog';
import { TaskBoard } from '../components/TaskBoard';
import { TaskDetail } from '../components/TaskDetail';
import type { useWorkbench } from '../hooks/useWorkbench';

export function TasksPage({ work, ownerKind }: { work: ReturnType<typeof useWorkbench>; ownerKind?: (ownerId?: string) => string | undefined }) {
  const [filters, setFilters] = useState(readTaskFilters);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [selected, setSelected] = useState<string>();
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
  const now = Date.now();
  const archived = archivedTasks(tasks, now).length;
  return <>
    <PageHeader title="任务" description="创建、执行和验收都记录在同一条任务里。" action={<>
      <Button ref={newTaskRef} type="primary" icon={Plus} disabled={work.busy || !work.caps || work.loading} onClick={() => setCreating(true)}>新建任务</Button>
      <Button icon={Archive} disabled={!work.caps || work.loading} onClick={() => setArchiving(true)}>归档 {archived}</Button>
    </>} />
    <TaskBoard filters={filters} onFiltersChange={setFilters} now={now} tasks={tasks} selected={selected} loading={work.loading} onSelect={setSelected} ownerKind={ownerKind} />
    <ArchiveDrawer now={now} tasks={tasks} selected={selected} open={archiving} onClose={() => setArchiving(false)} onSelect={setSelected} ownerKind={ownerKind} />
    <Drawer open={!!task} title="任务详情" placement="right" width="min(960px, 92vw)" onClose={() => setSelected(undefined)}>
      {task && <TaskDetail key={task.id} task={task} busy={work.busy || !work.caps} action={work.action} ownerKind={ownerKind}
        onStart={id => void work.action(() => window.weaver.startTask(id))}
        onCancel={id => void work.action(() => window.weaver.cancelTask(id))}
        onRetry={id => void work.action(async () => { const next = await command<{ id: string }>('tasks.retry', { taskId: id }, true); setSelected(next.id); })} />}
    </Drawer>
    <NewTaskDialog open={creating} busy={work.busy} close={() => setCreating(false)} onClosed={() => newTaskRef.current?.focus()}
      create={input => work.action(async () => { const created = await command<{ id: string }>('tasks.create', { ...input }, true); setSelected(created.id); })}
      importTask={() => void work.action(async () => { const imported = await window.weaver.importTask(); if (imported) { setSelected(imported.id); setCreating(false); } })} />
  </>;
}
