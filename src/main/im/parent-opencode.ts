import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { isAbsolute, relative, resolve } from 'node:path';
import { decodeLines } from '../adapters/cli/scope';
import { PublicTextBoundary } from './public-text';
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
  type ParentAgentSendOptions,
  type ParentProgressEvent,
  type PreparedParentAgent,
  type ParentProcess,
  type ParentProcessLauncher,
} from './parent-agent';

/**
 * OpenCode 2.2.x parent session (`opencode serve --hostname 127.0.0.1 --port <private>`).
 * The HTTP/SSE protocol is taken from the installed 2.2.7 `/openapi.json`, not from v1:
 * `GET /api/info`, `POST /api/session` (`{data:{id}}`), `PUT
 * /api/experimental/session/:id/instructions/entries/weaver-bootstrap`, `GET /api/event`,
 * `POST /api/session/:id/prompt` (200), `POST /api/session/:id/interrupt`
 * (`{interrupted:boolean}`), `DELETE /api/session/:id` (204), permission reply and form cancel
 * under `/api/session/:id/...`.
 *
 * The server binds only to loopback and requires the native Basic-auth password env
 * `OPENCODE_SERVER_PASSWORD` with the native username `opencode`; the random password exists only
 * in the child environment. The stdout URL is accepted only when it is exactly the preallocated
 * `http://127.0.0.1:<port>`; a different host, port or redirect is a protocol failure. No prompt is
 * sent during startup: health, session creation and the session instruction entry are the only
 * handshake requests. Each user prompt carries only the original user text; the factory-provided
 * Weaver bootstrap is attached once to the resident native session as the `weaver-bootstrap`
 * instruction entry, which 2.2.7 includes in the session's system instructions.
 *
 * Streaming uses only the 2.2 event contract: `session.text.delta`/`session.text.ended` carry
 * `assistantMessageID` and `ordinal`, reasoning has separate `session.reasoning.*` events and
 * tool calls have `session.tool.*` events, so no private part metadata is guessed. A turn settles
 * only on `session.execution.succeeded`, `session.execution.failed` or
 * `session.execution.interrupted`; `session.idle` is not a turn terminal and is ignored. A stale
 * execution terminal that arrives before this turn has bound an assistant message is ignored.
 * Multiple assistant messages in one execution are joined with a blank line; the internal
 * final-only identity check resolves only the newest terminal assistant text.
 * When `onProgress` is passed, one `开始` stage is reported when the first assistant message
 * binds, and each top-level `session.tool.input.started` reports its native `name` once per id.
 * Tool input/results, reasoning and synthetic events never enter progress or public text.
 *
 * OpenCode has no `--add-dir`; `external_directory` permission requests inside the configured
 * roots are approved once, every other permission/form request is rejected. Cross-root reads
 * therefore depend on OpenCode's native permission rules, never on a silently expanded cwd.
 */

const DENY_MESSAGE = 'The Weaver IM parent session cannot grant this permission. Allow it in the local OpenCode config and retry.';

interface ActiveTurn {
  promptAccepted: boolean;
  finalOnly: boolean;
  assistantOrder: string[];
  text: Map<string, Map<number, string>>;
  deltas: Map<string, Map<number, string>>;
  finish: Map<string, string>;
  executionStarted: boolean;
  stageEmitted: boolean;
  abortIssued?: boolean;
  abortAck?: boolean;
  terminalSeen?: boolean;
  settled: boolean;
  timer: { cancel(): void };
  cancelError?: Error;
  onDelta?: (chunk: string) => void;
  onProgress?: (event: ParentProgressEvent) => void;
  /** Native top-level tool call ids already reported this turn. */
  tools: Set<string>;
  resolve?: (value: string) => void;
  reject?: (error: Error) => void;
  boundary: PublicTextBoundary;
}

function countEdgeNewlines(value: string, fromStart: boolean): number {
  let count = 0;
  if (fromStart) {
    for (let i = 0; i < value.length && count < 2; i++) {
      if (value[i] === '\n') count++;
      else break;
    }
  } else {
    for (let i = value.length - 1; i >= 0 && count < 2; i--) {
      if (value[i] === '\n') count++;
      else break;
    }
  }
  return count;
}

function joinPublicSegments(segments: string[]): string {
  const nonEmpty = segments.filter(segment => segment.length > 0);
  if (!nonEmpty.length) return '';
  let out = nonEmpty[0]!;
  for (let i = 1; i < nonEmpty.length; i++) {
    const next = nonEmpty[i]!;
    const need = Math.max(0, 2 - countEdgeNewlines(out, false) - countEdgeNewlines(next, true));
    out += '\n'.repeat(need) + next;
  }
  return out;
}

export interface OpenCodeParentWaits {
  startupMs: number;
  turnMs: number;
  closeMs: number;
  launch: ParentProcessLauncher;
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => port ? resolvePort(port) : reject(new Error('no port')));
    });
  });
}

function insideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

function dataOf(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = event.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
}

export class OpenCodeParentSession implements ParentAgentSession {
  private readonly scope: ParentProcess;
  private signalUnavailable!: () => void;
  readonly unavailable = new Promise<void>(resolve => { this.signalUnavailable = resolve; });
  private readonly lines: ReturnType<typeof decodeLines>;
  private readonly stderrTail: string[] = [];
  private readonly sse = new AbortController();
  private baseUrl = '';
  private sessionId?: string;
  private active?: ActiveTurn;
  private closed = false;
  private closing = false;
  private exited = false;
  private sawScopeClose = false;
  private closePromise?: Promise<void>;
  private lastScopeError?: string;
  private sseStarted = false;
  private ready = false;
  private startupResolve!: () => void;
  private startupReject!: (error: Error) => void;
  private readonly startup = new Promise<void>((resolve, reject) => { this.startupResolve = resolve; this.startupReject = reject; });
  private sseReadyResolve!: () => void;
  private sseReadyReject!: (error: Error) => void;
  private readonly sseReady = new Promise<void>((resolve, reject) => { this.sseReadyResolve = resolve; this.sseReadyReject = reject; });
  private constructor(
    private readonly prepared: PreparedParentAgent,
    private readonly waits: OpenCodeParentWaits,
    private readonly port: number,
    private readonly password: string,
  ) {
    const opencodePath = requireExecutable('opencode');
    this.baseUrl = `http://127.0.0.1:${port}`;
    void this.sseReady.catch(() => { /* startup owns the primary failure */ });
    this.scope = waits.launch([
      opencodePath, 'serve',
      '--hostname', '127.0.0.1',
      '--port', String(port),
    ], prepared.workspace, { OPENCODE_SERVER_PASSWORD: password });
    this.lines = decodeLines(
      line => this.handleStdout(line),
      detail => this.startupFail(parentError('protocol', `opencode protocol frame exceeded limit: phase=${detail.phase} observedBytes=${detail.observedBytes}`)),
    );
    this.scope.stdout.on('data', (chunk: Buffer) => this.lines.write(chunk));
    this.scope.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString('utf8'));
      if (this.stderrTail.length > 8) this.stderrTail.shift();
    });
    this.scope.on('error', error => {
      this.lastScopeError = error instanceof Error ? error.message : String(error);
      this.startupFail(parentError('engine', `opencode parent scope failed: ${this.lastScopeError}`));
      if (this.sseStarted) this.failSession(parentError('engine', `opencode server failed${this.failureDetail()}`));
    });
    this.scope.on('close', () => {
      this.signalUnavailable();
      this.sawScopeClose = true;
      this.exited = true;
      if (!this.ready) this.startupFail(parentError('engine', `opencode server exited during startup${this.failureDetail()}`));
      this.failAll(parentError('engine', `opencode server exited${this.failureDetail()}`));
      if (!this.closed) void this.close().catch(() => { /* close owns resource reporting */ });
    });
  }

  static async start(prepared: PreparedParentAgent, waits: OpenCodeParentWaits): Promise<OpenCodeParentSession> {
    const port = await allocateLoopbackPort();
    const session = new OpenCodeParentSession(prepared, waits, port, randomBytes(24).toString('base64url'));
    try {
      await session.startServer();
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

  private startupFail(error: ParentAgentError): void {
    if (this.ready) return;
    this.startupReject(error);
    this.sseReadyReject(error);
    this.signalUnavailable();
  }

  private handleStdout(line: string): void {
    if (this.ready) return;
    const prefix = 'server listening on ';
    if (!line.startsWith(prefix)) return;
    const url = line.slice(prefix.length).trim();
    if (url !== this.baseUrl) {
      this.startupFail(parentError('protocol', 'opencode server announced an unexpected address; refusing to send credentials'));
      return;
    }
    this.startupResolve();
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`;
  }

  private async request(path: string, init: RequestInit, ms: number, label: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { authorization: this.authHeader(), 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (controller.signal.aborted) throw parentError('engine', `${label} timed out after ${ms}ms`);
      throw parentError('engine', `${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async startServer(): Promise<void> {
    const timer = startTimer(this.waits.startupMs, 'opencode startup', error => this.startupFail(error));
    try {
      await this.startup;
      const info = await this.request('/api/info', { method: 'GET' }, this.waits.startupMs, 'opencode info');
      if (info.status !== 200) throw parentError(info.status === 401 ? 'auth' : 'protocol', `opencode info returned ${info.status}`);
      const server = await this.readJson(info, this.waits.startupMs) as Record<string, unknown>;
      const version = typeof server.version === 'string' ? server.version : '';
      if (!/^2\.2\.\d+/.test(version)) {
        throw parentError('protocol', `opencode ${version || 'unknown version'} does not expose the verified 2.2 serve/session API`);
      }

      const slash = this.prepared.model.indexOf('/');
      if (slash <= 0 || slash === this.prepared.model.length - 1) throw parentError('invalid_input', 'opencode model must be provider/model');
      const providerID = this.prepared.model.slice(0, slash);
      const modelID = this.prepared.model.slice(slash + 1);
      const created = await this.request('/api/session', {
        method: 'POST',
        body: JSON.stringify({
          location: { directory: this.prepared.workspace },
          model: { providerID, id: modelID, ...(this.prepared.effort ? { variant: this.prepared.effort } : {}) },
        }),
      }, this.waits.startupMs, 'opencode session create');
      if (created.status !== 200) throw parentError(created.status === 401 ? 'auth' : 'protocol', `opencode session create returned ${created.status}`);
      const payload = await this.readJson(created, this.waits.startupMs) as Record<string, unknown>;
      const session = payload.data as Record<string, unknown> | undefined;
      const sessionId = typeof session?.id === 'string' ? session.id : '';
      if (!sessionId.startsWith('ses')) throw parentError('protocol', 'opencode session create did not include a session id');
      this.sessionId = sessionId;

      const instructions = await this.request(`/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/weaver-bootstrap`, {
        method: 'PUT',
        body: JSON.stringify({ value: this.prepared.instructions }),
      }, this.waits.startupMs, 'opencode instructions');
      if (instructions.status !== 204) throw parentError('protocol', `opencode instructions returned ${instructions.status}`);

      this.sseStarted = true;
      void this.readEvents();
      await this.sseReady;
    } finally {
      timer.cancel();
    }
  }

  private async readJson(response: Response, ms: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const text = await response.text();
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw parentError('protocol', 'opencode response exceeded the size limit');
      try { return JSON.parse(text) as unknown; }
      catch { throw parentError('protocol', 'opencode returned a non-JSON response'); }
    } catch (error) {
      if (error instanceof ParentAgentError) throw error;
      throw parentError(controller.signal.aborted ? 'engine' : 'protocol', controller.signal.aborted ? 'opencode response timed out' : 'opencode response could not be read');
    } finally { clearTimeout(timer); }
  }

  private async readEvents(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/event`, {
        method: 'GET',
        headers: { authorization: this.authHeader(), accept: 'text/event-stream' },
        signal: this.sse.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (!this.closing) {
        const failure = parentError('engine', `opencode event stream failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!this.ready) this.startupFail(failure);
        else this.failSession(failure);
      }
      return;
    }
    if (response.status !== 200 || !response.body) {
      if (!this.closing) {
        const failure = parentError(response.status === 401 ? 'auth' : 'protocol', `opencode event stream returned ${response.status}`);
        if (!this.ready) this.startupFail(failure);
        else this.failSession(failure);
      }
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 2 * 1024 * 1024) throw parentError('protocol', 'opencode event stream buffer exceeded the limit');
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index).replaceAll('\r\n', '\n');
          buffer = buffer.slice(index + 2);
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(data) as Record<string, unknown>; }
          catch { throw parentError('protocol', 'opencode event stream sent a non-JSON event'); }
          this.handleEvent(event);
        }
      }
      if (!this.closing) {
        const failure = parentError('engine', 'opencode event stream ended unexpectedly');
        if (!this.ready) this.startupFail(failure);
        else this.failSession(failure);
      }
    } catch (error) {
      if (this.closing) return;
      const failure = error instanceof ParentAgentError ? error : parentError('engine', `opencode event stream failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!this.ready) this.startupFail(failure);
      else this.failSession(failure);
    } finally {
      try { await reader.cancel(); } catch { /* stream already gone */ }
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = typeof event.type === 'string' ? event.type : '';
    const data = dataOf(event);
    if (!data) return;
    if (type === 'server.connected') {
      this.ready = true;
      this.sseReadyResolve();
      return;
    }
    if (type === 'permission.asked') { this.handlePermission(data); return; }
    if (type === 'form.created') { this.handleForm(data); return; }
    const sessionID = typeof data.sessionID === 'string' ? data.sessionID : '';
    if (!sessionID || sessionID !== this.sessionId) return;
    switch (type) {
      case 'session.execution.started': this.handleExecutionStarted(); return;
      case 'session.execution.succeeded': this.handleExecutionSucceeded(); return;
      case 'session.execution.failed': this.handleExecutionFailed(data); return;
      case 'session.execution.interrupted': this.handleExecutionInterrupted(data); return;
      case 'session.step.started': this.handleStepStarted(data); return;
      case 'session.step.ended': this.handleStepEnded(data); return;
      case 'session.step.failed': this.handleStepFailed(data); return;
      case 'session.text.delta': this.handleTextDelta(data); return;
      case 'session.text.ended': this.handleTextEnded(data); return;
      case 'session.tool.input.started': this.handleToolStarted(data); return;
      case 'session.idle': return;
      default: return;
    }
  }

  private noteAssistant(active: ActiveTurn, id: string): void {
    if (!id) return;
    if (!active.assistantOrder.includes(id)) {
      active.assistantOrder.push(id);
      active.boundary.noteBoundary();
    }
  }

  private emitProgress(active: ActiveTurn, event: ParentProgressEvent): void {
    if (this.active !== active || active.settled || active.cancelError) return;
    const callback = active.onProgress;
    if (!callback) return;
    try { callback(event); }
    catch { /* progress is best effort; the text turn owns failure reporting */ }
  }

  private emitTurnStart(active: ActiveTurn): void {
    if (active.stageEmitted) return;
    active.stageEmitted = true;
    this.emitProgress(active, { kind: 'stage', name: '开始' });
  }

  private handleExecutionStarted(): void {
    const active = this.active;
    if (!active || active.settled) return;
    active.executionStarted = true;
  }

  private handleStepStarted(data: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled) return;
    const id = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : '';
    this.noteAssistant(active, id);
    this.emitTurnStart(active);
  }

  private handleStepEnded(data: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled) return;
    const id = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : '';
    if (!id) return;
    this.noteAssistant(active, id);
    const finish = typeof data.finish === 'string' ? data.finish : '';
    if (finish) active.finish.set(id, finish);
  }

  private handleStepFailed(data: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled) return;
    const id = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : '';
    if (!id) return;
    this.noteAssistant(active, id);
    active.finish.set(id, 'error');
  }

  private handleToolStarted(data: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled || active.cancelError) return;
    const id = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : '';
    this.noteAssistant(active, id);
    this.emitTurnStart(active);
    const tool = typeof data.name === 'string' ? data.name.trim() : '';
    const callID = typeof data.id === 'string' && data.id ? data.id : '';
    if (!tool || !callID || active.tools.has(callID)) return;
    active.tools.add(callID);
    this.emitProgress(active, { kind: 'tool', name: tool });
  }

  private handleTextDelta(data: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled || active.cancelError) return;
    const id = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : '';
    const delta = typeof data.delta === 'string' ? data.delta : '';
    const ordinal = typeof data.ordinal === 'number' ? data.ordinal : 0;
    if (!id || !delta) return;
    this.noteAssistant(active, id);
    this.emitTurnStart(active);
    const rows = active.deltas.get(id) ?? new Map<number, string>();
    rows.set(ordinal, (rows.get(ordinal) ?? '') + delta);
    active.deltas.set(id, rows);
    if (!active.onDelta) return;
    try { active.onDelta(active.boundary.format(delta)); }
    catch (error) { this.failSession(parentError('engine', error instanceof Error ? error.message : String(error))); }
  }

  private handleTextEnded(data: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled || active.cancelError) return;
    const id = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : '';
    const text = typeof data.text === 'string' ? data.text : '';
    const ordinal = typeof data.ordinal === 'number' ? data.ordinal : 0;
    if (!id) return;
    this.noteAssistant(active, id);
    this.emitTurnStart(active);
    const rows = active.text.get(id) ?? new Map<number, string>();
    rows.set(ordinal, text);
    active.text.set(id, rows);
    if (!active.onDelta || !text) return;
    const accumulated = active.deltas.get(id)?.get(ordinal) ?? '';
    if (text === accumulated) return;
    if (!accumulated || text.startsWith(accumulated)) {
      const suffix = text.slice(accumulated.length);
      if (!suffix) return;
      try { active.onDelta(active.boundary.format(suffix)); }
      catch (error) { this.failSession(parentError('engine', error instanceof Error ? error.message : String(error))); }
      return;
    }
    this.failSession(parentError('protocol', 'opencode sent a divergent cumulative text snapshot'));
  }

  private handleExecutionSucceeded(): void {
    const active = this.active;
    if (!active || active.settled) return;
    // A stale terminal from an earlier execution can arrive before this turn binds anything.
    if (!active.executionStarted || !active.assistantOrder.length) return;
    if (active.cancelError) {
      active.terminalSeen = true;
      if (active.abortAck) this.confirmCancellation(active);
      return;
    }
    try {
      this.finishTurn(active, this.finalText(active));
    } catch (error) {
      const failure = error instanceof ParentAgentError ? error : parentError('engine', String(error));
      this.finishTurn(active, failure);
      if (failure.reason === 'protocol') void this.close().catch(() => {});
    }
  }

  private handleExecutionFailed(data: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled || !active.executionStarted) return;
    const error = this.classifyError(data.error);
    if (active.cancelError) {
      const type = (data.error as Record<string, unknown> | undefined)?.type;
      if ((typeof type === 'string' && /abort|interrupt/i.test(type)) || /abort|interrupt/i.test(error.message)) {
        active.terminalSeen = true;
        if (active.abortAck) this.confirmCancellation(active);
        return;
      }
      this.finishTurn(active, error);
      return;
    }
    this.finishTurn(active, error);
  }

  private handleExecutionInterrupted(data: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled) return;
    if (active.cancelError) {
      // Only an interrupt issued for this turn may confirm its cancellation.
      if (!active.abortIssued) return;
      active.terminalSeen = true;
      if (active.abortAck) this.confirmCancellation(active);
      return;
    }
    const reason = typeof data.reason === 'string' ? data.reason : 'unknown';
    this.finishTurn(active, parentError('engine', `opencode execution was interrupted (${reason})`));
  }

  private textFor(active: ActiveTurn, id: string): string {
    const rows = active.text.get(id);
    if (!rows) return '';
    return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('');
  }

  private finalText(active: ActiveTurn): string {
    const segments: Array<{ text: string; finish: string | undefined }> = [];
    for (const id of active.assistantOrder) {
      const text = this.textFor(active, id);
      if (!text) continue;
      segments.push({ text, finish: active.finish.get(id) });
    }
    if (!segments.length) throw parentError('protocol', 'opencode assistant message had no public text');
    if (active.finalOnly) {
      const terminal = [...segments].reverse().find(segment => segment.finish !== 'tool-calls' && segment.finish !== 'unknown') ?? segments[segments.length - 1]!;
      return terminal.text;
    }
    return joinPublicSegments(segments.map(segment => segment.text));
  }

  private classifyError(value: unknown): ParentAgentError {
    const error = value as Record<string, unknown> | undefined;
    const type = typeof error?.type === 'string' ? error.type : '';
    const message = typeof error?.message === 'string' ? error.message : 'opencode reported a turn error';
    const status = typeof error?.status === 'number' ? error.status : 0;
    if (status === 401 || /auth|unauthor|credential|login/i.test(type) || /auth|unauthor|credential|login/i.test(message)) {
      return parentError('auth', 'opencode provider authentication failed');
    }
    return parentError(parentFailureReason(message), `opencode turn failed: ${clipPublicText(message, 600)}`);
  }

  private finishTurn(active: ActiveTurn, outcome: string | Error): void {
    if (this.active !== active) return;
    this.active = undefined;
    active.timer.cancel();
    if (active.settled) return;
    active.settled = true;
    active.onDelta = undefined;
    active.onProgress = undefined;
    if (typeof outcome === 'string') active.resolve?.(outcome);
    else active.reject?.(outcome);
  }

  private cancelTurn(active: ActiveTurn, error: Error): void {
    if (this.active !== active || active.settled || active.cancelError) return;
    active.cancelError = error;
    active.onDelta = undefined;
    active.onProgress = undefined;
    active.timer.cancel();
    active.timer = startTimer(this.waits.closeMs, 'opencode interrupt terminal', failure => this.failSession(failure));
    if (active.promptAccepted) this.issueInterrupt(active);
  }

  private issueInterrupt(active: ActiveTurn): void {
    if (this.active !== active || active.settled || active.abortIssued || !this.sessionId) return;
    active.abortIssued = true;
    void this.request(`/api/session/${encodeURIComponent(this.sessionId)}/interrupt`, { method: 'POST' }, this.waits.closeMs, 'opencode interrupt')
      .then(async response => {
        if (response.status !== 200) throw parentError('protocol', `opencode interrupt returned ${response.status}`);
        const value = await this.readJson(response, this.waits.closeMs) as Record<string, unknown>;
        if (value?.interrupted !== true) throw parentError('engine', 'opencode did not accept the interrupt request');
        if (this.active !== active || active.settled) return;
        active.abortAck = true;
        if (active.terminalSeen) this.confirmCancellation(active);
      })
      .catch(error => {
        if (this.active === active) this.failSession(error instanceof ParentAgentError ? error : parentError('engine', String(error)));
      });
  }

  private confirmCancellation(active: ActiveTurn): void {
    if (this.active !== active || !active.abortAck || !active.terminalSeen) return;
    this.finishTurn(active, new ConfirmedParentCancellation());
  }

  private handlePermission(data: Record<string, unknown>): void {
    if (data.sessionID !== this.sessionId) return;
    const id = typeof data.id === 'string' ? data.id : '';
    if (!id) return;
    const action = typeof data.action === 'string' ? data.action : '';
    const resources = Array.isArray(data.resources) ? data.resources.filter((value): value is string => typeof value === 'string') : [];
    const allowed = action === 'external_directory' && resources.length > 0 && resources.every(resource => this.patternInsideRoots(resource));
    const body = allowed ? { decision: 'once' } : { decision: 'reject', message: DENY_MESSAGE };
    void this.request(`/api/session/${encodeURIComponent(this.sessionId!)}/permission/${encodeURIComponent(id)}/reply`, { method: 'POST', body: JSON.stringify(body) }, this.waits.closeMs, 'opencode permission reply')
      .then(response => { if (response.status !== 204 && response.status !== 200) throw parentError('engine', 'opencode permission reply failed'); })
      .catch(error => { this.failSession(error instanceof ParentAgentError ? error : parentError('engine', String(error))); });
  }

  private handleForm(data: Record<string, unknown>): void {
    const form = data.form as Record<string, unknown> | undefined;
    if (!form || form.sessionID !== this.sessionId) return;
    const id = typeof form.id === 'string' ? form.id : '';
    if (!id) return;
    void this.request(`/api/session/${encodeURIComponent(this.sessionId!)}/form/${encodeURIComponent(id)}?message=${encodeURIComponent(DENY_MESSAGE)}`, { method: 'DELETE' }, this.waits.closeMs, 'opencode form cancel')
      .then(response => { if (response.status !== 204 && response.status !== 200) throw parentError('engine', 'opencode form cancel failed'); })
      .catch(error => { this.failSession(error instanceof ParentAgentError ? error : parentError('engine', String(error))); });
  }

  private patternInsideRoots(pattern: string): boolean {
    if (!isAbsolute(pattern) || /[\x00-\x1f\x7f]/.test(pattern)) return false;
    const path = resolve(pattern);
    const roots = [this.prepared.workspace, ...(this.prepared.additionalWorkspaces ?? [])];
    return roots.some(root => insideRoot(path, root));
  }

  private failAll(error: ParentAgentError): void {
    const active = this.active;
    this.active = undefined;
    if (active) {
      active.timer.cancel();
      if (!active.settled) { active.settled = true; active.onDelta = undefined; active.onProgress = undefined; active.reject?.(error); }
    }
  }

  private failSession(error: ParentAgentError): void {
    this.signalUnavailable();
    this.failAll(error);
    if (!this.closed) void this.close().catch(() => { /* close failures surface through unavailable */ });
  }

  async send(text: string, signal?: AbortSignal, onDelta?: (chunk: string) => void, options?: ParentAgentSendOptions): Promise<string> {
    if (typeof text !== 'string' || !text.trim() || text.length > PARENT_TEXT_MAX) throw parentError('invalid_input', `send text must be 1–${PARENT_TEXT_MAX} characters`);
    if (signal?.aborted) throw abortReason(signal);
    if (this.closed) throw parentError('closed', 'opencode parent session is closed');
    if (this.exited) throw parentError('engine', `opencode server has exited${this.failureDetail()}`);
    if (this.active) throw parentError('engine', 'another send is still in progress on this session');
    if (!this.sessionId) throw parentError('protocol', 'opencode session was not started');
    const finalOnly = options?.finalAssistantOnly === true;
    const onProgress = options?.onProgress;
    const active: ActiveTurn = {
      promptAccepted: false,
      finalOnly,
      assistantOrder: [],
      text: new Map(),
      deltas: new Map(),
      finish: new Map(),
      executionStarted: false,
      stageEmitted: false,
      settled: false,
      timer: { cancel: () => undefined },
      tools: new Set<string>(),
      boundary: new PublicTextBoundary(),
      ...(!finalOnly && onDelta ? { onDelta } : {}),
      ...(!finalOnly && onProgress ? { onProgress } : {}),
    };
    const promise = new Promise<string>((resolve, reject) => { active.resolve = resolve; active.reject = reject; });
    const onAbort = () => { if (!active.settled) this.cancelTurn(active, abortReason(signal!)); };
    this.active = active;
    active.timer = startTimer(this.waits.turnMs, 'opencode turn', error => this.failSession(error));
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      // Close the tiny window between the initial check and listener registration.
      if (signal.aborted) onAbort();
    }
    void (async () => {
      try {
        const response = await this.request(
          `/api/session/${encodeURIComponent(this.sessionId!)}/prompt`,
          { method: 'POST', body: JSON.stringify({ text }) },
          this.waits.turnMs,
          'opencode prompt',
        );
        if (response.status !== 200) {
          if (response.status === 401) throw parentError('auth', 'opencode rejected the request authentication');
          throw parentError('protocol', `opencode prompt returned ${response.status}`);
        }
        const payload = await this.readJson(response, this.waits.turnMs) as Record<string, unknown>;
        const data = payload.data as Record<string, unknown> | undefined;
        if (!data || typeof data.id !== 'string' || !data.id.startsWith('msg_')) throw parentError('protocol', 'opencode prompt did not include an inbox id');
        if (this.active !== active) return;
        active.promptAccepted = true;
        if (active.cancelError) this.issueInterrupt(active);
      } catch (error) {
        if (this.active !== active) return;
        this.failSession(error instanceof ParentAgentError ? error : parentError('engine', String(error)));
      }
    })().catch(() => { /* the send promise carries the failure */ });
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
    this.failAll(parentError('closed', 'opencode parent session is closing'));
    this.sse.abort();
    if (this.sessionId && !this.exited) {
      await this.request(`/api/session/${encodeURIComponent(this.sessionId)}`, { method: 'DELETE' }, Math.min(2000, this.waits.closeMs), 'opencode session delete')
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
      const timer = startTimer(ms, 'opencode scope close', error => reject(error));
      const started = Date.now();
      const poll = setInterval(() => {
        if (this.sawScopeClose) { clearInterval(poll); timer.cancel(); resolve(true); }
        else if (Date.now() - started >= ms) { clearInterval(poll); timer.cancel(); reject(parentError('engine', 'opencode server did not exit after close')); }
      }, 25);
      poll.unref?.();
    });
  }
}

export async function startOpenCodeParentSession(prepared: PreparedParentAgent, waits: OpenCodeParentWaits): Promise<ParentAgentSession> {
  return OpenCodeParentSession.start(prepared, waits);
}
