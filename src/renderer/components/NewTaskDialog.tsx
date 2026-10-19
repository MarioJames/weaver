import { useState } from 'react';
import { Modal } from '@lobehub/ui/base-ui';
import { TaskComposer, type CreateTaskDraft, type TaskDraftFields } from './TaskComposer';

const emptyDraft: TaskDraftFields = { title: '', goal: '', workspace: '', profile: '', acceptance: '' };

export function NewTaskDialog({ open, busy, close, onClosed, create, importTask }: { open: boolean; busy: boolean; close: () => void; onClosed: () => void; create: (input: CreateTaskDraft) => Promise<boolean>; importTask: () => void }) {
  const [draft, setDraft] = useState(emptyDraft);
  return <Modal open={open} title="创建任务" width={640} destroyOnHidden={false} maskClosable={!busy} keyboard={!busy} afterClose={onClosed} onCancel={() => { if (!busy) close(); }} footer={null}>
    <TaskComposer disabled={busy} draft={draft} onDraft={setDraft} onCreate={async input => { const ok = await create(input); if (ok) { setDraft(current => ({ ...current, title: '', goal: '', acceptance: '' })); close(); } return ok; }} onImport={importTask} />
  </Modal>;
}
