import { useEffect, useState } from 'react';
import { Modal } from '@lobehub/ui';
import type { Task } from '../../../shared/contracts/tasks';
import { TaskComposer, type CreateTaskDraft } from './TaskComposer';
import { draftEdit } from './task-create';

/** Edit a draft in the same composer the task was created with. The fields and the expected revision are read again each time the dialog opens, so an edit made elsewhere saves as a conflict instead of overwriting it; a failed save keeps the fields as typed. */
export function EditTaskDialog({ open, task, profile, busy, recentWorkspaces, close, save }: { open: boolean; task: Task; profile: string; busy: boolean; recentWorkspaces?: string[]; close: () => void; save: (input: CreateTaskDraft, start: boolean, expectedRevision: number) => Promise<boolean> }) {
  const [edit, setEdit] = useState(() => draftEdit(task, profile));
  useEffect(() => { if (open) setEdit(draftEdit(task, profile)); }, [open, task.id]);
  return <Modal open={open} title="编辑任务" width={640} destroyOnHidden={false} maskClosable={!busy} keyboard={!busy} onCancel={() => { if (!busy) close(); }} footer={null}>
    <TaskComposer mode="edit" disabled={busy} draft={edit.fields} recentWorkspaces={recentWorkspaces}
      onDraft={value => setEdit(current => ({ ...current, fields: typeof value === 'function' ? value(current.fields) : value }))}
      onCreate={async (input, start) => { const ok = await save(input, start, edit.expectedRevision); if (ok) close(); return ok; }} />
  </Modal>;
}
