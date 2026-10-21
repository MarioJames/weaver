import { randomUUID } from 'node:crypto';
import { decodeLines } from '../adapters/cli/scope';
import {
  abortReason,
  clipPublicText,
  parentError,
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
 * Claude Code CLI parent session (`claude -p --input-format stream-json --output-format
 * stream-json --verbose`, verified against Claude Code 2.1.304). The session is bound to its
 * own `--session-id <uuid>` at launch. Readiness comes from a real structured handshake, not
 * from `system/init`: that CLI does not emit `system/init` before the first user message, but
 * it does answer a `control_request {request:{subtype:'initialize'}}` with a matching
 * `control_response` whose `response.subtype` is `success`, so waiting for `init` at creation
 * deadlocks startup. The first real send is what makes the model run; a later `system/init`
 * must echo the requested session id or the session fails closed.
 *
 * Each send writes one user JSON line carrying a client uuid; the turn is released only by the
 * result frame that echoes that uuid in `user_message_uuid`/`user_message_uuids`. Results that
 * cannot be attributed fail closed. Streaming deltas come from `stream_event`
 * `content_block_delta` `text_delta` frames only. Permission `control_request` frames are
 * explicitly denied.
 *
 * Ordinary cancellation waits for both the matching interrupt acknowledgement and result,
 * retaining the resident context. Unreliable protocol, timeout or callback failure closes it.
 */

const DENY_MESSAGE = 'The Weaver IM parent session cannot grant tool permissions. Allow this tool in the local Claude Code settings and retry.';

interface ActiveTurn {
  uuid: string;
  timer: { cancel(): void };
  settled: boolean;
  cancelError?: Error;
  interruptDone?: boolean;
  terminal?: boolean;
  streamMessageId?: string;
  onDelta?: (chunk: string) => void;
  resolve?: (value: string) => void;
  reject?: (error: Error) => void;
  declineNote?: string;
}

export interface ClaudeParentWaits {
  startupMs: number;
  turnMs: number;
  closeMs: number;
  launch: ParentProcessLauncher;
}

interface PendingControl {
  resolve(payload: Record<string, unknown> | undefined): void;
  reject(error: ParentAgentError): void;
}

interface CloseWaiter {
  resolve(): void;
  reject(error: ParentAgentError): void;
  timer: { cancel(): void };
}

export class ClaudeParentSession implements ParentAgentSession {
  private readonly scope: ParentProcess;
  private signalUnavailable!: () => void;
  readonly unavailable = new Promise<void>(resolve => { this.signalUnavailable = resolve; });
  private readonly lines: ReturnType<typeof decodeLines>;
  private readonly pendingControls = new Map<string, PendingControl>();
  private readonly closeWaiters: CloseWaiter[] = [];
  private readonly stderrTail: string[] = [];
  private readonly sessionId = randomUUID();
  private cliVersion?: string;
  private streamCursorId?: string;
  private readonly seenMessageIds = new Set<string>();
  private active?: ActiveTurn;
  private lastScopeError?: string;
  private closed = false;
  private exited = false;
  private sawScopeClose = false;
  private closePromise?: Promise<void>;

  private constructor(private readonly prepared: PreparedParentAgent, private readonly waits: ClaudeParentWaits) {
    const claudePath = requireExecutable('claude');
    this.scope = waits.launch([
      claudePath, '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', prepared.model,
      '--effort', prepared.effort,
      '--append-system-prompt', prepared.instructions,
      '--no-session-persistence',
      '--include-partial-messages',
      '--session-id', this.sessionId,
      ...(prepared.additionalWorkspaces?.length ? ['--add-dir', ...prepared.additionalWorkspaces] : []),
    ], prepared.workspace);
    this.lines = decodeLines(
      line => this.handleLine(line),
      detail => this.failSession(parentError('protocol', `claude protocol frame exceeded limit: phase=${detail.phase} observedBytes=${detail.observedBytes}`)),
    );
    this.scope.stdout.on('data', (chunk: Buffer) => this.lines.write(chunk));
    this.scope.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString('utf8'));
      if (this.stderrTail.length > 8) this.stderrTail.shift();
    });
    this.scope.on('error', error => {
      this.failSession(parentError('engine', `claude parent scope failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    this.scope.on('close', () => {
      this.signalUnavailable();
      this.sawScopeClose = true;
      this.exited = true;
      this.failAll(parentError('engine', `claude CLI exited${this.failureDetail()}`));
      for (const waiter of this.closeWaiters.splice(0)) {
        waiter.timer.cancel();
        waiter.resolve();
      }
      if (!this.closed) void this.close().catch(() => { /* the close path already owns cleanup */ });
    });
  }

  static async start(prepared: PreparedParentAgent, waits: ClaudeParentWaits): Promise<ClaudeParentSession> {
    const session = new ClaudeParentSession(prepared, waits);
    try {
      const payload = await session.requestControl('initialize', waits.startupMs, 'claude initialize');
      session.cliVersion = typeof (payload as Record<string, unknown> | undefined)?.claude_code_version === 'string'
        ? (payload as { claude_code_version: string }).claude_code_version
        : undefined;
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  private failureDetail(): string {
    const tail = clipPublicText(this.stderrTail.join(''), 2048);
    const parts = [this.lastScopeError, tail.trim() ? tail : undefined].filter(Boolean);
    return parts.length ? `: ${parts.join('; ')}` : '';
  }

  private write(frame: Record<string, unknown>): void {
    if (this.exited) throw parentError('engine', 'claude CLI has exited');
    if (this.closed) throw parentError('closed', 'claude parent session is closed');
    if (!this.scope.stdin || this.scope.stdin.destroyed) throw parentError('engine', 'parent CLI stdin is unavailable');
    this.scope.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private failAll(error: ParentAgentError): void {
    for (const [id, pending] of this.pendingControls) {
      this.pendingControls.delete(id);
      pending.reject(error);
    }
    const active = this.active;
    this.active = undefined;
    if (active) {
      active.timer.cancel();
      if (!active.settled) {
        active.settled = true;
        active.onDelta = undefined;
        active.reject?.(error);
      }
    }
  }

  /** Fail everything that is in flight and terminate the session; later sends fail closed. */
  private failSession(error: ParentAgentError): void {
    this.signalUnavailable();
    this.failAll(error);
    if (this.closed) return;
    void this.close().catch(() => { /* close failures surface through the scope */ });
  }

  /** One bounded structured control request; only its matching control_response settles it. */
  private requestControl(subtype: string, ms: number, label: string): Promise<Record<string, unknown> | undefined> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = startTimer(ms, label, error => {
        this.pendingControls.delete(requestId);
        remove();
        reject(error);
      });
      const pending: PendingControl = {
        resolve: payload => { timer.cancel(); remove(); resolve(payload); },
        reject: error => { timer.cancel(); remove(); reject(error); },
      };
      const remove = () => {
        if (this.pendingControls.get(requestId) === pending) this.pendingControls.delete(requestId);
      };
      this.pendingControls.set(requestId, pending);
      try {
        this.write({ type: 'control_request', request_id: requestId, request: { subtype } });
      } catch (error) {
        timer.cancel();
        remove();
        reject(error instanceof ParentAgentError ? error : parentError('engine', String(error)));
      }
    });
  }

  private resolveControl(requestId: string, response: Record<string, unknown> | undefined): void {
    const pending = this.pendingControls.get(requestId);
    if (!pending) return;
    this.pendingControls.delete(requestId);
    if (response?.subtype === 'success') pending.resolve(response.response as Record<string, unknown> | undefined);
    else pending.reject(parentError('protocol', `claude control request was rejected: ${clipPublicText(String(response?.subtype ?? 'unknown'), 100)}`));
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.failSession(parentError('protocol', `claude CLI sent a non-JSON protocol line: ${clipPublicText(line, 200)}`));
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      this.failSession(parentError('protocol', 'claude sent an invalid protocol frame'));
      return;
    }
    switch (frame.type) {
      case 'system':
        if (frame.subtype === 'init') {
          if (typeof frame.session_id !== 'string' || !frame.session_id || frame.session_id !== this.sessionId) {
            this.failSession(parentError('protocol', 'claude init event did not match the requested --session-id; the CLI protocol is not compatible'));
            return;
          }
        }
        return;
      case 'control_response': {
        const response = frame.response as Record<string, unknown> | undefined;
        const requestId = typeof response?.request_id === 'string' ? response.request_id : undefined;
        if (!requestId) return;
        this.resolveControl(requestId, response);
        return;
      }
      case 'stream_event':
        this.handleStreamEvent(frame);
        return;
      case 'result':
        this.handleResult(frame);
        return;
      case 'control_request':
        this.denyControlRequest(frame);
        return;
      case 'user':
      case 'assistant':
      case 'keep_alive':
        return;
      default:
        return;
    }
  }

  private checkSession(frame: Record<string, unknown>): boolean {
    if (frame.session_id === undefined) return true;
    if (frame.session_id === this.sessionId) return true;
    this.failSession(parentError('protocol', 'claude emitted an event for a different session; refusing to mix host conversation context'));
    return false;
  }

  private handleStreamEvent(frame: Record<string, unknown>): void {
    if (!this.checkSession(frame)) return;
    if (frame.parent_tool_use_id != null) return;
    const event = frame.event as Record<string, unknown> | undefined;
    const active = this.active;
    if (!active || active.settled || active.cancelError) return;
    if (event?.type === 'message_start') {
      const message = event.message as Record<string, unknown> | undefined;
      const id = message?.id;
      this.streamCursorId = typeof id === 'string' ? id : undefined;
      if (typeof id !== 'string' || this.seenMessageIds.has(id)) return;
      active.streamMessageId = id;
      if (typeof id === 'string') this.seenMessageIds.add(id);
      return;
    }
    if ((frame.api_message_id ?? this.streamCursorId) !== active.streamMessageId) return;
    if (event?.type === 'message_stop') { active.streamMessageId = undefined; return; }
    if (event?.type !== 'content_block_delta' || !active.streamMessageId) return;
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type !== 'text_delta' || typeof delta.text !== 'string' || !delta.text) return;
    if (!active.onDelta) return;
    try {
      active.onDelta(delta.text);
    } catch (error) {
      this.failSession(parentError('engine', error instanceof Error ? error.message : String(error)));
    }
  }

  private handleResult(frame: Record<string, unknown>): void {
    if (!this.checkSession(frame)) return;
    const active = this.active;
    if (!active) return;
    const attributed = this.resultUuids(frame);
    if (!attributed.known) {
      // Fail closed: a result that cannot be attributed must never release a send.
      this.failTurn(parentError('protocol', 'claude result could not be attributed to the current input (no user_message_uuid); the CLI protocol is not compatible'));
      return;
    }
    if (!attributed.uuids.includes(active.uuid)) return;
    if (active.cancelError) {
      active.terminal = true;
      this.finishCancellation(active);
      return;
    }
    const isError = frame.is_error === true || (typeof frame.subtype === 'string' && frame.subtype !== 'success');
    if (isError) {
      const errors = Array.isArray(frame.errors) ? frame.errors.filter(value => typeof value === 'string') as string[] : [];
      const text = typeof frame.result === 'string' && frame.result.trim() ? frame.result : errors.join('; ');
      this.failTurn(parentError('engine', `claude turn failed (${String(frame.subtype ?? 'error')}): ${text || 'unknown error'}${this.failureDetail()}`));
      return;
    }
    if (typeof frame.result !== 'string') {
      this.failTurn(parentError('protocol', 'claude success result did not include assistant text'));
      return;
    }
    this.finishTurn(frame.result);
  }

  private resultUuids(frame: Record<string, unknown>): { known: boolean; uuids: string[] } {
    const single = typeof frame.user_message_uuid === 'string' && frame.user_message_uuid ? [frame.user_message_uuid] : [];
    const many = Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids.filter((value): value is string => typeof value === 'string' && !!value) : [];
    if (frame.user_message_uuid === undefined && frame.user_message_uuids === undefined) return { known: false, uuids: [] };
    return { known: true, uuids: [...single, ...many] };
  }

  /** Permission prompts are always denied; the CLI then ends the turn on its own. */
  private denyControlRequest(frame: Record<string, unknown>): void {
    const requestId = typeof frame.request_id === 'string' ? frame.request_id : undefined;
    if (!requestId) return;
    const active = this.active;
    if (active && !active.settled) active.declineNote = DENY_MESSAGE;
    try {
      this.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: DENY_MESSAGE } },
      });
    } catch { /* the process is gone; the failure path owns reporting */ }
  }

  private cancelTurn(active: ActiveTurn, error: Error): void {
    if (this.active !== active || active.settled || active.cancelError) return;
    active.cancelError = error;
    active.onDelta = undefined;
    active.timer.cancel();
    active.timer = startTimer(this.waits.closeMs, 'claude interrupt terminal', failure => this.failSession(failure));
    void this.requestControl('interrupt', this.waits.closeMs, 'claude interrupt').then(() => {
      active.interruptDone = true;
      this.finishCancellation(active);
    }, failure => { if (this.active === active) this.failSession(failure); });
  }

  private finishCancellation(active: ActiveTurn): void {
    if (this.active !== active || !active.terminal || !active.interruptDone) return;
    this.finishTurn(new ConfirmedParentCancellation());
  }

  private finishTurn(outcome: string | Error): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.timer.cancel();
    if (active.settled) return;
    active.settled = true;
    active.onDelta = undefined;
    if (typeof outcome === 'string') active.resolve?.(outcome);
    else active.reject?.(outcome);
  }

  /** Terminal error for the current turn: settle it with the error and detach the slot. */
  private failTurn(error: ParentAgentError): void {
    this.finishTurn(error);
    // Attribution and framing defects are protocol-level: the session may not be trusted again.
    if (error.reason === 'protocol') void this.close().catch(() => { /* teardown failures surface through close */ });
  }

  async send(text: string, signal?: AbortSignal, onDelta?: (chunk: string) => void): Promise<string> {
    if (typeof text !== 'string' || !text.trim() || text.length > PARENT_TEXT_MAX) throw parentError('invalid_input', `send text must be 1–${PARENT_TEXT_MAX} characters`);
    if (signal?.aborted) throw abortReason(signal);
    if (this.closed) throw parentError('closed', 'claude parent session is closed');
    if (this.exited) throw parentError('engine', `claude CLI has exited${this.failureDetail()}`);
    if (this.active) throw parentError('engine', 'another send is still in progress on this session');
    if (!this.sessionId) throw parentError('protocol', 'claude session was not started');
    const active: ActiveTurn = {
      uuid: randomUUID(),
      timer: { cancel: () => undefined },
      settled: false,
      ...(onDelta ? { onDelta } : {}),
    };
    const promise = new Promise<string>((resolve, reject) => {
      active.resolve = resolve;
      active.reject = reject;
    });
    const onAbort = () => {
      if (active.settled) return;
      this.cancelTurn(active, abortReason(signal!));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    active.timer = startTimer(this.waits.turnMs, 'claude turn', error => this.failSession(error));
    this.active = active;
    try {
      this.write({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        uuid: active.uuid,
        parent_tool_use_id: null,
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
    return promise.finally(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.signalUnavailable();
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.failAll(parentError('closed', 'claude parent session is closing'));
    if (this.sawScopeClose) return;
    try { this.scope.stdin?.end(); } catch { /* stdin may already be gone */ }
    const graceful = await this.waitForScopeClose(Math.min(2000, this.waits.closeMs)).catch(() => false);
    if (!graceful) {
      this.scope.kill('SIGTERM');
      await this.waitForScopeClose(this.waits.closeMs);
    }
  }

  private waitForScopeClose(ms: number): Promise<boolean> {
    if (this.sawScopeClose) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      const timer = startTimer(ms, 'claude scope close', error => {
        remove();
        reject(error);
      });
      const entry: CloseWaiter = {
        resolve: () => { timer.cancel(); remove(); resolve(true); },
        reject: (error: ParentAgentError) => { timer.cancel(); remove(); reject(error); },
        timer,
      };
      const remove = () => {
        const index = this.closeWaiters.indexOf(entry);
        if (index >= 0) this.closeWaiters.splice(index, 1);
      };
      this.closeWaiters.push(entry);
    });
  }
}

export async function startClaudeParentSession(prepared: PreparedParentAgent, waits: ClaudeParentWaits): Promise<ParentAgentSession> {
  return ClaudeParentSession.start(prepared, waits);
}
