export const API_VERSION = 'weaver.v1' as const;
export interface CommandRequest { apiVersion: typeof API_VERSION; commandId?: string; command: string; args: Record<string, unknown> }
export interface CommandResponse { apiVersion: typeof API_VERSION; commandId?: string; ok: boolean; data?: unknown; error?: {code:string;message:string;retryable:boolean} }
export interface LogicalOwner {id:string;name:string;profileId:string;mode:'mock'|'manual';state:'ready'|'attached';createdAt:string;host?:unknown;messages?:import('../main/adapters/logical').OwnerMessage[]}
export interface WorkPackage {id:string;taskId:string;revision:number;instruction:string;scope:string[];acceptanceCriteria:string[];createdAt:string}
export interface CommandReceipt {hash:string;response?:CommandResponse}
/** The one step an owner takes after dispatch, so it never has to understand engines:
 * real, mock and not-yet-admitted work is polled; native work is the owner's own subagent call. */
export type DispatchNext =
 | {action:'wait';command:string}
 | {action:'run_subagent';model:string;effort:string;prompt:string;then:string}
