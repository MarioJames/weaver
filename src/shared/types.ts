import type { PolicySnapshot, SavePolicyInput, PreviewInput, RoutePreview, Issue } from "./policy";
export type TaskStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type AgentStatus = 'idle' | 'running' | 'stopping' | 'stopped';
export interface OwnerRef { name: string; transport: 'herdr-visible'; session: string; pane: string }
export interface TaskInput { workspace?: string; acceptanceCriteria?: string[]; constraints?: string[]; title: string; instruction: string; owner: OwnerRef }
export interface Artifact { id: string; name: string; mediaType: 'text/plain' | 'text/markdown' | 'application/json'; content: string; createdAt: string }
export interface TaskEvent { id: string; at: string; kind: 'lifecycle' | 'log' | 'progress' | 'artifact' | 'result' | 'error'; message: string }
export interface AgentRun { id: string; adapter: 'mock-jsonl'; status: AgentStatus; pid?: number; startedAt?: string; endedAt?: string; exitCode?: number | null }
export interface Task extends TaskInput { ownerEpoch?: number; ownerLastActivityAt?: string; continuationPolicy?: import('../main/continuation').ContinuationPolicy; continuationHistory?: import('../main/continuation').HandoffRecord[]; contextPack?: import('../main/continuation').ContextPack; revision?: number; scheduled?: boolean; retryOf?: string; ownerId?: string; packageId?: string; acknowledged?: boolean; reviewState?: 'pending' | 'accepted' | 'rejected'; reviewComment?: string; dispatch?: {owner:string;worker:string;engine:string;model:string;effort:string;execution:'mock';maxParallel:number}; id: string; createdAt: string; updatedAt: string; status: TaskStatus; progress: number; events: TaskEvent[]; artifacts: Artifact[]; run?: AgentRun; summary?: string }
export type WorkerRecord =
 | { type: 'log'; message: string }
 | { type: 'progress'; percent: number; message: string }
 | { type: 'artifact'; name: string; mediaType: Artifact['mediaType']; content: string }
 | { type: 'result'; summary: string };
export interface Capabilities { worker: string; owner: string; maxParallel: number; storePath: string }
export interface WeaverAPI {
 command(request: import('./commands').CommandRequest): Promise<import('./commands').CommandResponse>;
 getPolicy(): Promise<PolicySnapshot>;
 validatePolicy(config: unknown): Promise<Issue[]>;
 savePolicy(input: SavePolicyInput): Promise<PolicySnapshot>;
 previewRoute(input: PreviewInput): Promise<RoutePreview>;
 listTasks(): Promise<Task[]>;
 createTask(input: TaskInput): Promise<Task>;
 importTask(): Promise<Task | null>;
 startTask(id: string): Promise<Task>;
 cancelTask(id: string): Promise<Task>;
 capabilities(): Promise<Capabilities>;
 onTasksChanged(callback: () => void): () => void;
}
