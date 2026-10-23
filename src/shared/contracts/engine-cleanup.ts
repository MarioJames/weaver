export interface EngineCleanupOptions { engine: 'opencode'; keepDays: number; pruneEvents: boolean; eventIdleMinutes: number; vacuum: boolean }
export type EngineCleanupInput = EngineCleanupOptions & { mode: 'preview' | 'apply'; previewId?: string };
export interface CleanupReport {
 status: 'preview' | 'applied'; cutoff: string; keepDays: number; selection: string;
 eventPruning: { enabled: boolean; idleMinutes: number; idleCutoff: string; candidateSessions: number; candidateEvents: number };
 expiredIds: string[]; retainedCount: number; before: Record<string, number>; after: Record<string, number>; deleted: Record<string, number>;
 retained: Record<string, number>; bytesBefore: Record<string, number>; bytesAfter: Record<string, number>; vacuum: string;
}
export type CleanupResult = CleanupReport | { status: 'skipped'; reason: string; pid?: number; lock?: string } | { status: 'error'; error: string };
export interface EngineCleanupJob { id: string; status: 'running' | 'done'; startedAt: string; input: EngineCleanupInput; progress: string; result?: CleanupResult }
