import type { Artifact, Task, TaskFailure } from '../../../shared/contracts/tasks';

/** Queue reason codes in the words the status banner uses. Shared by the inspector and its tests. */
export const queueLabels: Record<NonNullable<Task['queueReason']>['code'], string> = {
  waiting_for_capacity: '等待执行槽位',
  policy_blocked: '当前策略阻止派发',
  frozen_route_changed: '已冻结路由发生变化',
  workspace_changed: '工作目录发生变化',
  launch_blocked: '执行启动受阻',
};

/** The Chinese name of each failure kind, shown in the status banner. */
export const failureKindLabels: Record<TaskFailure['kind'], string> = {
  early_exit: '提前退出',
  no_output: '无输出',
  rate_limit: '供应商限流',
  quota: '额度耗尽',
  auth: '认证失败',
  vendor: '供应商错误',
  cancelled: '已取消',
  other: '其他错误',
  unknown_outcome: '结果未知',
};

/** One recovery hint per failure kind, shown next to the category in the status banner. */
export const failureKindAdvice: Record<TaskFailure['kind'], string> = {
  early_exit: '命令没有跑完就退出了，查看时间线确认中断位置后重试。',
  no_output: '子 Agent 没有留下输出就退出了，查看时间线后重试。',
  rate_limit: '供应商限流，稍后重试或切换到其他渠道。',
  quota: '渠道额度已用完，补充额度或切换渠道后重试。',
  auth: '账号登录已失效，重新登录后重试。',
  vendor: '供应商侧异常，稍后重试。',
  cancelled: '任务已被取消；如需继续可以新建重试任务。',
  other: '查看时间线定位原因后重试。',
  unknown_outcome: '执行结果无法确认，查看时间线后决定是否重试。',
};

/** Artifacts for the result tab: entries duplicating the trimmed execution summary are folded into it. */
export function inspectorArtifacts(task: Task): Artifact[] {
  const summary = task.summary?.trim();
  return summary ? task.artifacts.filter(artifact => artifact.content.trim() !== summary) : task.artifacts;
}
