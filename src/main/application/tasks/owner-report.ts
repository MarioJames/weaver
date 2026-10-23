import type { RootTaskOverview, Task, TaskOverview, TaskStatus } from '../../../shared/contracts/tasks';
import { REDACTED, redactSecrets } from '../../../shared/redact';
import { fail } from '../commands/errors';
import type { TaskStore } from '../../store';

export interface OverviewOptions {
  ownerId?: string;
  staleAfterSeconds?: number;
  now?: number;
}

const CHILD_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'];
const ERROR_FALLBACK_MAX = 500;

/**
 * Matches CLI space forms redactSecrets does not cover: `--token <v>`, `--api-key=<v>`,
 * `--password "a b"` (quotes may span newlines), `--secret-key <v>`, and a flag/value
 * split across a newline. No word boundary after the flag on purpose: cleaning strips
 * controls first, so `--token\x00VALUE` becomes `--tokenVALUE`; the value must still be masked.
 */
const CLI_FLAG_VALUE =
  /--(token|api[-_]?key|password|passwd|secret(?:[-_]?key)?|access[-_]?key(?:[-_]?id)?|auth[-_]?token|client[-_]?secret|private[-_]?key)(\s*(?:[=:]\s*)?)((?:"[^"]*"?|'[^']*'?|[^\s]+))/gi;

/** Mask CLI `--flag value` credential forms on top of the shared key=value/Bearer/URL/token rules. Idempotent. */
export function redactReportSecrets(value: string): string {
  return redactSecrets(value).replace(
    CLI_FLAG_VALUE,
    (_match, flag: string, sep: string, val: string) => {
      const quote = val[0];
      const masked = quote === '"' || quote === "'" ? `${quote}${REDACTED}${quote}` : REDACTED;
      return `--${flag}${sep}${masked}`;
    },
  );
}

/** Strip C0 controls except tab/LF/CR, plus DEL and C1. Call BEFORE redaction so controls cannot split a sensitive key/flag to evade masking. */
export function stripReportControls(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, '');
}

function boundErrorText(value: string): string {
  const line = redactReportSecrets(stripReportControls(value)).replace(/\s+/g, ' ').trim();
  if (!line) return '';
  return line.length > ERROR_FALLBACK_MAX ? `${line.slice(0, ERROR_FALLBACK_MAX - 1)}…` : line;
}

/** Latest error for the overview: the failure message wins so a newer non-error event never hides an older error. */
function lastErrorOf(task: Task): string | null {
  const failure = typeof task.failure?.message === 'string' ? boundErrorText(task.failure.message) : '';
  if (failure) return failure;
  for (let i = task.events.length - 1; i >= 0; i--) {
    const item = task.events[i]!;
    if (item.kind !== 'error' || typeof item.message !== 'string') continue;
    const cleaned = boundErrorText(item.message);
    if (cleaned) return cleaned;
  }
  return null;
}

/**
 * Global running-root overview shared by tasks.overview and Bot.
 * Reads committed store state only. Roots are running executionRole=owner tasks without parentTaskId.
 * Child counts are literal direct-child status counts (retry history included via the same parentTaskId).
 */
export function buildTaskOverview(store: TaskStore, options: OverviewOptions = {}): TaskOverview {
  const staleAfterSeconds = options.staleAfterSeconds ?? 900;
  if (!Number.isInteger(staleAfterSeconds) || staleAfterSeconds < 0 || staleAfterSeconds > 86400) {
    fail('INVALID_REQUEST', 'staleAfterSeconds must be an integer between 0 and 86400');
  }
  if (options.ownerId !== undefined && typeof options.ownerId !== 'string') {
    fail('INVALID_REQUEST', 'Invalid owner ID: expected a UUID');
  }
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) fail('INVALID_REQUEST', 'Invalid overview timestamp');
  const generatedAt = new Date(now).toISOString();
  const heads = store.listHeadsCommitted();
  const roots = heads.filter(
    task => task.executionRole === 'owner' && task.parentTaskId === undefined && task.status === 'running' && (options.ownerId === undefined || task.ownerId === options.ownerId),
  );
  const byParent = new Map<string, Task[]>();
  for (const head of heads) {
    if (head.parentTaskId === undefined) continue;
    const list = byParent.get(head.parentTaskId) ?? [];
    list.push(head);
    byParent.set(head.parentTaskId, list);
  }
  const overviews: RootTaskOverview[] = roots.map(head => {
    const committed = store.getCommitted(head.id);
    const children = byParent.get(head.id) ?? [];
    const counts = { total: children.length, queued: 0, running: 0, cancelling: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const child of children) {
      if ((CHILD_STATUSES as readonly string[]).includes(child.status)) {
        counts[child.status as keyof Omit<typeof counts, 'total'>] += 1;
      }
    }
    const report = committed.ownerReport ?? null;
    let reportAgeSeconds: number | null = null;
    let reportStale = false;
    if (report) {
      const parsed = Date.parse(report.reportedAt);
      if (Number.isFinite(parsed)) {
        reportAgeSeconds = Math.max(0, Math.floor((now - parsed) / 1000));
        reportStale = reportAgeSeconds >= staleAfterSeconds;
      }
    }
    return {
      id: committed.id,
      title: committed.title,
      ownerId: committed.ownerId ?? null,
      status: committed.status,
      progress: committed.progress,
      ownerReport: report ? { ...report, blockers: [...report.blockers], nextSteps: [...report.nextSteps] } : null,
      reportAgeSeconds,
      reportStale,
      childCounts: counts,
      lastError: lastErrorOf(committed),
    };
  });
  return { generatedAt, staleAfterSeconds, roots: overviews };
}
