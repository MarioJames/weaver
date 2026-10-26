import { useState } from 'react';
import { Modal } from '@lobehub/ui';
import { TaskComposer, type CreateTaskDraft, type TaskDraftFields } from './TaskComposer';

const emptyDraft: TaskDraftFields = { goal: '', workspace: '', profile: '', criteria: '' };

export function NewTaskDialog({ open, busy, recentWorkspaces, close, onClosed, create }: { open: boolean; busy: boolean; recentWorkspaces?: string[]; close: () => void; onClosed: () => void; create: (input: CreateTaskDraft, start: boolean) => Promise<boolean> }) {
  const [draft, setDraft] = useState(emptyDraft);
  return <Modal open={open} title="创建任务" width={640} destroyOnHidden={false} maskClosable={!busy} keyboard={!busy} afterClose={onClosed} onCancel={() => { if (!busy) close(); }} footer={null}>
    <TaskComposer disabled={busy} draft={draft} recentWorkspaces={recentWorkspaces} onDraft={setDraft} onCreate={async (input, start) => { const ok = await create(input, start); if (ok) { setDraft(current => ({ ...current, goal: '', criteria: '' })); close(); } return ok; }} />
  </Modal>;
}
