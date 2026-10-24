import { prepareChannelRun, cleanupChannelRun } from '../../channels/runtime';
import { classifyVendorError, classifyVendorEvent } from './vendor-errors';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { WorkerRecord } from '../../../shared/contracts/tasks';
import { buildDshOverlayPatch, buildLaunchSpec } from './argv';
import { createNormalizer } from './normalize';
import { redactSecrets } from '../../../shared/redact';
import { clip, createRedactedLineBuffer } from './redact';
import { decodeLines, startOwnedScope, type LineOverflow, type OwnedScope } from './scope';
import type { CliAgentInput, ManagedAgentProcess } from './types';
import type { CliAgentEvidence, RealEngineKind } from '../../../shared/contracts/tasks';

const ENGINES = new Set<RealEngineKind>(['claude', 'opencode', 'pi', 'grok', 'codex', 'qodercli', 'dsh']);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const EFFORT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const STDERR_CAP = 24 * 1024;

export class CliAgentInputError extends Error {
  readonly code = 'invalid_input' as const;
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = 'CliAgentInputError';
  }
}

export interface PreparedCliAgent {
  engine: RealEngineKind;
  model: string;
  effort: string;
  workspace: string;
  stateDir: string;
  instruction: string;
  role?: 'worker' | 'owner';
  argv: string[];
  stdin: string | null;
  promptPath: string;
  /** Only pi keeps a per-run session directory; other engines have none. */
  sessionDir?: string;
  /** Only dsh carries a per-run --patch overlay file; other engines have none. */
  overlayPath?: string;
  unit: string;
  /** Private launch-only environment; excluded from receipts and task evidence. */
  env?: NodeJS.ProcessEnv;
  channelStateDir?: string;
  channelProfilePath?: string;
}

function fail(field: string, message: string): never {
  throw new CliAgentInputError(message, field);
}

function credentialRoots(): string[] {
  const home = homedir();
  // '.zcode' is the host's ZCode desktop client directory (not a Weaver engine); it stays shielded like the other credential roots.
  return ['.codex', '.grok', '.pi', '.opencode', '.qoder', '.qoder-cli', '.zcode', '.ssh'].map(name => path.join(home, name)).concat([
    path.join(home, '.config', 'opencode'),
    path.join(home, '.config', 'agents-cooperation'),
  ]);
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function rejectCredentialPath(field: string, resolved: string): void {
  for (const root of credentialRoots()) {
    if (inside(resolved, root)) fail(field, `${field} must not be inside credential or CLI config state`);
  }
}

function existingDirectory(field: string, value: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(field, `${field} must be an existing directory`);
  let resolved: string;
  try {
    const info = lstatSync(value);
    if (!info.isDirectory() && !info.isSymbolicLink()) fail(field, `${field} must be an existing directory`);
    resolved = realpathSync(value);
    if (!lstatSync(resolved).isDirectory()) fail(field, `${field} must be an existing directory`);
  } catch (error) {
    if (error instanceof CliAgentInputError) throw error;
    fail(field, `${field} must be an existing directory`);
  }
  rejectCredentialPath(field, resolved);
  return resolved;
}

/** Validate input and write the private prompt. Does not start a process. */
export function prepareCliAgentInput(input: CliAgentInput): PreparedCliAgent {
  if (input.channel && !input.channelConfig) fail('channel','Selected channel has no private runtime binding');
  if (!ENGINES.has(input.engine)) fail('engine', 'Engine must be claude, opencode, pi, grok, codex, qodercli, or dsh');
  if (typeof input.model !== 'string' || !MODEL.test(input.model) || input.model.includes('..')) fail('model', 'Model must be a bounded identifier');
  if (typeof input.effort !== 'string' || !EFFORT.test(input.effort)) fail('effort', 'Effort must be a bounded identifier');
  if (typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > 16000) fail('instruction', 'Instruction must be 1–16000 characters');
  if (input.role !== undefined && input.role !== 'worker' && input.role !== 'owner') fail('role', 'Role must be worker or owner');
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 120)) fail('name', 'Name must be at most 120 characters');
  if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) fail('workspace', 'workspace must be an existing absolute directory');
  const workspace = existingDirectory('workspace', input.workspace);
  if (typeof input.stateDir !== 'string' || !input.stateDir.trim()) fail('stateDir', 'stateDir must be a private job directory');
  try { mkdirSync(input.stateDir, { recursive: true, mode: 0o700 }); } catch { fail('stateDir', 'stateDir could not be created'); }
  const stateDir = existingDirectory('stateDir', input.stateDir);
  const id = randomBytes(4).toString('hex');
  const promptPath = path.join(stateDir, `prompt-${id}.txt`);
  const sessionDir = path.join(stateDir, `pi-session-${id}`);
  const leaderSocket = path.join(stateDir, `leader-${id}.sock`);
  // dsh reads model, reasoning effort and the permission posture from a patch-list
  // overlay; it is written per run next to the prompt and carries no credentials.
  const overlayPath = path.join(stateDir, `dsh-overlay-${id}.yml`);
  if (input.engine === 'pi') mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeFileSync(promptPath, input.instruction, { mode: 0o600 });
  chmodSync(promptPath, 0o600);
  if (input.engine === 'dsh') {
    writeFileSync(overlayPath, buildDshOverlayPatch(input.model, input.effort), { mode: 0o600 });
    chmodSync(overlayPath, 0o600);
  }
  let spec: ReturnType<typeof buildLaunchSpec>;
  try {
    spec = buildLaunchSpec({ engine: input.engine, model: input.model, effort: input.effort, workspace, instruction: input.instruction, promptPath, sessionDir, leaderSocket, overlayPath });
  } catch (error) {
    fail('effort', error instanceof Error ? error.message : 'Invalid effort');
  }
  const channelRun = input.channelConfig ? prepareChannelRun({ ...input.channelConfig, model: input.model, stateDir }) : undefined;
  if (channelRun) {
    // Global flags precede the subcommand, dsh provider patch precedes the final permission patch.
    spec.argv.splice(1, 0, ...channelRun.argv);
  }
  return { ...(channelRun ? { env: channelRun.env, channelStateDir:channelRun.channelStateDir, channelProfilePath:channelRun.channelProfilePath } : {}), engine: input.engine, model: input.model, effort: input.effort, workspace, stateDir, instruction: input.instruction, role: input.role, argv: spec.argv, stdin: spec.stdin, promptPath, ...(input.engine === 'pi' ? { sessionDir } : {}), ...(input.engine === 'dsh' ? { overlayPath } : {}), unit: `weaver-cli-${input.engine}-${id}` };
}

class CliAgent extends EventEmitter implements ManagedAgentProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid?: number;
  readonly scopeUnit: string;
  readonly evidence: CliAgentEvidence;
  private scope: OwnedScope;
  private cancelled = false;
  private failed = false;
  private normalizer: ReturnType<typeof createNormalizer>;
  private lines: ReturnType<typeof decodeLines>;
  private stderrBytes = 0;
  private stderrTail = '';
  private lastVendorError?: string;
  private stderrProbe = '';
  private firstOutput = false;
  private engine: RealEngineKind;
  private vendorBytes = 0;
  private vendorFrames = 0;
  private stderrBuffer: ReturnType<typeof createRedactedLineBuffer>;
  private readonly requestedModel: string;
  private readonly channelCleanup: () => void;
  private readonly reportedModels = new Set<string>();
  constructor(prepared: PreparedCliAgent) {
    super();
    this.channelCleanup=()=>cleanupChannelRun(prepared);
    this.engine = prepared.engine;
    this.requestedModel = prepared.model;
    this.scopeUnit = prepared.unit;
    this.evidence = { engine: prepared.engine, requestedModel: prepared.model, requestedEffort: prepared.effort, workspace: prepared.workspace, role: prepared.role, promptPath: prepared.promptPath, ...(prepared.sessionDir ? { sessionDir: prepared.sessionDir } : {}), terminal: 'pending' };
    this.normalizer = createNormalizer(prepared.engine);
    this.stderrBuffer = createRedactedLineBuffer(text => this.writeStderrText(text));
    this.lines = decodeLines(line => {
      this.vendorFrames = Math.min(Number.MAX_SAFE_INTEGER, this.vendorFrames + 1);
      const records=this.normalizer.push(line);
      const sessionId=this.normalizer.sessionId();if(sessionId&&this.evidence.vendorSessionId!==sessionId)this.evidence.vendorSessionId=sessionId;
      if(records.length && !this.firstOutput){this.firstOutput=true;this.emit('first-output',new Date().toISOString());}
      let value: Record<string,unknown>|undefined;try{value=JSON.parse(line);}catch{}
      if(value && (/error|fail/i.test(String(value.type)) || value.error || value.is_error || (value.type==='result'&&value.subtype!=='success') || (value.message && typeof value.message==='object' && ['error','aborted'].includes(String((value.message as Record<string,unknown>).stopReason))))) {
        const safe=redactSecrets(line);const message=safe.slice(0,2048);this.lastVendorError=message;this.emit('vendor-error',message,value?classifyVendorEvent(this.engine,value,safe):classifyVendorError(this.engine,safe));
      }
      if(this.engine==='pi'&&value)this.noteActualModel(value);
      this.emitRecords(records);
    }, detail => this.logOversizedLine(detail));
    const env = { ...(prepared.env ?? process.env) };
    delete env.ELECTRON_RUN_AS_NODE;
    this.scope = startOwnedScope({ command: prepared.argv, cwd: prepared.workspace, env, stdin: prepared.stdin, ...(prepared.stdin!==null?{stdinPath:prepared.promptPath}:{}), unit: prepared.unit });
    this.scope.on('identity', (invocation: string) => this.emit('identity', invocation));
    this.pid = this.scope.pid;
    this.emitRecords(launcherRecords(prepared));
    this.scope.stdout.on('data', (chunk: Buffer) => {
      // Transport volume includes ignored vendor token snapshots. Only frame
      // size and retained normalized evidence are budgets; this is telemetry.
      this.vendorBytes = Math.min(Number.MAX_SAFE_INTEGER, this.vendorBytes + chunk.length);
      this.lines.write(chunk);
    });
    this.scope.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer.write(chunk);
      // Some CLIs print a limit message without a newline and then wait forever.
      // Probe only the bounded unfinished line, using the same redaction framing.
      this.stderrProbe=(this.stderrProbe+chunk.toString('utf8')).split('\n').pop()!.slice(-8192);
      if(classifyVendorError(this.engine,this.stderrProbe)){
        const safe=createRedactedLineBuffer(text=>{const failure=classifyVendorError(this.engine,text);if(failure)this.emit('vendor-error',failure.message,failure);});
        safe.write(this.stderrProbe+'\n');safe.flush();
      }
    });
    this.scope.on('error', error => { this.failed = true; this.emit('error', error); });
    this.scope.on('close', (code: number | null) => this.complete(code));
  }
  kill(signal?: NodeJS.Signals): boolean {
    if (this.evidence.terminal !== 'pending') return false;
    this.cancelled = true;
    return this.scope.kill(signal);
  }
  /**
   * pi stamps every assistant message with the provider and model that actually served it. Each distinct pair is reported once
   * ('engine-model'), with whether it is the configured `provider/model`; the task manager records it and fails a mismatch.
   */
  private noteActualModel(event: Record<string, unknown>): void {
    const message = event.message && typeof event.message === 'object' ? event.message as Record<string, unknown> : undefined;
    if (message?.role !== 'assistant' || typeof message.provider !== 'string' || typeof message.model !== 'string' || !message.provider || !message.model) return;
    const actual = message.model.startsWith(`${message.provider}/`) ? message.model : `${message.provider}/${message.model}`;
    const reply = typeof message.responseModel === 'string' && message.responseModel && message.responseModel !== message.model ? message.responseModel : undefined;
    if (this.reportedModels.has(actual)) return;
    this.reportedModels.add(actual);
    this.emit('engine-model', { actual: redactSecrets(actual).slice(0, 200), expected: this.requestedModel, match: actual === this.requestedModel || message.model === this.requestedModel, ...(reply ? { responseModel: redactSecrets(reply).slice(0, 200) } : {}) });
  }
  private logOversizedLine(detail: LineOverflow): void {
    this.emitRecords([{ type: 'log', message: `vendor protocol frame exceeded limit: phase=${detail.phase} limitBytes=${detail.limitBytes} observedBytes=${detail.observedBytes} observedVendorBytes=${this.vendorBytes} parsedFrames=${this.vendorFrames}` }]);
  }
  private writeStderrText(text: string): void {
    this.stderrTail=(this.stderrTail+text).slice(-2048);this.emit('stderr-tail',this.stderrTail);
    const failure=classifyVendorError(this.engine,text);
    if(failure)this.emit('vendor-error',text.slice(-2048),failure);
    if (this.stderrBytes >= STDERR_CAP) return;
    const room = STDERR_CAP - this.stderrBytes;
    const slice = text.slice(0, room);
    this.stderrBytes += Buffer.byteLength(slice);
    this.stderr.write(slice);
    if (this.stderrBytes >= STDERR_CAP) this.stderr.write('\n[stderr truncated]\n');
  }
  private emitRecords(records: WorkerRecord[]): void {
    for (const item of records) {
      const safe = redactRecord(item);
      this.stdout.write(`${JSON.stringify(safe)}\n`);
    }
  }
  private complete(code: number | null): void {
    if (this.evidence.terminal !== 'pending') return;
    this.channelCleanup();
    this.lines.end();
    this.stderrBuffer.flush();
    const finished = this.normalizer.finish({ exitCode: this.failed ? 1 : code, cancelled: this.cancelled, truncated: false });
    this.evidence.vendorSessionId = finished.evidence.vendorSessionId;
    this.evidence.vendorModel = finished.evidence.vendorModel;
    this.evidence.usage = finished.evidence.usage;
    this.evidence.terminal = finished.evidence.terminal;
    if(finished.evidence.terminal!=='success'){for(const item of finished.records)if(item.type==='log'&&/terminal /.test(item.message))item.message=[item.message,this.stderrTail?`stderr tail: ${this.stderrTail}`:undefined,this.lastVendorError?`last vendor error: ${this.lastVendorError}`:undefined].filter(Boolean).join('; ').slice(-8000);}
    this.emitRecords(finished.records);
    this.stdout.end();
    this.stderr.end();
    const signal = this.cancelled ? 'SIGTERM' as const : null;
    this.emit('close', this.evidence.terminal === 'success' ? 0 : code === 0 || code === null ? 1 : code, signal);
  }
}

function permissionNote(engine: RealEngineKind): string {
  switch (engine) {
    case 'claude': return 'claude permission mode bypassPermissions is a CLI policy, not OS filesystem isolation';
    case 'grok': return 'grok permission mode bypassPermissions is a CLI policy, not OS filesystem isolation';
    case 'codex': return 'codex runs with danger-full-access (no vendor sandbox); this is not OS isolation';
    case 'opencode': return 'opencode --auto approves permissions inside the CLI; it is not OS isolation';
    case 'pi': return 'pi --approve trusts project files for this run; it is not OS isolation';
    case 'qodercli': return 'qodercli permission mode bypass_permissions is a CLI policy, not OS filesystem isolation';
    case 'dsh': return 'dsh runs workspace-write (file effects confined to the workspace) with ask approval that fails closed in headless; this is not OS isolation';
  }
}

export function redactRecord(record: WorkerRecord): WorkerRecord {
  if (record.type === 'log') return { type: 'log', message: clip(redactSecrets(record.message), 8000) };
  if (record.type === 'progress') return { type: 'progress', percent: record.percent, message: clip(redactSecrets(record.message), 8000) };
  if (record.type === 'artifact') return { ...record, content: clip(redactSecrets(record.content), 32000) };
  return { type: 'result', summary: clip(redactSecrets(record.summary), 8000) };
}

/** The three launcher records every run starts with (pipe and file mode share them). */
export function launcherRecords(input: { engine: RealEngineKind; model: string }): WorkerRecord[] {
  return [
    { type: 'log', message: `Launching ${input.engine} with requested model ${input.model}` },
    { type: 'log', message: permissionNote(input.engine) },
    { type: 'progress', percent: 10, message: 'owned scope started' },
  ];
}

/** Start one real CLI in its own systemd user scope. Rejects invalid input before launch.
 * The optional hook persists the prepared unit/prompt identity in the caller's transaction
 * before any external effect; when it throws nothing is started. */
export function startCliAgent(input: CliAgentInput, beforeSpawn?: (prepared: PreparedCliAgent) => void): ManagedAgentProcess {
  const prepared = prepareCliAgentInput(input);
  try {if (beforeSpawn) beforeSpawn(prepared);
    return new CliAgent(prepared);
  } catch(error) {cleanupChannelRun(prepared);throw error;}
}
