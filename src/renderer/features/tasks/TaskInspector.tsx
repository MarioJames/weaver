import { useEffect, useRef, useState, type JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ActionIcon, Alert, Button, CopyButton, Descriptions, Empty, Modal, Skeleton, Text } from '@lobehub/ui';
import { PageTabs } from '@lobehub/ui/dashboard';
import { X } from 'lucide-react';
import { notifyError } from '../../api/notify';
import { command } from '../../api/commands';
import type { Route } from '../../app/router';
import { navigate } from '../../app/router';
import type { Task } from '../../../shared/contracts/tasks';
import { StatusBadge } from '../../ui/StatusBadge';
import { AgentChip } from '../../ui/AgentChip';
import { EntityLink } from '../../ui/EntityLink';
import { TimeText } from '../../ui/TimeText';
import { styles as shared } from '../../ui/styles';
import { displayStatus } from '../../format/status-colors';
import { dispatchKind, isActive, isDraft, ownerDisplayName, ownerLabel, rootCancelNotice, taskTitle } from './task-view';
import { displayLog, redactLog, timelineActive } from './log-view';
import { modelText } from './AgentFacts';
import { TaskTextBlock } from './TaskTextBlock';
import { TaskHealthBadge } from './TaskHealthBadge';
import { TaskAgents } from './TaskAgents';
import { EventsPanel } from './EventsPanel';
import { ReviewPanel } from './ReviewPanel';
import { ArtifactsPanel } from './ArtifactsPanel';
import type { useWorkbench } from './useWorkbench';
import { inspectorStyles } from './inspector-style';
import { failureKindAdvice, failureKindLabels, inspectorArtifacts, queueLabels } from './inspector-view';

export interface TaskInspectorViewProps {
  task: Task;
  tasks: Task[];
  busy: boolean;
  action: (fn: () => Promise<unknown>) => Promise<boolean>;
  ownerKind?: (ownerId?: string) => string | undefined;
  freeChannel?: (workerId?: string) => boolean;
  taskRoute(taskId: string): Route;
  sessionRoute?(task: Task): Route | undefined;
  /** First visible tab; the drawer always opens on the overview. Only used by tests. */
  initialTab?: 'overview' | 'timeline' | 'result' | 'requirements';
  onClose(): void;
  onEdit?(task: Task): void;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return /^([A-Z][A-Z_0-9]+):/.exec(String((error as Error)?.message ?? error))?.[1] ?? '';
}

/** Failure banner: the kind in Chinese, one recovery hint, the message, and expandable raw details. */
function FailureBanner({ task }: { task: Task }) {
  const failure = task.failure;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [task.id]);
  const message = redactLog(failure?.message ?? [...task.events].reverse().find(event => event.kind === 'error')?.message ?? '查看时间线了解详情。');
  const details = [
    failure?.stderrTail ? { key: 'stderr', label: 'stderr 末尾', text: redactLog(failure.stderrTail) } : undefined,
    failure?.vendorError ? { key: 'vendor', label: '供应商错误', text: redactLog(failure.vendorError) } : undefined,
  ].filter(item => !!item);
  const copyText = [message, ...details.map(item => item.text)].join('\n\n');
  return <Alert type="error" title={failure?.kind ? `执行失败 · ${failureKindLabels[failure.kind]}` : '执行失败'} description={<div {...stylex.props(inspectorStyles.bannerBody)}>
    {failure?.kind && <Text>{failureKindAdvice[failure.kind]}</Text>}
    <Text className={stylex.props(shared.wrap).className}>{message}</Text>
    {details.length > 0 && <div {...stylex.props(inspectorStyles.bannerRow)}>
      <Button size="small" type="text" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}错误详情`} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开'}错误详情</Button>
      <CopyButton content={copyText} size="small" aria-label="复制失败信息" title="复制失败信息" />
    </div>}
    {expanded && details.map(item => <div key={item.key} {...stylex.props(inspectorStyles.bannerBody)}>
      <Text type="secondary" fontSize={12}>{item.label}</Text>
      <pre {...stylex.props(inspectorStyles.bannerCode)}>{item.text}</pre>
    </div>)}
  </div>} />;
}

/** The loaded inspector: header, banners and the four tabs. Data loading, Esc and focus live here too. */
export function TaskInspectorView({ task, tasks, busy, action, ownerKind, freeChannel, taskRoute, sessionRoute, initialTab, onClose, onEdit }: TaskInspectorViewProps): JSX.Element {
  const [tab, setTab] = useState(initialTab ?? 'overview');
  const [askCancel, setAskCancel] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  useEffect(() => { setReviewOpen(false); }, [task.id]);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    let inner = 0;
    const frame = requestAnimationFrame(() => { inner = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true })); });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(inner); };
  }, []);
  const draft = isDraft(task);
  const needsWorkspace = draft && !task.workspace?.trim();
  const retryLaunch = task.executionRole === 'owner' && task.status === 'failed' && !task.ownerHost;
  const canStart = !task.parentTaskId && ((task.status === 'queued' && !task.scheduled) || retryLaunch);
  const showReview = task.status === 'completed' && (!task.reviewState || task.reviewState === 'pending');
  const showRetry = task.executionRole !== 'owner' && !isActive(task) && task.reviewState !== 'accepted';
  const latest = task.events.at(-1);
  const failure = [...task.events].reverse().find(event => event.kind === 'error');
  const status = displayStatus(task);
  const activity = task.status === 'running' ? displayLog(latest?.message ?? '等待首次调度').replace(/\s+/g, ' ').trim() : '';
  const showActivity = activity !== '' && task.executionRole !== 'owner' && !/^父 Agent.*子 Agent/.test(activity);
  const cancelNotice = rootCancelNotice(task, tasks);
  const queueNotice = task.scheduled || (task.status === 'queued' && task.queueReason);
  const artifacts = inspectorArtifacts(task);
  const session = sessionRoute?.(task);
  const sessionName = ownerDisplayName(task, tasks);
  const sessionFullName = ownerLabel(task);
  const workspace = task.dispatch?.workspace || task.workspace;
  const retryTask = task.retryOf ? tasks.find(item => item.id === task.retryOf) : undefined;
  const retryTitle = retryTask ? taskTitle(retryTask) : (task.retryOf ?? '');
  const supersededTask = task.supersededBy ? tasks.find(item => item.id === task.supersededBy) : undefined;
  const supersededTitle = supersededTask ? taskTitle(supersededTask) : (task.supersededBy ?? '');
  const openReview = () => { setTab('result'); setReviewOpen(true); };
  return <section ref={panel} tabIndex={-1} aria-label="任务检查器" {...stylex.props(inspectorStyles.root)}>
    <div {...stylex.props(inspectorStyles.header)}>
      <div {...stylex.props(inspectorStyles.heading)}>
        <Text className={stylex.props(shared.wrap, inspectorStyles.title).className}>{taskTitle(task)}</Text>
        <div {...stylex.props(shared.row)}>
          <StatusBadge status={status} variant="tag" />
          <TaskHealthBadge taskId={task.id} active={task.status === 'running'} />
        </div>
        {needsWorkspace && <Text type="secondary">先编辑补充目标项目目录，才能开始执行。</Text>}
      </div>
      <div {...stylex.props(inspectorStyles.actions)}>
        {showReview && <Button type="primary" disabled={busy} onClick={openReview}>验收</Button>}
        {draft && onEdit && <Button disabled={busy} onClick={() => onEdit(task)}>编辑</Button>}
        {canStart && <Button type="primary" disabled={busy || needsWorkspace} onClick={() => void action(() => window.weaver.startTask(task.id))}>{retryLaunch ? '重试启动父 Agent' : '开始执行'}</Button>}
        {isActive(task) && <Button disabled={busy || task.status === 'cancelling'} onClick={() => cancelNotice ? setAskCancel(true) : void action(() => window.weaver.cancelTask(task.id))}>{task.status === 'cancelling' ? '正在停止…' : '取消任务'}</Button>}
        {showRetry && <Button disabled={busy} onClick={() => void action(async () => { const next = await command<{ id: string }>('tasks.retry', { taskId: task.id }, true); navigate(taskRoute(next.id)); })}>新建重试任务</Button>}
        <ActionIcon icon={X} aria-label="关闭任务详情" title="关闭任务详情" onClick={onClose} />
      </div>
    </div>
    {cancelNotice && <Modal open={askCancel} title={cancelNotice.title} width={600} okText="确认取消" cancelText="返回" okButtonProps={{ danger: true }} onCancel={() => setAskCancel(false)} onOk={() => { setAskCancel(false); void action(() => window.weaver.cancelTask(task.id)); }}>
      <div {...stylex.props(shared.stack)}><Text>{cancelNotice.description}</Text><Text type="secondary">{cancelNotice.detail}</Text></div>
    </Modal>}
    {(queueNotice || task.status === 'failed' || task.status === 'cancelled' || task.supersededBy) && <div {...stylex.props(inspectorStyles.banners)}>
      {queueNotice && <Alert type="info" title="调度请求已排队" description={task.queueReason ? `${queueLabels[task.queueReason.code]}：${redactLog(task.queueReason.message)}` : '等待调度检查。'} />}
      {task.status === 'failed' && <FailureBanner task={task} />}
      {task.status === 'cancelled' && <Alert type="secondary" title="执行已取消" description={redactLog(failure?.message ?? latest?.message ?? '查看时间线。')} />}
      {task.supersededBy && <Alert type="info" title="已被替代" description={<span>{task.supersededReason ? `${redactLog(task.supersededReason)} ` : ''}<EntityLink route={taskRoute(task.supersededBy)} title={supersededTitle}>{supersededTitle}</EntityLink></span>} />}
    </div>}
    <div {...stylex.props(inspectorStyles.tabs)}>
      <PageTabs label="任务详情页" value={tab} onChange={setTab} tabs={[
        { value: 'overview', label: '概况', content: <div {...stylex.props(inspectorStyles.overview)}>
          {showActivity && <Text type="secondary" className={stylex.props(inspectorStyles.activity).className}>{activity}</Text>}
          {task.summary && <TaskTextBlock key={`${task.id}:summary`} title="执行结果" content={task.summary} markdown clamp={6} />}
          <Descriptions colon={false} column={2} items={[
            task.dispatch?.worker
              ? { key: 'worker', label: '子 Agent', children: <AgentChip kind={dispatchKind(task)} name={task.dispatch.worker} title={task.dispatch.worker} /> }
              : { key: 'worker', label: '子 Agent', children: <Text type="secondary">未派发给子 Agent</Text> },
            modelText(task)
              ? { key: 'model', label: '模型', children: <Text ellipsis={{ rows: 1, tooltip: modelText(task) }}>{modelText(task)}</Text> }
              : { key: 'model', label: '模型', children: <Text type="secondary">未记录</Text> },
            { key: 'session', label: '会话', children: session ? <EntityLink route={session} title={sessionFullName}>{sessionName}</EntityLink> : <Text title={sessionFullName}>{sessionName}</Text> },
            workspace
              ? { key: 'workspace', label: '工作目录', children: <span {...stylex.props(inspectorStyles.value)}>
                <Text className={stylex.props(inspectorStyles.path).className} ellipsis={{ rows: 1, tooltip: workspace }}>{workspace}</Text>
                <CopyButton aria-label="复制工作目录" content={workspace} size="small" title="复制工作目录" />
              </span> }
              : { key: 'workspace', label: '工作目录', children: <Text type="secondary">未设置</Text> },
            { key: 'created', label: '派发时间', children: <TimeText className={stylex.props(shared.numbers).className} value={task.createdAt} /> },
            { key: 'updated', label: '最近更新', children: <TimeText className={stylex.props(shared.numbers).className} value={task.updatedAt} /> },
            ...(task.retryOf ? [{ key: 'retryOf', label: '重试来源', children: <EntityLink route={taskRoute(task.retryOf)} title={retryTitle}>{retryTitle}</EntityLink> }] : []),
          ]} />
          <TaskAgents task={task} tasks={tasks} taskRoute={taskRoute} ownerKind={ownerKind} freeChannel={freeChannel} />
        </div> },
        { value: 'timeline', label: '时间线', count: task.events.length, content: <EventsPanel events={task.events} taskId={task.id} active={timelineActive(task.status)} failure={task.failure} /> },
        { value: 'result', label: '结果与验收', content: <div {...stylex.props(inspectorStyles.overview)}>
          {task.status === 'completed'
            ? <ReviewPanel key={task.id} task={task} tasks={tasks} busy={busy} action={action} ownerKind={ownerKind} open={reviewOpen} onOpenChange={setReviewOpen} />
            : <Text type="secondary">执行成功后进入验收</Text>}
          <ArtifactsPanel artifacts={artifacts} status={task.status} />
        </div> },
        { value: 'requirements', label: '要求', content: <div {...stylex.props(inspectorStyles.overview)}>
          {task.constraints?.length ? <div {...stylex.props(inspectorStyles.section)}><Text strong>执行约束</Text><ul {...stylex.props(inspectorStyles.list)}>{task.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></div> : undefined}
          <div {...stylex.props(inspectorStyles.section)}><Text strong>验收标准</Text>
            {task.acceptanceCriteria?.length
              ? <ol {...stylex.props(inspectorStyles.list)}>{task.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ol>
              : <Text type="secondary">等待父 Agent 生成验收标准。</Text>}
          </div>
          <TaskTextBlock key={`${task.id}:prompt`} title="Prompt" content={task.instruction} clamp={6} />
        </div> },
      ]} />
    </div>
  </section>;
}

export function TaskInspector({ taskId, tasks, work, ownerKind, freeChannel, taskRoute, sessionRoute, onClose, onEdit }: {
  taskId: string;
  tasks: Task[];
  work: ReturnType<typeof useWorkbench>;
  ownerKind?: (ownerId?: string) => string | undefined;
  freeChannel?: (workerId?: string) => boolean;
  taskRoute(taskId: string): Route;
  sessionRoute?(task: Task): Route | undefined;
  onClose(): void;
  onEdit(task: Task): void;
}): JSX.Element {
  const listed = tasks.find(item => item.id === taskId);
  const [full, setFull] = useState<Task>();
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setFull(undefined);
    setMissing(false);
    setFailed(false);
    void window.weaver.getTask(taskId).then(value => { if (current) setFull(value); }).catch(error => {
      if (!current) return;
      if (errorCode(error) === 'NOT_FOUND') { setMissing(true); return; }
      setFailed(true);
      notifyError(error, '任务详情读取失败', { label: '重试', run: () => setAttempt(value => value + 1) });
    });
    return () => { current = false; };
  }, [taskId, listed?.revision, listed?.updatedAt, attempt]);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  if (missing) return <div {...stylex.props(inspectorStyles.root)}><Empty title="未找到这条任务" description="它可能已被删除，关闭后回到列表。" action={<Button onClick={onClose}>关闭</Button>} /></div>;
  if (failed && !full) return <div {...stylex.props(inspectorStyles.root)}><div {...stylex.props(inspectorStyles.error)}><Text type="secondary">任务详情读取失败</Text><Button size="small" type="text" onClick={() => setAttempt(value => value + 1)}>重试</Button></div></div>;
  if (!full) return <div role="status" aria-label="正在加载任务详情" {...stylex.props(inspectorStyles.root)}><Skeleton animated /></div>;
  const merged = listed ? { ...full, owner: listed.owner } : full;
  return <TaskInspectorView key={merged.id} task={merged} tasks={tasks} busy={work.busy || !work.caps} action={work.action} ownerKind={ownerKind} freeChannel={freeChannel} taskRoute={taskRoute} sessionRoute={sessionRoute} onClose={onClose} onEdit={onEdit} />;
}
