import type { Config } from '../shared/policy';
import type { Task, TaskStatus } from '../shared/types';
export type TaskFilter = 'all' | 'active' | 'review' | 'closed';
export const statusLabels: Record<TaskStatus, string> = { queued: '待执行', running: '执行中', cancelling: '停止中', completed: '执行完成', failed: '执行失败', cancelled: '已取消' };
export function isActive(task: Task): boolean { return ['queued', 'running', 'cancelling'].includes(task.status); }
export const UNASSIGNED_OWNER = '未指定负责人';
export const ALL_OWNERS = 'all';
/** The name a task carries when no owner was named. */
const PLACEHOLDER_OWNER = 'Task owner';
/** CLI-created tasks carry a placeholder owner name; the frozen dispatch holds the real profile. */
export function ownerLabel(task: Task): string {
  return task.dispatch?.owner ?? (task.owner.name !== PLACEHOLDER_OWNER ? task.owner.name : UNASSIGNED_OWNER);
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
export function filterTasks(tasks: Task[], filter: TaskFilter, query: string): Task[] {
 const needle = query.trim().toLocaleLowerCase();
 return tasks.filter(task => (!needle || `${task.title} ${task.owner.name} ${ownerLabel(task)} ${projectLabel(task)} ${task.id}`.toLocaleLowerCase().includes(needle)) && (filter === 'all' || (filter === 'active' && isActive(task)) || (filter === 'review' && task.status === 'completed' && reviewStatus(task) === 'pending') || (filter === 'closed' && !isActive(task))));
}
export function filterByOwner(tasks: Task[], owner: string): Task[] {
  return !owner || owner === ALL_OWNERS ? tasks : tasks.filter(task => ownerLabel(task) === owner);
}
/** The board narrows work along these three dimensions, in toolbar order. */
export type FilterDimension = 'owner' | 'engine' | 'worker';
export const FILTER_DIMENSIONS: readonly FilterDimension[] = ['owner', 'engine', 'worker'];
export const filterLabels: Record<FilterDimension, string> = { owner: '负责人', engine: '引擎', worker: '工作代理' };
/** The chosen values per dimension. */
export type TaskSelection = Record<FilterDimension, string[]>;
export function emptySelection(): TaskSelection { return { owner: [], engine: [], worker: [] }; }
/** localStorage key holding the board's filter selection. */
export const TASK_FILTERS_KEY = 'weaver-task-filters';
/** One dropdown entry: what it is called, how much live work hides behind it, and the brand to draw. */
export interface FilterOption { value: string; label: string; kind?: string; open: number }
/** The value a task answers for in one dimension; undefined when the task has no value to group by. */
export function taskOption(task: Task, dimension: FilterDimension): { value: string; label: string } | undefined {
  if (dimension === 'owner') {
    // Group by the policy key when the task carries one, so one owner under two names stays one choice.
    const value = taskOwnerId(task) ?? ownerLabel(task);
    return { value, label: logicalOwnerName(task) ?? ownerLabel(task) };
  }
  const kind = dispatchKind(task);
  if (dimension === 'engine') return kind ? { value: kind, label: kind } : undefined;
  const worker = task.dispatch?.worker;
  return worker ? { value: worker, label: worker } : undefined;
}
/**
 * Same dimension ORs its choices, dimensions AND each other.
 * `skip` leaves one dimension unfiltered, which is how a dropdown counts what adding a choice would show.
 */
export function applyTaskFilters(tasks: Task[], selection: TaskSelection, skip?: FilterDimension): Task[] {
  return tasks.filter(task => FILTER_DIMENSIONS.every(dimension => {
    if (dimension === skip) return true;
    const chosen = selection[dimension];
    if (!chosen.length) return true;
    const option = taskOption(task, dimension);
    return option !== undefined && chosen.includes(option.value);
  }));
}
/** Every value the board holds for one dimension, busiest first. Archived work is not on the board, so it never counts. */
export function filterOptions(tasks: Task[], dimension: FilterDimension, selection: TaskSelection, now: number = Date.now()): FilterOption[] {
  const board = nonArchived(tasks, now);
  const narrowed = new Set(applyTaskFilters(board, selection, dimension).map(task => task.id));
  const seen = new Map<string, FilterOption>();
  for (const task of board) {
    const option = taskOption(task, dimension);
    if (!option) continue;
    const live = narrowed.has(task.id) && isOpenTask(task);
    const known = seen.get(option.value);
    if (known) {
      if (live) known.open += 1;
      continue;
    }
    seen.set(option.value, { value: option.value, label: option.label, kind: dimension === 'owner' ? undefined : dispatchKind(task), open: live ? 1 : 0 });
  }
  return [...seen.values()].sort((a, b) => b.open - a.open || a.label.localeCompare(b.label));
}
/** Is anything narrowed at all? Only then does 清除 have a job. */
export function hasFilters(selection: TaskSelection): boolean {
  return FILTER_DIMENSIONS.some(dimension => selection[dimension].length > 0);
}
/** The checklist toggles: choosing a value that is already chosen drops it. */
export function toggleOption(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}
/** What a filter button says: the dimension, one choice by name, or how many choices are on. */
export function filterButtonLabel(dimension: FilterDimension, options: FilterOption[], chosen: string[]): string {
  const label = filterLabels[dimension];
  if (chosen.length === 1) return `${label}：${options.find(option => option.value === chosen[0])?.label ?? chosen[0]}`;
  if (chosen.length > 1) return `${label}：${chosen.length} 个`;
  return label;
}
/** A stored payload decodes to a selection; anything malformed or of the wrong shape is no selection at all. */
function parseSelection(raw: string | null): TaskSelection {
  if (!raw) return emptySelection();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptySelection();
    const stored = parsed as Record<string, unknown>;
    return FILTER_DIMENSIONS.reduce((selection, dimension) => {
      const values = stored[dimension];
      selection[dimension] = Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];
      return selection;
    }, emptySelection());
  } catch { return emptySelection(); }
}
/** The saved selection; unreadable storage is the same as none. */
export function readTaskFilters(): TaskSelection {
  try { return parseSelection(localStorage.getItem(TASK_FILTERS_KEY)); } catch { return emptySelection(); }
}
/** Persist the selection; a private-mode or full storage only loses the memory. */
export function writeTaskFilters(selection: TaskSelection): void {
  try { localStorage.setItem(TASK_FILTERS_KEY, JSON.stringify(selection)); } catch { /* The choice stays for this session only. */ }
}
/** Choices that no longer name anything on the board are dropped, so a stale payload never empties it. */
export function resolveSelection(selection: TaskSelection, tasks: Task[], now: number = Date.now()): TaskSelection {
  return FILTER_DIMENSIONS.reduce((next, dimension) => {
    const known = new Set(filterOptions(tasks, dimension, emptySelection(), now).map(option => option.value));
    next[dimension] = selection[dimension].filter(value => known.has(value));
    return next;
  }, emptySelection());
}
/** localStorage key recording whether the board's 已结束 column is open. */
export const ENDED_EXPANDED_KEY = 'weaver-task-ended-expanded';
/** 已结束 stays folded unless the user left it open; anything else stored there is not an open column. */
export function readEndedExpanded(): boolean {
  try { return localStorage.getItem(ENDED_EXPANDED_KEY) === 'true'; } catch { return false; }
}
export function writeEndedExpanded(open: boolean): void {
  try { localStorage.setItem(ENDED_EXPANDED_KEY, String(open)); } catch { /* The choice stays for this session only. */ }
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
/** The columns that still hold live work; 已结束 is the one that ages out of the board. */
const OPEN_COLUMNS: readonly TaskColumn[] = ['queued', 'running', 'review'];
export function isOpenTask(task: Task): boolean { return OPEN_COLUMNS.includes(taskColumn(task)); }
/** One board: the tasks split into TASK_COLUMNS order, newest first in each column. */
export function columnize(tasks: Task[]): Task[][] {
  const columns = TASK_COLUMNS.map(() => [] as Task[]);
  for (const task of tasks) columns[TASK_COLUMNS.findIndex(column => column.key === taskColumn(task))].push(task);
  for (const column of columns) column.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return columns;
}
/** How long finished work stays on the board before it moves to the archive. */
export const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Derived view only: closed work that has sat for a day leaves the board for the archive drawer. */
export function isArchived(task: Task, now: number = Date.now()): boolean {
 return taskColumn(task) === 'closed' && now - Date.parse(task.updatedAt) > ARCHIVE_AFTER_MS;
}
export function nonArchived(tasks: Task[], now: number = Date.now()): Task[] {
 return tasks.filter(task => !isArchived(task, now));
}
/** Everything the board has moved on from, newest first: the archive drawer's rows. */
export function archivedTasks(tasks: Task[], now: number = Date.now()): Task[] {
 return tasks.filter(task => isArchived(task, now)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
/** Archive rows narrowed by the drawer's search box and owner select. */
export function archiveRows(tasks: Task[], query: string, owner: string, now: number = Date.now()): Task[] {
 return filterByOwner(filterTasks(archivedTasks(tasks, now), 'all', query), owner);
}
/** How archived work ended; the board no longer says, because it no longer shows it. */
export function archiveOutcome(task: Task): { label: string; color?: string } {
 if (task.status === 'failed') return { label: '失败', color: 'error' };
 if (task.status === 'cancelled') return { label: '已取消' };
 const status = reviewStatus(task);
 if (status === 'rejected') return { label: '需修改', color: 'warning' };
 if (status === 'pending') return { label: '待验收', color: 'warning' };
 return { label: '已通过', color: 'success' };
}
export function reviewStatus(task: Task): string { return task.status === 'completed' ? (task.reviewState ?? 'pending') : 'not_ready'; }
export function reviewLabel(task: Task): string { const status = reviewStatus(task); return ({ pending: '待验收', approved: '已通过', accepted: '已通过', rejected: '需修改', changes_requested: '需修改', not_ready: '尚未进入验收' } as Record<string,string>)[status] ?? status; }
