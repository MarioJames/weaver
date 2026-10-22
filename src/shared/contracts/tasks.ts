import type { ContextPack, ContinuationPolicy, HandoffRecord } from './continuation';

export type RealEngineKind = 'opencode' | 'pi' | 'grok' | 'codex' | 'qodercli' | 'dsh';

/** Vendor facts actually present on the event stream. Absent fields stay unknown. */
export interface CliAgentEvidence {
  engine: RealEngineKind;
  requestedModel: string;
  requestedEffort: string;
  workspace: string;
  role?: 'worker' | 'owner';
  vendorSessionId?: string;
  /** The private prompt file this run was started from (under agent-state). */
  promptPath?: string;
  /** Pi only: the session directory created for this run. */
  sessionDir?: string;
  vendorModel?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  terminal: 'pending' | 'success' | 'error' | 'cancelled' | 'missing' | 'truncated';
}

export type TaskStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type AgentStatus = 'idle' | 'running' | 'stopping' | 'stopped';
export interface OwnerRef { name: string; transport: 'herdr-visible'; session: string; pane: string }
export interface TaskInput { workspace?: string; acceptanceCriteria?: string[]; constraints?: string[]; title?: string; instruction: string; owner: OwnerRef }
export interface Artifact { id: string; name: string; mediaType: 'text/plain' | 'text/markdown' | 'application/json'; content: string; createdAt: string }
export interface TaskEvent { id: string; at: string; kind: 'lifecycle' | 'log' | 'progress' | 'artifact' | 'result' | 'error'; message: string }
export interface TaskOwnerHost { kind: 'herdr'; session: string; workspaceId: string; paneId: string; /** Exact tab of this host; absent on records created before tab-level launch/cleanup existed. */ tabId?: string; /** True only when this launch created the workspace; false/absent means an existing workspace was reused. */ createdWorkspace?: boolean; agentName: string; launchedAt: string }
export interface TaskDispatch {
  owner: string; worker: string; engine: string; model: string; effort: string;
  /** native: the owner runs this same-engine worker with its built-in subagent tool; no process is launched. */
  execution: 'real' | 'mock' | 'native'; maxParallel: number; maxWaitMinutes?: number;
  adapter?: string; workspace?: string; engineKind?: string; workspaceIdentity?: string;
}
export interface AgentRun {
  id: string; adapter: string; execution?: 'real' | 'mock' | 'native'; status: AgentStatus;
  engine?: string; model?: string; effort?: string; workspace?: string;
  scopeUnit?: string; evidence?: CliAgentEvidence;
  pid?: number; firstOutputAt?: string; startedAt?: string; endedAt?: string; exitCode?: number | null;
  /** Startup permission commit time: absent means the run is still preparing and never allowed to spawn. */
  launchPermittedAt?: string;
  /** Scope attribution: the systemd InvocationID persisted once the identity event lands. */
  scopeInvocation?: string;
  /** Service-side only log/exit locations under stateDir. */
  stateDir?: string;
  logs?: { stdout: string; stderr: string; exit: string; exitTmp?: string };
  /** Pre-spawn fstat of the log files; the anchor for FD-based attribution. */
  logIdentity?: { stdout: { dev: number; ino: number }; stderr: { dev: number; ino: number } };
  /** 32hex binding for the exit file and FD evidence. */
  nonce?: string;
  /** Committed replay cursor: byte offsets plus the applied normalized-record count. */
  replay?: { stdoutOffset: number; stderrOffset: number; appliedRecords: number };
  /** Finish-batch commit time: the idempotency mark that skips finish replay on reattach. */
  finalizedAt?: string;
  /** Absolute termination deadline fixed at the first termination request; never extended on restart. */
  killAfter?: string;
  /** Termination stage, only moves forward. */
  terminationPhase?: 'term' | 'kill';
  cancelRequestedAt?: string;
  cancelSignal?: string;
  /** Absolute no-output deadline (startedAt + 120s); not renewed across restarts. */
  noOutputDeadline?: string;
  vendorError?: string;
  retryAt?: string;
  stderrTail?: string;
  resultSummary?: string;
  logTruncated?: boolean;
  /** Recovery-pending marker, visible to UI/CLI with a reason. */
  recovery?: { state: 'pending'; reason: string; since: string };
}
export interface TaskFailure { kind: 'early_exit'|'no_output'|'rate_limit'|'quota'|'auth'|'vendor'|'cancelled'|'other'|'unknown_outcome'; message: string; exitCode?: number; stderrTail?: string; vendorError?: string; retryAt?: string }
export interface Task extends TaskInput { executionRole?: 'owner'; parentTaskId?: string; title: string; failure?: TaskFailure; ownerEpoch?: number; ownerLastActivityAt?: string; continuationPolicy?: ContinuationPolicy; continuationHistory?: HandoffRecord[]; contextPack?: ContextPack; ownerHost?: TaskOwnerHost; revision?: number; scheduled?: boolean; queueReason?: { code: 'waiting_for_capacity' | 'policy_blocked' | 'frozen_route_changed' | 'workspace_changed' | 'launch_blocked'; message: string }; retryOf?: string; ownerId?: string; packageId?: string; acknowledged?: boolean; reviewState?: 'pending' | 'accepted' | 'rejected'; reviewComment?: string; /** Design-change replacement: the sibling child (same parentTaskId) that takes over this cancelled task. */ supersededBy?: string; /** Why the superseding sibling takes over (1–500 chars). */ supersededReason?: string; dispatch?: TaskDispatch; id: string; createdAt: string; updatedAt: string; status: TaskStatus; progress: number; events: TaskEvent[]; artifacts: Artifact[]; run?: AgentRun; summary?: string }
export type WorkerRecord =
 | { type: 'log'; message: string }
 | { type: 'progress'; percent: number; message: string }
 | { type: 'artifact'; name: string; mediaType: Artifact['mediaType']; content: string }
 | { type: 'result'; summary: string };
/** List preview only: events are the last three retained records, artifacts have no body. */
export type TaskSummary = Omit<Task, 'artifacts'> & { eventCount: number; artifacts: Omit<Artifact, 'content'>[] };
export interface Capabilities { worker: string; owner: string; maxParallel: number; storePath: string }
export interface WorkPackage {id:string;taskId:string;revision:number;instruction:string;scope:string[];acceptanceCriteria:string[];createdAt:string}
