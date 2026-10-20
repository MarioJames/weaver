import type { OwnerInstance } from '../shared/commands';
import type { Config } from '../shared/policy';
import type { Task, TaskStatus } from '../shared/types';
import { DISPLAY_LABELS, DISPLAY_STATUSES, displayStatus } from './status-colors';
import type { DisplayStatus } from './status-colors';
import { compactTime, projectTimeZone, startOfZonedDay } from './timezone';
export type TaskFilter = 'all' | 'active' | 'review' | 'closed';
export const statusLabels: Record<TaskStatus, string> = { queued: '待执行', running: '执行中', cancelling: '停止中', completed: '执行完成', failed: '执行失败', cancelled: '已取消' };
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
const validTime = (value?: string): value is string => !!value && Number.isFinite(Date.parse(value));
/** What a card's one footer sentence says: who dispatched, when, and the latest word on the task. */
export interface CardFooter {
  owner: string;
  /** The full instance name, for the tooltip. */
  ownerTitle: string;
  /** A task that never started was only created, not dispatched. */
  verb: '派发' | '创建';
  at: string;
  tail?: { label: '最新上报' | '完成于' | '结束于'; at: string };
}
export function cardFooter(task: Task): CardFooter {
  // A root parent task has no worker run of its own: its Herdr launch is when it was dispatched.
  const startedAt = task.run?.startedAt ?? (task.executionRole === 'owner' ? task.ownerHost?.launchedAt : undefined);
  const started = validTime(startedAt) ? startedAt : undefined;
  const at = started ?? task.createdAt;
  const head = { owner: ownerHostName(task), ownerTitle: ownerLabel(task), verb: started ? '派发' as const : '创建' as const, at };
  if (isActive(task)) {
    // A task that has not started has reported nothing: its only time is its creation.
    if (!started) return head;
    const last = task.events.at(-1)?.at;
    return { ...head, tail: { label: '最新上报', at: validTime(last) ? last : task.updatedAt } };
  }
  const endedAt = task.run?.endedAt;
  const ended = validTime(endedAt) ? endedAt : task.updatedAt;
  return { ...head, tail: { label: task.status === 'completed' ? '完成于' : '结束于', at: ended } };
}
/** The sentence as plain text, times in the board's compact format: 由 Claude 于 22:52 派发 · 最新上报 22:55. */
export function cardFooterText(footer: CardFooter, now: number = Date.now(), zone: string = projectTimeZone()): string {
  const head = `由 ${footer.owner} 于 ${compactTaskTime(footer.at, now, zone)} ${footer.verb}`;
  return footer.tail ? `${head} · ${footer.tail.label} ${compactTaskTime(footer.tail.at, now, zone)}` : head;
}
/** Compact display in the project time zone (HH:mm today, MM-DD HH:mm otherwise); the original timestamp remains available on the time element. */
export function compactTaskTime(value: string, now: number = Date.now(), zone: string = projectTimeZone()): string {
  return compactTime(value, now, zone);
}
export function filterTasks(tasks: Task[], filter: TaskFilter): Task[] {
  return tasks.filter(task => filter === 'all' || (filter === 'active' && isActive(task)) || (filter === 'review' && task.status === 'completed' && reviewStatus(task) === 'pending') || (filter === 'closed' && !isActive(task)));
}
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
/** localStorage key holding the board's filter selection. */
export const TASK_FILTERS_KEY = 'weaver-task-filters';
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
/** A stored payload decodes to a selection; anything malformed or of the wrong shape is no selection at all. */
function parseSelection(raw: string | null): TaskSelection {
  if (!raw) return emptySelection();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptySelection();
    const stored = parsed as Record<string, unknown>;
    const initial = emptySelection();
    initial.time = TIME_RANGES.find(range => range.value === stored.time)?.value ?? initial.time;
    return FILTER_DIMENSIONS.reduce((selection, dimension) => {
      const values = stored[dimension];
      selection[dimension] = Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];
      return selection;
    }, initial);
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
/** localStorage key recording whether the facet block is collapsed to its summary line. */
export const FILTERS_COLLAPSED_KEY = 'weaver-task-filters-collapsed';
export function readFiltersCollapsed(): boolean {
  try { return localStorage.getItem(FILTERS_COLLAPSED_KEY) === 'true'; } catch { return false; }
}
export function writeFiltersCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(FILTERS_COLLAPSED_KEY, String(collapsed)); } catch { /* The choice stays for this session only. */ }
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
/** Directory labels retain full paths as identity, including roots and missing workspaces. */
function workspaceLabel(workspace: string): string {
  const path = workspace.replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1) || workspace || '未指定工作目录';
}
/** Workspace groups and their cards both follow the newest task's update time. */
export function workspaceGroups(tasks: Task[]): { workspace: string; label: string; tasks: Task[] }[] {
  const groups = new Map<string, Task[]>();
  for (const task of [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const workspace = task.workspace ?? '';
    const group = groups.get(workspace);
    if (group) group.push(task);
    else groups.set(workspace, [task]);
  }
  return [...groups].map(([workspace, tasks]) => ({ workspace, label: workspaceLabel(workspace), tasks }));
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
/** How long finished work stays on the board before it moves to the archive. */
export const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Derived view only: closed work that has sat for a day leaves the board for the archive drawer. */
export function isArchived(task: Task, now: number = Date.now()): boolean {
 return taskColumn(task) === 'closed' && now - Date.parse(task.updatedAt) > ARCHIVE_AFTER_MS;
}
/** A child whose root is in the list lives inside the root (card summary, detail list), never as its own card; an orphan keeps its card. */
export function withoutNestedChildren(tasks: Task[]): Task[] {
 const ids = new Set(tasks.map(task => task.id));
 return tasks.filter(task => !task.parentTaskId || !ids.has(task.parentTaskId));
}
export function nonArchived(tasks: Task[], now: number = Date.now()): Task[] {
 return withoutNestedChildren(tasks).filter(task => !isArchived(task, now));
}
/** Everything the board has moved on from, newest first: the archive drawer's rows. */
export function archivedTasks(tasks: Task[], now: number = Date.now()): Task[] {
 return withoutNestedChildren(tasks).filter(task => isArchived(task, now)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
/** Archive rows narrowed by the drawer's time, status, parent and sub agent selects. */
export function archiveRows(tasks: Task[], selection: TaskSelection, now: number = Date.now()): Task[] {
  return applyTaskFilters(archivedTasks(tasks, now), selection, undefined, now, tasks);
}
export function reviewStatus(task: Task): string { return task.status === 'completed' ? (task.reviewState ?? 'pending') : 'not_ready'; }
export function reviewLabel(task: Task): string { const status = reviewStatus(task); return ({ pending: '待验收', approved: '已通过', accepted: '已通过', rejected: '需修改', changes_requested: '需修改', not_ready: '尚未进入验收' } as Record<string,string>)[status] ?? status; }
