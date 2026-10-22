import { LocalIPCError } from '../main/local-ipc';

/** The CLI accepts the same TaskStatus names as the server; tests keep this list in sync with the application contract. */
export const CLI_TASK_STATUSES = ['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'] as const;

const ALLOWED = `Allowed statuses: ${CLI_TASK_STATUSES.join(', ')}`;

/** Split one --status value, drop blank entries, reject unknown names and deduplicate in request order. */
export function parseTaskStatusList(value: string): string[] {
  const statuses = value.split(',').map(status => status.trim()).filter(Boolean);
  if (!statuses.length) throw new LocalIPCError('INVALID_ARGUMENT', `--status must list at least one status. ${ALLOWED}`);
  const unknown = statuses.find(status => !CLI_TASK_STATUSES.includes(status as typeof CLI_TASK_STATUSES[number]));
  if (unknown !== undefined) throw new LocalIPCError('INVALID_ARGUMENT', `Unknown status "${unknown}" for --status. ${ALLOWED}`);
  return [...new Set(statuses)];
}
