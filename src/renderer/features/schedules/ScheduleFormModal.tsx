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
  BUILTIN_HINT, BUILTIN_INTERVAL_DESC, CRON_DESC, EXECUTOR_DESC, EXECUTOR_ROLE_LABELS, GOAL_DESC, INTERVAL_DESC, TIMEOUT_DESC, WORKSPACE_DESC,
  buildExecutorOptions, builtinPatch, decodeExecutorValue, draftChanged, draftErrors, draftFromDefinition, emptyDraft, encodeExecutorValue, isExecutorAvailable, isRunning, scheduleInput, timingOf,
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
  agent: '创建独立任务并由所选执行 Agent 直接处理。父 Agent 可统筹复杂任务，子 Agent 直接执行简单任务。',
};

/**
 * One modal for creating and editing. The draft is component state, so a failed submit keeps
 * everything as typed; closing with unsaved changes asks before discarding. Builtin schedules
 * own only their timing and enabled switch; user schedules may leave the workspace blank.
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
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyError, setPolicyError] = useState('');
  const policyTicket = useRef(0);
  const mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const fieldId = useId();
  const zones = useMemo(() => listTimeZones(), []);
  useEffect(() => {
    if (!open) return;
    setDraft(definition ? draftFromDefinition(definition) : emptyDraft());
    setInitial(definition ? draftFromDefinition(definition) : emptyDraft());
    setConfirmDiscard(false);
    // Drop the previous snapshot so a stale policy can never offer options for the record now open.
    setPolicy(undefined);
    setPolicyError('');
    setPolicyLoading(true);
    const ticket = ++policyTicket.current;
    let current = true;
    if (!window.weaver) { setPolicyLoading(false); setPolicyError('执行 Agent 配置读取失败：当前环境不可用。'); return () => { current = false; }; }
    void window.weaver.getPolicy().then(snapshot => {
      if (!mounted.current || !current || ticket !== policyTicket.current) return;
      setPolicy(snapshot); setPolicyError(''); setPolicyLoading(false);
    })
      .catch(cause => {
        if (!mounted.current || !current || ticket !== policyTicket.current) return;
        setPolicyLoading(false);
        setPolicyError(cause instanceof Error ? cause.message : String(cause ?? '执行 Agent 配置读取失败'));
        notifyError(cause, '执行 Agent 配置读取失败');
      });
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
  const valid = Object.keys(errors).length === 0 && changed
    && (builtin || runningOnly || draft.kind !== 'agent' || isExecutorAvailable(policy, draft.executorRole, draft.executorProfile));
  const executorValue = draft.executorProfile ? encodeExecutorValue(draft.executorRole, draft.executorProfile) : undefined;
  const baseExecutorOptions = useMemo(() => buildExecutorOptions(policy), [policy]);
  const executorInBase = !!executorValue && baseExecutorOptions.some(option => option.value === executorValue);
  const executorAvailable = isExecutorAvailable(policy, draft.executorRole, draft.executorProfile);
  const executorOptions = useMemo(() => {
    // Only echo a saved-but-gone value after a successful read; while loading or failed
    // the select keeps its loading/empty placeholder instead of a misleading deleted row.
    if (policy && draft.executorProfile && executorValue && !executorInBase) {
      return [...baseExecutorOptions, {
        value: executorValue,
        label: `${draft.executorProfile} · ${EXECUTOR_ROLE_LABELS[draft.executorRole]} · 已删除或不可用`,
        disabled: true,
      }];
    }
    return baseExecutorOptions;
  }, [policy, baseExecutorOptions, draft.executorProfile, draft.executorRole, executorValue, executorInBase]);
  const reloadPolicy = () => {
    if (!open || policyLoading) return;
    const ticket = ++policyTicket.current;
    setPolicyLoading(true);
    setPolicyError('');
    if (!window.weaver) {
      setPolicyLoading(false);
      setPolicyError('执行 Agent 配置读取失败：当前环境不可用。');
      return;
    }
    void window.weaver.getPolicy().then(snapshot => {
      if (!mounted.current || ticket !== policyTicket.current) return;
      setPolicy(snapshot); setPolicyError(''); setPolicyLoading(false);
    }).catch(cause => {
      if (!mounted.current || ticket !== policyTicket.current) return;
      setPolicyLoading(false);
      setPolicyError(cause instanceof Error ? cause.message : String(cause ?? '执行 Agent 配置读取失败'));
      notifyError(cause, '执行 Agent 配置读取失败');
    });
  };
  const executorPlaceholder = policyLoading || (!policy && !policyError)
    ? '正在读取…'
    : policyError ? '读取失败，重试后选择' : (baseExecutorOptions.length ? '选择执行 Agent' : '没有可用的执行 Agent 配置');
  const fieldError = (key: keyof ReturnType<typeof draftErrors>) => errors[key]
    ? <p role="alert" className={styles.error}>{errors[key]}</p> : undefined;
  const executorInline = (() => {
    if (builtin || runningOnly || draft.kind !== 'agent') return undefined;
    if (policyLoading || (!policy && !policyError)) return { tone: 'status' as const, text: '正在读取执行 Agent 配置，已选内容和草稿会保留。' };
    if (policyError) return { tone: 'error' as const, text: `执行 Agent 配置读取失败：${policyError}` };
    if (policy && baseExecutorOptions.length === 0) return { tone: 'status' as const, text: '还没有可用的执行 Agent 配置，先去设置里启用后再重试读取。' };
    if (!draft.executorProfile) return undefined;
    if (!executorInBase) return { tone: 'error' as const, text: '已保存的执行配置已被删除，换成可用配置后才能提交执行内容。' };
    if (!executorAvailable) return { tone: 'error' as const, text: '所选执行配置当前不可用，换成可用配置后才能提交执行内容。' };
    return undefined;
  })();
  const executorExtra = (<>
    {fieldError('executor')}
    {executorInline && (executorInline.tone === 'error'
      ? <p role="alert" className={styles.error}>{executorInline.text}</p>
      : <p role="status" className={styles.meta}>{executorInline.text}</p>)}
    {(policyError || (policy && baseExecutorOptions.length === 0 && !builtin && !runningOnly && draft.kind === 'agent')) && (
      <div><Button size="small" disabled={policyLoading} loading={policyLoading} onClick={reloadPolicy}>重试读取</Button></div>
    )}
  </>);
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
          {!builtin && <Form.Field label="工作目录" desc={WORKSPACE_DESC} extra={fieldError('workspace')}>
            <WorkspacePicker value={draft.workspace} disabled={lockedField('workspace') || blocked} allowClear onChange={workspace => update({ workspace })} />
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
            <Form.Field label="任务目标" required desc={GOAL_DESC} extra={fieldError('goal')}>
              <TextArea id={`${fieldId}-goal`} aria-label="任务目标" disabled={lockedField('goal') || blocked} rows={3} maxLength={16000} value={draft.goal} placeholder="例如：核对 docs/ 与代码的差异并输出报告，项目在 /srv/site，允许只读检查" onChange={event => update({ goal: event.target.value })} />
            </Form.Field>
            <Form.Field label="执行 Agent" required desc={EXECUTOR_DESC} extra={executorExtra}>
              <NamedSelect id={`${fieldId}-executor`} aria-label="执行 Agent" showSearch disabled={lockedField('executorRole') || lockedField('executorProfile') || blocked} value={executorValue} placeholder={executorPlaceholder} options={executorOptions} onChange={value => {
                if (typeof value !== 'string') return;
                const decoded = decodeExecutorValue(value);
                if (decoded) update({ executorRole: decoded.role, executorProfile: decoded.profileId });
              }} />
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
