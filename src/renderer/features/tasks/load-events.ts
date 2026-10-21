import type { TaskEvent } from '../../../shared/contracts/tasks';

export interface EventPage { events: TaskEvent[]; nextCursor: string | null; hasMore: boolean }

/** Safety cap on pages fetched per load so a broken cursor can never loop forever. */
export const EVENT_PAGE_LIMIT = 200;

/**
 * Whether a load for `taskId` may echo pages back progressively: only the first load of a task
 * (including after a task switch, when `loadedTaskId` still names the previous task) or a retry
 * with nothing loaded yet. Same-task refreshes with events already on screen stay silent until the
 * full result arrives, so a long timeline never collapses back to the first page mid-refresh.
 */
export function progressiveFor(loadedTaskId: string | null, taskId: string, loadedCount: number): boolean {
  return loadedTaskId !== taskId || loadedCount === 0;
}

/**
 * Read every page of task events starting at the first page, following nextCursor until
 * the server reports no more. Accumulated events are handed to onProgress after each page
 * so a long timeline appears progressively. Stops immediately (no further fetches, no
 * further callbacks) when isCurrent() turns false — a task switch or unmount — or when the
 * page cap is reached; throws when a page fails, keeping what was already delivered.
 */
export async function loadAllEvents(fetchPage: (after?: string) => Promise<EventPage>, isCurrent: () => boolean, onProgress?: (events: TaskEvent[]) => void): Promise<TaskEvent[]> {
  const collected: TaskEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < EVENT_PAGE_LIMIT && isCurrent(); page += 1) {
    const result = await fetchPage(cursor);
    if (!isCurrent()) return collected;
    collected.push(...result.events);
    onProgress?.([...collected]);
    if (!result.hasMore || !result.nextCursor) return collected;
    cursor = result.nextCursor;
  }
  return collected;
}
