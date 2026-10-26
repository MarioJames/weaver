import type { Task } from '../../../shared/contracts/tasks';
import { isOwnerRoot } from './task-view';
import { REVIEW_WAIT_WARN_MINUTES, reviewWait } from './task-wait';

/** A pending review older than this needs a person; the wait itself is measured by task-wait.ts. */
export const REVIEW_WAIT_ATTENTION_MS = REVIEW_WAIT_WARN_MINUTES * 60 * 1000;

/** Only tasks updated inside this window can enter the attention set; older failures stay history. */
export const ATTENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function hasReplacement(task: Task, tasks: readonly Task[]): boolean {
  return tasks.some(item => item.id !== task.id && item.retryOf === task.id);
}

/**
 * The one attention set behind the navigation badge and the 需关注 views:
 * a failed attempt nobody retried or superseded, a rejected task nobody retried,
 * and a review that has waited longer than 30 minutes. Parent Agent roots are
 * infrastructure, not work items, and never count.
 */
export function needsAttention(task: Task, tasks: readonly Task[], now: number): boolean {
  if (isOwnerRoot(task)) return false;
  const updated = Date.parse(task.updatedAt);
  if (!Number.isFinite(updated) || now - updated > ATTENTION_WINDOW_MS) return false;
  if (task.status === 'failed') return !task.supersededBy && !hasReplacement(task, tasks);
  if (task.status !== 'completed') return false;
  if (task.reviewState === 'rejected') return !hasReplacement(task, tasks);
  return reviewWait(task, now)?.overdue === true;
}

export function attentionCount(tasks: readonly Task[], now: number): number {
  return tasks.reduce((count, task) => count + (needsAttention(task, tasks, now) ? 1 : 0), 0);
}

/**
 * The attention list behind the overview metric, the 「需关注 · N」 list and
 * the navigation badge: one判定 (`needsAttention`), newest first. Every
 * counter reads from this so the three can never drift apart.
 */
export function attentionTasks(tasks: readonly Task[], now: number): Task[] {
  return tasks.filter(task => needsAttention(task, tasks, now)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
