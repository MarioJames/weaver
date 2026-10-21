import type { Task } from '../../../shared/contracts/tasks';
import { notifyError } from '../../api/notify';
import type { CreateTaskDraft, TaskDraftFields } from './TaskComposer';

/** The composer's two submit paths. Both create and select the record; only 创建并开始 also asks the parent Agent to start. */
export async function createTask<Input>(input: Input, start: boolean, api: {
  create: (input: Input) => Promise<{ id: string }>;
  start: (id: string) => Promise<unknown>;
  select: (id: string) => void;
  /** The record exists; only its launch failed, so recovery retries the start and never creates a second task. */
  startFailed: (id: string, error: unknown) => void;
}): Promise<string> {
  const created = await api.create(input);
  api.select(created.id);
  if (!start) return created.id;
  try { await api.start(created.id); } catch (error) { api.startFailed(created.id, error); }
  return created.id;
}

/** The composer's fields for a draft that already exists; the parent Agent stays blank when its configuration cannot be found. */
export function draftFields(task: Pick<Task, 'instruction' | 'acceptanceCriteria' | 'workspace'>, profile = ''): TaskDraftFields {
  return { goal: task.instruction, criteria: (task.acceptanceCriteria ?? []).join('\n'), workspace: task.workspace ?? '', profile };
}

/** One opening of the edit dialog: the prefill fields and the revision read at that same moment. */
export interface DraftEdit { fields: TaskDraftFields; expectedRevision: number }
/** The dialog saves with this snapshot, so an edit made elsewhere surfaces as REVISION_CONFLICT instead of being silently overwritten. */
export function draftEdit(task: Pick<Task, 'instruction' | 'acceptanceCriteria' | 'workspace' | 'revision'>, profile = ''): DraftEdit {
  return { fields: draftFields(task, profile), expectedRevision: task.revision ?? 0 };
}

/** `tasks.update` arguments: cleared fields are sent as null (directory) or [] (criteria) so they really are cleared; the parent Agent only when it changed. */
export function taskUpdateArgs(task: Pick<Task, 'id' | 'revision'>, input: CreateTaskDraft, initialProfile: string): Record<string, unknown> {
  return {
    taskId: task.id,
    expectedRevision: task.revision,
    goal: input.goal,
    workspace: input.workspace ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    ...(input.ownerProfileId !== initialProfile ? { ownerProfileId: input.ownerProfileId } : {}),
  };
}

/** Saving a draft: 保存 only updates it; 保存并开始 then starts it. A failed update stops there, a failed start leaves the saved draft and reports it for a retry. */
export async function updateTask(args: Record<string, unknown>, start: boolean, api: {
  update: (args: Record<string, unknown>) => Promise<unknown>;
  start: (id: string) => Promise<unknown>;
  startFailed: (id: string, error: unknown) => void;
}): Promise<void> {
  await api.update(args);
  if (!start) return;
  const id = String(args.taskId);
  try { await api.start(id); } catch (error) { api.startFailed(id, error); }
}

/** Chinese explanations for the known draft-save failures; any other error keeps its own message. */
export function saveDraftFailureMessage(error: unknown): string | undefined {
  const raw = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
  if (raw.startsWith('REVISION_CONFLICT')) return '草稿已在其他地方更新。关闭弹窗后重新打开编辑，以免覆盖别人的修改。';
  if (raw.startsWith('INVALID_STATE')) return '任务已开始或不再是草稿，不能再编辑。';
  return undefined;
}

/** The one failure notice of a draft save: a single 保存草稿失败 overlay instead of the generic control-plane error. */
export function notifySaveDraftFailure(error: unknown): void {
  const message = saveDraftFailureMessage(error);
  if (message !== undefined) notifyError(message, '保存草稿失败');
  else notifyError(error, '保存草稿失败');
}
