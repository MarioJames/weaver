import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowLeft, Play, Plus, RefreshCw, Search, Square, Trash2 } from 'lucide-react';
import { ActionIcon, Alert, Button, Empty, Input, Modal, Segmented, Skeleton, Tag, Text, TextArea } from '@lobehub/ui';
import { TitleWithTips } from '@lobehub/ui/dashboard';
import { PageHeader } from '../../app/PageHeader';
import { Form, useForm } from '@lobehub/ui/form';
import { command } from '../../api/commands';
import { notifyError, notifyInfo } from '../../api/notify';
import { navigate, useRoute } from '../../app/router';
import { tagColor, statusTagColor } from '../../format/tag-colors';
import { listTimeZones } from '../../format/timezone';
import { MasterDetail } from '../../ui/MasterDetail';
import { Pane } from '../../ui/Pane';
import { SaveBar } from '../../ui/SaveBar';
import { SelectableList } from '../../ui/SelectableList';
import { TimeText } from '../../ui/TimeText';
import { NamedInputNumber, NamedSelect, NamedSwitch } from '../../ui/NamedControls';
import { useDraftGuard } from '../../ui/useDraftGuard';
import { styles } from '../../ui/styles';
import { WorkspacePicker } from '../tasks/WorkspacePicker';
import { schedulesStyles } from './schedules-style';
import type { SchedulePendingNotice } from './schedule-types';
import { ScheduleHistoryList } from './ScheduleHistoryList';
import { useSchedules } from './useSchedules';
import { readMutationReceipt, ScheduleMutationGate, type UnconfirmedIntent } from './schedule-mutations';
import type { PolicySnapshot } from '../../../shared/contracts/policy';
import {
  BUILTIN_HINT, BUILTIN_LABEL, BUILTIN_INTERVAL_DESC, CRON_DESC, EXECUTOR_DESC, EXECUTOR_ROLE_LABELS, GOAL_DESC, INTERVAL_DESC, KIND_LABELS,
  RUN_LABELS, RUN_TONES, TIMEOUT_DESC, WORKSPACE_DESC, buildExecutorOptions, decodeExecutorValue, draftChanged, draftErrors,
  draftFromDefinition, emptyDraft, encodeExecutorValue, executorOfDefinition, isExecutorAvailable, isBuiltinQuota, isRunning, scheduleInput, timingOf, timingText,
  type ScheduleDraft,
} from './schedules-view';
import type { ScheduleDefinition } from '../../../shared/contracts/schedules';

type KindFilter = 'all' | ScheduleDefinition['kind'];

const KIND_FILTER_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'script', label: '脚本' },
  { value: 'agent', label: 'Agent' },
];

/** The parked-intent notice sits in a fixed zone under the detail header, never inside the list. */
function PendingNotice({ notice }: { notice: SchedulePendingNotice }): ReactNode {
  return <Alert type="warning" title={`上一次提交没有拿到完整回执：${notice.context}`} description={notice.reason}
    action={<>
      <Button size="small" loading={notice.checking} onClick={notice.onVerify}>核对结果</Button>
      <Button size="small" disabled={notice.checking} onClick={notice.onResend}>重试同一请求</Button>
    </>} />;
}

/**
 * One schedule mutation at a time through the stable-intent gate; state stays local to this page.
 * Results lost in transport keep the intent plus its committee actions, and nothing new is sent
 * until that intent has a verdict.
 */
function useScheduleMutations(settle: () => void) {
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<UnconfirmedIntent>();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const gate = useMemo(() => new ScheduleMutationGate({
    send: mutation => command(mutation.command, mutation.args, true, mutation.commandId),
    readReceipt: readMutationReceipt,
    busy: value => { if (mounted.current) setBusy(value); },
    checking: value => { if (mounted.current) setChecking(value); },
    pending: value => { if (mounted.current) setPending(value); },
    settle: () => { if (mounted.current) settle(); },
    rejected: (error, context) => {
      if (!mounted.current) return;
      const conflict = error && typeof error === 'object' && 'code' in error && error.code === 'REVISION_CONFLICT';
      notifyError(conflict ? new Error('定时任务已被其他操作修改，草稿已保留。请刷新后核对最新内容再保存。') : error, context);
    },
    applied: (result, intent, confirmed) => {
      if (!mounted.current) return;
      if (!intent.applied) notifyInfo(confirmed ? '已核对：该操作已生效。' : '操作已完成。');
      intent.applied?.(result);
    },
  }), [settle]);
  return { busy, checking, pending, paused: busy || !!pending, gate };
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
  agent: '创建独立任务并由所选执行者直接处理。父 Agent 可统筹复杂任务，子 Agent 直接执行简单任务。',
};

/** The inline configuration form: the modal's fields as a page draft, saved through the SaveBar. */
function ScheduleConfigForm({ draft, initial, definition, active, blocked, policy, policyLoading, policyError, reloadPolicy, update }: {
  draft: ScheduleDraft;
  initial: ScheduleDraft;
  /** Undefined when creating; otherwise the live record under edit. */
  definition?: ScheduleDefinition;
  /** A run keeps its frozen execution fields while active. */
  active: boolean;
  blocked: boolean;
  policy?: PolicySnapshot;
  policyLoading: boolean;
  policyError: string;
  reloadPolicy: () => void;
  update: (patch: Partial<ScheduleDraft>) => void;
}) {
  const editing = !!definition;
  const builtin = !!definition && !!definition.builtin;
  const runningOnly = editing && active;
  const fieldId = useRef(`schedule-${definition?.id ?? 'new'}`).current;
  const zones = useMemo(() => listTimeZones(), []);
  const errors = runningOnly ? {} : draftErrors(draft, builtin);
  const executorValue = draft.executorProfile ? encodeExecutorValue(draft.executorRole, draft.executorProfile) : undefined;
  const baseExecutorOptions = useMemo(() => buildExecutorOptions(policy), [policy]);
  const executorInBase = !!executorValue && baseExecutorOptions.some(option => option.value === executorValue);
  const executorAvailable = isExecutorAvailable(policy, draft.executorRole, draft.executorProfile);
  const executorOptions = useMemo(() => {
    if (policy && draft.executorProfile && executorValue && !executorInBase) {
      return [...baseExecutorOptions, {
        value: executorValue,
        label: `${draft.executorProfile} · ${EXECUTOR_ROLE_LABELS[draft.executorRole]} · 已删除或不可用`,
        disabled: true,
      }];
    }
    return baseExecutorOptions;
  }, [policy, baseExecutorOptions, draft.executorProfile, draft.executorRole, executorValue, executorInBase]);
  const executorPlaceholder = policyLoading || (!policy && !policyError)
    ? '正在读取…'
    : policyError ? '读取失败，重试后选择' : (baseExecutorOptions.length ? '选择执行者' : '没有可用的执行者配置');
  const fieldError = (key: keyof ReturnType<typeof draftErrors>) => errors[key]
    ? <p role="alert" className={stylex.props(styles.error).className}>{errors[key]}</p> : undefined;
  const executorInline = (() => {
    if (builtin || runningOnly || draft.kind !== 'agent') return undefined;
    if (policyLoading || (!policy && !policyError)) return { tone: 'status' as const, text: '正在读取执行者配置，已选内容和草稿会保留。' };
    if (policyError) return { tone: 'error' as const, text: `执行者配置读取失败：${policyError}` };
    if (policy && baseExecutorOptions.length === 0) return { tone: 'status' as const, text: '还没有可用的执行者配置，先去设置里启用后再重试读取。' };
    if (!draft.executorProfile) return undefined;
    if (!executorInBase) return { tone: 'error' as const, text: '已保存的执行配置已被删除，换成可用配置后才能提交执行内容。' };
    if (!executorAvailable) return { tone: 'error' as const, text: '所选执行配置当前不可用，换成可用配置后才能提交执行内容。' };
    return undefined;
  })();
  const executorExtra = (<>
    {fieldError('executor')}
    {executorInline && (executorInline.tone === 'error'
      ? <p role="alert" className={stylex.props(styles.error).className}>{executorInline.text}</p>
      : <p role="status" className={stylex.props(styles.meta).className}>{executorInline.text}</p>)}
    {(policyError || (policy && baseExecutorOptions.length === 0 && !builtin && !runningOnly && draft.kind === 'agent')) && (
      <div><Button size="small" disabled={policyLoading} loading={policyLoading} onClick={reloadPolicy}>重试读取</Button></div>
    )}
  </>);
  /** Locked fields: whatever builtin editing or an active run may not touch. */
  const lockedField = (field: keyof ScheduleDraft): boolean => runningOnly
    || (builtin && field !== 'timingMode' && field !== 'intervalSeconds' && field !== 'cron' && field !== 'timezone');
  const minutesOf = (): number | undefined => draft.intervalSeconds === undefined ? undefined : draft.intervalSeconds / 60;
  if (runningOnly) {
    return <Alert type="warning" title="这个任务正在运行" description="执行内容在本次运行结束前不能修改，只能在头部切换启用状态。" />;
  }
  return <div {...stylex.props(schedulesStyles.formBody)}>
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
      ? builtin
        ? <Form.Field label="刷新间隔（分钟）" required desc={BUILTIN_INTERVAL_DESC} extra={fieldError('interval')}>
          <NamedInputNumber id={`${fieldId}-interval`} aria-label="刷新间隔（分钟）" disabled={lockedField('intervalSeconds') || blocked} step={5} format={{ useGrouping: false }} value={minutesOf()} placeholder="15" className={stylex.props(schedulesStyles.intervalInput).className} onChange={value => update({ intervalSeconds: value === undefined || value === null ? undefined : value * 60 })} />
        </Form.Field>
        : <Form.Field label="间隔秒数" required desc={INTERVAL_DESC} extra={fieldError('interval')}>
          <NamedInputNumber id={`${fieldId}-interval`} aria-label="间隔秒数" disabled={lockedField('intervalSeconds') || blocked} step={1} format={{ useGrouping: false }} value={draft.intervalSeconds} placeholder="900" className={stylex.props(schedulesStyles.intervalInput).className} onChange={value => update({ intervalSeconds: value ?? undefined })} />
        </Form.Field>
      : <div {...stylex.props(schedulesStyles.pair)}>
        <Form.Field label="cron 表达式" required desc={CRON_DESC} extra={fieldError('cron')}>
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
        <NamedInputNumber id={`${fieldId}-timeout`} aria-label="超时秒数" disabled={lockedField('timeoutSeconds') || blocked} step={1} format={{ useGrouping: false }} value={draft.timeoutSeconds} placeholder="3600" className={stylex.props(schedulesStyles.intervalInput).className} onChange={value => update({ timeoutSeconds: value ?? undefined })} />
      </Form.Field>
    </>}
    {draft.kind === 'agent' && !builtin && <>
      <Form.Field label="任务目标" required desc={GOAL_DESC} extra={fieldError('goal')}>
        <TextArea id={`${fieldId}-goal`} aria-label="任务目标" disabled={lockedField('goal') || blocked} rows={3} maxLength={16000} value={draft.goal} placeholder="例如：核对 docs/ 与代码的差异并输出报告，项目在 /srv/site，允许只读检查" onChange={event => update({ goal: event.target.value })} />
      </Form.Field>
      <Form.Field label="执行者" required desc={EXECUTOR_DESC} extra={executorExtra}>
        <NamedSelect id={`${fieldId}-executor`} aria-label="执行者" showSearch disabled={lockedField('executorRole') || lockedField('executorProfile') || blocked} value={executorValue} placeholder={executorPlaceholder} options={executorOptions} onChange={value => {
          if (typeof value !== 'string') return;
          const decoded = decodeExecutorValue(value);
          if (decoded) update({ executorRole: decoded.role, executorProfile: decoded.profileId });
        }} />
      </Form.Field>
    </>}
    {!editing && <Form.Field label="启用" desc="停用后不再按时间规则自动触发；仍能在这里或列表里手动执行。">
      <NamedSwitch id={`${fieldId}-enabled`} aria-label="启用" disabled={blocked} checked={draft.enabled} onChange={checked => update({ enabled: checked })} />
    </Form.Field>}
    {!editing && <Text type="secondary">保存后按时间规则触发；停用的任务不会自动运行，但仍可手动执行。</Text>}
    {void initial}
  </div>;
}

/** The detail pane: header actions, fixed write-lock zone, config draft and inline history. */
function ScheduleDetail({ schedule, creating, busy, checking, pending, paused, gate, onPolicyChanged, onCreated, onBack, registerGuard }: {
  schedule?: ScheduleDefinition;
  creating: boolean;
  busy: boolean;
  checking: boolean;
  pending?: UnconfirmedIntent;
  paused: boolean;
  gate: ScheduleMutationGate;
  onPolicyChanged?: () => void;
  onCreated: (id?: string) => void;
  onBack: () => void;
  registerGuard: (guard: (next: () => void) => void) => void;
}) {
  const live = creating ? undefined : schedule;
  const builtin = !!live?.builtin;
  const active = !!live && isRunning(live);
  const [draft, setDraft] = useState<ScheduleDraft>(() => live ? draftFromDefinition(live) : emptyDraft());
  const [initial] = useState<ScheduleDraft>(() => live ? draftFromDefinition(live) : emptyDraft());
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [policy, setPolicy] = useState<PolicySnapshot>();
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policyError, setPolicyError] = useState('');
  const policyTicket = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setPolicy(undefined);
    setPolicyError('');
    setPolicyLoading(true);
    const ticket = ++policyTicket.current;
    let current = true;
    if (!window.weaver) { setPolicyLoading(false); setPolicyError('执行者配置读取失败：当前环境不可用。'); return () => { current = false; }; }
    void window.weaver.getPolicy().then(snapshot => {
      if (!mounted.current || !current || ticket !== policyTicket.current) return;
      setPolicy(snapshot); setPolicyError(''); setPolicyLoading(false);
    })
      .catch(cause => {
        if (!mounted.current || !current || ticket !== policyTicket.current) return;
        setPolicyLoading(false);
        setPolicyError(cause instanceof Error ? cause.message : String(cause ?? '执行者配置读取失败'));
        notifyError(cause, '执行者配置读取失败');
      });
    return () => { current = false; };
  }, []);
  // The header switch commits immediately; keep the draft's copy aligned so a later
  // save never reverts the toggle through the stale snapshot.
  useEffect(() => {
    if (!live || creating) return;
    setDraft(current => current.enabled === live.enabled ? current : { ...current, enabled: live.enabled });
  }, [live?.enabled, creating]);
  const update = (patch: Partial<ScheduleDraft>) => setDraft(current => ({ ...current, ...patch }));
  const reloadPolicy = () => {
    if (policyLoading) return;
    const ticket = ++policyTicket.current;
    setPolicyLoading(true);
    setPolicyError('');
    if (!window.weaver) {
      setPolicyLoading(false);
      setPolicyError('执行者配置读取失败：当前环境不可用。');
      return;
    }
    void window.weaver.getPolicy().then(snapshot => {
      if (!mounted.current || ticket !== policyTicket.current) return;
      setPolicy(snapshot); setPolicyError(''); setPolicyLoading(false);
    }).catch(cause => {
      if (!mounted.current || ticket !== policyTicket.current) return;
      setPolicyLoading(false);
      setPolicyError(cause instanceof Error ? cause.message : String(cause ?? '执行者配置读取失败'));
      notifyError(cause, '执行者配置读取失败');
    });
  };
  const changed = creating
    ? draftChanged(draft, initial)
    : active
      ? false
      : builtin
        ? JSON.stringify(timingOf(draft)) !== JSON.stringify(live?.timing)
        : draftChanged({ ...draft, enabled: initial.enabled }, initial);
  const errors = active ? {} : draftErrors(draft, builtin);
  const executorReady = builtin || active || draft.kind !== 'agent' || isExecutorAvailable(policy, draft.executorRole, draft.executorProfile);
  const valid = Object.keys(errors).length === 0 && changed && executorReady;
  const dirty = changed;
  const { guard, dialog } = useDraftGuard(dirty);
  useEffect(() => { registerGuard(guard); }, [guard, registerGuard]);
  const blocked = busy || submitting || !!pending;
  const form = useForm({ onSubmit: () => void save() });
  const notice: SchedulePendingNotice | undefined = pending ? {
    context: pending.context,
    reason: pending.reason,
    checking,
    onVerify: () => void gate.verify(),
    onResend: () => void gate.resend(),
  } : undefined;
  async function save() {
    if (blocked || !valid || !mounted.current) return;
    if (!live) {
      setSubmitting(true);
      try {
        await gate.run('schedules.create', { ...scheduleInput(draft) }, '创建定时任务失败', result => {
          const id = (result as ScheduleDefinition | undefined)?.id ?? (result as { id?: string } | undefined)?.id;
          notifyInfo(`已创建${draft.name.trim() ? `「${draft.name.trim()}」` : '定时任务'}。`);
          onCreated(id);
        });
      } finally { if (mounted.current) setSubmitting(false); }
      return;
    }
    const patch: Partial<import('../../../shared/contracts/schedules').ScheduleInput> = builtin
      ? { timing: timingOf(draft) }
      : { ...scheduleInput(draft), enabled: live.enabled };
    setSubmitting(true);
    try {
      await gate.run('schedules.update',
        { scheduleId: live.id, expectedRevision: live.revision, patch },
        '保存定时任务失败', () => {
          if (isBuiltinQuota(live)) onPolicyChanged?.();
          notifyInfo('修改已保存。');
        });
    } finally { if (mounted.current) setSubmitting(false); }
  }
  function discard() {
    if (live && !creating) {
      setDraft({ ...draftFromDefinition(live), enabled: live.enabled });
    } else {
      setDraft(emptyDraft());
    }
  }
  const toggle = (enabled: boolean) => {
    if (!live) return;
    void gate.run('schedules.' + (enabled ? 'enable' : 'disable'), { scheduleId: live.id, expectedRevision: live.revision }, enabled ? '启用失败' : '停用失败',
      isBuiltinQuota(live) ? () => onPolicyChanged?.() : undefined);
  };
  const runNow = () => {
    if (!live) return;
    void gate.run('schedules.run', { scheduleId: live.id, expectedRevision: live.revision }, '立即运行失败');
  };
  const stopRun = (runId?: string) => {
    if (!live) return;
    const target = runId ?? live.activeRunId;
    if (!target) return;
    void gate.run('schedules.cancel', { scheduleId: live.id, runId: target }, '停止运行失败');
  };
  const destroy = () => {
    if (!live) return;
    void gate.run('schedules.delete', { scheduleId: live.id, expectedRevision: live.revision }, '删除定时任务失败',
      () => { notifyInfo(`已删除 ${live.name}`); setDeleting(false); navigate({ page: 'schedules' }); });
  };
  if (!live) {
    return <Pane label="新建定时任务" title={<span {...stylex.props(schedulesStyles.detailTitleLine)}>
      <Button className={stylex.props(schedulesStyles.back).className} size="small" icon={ArrowLeft} aria-label="返回列表" onClick={onBack}>返回</Button>
      <span {...stylex.props(schedulesStyles.detailName)}>新建定时任务</span>
    </span>} footer={<SaveBar dirty={dirty} saving={submitting} onSave={() => void save()} onDiscard={discard} saveDisabled={!valid || blocked} />}>
      <div {...stylex.props(schedulesStyles.detailBody)}>
        <section {...stylex.props(schedulesStyles.section)} aria-label="配置">
          <h2 {...stylex.props(schedulesStyles.sectionTitle)}>配置</h2>
          <Form form={form} layout="vertical">
            <ScheduleConfigForm draft={draft} initial={initial} active={false} blocked={blocked} policy={policy} policyLoading={policyLoading} policyError={policyError} reloadPolicy={reloadPolicy} update={update} />
          </Form>
        </section>
      </div>
      {dialog}
    </Pane>;
  }
  return <Pane
    label="定时任务详情"
    title={<span {...stylex.props(schedulesStyles.detailTitleLine)}>
      <Button className={stylex.props(schedulesStyles.back).className} size="small" icon={ArrowLeft} aria-label="返回列表" onClick={onBack}>返回</Button>
      <span {...stylex.props(schedulesStyles.detailName)} title={live.name}>{live.name}</span>
    </span>}
    actions={<div {...stylex.props(schedulesStyles.detailActions)}>
      <Tag size="small" color={tagColor(isBuiltinQuota(live) ? 'neutral' : 'childRole')}>{KIND_LABELS[live.kind]}</Tag>
      {isBuiltinQuota(live) && <Tag size="small" title={BUILTIN_HINT}>{BUILTIN_LABEL}</Tag>}
      <NamedSwitch size="small" aria-label={`启用 ${live.name}`} checked={live.enabled} disabled={paused} onChange={toggle} />
      {active
        ? <Button size="small" icon={Square} disabled={paused} aria-label={`停止 ${live.name} 的活跃运行`} onClick={() => stopRun()}>停止</Button>
        : <Button size="small" icon={Play} disabled={paused} aria-label={`立即运行 ${live.name}`} onClick={runNow}>运行</Button>}
      {!isBuiltinQuota(live) && <Button size="small" icon={Trash2} danger disabled={paused || active}
        title={active ? '有正在进行的运行，结束后才能删除。' : undefined}
        aria-label={`删除 ${live.name}`} onClick={() => setDeleting(true)}>删除</Button>}
    </div>}
    footer={<SaveBar dirty={dirty} saving={submitting} onSave={() => void save()} onDiscard={discard} saveDisabled={!valid || blocked} />}
  >
    {notice && <div {...stylex.props(schedulesStyles.pendingZone)}><PendingNotice notice={notice} /></div>}
    <div {...stylex.props(schedulesStyles.detailBody)}>
      <section {...stylex.props(schedulesStyles.section)} aria-label="配置">
        <h2 {...stylex.props(schedulesStyles.sectionTitle)}>配置</h2>
        <Form form={form} layout="vertical">
          <ScheduleConfigForm draft={draft} initial={initial} definition={live} active={active} blocked={blocked} policy={policy} policyLoading={policyLoading} policyError={policyError} reloadPolicy={reloadPolicy} update={update} />
        </Form>
      </section>
      <section {...stylex.props(schedulesStyles.section)} aria-label="运行历史">
        <h2 {...stylex.props(schedulesStyles.sectionTitle)}>运行历史</h2>
        <ScheduleHistoryList schedule={live} cancelBusy={paused} onCancelRun={stopRun} />
      </section>
    </div>
    <Modal open={deleting} title="删除定时任务？" width={440} maskClosable={!paused} onCancel={() => { if (!paused) setDeleting(false); }} footer={<>
      <Button htmlType="button" disabled={paused} onClick={() => setDeleting(false)}>取消</Button>
      <Button htmlType="button" danger type="primary" loading={busy} disabled={paused} onClick={destroy}>删除</Button>
    </>}>
      {pending?.mutation.command === 'schedules.delete' && notice && <PendingNotice notice={notice} />}
      <Text>将删除「{live.name}」这个定时任务定义及其全部运行历史；正在运行的任务不能删除；此操作不能撤销。</Text>
      {active && <Alert type="warning" title="这个任务正在运行" description="等本次运行结束（或先停止它）再删除。" />}
    </Modal>
    {dialog}
  </Pane>;
}

/** The schedules management page: master-detail list, inline config draft and inline history. */
export function SchedulesPage({ onPolicyChanged }: {
  /** The builtin quota schedule writes the quota settings; the saved policy view refreshes with it. */
  onPolicyChanged?: () => void;
} = {}) {
  const route = useRoute();
  const selectedId = route.page === 'schedules' ? route.id : undefined;
  const { schedules, loading, error, stale, problem, refresh, retry } = useSchedules();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [creating, setCreating] = useState(false);
  const [narrowList, setNarrowList] = useState(false);
  const [now, setNow] = useState(Date.now);
  const searchRef = useRef<HTMLInputElement>(null);
  const guardRef = useRef<(next: () => void) => void>(next => next());
  const { busy, checking, pending, paused, gate } = useScheduleMutations(refresh);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => (schedules ?? []).filter(item =>
    (kind === 'all' || item.kind === kind)
    && (!query || item.name.toLowerCase().includes(query)
      || (item.script?.command ?? '').toLowerCase().includes(query)
      || (item.agent?.goal ?? '').toLowerCase().includes(query)
      || (executorOfDefinition(item)?.profileId ?? '').toLowerCase().includes(query))), [schedules, kind, query]);
  // No id in the URL: settle on the first visible schedule without pushing history.
  useEffect(() => {
    if (route.page !== 'schedules' || selectedId || creating || loading || !schedules) return;
    const first = filtered[0] ?? schedules[0];
    if (first) navigate({ page: 'schedules', id: first.id }, { replace: true });
  }, [route.page, selectedId, creating, loading, schedules, filtered]);
  const selected = creating ? undefined : selectedId ? schedules?.find(item => item.id === selectedId) : undefined;
  const missing = !creating && !!selectedId && !!schedules && !selected;
  const toggle = (schedule: ScheduleDefinition, enabled: boolean) => {
    void gate.run('schedules.' + (enabled ? 'enable' : 'disable'), { scheduleId: schedule.id, expectedRevision: schedule.revision }, enabled ? '启用失败' : '停用失败',
      isBuiltinQuota(schedule) ? () => onPolicyChanged?.() : undefined);
  };
  const select = (id: string) => {
    if (id === selectedId && !creating) return;
    guardRef.current(() => { setCreating(false); setNarrowList(false); navigate({ page: 'schedules', id }); });
  };
  const startCreating = () => {
    if (creating) return;
    guardRef.current(() => { setCreating(true); setNarrowList(false); });
  };
  const backToList = (withGuard: boolean) => {
    if (withGuard) guardRef.current(() => { setCreating(false); setNarrowList(true); });
    else { setCreating(false); setNarrowList(true); }
  };
  const listBody = (): ReactNode => {
    if (loading && !schedules) return <div role="status" aria-label="正在加载定时任务"><Skeleton.Text animated rows={6} /></div>;
    if (error && !schedules) return <div {...stylex.props(styles.stack)}>
      <Alert type="error" title="定时任务读取失败" description={error} />
      <div><Button icon={Plus} onClick={retry}>重试</Button></div>
    </div>;
    if (!schedules?.length) return <Empty title="还没有定时任务" description="创建脚本或 Agent 定时任务，让 Weaver 按时间规则自动执行。" action={<Button icon={Plus} onClick={startCreating}>新建定时任务</Button>} />;
    if (!filtered.length) return <Empty title="没有匹配的定时任务" description="换个名称关键字或类型再试。" action={<Button onClick={() => { setSearch(''); setKind('all'); }}>清除筛选</Button>} />;
    return <SelectableList<ScheduleDefinition>
      label="定时任务列表"
      sections={[{ key: 'all', items: filtered }]}
      getKey={item => item.id}
      selectedKey={creating ? undefined : selectedId}
      onSelect={select}
      renderItem={item => {
        const lastRun = item.lastRun;
        return <div {...stylex.props(schedulesStyles.item)}>
          <div {...stylex.props(schedulesStyles.itemHead)}>
            <NamedSwitch size="small" aria-label={`启用 ${item.name}`} checked={item.enabled} disabled={paused} onChange={checked => toggle(item, checked)} />
            <span {...stylex.props(schedulesStyles.itemName)} title={item.name}>{item.name}</span>
            <span {...stylex.props(schedulesStyles.itemTags)}>
              <Tag size="small" color={tagColor(isBuiltinQuota(item) ? 'neutral' : 'childRole')}>{KIND_LABELS[item.kind]}</Tag>
              {isBuiltinQuota(item) && <Tag size="small" title={BUILTIN_HINT}>{BUILTIN_LABEL}</Tag>}
            </span>
          </div>
          <div {...stylex.props(schedulesStyles.itemSecond)}>
            <span>{timingText(item.timing)}</span>
            <span>·</span>
            <span>下次 <TimeText value={item.nextRunAt} now={now} /></span>
            {lastRun && <span {...stylex.props(schedulesStyles.resultDot)}>
              <span>·</span>
              <span data-tone={RUN_TONES[lastRun.status]} aria-hidden="true" {...stylex.props(schedulesStyles.resultPoint(RUN_TONES[lastRun.status]))} />
              <span>{RUN_LABELS[lastRun.status]}</span>
            </span>}
          </div>
        </div>;
      }}
    />;
  };
  const main = creating
    ? <ScheduleDetail key="new" creating schedule={undefined} busy={busy} checking={checking} pending={pending} paused={paused} gate={gate}
      onPolicyChanged={onPolicyChanged} onCreated={id => { setCreating(false); setNarrowList(false); if (id) navigate({ page: 'schedules', id }); else refresh(); }} onBack={() => backToList(true)}
      registerGuard={guard => { guardRef.current = guard; }} />
    : missing
      ? <Pane label="定时任务详情" title={<span {...stylex.props(schedulesStyles.detailTitleLine)}>
          <Button className={stylex.props(schedulesStyles.back).className} size="small" icon={ArrowLeft} aria-label="返回列表" onClick={() => backToList(false)}>返回</Button>
          <span {...stylex.props(schedulesStyles.detailName)}>未找到这个定时任务</span>
        </span>}>
        <div {...stylex.props(schedulesStyles.emptyMain)}>
          <Text type="secondary">可能是它已被删除，或链接里的 id 不对。</Text>
          <Button onClick={() => navigate({ page: 'schedules' })}>返回列表</Button>
        </div>
      </Pane>
      : selected
        ? <ScheduleDetail key={selected.id} creating={false} schedule={selected} busy={busy} checking={checking} pending={pending} paused={paused} gate={gate}
          onPolicyChanged={onPolicyChanged} onCreated={() => { }} onBack={() => backToList(true)} registerGuard={guard => { guardRef.current = guard; }} />
        : <Pane label="定时任务详情" title="定时任务">
          <div {...stylex.props(schedulesStyles.emptyMain)}>
            {loading ? <div role="status" aria-label="正在加载定时任务"><Skeleton.Text animated rows={4} /></div>
              : <Text type="secondary">在左侧选择一个定时任务，这里显示它的配置与运行历史。</Text>}
          </div>
        </Pane>;
  return <div {...stylex.props(schedulesStyles.page)}>
    <PageHeader
      title={<TitleWithTips title="定时任务" tips="按时间规则自动执行脚本命令，或让所选执行者定时处理目标；运行结果保留在各自的历史里。" />}
      action={<Button type="primary" icon={Plus} disabled={paused} onClick={startCreating}>新建定时任务</Button>}
    />
    <div {...stylex.props(schedulesStyles.body)}>
      <MasterDetail
        listLabel="定时任务列表"
        mainLabel="定时任务详情"
        listWidth={320}
        mobileView={narrowList ? 'list' : (creating || selectedId ? 'main' : 'list')}
        list={<Pane
          label="定时任务列表"
          toolbar={<div {...stylex.props(schedulesStyles.toolbar)}>
            <Input ref={searchRef} className={stylex.props(schedulesStyles.search).className} allowClear aria-label="搜索定时任务" prefix={<Search size={14} />} placeholder="按名称、命令、目标或执行者搜索" value={search} onChange={event => setSearch(event.target.value)} />
            <NamedSelect className={stylex.props(schedulesStyles.kindFilter).className} aria-label="按类型筛选" value={kind} options={KIND_FILTER_OPTIONS} onChange={value => { if (typeof value === 'string') setKind(value as KindFilter); }} />
            <ActionIcon icon={RefreshCw} aria-label="刷新定时任务" disabled={paused} onClick={() => void refresh()} />
          </div>}
        >
          <div {...stylex.props(schedulesStyles.detailBody)}>
            {stale && <p role="status" {...stylex.props(styles.meta, schedulesStyles.staleNote)}>后台刷新失败，显示的是上次结果：{problem}。可再点刷新重试。</p>}
            {listBody()}
          </div>
        </Pane>}
        main={main}
      />
    </div>
  </div>;
}
