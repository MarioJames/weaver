import { randomBytes, randomUUID } from 'node:crypto';
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
  type PreparedParentAgent,
  type ParentProcess,
  type ParentProcessLauncher,
} from './parent-agent';

/**
 * OpenCode parent session (`opencode serve --hostname 127.0.0.1 --port <private> --pure`).
 * The HTTP/SSE protocol is taken from the installed 1.19.3 `/doc` OpenAPI schema, not from an
 * older SDK: `GET /global/health`, `POST /session`, `GET /event`, `POST /session/:id/prompt_async`
 * (204), `POST /session/:id/abort` (boolean), `GET /session/:id/message`, and `DELETE /session/:id`.
 *
 * The server binds only to loopback and requires the native Basic-auth password env
 * `OPENCODE_SERVER_PASSWORD` with the native username `opencode`; the random password exists only
 * in the child environment. The stdout URL is accepted only when it is exactly the preallocated
 * `http://127.0.0.1:<port>`; a different host, port or redirect is a protocol failure. No prompt is
 * sent during startup: health and session creation are the only handshake requests. Each user
 * prompt carries the factory-provided Weaver bootstrap in the native `system` field (the same
 * `prompt_async` request body as the message endpoint), while `parts` stays the original user text.
 *
 * Every assistant delta is attributed by the native `messageID`/`parentID` pair and by the
 * original part metadata: only a `type: "text"` part that is neither `synthetic` nor `ignored`
 * on the current-turn assistant is public. Reasoning, tool, subtask, synthetic/ignored text and
 * foreign-session parts are dropped. A delta whose part metadata has not arrived yet is kept in
 * a bounded per-turn buffer until that metadata confirms public text; private metadata discards
 * it. Cumulative `part.updated` snapshots subtract the already-streamed suffix, and a divergent
 * snapshot fails closed. Buffered updates replay with their original type/flags, never rebuilt
 * as public text.
 * `session.idle` alone settles nothing: a success turn also needs the newest current-turn
 * assistant message fetched from the authoritative message list to show a native terminal, and
 * a cancellation needs the bound message to show a native stop after the abort ACK plus
 * `session.idle`. Stale or repeated `session.idle` for the same session never settles the
 * current turn alone.
 *
 * Native 1.19.3 terminal semantics (verified against the installed server's `/doc` OpenAPI,
 * a zero-prompt `serve` probe, and the producer/loop guards in the shipped binary):
  * `AssistantMessage.time.completed` is optional and only ends one assistant step — an
  * intermediate tool step is stored completed with `finish: "tool-calls"` while the turn keeps
  * running under the same prompt message (native treats `"unknown"` the same way). A message is
  * therefore terminal only with `error` set, or with `time.completed` plus an explicit non-empty
  * `finish` outside `{"tool-calls", "unknown"}`. A completed observation without `finish`
  * (missing, empty or non-string) is insufficient — never success, never a confirmed stop — and
  * the turn keeps the existing bounded wait for the true terminal instead of settling early.
  * `SessionStatus` is `idle | busy | retry`; `GET
 * /session/status` returns `{}` when nothing runs, so a missing key is idle-equivalent and
 * `busy`/`retry` can never prove completion or stop — `session.status` events carry no
 * turn/message id and are intentionally never stored (the old `lastStatus` cache was removed
 * as dead state rather than consulted as authority).
 * The newest current-turn assistant is picked by greatest `time.created` (later list index
 * breaks ties), never by assuming array order or by a late update to an old message, so the
 * first intermediate tool assistant can never shadow the true tail.
 *
 * OpenCode has no `--add-dir`; `external_directory` permission requests inside the configured
 * roots are approved once, every other permission/question request is rejected. Cross-root reads
 * therefore depend on OpenCode's native permission rules, never on a silently expanded cwd.
 */

const DENY_MESSAGE = 'The Weaver IM parent session cannot grant this permission. Allow it in the local OpenCode config and retry.';

interface ActiveTurn {
  promptMessageID: string;
  promptAccepted: boolean;
  assistantMessageID?: string;
  finalOnly: boolean;
  abortIssued?: boolean;
  abortAck?: boolean;
  idleSeen?: boolean;
  sawPart?: boolean;
  finalizing?: boolean;
  dirty?: boolean;
  settled: boolean;
  timer: { cancel(): void };
  cancelError?: Error;
  error?: ParentAgentError;
  onDelta?: (chunk: string) => void;
  resolve?: (value: string) => void;
  reject?: (error: Error) => void;
  boundary: PublicTextBoundary;
}

interface BufferedPart {
  event: 'delta' | 'update';
  partID: string;
  messageID: string;
  text?: string;
  part?: Record<string, unknown>;
}

interface PendingDelta {
  partID: string;
  messageID: string;
  text: string;
}

interface PartQualification {
  messageID: string;
  partID: string;
  public: boolean;
}

function publicTextOfEntry(entry: Record<string, unknown>): string {
  const parts = Array.isArray(entry.parts) ? entry.parts as Array<Record<string, unknown>> : [];
  let out = '';
  for (const part of parts) {
    if (part?.type !== 'text' || part.synthetic === true || part.ignored === true) continue;
    if (typeof part.text !== 'string') continue;
    out += part.text;
  }
  return out;
}

function orderedByNativeTime(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aTime = (a.entry.info as Record<string, unknown> | undefined)?.time as Record<string, unknown> | undefined;
      const bTime = (b.entry.info as Record<string, unknown> | undefined)?.time as Record<string, unknown> | undefined;
      const aCreated = typeof aTime?.created === 'number' ? aTime.created : 0;
      const bCreated = typeof bTime?.created === 'number' ? bTime.created : 0;
      if (aCreated !== bCreated) return aCreated - bCreated;
      return a.index - b.index;
    })
    .map(row => row.entry);
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

export class OpenCodeParentSession implements ParentAgentSession {
  private readonly scope: ParentProcess;
  private signalUnavailable!: () => void;
  readonly unavailable = new Promise<void>(resolve => { this.signalUnavailable = resolve; });
  private readonly lines: ReturnType<typeof decodeLines>;
  private readonly stderrTail: string[] = [];
  private readonly parts = new Map<string, string>();
  private readonly buffered = new Map<string, BufferedPart[]>();
  private bufferedCount = 0;
  private readonly pendingDeltas = new Map<string, PendingDelta[]>();
  private pendingCount = 0;
  private readonly partKinds = new Map<string, PartQualification>();
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
  private startupResolve!: () => void;
  private startupReject!: (error: Error) => void;
  private readonly startup = new Promise<void>((resolve, reject) => { this.startupResolve = resolve; this.startupReject = reject; });

  private constructor(
    private readonly prepared: PreparedParentAgent,
    private readonly waits: OpenCodeParentWaits,
    private readonly port: number,
    private readonly password: string,
  ) {
    const opencodePath = requireExecutable('opencode');
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.scope = waits.launch([
      opencodePath, 'serve',
      '--hostname', '127.0.0.1',
      '--port', String(port),
      '--pure',
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
      if (!this.sseStarted) this.startupFail(parentError('engine', `opencode server exited during startup${this.failureDetail()}`));
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
    if (this.sseStarted) return;
    this.startupReject(error);
    this.signalUnavailable();
  }

  private handleStdout(line: string): void {
    if (this.sseStarted) return;
    const prefix = 'opencode server listening on ';
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
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { authorization: this.authHeader(), 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: controller.signal,
        redirect: 'error',
      });
      return response;
    } catch (error) {
      if (controller.signal.aborted) throw parentError('engine', `${label} timed out after ${ms}ms`);
      throw parentError('engine', `${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private query(includeDirectory = true): string {
    return includeDirectory ? `?directory=${encodeURIComponent(this.prepared.workspace)}` : '';
  }

  private async startServer(): Promise<void> {
    const timer = startTimer(this.waits.startupMs, 'opencode startup', error => this.startupFail(error));
    try {
      await this.startup;
    } finally {
      timer.cancel();
    }
    const health = await this.request(`/global/health${this.query(false)}`, { method: 'GET' }, this.waits.startupMs, 'opencode health');
    if (health.status !== 200) throw parentError(health.status === 401 ? 'auth' : 'protocol', `opencode health returned ${health.status}`);
    const info = await this.readJson(health, this.waits.startupMs) as Record<string, unknown>;
    if (info.healthy !== true) throw parentError('protocol', 'opencode health did not report healthy');
    const version = typeof info.version === 'string' ? info.version : '';
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match || Number(match[1]) < 1 || Number(match[1]) === 1 && Number(match[2]) < 19) {
      throw parentError('protocol', `opencode ${version || 'unknown version'} does not expose the verified serve/session API`);
    }
    const created = await this.request(`/session${this.query()}`, { method: 'POST', body: '{}' }, this.waits.startupMs, 'opencode session create');
    if (created.status !== 200) throw parentError(created.status === 401 ? 'auth' : 'protocol', `opencode session create returned ${created.status}`);
    const session = await this.readJson(created, this.waits.startupMs) as Record<string, unknown>;
    const sessionId = typeof session.id === 'string' ? session.id : '';
    if (!sessionId.startsWith('ses')) throw parentError('protocol', 'opencode session create did not include a session id');
    this.sessionId = sessionId;
    this.sseStarted = true;
    void this.readEvents();
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
    if (!this.sessionId) return;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/event${this.query()}`, {
        method: 'GET',
        headers: { authorization: this.authHeader(), accept: 'text/event-stream' },
        signal: this.sse.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (!this.closing) this.failSession(parentError('engine', `opencode event stream failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (response.status !== 200 || !response.body) {
      if (!this.closing) this.failSession(parentError(response.status === 401 ? 'auth' : 'protocol', `opencode event stream returned ${response.status}`));
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
      if (!this.closing) this.failSession(parentError('engine', 'opencode event stream ended unexpectedly'));
    } catch (error) {
      if (this.closing) return;
      this.failSession(error instanceof ParentAgentError ? error : parentError('engine', `opencode event stream failed: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      try { await reader.cancel(); } catch { /* stream already gone */ }
    }
  }

  private eventProperties(event: Record<string, unknown>): Record<string, unknown> | undefined {
    const value = event.properties ?? event.data;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = typeof event.type === 'string' ? event.type : '';
    const props = this.eventProperties(event);
    if (!props || !this.sessionId) return;
    switch (type) {
      case 'message.updated': this.handleMessageUpdated(props); return;
      case 'message.part.delta': this.handlePartDelta(props); return;
      case 'message.part.updated': this.handlePartUpdated(props); return;
      case 'message.part.removed': return;
      case 'session.idle': this.handleIdle(props); return;
      case 'session.status': this.handleStatus(props); return;
      case 'session.error': this.handleSessionError(props); return;
      case 'permission.asked': this.handlePermission(props); return;
      case 'permission.v2.asked': this.handlePermissionV2(props); return;
      case 'question.asked':
      case 'question.v2.asked': this.handleQuestion(props); return;
      default: return;
    }
  }

  private sessionMatches(props: Record<string, unknown>): boolean {
    const sessionId = typeof props.sessionID === 'string' ? props.sessionID
      : (props.info as Record<string, unknown> | undefined)?.sessionID;
    return sessionId === this.sessionId;
  }

  private handleMessageUpdated(props: Record<string, unknown>): void {
    if (!this.sessionMatches(props)) return;
    const info = props.info as Record<string, unknown> | undefined;
    const active = this.active;
    if (!info || !active || active.settled) return;
    if (info.role !== 'assistant' || info.parentID !== active.promptMessageID) return;
    const id = typeof info.id === 'string' ? info.id : '';
    if (!id.startsWith('msg')) return;
    if (!active.assistantMessageID) {
      active.assistantMessageID = id;
      this.replayBuffered(id);
    } else if (active.assistantMessageID !== id) {
      // A later tool step starts a new assistant message under the same prompt message.
      // Never keep the first intermediate assistant as the forever final: rebind to the
      // newest current-turn assistant so deltas and the final fetch follow the live tail.
      // 流式侧：新 assistant 消息的公开文本与之前段落之间补段落分隔（首段与空段除外）。
      active.boundary.noteBoundary();
      active.assistantMessageID = id;
      this.replayBuffered(id);
    }
    const time = info.time as Record<string, unknown> | undefined;
    if (typeof time?.completed === 'number') {
      if (active.cancelError) {
        if (active.abortAck && active.idleSeen) void this.verifyCancellation(active);
        return;
      }
      if (active.idleSeen && active.sawPart) void this.finalizeSuccess(active);
    }
    if (info.error) {
      if (active.cancelError) {
        if (active.abortAck && active.idleSeen) void this.verifyCancellation(active);
        return;
      }
      active.error = this.classifyError(info.error);
    }
  }

  private partKey(messageID: string, partID: string): string {
    return `${messageID}\u0000${partID}`;
  }

  private bufferedSize(): number {
    return this.bufferedCount + this.pendingCount;
  }

  private resetTurnState(): void {
    this.parts.clear();
    this.partKinds.clear();
    this.buffered.clear();
    this.bufferedCount = 0;
    this.pendingDeltas.clear();
    this.pendingCount = 0;
  }

  private bufferPart(part: BufferedPart): void {
    if (this.bufferedSize() >= 512) { this.failSession(parentError('protocol', 'opencode part buffer exceeded the limit')); return; }
    const rows = this.buffered.get(part.messageID) ?? [];
    rows.push(part);
    this.buffered.set(part.messageID, rows);
    this.bufferedCount += 1;
  }

  private bufferPendingDelta(row: PendingDelta): void {
    if (this.bufferedSize() >= 512) { this.failSession(parentError('protocol', 'opencode part buffer exceeded the limit')); return; }
    const key = this.partKey(row.messageID, row.partID);
    const rows = this.pendingDeltas.get(key) ?? [];
    rows.push(row);
    this.pendingDeltas.set(key, rows);
    this.pendingCount += 1;
  }

  private dropPending(key: string): void {
    const rows = this.pendingDeltas.get(key);
    if (!rows) return;
    this.pendingDeltas.delete(key);
    this.pendingCount -= rows.length;
  }

  private flushPending(key: string): void {
    const rows = this.pendingDeltas.get(key);
    if (!rows) return;
    this.pendingDeltas.delete(key);
    this.pendingCount -= rows.length;
    for (const row of rows) this.emitDelta(row);
  }

  private replayBuffered(messageID: string): void {
    const rows = this.buffered.get(messageID);
    if (!rows) return;
    this.buffered.delete(messageID);
    this.bufferedCount -= rows.length;
    for (const row of rows) {
      if (row.event === 'delta') this.applyDelta({ messageID: row.messageID, partID: row.partID, text: row.text ?? '' });
      else if (row.part) this.applyPartUpdate(row.part);
    }
  }

  private handlePartDelta(props: Record<string, unknown>): void {
    if (props.sessionID !== this.sessionId) return;
    if (props.field !== 'text' || typeof props.delta !== 'string' || !props.delta) return;
    const messageID = typeof props.messageID === 'string' ? props.messageID : '';
    const partID = typeof props.partID === 'string' ? props.partID : '';
    if (!messageID || !partID) return;
    const active = this.active;
    if (!active || active.settled) return;
    const row: BufferedPart = { event: 'delta', messageID, partID, text: props.delta };
    if (!active.assistantMessageID) { this.bufferPart(row); return; }
    if (messageID !== active.assistantMessageID) return;
    this.applyDelta({ messageID, partID, text: props.delta });
  }

  private applyDelta(row: PendingDelta): void {
    const active = this.active;
    if (!active || active.settled || active.cancelError) return;
    const kind = this.partKinds.get(this.partKey(row.messageID, row.partID));
    if (!kind) { this.bufferPendingDelta(row); return; }
    if (!kind.public) return;
    this.emitDelta(row);
  }

  private emitDelta(row: Pick<BufferedPart, 'partID' | 'text'>): void {
    const active = this.active;
    if (!active || active.settled || active.cancelError) return;
    const text = row.text ?? '';
    if (!text) return;
    active.sawPart = true;
    this.parts.set(row.partID, (this.parts.get(row.partID) ?? '') + text);
    if (!active.onDelta) return;
    try { active.onDelta(active.boundary.format(text)); }
    catch (error) { this.failSession(parentError('engine', error instanceof Error ? error.message : String(error))); }
  }

  private handlePartUpdated(props: Record<string, unknown>): void {
    if (props.sessionID !== this.sessionId) return;
    const part = props.part as Record<string, unknown> | undefined;
    if (!part) return;
    if (part.sessionID !== undefined && part.sessionID !== this.sessionId) return;
    const messageID = typeof part.messageID === 'string' ? part.messageID : '';
    const partID = typeof part.id === 'string' ? part.id : '';
    if (!messageID || !partID) return;
    const active = this.active;
    if (!active || active.settled) return;
    const row: BufferedPart = { event: 'update', messageID, partID, part };
    if (!active.assistantMessageID) { this.bufferPart(row); return; }
    if (messageID !== active.assistantMessageID) return;
    this.applyPartUpdate(part);
  }

  private applyPartUpdate(part: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled || active.cancelError) return;
    if (typeof part.type !== 'string' || !part.type) return;
    const messageID = typeof part.messageID === 'string' ? part.messageID : '';
    const partID = typeof part.id === 'string' ? part.id : '';
    if (!messageID || !partID) return;
    const isPublic = part.type === 'text' && part.synthetic !== true && part.ignored !== true;
    const key = this.partKey(messageID, partID);
    const known = this.partKinds.get(key);
    if (known && known.public !== isPublic) {
      this.failSession(parentError('protocol', 'opencode changed the public qualification of a part after it was observed'));
      return;
    }
    if (!known) {
      if (this.partKinds.size >= 512) { this.failSession(parentError('protocol', 'opencode part metadata exceeded the limit')); return; }
      this.partKinds.set(key, { messageID, partID, public: isPublic });
    }
    if (!isPublic) { this.dropPending(key); return; }
    this.flushPending(key);
    this.handleTextPart(part);
  }

  private handleTextPart(part: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled || active.cancelError) return;
    if (part.type !== 'text' || part.synthetic === true || part.ignored === true) return;
    const partID = typeof part.id === 'string' ? part.id : '';
    const text = typeof part.text === 'string' ? part.text : '';
    if (!partID || !text) return;
    const previous = this.parts.get(partID) ?? '';
    if (text === previous) return;
    active.sawPart = true;
    if (text.startsWith(previous)) {
      const suffix = text.slice(previous.length);
      this.parts.set(partID, text);
      if (suffix && active.onDelta) {
        try { active.onDelta(active.boundary.format(suffix)); }
        catch (error) { this.failSession(parentError('engine', error instanceof Error ? error.message : String(error))); }
      }
      return;
    }
    if (previous.startsWith(text)) return;
    this.failSession(parentError('protocol', 'opencode sent a divergent cumulative text snapshot'));
  }

  private handleSessionError(props: Record<string, unknown>): void {
    if (!this.sessionMatches(props)) return;
    const active = this.active;
    if (!active || active.settled) return;
    const raw = props.error as Record<string, unknown> | undefined;
    const data = raw?.data as Record<string, unknown> | undefined;
    if (raw?.name === 'APIError' && data?.isRetryable === true) { active.error = this.classifyError(raw); return; }
    const error = this.classifyError(raw);
    if (active.cancelError) {
      if (/abort/i.test(error.message)) return;
      this.failSession(error);
      return;
    }
    this.finishTurn(active, error);
  }

  private classifyError(value: unknown): ParentAgentError {
    const error = value as Record<string, unknown> | undefined;
    const name = typeof error?.name === 'string' ? error.name : '';
    if (name === 'ProviderAuthError') return parentError('auth', 'opencode provider authentication failed');
    if (name === 'MessageAbortedError') return parentError('engine', 'opencode turn was aborted');
    const data = error?.data as Record<string, unknown> | undefined;
    const message = typeof data?.message === 'string' ? data.message : typeof error?.message === 'string' ? error.message : 'opencode reported a turn error';
    const statusCode = typeof data?.statusCode === 'number' ? data.statusCode : 0;
    if (statusCode === 401 || /auth|unauthorized|401/i.test(message)) return parentError('auth', 'opencode provider authentication failed');
    return parentError(parentFailureReason(message), `opencode turn failed: ${clipPublicText(message, 600)}`);
  }

  private handleStatus(props: Record<string, unknown>): void {
    if (!this.active || this.active.settled || props.sessionID !== this.sessionId) return;
    // Deliberately not stored: `session.status` carries no turn or message id, a stale
    // busy/retry can arrive at any time, and GET /session/status omits idle sessions (`{}`),
    // so status can neither prove completion nor cancellation. Settlement reads the
    // authoritative message list (`finish`/`error`) instead.
  }

  private handleIdle(props: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.settled || props.sessionID !== this.sessionId) return;
    if (active.cancelError) {
      // Only an idle after this turn's abort was accepted counts; a previous turn's idle cannot confirm it.
      if (!active.abortIssued) return;
      active.idleSeen = true;
      if (active.abortAck) void this.verifyCancellation(active);
      return;
    }
    // A previous turn's idle can arrive after this prompt; require public part activity for this turn.
    if (!active.sawPart) return;
    active.idleSeen = true;
    // The authoritative message list decides: an incomplete observation waits for the true terminal.
    if (active.assistantMessageID) void this.finalizeSuccess(active);
  }

  private currentTurnEntries(list: unknown, promptMessageID: string): Array<Record<string, unknown>> {
    if (!Array.isArray(list)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const item of list) {
      const entry = item as Record<string, unknown> | undefined;
      const info = entry?.info as Record<string, unknown> | undefined;
      if (!info || info.role !== 'assistant' || info.parentID !== promptMessageID) continue;
      if (typeof info.id !== 'string' || !info.id.startsWith('msg')) continue;
      if (typeof info.sessionID === 'string' && info.sessionID !== this.sessionId) continue;
      out.push(entry as Record<string, unknown>);
    }
    return out;
  }

  private async readMessageList(): Promise<unknown> {
    const response = await this.request(`/session/${encodeURIComponent(this.sessionId!)}/message${this.query()}`, { method: 'GET' }, this.waits.closeMs, 'opencode messages');
    if (response.status !== 200) throw parentError('protocol', `opencode messages returned ${response.status}`);
    const list = await this.readJson(response, this.waits.closeMs);
    if (!Array.isArray(list)) throw parentError('protocol', 'opencode messages response was not a list');
    return list;
  }

  private messageTerminal(info: Record<string, unknown> | undefined): 'error' | 'completed' | undefined {
    if (!info) return undefined;
    if (info.error) return 'error';
    const time = info.time as Record<string, unknown> | undefined;
    if (typeof time?.completed !== 'number') return undefined;
    const finish = (info as Record<string, unknown>).finish;
    // No compatibility fallback: a missing, empty or non-string finish is one insufficient
    // observation, not a terminal state. The live 1.19.3 producer always stores an explicit
    // finish (`finish ?? "stop"` on the complete path), so waiting for it cannot stall a
    // well-formed turn; settling here would let an unfinished turn resolve early.
    if (typeof finish !== 'string' || !finish) return undefined;
    if (finish === 'tool-calls' || finish === 'unknown') return undefined;
    return 'completed';
  }

  private newestEntry(entries: Array<Record<string, unknown>>): Record<string, unknown> {
    let best = 0;
    for (let i = 1; i < entries.length; i++) {
      const created = (entries[i]!.info as Record<string, unknown> | undefined)?.time as Record<string, unknown> | undefined;
      const bestCreated = (entries[best]!.info as Record<string, unknown> | undefined)?.time as Record<string, unknown> | undefined;
      const createdMs = typeof created?.created === 'number' ? created.created : 0;
      const bestMs = typeof bestCreated?.created === 'number' ? bestCreated.created : 0;
      if (createdMs >= bestMs) best = i;
    }
    return entries[best]!;
  }

  private async finalizeSuccess(active: ActiveTurn): Promise<void> {
    if (this.active !== active) return;
    // A terminal signal that arrives while GET /message is in flight must not be swallowed:
    // it sets `dirty` so the stale snapshot below triggers one more bounded re-read instead of
    // stalling until the turn timeout. At most 3 list reads per trigger; afterwards the turn
    // keeps waiting for the next event inside the existing turn bound (no extra sleep/timeout).
    if (active.finalizing) { active.dirty = true; return; }
    active.finalizing = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        active.dirty = false;
        let list = await this.readMessageList();
        if (this.active !== active || active.settled) return;
        let entries = this.currentTurnEntries(list, active.promptMessageID);
        if (!entries.length) {
          // A previous turn's idle can arrive while this turn is still persisting its message. One bounded
          // re-read is safe because entries are still matched by native parent/message ids, and an
          // incomplete observation keeps waiting for the true terminal instead of failing closed.
          await new Promise(resolve => setTimeout(resolve, 120));
          if (this.active !== active || active.settled) return;
          list = await this.readMessageList();
          if (this.active !== active || active.settled) return;
          entries = this.currentTurnEntries(list, active.promptMessageID);
        }
        if (entries.length) {
          const latest = this.newestEntry(entries);
          const latestInfo = latest.info as Record<string, unknown> | undefined;
          const state = this.messageTerminal(latestInfo);
          if (state === 'error') {
            this.finishTurn(active, this.classifyError(latestInfo?.error));
            return;
          }
          if (state === 'completed') {
            // Native 1.19.3: only the newest current-turn assistant proves the final turn — an
            // intermediate tool assistant stays completed with `finish: "tool-calls"` while the
            // turn continues, and a completed observation without an explicit finish proves
            // nothing, so `time.completed` alone never settles success.
            // Default user turns keep the whole-turn public aggregate, segmented by real
            // assistant-message boundaries (blank line) with intra-message tokens verbatim and
            // native-time stable order. The internal identity check instead resolves only the
            // newest terminal message's public text so a progress prefix never leaks into the
            // strict marker gate.
            const text = active.finalOnly
              ? publicTextOfEntry(latest)
              : joinPublicSegments(orderedByNativeTime(entries).map(publicTextOfEntry));
            if (!text.trim()) throw parentError('protocol', 'opencode assistant message had no public text');
            if (active.cancelError) {
              active.finalizing = false;
              if (active.abortAck && active.idleSeen) void this.verifyCancellation(active);
              return;
            }
            this.finishTurn(active, text);
            return;
          }
        }
        if (!active.dirty) { active.finalizing = false; return; }
      }
      active.finalizing = false;
    } catch (error) {
      const failure = error instanceof ParentAgentError ? error : parentError('engine', String(error));
      if (failure.reason === 'auth') { this.failSession(failure); return; }
      this.finishTurn(active, failure);
      if (failure.reason === 'protocol') void this.close().catch(() => {});
    }
  }

  private async verifyCancellation(active: ActiveTurn): Promise<void> {
    // Native proof only: the boolean abort ACK plus a same-session idle is not enough, because
    // `session.idle` carries no turn/message id and a stale idle can arrive while the current
    // message is still generating (and the session may still report busy). Confirm only when the
    // bound current-turn message itself shows a native stop: `MessageAbortedError`, or
    // `time.completed` with an explicit non-empty terminal `finish` (an intermediate
    // `finish: "tool-calls"` step keeps running and never confirms, and a completed
    // observation without `finish` is equally insufficient). Otherwise keep waiting for the true terminal inside the
    // abort-terminal bound. A non-abort message error surfaces truthfully instead of confirming.
    if (this.active !== active || !active.abortAck || !active.idleSeen || !active.assistantMessageID) return;
    if (active.finalizing) { active.dirty = true; return; }
    active.finalizing = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        active.dirty = false;
        const list = await this.readMessageList();
        if (this.active !== active || active.settled) return;
        const entries = this.currentTurnEntries(list, active.promptMessageID);
        if (entries.length) {
          const latestInfo = this.newestEntry(entries).info as Record<string, unknown> | undefined;
          const state = this.messageTerminal(latestInfo);
          if (state === 'completed') {
            active.finalizing = false;
            this.confirmCancellation(active);
            return;
          }
          if (state === 'error') {
            const errorName = (latestInfo?.error as Record<string, unknown> | undefined)?.name;
            active.finalizing = false;
            if (errorName === 'MessageAbortedError') this.confirmCancellation(active);
            else this.finishTurn(active, this.classifyError(latestInfo?.error));
            return;
          }
        }
        if (!active.dirty) { active.finalizing = false; return; }
      }
      active.finalizing = false;
    } catch {
      active.finalizing = false;
    }
  }

  private confirmCancellation(active: ActiveTurn): void {
    if (this.active !== active || !active.abortAck || !active.idleSeen) return;
    this.finishTurn(active, new ConfirmedParentCancellation());
  }

  private finishTurn(active: ActiveTurn, outcome: string | Error): void {
    if (this.active !== active) return;
    this.active = undefined;
    this.resetTurnState();
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
    active.timer = startTimer(this.waits.closeMs, 'opencode abort terminal', failure => this.failSession(failure));
    if (active.promptAccepted) this.issueAbort(active);
  }

  private issueAbort(active: ActiveTurn): void {
    if (this.active !== active || active.settled || active.abortIssued || !this.sessionId) return;
    active.abortIssued = true;
    void this.request(`/session/${encodeURIComponent(this.sessionId)}/abort${this.query()}`, { method: 'POST', body: '{}' }, this.waits.closeMs, 'opencode abort')
      .then(async response => {
        if (response.status !== 200) throw parentError('protocol', `opencode abort returned ${response.status}`);
        const value = await this.readJson(response, this.waits.closeMs);
        if (value !== true) throw parentError('engine', 'opencode did not accept the abort request');
        if (this.active !== active || active.settled) return;
        active.abortAck = true;
        if (active.idleSeen) void this.verifyCancellation(active);
      })
      .catch(error => {
        if (this.active === active) this.failSession(error instanceof ParentAgentError ? error : parentError('engine', String(error)));
      });
  }

  private handlePermission(props: Record<string, unknown>): void {
    if (props.sessionID !== this.sessionId) return;
    const id = typeof props.id === 'string' ? props.id : '';
    if (!id) return;
    const permission = typeof props.permission === 'string' ? props.permission : '';
    const patterns = Array.isArray(props.patterns) ? props.patterns.filter((value): value is string => typeof value === 'string') : [];
    const allowed = permission === 'external_directory' && patterns.length > 0 && patterns.every(pattern => this.patternInsideRoots(pattern));
    const body = allowed ? { reply: 'once' } : { reply: 'reject', message: DENY_MESSAGE };
    void this.request(`/permission/${encodeURIComponent(id)}/reply${this.query()}`, { method: 'POST', body: JSON.stringify(body) }, this.waits.closeMs, 'opencode permission reply')
      .then(response => { if (response.status !== 200) throw parentError('engine', 'opencode permission reply failed'); })
      .catch(error => { this.failSession(error instanceof ParentAgentError ? error : parentError('engine', String(error))); });
  }

  private handlePermissionV2(props: Record<string, unknown>): void {
    if (props.sessionID !== this.sessionId) return;
    const id = typeof props.id === 'string' ? props.id : '';
    if (!id) return;
    void this.request(`/api/session/${encodeURIComponent(this.sessionId!)}/permission/${encodeURIComponent(id)}/reply`, { method: 'POST', body: JSON.stringify({ reply: 'reject', message: DENY_MESSAGE }) }, this.waits.closeMs, 'opencode permission v2 reply')
      .then(response => { if (response.status !== 204 && response.status !== 200) throw parentError('engine', 'opencode permission reply failed'); })
      .catch(error => { this.failSession(error instanceof ParentAgentError ? error : parentError('engine', String(error))); });
  }

  private handleQuestion(props: Record<string, unknown>): void {
    if (props.sessionID !== this.sessionId) return;
    const id = typeof props.id === 'string' ? props.id : '';
    if (!id) return;
    void this.request(`/api/session/${encodeURIComponent(this.sessionId!)}/question/${encodeURIComponent(id)}/reject`, { method: 'POST', body: '{}' }, this.waits.closeMs, 'opencode question reject')
      .then(response => { if (response.status !== 204 && response.status !== 200) throw parentError('engine', 'opencode question reject failed'); })
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
    this.resetTurnState();
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

  async send(text: string, signal?: AbortSignal, onDelta?: (chunk: string) => void, options?: ParentAgentSendOptions): Promise<string> {
    if (typeof text !== 'string' || !text.trim() || text.length > PARENT_TEXT_MAX) throw parentError('invalid_input', `send text must be 1–${PARENT_TEXT_MAX} characters`);
    if (signal?.aborted) throw abortReason(signal);
    if (this.closed) throw parentError('closed', 'opencode parent session is closed');
    if (this.exited) throw parentError('engine', `opencode server has exited${this.failureDetail()}`);
    if (this.active) throw parentError('engine', 'another send is still in progress on this session');
    if (!this.sessionId) throw parentError('protocol', 'opencode session was not started');
    const slash = this.prepared.model.indexOf('/');
    if (slash <= 0 || slash === this.prepared.model.length - 1) throw parentError('invalid_input', 'opencode model must be provider/model');
    const providerID = this.prepared.model.slice(0, slash);
    const modelID = this.prepared.model.slice(slash + 1);
    const promptMessageID = `msg_${randomUUID().replaceAll('-', '')}`;
    this.resetTurnState();
    const finalOnly = options?.finalAssistantOnly === true;
    const active: ActiveTurn = {
      promptMessageID,
      promptAccepted: false,
      finalOnly,
      settled: false,
      timer: { cancel: () => undefined },
      boundary: new PublicTextBoundary(),
      // The internal identity check resolves only the terminal message and never streams
      // public deltas; user turns keep the normal attributed stream.
      ...(!finalOnly && onDelta ? { onDelta } : {}),
    };
    const promise = new Promise<string>((resolve, reject) => { active.resolve = resolve; active.reject = reject; });
    const onAbort = () => { if (!active.settled) this.cancelTurn(active, abortReason(signal!)); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    active.timer = startTimer(this.waits.turnMs, 'opencode turn', error => this.failSession(error));
    this.active = active;
    void (async () => {
      try {
        const response = await this.request(
          `/session/${encodeURIComponent(this.sessionId!)}/prompt_async${this.query()}`,
          {
            method: 'POST',
            body: JSON.stringify({
              messageID: promptMessageID,
              model: { providerID, modelID },
              ...(this.prepared.effort ? { variant: this.prepared.effort } : {}),
              system: this.prepared.instructions,
              parts: [{ type: 'text', text }],
            }),
          },
          this.waits.turnMs,
          'opencode prompt',
        );
        if (response.status !== 204) {
          if (response.status === 401) throw parentError('auth', 'opencode rejected the request authentication');
          throw parentError('protocol', `opencode prompt_async returned ${response.status}`);
        }
        if (this.active !== active) return;
        active.promptAccepted = true;
        if (active.cancelError) this.issueAbort(active);
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
      await this.request(`/session/${encodeURIComponent(this.sessionId)}${this.query()}`, { method: 'DELETE' }, Math.min(2000, this.waits.closeMs), 'opencode session delete')
        .catch(() => undefined);
    }
    if (!this.exited) {
      await this.request('/global/dispose', { method: 'POST', body: '{}' }, Math.min(2000, this.waits.closeMs), 'opencode dispose')
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
