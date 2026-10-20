import type { Task } from '../../../shared/contracts/tasks';
import { taskColumn } from './task-columns';
/** The archive table header sits above its scrolling body; its rows are virtual, so the body needs a numeric height. */
export const ARCHIVE_TABLE_HEADER = 40;
export const ARCHIVE_TABLE_MIN_BODY = 240;
/** Virtual rows are one line tall, so every column has a fixed width; narrower drawers scroll sideways. */
export const ARCHIVE_TABLE_WIDTH = 780;
/** The body height for the drawer space left to the table; unmeasured space falls back to the minimum so the table never collapses. */
export function archiveScrollY(available: number | undefined): number {
  return Math.max(ARCHIVE_TABLE_MIN_BODY, Math.floor((available ?? 0) - ARCHIVE_TABLE_HEADER));
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
