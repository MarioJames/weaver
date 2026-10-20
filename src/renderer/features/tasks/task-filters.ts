import type { Task } from '../../../shared/contracts/tasks';
import { DISPLAY_LABELS, DISPLAY_STATUSES, displayStatus } from '../../format/status-colors';
import type { DisplayStatus } from '../../format/status-colors';
import { projectTimeZone, startOfZonedDay } from '../../format/timezone';
import { archivedTasks, nonArchived } from './task-archive';
import { workspaceLabel } from './task-columns';
import { dispatchKind, logicalOwnerName, ownerLabel, taskOwnerId } from './task-view';
/** The facet rows below 时间, in display order. */
export type FilterDimension = 'status' | 'owner' | 'worker' | 'workspace';
export const FILTER_DIMENSIONS: readonly FilterDimension[] = ['status', 'owner', 'worker', 'workspace'];
export const filterLabels: Record<FilterDimension, string> = { status: '状态', owner: '父 Agent', worker: '子 Agent', workspace: '工作目录' };
export const TIME_RANGES = [
  { value: 'today', label: '今天' },
  { value: '1h', label: '近 1 小时' },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'all', label: '全部' },
] as const;
export type TaskTimeRange = typeof TIME_RANGES[number]['value'];
/** The chosen values per row, plus the single time scope. */
export type TaskSelection = Record<FilterDimension, string[]> & { time: TaskTimeRange };
export const timeLabel = (range: TaskTimeRange): string => TIME_RANGES.find(item => item.value === range)?.label ?? '';
/** Last activity since 00:00 of the project time zone's day (今天) or a rolling window (近 N 小时/天, independent of the zone); the caller supplies the clock. */
export function filterByTime(tasks: Task[], range: TaskTimeRange, now: number, zone: string = projectTimeZone()): Task[] {
  if (range === 'all') return tasks;
  const hours = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 };
  const since = range === 'today' ? startOfZonedDay(now, zone) : now - hours[range] * 3600000;
  return tasks.filter(task => {
    const updated = Date.parse(task.updatedAt);
    return updated >= since && updated <= now;
  });
}
export function emptySelection(): TaskSelection { return { status: [], owner: [], worker: [], workspace: [], time: 'today' }; }
/** One chip: what it is called, how many tasks in scope carry it, and the brand to draw. */
export interface FilterOption { value: string; label: string; kind?: string; count: number; ownerProfile?: string; /** Hover text when the chip shortens a longer name. */ title?: string }
/** A parent Agent chip reads "<host> · <session time>"; the workspace directory in the middle of the instance name is the lane's heading and stays in the hover. */
export function ownerChipLabel(full: string): string {
  const parts = full.split(' · ');
  return parts.length >= 3 ? `${parts[0]} · ${parts[parts.length - 1]}` : full;
}
/** The value a task answers for in one dimension; undefined when the task has no value to group by. */
export function taskOption(task: Task, dimension: FilterDimension): { value: string; label: string; title?: string } | undefined {
  if (dimension === 'owner') {
    const named = !!task.ownerId && !!logicalOwnerName(task);
    const value = named ? task.owner.name : taskOwnerId(task) ?? ownerLabel(task);
    const full = named ? task.owner.name : logicalOwnerName(task) ?? ownerLabel(task);
    const label = ownerChipLabel(full);
    return { value, label, ...(label !== full ? { title: full } : {}) };
  }
  if (dimension === 'status') {
    const status = displayStatus(task);
    return { value: status, label: DISPLAY_LABELS[status] };
  }
  if (dimension === 'workspace') {
    const workspace = task.workspace;
    return workspace ? { value: workspace, label: workspaceLabel(workspace) } : undefined;
  }
  const worker = task.dispatch?.worker;
  return worker ? { value: worker, label: worker } : undefined;
}
/** Children by parent id: a root answers for the sub agents its children dispatched to, as it has no dispatch of its own. */
export type ChildIndex = Map<string, Task[]>;
export function childIndex(tasks: Task[]): ChildIndex {
  const index: ChildIndex = new Map();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    const siblings = index.get(task.parentTaskId);
    if (siblings) siblings.push(task);
    else index.set(task.parentTaskId, [task]);
  }
  return index;
}
/** Every value a task answers for in one dimension. Only 子 Agent can be several: the task's own dispatch plus each child's, each once. */
export function taskOptions(task: Task, dimension: FilterDimension, children: ChildIndex = new Map()): (NonNullable<ReturnType<typeof taskOption>> & { kind?: string })[] {
  if (dimension !== 'worker') {
    const option = taskOption(task, dimension);
    return option ? [option] : [];
  }
  const seen = new Map<string, { value: string; label: string; kind?: string }>();
  for (const carrier of [task, ...(children.get(task.id) ?? [])]) {
    const worker = carrier.dispatch?.worker;
    if (worker && !seen.has(worker)) seen.set(worker, { value: worker, label: worker, kind: dispatchKind(carrier) });
  }
  return [...seen.values()];
}
/**
 * Same row ORs its choices, rows AND each other, and 时间 scopes all of them.
 * `skip` leaves one row unfiltered, which is how a facet counts what adding a choice would show.
 * `all` is every task, nested children included: a root is found by the sub agents its children ran on.
 */
export function applyTaskFilters(tasks: Task[], selection: TaskSelection, skip?: FilterDimension, now: number = Date.now(), all: Task[] = tasks): Task[] {
  const children = childIndex(all);
  return filterByTime(tasks, selection.time, now).filter(task => FILTER_DIMENSIONS.every(dimension => {
    if (dimension === skip) return true;
    const chosen = selection[dimension];
    if (!chosen.length) return true;
    return taskOptions(task, dimension, children).some(option => chosen.includes(option.value));
  }));
}
/**
 * The chips of one row over a pool of tasks. Only values with tasks in the chosen time range (and in the
 * other rows' selections) are offered, counted in that scope; a chosen value with none stays at count 0 so it can be unchecked.
 */
export function facetOptions(pool: Task[], dimension: FilterDimension, selection: TaskSelection, now: number = Date.now(), all: Task[] = pool): FilterOption[] {
  const children = childIndex(all);
  const scoped = new Set(applyTaskFilters(pool, selection, dimension, now, all).map(task => task.id));
  const seen = new Map<string, FilterOption>();
  for (const task of pool) {
    const counted = scoped.has(task.id);
    for (const option of taskOptions(task, dimension, children)) {
      const known = seen.get(option.value);
      if (known) {
        if (counted) known.count += 1;
        continue;
      }
      seen.set(option.value, { value: option.value, label: option.label, kind: dimension === 'worker' ? option.kind : undefined, ...(dimension === 'owner' ? { ownerProfile: taskOwnerId(task), ...(option.title ? { title: option.title } : {}) } : {}), count: counted ? 1 : 0 });
    }
  }
  const chosen = selection[dimension];
  for (const value of chosen) if (!seen.has(value)) seen.set(value, { value, label: dimension === 'status' ? DISPLAY_LABELS[value as DisplayStatus] ?? value : value, count: 0 });
  const options = [...seen.values()].filter(option => option.count > 0 || chosen.includes(option.value));
  if (dimension === 'owner') {
    // Two instances of one host with the same session time keep their directory so the chips stay distinguishable.
    const labels = new Map<string, number>();
    for (const option of options) labels.set(option.label, (labels.get(option.label) ?? 0) + 1);
    for (const option of options) if ((labels.get(option.label) ?? 0) > 1 && option.title) option.label = option.title;
  }
  if (dimension === 'status') return options.sort((a, b) => DISPLAY_STATUSES.indexOf(a.value as DisplayStatus) - DISPLAY_STATUSES.indexOf(b.value as DisplayStatus));
  return options.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
/** The board's chips: archived work is not on the board, so it never counts. */
export function filterOptions(tasks: Task[], dimension: FilterDimension, selection: TaskSelection, now: number = Date.now()): FilterOption[] {
  return facetOptions(nonArchived(tasks, now), dimension, selection, now, tasks);
}
/** Chosen values with their names, in row order; the 已选 tags and the collapsed summary read from this. */
export function selectedEntries(selection: TaskSelection, options: Record<FilterDimension, FilterOption[]>): { dimension: FilterDimension; value: string; label: string }[] {
  return FILTER_DIMENSIONS.flatMap(dimension => selection[dimension].map(value => ({ dimension, value, label: options[dimension].find(option => option.value === value)?.label ?? value })));
}
/** The collapsed block's one line, e.g. 筛选：今天 · 执行中 · claude_owner. */
export function filterSummary(selection: TaskSelection, options: Record<FilterDimension, FilterOption[]>): string {
  return `筛选：${[timeLabel(selection.time), ...selectedEntries(selection, options).map(entry => entry.label)].join(' · ')}`;
}
/** 清除 is available only when the selection differs from the default today view. */
export function hasFilters(selection: TaskSelection): boolean {
  return selection.time !== 'today' || FILTER_DIMENSIONS.some(dimension => selection[dimension].length > 0);
}
/** The checklist toggles: choosing a value that is already chosen drops it. */
export function toggleOption(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}
/** Choices that no longer name anything on the board (in any time range) are dropped, so a stale payload never empties it. */
export function resolveSelection(selection: TaskSelection, tasks: Task[], now: number = Date.now()): TaskSelection {
  return FILTER_DIMENSIONS.reduce((next, dimension) => {
    const known = new Set(filterOptions(tasks, dimension, { ...emptySelection(), time: 'all' }, now).map(option => option.value));
    next[dimension] = [...new Set(selection[dimension].map(value => {
      if (dimension !== 'owner' || known.has(value)) return value;
      const task = tasks.find(task => task.ownerId === value);
      return task ? taskOption(task, 'owner')?.value ?? value : value;
    }).filter(value => known.has(value)))];
    return next;
  }, { ...emptySelection(), time: selection.time });
}
/** Archive rows narrowed by the drawer's time, status, parent and sub agent selects. */
export function archiveRows(tasks: Task[], selection: TaskSelection, now: number = Date.now()): Task[] {
  return applyTaskFilters(archivedTasks(tasks, now), selection, undefined, now, tasks);
}
