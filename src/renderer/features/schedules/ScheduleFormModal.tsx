import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Segmented, TextArea, Text } from '@lobehub/ui/base-ui';
import { Form, useForm } from '@lobehub/ui/base-ui/form';
import type { PolicySnapshot } from '../../../shared/contracts/policy';
import type { ScheduleDefinition, ScheduleInput } from '../../../shared/contracts/schedules';
import { notifyError } from '../../api/notify';
import { NamedInputNumber, NamedSelect, NamedSwitch } from '../../ui/NamedControls';
import { listTimeZones } from '../../format/timezone';
import { WorkspacePicker } from '../tasks/WorkspacePicker';
import { schedulesStyles } from './schedules-style';
import { styles } from '../../ui/styles';
import {
  BUILTIN_HINT, BUILTIN_INTERVAL_DESC, CRON_DESC, INTERVAL_DESC, TIMEOUT_DESC, WORKSPACE_DESC,
  builtinPatch, draftChanged, draftErrors, draftFromDefinition, emptyDraft, isRunning, scheduleInput, timingOf,
  type ScheduleDraft,
} from './schedules-view';

export interface ScheduleSubmitRequest {
  /** The full payload when creating; one update patch when editing so enabled rides along atomically. */
  input: ScheduleInput | Partial<ScheduleInput>;
  /** Present when editing; create sends none. */
  scheduleId?: string;
  expectedRevision?: number;
}

/** The not-yet-confirmed intent the page is parked on, with its resolution actions. */
export interface SchedulePendingNotice {
  /** What the parked operation was called. */
  context: string;
  reason: string;
  checking: boolean;
  onVerify: () => void;
  onResend: () => void;
}

const KIND_OPTIONS = [
  { value: 'script' as const, label: '脚本' },
  { value: 'agent' as const, label: 'Agent' },
];

const TIMING_OPTIONS = [
  { value: 'interval' as const, label: '固定间隔' },
  { value: 'cron' as const, label: 'cron 表达式' },
];

const KIND_DESCRIPTIONS: Record<ScheduleDraft['kind'], string> = {
  script: '在本机系统 shell 中执行显式命令，适合备份、清理、巡检等固定动作。命令由 Weaver 服务账号运行，可以像普通程序一样调用 weaver CLI 等本机可执行文件。',
  agent: '创建独立的根任务并走父 Agent 链路，由它拆解派发，适合需要判断的工作。',
};

/**
 * One modal for creating and editing. The draft is component state, so a failed submit keeps
 * everything as typed; closing with unsaved changes asks before discarding. Builtin schedules
 * own only their timing and enabled switch; user schedules always need an existing workspace.
 */
export function ScheduleFormModal({ open, definition, active, busy, pendingNotice, close, onClosed, submit }: {
  open: boolean;
  /** Undefined creates a new schedule; otherwise the definition under edit. */
  definition?: ScheduleDefinition;
  /** Live run state can change while the definition/revision snapshot stays fixed. */
  active?: boolean;
  busy: boolean;
  /** Parked intent notice; buttons are wired to the page's gate. */
  pendingNotice?: SchedulePendingNotice;
  close: () => void;
  onClosed: () => void;
  submit: (request: ScheduleSubmitRequest) => Promise<boolean>;
}) {
  const builtin = !!definition && !!definition.builtin;
  const [draft, setDraft] = useState<ScheduleDraft>(() => definition ? draftFromDefinition(definition) : emptyDraft());
  const [initial, setInitial] = useState<ScheduleDraft>(() => definition ? draftFromDefinition(definition) : emptyDraft());
  const [submitting, setSubmitting] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [policy, setPolicy] = useState<PolicySnapshot>();
  const mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const fieldId = useId();
  const zones = useMemo(() => listTimeZones(), []);
  useEffect(() => {
    if (!open) return;
    setDraft(definition ? draftFromDefinition(definition) : emptyDraft());
    setInitial(definition ? draftFromDefinition(definition) : emptyDraft());
    setConfirmDiscard(false);
    let current = true;
    if (!window.weaver) return () => { current = false; };
    void window.weaver.getPolicy().then(snapshot => { if (current) setPolicy(snapshot); })
      .catch(cause => { if (current) notifyError(cause, '父 Agent 配置读取失败'); });
    return () => { current = false; };
    // The record id, not the object identity: a background refresh creates a new definition
    // object and must never wipe the draft being edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, definition?.id]);
  const editing = !!definition;
  // A run keeps its frozen execution fields: only the enabled switch may change while it is active.
  const runningOnly = editing && (active ?? isRunning(definition));
  const blocked = busy || submitting || !!pendingNotice;
  const errors = runningOnly ? {} : draftErrors(draft, builtin);
  // Only value-bearing edits get sent: builtin/quota and running records have nothing else to save.
  const changed = (() => {
    if (runningOnly) return draft.enabled !== definition?.enabled;
    if (builtin) return draft.enabled !== definition?.enabled || JSON.stringify(timingOf(draft)) !== JSON.stringify(definition?.timing);
    return draftChanged(draft, initial);
  })();
  const valid = Object.keys(errors).length === 0 && changed;
  const profileOptions = policy
    ? Object.keys(policy.config.owners).map(id => ({
        value: id,
        label: `${id}${!['claude','codex'].includes(policy.config.engines[policy.config.owners[id].engine]?.kind) ? ' · 不支持定时 Agent' : policy.owners[id]?.status === 'available' ? '' : ' · 不可用'}`,
        disabled: policy.owners[id]?.status !== 'available' || !['claude','codex'].includes(policy.config.engines[policy.config.owners[id].engine]?.kind),
      }))
    : [];
  const update = (patch: Partial<ScheduleDraft>) => setDraft(current => ({ ...current, ...patch }));
  const request = (): ScheduleSubmitRequest => {
    if (!definition) return { input: scheduleInput(draft) };
    // While a run is active the update patch carries just the switch; everything else stays frozen.
    if (runningOnly) return { input: { enabled: draft.enabled }, scheduleId: definition.id, expectedRevision: definition.revision };
    if (builtin) return { input: builtinPatch(draft, definition, runningOnly), scheduleId: definition.id, expectedRevision: definition.revision };
    return { input: scheduleInput(draft), scheduleId: definition.id, expectedRevision: definition.revision };
  };
  async function save() {
    if (blocked || !valid) return;
    setSubmitting(true);
    try {
      if (await submit(request()) && mounted.current) close();
    } finally { if(mounted.current)setSubmitting(false); }
  }
  const form = useForm({ onSubmit: () => void save() });
  /** Locked fields: whatever builtin editing or an active run may not touch. */
  const lockedField = (field: keyof ScheduleDraft): boolean => (runningOnly && field !== 'enabled')
    || (builtin && field !== 'enabled' && field !== 'timingMode' && field !== 'intervalSeconds' && field !== 'cron' && field !== 'timezone');
  const requestClose = () => {
    if(blocked)return;
    if (draftChanged(draft, initial) && !submitting) { setConfirmDiscard(true); return; }
    if (!submitting) close();
  };
  const fieldError = (key: keyof ReturnType<typeof draftErrors>) => errors[key]
    ? <p role="alert" className={styles.error}>{errors[key]}</p> : undefined;
  const minutesOf = (): number | undefined => draft.intervalSeconds === undefined ? undefined : draft.intervalSeconds / 60;
  return <>
    <Modal open={open} title={definition ? (builtin ? '编辑内置定时任务' : '编辑定时任务') : '新建定时任务'} width={640} destroyOnHidden={false} maskClosable={!blocked} keyboard={!blocked} afterClose={onClosed} onCancel={requestClose} footer={null}>
      <Form form={form} layout="vertical">
        {pendingNotice && <Alert type="warning" title={`上一次提交没有拿到完整回执：${pendingNotice.context}`} description={pendingNotice.reason}
          action={<>
            <Button size="small" loading={pendingNotice.checking} onClick={pendingNotice.onVerify}>核对结果</Button>
            <Button size="small" disabled={pendingNotice.checking} onClick={pendingNotice.onResend}>重试同一请求</Button>
          </>} />}
        {builtin && <Alert type="info" title={`内置任务：${BUILTIN_HINT}`} description="名称、类型、脚本内容和删除都不在这里修改；这里的启停和间隔与「设置」页的额度开关同源。" />}
        {runningOnly && <Alert type="warning" title="这个任务正在运行" description="执行内容在本次运行结束前不能修改，只能在此切换启用状态。" />}
        <div className={schedulesStyles.formBody}>
          {/* fieldError rides in `extra`, not as a second child: Field computes the visible
              label's htmlFor from a single direct element child's id, and an array—even with
              an undefined slot—enumerates as list children for it. */}
          <Form.Field label="名称" required desc={builtin ? BUILTIN_HINT : undefined} extra={fieldError('name')}>
            <Input id={`${fieldId}-name`} aria-label="名称" disabled={lockedField('name') || blocked} value={draft.name} maxLength={160} placeholder="例如：每夜整理任务看板" onChange={event => update({ name: event.target.value })} />
          </Form.Field>
          <Form.Field label="类型" required desc={editing ? '类型创建后不可更改。' : KIND_DESCRIPTIONS[draft.kind]}>
            <Segmented block value={draft.kind} options={KIND_OPTIONS} disabled={editing || lockedField('kind') || blocked} aria-label="任务类型" onChange={value => update({ kind: value })} />
          </Form.Field>
          {!builtin && <Form.Field label="时间规则" required desc={draft.timingMode === 'interval' ? INTERVAL_DESC : CRON_DESC}>
            <Segmented block value={draft.timingMode} options={TIMING_OPTIONS} disabled={lockedField('timingMode') || blocked} aria-label="时间规则" onChange={value => update({ timingMode: value })} />
          </Form.Field>}
          {draft.timingMode === 'interval'
            // No min/max/precision on the number boxes: they silently clamp on blur and would
            // save a value the user did not type. draftErrors already rejects missing, decimal,
            // negative and out-of-range values with the field's own inline text (SettingRows'
            // MinutesInput follows the same no-min/no-max pattern).
            ? builtin
              ? <Form.Field label="刷新间隔（分钟）" required desc={BUILTIN_INTERVAL_DESC} extra={fieldError('interval')}>
                  <NamedInputNumber id={`${fieldId}-interval`} aria-label="刷新间隔（分钟）" disabled={lockedField('intervalSeconds') || blocked} step={5} format={{ useGrouping: false }} value={minutesOf()} placeholder="15" style={{ inlineSize: 200 }} onChange={value => update({ intervalSeconds: value === undefined || value === null ? undefined : value * 60 })} />
                </Form.Field>
              : <Form.Field label="间隔秒数" required extra={fieldError('interval')}>
                  <NamedInputNumber id={`${fieldId}-interval`} aria-label="间隔秒数" disabled={lockedField('intervalSeconds') || blocked} step={1} format={{ useGrouping: false }} value={draft.intervalSeconds} placeholder="900" style={{ inlineSize: 200 }} onChange={value => update({ intervalSeconds: value ?? undefined })} />
                </Form.Field>
            : <div className={schedulesStyles.pair}>
                <Form.Field label="cron 表达式" required extra={fieldError('cron')}>
                  <Input id={`${fieldId}-cron`} aria-label="cron 表达式" disabled={lockedField('cron') || blocked} value={draft.cron} placeholder="*/15 * * * *" onChange={event => update({ cron: event.target.value })} />
                </Form.Field>
                <Form.Field label="时区" required desc="表达式按这个时区解释。" extra={fieldError('timezone')}>
                  <NamedSelect id={`${fieldId}-timezone`} aria-label="时区" showSearch disabled={lockedField('timezone') || blocked} value={draft.timezone || undefined} placeholder="选择时区" options={zones.map(zone => ({ value: zone, label: zone }))} onChange={value => { if (typeof value === 'string') update({ timezone: value }); }} />
                </Form.Field>
              </div>}
          {!builtin && <Form.Field label="工作目录" required desc={WORKSPACE_DESC} extra={fieldError('workspace')}>
            <WorkspacePicker value={draft.workspace} disabled={lockedField('workspace') || blocked} onChange={workspace => update({ workspace })} />
          </Form.Field>}
          {draft.kind === 'script' && !builtin && <>
            <Form.Field label="执行脚本" required desc={KIND_DESCRIPTIONS.script} extra={fieldError('command')}>
              <TextArea id={`${fieldId}-command`} aria-label="命令" disabled={lockedField('command') || blocked} rows={3} maxLength={16000} value={draft.command} placeholder="例如：rsync -a /srv/data/ /backup/data/" onChange={event => update({ command: event.target.value })} />
            </Form.Field>
            <Form.Field label="超时秒数" required desc={TIMEOUT_DESC} extra={fieldError('timeout')}>
              <NamedInputNumber id={`${fieldId}-timeout`} aria-label="超时秒数" disabled={lockedField('timeoutSeconds') || blocked} step={1} format={{ useGrouping: false }} value={draft.timeoutSeconds} placeholder="3600" style={{ inlineSize: 200 }} onChange={value => update({ timeoutSeconds: value ?? undefined })} />
            </Form.Field>
          </>}
          {draft.kind === 'agent' && !builtin && <>
            <Form.Field label="目标" required extra={fieldError('goal')}>
              <TextArea id={`${fieldId}-goal`} aria-label="目标" disabled={lockedField('goal') || blocked} rows={3} maxLength={16000} value={draft.goal} placeholder="例如：核对文档与代码的差异并输出报告" onChange={event => update({ goal: event.target.value })} />
            </Form.Field>
            <Form.Field label="父 Agent 配置" required desc="使用已保存的策略配置；不可用的配置不能选择。" extra={fieldError('profile')}>
              <NamedSelect id={`${fieldId}-profile`} aria-label="父 Agent 配置" disabled={lockedField('profile') || blocked} value={draft.profile || undefined} placeholder={policy ? '选择父 Agent 配置' : '正在读取…'} options={profileOptions} onChange={value => { if (typeof value === 'string') update({ profile: value }); }} />
            </Form.Field>
            <Form.Field label="验收标准" desc="可留空：父 Agent 会根据目标生成。每行一条，最多 30 条。" extra={fieldError('criteria')}>
              <TextArea id={`${fieldId}-criteria`} aria-label="验收标准" disabled={lockedField('criteria') || blocked} rows={3} maxLength={30000} value={draft.criteria} placeholder="例如：报告包含新增与删除两类条目&#10;不修改任何文件" onChange={event => update({ criteria: event.target.value })} />
            </Form.Field>
            <Form.Field label="约束" desc="每行一条，最多 30 条，用于限制 Agent 的操作范围。" extra={fieldError('constraints')}>
              <TextArea id={`${fieldId}-constraints`} aria-label="约束" disabled={lockedField('constraints') || blocked} rows={2} maxLength={30000} value={draft.constraints} placeholder="例如：只在 docs/ 目录内操作" onChange={event => update({ constraints: event.target.value })} />
            </Form.Field>
          </>}
          <Form.Field label="启用" desc={builtin
            ? '停用后不再按时间规则触发；正在进行的刷新不受影响，这里与「设置」页的额度开关同源。'
            : '停用后不再按时间规则自动触发；仍能在这里或列表里手动执行。'}>
            <NamedSwitch id={`${fieldId}-enabled`} aria-label="启用" disabled={lockedField('enabled') || blocked} checked={draft.enabled} onChange={checked => update({ enabled: checked })} />
          </Form.Field>
          {!editing && <Text type="secondary">保存后按时间规则触发；停用的任务不会自动运行，但仍可在这里手动执行。</Text>}
        </div>
        <div className={schedulesStyles.footer}>
          <Button htmlType="button" disabled={blocked} onClick={requestClose}>取消</Button>
          <Button htmlType="submit" type="primary" disabled={!valid || blocked} loading={submitting}>{builtin ? '保存内置任务' : editing ? '保存修改' : '创建'}</Button>
        </div>
      </Form>
    </Modal>
    <Modal open={confirmDiscard} title="放弃未保存的修改？" width={420} onCancel={() => setConfirmDiscard(false)} footer={<>
      <Button htmlType="button" onClick={() => setConfirmDiscard(false)}>继续编辑</Button>
      <Button htmlType="button" danger type="primary" onClick={() => { setConfirmDiscard(false); close(); }}>放弃修改</Button>
    </>}>关闭后这次修改不会保存。</Modal>
  </>;
}
