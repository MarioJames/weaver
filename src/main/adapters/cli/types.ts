import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { CliAgentEvidence, RealEngineKind } from '../../../shared/contracts/tasks';

export interface CliAgentInput {
  channel?: string;
  /** Main-process-only binding; never persist this object. */
  channelConfig?: import('../../channels/runtime').ChannelBinding;
  engine: RealEngineKind;
  model: string;
  effort: string;
  workspace: string;
  instruction: string;
  stateDir: string;
  name?: string;
  role?: 'worker' | 'owner';
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
