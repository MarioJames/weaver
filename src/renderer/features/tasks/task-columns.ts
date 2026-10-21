import type { Task } from '../../../shared/contracts/tasks';
import { reviewStatus } from './task-view';
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
export function workspaceLabel(workspace: string): string {
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
/** One line of a column once its workspace groups are flattened: a group heading (the first one below the 置顶 zone carries a rule above it), the 置顶 zone header, or a card. Only the lines near the viewport are mounted. */
export type BoardRow = { key: string; kind: 'heading'; label: string; title: string; count: number; afterZone?: true } | { key: string; kind: 'zoneHeading'; count: number } | { key: string; kind: 'card'; task: Task };
/** Groups flattened into one row sequence; every group gets a heading (even a single one), since cards no longer show the workspace. */
export function boardRows(groups: { workspace: string; label: string; tasks: Task[] }[]): BoardRow[] {
  return groups.flatMap(group => [
    { key: `group:${group.workspace}`, kind: 'heading' as const, label: group.label, title: group.workspace || group.label, count: group.tasks.length },
    ...group.tasks.map(task => ({ key: task.id, kind: 'card' as const, task })),
  ]);
}
/**
 * 置顶区 rows: the 「置顶 · N」 zone header, then the pinned cards behind workspace group headings —
 * grouped in the given order (splitPinned's manual-first, then newest), not re-sorted by update time.
 * Every key carries the pinned: namespace so zone and plain groups can share one lane without clashes.
 */
/**
 * The plain groups below a 置顶 zone: the first heading is flagged so the board draws a rule above it. Without it the
 * same workspace listed in both sections reads as one repeated group. Nothing changes when there is no zone.
 */
export function afterZone(zone: readonly BoardRow[], plain: BoardRow[]): BoardRow[] {
  const [first, ...rest] = plain;
  return zone.length && first?.kind === 'heading' ? [{ ...first, afterZone: true }, ...rest] : plain;
}
export function pinnedRows(pinned: readonly Task[]): BoardRow[] {
  if (!pinned.length) return [];
  const groups = new Map<string, Task[]>();
  for (const task of pinned) {
    const workspace = task.workspace ?? '';
    const group = groups.get(workspace);
    if (group) group.push(task);
    else groups.set(workspace, [task]);
  }
  return [
    { key: 'pinned:zone', kind: 'zoneHeading', count: pinned.length },
    ...[...groups].flatMap(([workspace, tasks]) => [
      { key: `pinned:group:${workspace}`, kind: 'heading' as const, label: workspaceLabel(workspace), title: workspace || workspaceLabel(workspace), count: tasks.length },
      ...tasks.map(task => ({ key: `pinned:${task.id}`, kind: 'card' as const, task })),
    ]),
  ];
}
