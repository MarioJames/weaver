import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { WorkerRecord } from '../../../shared/types';
import { buildLaunchSpec } from './argv';
import { createNormalizer } from './normalize';
import { clip, createRedactedLineBuffer, redact } from './redact';
import { decodeLines, startOwnedScope, type LineOverflow, type OwnedScope } from './scope';
import type { CliAgentEvidence, CliAgentInput, ManagedAgentProcess, RealEngineKind } from './types';

const ENGINES = new Set<RealEngineKind>(['opencode', 'pi', 'grok', 'codex']);
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
  unit: string;
}

function fail(field: string, message: string): never {
  throw new CliAgentInputError(message, field);
}

function credentialRoots(): string[] {
  const home = homedir();
  return ['.codex', '.grok', '.pi', '.opencode', '.ssh'].map(name => path.join(home, name)).concat([
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
  if (!ENGINES.has(input.engine)) fail('engine', 'Engine must be opencode, pi, grok, or codex');
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
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeFileSync(promptPath, input.instruction, { mode: 0o600 });
  chmodSync(promptPath, 0o600);
  let spec: ReturnType<typeof buildLaunchSpec>;
  try {
    spec = buildLaunchSpec({ engine: input.engine, model: input.model, effort: input.effort, workspace, instruction: input.instruction, promptPath, sessionDir, leaderSocket });
  } catch (error) {
    fail('effort', error instanceof Error ? error.message : 'Invalid effort');
  }
  return { engine: input.engine, model: input.model, effort: input.effort, workspace, stateDir, instruction: input.instruction, role: input.role, argv: spec.argv, stdin: spec.stdin, promptPath, unit: `weaver-cli-${input.engine}-${id}` };
}

class CliAgent extends EventEmitter implements ManagedAgentProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid?: number;
  readonly scopeUnit: string;
  readonly evidence: CliAgentEvidence;
  private scope: OwnedScope;
  private cancelled = false;
  private truncated = false;
  private failed = false;
  private normalizer: ReturnType<typeof createNormalizer>;
  private lines: ReturnType<typeof decodeLines>;
  private stderrBytes = 0;
  private vendorBytes = 0;
  private vendorFrames = 0;
  private stderrBuffer: ReturnType<typeof createRedactedLineBuffer>;
  constructor(prepared: PreparedCliAgent) {
    super();
    this.scopeUnit = prepared.unit;
    this.evidence = { engine: prepared.engine, requestedModel: prepared.model, requestedEffort: prepared.effort, workspace: prepared.workspace, role: prepared.role, terminal: 'pending' };
    this.normalizer = createNormalizer(prepared.engine);
    this.stderrBuffer = createRedactedLineBuffer(text => this.writeStderrText(text));
    this.lines = decodeLines(line => {
      if (this.truncated) return;
      this.vendorFrames = Math.min(Number.MAX_SAFE_INTEGER, this.vendorFrames + 1);
      this.emitRecords(this.normalizer.push(line));
    }, detail => this.markTruncated(detail));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    this.scope = startOwnedScope({ command: prepared.argv, cwd: prepared.workspace, env, stdin: prepared.stdin, unit: prepared.unit });
    this.pid = this.scope.pid;
    this.emitRecords([
      { type: 'log', message: `Launching ${prepared.engine} with requested model ${prepared.model}` },
      { type: 'log', message: permissionNote(prepared.engine) },
      { type: 'progress', percent: 10, message: 'owned scope started' },
    ]);
    this.scope.stdout.on('data', (chunk: Buffer) => {
      if (this.truncated) return;
      // Transport volume includes ignored vendor token snapshots. Only frame
      // size and retained normalized evidence are budgets; this is telemetry.
      this.vendorBytes = Math.min(Number.MAX_SAFE_INTEGER, this.vendorBytes + chunk.length);
      this.lines.write(chunk);
    });
    this.scope.stderr.on('data', (chunk: Buffer) => this.stderrBuffer.write(chunk));
    this.scope.on('error', error => { this.failed = true; this.emit('error', error); });
    this.scope.on('close', (code: number | null) => this.complete(code));
  }
  kill(signal?: NodeJS.Signals): boolean {
    if (this.evidence.terminal !== 'pending') return false;
    this.cancelled = true;
    return this.scope.kill(signal);
  }
  private markTruncated(detail: LineOverflow): void {
    if (this.truncated) return;
    this.truncated = true;
    this.emitRecords([{ type: 'log', message: `vendor protocol frame exceeded limit: phase=${detail.phase} limitBytes=${detail.limitBytes} observedBytes=${detail.observedBytes} observedVendorBytes=${this.vendorBytes} parsedFrames=${this.vendorFrames}` }]);
    this.scope.kill('SIGTERM');
  }
  private writeStderrText(text: string): void {
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
    this.lines.end();
    this.stderrBuffer.flush();
    const finished = this.normalizer.finish({ exitCode: this.failed ? 1 : code, cancelled: this.cancelled && !this.truncated, truncated: this.truncated });
    this.evidence.vendorSessionId = finished.evidence.vendorSessionId;
    this.evidence.vendorModel = finished.evidence.vendorModel;
    this.evidence.usage = finished.evidence.usage;
    this.evidence.terminal = finished.evidence.terminal;
    this.emitRecords(finished.records);
    this.stdout.end();
    this.stderr.end();
    const signal = this.cancelled || this.truncated ? 'SIGTERM' as const : null;
    this.emit('close', this.evidence.terminal === 'success' ? 0 : code === 0 || code === null ? 1 : code, signal);
  }
}

function permissionNote(engine: RealEngineKind): string {
  switch (engine) {
    case 'grok': return 'grok permission mode bypassPermissions is a CLI policy, not OS filesystem isolation';
    case 'codex': return 'codex sandbox workspace-write is the vendor profile, not a separate OS claim';
    case 'opencode': return 'opencode --auto approves permissions inside the CLI; it is not OS isolation';
    case 'pi': return 'pi --approve trusts project files for this run; it is not OS isolation';
  }
}

function redactRecord(record: WorkerRecord): WorkerRecord {
  if (record.type === 'log') return { type: 'log', message: clip(redact(record.message), 8000) };
  if (record.type === 'progress') return { type: 'progress', percent: record.percent, message: clip(redact(record.message), 8000) };
  if (record.type === 'artifact') return { ...record, content: clip(redact(record.content), 32000) };
  return { type: 'result', summary: clip(redact(record.summary), 8000) };
}

/** Start one real CLI in its own systemd user scope. Rejects invalid input before launch. */
export function startCliAgent(input: CliAgentInput): ManagedAgentProcess {
  const prepared = prepareCliAgentInput(input);
  return new CliAgent(prepared);
}
