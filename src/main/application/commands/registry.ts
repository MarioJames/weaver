import type { LogicalCommand } from '../../../shared/contracts/commands';
import type { OwnerLifecycle } from '../owners/lifecycle';
import type { Dispatcher } from '../scheduling/dispatch';
import type { Retries } from '../scheduling/retry';
import type { Mutations } from '../tasks/mutations';
import type { Queries } from '../tasks/queries';
import type { Results } from '../tasks/results';
import type { CommandArgs, CommandFlow } from './types';

/** Commands whose handler is a flow, because it may ask the runner for an owner host launch or close. */
export type FlowCommand = 'owners.launch' | 'owners.switch';
export type SyncCommand = Exclude<LogicalCommand, FlowCommand>;
/** Every logical command maps to exactly one handler; a command added to the shared contract fails to compile until it is routed here. */
export interface CommandRegistry {
 sync: Record<SyncCommand, (args: CommandArgs) => unknown>;
 flow: Record<FlowCommand, (args: CommandArgs) => CommandFlow<unknown>>;
}
export interface CommandUnits { queries: Queries; mutations: Mutations; results: Results; owners: OwnerLifecycle; dispatch: Dispatcher; retries: Retries }

export function createRegistry(u: CommandUnits): CommandRegistry {
 return {
  sync: {
   'sync.snapshot': a => u.queries.snapshot(a),
   'sync.status': a => u.queries.status(a),
   'capabilities.get': a => u.queries.capabilities(a),
   'workspaces.list': a => u.queries.workspaces(a),
   'owners.list': a => u.owners.list(a),
   'owners.get': a => u.owners.get(a),
   'owners.attach': a => u.owners.register('owners.attach', a),
   'owners.spawn': a => u.owners.register('owners.spawn', a),
   'owners.continuation.get': a => u.owners.continuationGet(a),
   'owners.continuation.configure': a => u.owners.continuationConfigure(a),
   'tasks.create': a => u.mutations.create(a),
   'tasks.start': a => u.owners.startRoot(a),
   'tasks.complete': a => u.mutations.complete(a),
   'tasks.describe': a => u.mutations.describe(a),
   'tasks.retry': a => u.retries.retry(a),
   'tasks.update': a => u.mutations.update(a),
   'tasks.get': a => u.queries.taskGet(a),
   'tasks.list': a => u.queries.taskList(a),
   'tasks.events': a => u.queries.taskEvents(a),
   'tasks.cancel': a => u.mutations.cancel(a),
   'tasks.results': a => u.results.results(a),
   'tasks.health': a => u.queries.taskHealth(a),
   'packages.create': a => u.mutations.packagesCreate(a),
   'packages.get': a => u.queries.packageGet(a),
   'workers.spawn': a => u.dispatch.dispatchTask('workers.spawn', a),
   'workers.complete': a => u.mutations.workersComplete(a),
   'artifacts.read': a => u.queries.artifactRead(a),
   'observability.get': a => u.queries.observability('observability.get', a),
   'observability.export': a => u.queries.observability('observability.export', a),
   'engines.health': a => u.queries.enginesHealth(a),
   'engines.penalty': a => u.queries.enginesPenalty(a),
   'engines.unblock': a => u.queries.enginesUnblock(a),
   'results.deliver': a => u.results.deliver(a),
   'results.ack': a => u.results.settle('results.ack', a),
   'reviews.submit': a => u.results.settle('reviews.submit', a),
   'operations.get': a => u.queries.operationGet(a),
  },
  flow: {
   'owners.launch': a => u.owners.launchOwner(a),
   'owners.switch': a => u.owners.switchOwner(a),
  },
 };
}
