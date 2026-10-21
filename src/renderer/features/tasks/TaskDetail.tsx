import { useEffect, useRef, useState } from 'react';
import { Empty, Icon } from '@lobehub/ui';
import { Alert, Button, Modal, Tabs, Tag, Text } from '@lobehub/ui/base-ui';
import { Loader2 } from 'lucide-react';
import { useNotifyError } from '../../api/notify';
import { TaskAgents } from './TaskAgents';
import type { Task } from '../../../shared/contracts/tasks';
import { displayLog, redactLog, timelineActive, toneColor } from './log-view';
import { DISPLAY_LABELS, DISPLAY_TONES, displayStatus } from '../../format/status-colors';
import { isActive, isDraft, rootCancelNotice, taskTitle } from './task-view';
import { styles } from '../../ui/styles';
import { AgentFacts } from './AgentFacts';
import { ArtifactsPanel } from './ArtifactsPanel';
import { EventsPanel } from './EventsPanel';
import { OwnerInspector } from '../roles/OwnerInspector';
import { ReviewPanel } from './ReviewPanel';
import { TaskTextBlock } from './TaskTextBlock';
import { styles as detailStyles } from './task-detail-style';

const queueLabels = { waiting_for_capacity: '等待执行槽位', policy_blocked: '当前策略阻止派发', frozen_route_changed: '已冻结路由发生变化', workspace_changed: '工作目录发生变化', launch_blocked: '执行启动受阻' };
export function TaskDetail({ task, busy, onStart, onEdit, onCancel, action, onRetry, ownerKind, tasks = [], onSelect }: { tasks?: Task[]; onSelect?: (id: string) => void; task?: Task; busy: boolean; onStart: (id: string) => void; onEdit?: (id: string) => void; onCancel: (id: string) => void; action: (fn: () => Promise<unknown>) => Promise<boolean>; onRetry?: (id: string) => void; ownerKind?: (ownerId?: string) => string | undefined }) {
  const [tab, setTab] = useState('overview');
  const [askCancel, setAskCancel] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  useEffect(() => { setReviewOpen(false); }, [task?.id]);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { const frame = requestAnimationFrame(() => panel.current?.closest('[role="dialog"]') && panel.current.focus({ preventScroll: true })); return () => cancelAnimationFrame(frame); }, []);
  useEffect(() => {
    const list = panel.current?.querySelector<HTMLElement>('[role="tablist"]');
    if (!list) return;
    const measure = () => {
      const start = list.scrollLeft > 1;
      const end = list.scrollWidth - list.clientWidth - list.scrollLeft > 1;
      list.dataset.overflow = start && end ? 'both' : start ? 'start' : end ? 'end' : 'none';
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    list.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); list.removeEventListener('scroll', measure); };
  }, [task?.id]);
  const failedMessage = task?.status === 'failed' ? redactLog(task.failure?.message ?? [...task.events].reverse().find(event => event.kind === 'error')?.message ?? '查看时间线了解详情。') : '';
  useNotifyError(failedMessage, '执行失败');
  if (!task) return <Empty title="选择一项任务" description="创建或导入后，执行、交接和验收都留在同一条记录里。" />;
  const retryLaunch = task.executionRole === 'owner' && task.status === 'failed' && !task.ownerHost;
  const canStart = !task.parentTaskId && ((task.status === 'queued' && !task.scheduled) || retryLaunch);
  const draft = isDraft(task);
  const needsWorkspace = draft && !task.workspace?.trim();
  const latest = task.events.at(-1);
  const failure = [...task.events].reverse().find(event => event.kind === 'error');
  const status = displayStatus(task);
  const activity = task.status === 'running' ? displayLog(latest?.message ?? '等待首次调度').replace(/\s+/g, ' ').trim() : '';
  const showActivity = activity && task.executionRole !== 'owner' && !/^父 Agent.*子 Agent/.test(activity);
  const summary = task.summary?.trim();
  const artifacts = task.summary ? task.artifacts.filter(artifact => artifact.content.trim() !== summary) : task.artifacts;
  const cancelNotice = task ? rootCancelNotice(task, tasks) : undefined;
  const queueNotice = task.scheduled || (task.status === 'queued' && task.queueReason);
  return <section ref={panel} tabIndex={-1} aria-label="任务详情" className={styles.stack}>
    <div className={detailStyles.header}>
      <div className={detailStyles.heading}>
        <Text className={styles.wrap} style={{ fontSize: 18, fontWeight: 600 }}>{taskTitle(task)}</Text>
        <div className={styles.row}>
          <Tag className={detailStyles.statusTag} variant="solid" color={toneColor(DISPLAY_TONES[status])} icon={timelineActive(task.status) ? <Icon icon={Loader2} spin size="small" /> : undefined}>{DISPLAY_LABELS[status]}</Tag>
        </div>
        {needsWorkspace && <Text type="secondary">先编辑补充目标项目目录，才能开始执行。</Text>}
      </div>
      <div className={detailStyles.actions}>
        {task.status === 'completed' && (!task.reviewState || task.reviewState === 'pending') && <Button type="primary" disabled={busy} onClick={() => { setTab('review'); setReviewOpen(true); }}>手动验收</Button>}
        {draft && onEdit && <Button disabled={busy} onClick={() => onEdit(task.id)}>编辑</Button>}
        {canStart && <Button type="primary" disabled={busy || needsWorkspace} onClick={() => onStart(task.id)}>{retryLaunch ? '重试启动父 Agent' : '开始执行'}</Button>}
        {isActive(task) && <Button disabled={busy || task.status === 'cancelling'} onClick={() => cancelNotice ? setAskCancel(true) : onCancel(task.id)}>{task.status === 'cancelling' ? '正在停止…' : '取消任务'}</Button>}
        {task.executionRole !== 'owner' && !isActive(task) && task.reviewState !== 'accepted' && onRetry && <Button disabled={busy} onClick={() => onRetry(task.id)}>新建重试任务</Button>}
      </div>
    </div>
    {cancelNotice && <Modal open={askCancel} title={cancelNotice.title} width={600} okText="确认取消" cancelText="返回" okButtonProps={{ danger: true }} onCancel={() => setAskCancel(false)} onOk={() => { setAskCancel(false); onCancel(task.id); }}>
      <div className={styles.stack}><Text>{cancelNotice.description}</Text><Text type="secondary">{cancelNotice.detail}</Text></div>
    </Modal>}
    <div role="group" aria-label="任务记录" className={detailStyles.tabs}>
      <Tabs activeKey={tab} onChange={setTab} variant="square" size="small" classNames={{ list: detailStyles.tabList, panel: detailStyles.panel }} items={[
        { key: 'overview', label: '概览', children: <div className={detailStyles.overview}>
          {queueNotice ? <Alert type="info" title="调度请求已排队" description={task.queueReason ? `${queueLabels[task.queueReason.code]}：${redactLog(task.queueReason.message)}` : '等待调度检查。'} />
            : task.status === 'cancelled' ? <Alert type="secondary" title="执行已取消" description={redactLog(failure?.message ?? latest?.message ?? '查看时间线。')} /> : showActivity ? <Text type="secondary" className={detailStyles.activity}>{activity}</Text> : undefined}
          {task.summary && <TaskTextBlock key={`${task.id}:summary`} title="执行结果" content={task.summary} markdown clamp={6} />}
          <AgentFacts task={task} ownerKind={ownerKind} />
          <TaskAgents task={task} tasks={tasks} onSelect={onSelect} ownerKind={ownerKind} />
          {task.retryOf && <Text type="secondary" className={styles.wrap}>重试来源：{task.retryOf}</Text>}
        </div> },
        { key: 'prompt', label: 'Prompt', children: <TaskTextBlock key={`${task.id}:prompt`} title="Prompt" content={task.instruction} /> },
        { key: 'requirements', label: '要求' + ((task.acceptanceCriteria?.length ?? 0) + (task.constraints?.length ?? 0) ? ` ${(task.acceptanceCriteria?.length ?? 0) + (task.constraints?.length ?? 0)}` : ''), children: <div className={detailStyles.overview}>
          {task.constraints?.length ? <div className={styles.stack}><Text style={{ fontWeight: 600 }}>执行约束</Text><ul className={detailStyles.list}>{task.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></div> : undefined}
          <div className={styles.stack}><Text style={{ fontWeight: 600 }}>验收标准</Text>
            {task.acceptanceCriteria?.length ? <ol className={detailStyles.list}>{task.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ol> : <Text type="secondary">等待父 Agent 生成并填充验收标准。</Text>}
          </div>
        </div> },
        { key: 'events', label: '时间线 ' + task.events.length, children: <EventsPanel events={task.events} taskId={task.id} active={timelineActive(task.status)} failure={task.failure} /> },
        { key: 'artifacts', label: '产物 ' + artifacts.length, children: <ArtifactsPanel artifacts={artifacts} status={task.status} /> },
        { key: 'review', label: '验收', children: task.status === 'completed' ? <ReviewPanel key={task.id} task={task} busy={busy} action={action} ownerKind={ownerKind} open={reviewOpen} onOpenChange={setReviewOpen} /> : <Empty title="执行成功后进入验收" description="执行结果、收到确认和验收结论各自独立。" /> },
        { key: 'continuation', label: '接续', children: <OwnerInspector task={task} busy={busy} action={action} /> },
      ]} />
    </div>
  </section>;
}
