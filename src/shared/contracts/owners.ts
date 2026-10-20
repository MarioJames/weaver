/** A message a registered owner instance has been sent or delivered a result through. */
export interface OwnerMessage {
 id: string;
 ownerId: string;
 kind: 'message' | 'result';
 message?: string;
 taskId?: string;
 manifestDigest?: string;
 transport: 'mock-memory';
 status: 'delivered' | 'acknowledged';
 createdAt: string;
 acknowledgedAt?: string;
}
export interface LogicalOwner {id:string;name:string;profileId:string;/** The caller's own label for the session that registered this instance: reference metadata, never a verified vendor session. */session?:string;mode:'mock'|'manual';state:'ready'|'attached';createdAt:string;host?:unknown;messages?:OwnerMessage[]}
/** What makes one owner session instance. The profile alone is only the policy role it runs in. */
export interface OwnerInstanceKey {profileId:string;name:string;session:string}
/** A registered instance as the control plane reports it: its identity and how much of it is already busy. */
export interface OwnerInstance extends LogicalOwner {runningTaskCount:number}
