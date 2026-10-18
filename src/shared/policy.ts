import type { Config, Block, Availability, Dispatch, RouteOptions } from '../main/policy/routing';
import type { Issue } from '../main/policy/json-schema';
export type { Config, Block, Dispatch, RouteOptions, Issue };
export interface PolicySnapshot {
 revision: number; config: Config; blocks: Block[]; activeBlocks: Block[];
 owners: Record<string, Availability>; workers: Record<string, Availability>;
 execution: 'disabled';
}
export interface SavePolicyInput { revision: number; config: Config; blocks: Block[] }
export interface PreviewInput extends RouteOptions { runningCount?: number }
export interface RoutePreview extends Dispatch { maxParallel: number; capacityAvailable: boolean; chatgptReview: boolean }
