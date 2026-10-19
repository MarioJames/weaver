import { notifyError } from '../notify';
import { NamedSelect } from './NamedControls';
import { useEffect, useId, useState, type Dispatch, type SetStateAction } from 'react';
import { Button, Input, Text, TextArea } from '@lobehub/ui/base-ui';
import { Form, useForm } from '@lobehub/ui/base-ui/form';
import type { PolicySnapshot } from '../../shared/policy';
import { styles } from '../style';
import { composerStyles } from './task-composer-style';

/** Browser tasks name an absolute project directory. Blank and `.` are not submitted. */
export function workspacePathError(value: string): string {
  const path = value.trim();
  if (!path) return '填写目标项目的绝对路径。';
  if (!path.startsWith('/')) return '需要目标项目的绝对路径，不能使用 . 或相对路径。';
  return '';
}

export interface CreateTaskDraft { title: string; goal: string; workspace: string; ownerProfileId: string; acceptanceCriteria: string[] }
export interface TaskDraftFields { title: string; goal: string; workspace: string; profile: string; acceptance: string }

export function TaskComposer({ disabled, draft, onDraft, onCreate, onImport }: { disabled: boolean; draft: TaskDraftFields; onDraft: Dispatch<SetStateAction<TaskDraftFields>>; onCreate: (input: CreateTaskDraft) => Promise<boolean>; onImport: () => void }) {
  const { title, goal, workspace, profile, acceptance } = draft;
  const fieldId = useId();
  const [policy, setPolicy] = useState<PolicySnapshot>();
  useEffect(() => {
    let current = true;
    if (!window.weaver) { notifyError('服务不可用。请通过 weaver web 打开这个页面后再读取 父 Agent 配置。'); return; }
    void window.weaver.getPolicy().then(snapshot => { if (current) { setPolicy(snapshot); onDraft(previous => previous.profile ? previous : { ...previous, profile: Object.keys(snapshot.config.owners).find(id => snapshot.owners[id]?.status === 'available') || '' }); } }).catch(cause => { if (current) notifyError(String(cause)); });
    return () => { current = false; };
  }, []);
  const criteria = acceptance.split('\n').map(line => line.trim()).filter(Boolean);
  const pathError = workspacePathError(workspace);
  const valid = Boolean(title.trim() && goal.trim() && !pathError && profile && criteria.length > 0 && criteria.length <= 30 && criteria.every(line => line.length <= 1000));
  const form = useForm({ onSubmit: () => { if (pathError) notifyError(pathError, '目标项目目录有误'); if (disabled || !valid || pathError) return; return onCreate({ title: title.trim(), goal: goal.trim(), workspace: workspace.trim(), ownerProfileId: profile, acceptanceCriteria: criteria }); } });
  return <Form form={form} layout="vertical" className={composerStyles.form}>
    <div className={styles.spread}><Button type="text" disabled={disabled} onClick={onImport}>导入 JSON</Button></div>
    <div className={composerStyles.scroll}><fieldset disabled={disabled} className={composerStyles.body}>
      <Form.Field label="任务标题" required><Input id={`${fieldId}-title`} aria-label="任务标题" required maxLength={160} value={title} placeholder="例如：整理本地集成说明" onChange={event => onDraft(current => ({ ...current, title: event.target.value }))} /></Form.Field>
      <Form.Field label="目标与约束" required><TextArea id={`${fieldId}-goal`} aria-label="目标与约束" required maxLength={16000} rows={4} value={goal} placeholder="例如：只改指定目录里的文档" onChange={event => onDraft(current => ({ ...current, goal: event.target.value }))} /></Form.Field>
      <Form.Field label="目标项目目录" required desc="绝对路径。留空或 . 不会提交，草稿保留。服务端仍会检查目录是否存在。">
        <Input id={`${fieldId}-workspace`} aria-label="目标项目目录" required maxLength={4000} value={workspace} placeholder="/home/user/project" onBlur={() => { if (pathError) notifyError(pathError, '目标项目目录有误'); }} onChange={event => onDraft(current => ({ ...current, workspace: event.target.value }))} />
      </Form.Field>
      <Form.Field label="父 Agent 配置" required><NamedSelect id={`${fieldId}-profile`} aria-label="父 Agent 配置" value={profile || undefined} placeholder={policy ? '选择可用父 Agent' : '正在读取…'} options={policy ? Object.keys(policy.config.owners).map(id => ({ value: id, label: `${id}${policy.owners[id]?.status === 'available' ? '' : ' · 不可用'}`, disabled: policy.owners[id]?.status !== 'available' })) : []} onChange={value => { if (typeof value === 'string') onDraft(current => ({ ...current, profile: value })); }} /></Form.Field>
      <Form.Field label="验收标准" required desc="每行一项，1–30 项，每项最多 1000 字。"><TextArea id={`${fieldId}-acceptance`} aria-label="验收标准" required maxLength={30000} rows={4} value={acceptance} placeholder={'例如：输出变更摘要\n列出验证结果'} onChange={event => onDraft(current => ({ ...current, acceptance: event.target.value }))} /></Form.Field>
      <Text type="secondary">创建时登记外部父 Agent 的逻辑引用，宿主引用未经验证，不会启动新的 AI。默认空闲 60 分钟后提醒手动接续；真实 CLI 自行读取接续包和切换上下文。</Text>
    </fieldset></div>
    <div className={composerStyles.footer}><Button htmlType="submit" type="primary" block disabled={disabled || !valid}>创建任务</Button></div>
  </Form>;
}
