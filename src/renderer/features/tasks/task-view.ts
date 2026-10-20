import type { OwnerInstance } from '../../../shared/contracts/owners';
import type { Config } from '../../../shared/contracts/policy';
import type { Task } from '../../../shared/contracts/tasks';
export type TaskFilter = 'all' | 'active' | 'review' | 'closed';
export function isActive(task: Task): boolean { return ['queued', 'running', 'cancelling'].includes(task.status); }
export const UNASSIGNED_OWNER = '未指定父 Agent';
/** Placeholder assigned to per-task throwaway instances. */
const PLACEHOLDER_OWNER = 'Task owner';
type ProfiledTask = Task & { owner: Task['owner'] & { profileId?: string } };
/** Enrich only the renderer's task copies; queued tasks have no frozen dispatch yet. */
export function withOwnerProfiles(tasks: Task[], owners: Pick<OwnerInstance, 'id' | 'name' | 'profileId'>[]): Task[] {
  const instances = new Map(owners.map(owner => [owner.id, owner]));
  return tasks.map(task => {
    const instance = task.ownerId ? instances.get(task.ownerId) : undefined;
    return instance ? { ...task, owner: { ...task.owner, name: instance.name, profileId: instance.profileId } } : task;
  });
}
/** Named registrations carry a display name distinct from their policy profile. */
function namedOwnerInstance(task: Task): boolean {
  return !!task.ownerId && !!logicalOwnerName(task) && task.ownerId !== taskOwnerId(task);
}
export function ownerLabel(task: Task): string {
  if (namedOwnerInstance(task)) return task.owner.name;
  return task.dispatch?.owner ?? (task as ProfiledTask).owner.profileId ?? (task.owner.name !== PLACEHOLDER_OWNER ? task.owner.name : UNASSIGNED_OWNER);
}
/** Resolve the policy profile, never prefer an instance UUID over a frozen profile. */
export function taskOwnerId(task: Task): string | undefined {
  return task.dispatch?.owner ?? (task as ProfiledTask).owner.profileId ?? task.ownerId;
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
/** The logical owner name a task carries itself, as opposed to the one its dispatch recorded. */
export function logicalOwnerName(task: Task): string | undefined {
  const name = task.owner.name;
  return name && name !== PLACEHOLDER_OWNER ? name : undefined;
}
/** Directory name of the project the task runs in; '' when no workspace was recorded. */
export function projectLabel(task: Task): string {
  const path = (task.dispatch?.workspace || task.workspace || '').replace(/\/+$/, '');
  if (!path) return '';
  return path.slice(path.lastIndexOf('/') + 1);
}
/** The host part of an owner instance name ("<Host> · <workspace dir> · <session time>"). The directory is the lane's heading and the session time is a second, confusing clock, so a card shows the host alone. */
export function ownerHostName(task: Task): string {
  const full = ownerLabel(task);
  return full.split(' · ')[0]?.trim() || full;
}
export function filterTasks(tasks: Task[], filter: TaskFilter): Task[] {
  return tasks.filter(task => filter === 'all' || (filter === 'active' && isActive(task)) || (filter === 'review' && task.status === 'completed' && reviewStatus(task) === 'pending') || (filter === 'closed' && !isActive(task)));
}
/** The directories earlier tasks already work in, newest first: what a new task most likely wants to pick again. Only absolute paths count. */
export function recentWorkspaces(tasks: Task[], limit = 8): string[] {
  const seen = new Set<string>();
  for (const task of [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const path = (task.workspace ?? '').trim().replace(/(?<=.)\/+$/, '');
    if (path.startsWith('/') && !seen.has(path)) seen.add(path);
    if (seen.size >= limit) break;
  }
  return [...seen];
}
/** Progress of a root's final children; a child that was retried is superseded by its retry and counts once. */
export interface ChildSummary { total: number; completed: number; running: number }
export function childSummary(root: Task, tasks: Task[]): ChildSummary | undefined {
 if (root.executionRole !== 'owner') return undefined;
 const children = tasks.filter(task => task.parentTaskId === root.id);
 const leaves = children.filter(task => !children.some(retry => retry.retryOf === task.id));
 if (!leaves.length) return undefined;
 return { total: leaves.length, completed: leaves.filter(task => task.status === 'completed').length, running: leaves.filter(task => task.status === 'running' || task.status === 'cancelling').length };
}
/** e.g. 子任务 2/3 完成 · 1 运行中; 运行中 is left out at zero. */
export function childSummaryLabel(summary: ChildSummary): string {
 return `子任务 ${summary.completed}/${summary.total} 完成${summary.running ? ` · ${summary.running} 运行中` : ''}`;
}
/** Cancelling a running parent Agent root also stops its unfinished children and closes the Herdr pane; any other task cancels without a prompt. */
export function rootCancelNotice(task: Task, tasks: Task[]): { title: string; description: string; detail: string } | undefined {
 if (task.executionRole !== 'owner' || task.status !== 'running') return undefined;
 const open = tasks.filter(item => item.parentTaskId === task.id && isActive(item)).length;
 return { title: '取消根任务', description: `取消后将同时取消全部未结束的子任务（当前 ${open} 个），并关闭 Herdr 中的父 Agent。`, detail: '已完成的子任务和产物会保留。' };
}
export function reviewStatus(task: Task): string { return task.status === 'completed' ? (task.reviewState ?? 'pending') : 'not_ready'; }
export function reviewLabel(task: Task): string { const status = reviewStatus(task); return ({ pending: '待验收', approved: '已通过', accepted: '已通过', rejected: '需修改', changes_requested: '需修改', not_ready: '尚未进入验收' } as Record<string,string>)[status] ?? status; }
