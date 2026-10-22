import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { CliAgentEvidence, RealEngineKind, TaskFailure, WorkerRecord } from '../../../shared/contracts/tasks';
import { redactSecrets } from '../../../shared/redact';
import { launcherRecords, prepareCliAgentInput, redactRecord } from './launch';
import type { CliAgentInput } from './types';
import { createNormalizer } from './normalize';
import { classifyVendorError, classifyVendorEvent } from './vendor-errors';
import { createRedactedLineBuffer } from './redact';
import { closeRunFiles, createRunFiles, readExitRecord } from './run-files';
import { pidInScope } from '../../monitors/process-tree';
import { LogTailer } from './log-tailer';
import {
  cleanupEscapedDescendants,
  confirmScopeAbsent,
  rememberEscapedDescendants,
  decodeLines,
  inspectScope,
  killOwnedScope,
  startOwnedScope,
  type EscapedCleanup,
  type KillOwnedScopeResult,
  type OwnedScope,
} from './scope';

/** Committed replay position: byte offsets plus the applied normalized-record count. */
export interface RunCursor {
  stdoutOffset: number;
  stderrOffset: number;
  appliedRecords: number;
}

/** Persisted launch identity for one file-mode run (§4.2). Written via beforeSpawn. */
export interface RunLaunchRecord {
  unit: string;
  stateDir: string;
  nonce: string;
  logs: { stdout: string; stderr: string; exit: string; exitTmp: string };
  logIdentity: { stdout: { dev: number; ino: number }; stderr: { dev: number; ino: number } };
  promptPath: string;
  sessionDir?: string;
  overlayPath?: string;
}

/** One atomic input batch: every record from a single complete line plus its end cursor. */
export interface RunBatch {
  cursor: RunCursor;
  records: WorkerRecord[];
  firstOutput?: true;
  failure?: TaskFailure;
  vendorError?: string;
  stderrTail?: string;
  engineModel?: { actual: string; expected: string; match: boolean; responseModel?: string };
}

/** The single terminal delivery for a run (emitted exactly once). */
export interface RunFinal {
  cursor: RunCursor;
  records: WorkerRecord[];
  evidence: CliAgentEvidence;
  exit: { code: number | null; signal: string | null; recorded: boolean };
  stderrTail?: string;
  vendorError?: string;
}

export interface CliRun extends EventEmitter {
  readonly unit: string;
  readonly evidence: CliAgentEvidence;
  readonly launch: RunLaunchRecord;
  /** Root pid of the worker scope when known; also the reattach anchor for escaped-process cleanup. */
  readonly pid?: number;
  setInvocation(id: string): void;
  setCancelled(): void;
  terminate(signal: 'SIGTERM' | 'SIGKILL'): Promise<KillOwnedScopeResult>;
  detach(): void;
}

/** Synchronous file-mode launcher: validates, persists, then spawns. */
export type StartCliRunFn = (input: CliAgentInput & { runId: string }, beforeSpawn: (record: RunLaunchRecord) => void) => CliRun;

/** Reattach state: everything the next process needs to resume the same run. */
export interface RunAttachState {
  input: CliAgentInput & { runId: string };
  launch: RunLaunchRecord;
  invocation?: string;
  cursor: RunCursor;
  pid?: number;
  cancelled: boolean;
}

const EXIT_POLL_MS = 250;
const KILL_GRACE_MS = 1500;
const PROBE_MAX = 8 * 1024;

/** Test-only unit prefix injection (production keeps the weaver-cli- unit). */
let runUnitPrefixForTests: string | undefined = process.env.WEAVER_RUN_UNIT_PREFIX ?? undefined;
export function __setRunUnitPrefixForTests(prefix: string | undefined): void {
  runUnitPrefixForTests = prefix;
}

/** Fatal-candidate priority within one undecided batch (§7.3): auth > quota > rate_limit > model > no_output/early_exit > other. */
const FATAL_RANK: Record<string, number> = {
  auth: 0,
  quota: 1,
  rate_limit: 2,
  model: 3,
  vendor: 3,
  no_output: 4,
  early_exit: 4,
  other: 5,
  cancelled: 5,
  unknown_outcome: 5,
};

export function pickFatalFailure(candidates: Array<{ failure: TaskFailure; offset: number }>): TaskFailure | undefined {
  if (candidates.length === 0) return undefined;
  let best = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    const bestRank = FATAL_RANK[best.failure.kind] ?? 5;
    const rank = FATAL_RANK[candidate.failure.kind] ?? 5;
    if (rank < bestRank || (rank === bestRank && candidate.offset < best.offset)) best = candidate;
  }
  return best.failure;
}

function readBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    return Buffer.alloc(0);
  }
}

/** Split a byte range into complete newline-terminated lines with exact end offsets. */
function readCompleteLines(path: string, fromOffset: number): Array<{ text: string; endOffset: number }> {
  const data = readBytes(path);
  if (data.length <= fromOffset) return [];
  const slice = data.subarray(fromOffset);
  const lastNewline = slice.lastIndexOf(10);
  if (lastNewline < 0) return [];
  const complete = slice.subarray(0, lastNewline + 1);
  const ends: number[] = [];
  for (let i = 0; i < complete.length; i++) {
    if (complete[i] === 10) ends.push(fromOffset + i + 1);
  }
  const texts: string[] = [];
  const decoder = decodeLines(
    text => {
      texts.push(text);
    },
    () => {
      /* oversized lines are dropped, like the online tailer */
    },
  );
  decoder.write(complete);
  decoder.end();
  if (texts.length === 0) return [];
  // Normally texts and ends pair 1:1; if an oversized line was dropped the
  // survivors align to the tail (conservative: never past the true end).
  const shift = ends.length - texts.length;
  return texts.map((text, index) => ({ text, endOffset: ends[shift + index] ?? fromOffset + complete.length }));
}

/** Decode a whole byte range into lines (replay helper; overflow lines are dropped). */
function decodeAll(data: Buffer): string[] {
  const texts: string[] = [];
  const decoder = decodeLines(
    text => {
      texts.push(text);
    },
    () => {
      /* dropped, like the online path */
    },
  );
  decoder.write(data);
  decoder.end();
  return texts;
}

interface ImplOptions {
  engine: RealEngineKind;
  model: string;
  effort: string;
  workspace: string;
  role?: 'worker' | 'owner';
  promptPath: string;
  sessionDir?: string;
  runId: string;
  launch: RunLaunchRecord;
  cursor: RunCursor;
  invocation?: string;
  pid?: number;
  cancelled: boolean;
  emitLauncher: boolean;
}

class CliRunImpl extends EventEmitter implements CliRun {
  readonly unit: string;
  readonly evidence: CliAgentEvidence;
  readonly launch: RunLaunchRecord;
  private readonly engine: RealEngineKind;
  private readonly requestedModel: string;
  private readonly runId: string;
  private cursor: RunCursor;
  private invocation: string | undefined;
  private cancelled: boolean;
  private readonly normalizer: ReturnType<typeof createNormalizer>;
  private readonly reportedModels = new Set<string>();
  private readonly stderrRedacted = createRedactedLineBuffer(text => this.handleRedactedStderr(text, this.pendingStderrEnd));
  private pendingStderrEnd = 0;
  private stderrTail = '';
  private lastVendorError: string | undefined;
  private firstOutputSent: boolean;
  private scope: OwnedScope | undefined;
  private stdoutTailer: LogTailer | undefined;
  private stderrTailer: LogTailer | undefined;
  private exitTimer: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private killPhase: 'term' | 'kill' | undefined;
  private killDeadline = 0;
  private lastProbe = '';
  private tailersOpen = false;
  private tailersStarted = false;
  private startImmediate: NodeJS.Immediate | undefined;
  private done = false;
  private detached = false;
  private rootPid: number | undefined;
  private readonly rememberedEscapes = new Map<number, string>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ImplOptions) {
    super();
    this.engine = options.engine;
    this.requestedModel = options.model;
    this.runId = options.runId;
    this.unit = options.launch.unit;
    this.launch = options.launch;
    this.cursor = { ...options.cursor };
    this.invocation = options.invocation;
    this.rootPid = options.pid;
    this.cancelled = options.cancelled;
    this.evidence = {
      engine: options.engine,
      requestedModel: options.model,
      requestedEffort: options.effort,
      workspace: options.workspace,
      role: options.role,
      promptPath: options.promptPath,
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      terminal: 'pending',
    };
    this.normalizer = createNormalizer(options.engine);
    // Replay the committed prefix to rebuild normalizer state (and to learn
    // whether first output already happened) without emitting or classifying.
    this.firstOutputSent = this.replayToCursor();
    // Defer the first pump so a caller can attach listeners after construction and still see the backlog.
    // This is what lets attachRecovered wire the run without replacing a global emitter.
    this.startImmediate = setImmediate(() => {
      this.startImmediate = undefined;
      if (this.done || this.detached) return;
      this.startTailers();
    });
    this.exitTimer = setInterval(() => {
      void this.checkExit();
    }, EXIT_POLL_MS);
    if (options.pid !== undefined && !options.emitLauncher) {
      // Reattached runs have no OwnedScope sweep; remember escapes while the root is reachable.
      this.sweepTimer = setInterval(() => this.rememberEscapes(), 3000);
      this.sweepTimer.unref?.();
    }
    if (options.emitLauncher) {
      const records = launcherRecords({ engine: options.engine, model: options.model }).map(redactRecord);
      queueMicrotask(() => {
        if (this.done || this.detached) return;
        this.cursor = { ...this.cursor, appliedRecords: this.cursor.appliedRecords + records.length };
        this.emit('batch', { cursor: { ...this.cursor }, records, stderrTail: this.stderrTail } satisfies RunBatch);
      });
    }
  }

  get pid(): number | undefined {
    return this.scope?.pid ?? this.rootPid;
  }

  setInvocation(id: string): void {
    this.invocation = id;
  }

  setCancelled(): void {
    this.cancelled = true;
  }

  async terminate(signal: 'SIGTERM' | 'SIGKILL'): Promise<KillOwnedScopeResult> {
    return killOwnedScope(this.unit, this.invocation, signal);
  }

  detach(): void {
    if (this.done || this.detached) return;
    this.detached = true;
    this.stopSweep();
    if (this.startImmediate !== undefined) {
      clearImmediate(this.startImmediate);
      this.startImmediate = undefined;
    }
    this.closeTailers();
    if (this.exitTimer !== undefined) {
      clearInterval(this.exitTimer);
      this.exitTimer = undefined;
    }
    // Release the owned scope's launcher handle (unref + destroy parent-side
    // stdio, stop its timers, drop listeners) without signalling the worker.
    // Afterwards neither the scope nor this run may emit or write again.
    try {
      (this.scope as OwnedScope & { detach?: () => void })?.detach?.();
    } catch {
      /* detach never fails shutdown */
    }
    try {
      this.scope?.removeAllListeners();
    } catch {
      /* ignore */
    }
    this.scope = undefined;
    this.removeAllListeners();
  }

  attachScope(scope: OwnedScope): void {
    this.scope = scope;
    scope.on('identity', (invocation: string) => {
      this.invocation = invocation;
      if (!this.detached && !this.done) this.emit('identity', invocation);
    });
    scope.on('pid', (pid: number) => {
      if (this.done) return;
      this.rootPid = pid;
      if (!this.detached) this.emit('pid', pid);
    });
    scope.on('cleanup', (cleaned: EscapedCleanup) => {
      if (!this.detached && !this.done) this.emit('cleanup', cleaned);
    });
    scope.on('error', (error: Error) => {
      if (!this.detached && !this.done) this.emit('error', error);
    });
  }

  private replayToCursor(): boolean {
    let sawRecords = false;
    const stdoutBytes = readBytes(this.launch.logs.stdout).subarray(0, Math.max(0, this.cursor.stdoutOffset));
    for (const line of decodeAll(stdoutBytes)) {
      const records = this.normalizer.push(line);
      if (records.length > 0) sawRecords = true;
      const sessionId = this.normalizer.sessionId();
      if (sessionId && this.evidence.vendorSessionId !== sessionId) this.evidence.vendorSessionId = sessionId;
      this.silentEngineModel(line);
    }
    const stderrBytes = readBytes(this.launch.logs.stderr).subarray(0, Math.max(0, this.cursor.stderrOffset));
    const rebuild = createRedactedLineBuffer(text => {
      this.stderrTail = (this.stderrTail + text).slice(-2048);
    });
    if (stderrBytes.length > 0) rebuild.write(stderrBytes);
    rebuild.flush();
    return sawRecords;
  }

  private startTailers(): void {
    if (this.tailersStarted || this.done || this.detached) return;
    this.tailersStarted = true;
    this.stdoutTailer = new LogTailer(
      this.launch.logs.stdout,
      (line, endOffset) => this.processStdoutLine(line.toString('utf8'), endOffset),
      {
        offset: this.cursor.stdoutOffset,
        pollMs: EXIT_POLL_MS,
        identity: this.launch.logIdentity.stdout,
        onIntegrityError: (reason, detail) => this.onIntegrity(reason, detail),
      },
    );
    this.stderrTailer = new LogTailer(
      this.launch.logs.stderr,
      (line, endOffset) => {
        this.pendingStderrEnd = endOffset;
        this.stderrRedacted.write(`${line.toString('utf8')}\n`);
      },
      {
        offset: this.cursor.stderrOffset,
        pollMs: EXIT_POLL_MS,
        identity: this.launch.logIdentity.stderr,
        onIntegrityError: (reason, detail) => this.onIntegrity(reason, detail),
      },
    );
    this.tailersOpen = true;
    this.stdoutTailer.start();
    this.stderrTailer.start();
  }

  private closeTailers(): void {
    if (this.startImmediate !== undefined) {
      clearImmediate(this.startImmediate);
      this.startImmediate = undefined;
    }
    this.tailersOpen = false;
    try {
      this.stdoutTailer?.close();
    } catch {
      /* ignore */
    }
    try {
      this.stderrTailer?.close();
    } catch {
      /* ignore */
    }
    this.stdoutTailer = undefined;
    this.stderrTailer = undefined;
  }

  private onIntegrity(reason: string, detail: string): void {
    if (this.done || this.detached) return;
    this.closeTailers();
    this.emit('integrity', reason, detail);
  }

  private silentEngineModel(line: string): void {
    if (this.engine !== 'pi') return;
    let value: Record<string, unknown> | undefined;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    this.noteActualModel(value, true);
  }

  private noteActualModel(event: Record<string, unknown>): { actual: string; expected: string; match: boolean; responseModel?: string } | undefined;
  private noteActualModel(event: Record<string, unknown>, silent: true): undefined;
  private noteActualModel(
    event: Record<string, unknown>,
    silent?: true,
  ): { actual: string; expected: string; match: boolean; responseModel?: string } | undefined {
    const message = event.message && typeof event.message === 'object' ? (event.message as Record<string, unknown>) : undefined;
    if (message?.role !== 'assistant' || typeof message.provider !== 'string' || typeof message.model !== 'string' || !message.provider || !message.model) {
      return undefined;
    }
    const actual = message.model.startsWith(`${message.provider}/`) ? message.model : `${message.provider}/${message.model}`;
    const reply = typeof message.responseModel === 'string' && message.responseModel && message.responseModel !== message.model ? message.responseModel : undefined;
    if (this.reportedModels.has(actual)) return undefined;
    this.reportedModels.add(actual);
    if (silent) return undefined;
    return {
      actual: redactSecrets(actual).slice(0, 200),
      expected: this.requestedModel,
      match: actual === this.requestedModel || message.model === this.requestedModel,
      ...(reply ? { responseModel: redactSecrets(reply).slice(0, 200) } : {}),
    };
  }

  private processStdoutLine(line: string, endOffset: number): void {
    if (this.done || this.detached) return;
    const raw = this.normalizer.push(line);
    const records = raw.map(redactRecord);
    const sessionId = this.normalizer.sessionId();
    if (sessionId && this.evidence.vendorSessionId !== sessionId) this.evidence.vendorSessionId = sessionId;
    let value: Record<string, unknown> | undefined;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      /* non-JSON lines carry no vendor signal */
    }
    let vendorError: string | undefined;
    let failure: TaskFailure | undefined;
    if (
      value &&
      (/error|fail/i.test(String(value.type)) ||
        value.error ||
        value.is_error ||
        (value.type === 'result' && value.subtype !== 'success') ||
        (value.message &&
          typeof value.message === 'object' &&
          ['error', 'aborted'].includes(String((value.message as Record<string, unknown>).stopReason))))
    ) {
      const safe = redactSecrets(line);
      vendorError = safe.slice(0, 2048);
      this.lastVendorError = vendorError;
      failure = classifyVendorEvent(this.engine, value, safe);
    }
    const engineModel = value && this.engine === 'pi' ? this.noteActualModel(value) : undefined;
    let firstOutput: true | undefined;
    if (records.length > 0 && !this.firstOutputSent) {
      this.firstOutputSent = true;
      firstOutput = true;
    }
    this.cursor = { ...this.cursor, stdoutOffset: endOffset, appliedRecords: this.cursor.appliedRecords + records.length };
    const batch: RunBatch = { cursor: { ...this.cursor }, records, stderrTail: this.stderrTail };
    if (firstOutput) batch.firstOutput = true;
    if (vendorError) batch.vendorError = vendorError;
    if (failure) batch.failure = failure;
    if (engineModel) batch.engineModel = engineModel;
    this.emit('batch', batch);
  }

  private handleRedactedStderr(text: string, endOffset: number): void {
    if (this.done || this.detached) return;
    this.stderrTail = (this.stderrTail + text).slice(-2048);
    this.cursor = { ...this.cursor, stderrOffset: endOffset };
    const candidates: Array<{ failure: TaskFailure; offset: number }> = [];
    const lineFailure = classifyVendorError(this.engine, text);
    if (lineFailure) candidates.push({ failure: lineFailure, offset: endOffset });
    // The online unterminated tail probe (§7.2) can race a complete line; fold a
    // simultaneous probe hit into the same batch by fixed priority. The replay
    // segment never probes, and a consumed probe is not re-emitted by the poll.
    const probe = this.peekProbeFailure();
    if (probe) candidates.push({ failure: probe.failure, offset: endOffset + probe.pendingBytes });
    const failure = pickFatalFailure(candidates);
    if (probe) this.lastProbe = probe.text;
    const batch: RunBatch = { cursor: { ...this.cursor }, records: [], stderrTail: this.stderrTail };
    if (failure) {
      batch.failure = failure;
      batch.vendorError = failure.message;
    }
    this.emit('batch', batch);
  }

  private peekProbeFailure(): { failure: TaskFailure; text: string; pendingBytes: number } | undefined {
    if (!this.tailersOpen || !this.stderrTailer) return undefined;
    const pending = this.stderrTailer.unterminatedTail(PROBE_MAX);
    if (pending.length === 0) return undefined;
    const text = pending.toString('utf8').slice(-PROBE_MAX);
    if (!text || text === this.lastProbe) return undefined;
    const failure = classifyVendorError(this.engine, text);
    if (!failure) return undefined;
    return { failure, text, pendingBytes: pending.length };
  }

  private probePoll(): void {
    if (this.done || this.detached || !this.tailersOpen) return;
    const probe = this.peekProbeFailure();
    if (!probe) return;
    this.lastProbe = probe.text;
    const batch: RunBatch = {
      cursor: { ...this.cursor },
      records: [],
      stderrTail: this.stderrTail,
      vendorError: probe.failure.message,
      failure: probe.failure,
    };
    this.emit('batch', batch);
  }

  private drainToEOF(): void {
    this.closeTailers();
    for (const { text, endOffset } of readCompleteLines(this.launch.logs.stdout, this.cursor.stdoutOffset)) {
      this.processStdoutLine(text, endOffset);
    }
    this.stderrRedacted.flush();
    for (const { text, endOffset } of readCompleteLines(this.launch.logs.stderr, this.cursor.stderrOffset)) {
      this.pendingStderrEnd = endOffset;
      this.stderrRedacted.write(`${text}\n`);
    }
    this.stderrRedacted.flush();
  }

  private async checkExit(): Promise<void> {
    if (this.done || this.detached || this.checking) return;
    this.checking = true;
    try {
      const exit = readExitRecord(this.launch.logs.exit, this.runId, this.launch.nonce);
      if (exit) {
        const inspection = await inspectScope(this.unit);
        if (inspection.state === 'unknown') return;
        if (inspection.state === 'present') {
          // A legal exit record means the engine exited, not that descendants
          // did: verify attribution, then clean the remaining scope (B5).
          if (!this.invocation) return;
          // A reattached run has no OwnedScope.stop() to sweep escaped
          // descendants; do it here while the root still proves this scope.
          await this.sweepEscaped();
          if (this.killPhase === undefined) {
            await killOwnedScope(this.unit, this.invocation, 'SIGTERM');
            this.killPhase = 'term';
            this.killDeadline = Date.now() + KILL_GRACE_MS;
          } else if (this.killPhase === 'term' && Date.now() >= this.killDeadline) {
            await killOwnedScope(this.unit, this.invocation, 'SIGKILL');
            this.killPhase = 'kill';
          }
          return;
        }
        this.drainToEOF();
        await this.finishWith({ code: exit.code, signal: exit.signal, recorded: true });
        return;
      }
      const absent = await confirmScopeAbsent(this.unit);
      if (absent === 'unknown' || absent === false) {
        this.probePoll();
        return;
      }
      this.drainToEOF();
      await this.finishWith({ code: null, signal: null, recorded: false });
    } finally {
      this.checking = false;
      if (!this.done && !this.detached) this.probePoll();
    }
  }

  /** Remember escapes only while the root pid still belongs to this scope; never trust a reused pid. */
  private rememberEscapes(): void {
    if (this.done || this.detached || this.rootPid === undefined) return;
    if (!pidInScope(this.rootPid, this.unit)) return;
    rememberEscapedDescendants(this.rootPid, this.unit, this.rememberedEscapes);
  }

  private stopSweep(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * Clean escaped descendants at the final teardown. The live tree is used
   * only while the root still proves this scope; remembered foreign pids stay
   * guarded by their recorded unit so a reused pid is never signalled.
   */
  private async sweepEscaped(): Promise<void> {
    if (this.scope || this.detached) return;
    const rootPid = this.rootPid !== undefined && pidInScope(this.rootPid, this.unit) ? this.rootPid : undefined;
    if (rootPid === undefined && this.rememberedEscapes.size === 0) return;
    try {
      const cleaned = await cleanupEscapedDescendants(rootPid, this.unit, this.rememberedEscapes);
      if (!this.detached && (cleaned.units.length || cleaned.pids.length)) this.emit('cleanup', cleaned);
    } catch { /* cleanup is best effort; never block the final delivery */ }
  }

  private async finishWith(exit: { code: number | null; signal: string | null; recorded: boolean }): Promise<void> {
    if (this.done || this.detached) return;
    // Fallback final sweep for a reattached run whose scope disappeared
    // between exit detection and delivery. Only the final teardown reaches
    // here; detach returns above and never signals anything.
    await this.sweepEscaped();
    if (this.done || this.detached) return;
    this.done = true;
    this.stopSweep();
    this.closeTailers();
    if (this.exitTimer !== undefined) {
      clearInterval(this.exitTimer);
      this.exitTimer = undefined;
    }
    const finished = this.normalizer.finish({ exitCode: exit.code, cancelled: this.cancelled, truncated: false });
    this.evidence.vendorSessionId = finished.evidence.vendorSessionId;
    this.evidence.vendorModel = finished.evidence.vendorModel;
    this.evidence.usage = finished.evidence.usage;
    this.evidence.terminal = finished.evidence.terminal;
    const records = finished.records.map(redactRecord);
    if (finished.evidence.terminal !== 'success') {
      for (const item of records) {
        if (item.type === 'log' && /terminal /.test(item.message)) {
          item.message = [item.message, this.stderrTail ? `stderr tail: ${this.stderrTail}` : undefined, this.lastVendorError ? `last vendor error: ${this.lastVendorError}` : undefined]
            .filter(Boolean)
            .join('; ')
            .slice(-8000);
        }
      }
    }
    this.emit('final', {
      cursor: { ...this.cursor },
      records,
      evidence: { ...this.evidence },
      exit,
      stderrTail: this.stderrTail,
      ...(this.lastVendorError ? { vendorError: this.lastVendorError } : {}),
    } satisfies RunFinal);
  }
}

/**
 * Validate input, pre-create the run log files, persist the launch record via
 * beforeSpawn (which must run before any external effect), then start the
 * file-mode scope. A throwing beforeSpawn closes the log FDs and never spawns.
 */
export function startCliRun(input: CliAgentInput & { runId: string }, beforeSpawn: (record: RunLaunchRecord) => void): CliRun {
  const prepared = prepareCliAgentInput(input);
  const created = createRunFiles(prepared.stateDir, input.runId);
  const unit = runUnitPrefixForTests ? `${runUnitPrefixForTests}${prepared.unit.replace(/^weaver-cli-/, '')}` : prepared.unit;
  const launch: RunLaunchRecord = {
    unit,
    stateDir: prepared.stateDir,
    nonce: created.nonce,
    logs: { ...created.paths },
    logIdentity: {
      stdout: { ...created.identity.stdout },
      stderr: { ...created.identity.stderr },
    },
    promptPath: prepared.promptPath,
    ...(prepared.sessionDir ? { sessionDir: prepared.sessionDir } : {}),
    ...(prepared.overlayPath ? { overlayPath: prepared.overlayPath } : {}),
  };
  try {
    beforeSpawn(launch);
  } catch (error) {
    closeRunFiles(created.fds);
    throw error;
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let scope: OwnedScope;
  try {
    scope = startOwnedScope({
      command: prepared.argv,
      cwd: prepared.workspace,
      env,
      stdin: prepared.stdin,
      ...(prepared.stdin !== null ? { stdinPath: prepared.promptPath } : {}),
      unit,
      files: {
        stdoutFd: created.fds.stdout,
        stderrFd: created.fds.stderr,
        exitPath: created.paths.exit,
        exitTmpPath: created.paths.exitTmp,
        runId: input.runId,
        nonce: created.nonce,
      },
    });
  } catch (error) {
    closeRunFiles(created.fds);
    throw error;
  }
  const run = new CliRunImpl({
    engine: prepared.engine,
    model: prepared.model,
    effort: prepared.effort,
    workspace: prepared.workspace,
    role: prepared.role,
    promptPath: prepared.promptPath,
    sessionDir: prepared.sessionDir,
    runId: input.runId,
    launch,
    cursor: { stdoutOffset: 0, stderrOffset: 0, appliedRecords: 0 },
    cancelled: false,
    emitLauncher: true,
  });
  run.attachScope(scope);
  return run;
}

/** Reattach to the same run from persisted state: replay to the cursor, then tail. Emits no launcher records. */
export function attachCliRun(state: RunAttachState): CliRun {
  return new CliRunImpl({
    engine: state.input.engine,
    model: state.input.model,
    effort: state.input.effort,
    workspace: state.input.workspace,
    role: state.input.role,
    promptPath: state.launch.promptPath,
    sessionDir: state.launch.sessionDir,
    runId: state.input.runId,
    launch: state.launch,
    cursor: { ...state.cursor },
    invocation: state.invocation,
    pid: state.pid,
    cancelled: state.cancelled,
    emitLauncher: false,
  });
}
