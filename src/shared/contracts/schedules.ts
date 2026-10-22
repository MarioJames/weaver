/** Shared contracts for scheduled tasks (owner-maintained frozen interface).
 * Static types only: no runtime imports, no scheduling or execution logic here.
 * All schedule operations go through the existing logical command layer
 * (window.weaver.command / weaver CLI); the command names live in ./commands. */

/** Interval schedules repeat every `seconds` (1..31536000); cron schedules accept
 * only 5- or 6-field expressions (never Date strings) with a valid IANA timezone. */
export type ScheduleTiming =
  | { mode: 'interval'; seconds: number }
  | { mode: 'cron'; expression: string; timezone: string };

/** Explicit shell command executed by the Weaver service's own OS shell
 * with the service account's permissions; it cannot invoke arbitrary builtin RPCs. */
export interface ScheduleScript { command: string; timeoutSeconds: number }

/** Which configured profile executes an Agent schedule. The role disambiguates profiles that share an id. */
export interface ScheduleExecutor { role: 'owner' | 'worker'; profileId: string }

/** Agent schedules run owner-coordinated or worker-direct depending on role: an owner profile coordinates
 * (and may dispatch workers), a worker profile executes directly.
 * The role selects the matching policy section; model and effort always come from that profile. */
export interface ScheduleAgent { goal: string; executor: ScheduleExecutor }

/** Payload for schedules.create; `builtin` is service-generated only and cannot be forged by callers. */
export interface ScheduleInput {
  name: string;
  kind: 'script' | 'agent';
  enabled?: boolean;
  timing: ScheduleTiming;
  workspace?: string;
  script?: ScheduleScript;
  agent?: ScheduleAgent;
}

/** A cancelled run is terminal like the other settled statuses. */
export type ScheduleRunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'skipped' | 'cancelled';

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  trigger: 'scheduled' | 'manual';
  status: ScheduleRunStatus;
  scheduledFor?: string;
  startedAt: string;
  finishedAt: string | null;
  /** Agent runs surface the underlying task id so lists can navigate to it. */
  taskId?: string;
  exitCode?: number | null;
  output: string;
  error?: string;
  truncated?: boolean;
}

/** Builtin schedules (currently quota.refresh) reuse existing services; their only
 * mutable fields are enabled/timing and they can never be deleted. */
export type ScheduleBuiltin = 'quota.refresh';

export interface ScheduleDefinition {
  id: string;
  name: string;
  kind: 'script' | 'agent';
  enabled: boolean;
  timing: ScheduleTiming;
  workspace?: string;
  script?: ScheduleScript;
  agent?: ScheduleAgent;
  builtin?: ScheduleBuiltin;
  revision: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  activeRunId?: string;
  lastRun?: ScheduleRun;
}
