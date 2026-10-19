import { useState, type KeyboardEvent } from 'react';
import { Empty } from '@lobehub/ui';
import { Button, Progress, Tag, Text } from '@lobehub/ui/base-ui';
import type { Task } from '../../shared/types';
import { redactLog } from '../log-view';
import { isActive, nextTab, reviewLabel, statusLabels } from '../task-view';
import { styles } from '../style';
import { ArtifactsPanel } from './ArtifactsPanel';
import { EventsPanel } from './EventsPanel';
import { OwnerInspector } from './OwnerInspector';
import { ReviewPanel } from './ReviewPanel';

const queueLabels = { waiting_for_capacity: '等待执行槽位', policy_blocked: '当前策略阻止派发', frozen_route_changed: '已冻结路由发生变化', workspace_changed: '工作目录发生变化', launch_blocked: '执行启动受阻' };

export function TaskDetail({ task, busy, onStart, onCancel, action, onRetry }: { task?: Task; busy: boolean; onStart: (id: string) => void; onCancel: (id: string) => void; action: (fn: () => Promise<unknown>) => Promise<boolean>; onRetry?: (id: string) => void }) {
  const [tab, setTab] = useState('events');
  if (!task) return <Empty title="选择一项任务" description="创建或导入后，执行、交接和验收都留在同一条记录里。" />;
  const latest = task.events.at(-1);
  const failure = [...task.events].reverse().find(event => event.kind === 'error');
  return <section aria-label="任务详情" className={styles.stack}>
    <div className={styles.spread}>
      <div className={styles.stack}>
        <Text className={styles.wrap} style={{ fontSize: 18, fontWeight: 600 }}>{task.title}</Text>
        <div className={styles.row}><Tag>{statusLabels[task.status]}</Tag><Tag>{reviewLabel(task)}</Tag><Text type="secondary">更新于 {new Date(task.updatedAt).toLocaleTimeString()}</Text></div>
      </div>
      <div className={styles.row}>
        {task.status === 'queued' && !task.scheduled && <Button type="primary" disabled={busy} onClick={() => onStart(task.id)}>开始执行</Button>}
        {isActive(task) && <Button disabled={busy || task.status === 'cancelling'} onClick={() => onCancel(task.id)}>{task.status === 'cancelling' ? '正在停止…' : '取消任务'}</Button>}
        {!isActive(task) && onRetry && <Button disabled={busy} onClick={() => onRetry(task.id)}>新建重试任务</Button>}
      </div>
    </div>
    <div className={styles.detail}>
      <div className={styles.stack}>
        <Text type="secondary">已创建 · {task.run ? '有执行记录' : '未执行'}{task.scheduled ? ' · 已排队' : ''} · {task.status === 'completed' ? '执行完成' : '执行未完成'} · {task.acknowledged ? '已确认收到结果' : '未确认收到结果'} · {task.reviewState === 'accepted' ? '已验收' : '未验收'}</Text>
        <div className={styles.spread}><Text>执行进度</Text><Text>{task.progress}%</Text></div>
        <Progress aria-label="执行进度" percent={task.progress} showInfo={false} />
        {(task.scheduled || task.status === 'failed' || task.status === 'cancelled') && <Text role="status">{task.scheduled ? `调度请求已排队。${task.queueReason ? `${queueLabels[task.queueReason.code]}：${redactLog(task.queueReason.message)}` : '等待调度检查。'}` : task.status === 'failed' ? `执行失败。${redactLog(failure?.message ?? latest?.message ?? '查看时间线。')}` : `执行已取消。${redactLog(failure?.message ?? latest?.message ?? '查看时间线。')}`}</Text>}
        {task.retryOf && <Text type="secondary" className={styles.wrap}>重试来源：{task.retryOf}</Text>}
        <div className={styles.stack}><Text style={{ fontWeight: 600 }}>目标与约束</Text><Text className={styles.wrap}>{task.instruction}</Text>
          {task.acceptanceCriteria?.length ? <ol>{task.acceptanceCriteria.map((criterion, index) => <li key={index} className={styles.wrap}>{criterion}</li>)}</ol> : <Text type="secondary">此旧任务未记录结构化验收标准。</Text>}
        </div>
        <Text type="secondary" className={styles.wrap}>{task.dispatch ? `策略：${task.dispatch.worker} · ${task.dispatch.engine} / ${task.dispatch.model} · ${task.dispatch.effort}。实际执行：${task.dispatch.execution}。` : '尚未记录调度结果。'}</Text>
        {task.summary && <div className={styles.stack}><Text style={{ fontWeight: 600 }}>执行结果</Text><Text className={styles.wrap}>{task.summary}</Text><Text type="secondary">执行完成与验收通过分别记录。</Text></div>}
        <Text type="secondary" className={styles.wrap}>最近活动{latest ? ` · ${new Date(latest.at).toLocaleTimeString()}` : ''} · {redactLog(latest?.message ?? '等待首次调度')}</Text>
        <div role="tablist" aria-label="任务记录" className={styles.row} onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          const keys = ['events', 'artifacts', 'review'];
          const next = nextTab(keys, tab, event.key);
          if (!next) return;
          event.preventDefault();
          setTab(next);
          document.getElementById(`task-tab-${next}`)?.focus();
        }}>
          {([['events', `时间线 ${task.events.length}`], ['artifacts', `产物 ${task.artifacts.length}`], ['review', '验收']] as const).map(([key, label]) => <button key={key} type="button" className={styles.tab} id={`task-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`task-panel-${key}`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)}>{label}</button>)}
        </div>
        <div role="tabpanel" id={`task-panel-${tab}`} aria-labelledby={`task-tab-${tab}`}>
          {tab === 'events' && <EventsPanel events={task.events} taskId={task.id} />}
          {tab === 'artifacts' && <ArtifactsPanel artifacts={task.artifacts} />}
          {tab === 'review' && (task.status === 'completed' ? <ReviewPanel task={task} busy={busy} action={action} /> : <Empty title="执行成功后进入验收" description="执行结果、收到确认和验收结论各自独立。" />)}
        </div>
      </div>
      <OwnerInspector task={task} busy={busy} action={action} />
    </div>
  </section>;
}
