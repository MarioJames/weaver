import type { ImportChannelsResult, ChannelsSnapshot, ChannelLogin, ChannelLoginRef, StartChannelLoginInput, SubmitChannelLoginCodeInput, SaveChannelResult, RefreshChannelQuotaInput, SaveChannelInput, DeleteChannelInput, ImportChannelsInput } from './channels';
import type { EngineCleanupInput, EngineCleanupJob } from './engine-cleanup';
import type { ImSettingsSnapshot, SaveImSettingsInput } from './im';
import type { PolicySnapshot, SavePolicyInput, PreviewInput, RoutePreview, Issue } from './policy';
import type { EngineProbeRecord, EngineReadiness, ExecutionBoundary, HelloInput, HelloJob } from '../engines';
import type { QuotaRefreshInput, QuotaRefreshResult, QuotaSnapshot } from './quota';
import type { CommandRequest, CommandResponse } from './commands';
import type { Capabilities, Task, TaskInput, TaskSummary } from './tasks';

export interface EngineScan { probedAt: string; probes: EngineProbeRecord[]; readiness: EngineReadiness[]; boundary: ExecutionBoundary }
export interface WeaverAPI {
 refreshChannelQuota(input: RefreshChannelQuotaInput): Promise<ChannelsSnapshot>;
 getChannels(): Promise<ChannelsSnapshot>;
 saveChannel(input: SaveChannelInput): Promise<SaveChannelResult>;
 startChannelLogin(input: StartChannelLoginInput): Promise<ChannelLogin>;
 getChannelLogin(input: ChannelLoginRef): Promise<ChannelLogin>;
 submitChannelLoginCode(input: SubmitChannelLoginCodeInput): Promise<ChannelLogin>;
 cancelChannelLogin(input: ChannelLoginRef): Promise<ChannelLogin>;
 deleteChannel(input: DeleteChannelInput): Promise<ChannelsSnapshot>;
 importChannels(input: ImportChannelsInput): Promise<ImportChannelsResult>;
 getImSettings(): Promise<ImSettingsSnapshot>;
 saveImSettings(input: SaveImSettingsInput): Promise<ImSettingsSnapshot>;
 reconnectIm(): Promise<ImSettingsSnapshot>;
 command(request: CommandRequest): Promise<CommandResponse>;
 getPolicy(): Promise<PolicySnapshot>;
 validatePolicy(config: unknown): Promise<Issue[]>;
 savePolicy(input: SavePolicyInput): Promise<PolicySnapshot>;
 previewRoute(input: PreviewInput): Promise<RoutePreview>;
 scanEngines(): Promise<EngineScan>;
 getQuota(): Promise<QuotaSnapshot>;
 refreshQuota(input: QuotaRefreshInput): Promise<QuotaRefreshResult>;
 startEngineCleanup(input: EngineCleanupInput): Promise<EngineCleanupJob>;
 getEngineCleanup(id: string): Promise<EngineCleanupJob | null>;
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
