import type { CleanupResult } from './contracts/engine-cleanup';
export function cutoffTime(now: number, keepDays: number): number;
export function cleanup(input: { db: string; keepDays?: number; apply?: boolean; vacuum?: boolean; pruneEvents?: boolean; eventIdleMinutes?: number; now?: number; expectedSelection?: string }): CleanupResult;
