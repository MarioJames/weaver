import type { Config } from '../shared/policy';
import type { Task, TaskStatus } from '../shared/types';
export type TaskFilter = 'all' | 'active' | 'review' | 'closed';
export const statusLabels: Record<TaskStatus, string> = { queued: '待执行', running: '执行中', cancelling: '停止中', completed: '执行完成', failed: '执行失败', cancelled: '已取消' };
export function isActive(task: Task): boolean { return ['queued', 'running', 'cancelling'].includes(task.status); }
export const UNASSIGNED_OWNER = '未指定负责人';
export const ALL_OWNERS = 'all';
/** localStorage key holding the board's owner selection. */
export const OWNER_FILTER_KEY = 'weaver-task-owner';
/** CLI-created tasks carry a placeholder owner name; the frozen dispatch holds the real profile. */
export function ownerLabel(task: Task): string {
  return task.dispatch?.owner ?? (task.owner.name !== 'Task owner' ? task.owner.name : UNASSIGNED_OWNER);
}
/** The policy key of the owning profile: the frozen dispatch stores it, logical tasks carry it directly. */
export function taskOwnerId(task: Task): string | undefined {
  return task.ownerId ?? task.dispatch?.owner;
}
/** Engine kind of the frozen worker dispatch: explicit kind first, otherwise the engine id. */
export function dispatchKind(task: Task): string | undefined {
  return task.dispatch ? (task.dispatch.engineKind ?? task.dispatch.engine) : undefined;
}
/** Maps the saved policy to a lookup of owner profile -> engine kind; undefined until the policy is known. */
export function ownerKindLookup(config?: Config): (ownerId?: string) => string | undefined {
  const owners = config?.owners;
  const engines = config?.engines;
  return (ownerId?: string) => {
    if (!ownerId || !owners || !engines) return undefined;
    const engineId = owners[ownerId]?.engine;
    return engineId ? engines[engineId]?.kind : undefined;
  };
}
/** A persisted owner selection that no longer matches any facet means all owners, never an empty board. */
export function resolveOwnerFilter(owner: string, tasks: Task[]): string {
  return owner === ALL_OWNERS || ownerFacets(tasks).some(facet => facet.value === owner) ? owner : ALL_OWNERS;
}
/** Directory name of the project the task runs in; '' when no workspace was recorded. */
export function projectLabel(task: Task): string {
  const path = (task.dispatch?.workspace || task.workspace || '').replace(/\/+$/, '');
  if (!path) return '';
  return path.slice(path.lastIndexOf('/') + 1);
}
export function filterTasks(tasks: Task[], filter: TaskFilter, query: string): Task[] {
 const needle = query.trim().toLocaleLowerCase();
 return tasks.filter(task => (!needle || `${task.title} ${task.owner.name} ${ownerLabel(task)} ${projectLabel(task)} ${task.id}`.toLocaleLowerCase().includes(needle)) && (filter === 'all' || (filter === 'active' && isActive(task)) || (filter === 'review' && task.status === 'completed' && reviewStatus(task) === 'pending') || (filter === 'closed' && !isActive(task))));
}
export interface OwnerFacet { value: string; label: string; count: number }
export function ownerFacets(tasks: Task[]): OwnerFacet[] {
 const counts = new Map<string, number>();
 for (const task of tasks) counts.set(ownerLabel(task), (counts.get(ownerLabel(task)) ?? 0) + 1);
 const owners = [...counts].map(([label, count]) => ({ value: label, label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
 return [{ value: ALL_OWNERS, label: '全部', count: tasks.length }, ...owners];
}
export function filterByOwner(tasks: Task[], owner: string): Task[] {
 return !owner || owner === ALL_OWNERS ? tasks : tasks.filter(task => ownerLabel(task) === owner);
}
export interface OwnerLane { owner: string; tasks: Task[]; counts: number[]; total: number }
/** One lane per owner, busiest first: active tasks lead, then total, then the name for stability. */
export function ownerLanes(tasks: Task[]): OwnerLane[] {
 const grouped = new Map<string, Task[]>();
 for (const task of tasks) {
   const owner = ownerLabel(task);
   const bucket = grouped.get(owner);
   if (bucket) bucket.push(task);
   else grouped.set(owner, [task]);
 }
 const counts = (laneTasks: Task[]): number[] => {
   const tally = [0, 0, 0, 0];
   for (const task of laneTasks) tally[TASK_COLUMNS.findIndex(column => column.key === taskColumn(task))] += 1;
   return tally;
 };
 return [...grouped].map(([owner, laneTasks]) => ({ owner, tasks: laneTasks, counts: counts(laneTasks), total: laneTasks.length }))
   .sort((a, b) => b.counts[0] + b.counts[1] - (a.counts[0] + a.counts[1]) || b.total - a.total || a.owner.localeCompare(b.owner));
}
/** localStorage key recording which owner lanes the user folded on the board. */
export const COLLAPSED_LANES_KEY = 'weaver-task-owner-collapsed';
/** Folded-owner map from localStorage; a broken or stale payload means every lane is open. */
export function readCollapsedLanes(): Record<string, boolean> {
 try {
   const raw = localStorage.getItem(COLLAPSED_LANES_KEY);
   if (!raw) return {};
   const parsed: unknown = JSON.parse(raw);
   return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, boolean> : {};
 } catch { return {}; }
}
export type TaskColumn = 'queued' | 'running' | 'review' | 'closed';
export const TASK_COLUMNS: readonly { key: TaskColumn; label: string }[] = [{ key: 'queued', label: '待执行' }, { key: 'running', label: '执行中' }, { key: 'review', label: '待验收' }, { key: 'closed', label: '已结束' }];
/** Kanban column: where the task is in its lifecycle. Completed work waits for review before it is closed. */
export function taskColumn(task: Task): TaskColumn {
 if (task.status === 'queued') return 'queued';
 if (task.status === 'running' || task.status === 'cancelling') return 'running';
 if (task.status === 'completed' && reviewStatus(task) === 'pending') return 'review';
 return 'closed';
}
export function reviewStatus(task: Task): string { return task.status === 'completed' ? (task.reviewState ?? 'pending') : 'not_ready'; }
export function reviewLabel(task: Task): string { const status = reviewStatus(task); return ({ pending: '待验收', approved: '已通过', accepted: '已通过', rejected: '需修改', changes_requested: '需修改', not_ready: '尚未进入验收' } as Record<string,string>)[status] ?? status; }

export function nextTab(keys: readonly string[], current: string, key: string): string | undefined {
  const index = keys.indexOf(current);
  if (index < 0) return undefined;
  if (key === 'ArrowRight') return keys[(index + 1) % keys.length];
  if (key === 'ArrowLeft') return keys[(index - 1 + keys.length) % keys.length];
  if (key === 'Home') return keys[0];
  if (key === 'End') return keys[keys.length - 1];
  return undefined;
}
