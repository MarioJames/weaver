import type { PolicySnapshot, SavePolicyInput, PreviewInput, RoutePreview, Issue } from './policy';
import type { EngineProbeRecord, EngineReadiness, ExecutionBoundary, HelloInput, HelloJob } from '../engines';
import type { QuotaRefreshInput, QuotaRefreshResult, QuotaSnapshot } from './quota';
import type { CommandRequest, CommandResponse } from './commands';
import type { Capabilities, Task, TaskInput, TaskSummary } from './tasks';

export interface EngineScan { probedAt: string; probes: EngineProbeRecord[]; readiness: EngineReadiness[]; boundary: ExecutionBoundary }
export interface EngineToggleInput { id: string; enabled: boolean; revision: number }
export interface EngineToggleResult { snapshot: PolicySnapshot; probe: EngineProbeRecord | null; readiness: EngineReadiness[] }
export interface WeaverAPI {
 command(request: CommandRequest): Promise<CommandResponse>;
 getPolicy(): Promise<PolicySnapshot>;
 validatePolicy(config: unknown): Promise<Issue[]>;
 savePolicy(input: SavePolicyInput): Promise<PolicySnapshot>;
 previewRoute(input: PreviewInput): Promise<RoutePreview>;
 scanEngines(): Promise<EngineScan>;
 getQuota(): Promise<QuotaSnapshot>;
 refreshQuota(input: QuotaRefreshInput): Promise<QuotaRefreshResult>;
 setEngineEnabled(input: EngineToggleInput): Promise<EngineToggleResult>;
 sayHi(input: HelloInput): Promise<HelloJob>;
 sayHiResult(id: string): Promise<HelloJob>;
 listTasks(): Promise<TaskSummary[]>;
 getTask(id: string): Promise<Task>;
 createTask(input: TaskInput): Promise<Task>;
 startTask(id: string): Promise<Task>;
 cancelTask(id: string): Promise<Task>;
 capabilities(): Promise<Capabilities>;
 onTasksChanged(callback: () => void): () => void;
}
