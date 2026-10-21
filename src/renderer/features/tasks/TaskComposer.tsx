import { notifyError } from '../../api/notify';
import { WorkspacePicker } from './WorkspacePicker';
import { NamedSelect } from '../../ui/NamedControls';
import { useEffect, useId, useState, type Dispatch, type SetStateAction } from 'react';
import { Button, Text, TextArea } from '@lobehub/ui/base-ui';
import { Form, useForm } from '@lobehub/ui/base-ui/form';
import type { PolicySnapshot } from '../../../shared/contracts/policy';
import { styles } from '../../ui/styles';
import { composerStyles } from './task-composer-style';

/** A project directory is absolute when given; blank is an error only where it is required (starting a task), a draft may leave it open. `.` and relative paths are never submitted. */
export function workspacePathError(value: string, required = true): string {
  const path = value.trim();
  if (!path) return required ? '选择目标项目目录。' : '';
  if (!path.startsWith('/')) return '需要目标项目的绝对路径，不能使用 . 或相对路径。';
  return '';
}

/** What the composer submits. `workspace` and `acceptanceCriteria` are left out when blank: a draft may not have them yet. */
export interface CreateTaskDraft { goal: string; workspace?: string; ownerProfileId: string; acceptanceCriteria?: string[] }
/** `criteria` is one acceptance criterion per line; left empty, the parent Agent writes them once it takes the task over. */
export interface TaskDraftFields { goal: string; workspace: string; profile: string; criteria?: string }

/** One criterion per non-empty line. */
export const criteriaLines = (text: string | undefined): string[] => (text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
/** The server keeps 1–30 criteria of up to 1000 characters each. */
export function criteriaError(text: string | undefined): string {
  const lines = criteriaLines(text);
  if (lines.length > 30) return '验收标准最多 30 条。';
  if (lines.some(line => line.length > 1000)) return '每条验收标准不超过 1000 个字符。';
  return '';
}

/** The request body of one submit: only filled-in optional fields are present. */
export function composerInput({ goal, workspace, profile, criteria }: TaskDraftFields): CreateTaskDraft {
  const acceptanceCriteria = criteriaLines(criteria);
  return { goal: goal.trim(), ...(workspace.trim() ? { workspace: workspace.trim() } : {}), ownerProfileId: profile, ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}) };
}

/** `mode="edit"` reuses the same fields for a draft that already exists: 保存 / 保存并开始 instead of 存为草稿 / 创建并开始, and the parent Agent configuration is never picked for the user. */
export function TaskComposer({ disabled, draft, mode = 'create', recentWorkspaces, onDraft, onCreate }: { disabled: boolean; draft: TaskDraftFields; mode?: 'create' | 'edit'; recentWorkspaces?: string[]; onDraft: Dispatch<SetStateAction<TaskDraftFields>>; onCreate: (input: CreateTaskDraft, start: boolean) => Promise<boolean> }) {
  const { goal, workspace, profile, criteria = '' } = draft;
  const fieldId = useId();
  const [policy, setPolicy] = useState<PolicySnapshot>();
  useEffect(() => {
    let current = true;
    if (!window.weaver) { notifyError('服务不可用。请通过 weaver web 打开这个页面后再读取 父 Agent 配置。'); return; }
    void window.weaver.getPolicy().then(snapshot => { if (current) { setPolicy(snapshot); if (mode === 'create') onDraft(previous => previous.profile ? previous : { ...previous, profile: Object.keys(snapshot.config.owners).find(id => snapshot.owners[id]?.status === 'available') || '' }); } }).catch(cause => { if (current) notifyError(String(cause)); });
    return () => { current = false; };
  }, []);
  const editing = mode === 'edit';
  const criteriaProblem = criteriaError(criteria);
  /** Saving a draft needs the goal and a parent Agent; the directory is optional but must be absolute when filled in. Starting needs all of it. */
  const draftError = workspacePathError(workspace, false);
  const startError = workspacePathError(workspace);
  const canDraft = Boolean(goal.trim() && !draftError && !criteriaProblem && profile);
  const canStart = canDraft && !startError;
  /** Which button was pressed: only that one shows loading, and both stay disabled until the request settles. */
  const [pressed, setPressed] = useState<'start' | 'draft'>();
  const submit = async (start: boolean) => {
    const pathError = start ? startError : draftError;
    if (pathError) notifyError(pathError, '目标项目目录有误');
    if (disabled || pressed || !(start ? canStart : canDraft)) return;
    setPressed(start ? 'start' : 'draft');
    try { return await onCreate(composerInput(draft), start); } finally { setPressed(undefined); }
  };
  const form = useForm({ onSubmit: () => submit(true) });
  return <Form form={form} layout="vertical" className={composerStyles.form}>
    <div className={composerStyles.scroll}><fieldset disabled={disabled} className={composerStyles.body}>
      <Form.Field label="目标与约束" required><TextArea id={`${fieldId}-goal`} aria-label="目标与约束" required maxLength={16000} rows={4} value={goal} placeholder="例如：只改指定目录里的文档" onChange={event => onDraft(current => ({ ...current, goal: event.target.value }))} /></Form.Field>
      <Form.Field label="验收标准" desc="可留空：父 Agent 接手后会根据目标生成并填入。每行一条。">
        <TextArea id={`${fieldId}-criteria`} aria-label="验收标准" rows={3} maxLength={30000} value={criteria} placeholder="例如：README 的安装步骤逐条核对过&#10;不修改任何文件" onChange={event => onDraft(current => ({ ...current, criteria: event.target.value }))} />
        {criteriaProblem && <p role="alert" className={styles.error}>{criteriaProblem}</p>}
      </Form.Field>
      <Form.Field label="目标项目目录" desc={`选择已有工作区，或浏览 Weaver 服务所在机器上的其他文件夹。${editing ? '开始执行前必须填写。' : '存为草稿时可留空，开始执行前必须填写。'}`}>
        <WorkspacePicker value={workspace} disabled={disabled} allowClear recent={recentWorkspaces} onChange={workspace => onDraft(current => ({ ...current, workspace }))} />
      </Form.Field>
      <Form.Field label="父 Agent 配置" required><NamedSelect id={`${fieldId}-profile`} aria-label="父 Agent 配置" value={profile || undefined} placeholder={policy ? '选择可用父 Agent' : '正在读取…'} options={policy ? Object.keys(policy.config.owners).map(id => ({ value: id, label: `${id}${policy.owners[id]?.status === 'available' ? '' : ' · 不可用'}`, disabled: policy.owners[id]?.status !== 'available' })) : []} onChange={value => { if (typeof value === 'string') onDraft(current => ({ ...current, profile: value })); }} /></Form.Field>
      <Text type="secondary">{editing
        ? '「保存并开始」会在保存后立即在 Herdr 中启动父 Agent，由它生成任务标题和验收标准，拆分子任务并派发给子 Agent；「保存」只更新草稿，稍后仍可再编辑，并在详情中开始。'
        : '「创建并开始」会立即在 Herdr 中启动父 Agent，由它生成任务标题和验收标准，拆分子任务并派发给子 Agent；「存为草稿」只保存目标与约束，之后可在任务详情中编辑，补齐目标项目目录后再点「开始执行」。'}</Text>
    </fieldset></div>
    <div className={composerStyles.footer}>
      <Button htmlType="button" disabled={disabled || !canDraft} loading={disabled && pressed === 'draft'} onClick={() => void submit(false)}>{editing ? '保存' : '存为草稿'}</Button>
      <Button htmlType="submit" type="primary" disabled={disabled || !canStart} loading={disabled && pressed === 'start'}>{editing ? '保存并开始' : '创建并开始'}</Button>
    </div>
  </Form>;
}
