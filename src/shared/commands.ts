export const API_VERSION = 'weaver.v1' as const;
export interface CommandRequest { apiVersion: typeof API_VERSION; commandId?: string; command: string; args: Record<string, unknown> }
export interface CommandResponse { apiVersion: typeof API_VERSION; commandId?: string; ok: boolean; data?: unknown; error?: {code:string;message:string;retryable:boolean} }
export interface LogicalOwner {id:string;name:string;profileId:string;mode:'mock'|'manual';state:'ready'|'attached';createdAt:string;host?:unknown;messages?:import('../main/adapters/logical').OwnerMessage[]}
export interface WorkPackage {id:string;taskId:string;revision:number;instruction:string;scope:string[];acceptanceCriteria:string[];createdAt:string}
export interface CommandReceipt {hash:string;response?:CommandResponse}
