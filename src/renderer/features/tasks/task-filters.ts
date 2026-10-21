import type { Task } from '../../../shared/contracts/tasks';
import { DISPLAY_LABELS, DISPLAY_STATUSES, displayStatus } from '../../format/status-colors';
import type { DisplayStatus } from '../../format/status-colors';
import { PENDING_TASK_TITLE } from '../../../shared/validation';
import { projectTimeZone, startOfZonedDay } from '../../format/timezone';
import { archivedTasks, isArchived, nonArchived } from './task-archive';
import { workspaceLabel } from './task-columns';
import { dispatchKind, isRootTask, logicalOwnerName, ownerInstanceTitle, ownerLabel, taskOwnerId, taskTitle } from './task-view';
/** The facet rows below 时间, in display order. */
export type FilterDimension = 'status' | 'owner' | 'worker' | 'workspace';
export const FILTER_DIMENSIONS: readonly FilterDimension[] = ['status', 'owner', 'worker', 'workspace'];
export const filterLabels: Record<FilterDimension, string> = { status: '状态', owner: '父 Agent', worker: '子 Agent', workspace: '工作目录' };
/** 读屏标签：标签以拉丁字母或数字结尾（父 Agent、子 Agent）时，两侧的中文连接词之间补一个空格。 */
export function filterAriaLabel(label: string): string {
  return /[A-Za-z0-9]$/.test(label) ? `按${label} 筛选归档任务` : `按${label}筛选归档任务`;
}
/**
 * 多选触发器里的值折叠：只完整显示第一个选中值，其余折成 +N（徽标悬停时列出被折叠的名字）。
 * 折进徽标之外的值由触发器渲染成空标签，再由样式隐藏。
 */
export function foldedTriggerValue(chosen: readonly string[], value: string, labelOf: (value: string) => string): { hidden: boolean; extra: number; extraTitle: string } {
  const index = chosen.indexOf(value);
  if (index > 0) return { hidden: true, extra: 0, extraTitle: '' };
  const rest = chosen.slice(index + 1).map(labelOf);
  return { hidden: false, extra: rest.length, extraTitle: rest.length ? `其余 ${rest.length} 项：${rest.join('、')}` : '' };
}
/**
 * The archive dropdown's own 「全部」 entry: never a stored value (a real option value can never collide with it),
 * and an empty row counts as 「全部」 chosen so the option renders selected without entering the selection.
 */
export const ARCHIVE_ALL_VALUE = '__all__';
/** One dropdown change for an archive facet: choosing 「全部」 clears the row, choosing values drops 「全部」. */
export function archiveRowValues(chosen: string[], next: string[]): string[] {
  const effective = chosen.length ? chosen : [ARCHIVE_ALL_VALUE];
  return next.includes(ARCHIVE_ALL_VALUE) && !effective.includes(ARCHIVE_ALL_VALUE) ? [] : next.filter(item => item !== ARCHIVE_ALL_VALUE);
}
/** The archive dropdown's options: 「全部 N」 first — N counts the archive narrowed by every other row, this one ignored — then the facet values with their counts. */
export function archiveSelectOptions(archived: Task[], dimension: FilterDimension, selection: TaskSelection, now: number = Date.now(), all: Task[] = archived): { value: string; label: string }[] {
  const allCount = applyTaskFilters(archived, selection, dimension, now, all).length;
  return [{ value: ARCHIVE_ALL_VALUE, label: `全部 ${allCount}` }, ...facetOptions(archived, dimension, selection, now, all).map(option => ({ value: option.value, label: `${option.label} ${option.count}` }))];
}
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
export interface FilterOption { value: string; label: string; kind?: string; count: number; ownerProfile?: string; /** Hover text when the chip shortens a longer name. */ title?: string; /** A-type parent Agents show the root task's own status beside their name. */ ownerStatus?: DisplayStatus }
/** A parent Agent chip reads "<host> · <session time>"; the workspace directory in the middle of the instance name is the lane's heading and stays in the hover. */
export function ownerChipLabel(full: string): string {
  const parts = full.split(' · ');
  return parts.length >= 3 ? `${parts[0]} · ${parts[parts.length - 1]}` : full;
}
/** Owner roots by id: an A-type parent Agent is found by its root task, whose children answer for it. */
export type RootIndex = Map<string, Task>;
export function rootIndex(tasks: Task[]): RootIndex {
  const index: RootIndex = new Map();
  for (const task of tasks) if (isRootTask(task)) index.set(task.id, task);
  return index;
}
/** The value a task answers for in one dimension; undefined when the task has no value to group by. */
export function taskOption(task: Task, dimension: FilterDimension, roots: RootIndex = new Map()): { value: string; label: string; title?: string; status?: DisplayStatus } | undefined {
  if (dimension === 'owner') {
    // A-type: children answer for their root task, and the root itself for its own future children.
    const root = task.parentTaskId ? roots.get(task.parentTaskId) : isRootTask(task) ? task : undefined;
    if (root) {
      const label = taskTitle(root);
      return { value: root.id, label, title: root.title !== PENDING_TASK_TITLE ? root.title : label, status: displayStatus(root) };
    }
    // B-type: a manually attached parent Agent instance answers by its instance id; its described title names the chip when present, the full instance name stays on hover.
    if (task.ownerId && logicalOwnerName(task)) {
      const full = task.owner.name;
      const described = ownerInstanceTitle(task);
      const label = described ?? ownerChipLabel(full);
      return { value: task.ownerId, label, ...(label !== full ? { title: described ? `${described} · ${full}` : full } : {}) };
    }
    // Legacy tasks without a registration or a root fall back to their frozen policy profile.
    const full = ownerLabel(task);
    const label = ownerChipLabel(full);
    return { value: taskOwnerId(task) ?? full, label, ...(label !== full ? { title: full } : {}) };
  }
  if (dimension === 'status') {
    const status = displayStatus(task);
    return { value: status, label: DISPLAY_LABELS[status] };
  }
  if (dimension === 'workspace') {
    const workspace = task.workspace;
    // A draft without a directory still answers for the workspace row: one 未指定工作目录 chip. Its value '' can never collide with a real absolute path.
    return { value: workspace ?? '', label: workspaceLabel(workspace ?? '') };
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
export function taskOptions(task: Task, dimension: FilterDimension, children: ChildIndex = new Map(), roots: RootIndex = new Map()): (NonNullable<ReturnType<typeof taskOption>> & { kind?: string })[] {
  if (dimension !== 'worker') {
    const option = taskOption(task, dimension, roots);
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
  const roots = rootIndex(all);
  return filterByTime(tasks, selection.time, now).filter(task => FILTER_DIMENSIONS.every(dimension => {
    if (dimension === skip) return true;
    const chosen = selection[dimension];
    if (!chosen.length) return true;
    return taskOptions(task, dimension, children, roots).some(option => chosen.includes(option.value));
  }));
}
/**
 * The chips of one row over a pool of tasks. Only values with tasks in the chosen time range (and in the
 * other rows' selections) are offered, counted in that scope; a chosen value with none stays at count 0 so it can be unchecked.
 */
export function facetOptions(pool: Task[], dimension: FilterDimension, selection: TaskSelection, now: number = Date.now(), all: Task[] = pool): FilterOption[] {
  const children = childIndex(all);
  const roots = rootIndex(all);
  const scoped = new Set(applyTaskFilters(pool, selection, dimension, now, all).map(task => task.id));
  const seen = new Map<string, FilterOption>();
  for (const task of pool) {
    const counted = scoped.has(task.id);
    for (const option of taskOptions(task, dimension, children, roots)) {
      const known = seen.get(option.value);
      if (known) {
        if (counted) known.count += 1;
        continue;
      }
      seen.set(option.value, { value: option.value, label: option.label, kind: dimension === 'worker' ? option.kind : undefined, ...(dimension === 'owner' ? { ownerProfile: taskOwnerId(task), ownerStatus: option.status, ...(option.title ? { title: option.title } : {}) } : {}), count: counted ? 1 : 0 });
    }
  }
  const rootBacked = new Set<string>();
  if (dimension === 'owner') {
    // A parent Agent with no sub agent tasks yet still offers itself, at count 0, wherever it is in the time scope.
    const boardPool = pool.some(task => !isArchived(task, now));
    if (boardPool) for (const root of roots.values()) {
      if (seen.has(root.id) || isArchived(root, now)) continue;
      const label = taskTitle(root);
      rootBacked.add(root.id);
      seen.set(root.id, { value: root.id, label, ownerProfile: taskOwnerId(root), ownerStatus: displayStatus(root), title: root.title !== PENDING_TASK_TITLE ? root.title : label, count: 0 });
    }
  }
  const chosen = selection[dimension];
  for (const value of chosen) if (!seen.has(value)) seen.set(value, { value, label: dimension === 'status' ? DISPLAY_LABELS[value as DisplayStatus] ?? value : value, count: 0 });
  const options = [...seen.values()].filter(option => option.count > 0 || chosen.includes(option.value) || rootBacked.has(option.value));
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
  const roots = rootIndex(tasks);
  return FILTER_DIMENSIONS.reduce((next, dimension) => {
    const known = new Set(filterOptions(tasks, dimension, { ...emptySelection(), time: 'all' }, now).map(option => option.value));
    next[dimension] = [...new Set(selection[dimension].flatMap(value => {
      if (dimension !== 'owner' || known.has(value)) return [value];
      // Old payloads named a parent by instance id, or by the instance name that used to merge same-name registrations; both remap onto the current values.
      const matched = tasks.filter(task => task.ownerId === value || task.owner.name === value);
      return matched.length ? matched.map(task => taskOption(task, 'owner', roots)?.value ?? value) : [value];
    }).filter(value => known.has(value)))];
    return next;
  }, { ...emptySelection(), time: selection.time });
}
/** Archive rows narrowed by the drawer's time, status, parent and sub agent selects. */
export function archiveRows(tasks: Task[], selection: TaskSelection, now: number = Date.now()): Task[] {
  return applyTaskFilters(archivedTasks(tasks, now), selection, undefined, now, tasks);
}
