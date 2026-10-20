import type { LogicalOwner, OwnerInstanceKey } from '../contracts/owners';

/** The session label of a manual instance: the durable field, or the host evidence of an instance registered before the field existed. */
export function ownerSession(owner: LogicalOwner): string | undefined {
 if(owner.session)return owner.session;
 const host=owner.host as {session?:unknown}|undefined;
 return typeof host?.session==='string'&&host.session?host.session:undefined;
}
export function sameOwnerInstance(owner: LogicalOwner, key: OwnerInstanceKey): boolean {
 return owner.mode==='manual'&&owner.profileId===key.profileId&&owner.name===key.name&&ownerSession(owner)===key.session;
}
