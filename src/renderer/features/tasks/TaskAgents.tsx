import * as stylex from '@stylexjs/stylex';
import { Button, Descriptions, Tag, Text } from '@lobehub/ui';
import type { Task } from '../../../shared/contracts/tasks';
import type { Route } from '../../app/router';
import { EntityLink } from '../../ui/EntityLink';
import { DISPLAY_LABELS, DISPLAY_TONES, displayStatus } from '../../format/status-colors';
import { statusTagColor } from '../../format/tag-colors';
import { FreeChannelTag } from '../../ui/FreeChannelTag';
import { dispatchKind, isActive, taskOwnerId, taskTitle } from './task-view';
import { AgentLabel } from '../../ui/EngineIcon';
import { TimeText } from '../../ui/TimeText';
import { styles } from './task-agents-style';

/** Root host evidence and direct children come from the same live task snapshot. */
export function TaskAgents({ task, tasks, onSelect, taskRoute, ownerKind, freeChannel }: { task: Task; tasks: Task[]; onSelect?: (id: string) => void; taskRoute?: (id: string) => Route; ownerKind?: (id?: string) => string | undefined; freeChannel?: (workerId?: string) => boolean }) {
  const parent = tasks.find(item => item.id === task.parentTaskId);
  if (task.parentTaskId) return <section {...stylex.props(styles.section)} aria-label="所属任务">
    <Text type="secondary">父任务</Text>
    {taskRoute
      ? <EntityLink route={taskRoute(task.parentTaskId)} title={parent?.title ?? task.parentTaskId}>{parent ? taskTitle(parent) : task.parentTaskId}</EntityLink>
      : <Button type="text" outdent="start" disabled={!parent || !onSelect} onClick={() => onSelect?.(task.parentTaskId!)}>{parent ? taskTitle(parent) : task.parentTaskId}</Button>}
  </section>;
  if (task.executionRole !== 'owner') return null;
  const children = tasks.filter(item => item.parentTaskId === task.id);
  const host = task.ownerHost;
  return <section aria-label="父子 Agent" {...stylex.props(styles.section)}>
    <Text strong>父 Agent · {host ? isActive(task) ? '在 Herdr 中运行' : 'Herdr 启动记录' : task.status === 'running' ? '正在 Herdr 中启动' : task.status === 'failed' ? '未启动' : '已停止'}</Text>
    {host && <Descriptions colon={false} column={1} items={[
      { key: 'agent', label: 'Agent', children: <span {...stylex.props(styles.value)}><AgentLabel kind={ownerKind?.(taskOwnerId(task))} name={host.agentName} /></span> },
      { key: 'session', label: 'Herdr 会话', children: host.session },
      { key: 'workspace', label: '宿主工作区', children: host.workspaceId },
      { key: 'pane', label: '窗格', children: host.paneId },
      { key: 'time', label: '启动时间', children: <TimeText value={host.launchedAt} /> },
    ]} />}
    <Text strong>子任务 · {children.length}</Text>
    {children.length ? <ul {...stylex.props(styles.children)}>{children.map(child => {
      const status = displayStatus(child);
      return <li key={child.id} {...stylex.props(styles.child)}>
        {taskRoute
          ? <EntityLink route={taskRoute(child.id)} title={child.title}>{taskTitle(child)}</EntityLink>
          : <Button type="text" outdent="start" className={stylex.props(styles.link).className} disabled={!onSelect} onClick={() => onSelect?.(child.id)}>{taskTitle(child)}</Button>}
        <span {...stylex.props(styles.meta)}>
          <Tag size="small" color={statusTagColor(DISPLAY_TONES[status])}>{DISPLAY_LABELS[status]}</Tag>
          {child.dispatch?.worker ? <>
            <AgentLabel kind={dispatchKind(child)} name={child.dispatch.worker} />
            {freeChannel?.(child.dispatch.worker) && <FreeChannelTag title={`子 Agent ${child.dispatch.worker} 使用免费渠道`} />}
          </> : <Text type="secondary">{isActive(child) ? '等待派发子 Agent' : '未派发给子 Agent'}</Text>}
        </span>
      </li>;
    })}</ul> : <Text type="secondary">{task.status === 'running' ? '父 Agent 正在准备和拆分任务，子任务会自动显示在这里。' : '尚未创建子任务。'}</Text>}
  </section>;
}
