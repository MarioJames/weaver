import type { PolicySnapshot, SavePolicyInput, PreviewInput, RoutePreview, Issue } from "./policy";
import type { EngineProbeRecord, EngineReadiness, ExecutionBoundary } from "./engines";
import type { QuotaRefreshInput, QuotaRefreshResult, QuotaSnapshot } from './quota';
export type { EngineProbeRecord, EngineReadiness };
export interface EngineScan { probedAt: string; probes: EngineProbeRecord[]; readiness: EngineReadiness[]; boundary: ExecutionBoundary }
export interface EngineToggleInput { id: string; enabled: boolean; revision: number }
export interface EngineToggleResult { snapshot: PolicySnapshot; probe: EngineProbeRecord | null; readiness: EngineReadiness[] }
export type TaskStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type AgentStatus = 'idle' | 'running' | 'stopping' | 'stopped';
export interface OwnerRef { name: string; transport: 'herdr-visible'; session: string; pane: string }
export interface TaskInput { workspace?: string; acceptanceCriteria?: string[]; constraints?: string[]; title?: string; instruction: string; owner: OwnerRef }
export interface Artifact { id: string; name: string; mediaType: 'text/plain' | 'text/markdown' | 'application/json'; content: string; createdAt: string }
export interface TaskEvent { id: string; at: string; kind: 'lifecycle' | 'log' | 'progress' | 'artifact' | 'result' | 'error'; message: string }
export interface TaskOwnerHost { kind: 'herdr'; session: string; workspaceId: string; paneId: string; agentName: string; launchedAt: string }
export interface TaskDispatch {
  proxy?: string;
  owner: string; worker: string; engine: string; model: string; effort: string;
  /** native: the owner runs this same-engine worker with its built-in subagent tool; no process is launched. */
  execution: 'real' | 'mock' | 'native'; maxParallel: number; maxWaitMinutes?: number;
  adapter?: string; workspace?: string; engineKind?: string; workspaceIdentity?: string;
}
export interface AgentRun {
  id: string; adapter: string; execution?: 'real' | 'mock' | 'native'; status: AgentStatus;
  engine?: string; model?: string; effort?: string; workspace?: string; timeoutMs?: number;
  scopeUnit?: string; evidence?: import('../main/adapters/cli/types').CliAgentEvidence;
  pid?: number; firstOutputAt?: string; startedAt?: string; endedAt?: string; exitCode?: number | null;
}
export interface TaskFailure { kind: 'early_exit'|'no_output'|'rate_limit'|'quota'|'auth'|'vendor'|'cancelled'|'other'; message: string; exitCode?: number; stderrTail?: string; vendorError?: string; retryAt?: string }
export interface Task extends TaskInput { executionRole?: 'owner'; parentTaskId?: string; title: string; failure?: TaskFailure; ownerEpoch?: number; ownerLastActivityAt?: string; continuationPolicy?: import('../main/continuation').ContinuationPolicy; continuationHistory?: import('../main/continuation').HandoffRecord[]; contextPack?: import('../main/continuation').ContextPack; ownerHost?: TaskOwnerHost; revision?: number; scheduled?: boolean; queueReason?: { code: 'waiting_for_capacity' | 'policy_blocked' | 'frozen_route_changed' | 'workspace_changed' | 'launch_blocked'; message: string }; retryOf?: string; ownerId?: string; packageId?: string; acknowledged?: boolean; reviewState?: 'pending' | 'accepted' | 'rejected'; reviewComment?: string; dispatch?: TaskDispatch; id: string; createdAt: string; updatedAt: string; status: TaskStatus; progress: number; events: TaskEvent[]; artifacts: Artifact[]; run?: AgentRun; summary?: string }
export type WorkerRecord =
 | { type: 'log'; message: string }
 | { type: 'progress'; percent: number; message: string }
 | { type: 'artifact'; name: string; mediaType: Artifact['mediaType']; content: string }
 | { type: 'result'; summary: string };
/** List preview only: events are the last three retained records, artifacts have no body. */
export type TaskSummary = Omit<Task, 'artifacts'> & { eventCount: number; artifacts: Omit<Artifact, 'content'>[] };
export interface Capabilities { worker: string; owner: string; maxParallel: number; storePath: string }
export interface WeaverAPI {
 command(request: import('./commands').CommandRequest): Promise<import('./commands').CommandResponse>;
 getPolicy(): Promise<PolicySnapshot>;
 validatePolicy(config: unknown): Promise<Issue[]>;
 savePolicy(input: SavePolicyInput): Promise<PolicySnapshot>;
 previewRoute(input: PreviewInput): Promise<RoutePreview>;
 scanEngines(): Promise<EngineScan>;
 getQuota(): Promise<QuotaSnapshot>;
 refreshQuota(input: QuotaRefreshInput): Promise<QuotaRefreshResult>;
 setEngineEnabled(input: EngineToggleInput): Promise<EngineToggleResult>;
 sayHi(input: import('./engines').HelloInput): Promise<import('./engines').HelloJob>;
 sayHiResult(id: string): Promise<import('./engines').HelloJob>;
 listTasks(): Promise<TaskSummary[]>;
 getTask(id: string): Promise<Task>;
 createTask(input: TaskInput): Promise<Task>;
 startTask(id: string): Promise<Task>;
 cancelTask(id: string): Promise<Task>;
 capabilities(): Promise<Capabilities>;
 onTasksChanged(callback: () => void): () => void;
}
