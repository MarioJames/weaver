import { randomBytes } from 'node:crypto';
import { redactSecrets } from '../../shared/redact';
import { findExecutableSync } from '../system/executables';
import { startOwnedScope, type OwnedScope } from '../adapters/cli/scope';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { resolveImWorkspaces } from './workspaces';
import { PARENT_TEXT_MAX } from './limits';
export { PARENT_TEXT_MAX } from './limits';
import { startCodexParentSession } from './parent-codex';
import { startClaudeParentSession } from './parent-claude';
import { startOpenCodeParentSession } from './parent-opencode';
import { startPiParentSession } from './parent-pi';
import { startGrokParentSession } from './parent-grok';
import { startQoderParentSession } from './parent-qoder';
import { imEngineEffortAllowed, isImEngineKind, type ImEngineKind } from '../../shared/im-engines';

/** Input for one long-lived IM parent agent session. Engine/model/effort come from the owner profile. */
export interface ParentAgentInput {
  engineKind: ImEngineKind;
  model: string;
  effort: string;
  workspace: string;
  additionalWorkspaces?: readonly string[];
  instructions: string;
}

/** One persistent parent agent conversation. A session keeps the same engine process and context across sends. */
export interface ParentAgentSession {
  /** Resolves when control is unavailable; close still owns complete resource reclamation. */
  readonly unavailable?: Promise<void>;
  send(text: string, signal?: AbortSignal, onDelta?: (chunk: string) => void): Promise<string>;
  close(): Promise<void>;
}

export type ParentAgentFactory = (input: ParentAgentInput) => Promise<ParentAgentSession>;

/** Bounded identifiers, matching the existing CLI adapter rules. */
export const PARENT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
export const PARENT_EFFORT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const PARENT_UNIT_PREFIX = 'dev-weaver-im-';

/** Bounded waits. Overridable only through the internal test parameter, never through RPC. */
export const PARENT_STARTUP_MS = 30_000;
export const PARENT_TURN_MS = 15 * 60_000;
export const PARENT_CLOSE_MS = 20_000;

export interface ParentAgentInternals {
  startupMs?: number;
  turnMs?: number;
  closeMs?: number;
  launch?: ParentProcessLauncher;
}

export type ParentAgentFailureReason = 'invalid_input' | 'engine_missing' | 'auth' | 'protocol' | 'engine' | 'closed' | 'aborted';

/** Auth failures still use a fixed public message; only the reason is classified, never vendor text. */
const AUTH_FAILURE = /authentication (?:failed|error)|invalid[_ ]api[_ ]key|unauthorized|\b401\b|not (?:logged|signed) in|login required|credential/i;
export function parentFailureReason(message: string): 'auth' | 'engine' {
  return AUTH_FAILURE.test(message) ? 'auth' : 'engine';
}

export class ParentAgentError extends Error {
  constructor(message: string, readonly reason: ParentAgentFailureReason) {
    super(message);
    this.name = 'ParentAgentError';
  }
}

/** Emitted only after a native authoritative terminal proves the current turn really stopped.
 * OpenCode needs its bound current-turn message to show `MessageAbortedError`/`time.completed`
 * after the abort ACK plus `session.idle` (a bare ACK plus a stale same-session idle is not
 * proof); other engines use their own native proof (e.g. Grok reports a matching cancellation
 * without any ACK). Never synthesize this from a transport timeout alone. */
export class ConfirmedParentCancellation extends ParentAgentError {
  constructor() { super('Parent turn cancellation was confirmed', 'aborted'); this.name = 'AbortError'; }
}

/** A matching host proof that this request never reached the engine and cannot do so later. */
export class ParentTurnNotSubmitted extends ParentAgentError {
  constructor() { super('Parent turn was not submitted', 'aborted'); this.name = 'ParentTurnNotSubmitted'; }
}

/** Public error text is always redacted and bounded: no credentials, no full stdin/stderr/argv. */
export function parentError(reason: ParentAgentFailureReason, message: string): ParentAgentError {
  return new ParentAgentError(redactSecrets(message).slice(0, 2000), reason);
}

export function clipPublicText(value: string, max: number): string {
  return redactSecrets(value).slice(0, max);
}

export interface PreparedParentAgent {
  engineKind: ImEngineKind;
  model: string;
  effort: string;
  workspace: string;
  additionalWorkspaces?: readonly string[];
  instructions: string;
}

function failInput(field: string, message: string): never {
  throw new ParentAgentError(`${field}: ${message}`, 'invalid_input');
}

/** Validate input. Does not start a process and does not create any Weaver task or owner record. */
export function prepareParentAgentInput(input: ParentAgentInput): PreparedParentAgent {
  if (!input || !isImEngineKind(input.engineKind)) failInput('engineKind', 'engineKind must be a supported IM engine');
  if (typeof input.model !== 'string' || !PARENT_MODEL_PATTERN.test(input.model) || input.model.includes('..')) failInput('model', 'model must be a bounded identifier');
  if (!imEngineEffortAllowed(input.engineKind, input.effort)) failInput('effort', 'effort must be a level the engine supports');
  if (typeof input.instructions !== 'string' || !input.instructions.trim() || input.instructions.length > PARENT_TEXT_MAX) failInput('instructions', `instructions must be 1–${PARENT_TEXT_MAX} characters`);
  let roots: string[];
  try { roots = resolveImWorkspaces([input.workspace, ...(input.additionalWorkspaces ?? [])]); }
  catch { failInput('workspace', 'workspaces must be distinct existing project directories outside credential state'); }
  const [workspace, ...additionalWorkspaces] = roots;
  return { engineKind: input.engineKind, model: input.model, effort: input.effort, workspace, additionalWorkspaces, instructions: input.instructions };
}

const STRIPPED_ENV = /^(CLAUDECODE$|CLAUDE_CODE_|CODEX_THREAD_ID$|CODEX_SESSION_ID$|HERDR_|WEAVER_TASK|WEAVER_WORKER)/;

/**
 * Environment for the parent agent child: host nesting/worker identifiers are removed so a
 * leftover host context cannot leak into the conversation, while HOME and the CLI auth
 * environment are kept. The global HOME/CODEX_HOME/config are never modified.
 */
export function parentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_ENV.test(key)) continue;
    env[key] = value;
  }
  return env;
}

export function requireExecutable(name: string): string {
  const found = findExecutableSync(name);
  if (!found) throw parentError('engine_missing', `${name} CLI was not found on PATH; the ${name} parent agent cannot start`);
  return found;
}

/** Put the IM session into its own systemd user scope with the shared 8G/10G limits. */
export function startParentScope(command: readonly string[], workspace: string, extraEnv?: Readonly<Record<string, string>>): OwnedScope {
  const unit = `${PARENT_UNIT_PREFIX}${randomBytes(4).toString('hex')}`;
  return startOwnedScope({ command, cwd: workspace, env: { ...parentEnv(), ...extraEnv }, stdin: null, keepStdinOpen: true, unit });
}

/** Engine stdio transport only. It does not assert ownership or closure of any enclosing unit. */
export interface ParentProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin?: Writable;
  kill(signal?: NodeJS.Signals): boolean;
}
export type ParentProcessLauncher = (command: readonly string[], workspace: string, env?: Readonly<Record<string, string>>) => ParentProcess;

export interface TimerHandle {
  cancel(): void;
}

/** One bounded wait. The fire callback must settle the surrounding operation exactly once. */
export function startTimer(ms: number, label: string, fire: (error: ParentAgentError) => void): TimerHandle {
  const timer = setTimeout(() => fire(parentError('engine', `${label} timed out after ${ms}ms`)), ms);
  return { cancel: () => clearTimeout(timer) };
}

export function abortReason(signal: AbortSignal): Error {
  // Reusing a previous outcome as a new abort reason is still only cancellation intent.
  if (signal.reason instanceof ConfirmedParentCancellation || signal.reason instanceof ParentTurnNotSubmitted) return parentError('aborted', 'send was aborted');
  return signal.reason instanceof Error ? signal.reason : parentError('aborted', 'send was aborted');
}

/**
 * Factory for Feishu IM parent agent sessions. Each session is one resident engine process
 * inside its own owned scope; scheduling decisions live with the backend, never here.
 * The optional second parameter is internal test support only and is never exposed over RPC.
 * The signature stays assignable to ParentAgentFactory.
 */
export const createParentAgent = async (input: ParentAgentInput, internals?: ParentAgentInternals): Promise<ParentAgentSession> => {
  const prepared = prepareParentAgentInput(input);
  const waits = {
    startupMs: internals?.startupMs ?? PARENT_STARTUP_MS,
    turnMs: internals?.turnMs ?? PARENT_TURN_MS,
    closeMs: internals?.closeMs ?? PARENT_CLOSE_MS,
    launch: internals?.launch ?? startParentScope,
  };
  if (prepared.engineKind === 'codex') return startCodexParentSession(prepared, waits);
  if (prepared.engineKind === 'opencode') return startOpenCodeParentSession(prepared, waits);
  if (prepared.engineKind === 'pi') return startPiParentSession(prepared, waits);
  if (prepared.engineKind === 'grok') return startGrokParentSession(prepared, waits);
  if (prepared.engineKind === 'qodercli') return startQoderParentSession(prepared, waits);
  return startClaudeParentSession(prepared, waits);
};
