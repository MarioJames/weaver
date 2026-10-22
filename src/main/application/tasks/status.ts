import type { TaskStatus } from '../../../shared/contracts/tasks';
import { fail } from '../commands/errors';
import type { CommandArgs } from '../commands/types';

/** The complete status set tasks.list accepts, in the order the error message lists it. */
export const TASK_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'];

const ALLOWED = `Allowed statuses: ${TASK_STATUSES.join(', ')}`;

/** tasks.list status is one TaskStatus or a non-empty TaskStatus array; duplicates are dropped in request order. */
export function taskStatusFilter(args: CommandArgs): TaskStatus[] | undefined {
  const raw = args.status;
  if (raw === undefined) return undefined;
  const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : fail('INVALID_ARGUMENT', `status for tasks.list must be a task status string or a non-empty array of task status strings. ${ALLOWED}`);
  if (values.length === 0) fail('INVALID_ARGUMENT', `status for tasks.list must not be empty. ${ALLOWED}`);
  const statuses: TaskStatus[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') fail('INVALID_ARGUMENT', `status for tasks.list must contain non-empty task status strings. ${ALLOWED}`);
    if (!TASK_STATUSES.includes(value as TaskStatus)) fail('INVALID_ARGUMENT', `Unknown status "${value as string}" for tasks.list. ${ALLOWED}`);
    if (!statuses.includes(value as TaskStatus)) statuses.push(value as TaskStatus);
  }
  return statuses;
}
