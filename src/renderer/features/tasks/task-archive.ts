import type { Task } from '../../../shared/contracts/tasks';
import { taskColumn } from './task-columns';
import { isOwnerRoot } from './task-view';
/** The archive table header sits above its scrolling body; its rows are virtual, so the body needs a numeric height. */
export const ARCHIVE_TABLE_HEADER = 40;
export const ARCHIVE_TABLE_MIN_BODY = 240;
/** Virtual rows are one line tall, so every column has a fixed width; narrower drawers scroll sideways. */
export const ARCHIVE_TABLE_WIDTH = 780;
/** The pager the table mounts under the body: one 24px line plus the 8px the drawer gives it above and below. */
export const ARCHIVE_PAGINATION_BAR = 40;
/** The body height for the drawer space left to the table, once the header and the pager below it are paid for. */
export function archiveScrollY(available: number | undefined, paginationBar: number): number {
  return Math.max(ARCHIVE_TABLE_MIN_BODY, Math.floor((available ?? 0) - ARCHIVE_TABLE_HEADER - paginationBar));
}
/** A day of archived work pages comfortably at 50, and the reader may trade that for fewer or more rows. */
export const ARCHIVE_PAGE_SIZE = 50;
export const ARCHIVE_PAGE_SIZES = [20, ARCHIVE_PAGE_SIZE, 100];
/** How much archived work the current filters match, in the pager's own words. */
export function archiveTotalLabel(total: number): string { return `共 ${total} 条`; }
/** A page size, said the way the archive says it: the library's own size changer speaks English. */
export function archivePageSizeLabel(size: number | string): string { return `${size} 条/页`; }
/** What the picker for page size is called, since the library gives it no name of its own. */
export const ARCHIVE_SIZE_CHANGER_LABEL = '每页条数';
export interface ArchivePageSizeOption { label: string; value: string }
/** The flat options the pager hands its size changer, relabelled from the size each one pages by. */
export function archivePageSizeOptions(options: readonly { label?: unknown; value?: string | number }[]): ArchivePageSizeOption[] {
  return options.map(({ value }) => { const size = `${value}`; return { value: size, label: archivePageSizeLabel(size) }; });
}
/** Pages that exist for a list; an empty list still has its first page. */
export function archivePageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
/** The page to show: a list that grew shorter pulls the reader onto its last page instead of a blank one. */
export function clampArchivePage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, page), archivePageCount(total, pageSize));
}
export interface ArchivePager { page: number; pageSize: number }
/** Filters pick a different list, so its page starts over; the page size is the reader's choice and stays. */
export function resetArchivePage(pager: ArchivePager): ArchivePager {
  return { ...pager, page: 1 };
}
/** What the pager asked for, stored already inside the list it pages through. */
export function applyArchivePage(pager: ArchivePager, total: number, page: number, pageSize: number): ArchivePager {
  return { page: clampArchivePage(page, total, pageSize), pageSize };
}
/** How long finished work stays on the board before it moves to the archive. */
export const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Derived view only: closed work that has sat for a day leaves the board for the archive drawer. */
export function isArchived(task: Task, now: number = Date.now()): boolean {
 return taskColumn(task) === 'closed' && now - Date.parse(task.updatedAt) > ARCHIVE_AFTER_MS;
}
/** The board and archive rows are sub agent tasks: owner roots live only in the 父 Agent filter row and the detail links. */
export function withoutRootTasks(tasks: Task[]): Task[] {
 return tasks.filter(task => !isOwnerRoot(task));
}
export function nonArchived(tasks: Task[], now: number = Date.now()): Task[] {
 return withoutRootTasks(tasks).filter(task => !isArchived(task, now));
}
/** Everything the board has moved on from, newest first: the archive drawer's rows. */
export function archivedTasks(tasks: Task[], now: number = Date.now()): Task[] {
 return withoutRootTasks(tasks).filter(task => isArchived(task, now)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
