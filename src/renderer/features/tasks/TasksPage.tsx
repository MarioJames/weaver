import { notifyError } from '../../api/notify';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button, CopyButton, Empty, Input, Modal, Progress, Segmented, Skeleton, Table, Tag, Text } from '@lobehub/ui';
import type { SelectProps, TableColumnsType } from '@lobehub/ui';
import { PageHeader, TitleWithTips } from '@lobehub/ui/dashboard';
import { ArrowLeft, ChevronDown, ChevronRight, Pin, PinOff, Search, TriangleAlert } from 'lucide-react';
import type { Route } from '../../app/router';
import { navigate, routeHref, useRoute } from '../../app/router';
import { command } from '../../api/commands';
import type { OwnerInstance } from '../../../shared/contracts/owners';
import type { Task } from '../../../shared/contracts/tasks';
import { createTask, notifySaveDraftFailure, taskUpdateArgs, updateTask } from './task-create';
import { attentionTasks, needsAttention } from './task-attention';
import { isOwnerRoot, ownerProfileOf, recentWorkspaces, withOwnerProfiles } from './task-view';
import { buildSessions, retryAttemptOf, retryChains, sessionKeyOf, sessionWorkspaceLabel, type Session } from './task-session';
import {
  WORKBENCH_TIMES, defaultWorkbenchBoard, defaultWorkbenchSessions, readTaskPins, readWorkbenchBoard, readWorkbenchEnded, readWorkbenchSessions,
  writeTaskPins, writeWorkbenchBoard, writeWorkbenchEnded, writeWorkbenchSessions, type WorkbenchBoard, type WorkbenchSessions, type WorkbenchTime,
} from './task-persistence';
import { isPinned, nextPinTime, pruneStalePins, togglePin } from './task-pins';
import { EditTaskDialog } from './EditTaskDialog';
import { NewTaskDialog } from './NewTaskDialog';
import { TaskInspector } from './TaskInspector';
import { ContinueSessionButton } from './SessionContinueDialog';
import type { useWorkbench } from './useWorkbench';
import { MasterDetail } from '../../ui/MasterDetail';
import { BoardInspectorOverlay, TaskBoardView } from './TaskBoard';
import { CompactMetrics, type CompactMetricItem } from '../../ui/CompactMetrics';
import { Pane } from '../../ui/Pane';
import { SelectableList } from '../../ui/SelectableList';
import { GroupHeading } from '../../ui/GroupHeading';
import { StatusBadge } from '../../ui/StatusBadge';
import { AgentChip } from '../../ui/AgentChip';
import { EntityLink } from '../../ui/EntityLink';
import { TimeText } from '../../ui/TimeText';
import { EngineIcon } from '../../ui/EngineIcon';
import { FreeChannelTag } from '../../ui/FreeChannelTag';
import { NamedSelect } from '../../ui/NamedControls';
import { displayLog } from './log-view';
import { cardFooter, completedAt } from './task-footer';
import { DISPLAY_LABELS, displayStatus, type DisplayStatus } from '../../format/status-colors';
import { tagColor } from '../../format/tag-colors';
import { dispatchKind, isActive, isDraft, ownerLabel, rootCancelNotice, taskOwnerId, taskTitle } from './task-view';
import { projectTimeZone, startOfZonedDay } from '../../format/timezone';
import { TaskTextBlock } from './TaskTextBlock';
import { workbenchStyles } from './workbench-style';

const NARROW_QUERY = '(max-width: 1023.98px)';
const WIDE_QUERY = '(min-width: 1440px)';
const TIGHT_QUERY = '(max-width: 1279.98px)';

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [query]);
  return matches;
}

function useNarrow(): boolean {
  return useMedia(NARROW_QUERY);
}

const TIME_WINDOW_MS: Record<Exclude<WorkbenchTime, 'all'>, number> = {
  today: 0, '24h': 24 * 3600000, '7d': 7 * 24 * 3600000, '30d': 30 * 24 * 3600000,
};

function inTimeWindow(value: string, time: WorkbenchTime, now: number, zone: string): boolean {
  if (time === 'all') return true;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at > now) return false;
  if (time === 'today') return at >= startOfZonedDay(now, zone);
  return now - at <= TIME_WINDOW_MS[time];
}

function sessionHasOpen(session: Session): boolean {
  if (session.root && isActive(session.root)) return true;
  return session.tasks.some(task => isActive(task));
}

/** The compact counts line: non-zero display states joined with ·, 执行中 first. */
function sessionCountsText(session: Session): { text: string; running: number } {
  const order: DisplayStatus[] = ['running', 'cancelling', 'review', 'queued', 'scheduled', 'draft', 'accepted', 'rejected', 'failed', 'cancelled'];
  const parts: string[] = [];
  let running = 0;
  for (const status of order) {
    const count = session.counts[status] ?? 0;
    if (count <= 0) continue;
    if (status === 'running' || status === 'cancelling') running += count;
    parts.push(`${count} ${DISPLAY_LABELS[status]}`);
  }
  return { text: parts.join(' · '), running };
}

type TaskSegment = 'attention' | 'running' | 'review' | 'queued' | 'closed';
const TASK_SEGMENTS: readonly { key: TaskSegment; label: string }[] = [
  { key: 'attention', label: '需关注' }, { key: 'running', label: '执行中' }, { key: 'review', label: '待验收' },
  { key: 'queued', label: '待执行' }, { key: 'closed', label: '已结束' },
];

function taskSegment(task: Task, tasks: readonly Task[], now: number): TaskSegment {
  if (needsAttention(task, tasks, now)) return 'attention';
  const status = displayStatus(task);
  if (status === 'running' || status === 'cancelling') return 'running';
  if (status === 'review') return 'review';
  if (status === 'draft' || status === 'queued' || status === 'scheduled') return 'queued';
  return 'closed';
}

function parentAgentOf(session: Session, ownerKind?: (ownerId?: string) => string | undefined): { kind?: string; name: string; title: string } {
  const probe = session.root ?? session.tasks[0];
  if (!probe) return { name: '未指定父 Agent', title: '未指定父 Agent' };
  const full = ownerLabel(probe);
  const name = full.split(' · ')[0]?.trim() || full;
  const kind = ownerKind?.(taskOwnerId(probe)) ?? dispatchKind(probe);
  return { kind, name, title: full };
}

function SessionCounts({ session }: { session: Session }) {
  const { text, running } = sessionCountsText(session);
  if (!text) return <span {...stylex.props(workbenchStyles.sessionCounts)}>暂无任务</span>;
  return <span {...stylex.props(workbenchStyles.sessionCounts)}>
    {running > 0 && <span data-tone="processing" aria-hidden="true" />}
    {text}
  </span>;
}

export function TasksPage({ work, ownerKind, freeChannel }: {
  work: ReturnType<typeof useWorkbench>;
  ownerKind?: (ownerId?: string) => string | undefined;
  freeChannel?: (workerId?: string) => boolean;
}) {
  const route = useRoute();
  const view = route.page === 'tasks' ? route.view : 'board';
  const narrow = useNarrow();
  const wide = useMedia(WIDE_QUERY);
  const tight = useMedia(TIGHT_QUERY);
  const medium = !wide && !narrow;
  const now = Date.now();
  const zone = projectTimeZone();
  const [owners, setOwners] = useState<OwnerInstance[]>([]);
  useEffect(() => {
    let current = true;
    void command<{ owners: OwnerInstance[] }>('owners.list', {}).then(result => {
      if (current) { setOwners(result.owners); }
    }).catch(error => { if (current) notifyError(error, '资料读取失败'); });
    return () => { current = false; };
  }, [work.tasks]);
  const tasks = useMemo(() => withOwnerProfiles(work.tasks, owners), [work.tasks, owners]);
  const tasksById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  const sessions = useMemo(() => buildSessions(tasks, owners, now), [tasks, owners, now]);
  const sessionByKey = useMemo(() => new Map(sessions.map(session => [session.key, session])), [sessions]);

  const [prefs, setPrefs] = useState<WorkbenchSessions>(readWorkbenchSessions);
  const [boardPrefs, setBoardPrefs] = useState<WorkbenchBoard>(readWorkbenchBoard);
  const [endedOpen, setEndedOpen] = useState(readWorkbenchEnded);
  const [pins, setPins] = useState(readTaskPins);
  const [creating, setCreating] = useState(false);
  const [editingTask, setEditingTask] = useState<Task>();
  const [editing, setEditing] = useState(false);
  const [askCancelRoot, setAskCancelRoot] = useState<Task>();
  const newTaskRef = useRef<HTMLButtonElement | HTMLAnchorElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const allSearchRef = useRef<HTMLInputElement>(null);
  const [allQuery, setAllQuery] = useState('');
  const [allTime, setAllTime] = useState<WorkbenchTime>('all');
  const [allStatuses, setAllStatuses] = useState<string[]>([]);
  const [allSessions, setAllSessions] = useState<string[]>([]);
  const [allWorkers, setAllWorkers] = useState<string[]>([]);
  const [allWorkspaces, setAllWorkspaces] = useState<string[]>([]);

  useEffect(() => {
    if (!tasks.length) return;
    const pruned = pruneStalePins(pins, tasks.map(task => task.id));
    if (pruned !== pins) { setPins(pruned); writeTaskPins(pruned); }
  }, [pins, tasks]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const field = view === 'all' ? allSearchRef.current : searchRef.current;
      if (!field) return;
      event.preventDefault();
      field.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [view]);

  const updatePrefs = (next: WorkbenchSessions) => { setPrefs(next); writeWorkbenchSessions(next); };
  const updateBoardPrefs = (next: WorkbenchBoard) => { setBoardPrefs(next); writeWorkbenchBoard(next); };
  const toggleEnded = () => { const next = !endedOpen; setEndedOpen(next); writeWorkbenchEnded(next); };
  const onTogglePin = (id: string) => {
    const next = togglePin(pins, id, nextPinTime(pins, now, Date.now()));
    setPins(next);
    writeTaskPins(next);
  };

  const focusTaskRow = (id: string | undefined) => {
    requestAnimationFrame(() => {
      const row = id ? document.querySelector<HTMLElement>(`[data-task-row="${CSS.escape(id)}"]`) : null;
      if (row?.isConnected) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }); return; }
      const fallback = view === 'all'
        ? allSearchRef.current
        : view === 'board'
          ? document.querySelector<HTMLElement>('[aria-label="搜索看板"]')
          : searchRef.current;
      fallback?.focus({ preventScroll: true });
    });
  };

  // ---- sessions view filtering ----
  const needle = prefs.query.trim().toLocaleLowerCase();
  const scopedSessions = sessions.filter(session => {
    if (!inTimeWindow(session.lastActivityAt, prefs.time, now, zone)) return false;
    if (prefs.scope === 'attention' && session.attention <= 0) return false;
    if (prefs.scope === 'active' && !sessionHasOpen(session)) return false;
    if (!needle) return true;
    const haystack = [
      session.title, session.workspace ?? '',
      ...session.tasks.flatMap(task => [taskTitle(task), task.dispatch?.worker ?? '', task.dispatch?.workspace ?? task.workspace ?? '']),
      ...(session.root ? [taskTitle(session.root)] : []),
    ].join('\n').toLocaleLowerCase();
    return haystack.includes(needle);
  });
  const attentionList = useMemo(() => attentionTasks(tasks, now), [tasks, now]);
  const attentionTotal = attentionList.length;
  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, Session[]>();
    for (const session of [...scopedSessions].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))) {
      const workspace = session.workspace ?? '';
      const group = groups.get(workspace);
      if (group) group.push(session);
      else groups.set(workspace, [session]);
    }
    return [...groups].map(([workspace, items]) => {
      const ordered = [...items].sort((a, b) => (b.attention > 0 ? 1 : 0) - (a.attention > 0 ? 1 : 0) || b.lastActivityAt.localeCompare(a.lastActivityAt));
      return { workspace, label: sessionWorkspaceLabel(workspace), sessions: ordered, lastActivityAt: ordered.reduce((latest, s) => (s.lastActivityAt > latest ? s.lastActivityAt : latest), '') };
    }).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }, [scopedSessions]);
  const listSections = workspaceGroups.map(group => ({
    key: group.workspace || 'none',
    heading: <GroupHeading label={group.label} count={group.sessions.length} title={group.workspace || '未指定工作目录'} />,
    items: group.sessions,
  }));

  // ---- selection from URL ----
  const sessionKey = route.page === 'tasks' && route.view === 'sessions' ? route.sessionKey : undefined;
  const sessionTaskId = route.page === 'tasks' && route.view === 'sessions' ? route.taskId : undefined;
  const allTaskId = route.page === 'tasks' && route.view === 'all' ? route.taskId : undefined;
  const allInspectorOpen = !!allTaskId;
  const session = sessionKey ? sessionByKey.get(sessionKey) : undefined;
  const inspectorTask = (sessionTaskId ?? allTaskId) ? tasksById.get((sessionTaskId ?? allTaskId)!) : undefined;

  const sessionRouteOf = (task: Task): Route => ({ page: 'tasks', view: 'sessions', sessionKey: sessionKeyOf(task, tasksById) });
  const taskRouteIn = (id: string, fallbackSession: string): Route => {
    const task = tasksById.get(id);
    if (!task) return { page: 'tasks', view: 'sessions', sessionKey: fallbackSession, taskId: id };
    const key = sessionKeyOf(task, tasksById);
    return key === fallbackSession
      ? { page: 'tasks', view: 'sessions', sessionKey: fallbackSession, taskId: id }
      : { page: 'tasks', view: 'sessions', sessionKey: key, taskId: id };
  };
  const closeInspector = (returnTo: Route, focusId?: string) => {
    navigate(returnTo, { replace: true });
    focusTaskRow(focusId);
  };

  // ---- overview metrics ----
  const runningCount = tasks.filter(task => { const s = displayStatus(task); return s === 'running' || s === 'cancelling'; }).length;
  const queuedCount = tasks.filter(task => { const s = displayStatus(task); return s === 'queued' || s === 'scheduled' || s === 'draft'; }).length;
  const todayStart = startOfZonedDay(now, zone);
  const doneToday = tasks.filter(task => task.status === 'completed' && Date.parse(completedAt(task)) >= todayStart).length;
  const metrics: CompactMetricItem[] = [
    { label: '执行中', value: runningCount },
    { label: '排队中', value: queuedCount },
    { label: '需关注', value: attentionTotal, valueTone: attentionTotal > 0 ? 'warning' : undefined, onClick: () => updatePrefs({ ...prefs, scope: 'attention' }) },
    { label: '今日完成', value: doneToday },
  ];

  const newTaskAction = (
    <Button ref={newTaskRef} type="primary" disabled={work.busy || !work.caps || work.loading} onClick={() => setCreating(true)}>新建任务</Button>
  );
  const viewSwitch = (
    <Segmented
      aria-label="视图切换"
      value={view}
      options={[{ value: 'board', label: '看板' }, { value: 'sessions', label: '会话' }, { value: 'all', label: '全部任务' }]}
      onChange={value => navigate(
        value === 'all' ? { page: 'tasks', view: 'all' }
          : value === 'sessions' ? { page: 'tasks', view: 'sessions' }
            : { page: 'tasks', view: 'board' },
      )}
    />
  );

  // ---- all-tasks view ----
  const allStatusOptions = [...new Set(tasks.map(task => displayStatus(task)))].sort().map(status => ({ value: status, label: DISPLAY_LABELS[status] }));
  const allSessionOptions = sessions.map(item => ({ value: item.key, label: item.title }));
  const allWorkerOptions = [...new Set(tasks.map(task => task.dispatch?.worker).filter((w): w is string => !!w))].sort().map(w => ({ value: w, label: w }));
  const allWorkspaceOptions = [...new Set(tasks.map(task => task.dispatch?.workspace || task.workspace).filter((w): w is string => !!w))].sort().map(w => ({ value: w, label: sessionWorkspaceLabel(w) }));
  const allNeedle = allQuery.trim().toLocaleLowerCase();
  const allRows = tasks.filter(task => {
    if (!inTimeWindow(task.updatedAt, allTime, now, zone)) return false;
    if (allStatuses.length && !allStatuses.includes(displayStatus(task))) return false;
    if (allSessions.length && !allSessions.includes(sessionKeyOf(task, tasksById))) return false;
    if (allWorkers.length && (!task.dispatch?.worker || !allWorkers.includes(task.dispatch.worker))) return false;
    if (allWorkspaces.length && !allWorkspaces.includes(task.dispatch?.workspace || task.workspace || '')) return false;
    if (!allNeedle) return true;
    return [taskTitle(task), task.dispatch?.worker ?? '', task.dispatch?.workspace ?? task.workspace ?? '', sessionByKey.get(sessionKeyOf(task, tasksById))?.title ?? '']
      .join('\n').toLocaleLowerCase().includes(allNeedle);
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const allFiltered = allStatuses.length + allSessions.length + allWorkers.length + allWorkspaces.length > 0 || !!allNeedle || allTime !== 'all';
  const clearAllFilters = () => { setAllQuery(''); setAllTime('all'); setAllStatuses([]); setAllSessions([]); setAllWorkers([]); setAllWorkspaces([]); };
  const multiProps: Partial<SelectProps> = { mode: 'multiple', allowClear: true };

  const allColumnStatus: TableColumnsType<Task>[number] = { title: '状态', key: 'status', width: 96, ellipsis: true, render: (_, task) => <StatusBadge status={displayStatus(task)} /> };
  const allColumnTask: TableColumnsType<Task>[number] = {
    title: '任务', key: 'task', width: wide ? 260 : tight ? 188 : 240, ellipsis: true,
    render: (_, task) => <span title={taskTitle(task)} {...stylex.props(workbenchStyles.cellText)}>{taskTitle(task)}</span>,
  };
  const allColumnSession: TableColumnsType<Task>[number] = {
    title: '会话', key: 'session', width: wide ? 200 : 160, ellipsis: true,
    render: (_, task) => {
      const key = sessionKeyOf(task, tasksById);
      const title = sessionByKey.get(key)?.title ?? key;
      return <span onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <EntityLink route={{ page: 'tasks', view: 'sessions', sessionKey: key }} title={title}>{title}</EntityLink>
      </span>;
    },
  };
  const allColumnWorker: TableColumnsType<Task>[number] = {
    title: '子 Agent', key: 'worker', width: wide ? 140 : 108, ellipsis: true,
    render: (_, task) => task.dispatch?.worker
      ? <AgentChip kind={dispatchKind(task)} name={task.dispatch.worker} title={task.dispatch.worker} />
      : <Text type="secondary">未派发</Text>,
  };
  const allColumnWorkspace: TableColumnsType<Task>[number] = {
    title: '工作目录', key: 'workspace', width: wide ? 130 : 92, ellipsis: true,
    render: (_, task) => {
      const path = task.dispatch?.workspace || task.workspace || '';
      return <span title={path || '未指定工作目录'} {...stylex.props(workbenchStyles.cellText)}>{path ? sessionWorkspaceLabel(path) : '未指定'}</span>;
    },
  };
  const allColumnUpdated: TableColumnsType<Task>[number] = {
    title: '结束或最近上报', key: 'updated', width: wide ? 140 : tight ? 124 : 126, ellipsis: true,
    render: (_, task) => {
      const footer = cardFooter(task, { name: '', title: '' });
      return <TimeText value={footer.tail?.at ?? footer.at} now={now} />;
    },
  };
  // Six columns only fit the widest main pane; narrower windows drop the facts that the inspector repeats.
  const allTableColumns: TableColumnsType<Task> = wide
    ? [allColumnStatus, allColumnTask, allColumnSession, allColumnWorker, allColumnWorkspace, allColumnUpdated]
    : tight
      ? [allColumnStatus, allColumnTask, allColumnUpdated]
      : [allColumnStatus, allColumnTask, allColumnSession, allColumnUpdated];
  const allTableWidth = wide ? 966 : tight ? 408 : 622;

  const allListPane = (
    <Pane label="全部任务筛选" title="筛选">
      <div {...stylex.props(workbenchStyles.filterStack)}>
        <Input ref={allSearchRef} allowClear aria-label="搜索全部任务" placeholder="搜索任务、子 Agent" prefix={<Search size={14} />} value={allQuery} onChange={event => setAllQuery(event.target.value)} {...stylex.props(workbenchStyles.search)} />
        <NamedSelect aria-label="时间范围" value={allTime} options={WORKBENCH_TIMES.map(item => ({ value: item.value, label: item.label }))} onChange={value => { if (typeof value === 'string') setAllTime(value as WorkbenchTime); }} />
        <NamedSelect aria-label="状态" placeholder="状态" value={allStatuses} options={allStatusOptions} onChange={value => setAllStatuses(Array.isArray(value) ? value.map(String) : [])} {...multiProps} />
        <NamedSelect aria-label="会话" placeholder="会话" value={allSessions} options={allSessionOptions} onChange={value => setAllSessions(Array.isArray(value) ? value.map(String) : [])} {...multiProps} />
        <NamedSelect aria-label="子 Agent" placeholder="子 Agent" value={allWorkers} options={allWorkerOptions} onChange={value => setAllWorkers(Array.isArray(value) ? value.map(String) : [])} {...multiProps} />
        <NamedSelect aria-label="工作目录" placeholder="工作目录" value={allWorkspaces} options={allWorkspaceOptions.map(o => ({ value: o.value, label: `${o.label}` }))} onChange={value => setAllWorkspaces(Array.isArray(value) ? value.map(String) : [])} {...multiProps} />
        {allFiltered && <Button size="small" onClick={clearAllFilters}>清除筛选</Button>}
      </div>
    </Pane>
  );

  const allMainPane = (
    <Pane
      label="全部任务"
      title={`全部任务 · ${allRows.length}`}
      toolbar={medium ? undefined : <div {...stylex.props(workbenchStyles.allFilters)}>
        <Input ref={allSearchRef} allowClear aria-label="搜索全部任务" placeholder="搜索任务、子 Agent" prefix={<Search size={14} />} value={allQuery} onChange={event => setAllQuery(event.target.value)} {...stylex.props(workbenchStyles.allSearch)} />
        <NamedSelect aria-label="时间范围" value={allTime} options={WORKBENCH_TIMES.map(item => ({ value: item.value, label: item.label }))} onChange={value => { if (typeof value === 'string') setAllTime(value as WorkbenchTime); }} {...stylex.props(workbenchStyles.allSelect)} />
        <NamedSelect aria-label="状态" placeholder="状态" value={allStatuses} options={allStatusOptions} onChange={value => setAllStatuses(Array.isArray(value) ? value.map(String) : [])} {...multiProps} {...stylex.props(workbenchStyles.allSelect)} />
        <NamedSelect aria-label="会话" placeholder="会话" value={allSessions} options={allSessionOptions} onChange={value => setAllSessions(Array.isArray(value) ? value.map(String) : [])} {...multiProps} {...stylex.props(workbenchStyles.allSelect)} />
        <NamedSelect aria-label="子 Agent" placeholder="子 Agent" value={allWorkers} options={allWorkerOptions} onChange={value => setAllWorkers(Array.isArray(value) ? value.map(String) : [])} {...multiProps} {...stylex.props(workbenchStyles.allSelect)} />
        <NamedSelect aria-label="工作目录" placeholder="工作目录" value={allWorkspaces} options={allWorkspaceOptions} onChange={value => setAllWorkspaces(Array.isArray(value) ? value.map(String) : [])} {...multiProps} {...stylex.props(workbenchStyles.allSelect)} />
        {allFiltered && <Button size="small" onClick={clearAllFilters}>清除筛选</Button>}
      </div>}
    >
      {allRows.length === 0 ? (
        <div {...stylex.props(workbenchStyles.emptyWrap)}>
          <Empty title="没有匹配的任务" description="调整搜索或筛选条件。" action={allFiltered ? <Button size="small" onClick={clearAllFilters}>清除筛选</Button> : undefined} />
        </div>
      ) : (narrow || allInspectorOpen) ? (
        <SelectableList<Task>
          label="全部任务"
          sections={[{ key: 'all', items: allRows }]}
          getKey={task => task.id}
          selectedKey={allTaskId}
          onSelect={id => navigate({ page: 'tasks', view: 'all', taskId: id })}
          virtual
          renderItem={task => {
            const key = sessionKeyOf(task, tasksById);
            const title = sessionByKey.get(key)?.title ?? key;
            const path = task.dispatch?.workspace || task.workspace || '';
            return <span data-task-row={task.id} tabIndex={-1} {...stylex.props(workbenchStyles.mobileRow)}>
              <span {...stylex.props(workbenchStyles.mobileHead)}>
                <StatusBadge status={displayStatus(task)} />
                <span {...stylex.props(workbenchStyles.taskTitle)}>{taskTitle(task)}</span>
              </span>
              <span {...stylex.props(workbenchStyles.mobileMeta)}>
                <span onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                  <EntityLink route={{ page: 'tasks', view: 'sessions', sessionKey: key }} title={title}>{title}</EntityLink>
                </span>
                <span {...stylex.props(workbenchStyles.taskMetaText)} title={path || '未指定工作目录'}>{path ? sessionWorkspaceLabel(path) : '未指定'}</span>
                <TimeText value={cardFooter(task, { name: '', title: '' }).tail?.at ?? cardFooter(task, { name: '', title: '' }).at} now={now} />
              </span>
            </span>;
          }}
        />
      ) : (
        <AllTasksTable columns={allTableColumns} rows={allRows} width={allTableWidth} />
      )}
    </Pane>
  );

  if (view === 'all') {
    const inspectorOpen = allInspectorOpen;
    const mobileView = narrow ? (inspectorOpen ? 'inspector' : 'main') : 'list';
    return (
      <section aria-label="工作台" {...stylex.props(workbenchStyles.page)}>
        <PageHeader
          title={<TitleWithTips title="工作台" tips="以会话为经、以任务为纬：左侧按工作目录分组会话，主窗格看中任务，检查器看细节。地址即状态，刷新与后退都回到同一处。" />}
          action={<div {...stylex.props(workbenchStyles.detailActions)}>{newTaskAction}{viewSwitch}</div>}
        />
        <div {...stylex.props(workbenchStyles.body)}>
          <MasterDetail
            listLabel="全部任务筛选"
            mainLabel="全部任务"
            list={medium ? allListPane : undefined}
            listWidth={medium ? 320 : 0}
            main={allMainPane}
            inspector={inspectorOpen ? (
              inspectorTask || tasksById.has(allTaskId!) ? (
                <TaskInspector
                  key={allTaskId}
                  taskId={allTaskId!}
                  tasks={tasks}
                  work={work}
                  ownerKind={ownerKind}
                  freeChannel={freeChannel}
                  taskRoute={id => ({ page: 'tasks', view: 'all', taskId: id })}
                  sessionRoute={sessionRouteOf}
                  onClose={() => closeInspector({ page: 'tasks', view: 'all' }, allTaskId)}
                  onEdit={full => { setEditingTask(full); setEditing(true); }}
                />
              ) : (
                <MissingTaskPane onBack={() => navigate({ page: 'tasks', view: 'all' }, { replace: true })} />
              )
            ) : undefined}
            inspectorOpen={inspectorOpen}
            onInspectorClose={() => closeInspector({ page: 'tasks', view: 'all' }, allTaskId)}
            mobileView={mobileView}
          />
        </div>
        {editingTask && (
          <EditTaskDialog open={editing} task={editingTask} profile={ownerProfileOf(editingTask, owners)} busy={work.busy} recentWorkspaces={recentWorkspaces(tasks, 5)} close={() => setEditing(false)}
            save={(input, start, expectedRevision) => work.action(() => updateTask(taskUpdateArgs({ id: editingTask.id, revision: expectedRevision }, input, ownerProfileOf(editingTask, owners)), start, {
              update: args => command('tasks.update', args, true),
              start: id => window.weaver.startTask(id),
              startFailed: (id, error) => notifyError(error, '草稿已保存，启动失败', { label: '重试启动', run: () => { void work.action(() => window.weaver.startTask(id)); } }),
            }), notifySaveDraftFailure)} />
        )}
        <NewTaskDialog open={creating} busy={work.busy} recentWorkspaces={recentWorkspaces(tasks, 5)} close={() => setCreating(false)} onClosed={() => newTaskRef.current?.focus()}
          create={(input, start) => work.action(() => createTask(input, start, {
            create: value => command<{ id: string }>('tasks.create', { ...value }, true),
            start: id => window.weaver.startTask(id),
            select: id => navigate({ page: 'tasks', view: 'sessions', sessionKey: `r-${id}` }),
            startFailed: (id, error) => notifyError(error, '任务已创建，启动失败', { label: '重试启动', run: () => { void work.action(() => window.weaver.startTask(id)); } }),
          }))} />
      </section>
    );
  }

  // ---- board view (default) ----
  if (view === 'board') {
    const boardTaskId = route.page === 'tasks' && route.view === 'board' ? route.taskId : undefined;
    const boardTask = boardTaskId ? tasksById.get(boardTaskId) : undefined;
    const closeBoardInspector = (focusId?: string) => {
      navigate({ page: 'tasks', view: 'board' }, { replace: true });
      focusTaskRow(focusId);
    };
    return (
      <section aria-label="工作台" {...stylex.props(workbenchStyles.page)}>
        <PageHeader
          title={<TitleWithTips title="工作台" tips="看板一眼看清各状态有什么：待执行、执行中、待验收、已结束。点卡片在右侧检查器看细节，地址即状态，刷新与后退都回到同一处。" />}
          action={<div {...stylex.props(workbenchStyles.detailActions)}>{newTaskAction}{viewSwitch}</div>}
        />
        <div {...stylex.props(workbenchStyles.body)}>
          <TaskBoardView
            tasks={tasks}
            now={now}
            narrow={narrow}
            prefs={boardPrefs}
            onPrefsChange={updateBoardPrefs}
            pins={pins}
            onTogglePin={onTogglePin}
            selectedId={boardTaskId}
            onSelect={id => navigate({ page: 'tasks', view: 'board', taskId: id })}
            freeChannel={freeChannel}
            inspector={boardTaskId ? (
              <BoardInspectorOverlay label="任务检查器" narrow={narrow} onClose={() => closeBoardInspector(boardTaskId)}>
                {boardTask || tasksById.has(boardTaskId) ? (
                  <TaskInspector
                    key={boardTaskId}
                    taskId={boardTaskId}
                    tasks={tasks}
                    work={work}
                    ownerKind={ownerKind}
                    freeChannel={freeChannel}
                    taskRoute={id => ({ page: 'tasks', view: 'board', taskId: id })}
                    sessionRoute={sessionRouteOf}
                    onClose={() => closeBoardInspector(boardTaskId)}
                    onEdit={full => { setEditingTask(full); setEditing(true); }}
                  />
                ) : (
                  <MissingTaskPane onBack={() => closeBoardInspector()} />
                )}
              </BoardInspectorOverlay>
            ) : undefined}
          />
        </div>
        {editingTask && (
          <EditTaskDialog open={editing} task={editingTask} profile={ownerProfileOf(editingTask, owners)} busy={work.busy} recentWorkspaces={recentWorkspaces(tasks, 5)} close={() => setEditing(false)}
            save={(input, start, expectedRevision) => work.action(() => updateTask(taskUpdateArgs({ id: editingTask.id, revision: expectedRevision }, input, ownerProfileOf(editingTask, owners)), start, {
              update: args => command('tasks.update', args, true),
              start: id => window.weaver.startTask(id),
              startFailed: (id, error) => notifyError(error, '草稿已保存，启动失败', { label: '重试启动', run: () => { void work.action(() => window.weaver.startTask(id)); } }),
            }), notifySaveDraftFailure)} />
        )}
        <NewTaskDialog open={creating} busy={work.busy} recentWorkspaces={recentWorkspaces(tasks, 5)} close={() => setCreating(false)} onClosed={() => newTaskRef.current?.focus()}
          create={(input, start) => work.action(() => createTask(input, start, {
            create: value => command<{ id: string }>('tasks.create', { ...value }, true),
            start: id => window.weaver.startTask(id),
            select: id => navigate({ page: 'tasks', view: 'sessions', sessionKey: `r-${id}` }),
            startFailed: (id, error) => notifyError(error, '任务已创建，启动失败', { label: '重试启动', run: () => { void work.action(() => window.weaver.startTask(id)); } }),
          }))} />
      </section>
    );
  }

  // ---- sessions view ----
  const listPane = (
    <Pane
      label="会话列表"
      toolbar={<div {...stylex.props(workbenchStyles.filterStack)}>
        <Input
          ref={searchRef}
          allowClear
          aria-label="搜索会话"
          placeholder="搜索会话、任务或目录"
          prefix={<Search size={14} />}
          value={prefs.query}
          onChange={event => updatePrefs({ ...prefs, query: event.target.value })}
          {...stylex.props(workbenchStyles.search)}
        />
        <div {...stylex.props(workbenchStyles.rangeRow)}>
          <NamedSelect aria-label="时间范围" value={prefs.time} options={WORKBENCH_TIMES.map(item => ({ value: item.value, label: item.label }))} onChange={value => { if (typeof value === 'string') updatePrefs({ ...prefs, time: value as WorkbenchTime }); }} />
          <Segmented
            aria-label="会话范围"
            value={prefs.scope}
            options={[
              { value: 'attention', label: `需关注 ${attentionTotal}` },
              { value: 'active', label: '进行中' },
              { value: 'all', label: '全部' },
            ]}
            onChange={value => updatePrefs({ ...prefs, scope: value as WorkbenchSessions['scope'] })}
          />
        </div>
      </div>}
    >
      {work.loading && !tasks.length ? (
        <div role="status" aria-label="正在加载会话"><Skeleton animated /></div>
      ) : scopedSessions.length === 0 ? (
        <div {...stylex.props(workbenchStyles.emptyWrap)}>
          <Empty title={tasks.length === 0 ? '还没有任务' : '没有匹配的会话'} description={tasks.length === 0 ? undefined : '调整搜索、时间或范围。'} action={tasks.length === 0 ? <Button onClick={() => setCreating(true)}>新建任务</Button> : <Button size="small" onClick={() => updatePrefs(defaultWorkbenchSessions())}>清除筛选</Button>} />
        </div>
      ) : (
        <SelectableList<Session>
          label="会话列表"
          sections={listSections}
          getKey={item => item.key}
          selectedKey={sessionKey}
          onSelect={key => navigate({ page: 'tasks', view: 'sessions', sessionKey: key })}
          virtual={scopedSessions.length > 50}
          renderItem={item => {
            const href = routeHref({ page: 'tasks', view: 'sessions', sessionKey: item.key });
            return (
              <a
                href={href}
                title={item.title}
                onClick={event => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) { event.stopPropagation(); return; }
                  event.preventDefault();
                  event.stopPropagation();
                  navigate({ page: 'tasks', view: 'sessions', sessionKey: item.key });
                }}
                {...stylex.props(workbenchStyles.taskRow)}
              >
                <span {...stylex.props(workbenchStyles.sessionRow)}>
                  <span {...stylex.props(workbenchStyles.sessionHead)}>
                    <EngineIcon kind={item.hostKind} size={14} />
                    <span {...stylex.props(workbenchStyles.sessionTitle)}>{item.title}</span>
                    <TimeText value={item.lastActivityAt} now={now} />
                  </span>
                  <span {...stylex.props(workbenchStyles.sessionMeta)}>
                    <SessionCounts session={item} />
                    {item.attention > 0 && (
                      <span aria-label={`需关注 ${item.attention} 个任务`} {...stylex.props(workbenchStyles.attentionFlag)}>
                        <TriangleAlert size={14} aria-hidden="true" />
                        {item.attention}
                      </span>
                    )}
                  </span>
                </span>
              </a>
            );
          }}
        />
      )}
    </Pane>
  );

  const detailPane = sessionKey && !session ? (
    <Pane label="会话详情" title="未找到">
      <div {...stylex.props(workbenchStyles.emptyWrap)}>
        <Empty title="未找到" description="这个会话可能已被删除，或链接中的 ID 有误。" action={<Button onClick={() => navigate({ page: 'tasks', view: 'sessions' }, { replace: true })}>返回列表</Button>} />
      </div>
    </Pane>
  ) : session ? (
    <SessionDetail
      session={session}
      tasks={tasks}
      tasksById={tasksById}
      work={work}
      ownerKind={ownerKind}
      freeChannel={freeChannel}
      now={now}
      pins={pins}
      onTogglePin={onTogglePin}
      endedOpen={endedOpen}
      onToggleEnded={toggleEnded}
      narrow={narrow}
      onEditRoot={root => { setEditingTask(root); setEditing(true); }}
      onAskCancel={setAskCancelRoot}
    />
  ) : tasks.length === 0 ? (
    <Pane label="工作台概览" title="概览">
      <div {...stylex.props(workbenchStyles.emptyWrap)}>
        <Empty title="还没有任务" description="创建一个任务后，会话与任务会出现在这里。" action={<Button onClick={() => setCreating(true)}>新建任务</Button>} />
      </div>
    </Pane>
  ) : (
    <Pane label="工作台概览" title="概览">
      <div {...stylex.props(workbenchStyles.overview)}>
        <CompactMetrics label="工作台指标" items={metrics} loading={work.loading} />
        {attentionList.length > 0 && (
          <section aria-label="需关注的任务">
            <div {...stylex.props(workbenchStyles.overviewTitle)}>需关注 · {attentionList.length}</div>
            <div role="list" {...stylex.props(workbenchStyles.attentionList)}>
              {attentionList.slice(0, 10).map(task => {
                const key = sessionKeyOf(task, tasksById);
                return <div key={task.id} role="listitem" {...stylex.props(workbenchStyles.attentionItem)}>
                  <StatusBadge status={displayStatus(task)} />
                  <span {...stylex.props(workbenchStyles.attentionLink)}>
                    <EntityLink route={{ page: 'tasks', view: 'sessions', sessionKey: key, taskId: task.id }} title={taskTitle(task)}>
                      {taskTitle(task)}
                    </EntityLink>
                  </span>
                  <span {...stylex.props(workbenchStyles.attentionSession)}>{sessionByKey.get(key)?.title ?? key}</span>
                </div>;
              })}
            </div>
          </section>
        )}
      </div>
    </Pane>
  );

  const inspectorOpen = !!sessionTaskId;
  const mobileView = narrow ? (inspectorOpen ? 'inspector' : sessionKey ? 'main' : 'list') : 'list';

  return (
    <section aria-label="工作台" {...stylex.props(workbenchStyles.page)}>
      <PageHeader
        title={<TitleWithTips title="工作台" tips="以会话为经、以任务为纬：左侧按工作目录分组会话，主窗格看中任务，检查器看细节。地址即状态，刷新与后退都回到同一处。" />}
        action={<div {...stylex.props(workbenchStyles.detailActions)}>{newTaskAction}{viewSwitch}</div>}
      />
      <div {...stylex.props(workbenchStyles.body)}>
        <MasterDetail
          listLabel="会话列表"
          mainLabel="会话详情"
          list={listPane}
          main={detailPane}
          inspector={inspectorOpen ? (
            inspectorTask || tasksById.has(sessionTaskId!) ? (
              <TaskInspector
                key={sessionTaskId}
                taskId={sessionTaskId!}
                tasks={tasks}
                work={work}
                ownerKind={ownerKind}
                freeChannel={freeChannel}
                taskRoute={id => taskRouteIn(id, sessionKey ?? sessionKeyOf(tasksById.get(id)!, tasksById))}
                sessionRoute={sessionRouteOf}
                onClose={() => closeInspector(
                  sessionKey ? { page: 'tasks', view: 'sessions', sessionKey } : { page: 'tasks', view: 'sessions' },
                  sessionTaskId,
                )}
                onEdit={full => { setEditingTask(full); setEditing(true); }}
              />
            ) : (
              <MissingTaskPane onBack={() => closeInspector(sessionKey ? { page: 'tasks', view: 'sessions', sessionKey } : { page: 'tasks', view: 'sessions' })} />
            )
          ) : undefined}
          inspectorOpen={inspectorOpen}
          onInspectorClose={() => closeInspector(sessionKey ? { page: 'tasks', view: 'sessions', sessionKey } : { page: 'tasks', view: 'sessions' }, sessionTaskId)}
          mobileView={mobileView}
        />
      </div>
      {askCancelRoot && <CancelRootDialog task={askCancelRoot} tasks={tasks} work={work} onClose={() => setAskCancelRoot(undefined)} />}
      {editingTask && (
        <EditTaskDialog open={editing} task={editingTask} profile={ownerProfileOf(editingTask, owners)} busy={work.busy} recentWorkspaces={recentWorkspaces(tasks, 5)} close={() => setEditing(false)}
          save={(input, start, expectedRevision) => work.action(() => updateTask(taskUpdateArgs({ id: editingTask.id, revision: expectedRevision }, input, ownerProfileOf(editingTask, owners)), start, {
            update: args => command('tasks.update', args, true),
            start: id => window.weaver.startTask(id),
            startFailed: (id, error) => notifyError(error, '草稿已保存，启动失败', { label: '重试启动', run: () => { void work.action(() => window.weaver.startTask(id)); } }),
          }), notifySaveDraftFailure)} />
      )}
      <NewTaskDialog open={creating} busy={work.busy} recentWorkspaces={recentWorkspaces(tasks, 5)} close={() => setCreating(false)} onClosed={() => newTaskRef.current?.focus()}
        create={(input, start) => work.action(() => createTask(input, start, {
          create: value => command<{ id: string }>('tasks.create', { ...value }, true),
          start: id => window.weaver.startTask(id),
          select: id => navigate({ page: 'tasks', view: 'sessions', sessionKey: `r-${id}` }),
          startFailed: (id, error) => notifyError(error, '任务已创建，启动失败', { label: '重试启动', run: () => { void work.action(() => window.weaver.startTask(id)); } }),
        }))} />
    </section>
  );
}

/** The all-tasks table fills the pane body and scrolls its rows internally. */
function AllTasksTable({ columns, rows, width }: {
  columns: TableColumnsType<Task>;
  rows: Task[];
  width: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(480);
  useEffect(() => {
    const node = wrap.current;
    if (!node) return;
    const sync = () => {
      const head = node.querySelector('.ant-table-header, [class*="table-header"]');
      const headHeight = head instanceof HTMLElement ? head.clientHeight : 40;
      setBodyHeight(Math.max(240, Math.floor(node.clientHeight - headHeight)));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={wrap} {...stylex.props(workbenchStyles.allTableWrap)}>
    <Table<Task>
      virtual
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={rows}
      pagination={false}
      scroll={{ x: width, y: bodyHeight }}
      onRow={(task: Task) => ({
        tabIndex: 0,
        'data-task-row': task.id,
        onClick: () => navigate({ page: 'tasks', view: 'all', taskId: task.id }),
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate({ page: 'tasks', view: 'all', taskId: task.id }); }
        },
      })}
    />
  </div>;
}

function MissingTaskPane({ onBack }: { onBack: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let inner = 0;
    const frame = requestAnimationFrame(() => { inner = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true })); });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(inner); };
  }, []);
  return <Pane label="未找到" title="未找到"><div ref={panel} tabIndex={-1} {...stylex.props(workbenchStyles.emptyWrap, workbenchStyles.noOutline)}>
    <Empty title="未找到" description="这条任务可能已被删除，或链接中的 ID 有误。" action={<Button onClick={onBack}>返回</Button>} />
  </div></Pane>;
}

function CancelRootDialog({ task, tasks, work, onClose }: {
  task: Task;
  tasks: Task[];
  work: ReturnType<typeof useWorkbench>;
  onClose: () => void;
}) {
  const notice = rootCancelNotice(task, tasks);
  if (!notice) return null;
  return (
    <Modal open title={notice.title} width={600} okText="确认取消" cancelText="返回" okButtonProps={{ danger: true }}
      onCancel={onClose} onOk={() => { onClose(); void work.action(() => window.weaver.cancelTask(task.id)); }}>
      <Text>{notice.description}</Text>
      <Text type="secondary">{notice.detail}</Text>
    </Modal>
  );
}

function SessionDetail({ session, tasks, tasksById, work, ownerKind, freeChannel, now, pins, onTogglePin, endedOpen, onToggleEnded, narrow, onEditRoot, onAskCancel }: {
  session: Session;
  tasks: Task[];
  tasksById: Map<string, Task>;
  work: ReturnType<typeof useWorkbench>;
  ownerKind?: (ownerId?: string) => string | undefined;
  freeChannel?: (workerId?: string) => boolean;
  now: number;
  pins: Record<string, number>;
  onTogglePin: (id: string) => void;
  endedOpen: boolean;
  onToggleEnded: () => void;
  narrow: boolean;
  onEditRoot: (root: Task) => void;
  onAskCancel: (root: Task) => void;
}) {
  const root = session.root;
  const chains = useMemo(() => retryChains(session.tasks), [session.tasks]);
  const parent = parentAgentOf(session, ownerKind);
  const workspace = session.workspace;
  const startedAt = root ? (root.run?.startedAt ?? root.ownerHost?.launchedAt ?? root.createdAt) : session.tasks.reduce<string | undefined>((earliest, task) => !earliest || task.createdAt < earliest ? task.createdAt : earliest, undefined);
  const retryLaunch = !!root && root.executionRole === 'owner' && root.status === 'failed' && !root.ownerHost;
  const canStart = !!root && !root.parentTaskId && ((root.status === 'queued' && !root.scheduled) || retryLaunch);
  const draft = !!root && isDraft(root);
  const needsWorkspace = draft && !root?.workspace?.trim();
  const report = root?.ownerReport ?? null;
  const reportAge = report ? now - Date.parse(report.reportedAt) : null;
  const stale = reportAge !== null && Number.isFinite(reportAge) && reportAge > 15 * 60 * 1000;

  const renderTaskRow = (task: Task, attempt: number, indented: boolean) => {
    const status = displayStatus(task);
    const footer = cardFooter(task, { name: '', title: '' });
    const latest = task.events.at(-1);
    const activity = task.status === 'running' ? displayLog(latest?.message ?? '等待首次调度').replace(/\s+/g, ' ').trim() : '';
    const showActivity = activity !== '' && task.executionRole !== 'owner';
    const pinned = isPinned(pins, task.id);
    const href = routeHref({ page: 'tasks', view: 'sessions', sessionKey: session.key, taskId: task.id });
    return (
      <div key={task.id} {...stylex.props(workbenchStyles.taskRow, indented && workbenchStyles.retryIndent)}>
        <div {...stylex.props(workbenchStyles.taskBlock)}>
          <a
            href={href}
            title={taskTitle(task)}
            data-task-row={task.id}
            onClick={event => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) { event.stopPropagation(); return; }
              event.preventDefault();
              navigate({ page: 'tasks', view: 'sessions', sessionKey: session.key, taskId: task.id });
            }}
            {...stylex.props(workbenchStyles.taskLink)}
          >
            <span {...stylex.props(workbenchStyles.taskMain)}>
              <span {...stylex.props(workbenchStyles.taskHead)}>
              <StatusBadge status={status} />
              <span {...stylex.props(workbenchStyles.taskTitle)}>{taskTitle(task)}</span>
              {attempt > 1 && <Tag size="small" color={tagColor('neutral')}>第 {attempt} 次尝试</Tag>}
              {task.supersededBy && <Tag size="small" color={tagColor('neutral')}>已被替代</Tag>}
            </span>
            <span {...stylex.props(workbenchStyles.taskMeta)}>
              {task.dispatch?.worker ? (
                <AgentChip kind={dispatchKind(task)} name={task.dispatch.worker} title={task.dispatch.worker} />
              ) : (
                <span>未派发子 Agent</span>
              )}
              {task.dispatch?.worker && freeChannel?.(task.dispatch.worker) && <FreeChannelTag title={`子 Agent ${task.dispatch.worker} 使用免费渠道`} />}
              {showActivity && <span {...stylex.props(workbenchStyles.taskMetaText)} title={activity}>{activity}</span>}
              {!showActivity && task.summary && <span {...stylex.props(workbenchStyles.taskMetaText)} title={task.summary}>{task.summary}</span>}
              <span {...stylex.props(workbenchStyles.sessionTime)}>
                {footer.tail ? (
                  <><TimeText value={footer.at} now={now} /> {footer.verb} · {footer.tail.label} <TimeText value={footer.tail.at} now={now} /></>
                ) : (
                  <><TimeText value={footer.at} now={now} /> {footer.verb}</>
                )}
              </span>
            </span>
            </span>
          </a>
          {task.supersededBy && (
            <span {...stylex.props(workbenchStyles.taskMeta)}>
              <span>已被 <EntityLink route={{ page: 'tasks', view: 'sessions', sessionKey: session.key, taskId: task.supersededBy }} title={task.supersededBy}>{tasksById.get(task.supersededBy) ? taskTitle(tasksById.get(task.supersededBy)!) : task.supersededBy}</EntityLink> 替代</span>
            </span>
          )}
        </div>
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={pinned ? '取消置顶' : '置顶'}
          title={pinned ? '取消置顶' : '置顶'}
          onClick={() => onTogglePin(task.id)}
          {...stylex.props(workbenchStyles.pinButton)}
        >
          {pinned ? <Pin size={14} aria-hidden="true" fill="currentColor" /> : <PinOff size={14} aria-hidden="true" />}
        </button>
      </div>
    );
  };

  const chainsForSegment = (segment: TaskSegment): Task[][] => [...chains.values()]
    .filter(chain => taskSegment(chain[chain.length - 1]!, tasks, now) === segment)
    .sort((a, b) => (b[b.length - 1]!.updatedAt).localeCompare(a[a.length - 1]!.updatedAt));

  const renderGroup = (segment: TaskSegment, label: string) => {
    const segmentChains = chainsForSegment(segment);
    if (!segmentChains.length) return null;
    const { pinned: pinnedChains, rest: restChains } = splitPinnedChains(segmentChains, pins);
    const ordered = [...pinnedChains, ...restChains];
    const count = segmentChains.reduce((sum, chain) => sum + chain.length, 0);
    const foldable = segment === 'closed';
    const shown = !foldable || endedOpen;
    return (
      <section key={segment} aria-label={`${label}任务`} {...stylex.props(workbenchStyles.group)}>
        <div {...stylex.props(workbenchStyles.groupHead)}>
          {foldable ? (
            <button type="button" aria-expanded={shown} onClick={onToggleEnded} {...stylex.props(workbenchStyles.groupToggle)}>
              {shown ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              <span {...stylex.props(workbenchStyles.groupTitle)}>{label}</span>
              <span {...stylex.props(workbenchStyles.groupCount)}>{count}</span>
            </button>
          ) : (
            <><span {...stylex.props(workbenchStyles.groupTitle)}>{label}</span><span {...stylex.props(workbenchStyles.groupCount)}>{count}</span></>
          )}
        </div>
        {shown && ordered.map(chain => chain.map((task, index) => renderTaskRow(
          task,
          chain.length > 1 ? retryAttemptOf(task, chains) : 1,
          chain.length > 1 && index > 0,
        )))}
      </section>
    );
  };

  return (
    <Pane
      label="会话详情"
      title={narrow ? <Button size="small" icon={<ArrowLeft size={14} />} onClick={() => navigate({ page: 'tasks', view: 'sessions' })}>返回</Button> : undefined}
    >
      <div {...stylex.props(workbenchStyles.detailHead)}>
        <div {...stylex.props(workbenchStyles.detailTitle)}>{session.title}</div>
        <div {...stylex.props(workbenchStyles.detailTags)}>
          {session.kind === 'root' && <Tag color={tagColor('childRole')}>网页发起</Tag>}
          {session.kind === 'host' && <Tag color={tagColor('ownerRole')}>宿主会话</Tag>}
          <span {...stylex.props(workbenchStyles.factLabel)}>父 Agent</span>
          <AgentChip kind={parent.kind} name={parent.name} title={parent.title} />
        </div>
        <div {...stylex.props(workbenchStyles.detailFacts)}>
          {workspace && (
            <div {...stylex.props(workbenchStyles.factRow)}>
              <span {...stylex.props(workbenchStyles.factLabel)}>工作目录</span>
              <span {...stylex.props(workbenchStyles.factValue)} title={workspace}>{workspace}</span>
              <CopyButton aria-label="复制工作目录" content={workspace} size="small" title="复制工作目录" />
            </div>
          )}
          {startedAt && (
            <div {...stylex.props(workbenchStyles.factRow)}>
              <span {...stylex.props(workbenchStyles.factLabel)}>开始时间</span>
              <TimeText value={startedAt} now={now} />
            </div>
          )}
        </div>
        {needsWorkspace && <Text type="secondary">先编辑补充目标项目目录，才能开始执行。</Text>}
        {session.kind === 'root' && root && (
          <div {...stylex.props(workbenchStyles.detailActions)}>
            {canStart && <Button type="primary" disabled={work.busy || needsWorkspace} onClick={() => void work.action(() => window.weaver.startTask(root.id))}>{retryLaunch ? '重试启动父 Agent' : '开始执行'}</Button>}
            {draft && <Button disabled={work.busy} onClick={() => onEditRoot(root)}>编辑</Button>}
            {isActive(root) && <Button disabled={work.busy || root.status === 'cancelling'} onClick={() => { const notice = rootCancelNotice(root, tasks); if (notice) onAskCancel(root); else void work.action(() => window.weaver.cancelTask(root.id)); }}>{root.status === 'cancelling' ? '正在停止…' : '取消'}</Button>}
            <ContinueSessionButton task={root} busy={work.busy} action={work.action} />
          </div>
        )}
      </div>
      {session.kind === 'root' && root && (
        <section aria-label="进度汇报" {...stylex.props(workbenchStyles.report)}>
          <div {...stylex.props(workbenchStyles.reportTitle)}>进度汇报</div>
          {report ? (
            <>
              <Text>{report.summary}</Text>
              {report.percent !== null && <Progress percent={report.percent} />}
              {report.phase && <Text type="secondary">阶段：{report.phase}</Text>}
              {report.blockers.length > 0 && (
                <ul {...stylex.props(workbenchStyles.blockerList)}>
                  {report.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}
                </ul>
              )}
              {report.nextSteps.length > 0 && <Text type="secondary">下一步：{report.nextSteps.join('；')}</Text>}
              <span {...stylex.props(workbenchStyles.reportMeta)}>
                汇报于 <TimeText value={report.reportedAt} now={now} />
                {stale && <span {...stylex.props(workbenchStyles.staleMark)}> · 已过期</span>}
              </span>
            </>
          ) : (
            <Text type="secondary">父 Agent 尚未汇报进度</Text>
          )}
        </section>
      )}
      {session.kind === 'root' && root && (
        <section aria-label="会话目标" {...stylex.props(workbenchStyles.goalWrap)}>
          <TaskTextBlock title="会话目标" content={[root.instruction, (root.acceptanceCriteria ?? []).length ? `验收标准：\n${(root.acceptanceCriteria ?? []).map(item => `- ${item}`).join('\n')}` : ''].filter(Boolean).join('\n\n')} clamp={4} />
        </section>
      )}
      {session.tasks.length === 0 ? (
        <div {...stylex.props(workbenchStyles.emptyWrap)}>
          <Empty title="这个会话还没有任务" description={session.kind === 'root' ? '父 Agent 启动后，拆分的子任务会出现在这里。' : undefined} />
        </div>
      ) : (
        TASK_SEGMENTS.map(segment => renderGroup(segment.key, segment.label))
      )}
    </Pane>
  );
}

function splitPinnedChains(chains: Task[][], pins: Record<string, number>): { pinned: Task[][]; rest: Task[][] } {
  const pinned: Task[][] = [];
  const rest: Task[][] = [];
  for (const chain of chains) {
    const pinTimes = chain.filter(task => isPinned(pins, task.id)).map(task => pins[task.id] ?? 0);
    (pinTimes.length ? pinned : rest).push(chain);
  }
  pinned.sort((a, b) => Math.max(...a.map(t => pins[t.id] ?? 0)) > Math.max(...b.map(t => pins[t.id] ?? 0)) ? -1 : 1);
  return { pinned, rest };
}
