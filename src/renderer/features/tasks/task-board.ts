import type { Task } from '../../../shared/contracts/tasks';
import type { TaskHealthState } from '../../../shared/contracts/monitoring';
import { displayStatus } from '../../format/status-colors';
import { completedAt } from './task-footer';
import { dispatchKind, isOwnerRoot, ownerHostName, ownerLabel, taskOwnerId, taskTitle } from './task-view';
import { sessionWorkspaceLabel } from './task-session';
import type { WorkbenchBoard } from './task-persistence';

/** 看板列：待执行（queued / scheduled / draft）· 执行中（running / cancelling）· 待验收（completed 且验收待定）· 已结束（其余）。 */
export type BoardColumnKey = 'queued' | 'running' | 'review' | 'closed';

export const BOARD_COLUMNS: readonly { key: BoardColumnKey; label: string }[] = [
  { key: 'queued', label: '待执行' },
  { key: 'running', label: '执行中' },
  { key: 'review', label: '待验收' },
  { key: 'closed', label: '已结束' },
];

/** 已结束列只放近 24 小时内结束的任务；更早的在全部任务表中查看。 */
export const BOARD_CLOSED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 任务在看板 belong 的列，按人读到的显示状态划分。 */
export function boardColumnOf(task: Task): BoardColumnKey {
  const status = displayStatus(task);
  if (status === 'draft' || status === 'queued' || status === 'scheduled') return 'queued';
  if (status === 'running' || status === 'cancelling') return 'running';
  if (status === 'review') return 'review';
  return 'closed';
}

/** 看板的卡片是子 Agent 的工作包：父 Agent 根任务只活在会话里，不进列。 */
export function isBoardTask(task: Task): boolean {
  return !isOwnerRoot(task);
}

/** 看板可见的任务：去掉父 Agent 根任务，已结束列只留 24 小时窗口内的。 */
export function boardVisible(tasks: readonly Task[], now: number): Task[] {
  return tasks.filter(task => {
    if (!isBoardTask(task)) return false;
    if (boardColumnOf(task) !== 'closed') return true;
    const ended = Date.parse(completedAt(task));
    return Number.isFinite(ended) && now - ended <= BOARD_CLOSED_WINDOW_MS;
  });
}

/** 一列之内的任务：按最近更新倒序。 */
export function columnizeBoard(tasks: readonly Task[]): Record<BoardColumnKey, Task[]> {
  const columns: Record<BoardColumnKey, Task[]> = { queued: [], running: [], review: [], closed: [] };
  for (const task of tasks) columns[boardColumnOf(task)].push(task);
  for (const key of Object.keys(columns) as BoardColumnKey[]) {
    columns[key].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return columns;
}

export interface BoardGroup {
  workspace: string;
  label: string;
  tasks: Task[];
  lastActivityAt: string;
}

/** 列内按工作目录分组：每组都显示组头（含只有一组时），组按最近更新倒序。 */
export function groupBoardColumn(tasks: readonly Task[]): BoardGroup[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const workspace = task.dispatch?.workspace || task.workspace || '';
    const group = groups.get(workspace);
    if (group) group.push(task);
    else groups.set(workspace, [task]);
  }
  return [...groups]
    .map(([workspace, items]) => ({
      workspace,
      label: sessionWorkspaceLabel(workspace),
      tasks: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      lastActivityAt: items.reduce((latest, task) => (task.updatedAt > latest ? task.updatedAt : latest), ''),
    }))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/** 组折叠的存储键：列 + 工作目录。 */
export function boardGroupKey(column: BoardColumnKey, workspace: string): string {
  return `${column}:${workspace}`;
}

/** 组是否折叠：存过的值优先；待执行、执行中、待验收默认展开，已结束默认折叠。 */
export function isGroupCollapsed(collapsed: Record<string, boolean>, column: BoardColumnKey, workspace: string): boolean {
  const stored = collapsed[boardGroupKey(column, workspace)];
  if (typeof stored === 'boolean') return stored;
  return column === 'closed';
}

/** 父 Agent 筛选的取值：实例 id 优先，其次冻结的 profile，都没有时回落到名称。 */
export function boardOwnerKey(task: Task): string {
  return task.ownerId ?? taskOwnerId(task) ?? ownerLabel(task);
}

export interface BoardOwnerOption {
  value: string;
  label: string;
  title: string;
  kind?: string;
}

/** 父 Agent 多选的选项：短宿主名 + 完整名悬停，引擎种类供图标使用。 */
export function boardOwnerOptions(tasks: readonly Task[]): BoardOwnerOption[] {
  const options = new Map<string, BoardOwnerOption>();
  for (const task of tasks) {
    const value = boardOwnerKey(task);
    if (options.has(value)) continue;
    const full = ownerLabel(task);
    options.set(value, { value, label: ownerHostName(task), title: full, kind: dispatchKind(task) });
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh'));
}

export interface BoardWorkspaceOption {
  value: string;
  label: string;
}

/** 工作目录多选的选项：目录名 + 完整路径悬停。 */
export function boardWorkspaceOptions(tasks: readonly Task[]): BoardWorkspaceOption[] {
  const paths = new Set<string>();
  for (const task of tasks) {
    const workspace = task.dispatch?.workspace || task.workspace || '';
    if (workspace) paths.add(workspace);
  }
  return [...paths]
    .map(value => ({ value, label: sessionWorkspaceLabel(value) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
}

/** 看板工具条的筛选：搜索（任务标题、子 Agent、工作目录）+ 工作目录多选 + 父 Agent 多选。 */
export function applyBoardFilters(tasks: readonly Task[], prefs: WorkbenchBoard): Task[] {
  const needle = prefs.query.trim().toLocaleLowerCase();
  const workspaces = new Set(prefs.workspaces);
  const owners = new Set(prefs.owners);
  return tasks.filter(task => {
    if (workspaces.size > 0 && !workspaces.has(task.dispatch?.workspace || task.workspace || '')) return false;
    if (owners.size > 0 && !owners.has(boardOwnerKey(task))) return false;
    if (!needle) return true;
    const haystack = [taskTitle(task), task.dispatch?.worker ?? '', task.dispatch?.workspace ?? task.workspace ?? '']
      .join('\n')
      .toLocaleLowerCase();
    return haystack.includes(needle);
  });
}

/** 看板卡片是否展示健康徽标：只在异常健康态展示（疑似停滞/无输出等），正常执行中不展示，避免与状态文字重复。 */
export function isBoardHealthAlert(state: TaskHealthState): boolean {
  return state === 'stalled' || state === 'waiting_model';
}

/** 小屏状态 Segmented 的计数：筛选后的四列任务数。 */
export function boardColumnCounts(tasks: readonly Task[]): Record<BoardColumnKey, number> {
  const counts: Record<BoardColumnKey, number> = { queued: 0, running: 0, review: 0, closed: 0 };
  for (const task of tasks) counts[boardColumnOf(task)] += 1;
  return counts;
}
