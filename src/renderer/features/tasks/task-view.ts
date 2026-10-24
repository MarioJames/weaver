import type { OwnerInstance } from '../../../shared/contracts/owners';
import type { Config } from '../../../shared/contracts/policy';
import type { Task } from '../../../shared/contracts/tasks';
import { PENDING_TASK_TITLE } from '../../../shared/validation';
export type TaskFilter = 'all' | 'active' | 'review' | 'closed';
export function isActive(task: Task): boolean { return ['queued', 'running', 'cancelling'].includes(task.status); }
/** A draft is a root task nobody has started: still editable, with nothing frozen or dispatched yet. Mirrors the server's tasks.update rule. */
export function isDraft(task: Task): boolean {
  return !task.parentTaskId && task.status === 'queued' && task.executionRole !== 'owner' && !task.scheduled && !task.packageId && !task.dispatch && !task.ownerHost;
}
const TITLE_MAX = 60;
const MARKDOWN_PREFIX = /^(?:(?:#{1,6}|[-*+]|\d+[.)])(?:\s+|$)|>\s*)+/;
const DECORATION_ONLY = /^(?:[-*_=]{3,}|`{3,}.*)$/;
/** What a task is called on screen: the real title, or until the parent Agent names it the first line of the goal. */
export function taskTitle(task: Pick<Task, 'id' | 'title' | 'instruction'>): string {
  if (task.title !== PENDING_TASK_TITLE) return task.title;
  for (const raw of (task.instruction ?? '').split('\n')) {
    const line = raw.trim();
    if (DECORATION_ONLY.test(line)) continue;
    const text = line.replace(MARKDOWN_PREFIX, '').trim();
    if (!text) continue;
    const chars = Array.from(text);
    return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : text;
  }
  return `任务 ${task.id.slice(0, 8)}`;
}
/** The policy profile a task's owner instance runs under; '' when the instance is not among the known owners. */
export function ownerProfileOf(task: Pick<Task, 'ownerId'>, owners: Pick<OwnerInstance, 'id' | 'profileId'>[]): string {
  return (task.ownerId && owners.find(owner => owner.id === task.ownerId)?.profileId) || '';
}
export const UNASSIGNED_OWNER = '未指定父 Agent';
/** An owner root: the parent Agent task itself. It never sits in the board columns or the archive rows. */
export function isOwnerRoot(task: Task): boolean {
  return task.executionRole === 'owner' && !task.parentTaskId;
}

/** A page-created parent Agent before its first start: a queued draft bound to an owner instance, which becomes the root on start. It keeps its card until then. */
export function isRootDraft(task: Task): boolean {
  return !!task.ownerId && isDraft(task) && !logicalOwnerName(task);
}

/** A task that answers in the 父 Agent row by its own root id: started owner roots and the drafts that become them. */
export function isRootTask(task: Task): boolean {
  return !task.parentTaskId && (isOwnerRoot(task) || isRootDraft(task));
}

/** Placeholder assigned to per-task throwaway instances. */
const PLACEHOLDER_OWNER = 'Task owner';
type ProfiledTask = Task & { owner: Task['owner'] & { profileId?: string; title?: string } };
/** Enrich only the renderer's task copies; queued tasks have no frozen dispatch yet. */
export function withOwnerProfiles(tasks: Task[], owners: Pick<OwnerInstance, 'id' | 'name' | 'profileId' | 'title'>[]): Task[] {
  const instances = new Map(owners.map(owner => [owner.id, owner]));
  return tasks.map(task => {
    const instance = task.ownerId ? instances.get(task.ownerId) : undefined;
    return instance ? { ...task, owner: { ...task.owner, name: instance.name, profileId: instance.profileId, ...(instance.title ? { title: instance.title } : {}) } } : task;
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
    const channelId = owners[ownerId]?.channel;
    const engineId = channelId ? config?.channels[channelId]?.engine : undefined;
    return engineId ? engines[engineId]?.kind : undefined;
  };
}
/** Maps the saved policy to a lookup of worker id -> free channel; a missing config, a missing worker or no flag is simply not free. */
export function freeChannelLookup(config?: Config): (workerId?: string) => boolean {
  const workers = config?.workers;
  return (workerId?: string) => Boolean(workerId && workers?.[workerId]?.free_channel === true);
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

/** A manual parent Agent instance answers with its current main-task title when one was described, so cards and filters read the work, not the session clock. */
export function ownerInstanceTitle(task: Task): string | undefined {
  return namedOwnerInstance(task) ? (task as ProfiledTask).owner.title : undefined;
}
/** The parent Agent a board card names: an A-type child names its root task, others their owner instance or profile. */
export function cardOwner(task: Task, rootOf?: (id: string) => Task | undefined): { name: string; title: string } {
  const root = task.parentTaskId ? rootOf?.(task.parentTaskId) : undefined;
  if (root) {
    const name = taskTitle(root);
    return { name, title: root.title !== PENDING_TASK_TITLE ? root.title : name };
  }
  const full = ownerLabel(task);
  const described = ownerInstanceTitle(task);
  if (described) return { name: described, title: `${described} · ${full}` };
  return { name: ownerHostName(task), title: full };
}

/** Why a selected parent Agent has no sub agent tasks on the board yet, and what happens next. */
export function emptyRootNotice(root: Task): string {
  const title = taskTitle(root);
  if (root.status === 'failed') return `父 Agent「${title}」启动失败，没有创建子任务${root.failure?.message ? `：${root.failure.message}` : ''}`;
  if (root.status === 'cancelled') return `父 Agent「${title}」已取消，没有子任务。`;
  if (isActive(root)) return `父 Agent「${title}」正在拆分任务，子任务会自动出现在这里。`;
  return `父 Agent「${title}」还没有子任务。`;
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
/** Cancelling a running parent Agent root also stops its unfinished children and closes the Herdr pane; any other task cancels without a prompt. */
export function rootCancelNotice(task: Task, tasks: Task[]): { title: string; description: string; detail: string } | undefined {
 if (task.executionRole !== 'owner' || task.status !== 'running') return undefined;
 const open = tasks.filter(item => item.parentTaskId === task.id && isActive(item)).length;
 return { title: '取消根任务', description: `取消后将同时取消全部未结束的子任务（当前 ${open} 个），并关闭 Herdr 中的父 Agent。`, detail: '已完成的子任务和产物会保留。' };
}
export function reviewStatus(task: Task): string { return task.status === 'completed' ? (task.reviewState ?? 'pending') : 'not_ready'; }
export function reviewLabel(task: Task): string { const status = reviewStatus(task); return ({ pending: '待验收', approved: '已通过', accepted: '已通过', rejected: '需修改', changes_requested: '需修改', not_ready: '尚未进入验收' } as Record<string,string>)[status] ?? status; }
