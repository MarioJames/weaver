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
 * Qoder CLI parent session (`qodercli -p --input-format stream-json --output-format stream-json
 * --include-partial-messages --no-session-persistence`, verified against 1.1.75). The public
 * Agent SDK documents `startup()` as an `initialize` control handshake before any first task,
 * and the installed CLI answers it without a user prompt; `system/init` then provides the live
 * session id and model. The same process keeps the conversation for later `user` frames.
 *
 * Only `stream_event/content_block_delta/text_delta` becomes public text. The `result` frame is
 * the only terminal. Since the native result carries no request uuid, attribution follows the
 * documented one-query-at-a-time model: the adapter never writes a second user frame while a
 * result is outstanding, rejects frames for another session or subagent, drops duplicate result
 * uuids, and requires at least one current-turn stream event before accepting a success terminal.
 * Native 1.1.75 reports authentication/quota/provider failures as an `is_error` result before
 * any public delta, so an attributable error result settles the turn without that stream proof;
 * a stale success result still cannot release the turn. A top-level `error` frame is fatal for
 * the process and is handled instead of ignored. Interrupt uses a matching `control_response`
 * ACK plus the matching `result`; a missing half closes the session.
 *
 * `qodercli status` output can contain account fields. This adapter never runs it, and no auth
 * payload or vendor text is exposed: only a fixed failure reason leaves the module.
 */

const DENY_MESSAGE = 'The Weaver IM parent session cannot grant tool permissions. Allow this tool in the local Qoder settings and retry.';

interface PendingControl {
  timer: { cancel(): void };
  resolve(value: Record<string, unknown> | undefined): void;
  reject(error: ParentAgentError): void;
}

interface ActiveTurn {
  sawStream: boolean;
  settled: boolean;
  timer: { cancel(): void };
  cancelError?: Error;
  interruptAck?: boolean;
  terminal?: Record<string, unknown>;
  deltaText: string;
  failureHint?: string;
  declineNote?: string;
  onDelta?: (chunk: string) => void;
  resolve?: (value: string) => void;
  reject?: (error: Error) => void;
}

export interface QoderParentWaits {
  startupMs: number;
  turnMs: number;
  closeMs: number;
  launch: ParentProcessLauncher;
}

export class QoderParentSession implements ParentAgentSession {
  private readonly scope: ParentProcess;
  private signalUnavailable!: () => void;
  readonly unavailable = new Promise<void>(resolve => { this.signalUnavailable = resolve; });
  private readonly lines: ReturnType<typeof decodeLines>;
  private readonly pending = new Map<string, PendingControl>();
  private readonly closeWaiters: Array<{ resolve(): void; reject(error: ParentAgentError): void; timer: { cancel(): void } }> = [];
  private readonly stderrTail: string[] = [];
  private readonly seenResultIds = new Set<string>();
  private sessionId?: string;
  private initModel?: string;
  private initResolve!: () => void;
  private readonly initialized = new Promise<void>(resolve => { this.initResolve = resolve; });
  private active?: ActiveTurn;
  private closed = false;
  private exited = false;
  private sawScopeClose = false;
  private closePromise?: Promise<void>;
  private lastScopeError?: string;

  private constructor(private readonly prepared: PreparedParentAgent, private readonly waits: QoderParentWaits) {
    const qoderPath = requireExecutable('qodercli');
    this.scope = waits.launch([
      qoderPath, '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--model', prepared.model,
      '--reasoning-effort', prepared.effort,
      '-w', prepared.workspace,
      '--no-session-persistence',
      '--append-system-prompt', prepared.instructions,
      ...(prepared.additionalWorkspaces?.length ? ['--add-dir', ...prepared.additionalWorkspaces] : []),
    ], prepared.workspace);
    this.lines = decodeLines(
      line => this.handleLine(line),
      detail => this.failSession(parentError('protocol', `qodercli protocol frame exceeded limit: phase=${detail.phase} observedBytes=${detail.observedBytes}`)),
    );
    this.scope.stdout.on('data', (chunk: Buffer) => this.lines.write(chunk));
    this.scope.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString('utf8'));
      if (this.stderrTail.length > 8) this.stderrTail.shift();
    });
    this.scope.on('error', error => {
      this.lastScopeError = error instanceof Error ? error.message : String(error);
      this.failSession(parentError('engine', `qodercli parent scope failed: ${this.lastScopeError}`));
    });
    this.scope.on('close', () => {
      this.signalUnavailable();
      this.sawScopeClose = true;
      this.exited = true;
      this.failAll(parentError('engine', `qodercli exited${this.failureDetail()}`));
      for (const waiter of this.closeWaiters.splice(0)) { waiter.timer.cancel(); waiter.resolve(); }
      if (!this.closed) void this.close().catch(() => { /* close owns resource reporting */ });
    });
  }

  static async start(prepared: PreparedParentAgent, waits: QoderParentWaits): Promise<QoderParentSession> {
    const session = new QoderParentSession(prepared, waits);
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
    if (this.exited) throw parentError('engine', 'qodercli has exited');
    if (this.closed) throw parentError('closed', 'qodercli parent session is closed');
    if (!this.scope.stdin || this.scope.stdin.destroyed) throw parentError('engine', 'qodercli stdin is unavailable');
    this.scope.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private control(subtype: string, payload: Record<string, unknown>, ms: number, label: string): Promise<Record<string, unknown> | undefined> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = startTimer(ms, label, error => { this.pending.delete(requestId); reject(error); });
      this.pending.set(requestId, {
        timer,
        resolve: value => { timer.cancel(); this.pending.delete(requestId); resolve(value); },
        reject: error => { timer.cancel(); this.pending.delete(requestId); reject(error); },
      });
      try { this.write({ type: 'control_request', request_id: requestId, request: { subtype, ...payload } }); }
      catch (error) {
        timer.cancel();
        this.pending.delete(requestId);
        reject(error instanceof ParentAgentError ? error : parentError('engine', String(error)));
      }
    });
  }

  private async handshake(): Promise<void> {
    await this.control('initialize', {}, this.waits.startupMs, 'qodercli initialize');
    // The native CLI emits system/init independently of the control response; wait for that
    // evidence rather than assuming the two records arrive in one order.
    const timer = startTimer(this.waits.startupMs, 'qodercli system/init', error => this.initResolve());
    try { await this.initialized; } finally { timer.cancel(); }
    if (!this.sessionId) throw parentError('protocol', 'qodercli initialize completed without a system/init session id');
    this.verifyModel();
  }

  private verifyModel(): void {
    const actual = this.initModel;
    if (!actual) return;
    const requested = this.prepared.model;
    const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const aliases = new Set(['default', 'defaultmodel', 'auto']);
    if (aliases.has(normalized(requested))) return;
    const matches = normalized(requested) === normalized(actual)
      || normalized(requested).endsWith(normalized(actual))
      || normalized(actual).endsWith(normalized(requested));
    if (!matches) throw parentError('protocol', 'qodercli resolved a different model than the configured one; refusing to continue');
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
      this.failSession(parentError('protocol', `qodercli sent a non-JSON protocol line: ${clipPublicText(line, 200)}`));
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      this.failSession(parentError('protocol', 'qodercli sent an invalid protocol frame'));
      return;
    }
    switch (frame.type) {
      case 'system': this.handleSystem(frame); return;
      case 'control_response': this.handleControlResponse(frame); return;
      case 'control_request': this.handleServerControl(frame); return;
      case 'stream_event': this.handleStreamEvent(frame); return;
      case 'result': this.handleResult(frame); return;
      case 'error': this.handleErrorFrame(frame); return;
      case 'assistant': this.handleAssistant(frame); return;
      case 'user':
        return;
      default:
        return;
    }
  }

  private handleSystem(frame: Record<string, unknown>): void {
    if (frame.subtype !== 'init') return;
    const sessionId = typeof frame.session_id === 'string' ? frame.session_id : '';
    if (!sessionId) { this.failSession(parentError('protocol', 'qodercli system/init did not include a session id')); return; }
    if (this.sessionId && this.sessionId !== sessionId) {
      this.failSession(parentError('protocol', 'qodercli changed session id during startup'));
      return;
    }
    this.sessionId = sessionId;
    if (typeof frame.model === 'string' && frame.model) this.initModel = frame.model;
    this.initResolve();
  }

  private handleControlResponse(frame: Record<string, unknown>): void {
    const response = frame.response as Record<string, unknown> | undefined;
    const requestId = typeof response?.request_id === 'string' ? response.request_id : undefined;
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (response?.subtype === 'success') { pending.resolve(response.response as Record<string, unknown> | undefined); return; }
    const text = typeof response?.error === 'string' && response.error ? response.error : 'control request was rejected';
    pending.reject(parentError(parentFailureReason(text), `qodercli control request failed: ${clipPublicText(text, 400)}`));
  }

  private respond(id: string, response: Record<string, unknown>): void {
    try { this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } }); }
    catch { /* the process is gone; the failure path owns reporting */ }
  }

  private respondError(id: string, message: string): void {
    try { this.write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: clipPublicText(message, 300) } }); }
    catch { /* the process is gone */ }
  }

  private handleServerControl(frame: Record<string, unknown>): void {
    const requestId = typeof frame.request_id === 'string' ? frame.request_id : undefined;
    if (!requestId) return;
    const request = frame.request as Record<string, unknown> | undefined;
    const subtype = typeof request?.subtype === 'string' ? request.subtype : typeof request?.type === 'string' ? request.type : '';
    if (subtype === 'can_use_tool') {
      const active = this.active;
      if (active && !active.settled) active.declineNote = DENY_MESSAGE;
      this.respond(requestId, { behavior: 'deny', message: DENY_MESSAGE });
      return;
    }
    this.respondError(requestId, `Weaver IM parent session does not support qodercli control request ${subtype || 'unknown'}`);
  }

  private handleStreamEvent(frame: Record<string, unknown>): void {
    if (frame.session_id !== undefined && frame.session_id !== this.sessionId) return;
    if (frame.parent_tool_use_id != null) return;
    const active = this.active;
    if (!active || active.settled || active.cancelError) return;
    const event = frame.event as Record<string, unknown> | undefined;
    if (event?.type !== 'content_block_delta') return;
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type !== 'text_delta' || typeof delta.text !== 'string' || !delta.text) return;
    active.sawStream = true;
    active.deltaText += delta.text;
    if (!active.onDelta) return;
    try { active.onDelta(delta.text); }
    catch (error) { this.failSession(parentError('engine', error instanceof Error ? error.message : String(error))); }
  }

  private handleAssistant(frame: Record<string, unknown>): void {
    if (frame.session_id !== undefined && frame.session_id !== this.sessionId) return;
    if (frame.parent_tool_use_id != null) return;
    const active = this.active;
    if (!active || active.settled) return;
    const error = frame.error;
    if (typeof error === 'string' && error && !active.failureHint) active.failureHint = error;
  }

  private handleErrorFrame(frame: Record<string, unknown>): void {
    if (frame.session_id !== undefined && frame.session_id !== this.sessionId) return;
    if (frame.parent_tool_use_id != null) return;
    const uuid = typeof frame.uuid === 'string' ? frame.uuid : '';
    if (uuid && this.seenResultIds.has(uuid)) return;
    if (uuid) this.rememberResult(uuid);
    const text = this.failureText(frame);
    const subtype = typeof frame.subtype === 'string' && frame.subtype ? frame.subtype : 'stream error';
    this.failSession(parentError(this.failureReason(text, frame.error_code), `qodercli sent a fatal error frame (${subtype}): ${text || 'unknown error'}`));
  }

  private handleResult(frame: Record<string, unknown>): void {
    const active = this.active;
    if (!active) return;
    if (frame.session_id !== undefined && frame.session_id !== this.sessionId) return;
    if (frame.parent_tool_use_id != null) return;
    const uuid = typeof frame.uuid === 'string' ? frame.uuid : '';
    if (uuid && this.seenResultIds.has(uuid)) return;
    if (active.cancelError) {
      if (!active.terminal) active.terminal = frame;
      if (active.interruptAck) this.finishCancellation(active);
      return;
    }
    const isError = frame.is_error === true || (typeof frame.subtype === 'string' && frame.subtype !== 'success');
    if (!isError && !active.sawStream) return;
    if (uuid) this.rememberResult(uuid);
    if (isError) {
      const subtype = typeof frame.subtype === 'string' && frame.subtype ? frame.subtype : 'error';
      const text = this.failureText(frame);
      this.finishTurn(active, parentError(this.failureReason(text, frame.error_code, active.failureHint), `qodercli turn failed (${subtype}): ${text || 'unknown error'}`));
      return;
    }
    const final = typeof frame.result === 'string' && frame.result.trim() ? frame.result : active.deltaText;
    if (!final.trim()) {
      const error = parentError('protocol', 'qodercli success result did not include assistant text');
      this.finishTurn(active, error);
      void this.close().catch(() => {});
      return;
    }
    this.finishTurn(active, final);
  }

  private failureText(frame: Record<string, unknown>): string {
    const errors = Array.isArray(frame.errors)
      ? frame.errors.filter((value): value is string => typeof value === 'string' && !!value.trim()).join('; ')
      : '';
    const error = frame.error;
    const nested = error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>).message
      : undefined;
    const candidates = [
      typeof frame.result === 'string' ? frame.result : '',
      errors,
      typeof error === 'string' ? error : '',
      typeof nested === 'string' ? nested : '',
      typeof frame.message === 'string' ? frame.message : '',
    ];
    return candidates.find(value => value.trim()) ?? '';
  }

  private failureReason(text: string, code: unknown, hint?: string): 'auth' | 'engine' {
    const codeText = typeof code === 'string' || typeof code === 'number' ? String(code) : '';
    if (code === 105 || (codeText && /auth|token|credential/i.test(codeText))) return 'auth';
    return parentFailureReason([text, hint, codeText].filter(Boolean).join(' '));
  }

  private rememberResult(uuid: string): void {
    this.seenResultIds.add(uuid);
    if (this.seenResultIds.size > 32) {
      const oldest = this.seenResultIds.values().next().value;
      if (oldest) this.seenResultIds.delete(oldest);
    }
  }

  private finishCancellation(active: ActiveTurn): void {
    if (this.active !== active || !active.interruptAck || !active.terminal) return;
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
    active.timer = startTimer(this.waits.closeMs, 'qodercli interrupt terminal', failure => this.failSession(failure));
    void this.control('interrupt', {}, this.waits.closeMs, 'qodercli interrupt').then(() => {
      active.interruptAck = true;
      if (active.terminal) this.finishCancellation(active);
    }, failure => { if (this.active === active) this.failSession(failure); });
  }

  async send(text: string, signal?: AbortSignal, onDelta?: (chunk: string) => void): Promise<string> {
    if (typeof text !== 'string' || !text.trim() || text.length > PARENT_TEXT_MAX) throw parentError('invalid_input', `send text must be 1–${PARENT_TEXT_MAX} characters`);
    if (signal?.aborted) throw abortReason(signal);
    if (this.closed) throw parentError('closed', 'qodercli parent session is closed');
    if (this.exited) throw parentError('engine', `qodercli has exited${this.failureDetail()}`);
    if (this.active) throw parentError('engine', 'another send is still in progress on this session');
    if (!this.sessionId) throw parentError('protocol', 'qodercli session was not started');
    const active: ActiveTurn = {
      sawStream: false,
      settled: false,
      timer: { cancel: () => undefined },
      deltaText: '',
      ...(onDelta ? { onDelta } : {}),
    };
    const promise = new Promise<string>((resolve, reject) => { active.resolve = resolve; active.reject = reject; });
    const onAbort = () => { if (!active.settled) this.cancelTurn(active, abortReason(signal!)); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    active.timer = startTimer(this.waits.turnMs, 'qodercli turn', error => this.failSession(error));
    this.active = active;
    try {
      this.write({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: this.sessionId,
      });
    } catch (error) {
      if (this.active === active) {
        this.active = undefined;
        active.timer.cancel();
        active.settled = true;
        active.onDelta = undefined;
        active.reject?.(error instanceof Error ? error : parentError('engine', String(error)));
      }
      if (signal) signal.removeEventListener('abort', onAbort);
      throw error;
    }
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
    this.failAll(parentError('closed', 'qodercli parent session is closing'));
    try { this.scope.stdin?.end(); } catch { /* stdin may already be gone */ }
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
      const timer = startTimer(ms, 'qodercli scope close', error => { remove(); reject(error); });
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

export async function startQoderParentSession(prepared: PreparedParentAgent, waits: QoderParentWaits): Promise<ParentAgentSession> {
  return QoderParentSession.start(prepared, waits);
}
