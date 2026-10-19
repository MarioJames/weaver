import { useState } from 'react';
import { Empty, Icon } from '@lobehub/ui';
import { Alert, Button, Tabs, Tag, Text } from '@lobehub/ui/base-ui';
import { Loader2 } from 'lucide-react';
import type { Task } from '../../shared/types';
import { redactLog, timelineActive } from '../log-view';
import { isActive, reviewLabel, statusLabels } from '../task-view';
import { styles } from '../style';
import { AgentFacts } from './AgentFacts';
import { ArtifactsPanel } from './ArtifactsPanel';
import { EventsPanel } from './EventsPanel';
import { OwnerInspector } from './OwnerInspector';
import { ReviewPanel } from './ReviewPanel';
import { TaskTextBlock } from './TaskTextBlock';
import { styles as detailStyles } from './task-detail-style';

const queueLabels = { waiting_for_capacity: '等待执行槽位', policy_blocked: '当前策略阻止派发', frozen_route_changed: '已冻结路由发生变化', workspace_changed: '工作目录发生变化', launch_blocked: '执行启动受阻' };
export function TaskDetail({ task, busy, onStart, onCancel, action, onRetry, ownerKind }: { task?: Task; busy: boolean; onStart: (id: string) => void; onCancel: (id: string) => void; action: (fn: () => Promise<unknown>) => Promise<boolean>; onRetry?: (id: string) => void; ownerKind?: (ownerId?: string) => string | undefined }) {
  const [tab, setTab] = useState('overview');
  if (!task) return <Empty title="选择一项任务" description="创建或导入后，执行、交接和验收都留在同一条记录里。" />;
  const latest = task.events.at(-1);
  const failure = [...task.events].reverse().find(event => event.kind === 'error');
  const dispatch = task.dispatch;
  const rest = [dispatch && `${dispatch.engine} / ${dispatch.model}`, dispatch?.effort, `更新于 ${new Date(task.updatedAt).toLocaleString()}`].filter(Boolean).join(' · ');
  const queueNotice = task.scheduled || (task.status === 'queued' && task.queueReason);
  return <section aria-label="任务详情" className={styles.stack}>
    <div className={styles.spread}>
      <div className={styles.tight}>
        <Text className={styles.wrap} style={{ fontSize: 18, fontWeight: 600 }}>{task.title}</Text>
        <div className={styles.row}>
          <Tag icon={isActive(task) ? <Icon icon={Loader2} spin size="small" /> : undefined}>{statusLabels[task.status]}</Tag>
          {task.status === 'completed' && <Tag>{reviewLabel(task)}</Tag>}
        </div>
      </div>
      <div className={styles.row}>
        {task.status === 'queued' && !task.scheduled && <Button type="primary" disabled={busy} onClick={() => onStart(task.id)}>开始执行</Button>}
        {isActive(task) && <Button disabled={busy || task.status === 'cancelling'} onClick={() => onCancel(task.id)}>{task.status === 'cancelling' ? '正在停止…' : '取消任务'}</Button>}
        {!isActive(task) && onRetry && <Button disabled={busy} onClick={() => onRetry(task.id)}>新建重试任务</Button>}
      </div>
    </div>
    <AgentFacts task={task} ownerKind={ownerKind} />
    <Text type="secondary" className={styles.wrap}>{rest}</Text>
    {queueNotice ? <Alert type="info" title="调度请求已排队" description={task.queueReason ? `${queueLabels[task.queueReason.code]}：${redactLog(task.queueReason.message)}` : '等待调度检查。'} />
      : task.status === 'failed' ? <Alert type="error" title="执行失败" description={redactLog(failure?.message ?? latest?.message ?? '查看时间线。')} />
        : task.status === 'cancelled' ? <Alert type="secondary" title="执行已取消" description={redactLog(failure?.message ?? latest?.message ?? '查看时间线。')} /> : undefined}
    {task.retryOf && <Text type="secondary" className={styles.wrap}>重试来源：{task.retryOf}</Text>}
    <div role="group" aria-label="任务记录" className={detailStyles.tabs}>
      <Tabs activeKey={tab} onChange={setTab} variant="square" size="small" classNames={{ list: detailStyles.tabList, panel: detailStyles.panel }} items={[
        { key: 'overview', label: '概览', children: <div className={detailStyles.overview}>
          <TaskTextBlock title="Prompt" content={task.instruction} />
          {task.constraints?.length ? <div className={styles.stack}><Text style={{ fontWeight: 600 }}>执行约束</Text><ul className={detailStyles.list}>{task.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></div> : undefined}
          <div className={styles.stack}><Text style={{ fontWeight: 600 }}>验收标准</Text>
            {task.acceptanceCriteria?.length ? <ol className={detailStyles.list}>{task.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ol> : <Text type="secondary">此旧任务未记录结构化验收标准。</Text>}
          </div>
          {task.summary && <TaskTextBlock title="执行结果" content={task.summary} />}
        </div> },
        { key: 'events', label: '时间线 ' + task.events.length, children: <EventsPanel events={task.events} taskId={task.id} active={timelineActive(task.status)} /> },
        { key: 'artifacts', label: '产物 ' + task.artifacts.length, children: <ArtifactsPanel artifacts={task.artifacts} /> },
        { key: 'review', label: '验收', children: task.status === 'completed' ? <ReviewPanel task={task} busy={busy} action={action} /> : <Empty title="执行成功后进入验收" description="执行结果、收到确认和验收结论各自独立。" /> },
        { key: 'continuation', label: '接续', children: <OwnerInspector task={task} busy={busy} action={action} /> },
      ]} />
    </div>
  </section>;
}
