import type { Task } from '../../shared/contracts/tasks';
import { isDraft } from '../features/tasks/task-view';

/**
 * One color scheme for every place that shows where a task is: board lanes, card and detail tags,
 * timeline outcomes and filter dots. Values are StatusTones; the Tag colors they resolve to live in
 * format/tag-colors.ts, so lanes map them to cssVar tokens and tags to one shared semantic scheme.
 */
export type StatusTone = 'default' | 'processing' | 'warning' | 'success' | 'error' | 'orange' | 'volcano';

/** The state a person reads at a glance, review outcome included once execution has finished. */
export type DisplayStatus = 'draft' | 'queued' | 'scheduled' | 'running' | 'cancelling' | 'review' | 'accepted' | 'rejected' | 'failed' | 'cancelled';

export const DISPLAY_STATUSES: readonly DisplayStatus[] = ['draft', 'queued', 'scheduled', 'running', 'cancelling', 'review', 'accepted', 'rejected', 'failed', 'cancelled'];

export const DISPLAY_LABELS: Record<DisplayStatus, string> = {
  draft: '草稿', queued: '待执行', scheduled: '排队中', running: '执行中', cancelling: '停止中',
  review: '待验收', accepted: '已通过', rejected: '需修改', failed: '失败', cancelled: '已取消',
};

export const DISPLAY_TONES: Record<DisplayStatus, StatusTone> = {
  draft: 'default', queued: 'default', scheduled: 'default', running: 'processing', cancelling: 'orange',
  review: 'warning', accepted: 'success', rejected: 'volcano', failed: 'error', cancelled: 'default',
};

export function displayStatus(task: Task): DisplayStatus {
  if (isDraft(task)) return 'draft';
  if (task.status === 'queued') return task.scheduled ? 'scheduled' : 'queued';
  if (task.status === 'completed') return task.reviewState === 'accepted' ? 'accepted' : task.reviewState === 'rejected' ? 'rejected' : 'review';
  return task.status;
}
