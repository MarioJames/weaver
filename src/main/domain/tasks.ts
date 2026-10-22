import { randomUUID } from 'node:crypto';
import type { LogicalOwner } from '../../shared/contracts/owners';
import type { Task, TaskEvent } from '../../shared/contracts/tasks';

export const active = (task: Task) => task.status === 'running' || task.status === 'cancelling';
/** A permitted but unfinalized run still owns its worker and owner slot, even after a failed decision. */
export const occupiesSlot = (task: Pick<Task, 'status' | 'executionRole' | 'run'>): boolean =>
 task.executionRole !== 'owner' && (task.status === 'running' || task.status === 'cancelling' || (task.run?.launchPermittedAt !== undefined && task.run.finalizedAt === undefined));
/** Slots belong to the exact owner instance a task is bound to; unbound work shares only its own profile group. */
const instanceGroup = (ownerId: string) => `instance:${ownerId}`;
const profileGroup = (profile: string) => `profile:${profile}`;
export const slotGroupOf = (task: Pick<Task, 'ownerId' | 'dispatch'>): string | undefined => task.ownerId ? instanceGroup(task.ownerId) : task.dispatch ? profileGroup(task.dispatch.owner) : undefined;
/** The group new work competes in: its own instance when bound, otherwise the profile group of unbound work. */
export const slotGroupFor = (ownerId: string | undefined, profile: string) => ownerId ? instanceGroup(ownerId) : profileGroup(profile);
/** Running, cancelling and still-open runs already holding a slot of the same owner instance. */
export const slotGroupCount = (tasks: Task[], group: string | undefined): number => group === undefined ? 0 : tasks.reduce((held, task) => held + (occupiesSlot(task) && slotGroupOf(task) === group ? 1 : 0), 0);
/** Whose slots these are, in the words an owner reads when a dispatch has to wait. */
export const slotGroupName = (owners: LogicalOwner[], ownerId: string | undefined, profile: string): string => {
 const instance = ownerId ? owners.find(owner => owner.id === ownerId) : undefined;
 return instance ? `Owner instance ${instance.name} of profile ${profile}` : `Owner ${profile}`;
};
export function event(task: Task, kind: TaskEvent['kind'], message: string): void {
  const at = new Date().toISOString(); task.updatedAt = at;
  task.events.push({id:randomUUID(), at, kind, message});
  retainBoundedEvents(task);
}

/** Hard bound on the retained timeline; process records have their own tighter budget below. */
export const MAX_TASK_EVENTS = 500;
/** Process records (log/progress) keep their head and tail; the gap becomes one omission marker. */
export const PROCESS_HEAD_RETAINED = 50;
export const PROCESS_TAIL_RETAINED = 400;

const isProcessKind = (kind: TaskEvent['kind']): boolean => kind === 'log' || kind === 'progress';
export const omissionMessage = (omitted: number): string =>
  `已省略 ${omitted} 条过程记录（仅保留最早 ${PROCESS_HEAD_RETAINED} 条与最近 ${PROCESS_TAIL_RETAINED} 条；结果、产物与失败记录不受影响）`;
export function isOmissionMarker(item: TaskEvent): boolean {
  return item.kind === 'log' && /^已省略 \d+ 条过程记录（/.test(item.message);
}
function omittedCount(message: string): number {
  const match = /^已省略 (\d+) 条过程记录（/.exec(message);
  return match ? Number(match[1]) : 0;
}

/**
 * Bounded retention for the task timeline. Process records (log/progress) keep
 * their earliest HEAD and most recent TAIL entries with a single omission
 * marker at the gap; lifecycle/result/artifact/error records decide the task
 * outcome and are never evicted by this budget. The absolute MAX_TASK_EVENTS
 * bound is a last resort that still spares the marker.
 */
function retainBoundedEvents(task: Task): void {
  let marker: TaskEvent | undefined;
  const process: TaskEvent[] = [];
  for (const item of task.events) {
    if (isOmissionMarker(item)) marker ??= item;
    else if (isProcessKind(item.kind)) process.push(item);
  }
  if (process.length > PROCESS_HEAD_RETAINED + PROCESS_TAIL_RETAINED) {
    const drop = process.length - (PROCESS_HEAD_RETAINED + PROCESS_TAIL_RETAINED);
    const victims = new Set(process.slice(PROCESS_HEAD_RETAINED, process.length - PROCESS_TAIL_RETAINED));
    const omitted = (marker ? omittedCount(marker.message) : 0) + drop;
    task.events = task.events.filter(item => !victims.has(item));
    const at = new Date().toISOString();
    if (marker) { marker.message = omissionMessage(omitted); marker.at = at; }
    else marker = {id: randomUUID(), at, kind: 'log', message: omissionMessage(omitted)};
    task.events = task.events.filter(item => item !== marker);
    const headLast = process[PROCESS_HEAD_RETAINED - 1];
    const anchor = headLast ? task.events.indexOf(headLast) : -1;
    task.events.splice(anchor + 1, 0, marker);
  }
  while (task.events.length > MAX_TASK_EVENTS) {
    const index = task.events.findIndex(item => !isOmissionMarker(item));
    if (index < 0) break;
    const [victim] = task.events.splice(index, 1);
    if (victim && isProcessKind(victim.kind) && victim !== marker) {
      const at = new Date().toISOString();
      const omitted = (marker ? omittedCount(marker.message) : 0) + 1;
      if (marker) { marker.message = omissionMessage(omitted); marker.at = at; }
      else {
        marker = {id: randomUUID(), at, kind: 'log', message: omissionMessage(omitted)};
        task.events.splice(Math.min(index, task.events.length), 0, marker);
      }
    }
  }
}
