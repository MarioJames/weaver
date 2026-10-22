/** A validation finding: where in the document and what is wrong. */
export interface Issue { path: string; message: string }
export interface Engine { enabled: boolean; kind: string; quota_refresh?: boolean }
export interface QuotaSettings { auto_refresh: boolean; interval_minutes: number }
/** Scheduled live probes of free_channel workers; missing means enabled every 10 minutes. */
export interface FreeChannelProbeSettings { enabled: boolean; interval_minutes: number }
export interface Owner { enabled: boolean; engine: string; model: string; effort: string; workers: string[]; max_parallel: number; worker_weights?: Record<string, number> }
export interface Worker { free_channel?: boolean; enabled: boolean; engine: string; model: string; effort: string; description?: string; /** Cap on tasks this worker runs at once across every owner; missing means no cap. */ max_parallel?: number }
export interface Herdr { max_wait_minutes: number }
/** Rendering preferences; missing means follow the browser. */
export interface Display { timezone?: string }
export interface Config { version: 1; chatgpt_review?: boolean; quota?: QuotaSettings; free_channel_probe?: FreeChannelProbeSettings; display?: Display; engines: Record<string, Engine>; owners: Record<string, Owner>; workers: Record<string, Worker>; herdr: Herdr }
/** A block with `worker` keeps only that worker out; without it the block covers the whole engine (or one model of it). */
export interface Block { engine: string; model?: string; worker?: string; reason: string; since: string; release_at?: string; by?: string }
export interface State { version: 1; blocks: Block[] }
export interface Availability { status: "available" | "disabled" | "engine_disabled" | "blocked"; engine?: string; model?: string; worker?: string; reason?: string; release_at?: string }
export interface Dispatch {
 owner: string; worker: string; engine: string; model: string; effort: string;
 execution: 'disabled'; dispatch: 'preview'; warnings: string[];
 selected_by?: 'worker' | 'weight'; skipped?: {worker:string; reason:string}[];
 /** Effective weight of the selected worker. Omitted config means 5. */
 weight?: number;
 /** Dispatchable workers in the order they would be chosen, with the running count the choice used. */
 candidates?: {worker:string; weight:number; running:number}[];
 /** The chosen worker's concurrency cap and the running count the choice used; present only when that worker carries a max_parallel. */
 workerCapacity?: {running:number; limit:number};
}
export interface RouteOptions { owner: string; worker?: string; /** Running tasks per worker, across all owners. */ workerLoad?: Record<string, number>; /** Engines whose attempt already failed or was cancelled earlier in this task's retry chain, or an engine vendor block being rerouted. */ excludeEngines?: string[]; /** Workers excluded for this dispatch: failed attempts in a retry chain, or the one a queued task was frozen to before it was blocked. */ excludeWorkers?: string[] }
export interface PolicySnapshot {
 revision: number; config: Config; blocks: Block[]; activeBlocks: Block[];
 owners: Record<string, Availability>; workers: Record<string, Availability>;
 execution: 'disabled';
}
export interface SavePolicyInput { revision: number; config: Config; blocks: Block[] }
export interface PreviewInput extends RouteOptions { runningCount?: number }
export interface RoutePreview extends Dispatch { maxParallel: number; capacityAvailable: boolean; chatgptReview: boolean }
