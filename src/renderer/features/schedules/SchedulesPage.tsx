import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { History, Pencil, Play, Plus, RefreshCw, Search, Square, Trash2 } from 'lucide-react';
import { Empty } from '@lobehub/ui';
import { PageHeader } from '@lobehub/ui/dashboard';
import { ActionIcon, Alert, Button, Input, Modal, Skeleton, Tag, Text } from '@lobehub/ui/base-ui';
import { command } from '../../api/commands';
import { notifyError, notifyInfo } from '../../api/notify';
import { NamedSelect, NamedSwitch } from '../../ui/NamedControls';
import { TimeText } from '../../ui/TimeText';
import { statusTagColor, tagColor } from '../../format/tag-colors';
import { styles } from '../../ui/styles';
import { schedulesStyles } from './schedules-style';
import { ScheduleFormModal, type SchedulePendingNotice, type ScheduleSubmitRequest } from './ScheduleFormModal';
import { ScheduleRunsDrawer } from './ScheduleRunsDrawer';
import { useSchedules } from './useSchedules';
import { readMutationReceipt, ScheduleMutationGate, type UnconfirmedIntent } from './schedule-mutations';
import {
  BUILTIN_HINT, BUILTIN_LABEL, KIND_LABELS, RUN_LABELS, RUN_TONES, timingText,
  isBuiltinQuota, isRunning,
} from './schedules-view';
import type { ScheduleDefinition } from '../../../shared/contracts/schedules';

type KindFilter = 'all' | ScheduleDefinition['kind'];

const KIND_FILTER_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'script', label: `脚本` },
  { value: 'agent', label: `Agent` },
];

/** The parked-intent notice shared by the page and the form modal. */
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
  useEffect(() => { mounted.current=true;return()=>{mounted.current=false;}; },[]);
  const gate = useMemo(() => new ScheduleMutationGate({
    send: mutation => command(mutation.command, mutation.args, true, mutation.commandId),
    readReceipt: readMutationReceipt,
    busy: value => { if(mounted.current)setBusy(value); },
    checking: value => { if(mounted.current)setChecking(value); },
    pending: value => { if(mounted.current)setPending(value); },
    settle: () => { if(mounted.current)settle(); },
    rejected: (error, context) => {
      if(!mounted.current)return;
      const conflict=error && typeof error==='object' && 'code' in error && error.code==='REVISION_CONFLICT';
      notifyError(conflict ? new Error('定时任务已被其他操作修改，草稿已保留。请关闭并重新打开，核对最新内容后保存。') : error,context);
    },
    applied: (result, intent, confirmed) => {
      if(!mounted.current)return;
      if (!intent.applied) notifyInfo(confirmed ? '已核对：该操作已生效。' : '操作已完成。');
      intent.applied?.(result);
    },
  }), [settle]);
  return { busy, checking, pending, paused: busy || !!pending, gate };
}

/** One row of the list: identity and its switch on the first line, the timing facts on the second. */
function ScheduleRow({ schedule, now, busy, onToggle, onRun, onStop, onEdit, onHistory, onDelete }: {
  schedule: ScheduleDefinition;
  now: number;
  busy: boolean;
  onToggle: (schedule: ScheduleDefinition, enabled: boolean) => void;
  onRun: (schedule: ScheduleDefinition) => void;
  onStop: (schedule: ScheduleDefinition) => void;
  onEdit: (schedule: ScheduleDefinition) => void;
  onHistory: (schedule: ScheduleDefinition) => void;
  onDelete: (schedule: ScheduleDefinition) => void;
}) {
  const builtin = isBuiltinQuota(schedule);
  const lastRun = schedule.lastRun;
  return <div className={schedulesStyles.row}>
    <div className={schedulesStyles.rowHead}>
      <NamedSwitch size="small" aria-label={`启用 ${schedule.name}`} checked={schedule.enabled} disabled={busy} onChange={checked => onToggle(schedule, checked)} />
      <Text strong className={schedulesStyles.name}>{schedule.name}</Text>
    </div>
    <div className={schedulesStyles.tags}>
      <Tag size="small" color={tagColor(builtin ? 'neutral' : 'childRole')}>{KIND_LABELS[schedule.kind]}</Tag>
      {builtin && <Tag size="small" title={BUILTIN_HINT}>{BUILTIN_LABEL}</Tag>}
      {!schedule.enabled && <Tag size="small">已停用</Tag>}
      {isRunning(schedule) && <Tag size="small" color={statusTagColor('processing')}>运行中</Tag>}
    </div>
    <div className={schedulesStyles.meta}>
      <span className={schedulesStyles.metaItem}><span>规则</span><span>{timingText(schedule.timing)}</span></span>
      {schedule.timing.mode === 'cron' && <span className={schedulesStyles.metaItem}><span>时区</span><span>{schedule.timing.timezone}</span></span>}
      {schedule.workspace && <span className={schedulesStyles.metaItem}><span>目录</span><span className={styles.wrap}>{schedule.workspace}</span></span>}
      <span className={schedulesStyles.metaItem}><span>下次</span><TimeText value={schedule.nextRunAt} now={now} /></span>
      <span className={schedulesStyles.metaItem}><span>上次</span><TimeText value={schedule.lastRunAt} now={now} /></span>
      {lastRun && <span className={schedulesStyles.metaItem}>
        <span>结果</span>
        <Tag size="small" color={statusTagColor(RUN_TONES[lastRun.status])}>{RUN_LABELS[lastRun.status]}</Tag>
      </span>}
    </div>
    <div className={schedulesStyles.actions}>
      <Button size="small" type="text" icon={Play} disabled={busy || isRunning(schedule)} aria-label={`立即运行 ${schedule.name}`} onClick={() => onRun(schedule)}>运行</Button>
      {!builtin && isRunning(schedule) && <Button size="small" type="text" icon={Square} disabled={busy} aria-label={`停止 ${schedule.name} 的活跃运行`} onClick={() => onStop(schedule)}>停止</Button>}
      <Button size="small" type="text" icon={History} aria-label={`查看 ${schedule.name} 的运行历史`} onClick={() => onHistory(schedule)}>历史</Button>
      <Button size="small" type="text" icon={Pencil} disabled={busy} aria-label={`编辑 ${schedule.name}`} onClick={() => onEdit(schedule)}>{builtin ? '调整' : '编辑'}</Button>
      {!builtin && <Button size="small" type="text" icon={Trash2} danger disabled={busy || isRunning(schedule)}
        title={isRunning(schedule) ? '有正在进行的运行，结束后才能删除。' : undefined}
        aria-label={`删除 ${schedule.name}`} onClick={() => onDelete(schedule)}>删除</Button>}
    </div>
  </div>;
}

/** The schedules management page: list, filters, form modal, history drawer and the confirmations. */
export function SchedulesPage({ onOpenTask, onPolicyChanged }: {
  /** Agent run history links open the exact task detail on the tasks page. */
  onOpenTask?: (taskId: string) => void;
  /** The builtin quota schedule writes the quota settings; the saved policy view refreshes with it. */
  onPolicyChanged?: () => void;
} = {}) {
  const { schedules, loading, error, stale, problem, refresh, retry } = useSchedules();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ScheduleDefinition>();
  const [historyOf, setHistoryOf] = useState<ScheduleDefinition>();
  const [deleting, setDeleting] = useState<ScheduleDefinition>();
  const [now, setNow] = useState(Date.now);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const { busy, checking, pending, paused, gate } = useScheduleMutations(refresh);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // Keep the opening definition for CAS and drafts; only live run state follows refreshes.
  const editingCurrent = editing ? schedules?.find(item => item.id === editing.id) ?? editing : undefined;
  const historyCurrent=historyOf ? schedules?.find(item=>item.id===historyOf.id) ?? historyOf : undefined;
  const query = search.trim().toLowerCase();
  const rows = (schedules ?? []).filter(item =>
    (kind === 'all' || item.kind === kind)
    && (!query || item.name.toLowerCase().includes(query)
      || (item.script?.command ?? '').toLowerCase().includes(query)
      || (item.agent?.goal ?? '').toLowerCase().includes(query)));
  const notice: SchedulePendingNotice | undefined = pending ? {
    context: pending.context,
    reason: pending.reason,
    checking,
    onVerify: () => void gate.verify(),
    onResend: () => void gate.resend(),
  } : undefined;
  /** The parked notice rides inside the form that started it (create/edit), nowhere else. */
  const pendingInForm = pending && ((!!creating && pending.mutation.command === 'schedules.create')
    || (!!editingCurrent && pending.mutation.command === 'schedules.update' && pending.mutation.args.scheduleId === editingCurrent.id));
  const pendingForForm = pending && pendingInForm ? notice : undefined;
  const pendingInDelete = !!deleting && pending?.mutation.command === 'schedules.delete' && pending.mutation.args.scheduleId === deleting.id;
  const pendingInHistory = !!historyOf && pending?.mutation.command === 'schedules.cancel' && pending.mutation.args.scheduleId === historyOf.id;
  const pendingForPage = pending && !pendingInForm && !pendingInDelete && !pendingInHistory ? notice : undefined;
  const toggle = (schedule: ScheduleDefinition, enabled: boolean) => {
    void gate.run('schedules.' + (enabled ? 'enable' : 'disable'), { scheduleId: schedule.id, expectedRevision: schedule.revision }, enabled ? '启用失败' : '停用失败',
      isBuiltinQuota(schedule) ? () => onPolicyChanged?.() : undefined);
  };
  const runNow = (schedule: ScheduleDefinition) => {
    void gate.run('schedules.run', { scheduleId: schedule.id, expectedRevision: schedule.revision }, '立即运行失败');
  };
  const stopRun = (schedule: ScheduleDefinition, runId?: string) => {
    const target = runId ?? schedule.activeRunId;
    if (!target) return;
    void gate.run('schedules.cancel', { scheduleId: schedule.id, runId: target }, '停止运行失败');
  };
  const submit = async (request: ScheduleSubmitRequest): Promise<boolean> => {
    const creating = !request.scheduleId;
    const name = request.input.name?.trim();
    const applied = () => {
      if (editingCurrent && isBuiltinQuota(editingCurrent)) onPolicyChanged?.();
      if (creating) { notifyInfo(`已创建${name ? `「${name}」` : '定时任务'}。`); setCreating(false); }
      else { notifyInfo('修改已保存。'); setEditing(undefined); }
    };
    if (creating) return await gate.run('schedules.create', { ...request.input }, '创建定时任务失败', applied);
    return await gate.run('schedules.update',
      { scheduleId: request.scheduleId, expectedRevision: request.expectedRevision, patch: { ...request.input } },
      '保存定时任务失败', applied);
  };

  const destroy = (schedule: ScheduleDefinition) => {
    void gate.run('schedules.delete', { scheduleId: schedule.id, expectedRevision: schedule.revision }, '删除定时任务失败',
      () => { notifyInfo(`已删除 ${schedule.name}`);setDeleting(undefined); });
  };
  const listBody = (): ReactNode => {
    if (loading && !schedules) return <div role="status" aria-label="正在加载定时任务"><Skeleton.Text animated rows={6} /></div>;
    if (error && !schedules) return <div className={styles.stack}>
      <Alert type="error" title="定时任务读取失败" description={error} />
      <div><Button icon={RefreshCw} onClick={retry}>重试</Button></div>
    </div>;
    if (!schedules?.length) return <Empty title="还没有定时任务" description="创建脚本或 Agent 定时任务，让 Weaver 按时间规则自动执行。" action={<Button icon={Plus} onClick={() => setCreating(true)}>新建定时任务</Button>} />;
    if (!rows.length) return <Empty title="没有匹配的定时任务" description="换个名称关键字或类型再试。" action={<Button onClick={() => { setSearch(''); setKind('all'); }}>清除筛选</Button>} />;
    return <div className={schedulesStyles.list}>
      {rows.map(item => <ScheduleRow key={item.id} schedule={item} now={now} busy={paused}
        onToggle={toggle} onRun={runNow} onStop={stopRun} onEdit={setEditing} onHistory={setHistoryOf} onDelete={setDeleting} />)}
    </div>;
  };
  return <>
    <PageHeader title="定时任务" description="按时间规则自动执行脚本命令，或让独立的父 Agent 定时处理目标；运行结果保留在各自的历史里。" action={
      <Button ref={newButtonRef} type="primary" icon={Plus} disabled={paused} onClick={() => setCreating(true)}>新建定时任务</Button>
    } />
    <div className={schedulesStyles.page}>
      <div className={schedulesStyles.toolbar}>
        <Input className={schedulesStyles.search} allowClear aria-label="搜索定时任务" prefix={<Search size={14} />} placeholder="按名称、命令或目标搜索" value={search} onChange={event => setSearch(event.target.value)} />
        <NamedSelect className={schedulesStyles.kindFilter} aria-label="按类型筛选" value={kind} options={KIND_FILTER_OPTIONS} onChange={value => { if (typeof value === 'string') setKind(value as KindFilter); }} />
        <ActionIcon className={schedulesStyles.refresh} icon={RefreshCw} aria-label="刷新定时任务" disabled={paused} onClick={() => void refresh()} />
      </div>
      {stale && <p role="status" className={`${styles.meta} ${schedulesStyles.staleNote}`}>后台刷新失败，显示的是上次结果：{problem}。可再点刷新重试。</p>}
      {pendingForPage && <PendingNotice notice={pendingForPage} />}
      {listBody()}
    </div>
    <ScheduleFormModal open={creating} busy={busy} pendingNotice={pendingForForm} close={() => setCreating(false)} onClosed={() => newButtonRef.current?.focus()} submit={submit} />
    <ScheduleFormModal key={editing?.id} open={!!editing} definition={editing} active={!!editingCurrent?.activeRunId} busy={busy} pendingNotice={pendingForForm} close={() => setEditing(undefined)} onClosed={() => setEditing(undefined)} submit={submit} />
    {historyOf && <ScheduleRunsDrawer schedule={historyCurrent!} open={!!historyOf} onClose={() => setHistoryOf(undefined)} pendingNotice={pendingInHistory ? notice : undefined} cancelBusy={paused} onCancelRun={runId => historyOf && stopRun(historyOf, runId)} onViewTask={onOpenTask} />}
    <Modal open={!!deleting} title="删除定时任务？" width={440} maskClosable={!paused} onCancel={() => { if (!paused) setDeleting(undefined); }} footer={<>
      <Button htmlType="button" disabled={paused} onClick={() => setDeleting(undefined)}>取消</Button>
      <Button htmlType="button" danger type="primary" loading={busy} disabled={paused} onClick={() => deleting && destroy(deleting)}>删除</Button>
    </>}>
      {pendingInDelete && notice && <PendingNotice notice={notice} />}
      <Text>将删除「{deleting?.name}」这个定时任务定义及其全部运行历史；正在运行的任务不能删除；此操作不能撤销。</Text>
      {deleting && isRunning(deleting) && <Alert type="warning" title="这个任务正在运行" description="等本次运行结束（或先停止它）再删除。" />}
    </Modal>
  </>;
}
