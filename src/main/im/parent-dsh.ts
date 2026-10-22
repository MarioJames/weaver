import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDshOverlayPatch } from '../adapters/cli/argv';
import { decodeLines } from '../adapters/cli/scope';
import { processTree, readProcessSnapshots } from '../monitors/process-tree';
import {
  abortReason,
  parentError,
  parentFailureReason,
  PARENT_TEXT_MAX,
  requireExecutable,
  startTimer,
  ConfirmedParentCancellation,
  ParentAgentError,
  type ParentAgentSession,
  type ParentAgentSendOptions,
  type ParentProcess,
  type ParentProcessLauncher,
  type ParentProgressEvent,
  type PreparedParentAgent,
  type TimerHandle,
} from './parent-agent';
import { PublicTextBoundary } from './public-text';

/**
 * dsh parent session. The installed 0.2.1-rc.2 headless profile is explicitly one task per
 * invocation: it prints newline-delimited `--json` events, flushes the persisted Session, and
 * exits. There is no interactive stdin protocol and no native in-process multi-turn surface in
 * this composition. The Weaver host therefore stays resident while each turn is one native dsh
 * child; context continues through the exact Session id reported by the opening `session` event
 * and adopted with `--session-id` on the next child. This adapter never claims that the native
 * dsh process is reused across turns.
 *
 * Only `text` events and the terminal `final` event are public text. `thinking`,
 * `tool_result`, `status` details, stderr diagnostics and protocol errors stay inside
 * this module. The stream is the native projection: committed text arrives when a step
 * commits, not per token. When the caller passes `ParentAgentSendOptions.onProgress`,
 * `tool_call` tool names and `status` phase names are additionally reported as short
 * sanitized progress labels (never arguments, commands, thinking text or paths);
 * without `onProgress` the behavior is exactly the previous text-only one.
 *
 * Model, effort and the unattended permission posture ride the same private `--patch` overlay as
 * the existing worker launcher: `deepseek-official`, `workspace-write`, `ask`, and the local
 * credential service enabled by reference only. No credential value is read or written here.
 *
 * dsh's sandbox-policy contract has one primary workspace root per session (the Session cwd).
 * The first configured root is the child cwd and the Session root; the remaining roots stay in
 * the bootstrap instruction list and are reachable by absolute path under native read policy.
 * Writes outside the primary root remain blocked by `workspace-write` and would need approval,
 * which headless cannot answer, so they fail closed instead of silently widening permissions.
 *
 * Cancellation is real process-tree termination: SIGTERM first, a bounded SIGKILL fallback, and
 * the outcome is confirmed only after every owned descendant is positively gone. Reply settlement
 * and resource ownership are separate: if the tree cannot be proven stopped, the send fails closed
 * and the exact process resource is retained so a later close() retries it. The per-session private
 * overlay directory is removed only after the tree is reclaimed.
 */

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STDERR_MAX = 2048;

interface ActiveTurn {
  settled: boolean;
  released: boolean;
  cancelError?: Error;
  failure?: ParentAgentError;
  timer: TimerHandle;
  onDelta?: (chunk: string) => void;
  onProgress?: (event: ParentProgressEvent) => void;
  boundary: PublicTextBoundary;
  process?: ParentProcess;
  pid?: number;
  groupOwned: boolean;
  knownTree: Map<number, number>;
  lines?: ReturnType<typeof decodeLines>;
  closeSignal: Promise<void>;
  resolveClose?: () => void;
  detachAbort?: () => void;
  resolve?: (value: string) => void;
  reject?: (error: Error) => void;
  sawClose: boolean;
  sawFinal: boolean;
  finalText?: string;
  sawSession: boolean;
  nativeAborted: boolean;
  turnEndMessage?: string;
  errorMessage?: string;
  stderrTail: string[];
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  reaping?: Promise<boolean>;
  finishing?: Promise<void>;
}

function privateGroup(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return false;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return Number(fields[2]) === pid;
  } catch {
    return false;
  }
}

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface DshParentWaits {
  startupMs: number;
  turnMs: number;
  closeMs: number;
  launch: ParentProcessLauncher;
}

export class DshParentSession implements ParentAgentSession {
  private signalUnavailable!: () => void;
  readonly unavailable = new Promise<void>(resolve => { this.signalUnavailable = resolve; });
  private readonly dshPath: string;
  private readonly overlayDir: string;
  private readonly overlayPath: string;
  private sessionId?: string;
  private instructionsSent = false;
  private active?: ActiveTurn;
  // Reply settlement and resource ownership are separate: a settled send never drops a native
  // process/tree that has not been positively proven gone.
  private readonly retained = new Set<ActiveTurn>();
  private lastStderr = '';
  private closed = false;
  private fatal?: ParentAgentError;
  private closePromise?: Promise<void>;
  private overlayRemoved = false;

  private constructor(private readonly prepared: PreparedParentAgent, private readonly waits: DshParentWaits) {
    this.dshPath = requireExecutable('dsh');
    const overlay = buildDshOverlayPatch(prepared.model, prepared.effort);
    this.overlayDir = mkdtempSync(join(tmpdir(), 'weaver-im-dsh-'));
    this.overlayPath = join(this.overlayDir, 'overlay.yml');
    try {
      chmodSync(this.overlayDir, 0o700);
      writeFileSync(this.overlayPath, overlay, { mode: 0o600 });
      chmodSync(this.overlayPath, 0o600);
    } catch (error) {
      try { rmSync(this.overlayDir, { recursive: true, force: true }); } catch { /* preserve the startup error */ }
      throw error;
    }
  }

  static async start(prepared: PreparedParentAgent, waits: DshParentWaits): Promise<DshParentSession> {
    return new DshParentSession(prepared, waits);
  }

  private command(): string[] {
    const argv = [this.dshPath, '--profile', 'headless', '--patch', this.overlayPath, '--json'];
    if (this.sessionId) argv.push('--session-id', this.sessionId);
    return argv;
  }

  private failureDetail(): string {
    return this.lastStderr.trim() ? 'dsh CLI exited after reporting diagnostics' : 'dsh CLI exited';
  }

  /**
   * Best-effort progress channel: only short tool/stage labels leave this module.
   * `thinking` bodies, `tool_call.input` (tool arguments/full commands), `tool_result`
   * and stderr never enter onProgress; callback errors are swallowed and never affect
   * the text turn.
   */
  private emitProgress(active: ActiveTurn, event: ParentProgressEvent): void {
    if (active.settled || active.cancelError || active.failure) return;
    const callback = active.onProgress;
    if (!callback) return;
    try { callback(event); }
    catch { /* progress is best effort; the text turn owns failure reporting */ }
  }

  private handleLine(active: ActiveTurn, line: string): void {
    if (active.settled) return;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; }
    catch {
      this.failProtocol(active, 'dsh sent a non-JSON protocol line');
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      this.failProtocol(active, 'dsh sent an invalid protocol frame');
      return;
    }
    switch (frame.type) {
      case 'session': {
        const id = typeof frame.sessionId === 'string' ? frame.sessionId : '';
        if (!id || !SESSION_ID.test(id)) { this.failProtocol(active, 'dsh did not report a usable session id'); return; }
        if (this.sessionId && id !== this.sessionId) { this.failProtocol(active, 'dsh resumed a different session than requested'); return; }
        active.sawSession = true;
        if (!this.sessionId) {
          this.sessionId = id;
          // The Session now exists with the bootstrap instructions in its first user message.
          this.instructionsSent = true;
        }
        return;
      }
      case 'status': {
        const phase = typeof frame.phase === 'string' ? frame.phase : '';
        if (phase === 'step_start') active.boundary.noteBoundary();
        // Stage progress: only the stage name (turn start / step number), never body text or args.
        if (phase === 'turn_start') this.emitProgress(active, { kind: 'stage', name: '开始' });
        else if (phase === 'step_start') {
          const step = frame.step;
          this.emitProgress(active, {
            kind: 'stage',
            name: typeof step === 'number' && Number.isFinite(step) ? `步骤${step}` : '执行',
          });
        }
        if (phase === 'turn_end') {
          const reason = frame.reason;
          if (reason && typeof reason === 'object' && !Array.isArray(reason)) {
            const value = reason as Record<string, unknown>;
            const kind = typeof value.kind === 'string' ? value.kind : '';
            if (kind === 'aborted') active.nativeAborted = true;
            if (kind === 'error') {
              const error = value.error as Record<string, unknown> | undefined;
              const code = typeof error?.code === 'string' ? error.code : '';
              const message = typeof error?.message === 'string' ? error.message : '';
              active.turnEndMessage = [code, message].filter(Boolean).join(': ') || 'error';
            }
          } else if (typeof reason === 'string') {
            if (reason === 'aborted') active.nativeAborted = true;
            else if (reason !== 'completed') active.turnEndMessage = reason;
          }
        }
        return;
      }
      case 'text': {
        if (active.cancelError || active.failure) return;
        if (typeof frame.text !== 'string' || !frame.text) return;
        if (!active.onDelta) return;
        try { active.onDelta(active.boundary.format(frame.text)); }
        catch { this.failSessionTurn(active, parentError('engine', 'dsh public text callback failed')); }
        return;
      }
      case 'final': {
        if (typeof frame.text === 'string') {
          active.sawFinal = true;
          active.finalText = frame.text;
        }
        return;
      }
      case 'error': {
        if (typeof frame.message === 'string') active.errorMessage = frame.message;
        return;
      }
      case 'thinking':
      case 'tool_result':
        return;
      case 'tool_call': {
        // Tool progress: only the short tool-name label; `input` (args/full commands) and results never forward.
        if (active.cancelError || active.failure) return;
        const tool = frame.tool;
        if (typeof tool === 'string' && tool.trim()) {
          this.emitProgress(active, { kind: 'tool', name: tool });
        }
        return;
      }
      default:
        return;
    }
  }

  private failProtocol(active: ActiveTurn, message: string): void {
    const error = parentError('protocol', message);
    this.failTurn(active, error);
    this.markFatal(error);
  }

  private failSessionTurn(active: ActiveTurn, error: ParentAgentError): void {
    this.failTurn(active, error);
    this.markFatal(error);
  }

  /** A protocol/stream failure makes the whole resumed-session contract untrustworthy. */
  private markFatal(error: ParentAgentError): void {
    this.fatal ??= error;
    // Settle the failed send first, then release the child and overlay exactly as close does.
    queueMicrotask(() => { void this.close().catch(() => { /* close owns resource reporting */ }); });
  }

  private failTurn(active: ActiveTurn, error: ParentAgentError): void {
    if (active.settled || active.cancelError || active.failure) return;
    active.failure = error;
    this.stop(active);
  }

  private requestCancel(active: ActiveTurn, reason: Error): void {
    if (active.settled || active.cancelError) return;
    active.cancelError = reason;
    this.stop(active);
  }

  private stop(active: ActiveTurn): void {
    active.onDelta = undefined;
    active.onProgress = undefined;
    active.timer.cancel();
    if (!active.process) {
      // No native child exists, so there is nothing to terminate.
      this.settleTurn(active, active.cancelError ?? active.failure ?? parentError('closed', 'dsh parent session is unavailable'));
      this.releaseTurn(active);
      return;
    }
    if (active.sawClose) { void this.afterClose(active); return; }
    void this.reapTree(active, Math.min(this.waits.closeMs, 2_000)).then(stopped => {
      if (stopped) {
        void this.waitClose(active, this.waits.closeMs).then(closed => {
          if (closed) { void this.afterClose(active); return; }
          // The tree is gone even though the close event has not arrived; cancellation is
          // confirmed by the tree proof, never by the missing/settled event itself.
          this.settleTurn(active, active.cancelError ? new ConfirmedParentCancellation() : active.failure ?? parentError('engine', 'dsh process exited without reporting close'));
          this.releaseTurn(active);
        });
        return;
      }
      const error = parentError('engine', 'dsh process tree did not stop');
      this.fatal ??= error;
      this.signalUnavailable();
      this.settleTurn(active, active.cancelError ? error : active.failure ?? error);
    });
  }

  /**
   * Positive tree proof. A launcher that can own the tree reports liveness directly; otherwise
   * only a private process group or the already observed /proc descendants count. An ordinary
   * error/close event or a settled promise is never used here.
   */
  private treeGone(active: ActiveTurn): boolean {
    const child = active.process;
    if (!child) return true;
    let ownedGone: boolean | undefined;
    if (typeof child.treeAlive === 'function') {
      try { ownedGone = child.treeAlive() === false; } catch { ownedGone = false; }
      if (!ownedGone) return false;
    } else if (active.groupOwned && active.pid !== undefined) {
      ownedGone = !groupAlive(active.pid);
      if (!ownedGone) return false;
    }
    // An escaped descendant may leave the process group/cgroup; every captured descendant
    // must independently be gone. Without an observable tree, only explicit ownership counts.
    const alive = this.observeTree(active);
    if (!alive) return ownedGone === true;
    for (const [pid, start] of active.knownTree) {
      if (alive.get(pid) === start) return false;
      // A live process the snapshot could not read (permissions/hidepid/zombie race) is
      // still not proof of death; only a missing PID or a different start time counts.
      if (!alive.has(pid) && pidExists(pid)) return false;
    }
    return true;
  }

  /** Record the direct child and every currently reachable descendant with PID-reuse-safe identity. */
  private observeTree(active: ActiveTurn): Map<number, number> | undefined {
    if (active.pid === undefined) return undefined;
    try {
      const snapshots = readProcessSnapshots();
      const alive = new Map(snapshots.map(process => [process.pid, process.startTicks]));
      const roots = new Set<number>();
      if (alive.has(active.pid)) roots.add(active.pid);
      for (const [pid, start] of active.knownTree) if (alive.get(pid) === start) roots.add(pid);
      for (const root of roots) for (const snapshot of processTree(root, snapshots)) active.knownTree.set(snapshot.pid, snapshot.startTicks);
      return alive;
    } catch {
      return undefined;
    }
  }

  private signalTree(active: ActiveTurn, signal: NodeJS.Signals): void {
    const child = active.process;
    if (!child) return;
    if (typeof child.killTree === 'function') {
      try { child.killTree(signal); } catch { /* the bounded wait below reports the truth */ }
      return;
    }
    if (active.groupOwned && active.pid !== undefined) {
      try { globalThis.process.kill(-active.pid, signal); } catch { /* the bounded wait below reports the truth */ }
      return;
    }
    const alive = this.observeTree(active);
    if (!alive) {
      try { child.kill(signal); } catch { /* the bounded wait below reports the truth */ }
      return;
    }
    // Reap the observed descendants before their parent disappears and reparents them.
    for (const [pid, start] of active.knownTree) {
      if (pid === active.pid || alive.get(pid) !== start) continue;
      try { globalThis.process.kill(pid, signal); } catch { /* raced with exit */ }
    }
    try { child.kill(signal); } catch { /* the bounded wait below reports the truth */ }
  }

  private waitTree(active: ActiveTurn, ms: number): Promise<boolean> {
    if (this.treeGone(active)) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      const deadline = Date.now() + ms;
      const tick = (): void => {
        if (this.treeGone(active)) { resolve(true); return; }
        if (Date.now() >= deadline) { resolve(false); return; }
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
  }

  /** One bounded TERM/KILL attempt, shared by cancel, failure and close retries. */
  private reapTree(active: ActiveTurn, graceMs: number): Promise<boolean> {
    if (active.reaping) return active.reaping;
    const promise = (async () => {
      if (this.treeGone(active)) return true;
      this.signalTree(active, 'SIGTERM');
      if (await this.waitTree(active, graceMs)) return true;
      this.signalTree(active, 'SIGKILL');
      return this.waitTree(active, this.waits.closeMs);
    })().finally(() => { if (active.reaping === promise) active.reaping = undefined; });
    active.reaping = promise;
    return promise;
  }

  private handleClose(active: ActiveTurn, code: number | null, signal: NodeJS.Signals | null): void {
    active.sawClose = true;
    active.exitCode = code;
    active.exitSignal = signal;
    this.lastStderr = active.stderrTail.join('');
    try { active.lines?.end(); } catch { /* the line decoder is idempotent enough for a close */ }
    active.resolveClose?.();
    void this.afterClose(active);
  }

  private terminalOutcome(active: ActiveTurn): string | Error {
    if (active.cancelError) return new ConfirmedParentCancellation();
    if (active.failure) return active.failure;
    if (!active.sawSession) {
      const error = parentError('protocol', 'dsh run did not report its session');
      this.markFatal(error);
      return error;
    }
    if (active.exitCode === 0 && active.sawFinal) return active.finalText ?? '';
    if (active.exitCode === 0) {
      const error = parentError('protocol', 'dsh exited without a final event');
      this.markFatal(error);
      return error;
    }
    if (active.nativeAborted) {
      return parentError('engine', `dsh turn was aborted${active.exitSignal ? ` (${active.exitSignal})` : ''}`);
    }
    const evidence = [active.turnEndMessage, active.errorMessage, active.stderrTail.join('')].filter(Boolean).join(' ');
    return parentError(parentFailureReason(evidence), `dsh turn failed${active.exitCode === null ? '' : ` (exit ${active.exitCode})`}`);
  }

  private afterClose(active: ActiveTurn): Promise<void> {
    if (active.finishing) return active.finishing;
    active.finishing = (async () => {
      const outcome = this.terminalOutcome(active);
      const stopped = await this.reapTree(active, active.cancelError ? Math.min(this.waits.closeMs, 2_000) : this.waits.closeMs);
      if (outcome instanceof ConfirmedParentCancellation && !stopped) {
        const error = parentError('engine', 'dsh process tree did not stop after cancellation');
        this.fatal ??= error;
        this.signalUnavailable();
        this.settleTurn(active, error);
        return;
      }
      this.settleTurn(active, outcome);
      if (stopped) { this.releaseTurn(active); return; }
      const error = parentError('engine', 'dsh process tree did not stop');
      this.fatal ??= error;
      this.signalUnavailable();
    })();
    return active.finishing;
  }

  private settleTurn(active: ActiveTurn, outcome: string | Error): void {
    if (active.settled) return;
    if (this.active === active) this.active = undefined;
    active.settled = true;
    active.timer.cancel();
    active.onDelta = undefined;
    active.onProgress = undefined;
    active.detachAbort?.();
    if (typeof outcome === 'string') active.resolve?.(outcome);
    else active.reject?.(outcome);
  }

  private releaseTurn(active: ActiveTurn): void {
    if (active.released) return;
    active.released = true;
    this.retained.delete(active);
    active.process = undefined;
    active.lines = undefined;
  }

  private waitClose(active: ActiveTurn, ms: number): Promise<boolean> {
    if (active.sawClose) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      const timer = startTimer(ms, 'dsh process close', () => resolve(false));
      void active.closeSignal.then(() => { timer.cancel(); resolve(true); });
    });
  }

  async send(text: string, signal?: AbortSignal, onDelta?: (chunk: string) => void, options?: ParentAgentSendOptions): Promise<string> {
    if (typeof text !== 'string' || !text.trim() || text.length > PARENT_TEXT_MAX) throw parentError('invalid_input', `send text must be 1–${PARENT_TEXT_MAX} characters`);
    if (signal?.aborted) throw abortReason(signal);
    if (this.closed) throw parentError('closed', 'dsh parent session is closed');
    if (this.fatal) throw parentError(this.fatal.reason, 'dsh parent session is unavailable');
    if (this.active) throw parentError('engine', 'another send is still in progress on this session');
    if (this.retained.size) throw parentError('engine', 'a previous dsh turn has not stopped yet; close and retry');

    const prompt = this.instructionsSent ? text : `${this.prepared.instructions}\n\n${text}`;
    const finalOnly = options?.finalAssistantOnly === true;
    const onProgress = options?.onProgress;
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    let resolveClose!: () => void;
    const closeSignal = new Promise<void>(value => { resolveClose = value; });
    const active: ActiveTurn = {
      settled: false,
      released: false,
      timer: { cancel: () => undefined },
      boundary: new PublicTextBoundary(),
      groupOwned: false,
      knownTree: new Map(),
      closeSignal,
      resolveClose,
      sawClose: false,
      sawFinal: false,
      sawSession: false,
      nativeAborted: false,
      stderrTail: [],
      ...(!finalOnly && onDelta ? { onDelta } : {}),
      ...(onProgress ? { onProgress } : {}),
    };
    const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    active.resolve = resolve;
    active.reject = reject;
    this.active = active;
    this.retained.add(active);
    const onAbort = () => this.requestCancel(active, abortReason(signal!));
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      active.detachAbort = () => signal.removeEventListener('abort', onAbort);
    }
    active.timer = startTimer(this.waits.turnMs, 'dsh turn', error => this.failTurn(active, error));

    try {
      const scope = this.waits.launch(this.command(), this.prepared.workspace);
      active.process = scope;
      active.pid = scope.pid;
      active.groupOwned = privateGroup(active.pid);
      if (active.pid !== undefined) this.observeTree(active);
      active.lines = decodeLines(
        line => this.handleLine(active, line),
        detail => this.failProtocol(active, `dsh protocol frame exceeded limit: phase=${detail.phase} observedBytes=${detail.observedBytes}`),
      );
      scope.stdout.on('data', (chunk: Buffer) => {
        if (!active.settled) active.lines?.write(chunk);
      });
      scope.stderr.on('data', (chunk: Buffer) => {
        active.stderrTail.push(chunk.toString('utf8'));
        let total = active.stderrTail.reduce((sum, item) => sum + item.length, 0);
        while (total > STDERR_MAX && active.stderrTail.length > 1) total -= active.stderrTail.shift()!.length;
        if (total > STDERR_MAX) active.stderrTail[0] = active.stderrTail[0]!.slice(-STDERR_MAX);
      });
      scope.on('error', () => {
        if (active.settled) return;
        active.failure ??= parentError('engine', 'dsh process failed to start');
        this.stop(active);
      });
      scope.on('close', (code: number | null, scopeSignal: NodeJS.Signals | null) => this.handleClose(active, code, scopeSignal));
      if (!scope.stdin || scope.stdin.destroyed) throw parentError('engine', 'dsh stdin is unavailable');
      scope.stdin.write(prompt);
      scope.stdin.end();
      if (signal?.aborted) onAbort();
    } catch (error) {
      const failure = error instanceof ParentAgentError ? error : parentError('engine', 'dsh could not start');
      if (active.process && !active.sawClose) {
        active.failure ??= failure;
        // The rejected send no longer owns the reply slot, but the native resource stays in
        // `retained` until the tree is proven gone; close can retry the exact process.
        this.stop(active);
      } else {
        this.settleTurn(active, failure);
        this.releaseTurn(active);
      }
    }

    return promise.finally(() => active.detachAbort?.());
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.signalUnavailable();
    const active = this.active;
    if (active && !active.cancelError && !active.failure) active.failure = parentError('closed', 'dsh parent session is closed');
    this.closePromise = this.doClose().catch(error => {
      // A failed close keeps the exact native process (and the private overlay) for a later
      // precise retry; it must never be mistaken for a reclaimed session.
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    const active = this.active;
    if (active) this.stop(active);
    while (this.retained.size) {
      let progressed = false;
      for (const turn of [...this.retained]) {
        const stopped = await this.reapTree(turn, Math.min(this.waits.closeMs, 2_000));
        if (!stopped) {
          if (!turn.settled) this.settleTurn(turn, turn.cancelError ? parentError('engine', 'dsh process tree did not stop during close') : turn.failure ?? parentError('closed', 'dsh parent session is closed'));
          throw parentError('engine', 'dsh process did not exit during close');
        }
        if (!turn.sawClose) await this.waitClose(turn, this.waits.closeMs);
        if (!turn.settled) {
          this.settleTurn(turn, turn.cancelError ? new ConfirmedParentCancellation() : turn.failure ?? parentError('closed', 'dsh parent session is closed'));
        }
        this.releaseTurn(turn);
        progressed = true;
      }
      if (!progressed) break;
    }
    this.removeOverlay();
  }

  private removeOverlay(): void {
    if (this.overlayRemoved) return;
    try {
      rmSync(this.overlayDir, { recursive: true, force: true });
      this.overlayRemoved = true;
    } catch {
      throw parentError('engine', `dsh private overlay could not be removed: ${this.failureDetail()}`);
    }
  }
}

export async function startDshParentSession(prepared: PreparedParentAgent, waits: DshParentWaits): Promise<ParentAgentSession> {
  return DshParentSession.start(prepared, waits);
}
