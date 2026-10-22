import type { CliAgentInput, PreparedCliAgent } from './cli/index';
import type { ManagedProcess } from './worker';
export type { CliAgentInput, ManagedAgentProcess, PreparedCliAgent } from './cli/index';
/** Injection boundary for deterministic fixture processes; production imports the fixed launcher. */
export type StartCliAgent = (input: CliAgentInput, beforeSpawn?: (prepared: PreparedCliAgent) => void) => ManagedProcess;
