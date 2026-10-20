import type { launchOwnerAsync, closeOwnerHostAsync, OwnerLaunchInput, OwnerLaunchResult } from '../../owner-host';
/** The arguments object every logical command receives. */
export type CommandArgs = Record<string, unknown>;
/** The external effects a command flow may ask its runner for; the flow itself never performs them. */
export type OwnerEffect = { kind:'launch'; input:OwnerLaunchInput } | { kind:'close'; host:OwnerLaunchResult } | {kind:'first-output';taskId:string};
export type CommandFlow<T> = Generator<OwnerEffect,T,OwnerLaunchResult | undefined>;
export interface AsyncOwnerHost { launcher?:typeof launchOwnerAsync; closer?:typeof closeOwnerHostAsync }
