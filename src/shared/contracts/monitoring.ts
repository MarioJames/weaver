import type { TaskFailure } from './tasks';


/** One live command process under a worker's CLI, as health reports it. argv-derived and redacted. */
export interface RunningCommand {
  pid: number;
  /** argv0 plus bounded arguments; credentials are redacted and environment is never read. */
  summary: string;
  startedAt: string;
  elapsedMs: number;
}

export type TaskHealthState = 'ended' | 'starting' | 'working' | 'waiting_model' | 'running_command' | 'stalled' | 'owner_starting' | 'owner_running';

/** The monitor's own reading of one running task: silence, CPU and any command it can prove is alive. */
export interface TaskHealth {
  taskId: string;
  state: TaskHealthState;
  taskStatus: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  engine: string | null;
  lastEventAt: string | null;
  silenceMs: number | null;
  cpuActive: boolean | null;
  cpuIdleMs: number | null;
  scopeUnit: string | null;
  /** Present while a live command process exists under the worker CLI. */
  runningCommand?: RunningCommand;
  /** command_timeout: a command has outlived herdr.max_command_minutes; Weaver only reports, it never kills it. */
  reason?: 'command_timeout';
  /** Owner roots only: how their sub-agents stand. */
  children?: { total: number; running: number; completed: number };
}

/** The answer of one light probe call. */
export interface ProbeOutcome { ok: boolean; ms: number; error?: string }

/** One line of the stall record: a trigger carries tasks, a probe carries its route and outcome, a recovery carries a message. Times are ISO strings on the wire. */
export interface StallHistoryRecord {
  engine: string;
  level: number;
  at: string;
  /** The ids this record still names, at most RECORD_TASKS_MAX of them. */
  tasks: string[];
  /** How many tasks the evidence really covered, when the list above had to stop early. */
  taskCount?: number;
  stalledMinutes?: number;
  probe?: ProbeOutcome;
  model?: string;
  effort?: string;
  message?: string;
}

export interface EngineStallStatus {
  level: number;
  lastTriggerAt: string | null;
  needsAttention: boolean;
  /** Effective stall block in force in the policy right now. */
  blocked: boolean;
  blockedUntil: string | null;
  nextProbeAt: string | null;
  probeSuccesses: number;
  history: StallHistoryRecord[];
}

export interface StallStatus {
  engines: Record<string, EngineStallStatus>;
  config: { stallMinutes: number; quorum: number; ladder: (number | null)[]; resetHours: number };
}

/** One free-channel history line: a probe with its answer and what the answer wrote into the policy. Times are ISO strings on the wire. */
export interface FreeProbeHistoryRecord {
  worker: string;
  engine: string;
  level: number;
  at: string;
  probe: ProbeOutcome;
  classification?: TaskFailure['kind'];
  block?: { by: string; reason: string; since: string; release_at?: string };
  message?: string;
}

/** stall: ladder without deadline; rate_limit: vendor ladder; quota: free-quota ban. null is healthy. */
export type FreeProbeMode = 'stall' | 'rate_limit' | 'quota' | null;

export interface FreeWorkerStatus {
  worker: string;
  engine: string;
  model: string;
  probed: boolean;
  level: number;
  mode: FreeProbeMode;
  needsAttention: boolean;
  lastTriggerAt: string | null;
  blockedUntil: string | null;
  nextProbeAt: string | null;
  probeSuccesses: number;
  /** What the policy right now answers for this worker's route, exactly as routing sees it. */
  availability: { status: string; reason?: string; release_at?: string };
  history: FreeProbeHistoryRecord[];
}

export interface FreeChannelStatus {
  schedule: { enabled: boolean; interval_minutes: number; lastRunAt: string | null; nextRunAt: string | null };
  workers: FreeWorkerStatus[];
}
