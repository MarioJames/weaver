import type { TaskStatus } from './tasks';

export interface ContinuationPolicy { idleRotationMinutes: number | null }
export interface ContextPack {
 version: 1; id: string; createdAt: string; taskId: string; ownerEpoch: number;
 goal: string; workspace: string | null; profile: string; constraints: string[];
 plan: string[]; decisions: string[];
 taskProgress: {status: TaskStatus; percent: number; summary: string | null};
 acceptedArtifacts: Array<{id: string; name: string; mediaType: string; sha256: string}>;
 pendingApprovals: string[];
 recentMessages: Array<{kind: string; at: string; message: string}>;
 baseReferences: {taskId: string; packageId: string | null; previousPackId: string | null};
 limitations: string[];
}
export interface HandoffRecord {
 id: string; at: string; reason: 'manual' | 'idle'; fromOwnerId: string; toOwnerId: string;
 fromProfileId: string; toProfileId: string; epoch: number; packId: string; acknowledgementId: string | null;
}
