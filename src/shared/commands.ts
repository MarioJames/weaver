export const API_VERSION = 'weaver.v1' as const;
export interface CommandRequest { apiVersion: typeof API_VERSION; commandId?: string; command: string; args: Record<string, unknown> }
export interface CommandResponse { apiVersion: typeof API_VERSION; commandId?: string; ok: boolean; data?: unknown; error?: {code:string;message:string;retryable:boolean} }
export interface LogicalOwner {id:string;name:string;profileId:string;/** The caller's own label for the session that registered this instance: reference metadata, never a verified vendor session. */session?:string;mode:'mock'|'manual';state:'ready'|'attached';createdAt:string;host?:unknown;messages?:import('../main/adapters/logical').OwnerMessage[]}
/** The session label of a manual instance: the durable field, or the host evidence of an instance registered before the field existed. */
export function ownerSession(owner: LogicalOwner): string | undefined {
 if(owner.session)return owner.session;
 const host=owner.host as {session?:unknown}|undefined;
 return typeof host?.session==='string'&&host.session?host.session:undefined;
}
/** What makes one owner session instance. The profile alone is only the policy role it runs in. */
export interface OwnerInstanceKey {profileId:string;name:string;session:string}
export function sameOwnerInstance(owner: LogicalOwner, key: OwnerInstanceKey): boolean {
 return owner.mode==='manual'&&owner.profileId===key.profileId&&owner.name===key.name&&ownerSession(owner)===key.session;
}
/** A registered instance as the control plane reports it: its identity and how much of it is already busy. */
export interface OwnerInstance extends LogicalOwner {runningTaskCount:number}
export interface WorkPackage {id:string;taskId:string;revision:number;instruction:string;scope:string[];acceptanceCriteria:string[];createdAt:string}
export interface CommandReceipt {hash:string;response?:CommandResponse}
/** The one step an owner takes after dispatch, so it never has to understand engines:
 * real, mock and not-yet-admitted work is polled; native work is the owner's own subagent call. */
export type DispatchNext =
 | {action:'wait';command:string}
 | {action:'run_subagent';model:string;effort:string;prompt:string;then:string}
