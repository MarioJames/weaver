import type { Task } from '../../../shared/contracts/tasks';
/** A task counts as 「新」 for this long after its creation (inclusive), then stops on its own. */
export const NEW_TASK_WINDOW_MS = 120000;
/** Manual pins: task id -> the moment it was pinned. Lives in localStorage via task-persistence. */
export type TaskPins = Record<string, number>;

/** True while the task was created at most one window ago; a future or unreadable createdAt is never freshness (clock rollback is not 「新」). */
export function isNewTask(task: Task, now: number): boolean {
  const createdAt = Date.parse(task.createdAt);
  if (Number.isNaN(createdAt)) return false;
  const age = now - createdAt;
  return age >= 0 && age <= NEW_TASK_WINDOW_MS;
}

/** The earliest moment any still-new task leaves the window; the board re-renders at that instant. Null when nothing is new. */
export function nextNewExpiry(tasks: readonly Task[], now: number): number | null {
  return tasks.reduce<number | null>((earliest, task) => {
    if (!isNewTask(task, now)) return earliest;
    const expiry = Date.parse(task.createdAt) + NEW_TASK_WINDOW_MS;
    return earliest === null || expiry < earliest ? expiry : earliest;
  }, null);
}

export function isPinned(pins: TaskPins, id: string): boolean {
  return pins[id] !== undefined;
}

/**
 * The moment a click pins a task. The board's clock is the page's render-time value and goes stale between data
 * refreshes, so two pins clicked in one stretch would tie and lose their order; the wall clock plus a strict step past
 * the newest existing pin keeps 「按置顶时间倒序」 deterministic.
 */
export function nextPinTime(pins: TaskPins, renderNow: number, wallNow: number): number {
  return Math.max(wallNow, renderNow, ...Object.values(pins).map(at => at + 1));
}

/** Toggle one pin, recording the moment it was pinned. Pure: the caller decides when to persist. */
export function togglePin(pins: TaskPins, id: string, now: number): TaskPins {
  if (isPinned(pins, id)) {
    const next = { ...pins };
    delete next[id];
    return next;
  }
  return { ...pins, [id]: now };
}

/** Drop entries whose id is no longer any task; the same record returns unchanged when nothing is stale. */
export function pruneStalePins(pins: TaskPins, ids: Iterable<string>): TaskPins {
  const known = new Set(ids);
  const stale = Object.keys(pins).filter(id => !known.has(id));
  if (!stale.length) return pins;
  const next = { ...pins };
  for (const id of stale) delete next[id];
  return next;
}

/**
 * The pinned section of one column: every manual pin and every still-new task. Manual pins sort by
 * pin time (newest first) and lead; the remaining 「新」 tasks follow by createdAt. Everything else
 * stays in the plain groups in its original column order.
 */
export function splitPinned(items: readonly Task[], pins: TaskPins, now: number): { pinned: Task[]; rest: Task[] } {
  const manual = items.filter(task => isPinned(pins, task.id)).sort((a, b) => pins[b.id] - pins[a.id]);
  const fresh = items.filter(task => isNewTask(task, now) && !isPinned(pins, task.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const zoneIds = new Set([...manual, ...fresh].map(task => task.id));
  return { pinned: [...manual, ...fresh], rest: items.filter(task => !zoneIds.has(task.id)) };
}
