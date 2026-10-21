import type { Task } from '../../../shared/contracts/tasks';
import { compactTime, projectTimeZone } from '../../format/timezone';
import { isActive, ownerHostName, ownerLabel } from './task-view';
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
export function cardFooter(task: Task, owner?: { name: string; title: string }): CardFooter {
  // A root parent task has no worker run of its own: its Herdr launch is when it was dispatched.
  const startedAt = task.run?.startedAt ?? (task.executionRole === 'owner' ? task.ownerHost?.launchedAt : undefined);
  const started = validTime(startedAt) ? startedAt : undefined;
  const at = started ?? task.createdAt;
  const head = { owner: owner?.name ?? ownerHostName(task), ownerTitle: owner?.title ?? ownerLabel(task), verb: started ? '派发' as const : '创建' as const, at };
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
