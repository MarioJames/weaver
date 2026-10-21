import type { Task } from '../../../shared/contracts/tasks';
import { completedAt } from './task-footer';
import { taskColumn } from './task-columns';

/** A review that has waited longer than this many minutes is shown as overdue (warning color and a hint). */
export const REVIEW_WAIT_WARN_MINUTES = 30;
/** The lifecycle event the results.ack command records; its time is when the parent Agent confirmed receipt. */
export const RECEIPT_ACK_MESSAGE = 'Result receipt acknowledged; acceptance unchanged';
/** Shown on hover once the wait is overdue. */
export const REVIEW_OVERDUE_HINT = '父 Agent 尚未提交验收，请检查其运行状态';

export interface ReviewWait {
  acknowledged: boolean;
  /** The line shown under the status tag. */
  text: string;
  /** Whole minutes waited, counted from completion (not acknowledged) or from the acknowledgement. */
  minutes: number;
  overdue: boolean;
  /** Hover text; only present once overdue. */
  title?: string;
}

/** < 60 minutes: 「N 分钟」; otherwise 「X 小时 Y 分钟」. */
export function formatWait(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  return whole < 60 ? `${whole} 分钟` : `${Math.floor(whole / 60)} 小时 ${whole % 60} 分钟`;
}

const validTime = (value?: string): value is string => !!value && Number.isFinite(Date.parse(value));

/** When the parent Agent confirmed receipt: the latest ack event, else the last update. */
export function acknowledgedAt(task: Task): string {
  for (let index = task.events.length - 1; index >= 0; index--) {
    const event = task.events[index]!;
    if (event.message === RECEIPT_ACK_MESSAGE && validTime(event.at)) return event.at;
  }
  return task.updatedAt;
}

/** What a 待验收 card says about how long it has waited and on what; null for every other card. */
export function reviewWait(task: Task, now: number): ReviewWait | null {
  if (taskColumn(task) !== 'review') return null;
  const acknowledged = !!task.acknowledged;
  const since = Date.parse(acknowledged ? acknowledgedAt(task) : completedAt(task));
  const minutes = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 60000)) : 0;
  const overdue = minutes > REVIEW_WAIT_WARN_MINUTES;
  const label = acknowledged ? '已确认收到 · 待验收结论' : '待父 Agent 确认收到';
  return { acknowledged, text: `${label} · 已等 ${formatWait(minutes)}`, minutes, overdue, ...(overdue ? { title: REVIEW_OVERDUE_HINT } : {}) };
}
