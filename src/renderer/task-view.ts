import type { Task, TaskStatus } from '../shared/types';
export type TaskFilter = 'all' | 'active' | 'review' | 'closed';
export const statusLabels: Record<TaskStatus, string> = { queued: '待执行', running: '执行中', cancelling: '停止中', completed: '执行完成', failed: '执行失败', cancelled: '已取消' };
export function isActive(task: Task): boolean { return ['queued', 'running', 'cancelling'].includes(task.status); }
export function filterTasks(tasks: Task[], filter: TaskFilter, query: string): Task[] {
 const needle = query.trim().toLocaleLowerCase();
 return tasks.filter(task => (!needle || `${task.title} ${task.owner.name} ${task.id}`.toLocaleLowerCase().includes(needle)) && (filter === 'all' || (filter === 'active' && isActive(task)) || (filter === 'review' && task.status === 'completed' && reviewStatus(task) === 'pending') || (filter === 'closed' && !isActive(task))));
}
export function reviewStatus(task: Task): string { return task.status === 'completed' ? (task.reviewState ?? 'pending') : 'not_ready'; }
export function reviewLabel(task: Task): string { const status = reviewStatus(task); return ({ pending: '待验收', approved: '已通过', accepted: '已通过', rejected: '需修改', changes_requested: '需修改', not_ready: '尚未进入验收' } as Record<string,string>)[status] ?? status; }
