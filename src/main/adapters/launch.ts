import type { CliAgentInput } from './cli/index';
import type { ManagedProcess } from './worker';
export type { CliAgentInput, ManagedAgentProcess } from './cli/index';
/** Injection boundary for deterministic fixture processes; production imports the fixed launcher. */
export type StartCliAgent = (input: CliAgentInput) => ManagedProcess;
