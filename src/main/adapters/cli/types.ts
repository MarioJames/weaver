import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

export type RealEngineKind = 'opencode' | 'pi' | 'grok' | 'codex';

export interface CliAgentInput {
  engine: RealEngineKind;
  model: string;
  effort: string;
  workspace: string;
  instruction: string;
  stateDir: string;
  name?: string;
  role?: 'worker' | 'owner';
}

/** Vendor facts actually present on the event stream. Absent fields stay unknown. */
export interface CliAgentEvidence {
  engine: RealEngineKind;
  requestedModel: string;
  requestedEffort: string;
  workspace: string;
  role?: 'worker' | 'owner';
  vendorSessionId?: string;
  vendorModel?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  terminal: 'pending' | 'success' | 'error' | 'cancelled' | 'missing' | 'truncated';
}

export interface ManagedAgentProcess extends EventEmitter {
  pid?: number;
  stdout: Readable;
  stderr: Readable;
  /** systemd --user scope unit name without the .scope suffix. kill() stops this unit. */
  readonly scopeUnit: string;
  readonly evidence: CliAgentEvidence;
  kill(signal?: NodeJS.Signals): boolean;
}
