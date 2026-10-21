import { randomUUID } from 'node:crypto';
import { decodeLines } from '../adapters/cli/scope';
import {
  abortReason,
  clipPublicText,
  parentError,
  parentFailureReason,
  PARENT_TEXT_MAX,
  requireExecutable,
  startTimer,
  ParentAgentError,
  ConfirmedParentCancellation,
  type ParentAgentSession,
  type PreparedParentAgent,
  type ParentProcess,
  type ParentProcessLauncher,
} from './parent-agent';

/**
 * Pi RPC parent session (`pi --mode rpc --no-session`, protocol from the installed 1.3.0
 * docs/rpc.md and docs/json.md). The process is long-lived: one `get_state` handshake starts it
 * without a user prompt, every `prompt` command runs in the same process and conversation, and
 * `agent_settled` is the only terminal that means Pi will not continue automatically.
 *
 * Public text comes only from `message_update.assistantMessageEvent.text_delta`; thinking,
 * tool-call and subagent updates never leave this module. The authoritative final text is the
 * completed assistant `message_end`. Abort sends `abort` and requires its success response plus
 * `agent_settled.aborted === true`; either one missing closes the session instead of replaying.
 *
 * Pi has no `--add-dir` and no built-in sandbox. The first configured root is the cwd; the other
 * roots stay in the bootstrap list and are reachable by absolute path under the user's native Pi
 * permissions. This adapter does not add `--approve`, disable extensions, or add a bypass mode.
 */

const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

interface PendingCommand {
  command: string;
  timer: { cancel(): void };
  resolve(value: Record<string, unknown> | undefined): void;
  reject(error: ParentAgentError): void;
}

interface ActiveTurn {
  accepted: boolean;
  running: boolean;
  settled: boolean;
  timer: { cancel(): void };
  cancelError?: Error;
  abortAck?: boolean;
  abortTerminal?: boolean;
  declineNote?: string;
  errorText?: string;
  finalText?: string;
  onDelta?: (chunk: string) => void;
  resolve?: (value: string) => void;
  reject?: (error: Error) => void;
}

export interface PiParentWaits {
  startupMs: number;
  turnMs: number;
  closeMs: number;
  launch: ParentProcessLauncher;
}

export class PiParentSession implements ParentAgentSession {
  private readonly scope: ParentProcess;
  private signalUnavailable!: () => void;
  readonly unavailable = new Promise<void>(resolve => { this.signalUnavailable = resolve; });
  private readonly lines: ReturnType<typeof decodeLines>;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly closeWaiters: Array<{ resolve(): void; reject(error: ParentAgentError): void; timer: { cancel(): void } }> = [];
  private readonly stderrTail: string[] = [];
  private sessionId?: string;
  private active?: ActiveTurn;
  private closed = false;
  private exited = false;
  private sawScopeClose = false;
  private closePromise?: Promise<void>;
  private lastScopeError?: string;
  private nextId = 1;

  private constructor(private readonly prepared: PreparedParentAgent, private readonly waits: PiParentWaits) {
    const piPath = requireExecutable('pi');
    this.scope = waits.launch([
      piPath, '--mode', 'rpc',
      '--no-session',
      '--model', prepared.model,
      '--thinking', prepared.effort,
      '--append-system-prompt', prepared.instructions,
    ], prepared.workspace);
    this.lines = decodeLines(
      line => this.handleLine(line),
      detail => this.failSession(parentError('protocol', `pi protocol frame exceeded limit: phase=${detail.phase} observedBytes=${detail.observedBytes}`)),
    );
    this.scope.stdout.on('data', (chunk: Buffer) => this.lines.write(chunk));
    this.scope.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString('utf8'));
      if (this.stderrTail.length > 8) this.stderrTail.shift();
    });
    this.scope.on('error', error => {
      this.lastScopeError = error instanceof Error ? error.message : String(error);
      this.failSession(parentError('engine', `pi parent scope failed: ${this.lastScopeError}`));
    });
    this.scope.on('close', () => {
      this.signalUnavailable();
      this.sawScopeClose = true;
      this.exited = true;
      this.failAll(parentError('engine', `pi CLI exited${this.failureDetail()}`));
      for (const waiter of this.closeWaiters.splice(0)) { waiter.timer.cancel(); waiter.resolve(); }
      if (!this.closed) void this.close().catch(() => { /* close owns resource reporting */ });
    });
  }

  static async start(prepared: PreparedParentAgent, waits: PiParentWaits): Promise<PiParentSession> {
    const session = new PiParentSession(prepared, waits);
    try {
      await session.handshake();
      return session;
    } catch (error) {
      await session.close().catch(() => { /* startup failure is the primary error */ });
      throw error;
    }
  }

  private failureDetail(): string {
    const tail = clipPublicText(this.stderrTail.join(''), 2048);
    const parts = [this.lastScopeError, tail.trim() ? tail : undefined].filter(Boolean);
    return parts.length ? `: ${parts.join('; ')}` : '';
  }

  private write(frame: Record<string, unknown>): void {
    if (this.exited) throw parentError('engine', 'pi CLI has exited');
    if (this.closed) throw parentError('closed', 'pi parent session is closed');
    if (!this.scope.stdin || this.scope.stdin.destroyed) throw parentError('engine', 'pi stdin is unavailable');
    this.scope.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private command(type: string, payload: Record<string, unknown>, ms: number, label: string): Promise<Record<string, unknown> | undefined> {
    const id = `im-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = startTimer(ms, label, error => {
        this.pending.delete(id);
        reject(error);
      });
      this.pending.set(id, {
        command: type,
        timer,
        resolve: value => { timer.cancel(); this.pending.delete(id); resolve(value); },
        reject: error => { timer.cancel(); this.pending.delete(id); reject(error); },
      });
      try { this.write({ id, type, ...payload }); }
      catch (error) {
        timer.cancel();
        this.pending.delete(id);
        reject(error instanceof ParentAgentError ? error : parentError('engine', String(error)));
      }
    });
  }

  private async handshake(): Promise<void> {
    const state = await this.command('get_state', {}, this.waits.startupMs, 'pi get_state');
    if (!state) throw parentError('protocol', 'pi get_state did not return session state');
    this.sessionId = typeof state.sessionId === 'string' && state.sessionId ? state.sessionId : undefined;
    if (!this.sessionId) throw parentError('protocol', 'pi get_state did not include a session id');
    this.verifyModel(state);
    if (state.thinkingLevel !== this.prepared.effort) {
      await this.command('set_thinking_level', { level: this.prepared.effort }, this.waits.startupMs, 'pi set_thinking_level')
        .catch(error => { throw error instanceof ParentAgentError ? error : parentError('engine', String(error)); });
      const after = await this.command('get_state', {}, this.waits.startupMs, 'pi get_state');
      if (after?.thinkingLevel !== this.prepared.effort) throw parentError('protocol', 'pi did not apply the requested thinking level');
    }
  }

  /** Unknown is allowed when Pi has no provider configured yet; a resolved model must match. */
  private verifyModel(state: Record<string, unknown>): void {
    const model = state.model as Record<string, unknown> | undefined;
    const actual = typeof model?.id === 'string' ? model.id : '';
    if (!actual || actual === 'unknown') return;
    const requested = this.prepared.model;
    const provider = typeof model?.provider === 'string' ? model.provider : '';
    const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const matches = requested === actual
      || (provider && requested === `${provider}/${actual}`)
      || requested.endsWith(`/${actual}`)
      || normalized(requested).endsWith(normalized(actual));
    if (!matches) throw parentError('protocol', 'pi resolved a different model than the configured one; refusing to continue');
  }

  private failAll(error: ParentAgentError): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    const active = this.active;
    this.active = undefined;
    if (active) {
      active.timer.cancel();
      if (!active.settled) { active.settled = true; active.onDelta = undefined; active.reject?.(error); }
    }
  }

  private failSession(error: ParentAgentError): void {
    this.signalUnavailable();
    this.failAll(error);
    if (!this.closed) void this.close().catch(() => { /* close failures surface through unavailable */ });
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; }
    catch {
      this.failSession(parentError('protocol', `pi sent a non-JSON protocol line: ${clipPublicText(line, 200)}`));
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      this.failSession(parentError('protocol', 'pi sent an invalid protocol frame'));
      return;
    }
    const type = frame.type;
    if (type === 'response') { this.handleResponse(frame); return; }
    if (type === 'extension_ui_request') { this.handleExtensionUi(frame); return; }
    if (type === 'agent_start') { if (this.active) this.active.running = true; return; }
    if (type === 'message_update') { this.handleMessageUpdate(frame); return; }
    if (type === 'message_end') { this.handleMessageEnd(frame); return; }
    if (type === 'auto_retry_end' && frame.success === false) {
      const active = this.active;
      if (active && active.accepted) active.errorText = typeof frame.finalError === 'string' ? frame.finalError : active.errorText;
      return;
    }
    if (type === 'agent_settled') { this.handleSettled(frame); return; }
    if (type === 'extension_error') return;
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = typeof frame.id === 'string' ? frame.id : undefined;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    if (typeof frame.command === 'string' && frame.command !== pending.command) {
      pending.reject(parentError('protocol', 'pi response command did not match its request'));
      return;
    }
    if (frame.success === true) {
      pending.resolve(frame.data as Record<string, unknown> | undefined);
      return;
    }
    const message = typeof frame.error === 'string' && frame.error ? frame.error : 'pi command was rejected';
    pending.reject(parentError(parentFailureReason(message), `pi ${pending.command} failed: ${message}`));
  }

  private handleExtensionUi(frame: Record<string, unknown>): void {
    const method = frame.method;
    const id = typeof frame.id === 'string' ? frame.id : undefined;
    if (!id || typeof method !== 'string' || !DIALOG_METHODS.has(method)) return;
    const active = this.active;
    if (active && !active.settled) active.declineNote ??= 'Pi requested interactive input; the Weaver IM parent session cancelled it.';
    try { this.write({ type: 'extension_ui_response', id, cancelled: true }); }
    catch { /* the process is gone; the failure path owns reporting */ }
  }

  private activeRunning(): ActiveTurn | undefined {
    const active = this.active;
    if (!active || active.settled || active.cancelError || !active.running) return undefined;
    return active;
  }

  private handleMessageUpdate(frame: Record<string, unknown>): void {
    const active = this.activeRunning();
    if (!active) return;
    if (frame.parentToolCallId != null) return;
    const update = frame.assistantMessageEvent as Record<string, unknown> | undefined;
    if (update?.type !== 'text_delta' || typeof update.delta !== 'string' || !update.delta) return;
    if (frame.parentToolUseId != null || update.parentToolCallId != null) return;
    if (!active.onDelta) return;
    try { active.onDelta(update.delta); }
    catch (error) { this.failSession(parentError('engine', error instanceof Error ? error.message : String(error))); }
  }

  private handleMessageEnd(frame: Record<string, unknown>): void {
    if (frame.parentToolCallId != null) return;
    const active = this.activeRunning();
    if (!active) return;
    const message = frame.message as Record<string, unknown> | undefined;
    if (message?.role !== 'assistant') return;
    if (typeof message.errorMessage === 'string' && message.errorMessage) {
      active.errorText = message.errorMessage;
      return;
    }
    if (typeof message.stopReason === 'string' && /error|aborted/i.test(message.stopReason)) return;
    if (!Array.isArray(message.content)) return;
    const text = message.content
      .filter((part): part is Record<string, unknown> => !!part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text')
      .map(part => typeof part.text === 'string' ? part.text : '')
      .join('');
    if (text) active.finalText = text;
  }

  private handleSettled(frame: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled) return;
    // A settled event before this prompt was accepted or started belongs to no current turn.
    if (!active.accepted || !active.running) return;
    const aborted = frame.aborted === true;
    if (active.cancelError) {
      if (aborted && active.abortAck) { this.finishCancellation(active); return; }
      if (!aborted) { this.failSession(parentError('engine', 'pi completed before cancellation was confirmed')); return; }
      active.abortTerminal = true;
      if (active.abortAck) this.finishCancellation(active);
      return;
    }
    if (aborted) { this.finishTurn(active, parentError('engine', 'pi run was aborted before completion')); return; }
    if (active.errorText) {
      const reason = parentFailureReason(active.errorText);
      this.finishTurn(active, parentError(reason, `pi turn failed: ${active.errorText}`));
      return;
    }
    if (!active.finalText?.trim()) {
      const error = parentError('protocol', 'pi settled without a final assistant message');
      this.finishTurn(active, error);
      void this.close().catch(() => {});
      return;
    }
    this.finishTurn(active, active.finalText);
  }

  private finishCancellation(active: ActiveTurn): void {
    if (this.active !== active || !active.abortAck || !active.abortTerminal) return;
    this.finishTurn(active, new ConfirmedParentCancellation());
  }

  private finishTurn(active: ActiveTurn, outcome: string | Error): void {
    if (this.active !== active) return;
    this.active = undefined;
    active.timer.cancel();
    if (active.settled) return;
    active.settled = true;
    active.onDelta = undefined;
    if (typeof outcome === 'string') active.resolve?.(outcome);
    else active.reject?.(outcome);
  }

  private cancelTurn(active: ActiveTurn, error: Error): void {
    if (this.active !== active || active.settled || active.cancelError) return;
    active.cancelError = error;
    active.onDelta = undefined;
    active.timer.cancel();
    active.timer = startTimer(this.waits.closeMs, 'pi abort terminal', failure => this.failSession(failure));
    void this.command('abort', {}, this.waits.closeMs, 'pi abort').then(() => {
      active.abortAck = true;
      if (active.abortTerminal) this.finishCancellation(active);
    }, failure => { if (this.active === active) this.failSession(failure); });
  }

  async send(text: string, signal?: AbortSignal, onDelta?: (chunk: string) => void): Promise<string> {
    if (typeof text !== 'string' || !text.trim() || text.length > PARENT_TEXT_MAX) throw parentError('invalid_input', `send text must be 1–${PARENT_TEXT_MAX} characters`);
    if (signal?.aborted) throw abortReason(signal);
    if (this.closed) throw parentError('closed', 'pi parent session is closed');
    if (this.exited) throw parentError('engine', `pi CLI has exited${this.failureDetail()}`);
    if (this.active) throw parentError('engine', 'another send is still in progress on this session');
    if (!this.sessionId) throw parentError('protocol', 'pi session was not started');
    const active: ActiveTurn = {
      // The prompt bytes are written synchronously below; a fast fixture may emit its first events
      // and the terminal before the command response microtask runs.
      accepted: true,
      running: false,
      settled: false,
      timer: { cancel: () => undefined },
      ...(onDelta ? { onDelta } : {}),
    };
    const promise = new Promise<string>((resolve, reject) => { active.resolve = resolve; active.reject = reject; });
    const onAbort = () => { if (!active.settled) this.cancelTurn(active, abortReason(signal!)); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    active.timer = startTimer(this.waits.turnMs, 'pi turn', error => this.failSession(error));
    this.active = active;
    void this.command('prompt', { message: text }, this.waits.turnMs, 'pi prompt').then(data => {
      if (this.active !== active) return;
      const disposition = typeof data?.disposition === 'string' ? data.disposition : '';
      if (disposition === 'handled') {
        this.finishTurn(active, parentError('engine', 'pi handled the prompt without starting an assistant run'));
        return;
      }
    }, error => {
      if (this.active !== active) return;
      this.finishTurn(active, error instanceof ParentAgentError ? error : parentError('engine', String(error)));
    });
    return promise.finally(() => { if (signal) signal.removeEventListener('abort', onAbort); });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.signalUnavailable();
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.failAll(parentError('closed', 'pi parent session is closing'));
    if (!this.sawScopeClose) {
      const graceful = await this.waitForScopeClose(Math.min(2000, this.waits.closeMs)).catch(() => false);
      if (!graceful) {
        this.scope.kill('SIGTERM');
        const terminated = await this.waitForScopeClose(this.waits.closeMs).catch(() => false);
        if (!terminated) {
          this.scope.kill('SIGKILL');
          await this.waitForScopeClose(this.waits.closeMs);
        }
      }
    }
  }

  private waitForScopeClose(ms: number): Promise<boolean> {
    if (this.sawScopeClose) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      const timer = startTimer(ms, 'pi scope close', error => { remove(); reject(error); });
      const entry = {
        resolve: () => { timer.cancel(); remove(); resolve(true); },
        reject: (error: ParentAgentError) => { timer.cancel(); remove(); reject(error); },
        timer,
      };
      const remove = () => { const index = this.closeWaiters.indexOf(entry); if (index >= 0) this.closeWaiters.splice(index, 1); };
      this.closeWaiters.push(entry);
    });
  }
}

export async function startPiParentSession(prepared: PreparedParentAgent, waits: PiParentWaits): Promise<ParentAgentSession> {
  return PiParentSession.start(prepared, waits);
}
