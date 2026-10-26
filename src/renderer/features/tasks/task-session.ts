import type { OwnerInstance } from '../../../shared/contracts/owners';
import type { Task } from '../../../shared/contracts/tasks';
import { DISPLAY_STATUSES, displayStatus, type DisplayStatus } from '../../format/status-colors';
import { dispatchKind, isOwnerRoot, isRootTask, ownerHostLabel, taskTitle } from './task-view';
import { attentionCount } from './task-attention';

export type SessionKind = 'root' | 'host' | 'unowned';

export interface Session {
  key: string;
  kind: SessionKind;
  root?: Task;
  owner?: OwnerInstance;
  title: string;
  hostKind?: string;
  workspace?: string;
  /** Sub tasks of the session; the root task itself is never included. */
  tasks: Task[];
  counts: Record<DisplayStatus, number>;
  attention: number;
  lastActivityAt: string;
}

export type TasksById = Map<string, Task> | Record<string, Task | undefined>;

function byId(tasksById: TasksById, id: string | undefined): Task | undefined {
  if (!id) return undefined;
  if (tasksById instanceof Map) return tasksById.get(id);
  return tasksById[id];
}

function isWebRoot(task: Task): boolean {
  return isRootTask(task);
}

/**
 * The session a task belongs to: a web root or a child of one is `r-<rootId>`,
 * otherwise the owner instance is `o-<ownerId>`, otherwise the legacy bucket.
 */
export function sessionKeyOf(task: Task, tasksById: TasksById): string {
  if (isWebRoot(task)) return `r-${task.id}`;
  if (task.parentTaskId) {
    const parent = byId(tasksById, task.parentTaskId);
    if (parent && isWebRoot(parent)) return `r-${parent.id}`;
  }
  if (task.ownerId) return `o-${task.ownerId}`;
  return 'unowned';
}

/** Directory name of an absolute path; '' stays '' so the group keeps its full-path title. */
export function sessionWorkspaceLabel(workspace: string): string {
  const path = workspace.replace(/\/+$/, '');
  if (!path) return workspace || '未指定工作目录';
  return path.slice(path.lastIndexOf('/') + 1) || workspace;
}

/** Session title order: web goal title -> instance title -> 「宿主 · HH:mm」; never the full instance name. */
export function sessionTitle(root: Task | undefined, owner: OwnerInstance | undefined): string {
  if (root) {
    const title = taskTitle(root);
    if (title) return title;
  }
  if (owner?.title?.trim()) return owner.title.trim();
  if (owner) return ownerHostLabel({ name: owner.name, createdAt: owner.createdAt });
  return '未归属的任务';
}

function sessionWorkspace(root: Task | undefined, tasks: Task[]): string | undefined {
  const fromRoot = root?.dispatch?.workspace || root?.workspace;
  if (fromRoot?.trim()) return fromRoot;
  const ordered = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const task of ordered) {
    const path = task.dispatch?.workspace || task.workspace;
    if (path?.trim()) return path;
  }
  return undefined;
}

function sessionHostKind(owner: OwnerInstance | undefined, root: Task | undefined, tasks: Task[]): string | undefined {
  const ordered = root ? [root, ...tasks] : tasks;
  for (const task of [...ordered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const kind = dispatchKind(task);
    if (kind) return kind;
  }
  return undefined;
}

function emptyCounts(): Record<DisplayStatus, number> {
  return Object.fromEntries(DISPLAY_STATUSES.map(status => [status, 0])) as Record<DisplayStatus, number>;
}

/**
 * One session per web root, per owner instance, plus the legacy bucket.
 * Web sessions carry their root (kept out of `tasks`); host sessions group by ownerId.
 */
export function buildSessions(tasks: readonly Task[], owners: readonly OwnerInstance[], now: number): Session[] {
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  const ownerById = new Map(owners.map(owner => [owner.id, owner]));
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = sessionKeyOf(task, tasksById);
    const group = groups.get(key);
    if (group) group.push(task);
    else groups.set(key, [task]);
  }
  const sessions: Session[] = [];
  for (const [key, members] of groups) {
    if (key === 'unowned') {
      const counts = emptyCounts();
      for (const task of members) counts[displayStatus(task)] += 1;
      const lastActivityAt = members.reduce((latest, task) => (task.updatedAt > latest ? task.updatedAt : latest), members[0]?.updatedAt ?? new Date(now).toISOString());
      sessions.push({
        key, kind: 'unowned', title: '未归属的任务',
        workspace: sessionWorkspace(undefined, members),
        tasks: [...members].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        counts, attention: attentionCount(members, now), lastActivityAt,
      });
      continue;
    }
    if (key.startsWith('r-')) {
      const rootId = key.slice(2);
      const root = tasksById.get(rootId);
      const children = members.filter(task => task.id !== rootId);
      const kind: SessionKind = 'root';
      const owner = root?.ownerId ? ownerById.get(root.ownerId) : undefined;
      const counts = emptyCounts();
      for (const task of children) counts[displayStatus(task)] += 1;
      const pool = root ? [root, ...children] : children;
      const lastActivityAt = pool.reduce((latest, task) => (task.updatedAt > latest ? task.updatedAt : latest), pool[0]?.updatedAt ?? new Date(now).toISOString());
      const title = root ? sessionTitle(root, owner) : (owner ? sessionTitle(undefined, owner) : `未归属的任务`);
      sessions.push({
        key, kind, root, owner, title,
        hostKind: sessionHostKind(owner, root, children),
        workspace: sessionWorkspace(root, children),
        tasks: [...children].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        counts, attention: attentionCount(pool.filter(task => !isOwnerRoot(task)), now), lastActivityAt,
      });
      continue;
    }
    const ownerId = key.slice(2);
    const owner = ownerById.get(ownerId);
    const counts = emptyCounts();
    for (const task of members) counts[displayStatus(task)] += 1;
    const lastActivityAt = members.reduce((latest, task) => (task.updatedAt > latest ? task.updatedAt : latest), members[0]?.updatedAt ?? new Date(now).toISOString());
    sessions.push({
      key, kind: 'host', owner, title: sessionTitle(undefined, owner),
      hostKind: sessionHostKind(owner, undefined, members),
      workspace: sessionWorkspace(undefined, members),
      tasks: [...members].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      counts, attention: attentionCount(members.filter(task => !isOwnerRoot(task)), now), lastActivityAt,
    });
  }
  return sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/**
 * Retry chains: every task filed under the earliest ancestor it retried from.
 * The map key is the original task id; each chain is ordered oldest first so the
 * list can indent retries under the original and label 「第 N 次尝试」.
 */
export function retryChains(tasks: readonly Task[]): Map<string, Task[]> {
  const byTaskId = new Map(tasks.map(task => [task.id, task]));
  const rootOf = (task: Task): string => {
    let current = task;
    const seen = new Set<string>([current.id]);
    while (current.retryOf) {
      const parent = byTaskId.get(current.retryOf);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
    }
    return current.id;
  };
  const chains = new Map<string, Task[]>();
  for (const task of tasks) {
    const rootId = rootOf(task);
    const chain = chains.get(rootId);
    if (chain) chain.push(task);
    else chains.set(rootId, [task]);
  }
  for (const chain of chains.values()) {
    chain.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  return chains;
}

/** 1-based position of a task inside its retry chain; the original is 1. */
export function retryAttemptOf(task: Task, chains: Map<string, Task[]>): number {
  for (const chain of chains.values()) {
    const index = chain.findIndex(item => item.id === task.id);
    if (index >= 0) return index + 1;
  }
  return 1;
}
