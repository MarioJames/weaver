export const API_VERSION = 'weaver.v1' as const;
/** The credential context a CLI sends after reading the private owner file; an authenticated request never falls back to the local administrator. */
export interface OwnerAuth { ownerId:string; token:string }
export interface CommandRequest { apiVersion: typeof API_VERSION; commandId?: string; command: string; args: Record<string, unknown>; ownerAuth?: OwnerAuth }
export interface CommandResponse { apiVersion: typeof API_VERSION; commandId?: string; ok: boolean; data?: unknown; error?: {code:string;message:string;retryable:boolean} }
export interface CommandReceipt {hash:string;response?:CommandResponse}
/** The one step an owner takes after dispatch, so it never has to understand engines:
 * real, mock and not-yet-admitted work is polled; native work is the owner's own subagent call. */
export type DispatchNext =
 | {action:'wait';command:string}
 | {action:'run_subagent';model:string;effort:string;prompt:string;then:string}

/** Logical commands that change state; each needs a commandId and returns a receipt. */
export const WRITE_COMMANDS = ['owners.attach','owners.spawn','owners.describe','owners.switch','owners.launch','owners.continuation.configure','tasks.create','tasks.start','tasks.followup','tasks.update','tasks.complete','tasks.describe','tasks.retry','tasks.cancel','packages.create','workers.spawn','workers.complete','results.deliver','results.ack','reviews.submit','engines.unblock','workers.unblock','schedules.create','schedules.update','schedules.enable','schedules.disable','schedules.delete','schedules.run','schedules.cancel'] as const;
/** Logical commands that only read. */
export const READ_COMMANDS = ['workspaces.list','capabilities.get','sync.snapshot','sync.status','owners.list','owners.get','owners.continuation.get','tasks.get','tasks.list','tasks.events','tasks.results','tasks.health','artifacts.read','packages.get','operations.get','observability.get','observability.export','engines.health','engines.penalty','schedules.list','schedules.get','schedules.runs'] as const;
/** CLI-only polling commands built on tasks.get, tasks.events and tasks.health; the server has no command for them. */
export const POLL_COMMANDS = ['tasks.wait', 'tasks.watch'] as const;
export type WriteCommand = typeof WRITE_COMMANDS[number];
export type ReadCommand = typeof READ_COMMANDS[number];
export type LogicalCommand = WriteCommand | ReadCommand;
const writes: ReadonlySet<string> = new Set(WRITE_COMMANDS);
export const isWriteCommand = (command: string): boolean => writes.has(command);
