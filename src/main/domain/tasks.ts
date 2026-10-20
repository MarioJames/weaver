import { randomUUID } from 'node:crypto';
import type { LogicalOwner } from '../../shared/contracts/owners';
import type { Task, TaskEvent } from '../../shared/contracts/tasks';

export const active = (task: Task) => task.status === 'running' || task.status === 'cancelling';
/** Slots belong to the exact owner instance a task is bound to; unbound work shares only its own profile group. */
const instanceGroup = (ownerId: string) => `instance:${ownerId}`;
const profileGroup = (profile: string) => `profile:${profile}`;
export const slotGroupOf = (task: Pick<Task, 'ownerId' | 'dispatch'>): string | undefined => task.ownerId ? instanceGroup(task.ownerId) : task.dispatch ? profileGroup(task.dispatch.owner) : undefined;
/** The group new work competes in: its own instance when bound, otherwise the profile group of unbound work. */
export const slotGroupFor = (ownerId: string | undefined, profile: string) => ownerId ? instanceGroup(ownerId) : profileGroup(profile);
/** Running and cancelling tasks already holding a slot of the same owner instance. */
export const slotGroupCount = (tasks: Task[], group: string | undefined): number => group === undefined ? 0 : tasks.reduce((held, task) => held + (active(task) && task.executionRole!=='owner' && slotGroupOf(task) === group ? 1 : 0), 0);
/** Whose slots these are, in the words an owner reads when a dispatch has to wait. */
export const slotGroupName = (owners: LogicalOwner[], ownerId: string | undefined, profile: string): string => {
 const instance = ownerId ? owners.find(owner => owner.id === ownerId) : undefined;
 return instance ? `Owner instance ${instance.name} of profile ${profile}` : `Owner ${profile}`;
};
export function event(task: Task, kind: TaskEvent['kind'], message: string): void {
 const at = new Date().toISOString(); task.updatedAt = at;
 task.events.push({id:randomUUID(), at, kind, message});
 if (task.events.length > 500) task.events.splice(0, task.events.length - 500);
}
