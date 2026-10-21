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
 * Grok ACP parent session (`grok agent --model ... --reasoning-effort ... --no-leader stdio`,
 * verified against 1.0.62). This is the Agent Client Protocol over newline-delimited JSON-RPC.
 * Startup performs only `initialize` -> `authenticate` -> `session/new`; no user prompt is sent.
 * One process and one ACP session serve every turn, and `session/update` chunks are filtered by
 * the native `sessionId`.
 *
 * Only `agent_message_chunk` text content becomes public text. Thought chunks, tool calls and
 * plans never leave this module. `session/prompt`'s response is the sole turn terminal. ACP has
 * no cancel ACK: `session/cancel` is a notification, so cancellation is confirmed only by the
 * matching prompt response with `stopReason:"cancelled"`. Without that response the session is
 * closed and the turn is never replayed.
 *
 * Grok does not support multi-root sessions (`additionalDirectories is not supported`). The first
 * configured root is the cwd and remains the ACP workspace; the full root list stays in the
 * bootstrap instructions, and cross-root tool access uses Grok's native local permissions. No
 * symlink view is created and no root is silently dropped. `--always-approve` is never added.
 */

const REJECT_NOTE = 'Grok requested tool permission; the Weaver IM parent session rejected it because there is no interactive approval channel.';

interface PendingRequest {
  timer: { cancel(): void };
  resolve(value: Record<string, unknown> | undefined): void;
  reject(error: ParentAgentError): void;
}

interface ActiveTurn {
  settled: boolean;
  timer: { cancel(): void };
  cancelError?: Error;
  deltaText: string;
  declineNote?: string;
  onDelta?: (chunk: string) => void;
  resolve?: (value: string) => void;
  reject?: (error: Error) => void;
}

export interface GrokParentWaits {
  startupMs: number;
  turnMs: number;
  closeMs: number;
  launch: ParentProcessLauncher;
}

export class GrokParentSession implements ParentAgentSession {
  private readonly scope: ParentProcess;
  private signalUnavailable!: () => void;
  readonly unavailable = new Promise<void>(resolve => { this.signalUnavailable = resolve; });
  private readonly lines: ReturnType<typeof decodeLines>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly closeWaiters: Array<{ resolve(): void; reject(error: ParentAgentError): void; timer: { cancel(): void } }> = [];
  private readonly stderrTail: string[] = [];
  private sessionId?: string;
  private active?: ActiveTurn;
  private nextId = 1;
  private closed = false;
  private exited = false;
  private sawScopeClose = false;
  private closePromise?: Promise<void>;
  private closing = false;
  private lastScopeError?: string;

  private constructor(private readonly prepared: PreparedParentAgent, private readonly waits: GrokParentWaits) {
    const grokPath = requireExecutable('grok');
    this.scope = waits.launch([
      grokPath, 'agent',
      '--model', prepared.model,
      '--reasoning-effort', prepared.effort,
      '--no-leader',
      'stdio',
    ], prepared.workspace);
    this.lines = decodeLines(
      line => this.handleLine(line),
      detail => this.failSession(parentError('protocol', `grok protocol frame exceeded limit: phase=${detail.phase} observedBytes=${detail.observedBytes}`)),
    );
    this.scope.stdout.on('data', (chunk: Buffer) => this.lines.write(chunk));
    this.scope.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString('utf8'));
      if (this.stderrTail.length > 8) this.stderrTail.shift();
    });
    this.scope.on('error', error => {
      this.lastScopeError = error instanceof Error ? error.message : String(error);
      this.failSession(parentError('engine', `grok parent scope failed: ${this.lastScopeError}`));
    });
    this.scope.on('close', () => {
      this.signalUnavailable();
      this.sawScopeClose = true;
      this.exited = true;
      this.failAll(parentError('engine', `grok agent exited${this.failureDetail()}`));
      for (const waiter of this.closeWaiters.splice(0)) { waiter.timer.cancel(); waiter.resolve(); }
      if (!this.closed) void this.close().catch(() => { /* close owns resource reporting */ });
    });
  }

  static async start(prepared: PreparedParentAgent, waits: GrokParentWaits): Promise<GrokParentSession> {
    const session = new GrokParentSession(prepared, waits);
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
    if (this.exited) throw parentError('engine', 'grok agent has exited');
    if (this.closed && !this.closing) throw parentError('closed', 'grok parent session is closed');
    if (!this.scope.stdin || this.scope.stdin.destroyed) throw parentError('engine', 'grok stdin is unavailable');
    this.scope.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private request(method: string, params: Record<string, unknown>, ms: number, label: string): Promise<Record<string, unknown> | undefined> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = startTimer(ms, label, error => { this.pending.delete(id); reject(error); });
      this.pending.set(id, {
        timer,
        resolve: value => { timer.cancel(); this.pending.delete(id); resolve(value); },
        reject: error => { timer.cancel(); this.pending.delete(id); reject(error); },
      });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) {
        timer.cancel();
        this.pending.delete(id);
        reject(error instanceof ParentAgentError ? error : parentError('engine', String(error)));
      }
    });
  }

  private async handshake(): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, this.waits.startupMs, 'grok initialize').catch(error => {
      throw error instanceof ParentAgentError && error.reason !== 'protocol' ? parentError('protocol', 'grok initialize was rejected') : error;
    });
    if (init?.protocolVersion !== 1) throw parentError('protocol', 'grok ACP protocol version is not 1');
    const methods = Array.isArray(init.authMethods)
      ? init.authMethods.filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
      : [];
    const meta = init._meta as Record<string, unknown> | undefined;
    const fallback = typeof meta?.defaultAuthMethodId === 'string' ? meta.defaultAuthMethodId : '';
    const ids = methods.map(method => typeof method.id === 'string' ? method.id : '').filter(Boolean);
    const choice = ids.includes('xai.api_key') && process.env.XAI_API_KEY ? 'xai.api_key'
      : ids.includes('cached_token') ? 'cached_token'
      : fallback || ids[0];
    if (!choice) throw parentError('auth', 'grok agent is not authenticated and advertises no authentication method');
    try {
      await this.request('authenticate', { methodId: choice }, this.waits.startupMs, 'grok authenticate');
    } catch (error) {
      if (error instanceof ParentAgentError && error.reason === 'protocol') {
        throw parentError('auth', 'grok authentication was rejected');
      }
      throw error;
    }
    const created = await this.request('session/new', {
      cwd: this.prepared.workspace,
      mcpServers: [],
      _meta: { rules: this.prepared.instructions },
    }, this.waits.startupMs, 'grok session/new');
    const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : '';
    if (!sessionId) throw parentError('protocol', 'grok session/new did not include a session id');
    this.sessionId = sessionId;
    this.verifySession(created);
  }

  private verifySession(created: Record<string, unknown> | undefined): void {
    const models = created?.models as Record<string, unknown> | undefined;
    const current = typeof models?.currentModelId === 'string' ? models.currentModelId : '';
    if (current && current !== this.prepared.model) {
      throw parentError('protocol', 'grok resolved a different model than the configured one; refusing to continue');
    }
    const meta = created?._meta as Record<string, unknown> | undefined;
    const config = meta?.['x.ai/sessionConfig'] as Record<string, unknown> | undefined;
    const options = Array.isArray(config?.options) ? config.options as Array<Record<string, unknown>> : [];
    const modes = options.filter(option => option?.category === 'mode');
    const selected = modes.find(option => option.selected === true);
    if (!selected) throw parentError('protocol', 'grok did not report the effective reasoning effort');
    if (selected.id !== this.prepared.effort) throw parentError('protocol', 'grok resolved a different reasoning effort than the configured one; refusing to continue');
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
      this.failSession(parentError('protocol', `grok sent a non-JSON protocol line: ${clipPublicText(line, 200)}`));
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      this.failSession(parentError('protocol', 'grok sent an invalid protocol frame'));
      return;
    }
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const id = typeof frame.id === 'number' ? frame.id : undefined;
      if (id === undefined) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      if (frame.error !== undefined) {
        const error = frame.error as Record<string, unknown> | undefined;
        const message = typeof error?.message === 'string' ? error.message : 'unknown error';
        pending.reject(parentError(parentFailureReason(message), `grok request failed: ${clipPublicText(message, 400)}`));
      } else {
        pending.resolve(frame.result as Record<string, unknown> | undefined);
      }
      return;
    }
    if (typeof frame.method === 'string') {
      if (typeof frame.id === 'number' || typeof frame.id === 'string') this.answerServerRequest(frame.id, frame.method, frame.params as Record<string, unknown> | undefined);
      else this.handleNotification(frame.method, frame.params as Record<string, unknown> | undefined);
      return;
    }
    this.failSession(parentError('protocol', 'grok sent an unrecognized protocol frame'));
  }

  private respond(id: number | string, result: Record<string, unknown>): void {
    try { this.write({ jsonrpc: '2.0', id, result }); } catch { /* process gone */ }
  }

  private respondError(id: number | string, message: string): void {
    try { this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: clipPublicText(message, 300) } }); } catch { /* process gone */ }
  }

  private answerServerRequest(id: number | string, method: string, params: Record<string, unknown> | undefined): void {
    if (method === 'session/request_permission') {
      const active = this.active;
      if (active && !active.settled) active.declineNote = REJECT_NOTE;
      const options = Array.isArray(params?.options) ? params.options as Array<Record<string, unknown>> : [];
      const reject = options.find(option => option?.kind === 'reject_once') ?? options.find(option => option?.kind === 'reject_always');
      if (reject && typeof reject.optionId === 'string') {
        this.respond(id, { outcome: { outcome: 'selected', optionId: reject.optionId } });
      } else {
        this.respond(id, { outcome: { outcome: 'cancelled' } });
      }
      return;
    }
    this.respondError(id, `Weaver IM parent session does not support grok client request ${method}`);
  }

  private handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    if (method !== 'session/update') return;
    if (!params || params.sessionId !== this.sessionId) return;
    const active = this.active;
    if (!active || active.settled || active.cancelError) return;
    const update = params.update as Record<string, unknown> | undefined;
    if (update?.sessionUpdate !== 'agent_message_chunk') return;
    const content = update.content as Record<string, unknown> | undefined;
    if (content?.type !== 'text' || typeof content.text !== 'string' || !content.text) return;
    active.deltaText += content.text;
    if (!active.onDelta) return;
    try { active.onDelta(content.text); }
    catch (error) { this.failSession(parentError('engine', error instanceof Error ? error.message : String(error))); }
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
    active.timer = startTimer(this.waits.closeMs, 'grok cancel terminal', failure => this.failSession(failure));
    try { this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } }); }
    catch (failure) { this.failSession(failure instanceof ParentAgentError ? failure : parentError('engine', String(failure))); }
  }

  async send(text: string, signal?: AbortSignal, onDelta?: (chunk: string) => void): Promise<string> {
    if (typeof text !== 'string' || !text.trim() || text.length > PARENT_TEXT_MAX) throw parentError('invalid_input', `send text must be 1–${PARENT_TEXT_MAX} characters`);
    if (signal?.aborted) throw abortReason(signal);
    if (this.closed) throw parentError('closed', 'grok parent session is closed');
    if (this.exited) throw parentError('engine', `grok agent has exited${this.failureDetail()}`);
    if (this.active) throw parentError('engine', 'another send is still in progress on this session');
    if (!this.sessionId) throw parentError('protocol', 'grok session was not started');
    const active: ActiveTurn = {
      settled: false,
      timer: { cancel: () => undefined },
      deltaText: '',
      ...(onDelta ? { onDelta } : {}),
    };
    const promise = new Promise<string>((resolve, reject) => { active.resolve = resolve; active.reject = reject; });
    const onAbort = () => { if (!active.settled) this.cancelTurn(active, abortReason(signal!)); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    active.timer = startTimer(this.waits.turnMs, 'grok turn', error => this.failSession(error));
    this.active = active;
    void this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, this.waits.turnMs, 'grok prompt').then(response => {
      if (this.active !== active) return;
      const stopReason = typeof response?.stopReason === 'string' ? response.stopReason : '';
      if (active.cancelError) {
        if (stopReason === 'cancelled') { this.finishTurn(active, new ConfirmedParentCancellation()); return; }
        this.failSession(parentError('engine', 'grok completed before cancellation was confirmed'));
        return;
      }
      if (stopReason === 'cancelled') { this.finishTurn(active, parentError('engine', 'grok cancelled the turn unexpectedly')); return; }
      if (stopReason !== 'end_turn' && stopReason !== 'max_tokens') {
        this.finishTurn(active, parentError('engine', active.declineNote ?? `grok turn stopped with ${stopReason || 'unknown reason'}`));
        return;
      }
      if (!active.deltaText.trim()) {
        const error = parentError('protocol', 'grok turn ended without assistant text');
        this.finishTurn(active, error);
        void this.close().catch(() => {});
        return;
      }
      this.finishTurn(active, active.deltaText);
    }, error => {
      if (this.active !== active) return;
      this.finishTurn(active, error instanceof ParentAgentError ? error : parentError('engine', String(error)));
    });
    return promise.finally(() => { if (signal) signal.removeEventListener('abort', onAbort); });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closing = true;
    this.signalUnavailable();
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.failAll(parentError('closed', 'grok parent session is closing'));
    if (this.sessionId && !this.exited) {
      await this.request('session/close', { sessionId: this.sessionId }, Math.min(2000, this.waits.closeMs), 'grok session/close')
        .catch(() => undefined);
    }
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
      const timer = startTimer(ms, 'grok scope close', error => { remove(); reject(error); });
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

export async function startGrokParentSession(prepared: PreparedParentAgent, waits: GrokParentWaits): Promise<ParentAgentSession> {
  return GrokParentSession.start(prepared, waits);
}
