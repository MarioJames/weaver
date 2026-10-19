import { useState, type KeyboardEvent } from 'react';
import { Empty, Icon } from '@lobehub/ui';
import { Alert, Button, Tag, Text } from '@lobehub/ui/base-ui';
import { Loader2 } from 'lucide-react';
import type { Task } from '../../shared/types';
import { redactLog } from '../log-view';
import { isActive, nextTab, dispatchKind, ownerLabel, projectLabel, reviewLabel, statusLabels, taskOwnerId } from '../task-view';
import { styles } from '../style';
import { AgentLabel } from './EngineIcon';
import { ArtifactsPanel } from './ArtifactsPanel';
import { EventsPanel } from './EventsPanel';
import { OwnerInspector } from './OwnerInspector';
import { ReviewPanel } from './ReviewPanel';

const queueLabels = { waiting_for_capacity: '等待执行槽位', policy_blocked: '当前策略阻止派发', frozen_route_changed: '已冻结路由发生变化', workspace_changed: '工作目录发生变化', launch_blocked: '执行启动受阻' };
const TABS = [['events', '时间线'], ['artifacts', '产物'], ['review', '验收'], ['continuation', '接续']] as const;
const TAB_KEYS = TABS.map(([key]) => key);
const CLAMP_LINES = 4;
/** Only worth a toggle once the text is long enough for the clamp to actually cut it off. */
function clamps(instruction: string): boolean { return instruction.length > 240 || instruction.split('\n').length > CLAMP_LINES; }

export function TaskDetail({ task, busy, onStart, onCancel, action, onRetry, ownerKind }: { task?: Task; busy: boolean; onStart: (id: string) => void; onCancel: (id: string) => void; action: (fn: () => Promise<unknown>) => Promise<boolean>; onRetry?: (id: string) => void; ownerKind?: (ownerId?: string) => string | undefined }) {
  const [tab, setTab] = useState('events');
  const [expanded, setExpanded] = useState(false);
  if (!task) return <Empty title="选择一项任务" description="创建或导入后，执行、交接和验收都留在同一条记录里。" />;
  const latest = task.events.at(-1);
  const failure = [...task.events].reverse().find(event => event.kind === 'error');
  const dispatch = task.dispatch;
  const project = projectLabel(task);
  const rest = [dispatch && `${dispatch.engine} / ${dispatch.model}`, dispatch?.effort, project, `更新于 ${new Date(task.updatedAt).toLocaleString()}`].filter(Boolean).join(' · ');
  const ownerIconKind = ownerKind?.(taskOwnerId(task));
  const meta = <>
    {ownerIconKind || dispatch ? <AgentLabel kind={ownerIconKind} name={ownerLabel(task)} /> : ownerLabel(task)}
    {dispatch ? <> → <AgentLabel kind={dispatchKind(task)} name={dispatch.worker} /></> : ''}
    {rest ? ` · ${rest}` : ''}
  </>;
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
    <Text type="secondary" className={styles.wrap}>{meta}</Text>
    {queueNotice ? <Alert type="info" title="调度请求已排队" description={task.queueReason ? `${queueLabels[task.queueReason.code]}：${redactLog(task.queueReason.message)}` : '等待调度检查。'} />
      : task.status === 'failed' ? <Alert type="error" title="执行失败" description={redactLog(failure?.message ?? latest?.message ?? '查看时间线。')} />
        : task.status === 'cancelled' ? <Alert type="secondary" title="执行已取消" description={redactLog(failure?.message ?? latest?.message ?? '查看时间线。')} /> : undefined}
    {task.retryOf && <Text type="secondary" className={styles.wrap}>重试来源：{task.retryOf}</Text>}
    <div className={styles.stack}>
      <Text style={{ fontWeight: 600 }}>目标与约束</Text>
      <Text className={styles.wrap} lineClamp={expanded ? undefined : CLAMP_LINES}>{task.instruction}</Text>
      {clamps(task.instruction) && <Button size="small" type="text" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开'}</Button>}
      {task.acceptanceCriteria?.length ? <ol style={{ marginBlock: 0, paddingInlineStart: 20 }}>{task.acceptanceCriteria.map((criterion, index) => <li key={index} className={styles.wrap}>{criterion}</li>)}</ol> : <Text type="secondary">此旧任务未记录结构化验收标准。</Text>}
    </div>
    {task.summary && <div className={styles.stack}><Text style={{ fontWeight: 600 }}>执行结果</Text><Text className={styles.wrap}>{task.summary}</Text></div>}
    <div role="tablist" aria-label="任务记录" className={styles.row} onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
      const next = nextTab(TAB_KEYS, tab, event.key);
      if (!next) return;
      event.preventDefault();
      setTab(next);
      document.getElementById(`task-tab-${next}`)?.focus();
    }}>
      {TABS.map(([key, label]) => {
        const count = key === 'events' ? task.events.length : key === 'artifacts' ? task.artifacts.length : undefined;
        return <button key={key} type="button" className={styles.tab} id={`task-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`task-panel-${key}`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)}>{count === undefined ? label : `${label} ${count}`}</button>;
      })}
    </div>
    <div role="tabpanel" id={`task-panel-${tab}`} aria-labelledby={`task-tab-${tab}`}>
      {tab === 'events' && <EventsPanel events={task.events} taskId={task.id} />}
      {tab === 'artifacts' && <ArtifactsPanel artifacts={task.artifacts} />}
      {tab === 'review' && (task.status === 'completed' ? <ReviewPanel task={task} busy={busy} action={action} /> : <Empty title="执行成功后进入验收" description="执行结果、收到确认和验收结论各自独立。" />)}
      {tab === 'continuation' && <OwnerInspector task={task} busy={busy} action={action} />}
    </div>
  </section>;
}
