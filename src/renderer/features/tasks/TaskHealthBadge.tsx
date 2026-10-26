import { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Tag, Text } from '@lobehub/ui';
import type { TaskHealth, TaskHealthState } from '../../../shared/contracts/monitoring';
import { command } from '../../api/commands';
import type { TagSemantic } from '../../format/tag-colors';
import { tagColor } from '../../format/tag-colors';
import { styles } from '../../ui/styles';

export const HEALTH_LABELS: Record<TaskHealthState, string> = {
  ended: '已结束',
  starting: '启动中',
  working: '工作中',
  waiting_model: '等待模型',
  running_command: '命令运行中',
  stalled: '已卡住',
  owner_starting: '父 Agent 启动中',
  owner_running: '父 Agent 运行中',
};

const HEALTH_TONES: Record<TaskHealthState, TagSemantic> = {
  ended: 'neutral',
  starting: 'inProgress',
  working: 'inProgress',
  waiting_model: 'warning',
  running_command: 'inProgress',
  stalled: 'error',
  owner_starting: 'inProgress',
  owner_running: 'inProgress',
};

/** A command's age uses the same coarse wording as the rest of the board. */
export function commandElapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** The monitor's reading, rendered without a second interpretation of silence or CPU. */
export function TaskHealthView({ health }: { health: TaskHealth }) {
  const command = health.runningCommand;
  return <div {...stylex.props(styles.row)} aria-label="任务健康">
    <Tag color={tagColor(HEALTH_TONES[health.state])}>{HEALTH_LABELS[health.state]}</Tag>
    {command && <Text type="secondary" fontSize={12} className={stylex.props(styles.wrap).className}>
      命令：{command.summary} · 已运行 {commandElapsedText(command.elapsedMs)}
    </Text>}
    {health.reason === 'command_timeout' && <Text type="warning" fontSize={12}>超过单条命令最长运行时间，请父 Agent 判断是否取消或重试；Weaver 不会自动停止命令。</Text>}
  </div>;
}

/** Poll one task's health only while it runs; a closed detail stops immediately. */
export function TaskHealthBadge({ taskId, active }: { taskId: string; active: boolean }) {
  const [health, setHealth] = useState<TaskHealth>();
  useEffect(() => {
    setHealth(undefined);
    if (!active) return;
    let current = true;
    const load = () => { void command<TaskHealth>('tasks.health', { taskId }).then(value => { if (current) setHealth(value); }).catch(() => { /* health is evidence, not a page failure */ }); };
    load();
    const timer = setInterval(load, 5_000);
    return () => { current = false; clearInterval(timer); };
  }, [taskId, active]);
  return health ? <TaskHealthView health={health} /> : null;
}
