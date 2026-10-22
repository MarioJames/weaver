import { isDeepStrictEqual } from 'node:util';
import { decodeLines } from '../adapters/cli/scope';
import { PublicTextBoundary } from './public-text';
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
 * Codex app-server parent session (protocol verified against codex-cli 0.163.0 app-server,
 * `codex app-server --listen stdio://`). One initialize handshake, one ephemeral thread per
 * session, one turn/start per send. Notifications are attributed strictly by schema:
 * turn-level frames (turn/started, turn/completed) carry `turn.id`, item-level frames
 * (item/agentMessage/delta, item/completed, error) carry `turnId`; frames without a
 * turn id belong to nothing and are dropped. Frames that arrive before the authoritative
 * turn/start response are buffered per turn id and replayed only when that exact turn id is
 * bound by the response; foreign keys are dropped, so an old turn or a missing-id frame can
 * never leak text or release the current send. Only thread/turn-matched final assistant text
 * is returned; commentary, reasoning and tool output never leave this module. Server approval
 * and input requests are answered with an explicit decline so a turn can never hang on a
 * permission prompt.
 */

const DENY_NOTE = 'Codex requested tool approval or client input that the Weaver IM parent session must not grant. The request was denied; grant the permission in the local Codex config and retry.';

interface PendingRequest {
  resolve(value: Record<string, unknown> | undefined): void;
  reject(error: ParentAgentError): void;
  timer: { cancel(): void };
}

interface ActiveTurn {
  threadId: string;
  turnId?: string;
  timer: { cancel(): void };
  settled: boolean;
  cancelError?: Error;
  interruptSent?: boolean;
  interruptDone?: boolean;
  terminal?: Record<string, unknown>;
  declineReason?: string;
  onDelta?: (chunk: string) => void;
  resolve?: (value: string) => void;
  reject?: (error: Error) => void;
  finalText?: string;
  lastPlain?: string;
  streamItemId?: string;
  boundary: PublicTextBoundary;
}

export interface CodexParentWaits {
  startupMs: number;
  turnMs: number;
  closeMs: number;
  launch: ParentProcessLauncher;
}

export class CodexParentSession implements ParentAgentSession {
  private readonly scope: ParentProcess;
  private signalUnavailable!: () => void;
  readonly unavailable = new Promise<void>(resolve => { this.signalUnavailable = resolve; });
  private readonly lines: ReturnType<typeof decodeLines>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly startupWaiters: Array<{ resolve(): void; reject(error: ParentAgentError): void }> = [];
  private readonly closeWaiters: Array<{ resolve(): void; reject(error: ParentAgentError): void; timer: { cancel(): void } }> = [];
  private readonly stderrTail: string[] = [];
  private nextRequestId = 1;
  private threadId?: string;
  private sandboxPolicy?: Record<string, unknown>;
  private serverVersion?: string;
  private active?: ActiveTurn;
  /** The turn id bound by the authoritative turn/start response; unset until then. */
  /** Frames for turns not yet bound, keyed by the turn id they claim; foreign keys are dropped at bind time. */
  private readonly preBindFrames = new Map<string, Array<{ method: string; params?: Record<string, unknown> }>>();
  private readonly settledTurnIds = new Set<string>();
  private lastScopeError?: string;
  private closed = false;
  private exited = false;
  private sawScopeClose = false;
  private closePromise?: Promise<void>;

  private constructor(private readonly prepared: PreparedParentAgent, private readonly waits: CodexParentWaits) {
    const codexPath = requireExecutable('codex');
    this.scope = waits.launch(
      [codexPath, 'app-server', '--listen', 'stdio://', '-c', `model_reasoning_effort="${prepared.effort}"`],
      prepared.workspace,
    );
    this.lines = decodeLines(
      line => this.handleLine(line),
      detail => this.failSession(parentError('protocol', `codex protocol frame exceeded limit: phase=${detail.phase} observedBytes=${detail.observedBytes}`)),
    );
    this.scope.stdout.on('data', (chunk: Buffer) => this.lines.write(chunk));
    this.scope.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString('utf8'));
      if (this.stderrTail.length > 8) this.stderrTail.shift();
    });
    this.scope.on('error', error => { this.lastScopeError = error instanceof Error ? error.message : String(error); this.failSession(parentError('engine', this.lastScopeError)); });
    this.scope.on('close', () => {
      this.signalUnavailable();
      this.sawScopeClose = true;
      this.exited = true;
      this.failAll(parentError('engine', `codex app-server exited${this.failureDetail()}`));
      for (const waiter of this.closeWaiters.splice(0)) {
        waiter.timer.cancel();
        waiter.resolve();
      }
    });
  }

  static async start(prepared: PreparedParentAgent, waits: CodexParentWaits): Promise<CodexParentSession> {
    const session = new CodexParentSession(prepared, waits);
    try {
      await session.handshake();
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
    if (this.exited) throw parentError('engine', 'codex app-server has exited');
    if (this.closed) throw parentError('closed', 'codex parent session is closed');
    if (!this.scope.stdin || this.scope.stdin.destroyed) throw parentError('engine', 'parent CLI stdin is unavailable');
    this.scope.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private request(method: string, params: Record<string, unknown>, ms: number, label: string): Promise<Record<string, unknown> | undefined> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = startTimer(ms, `${label} request`, error => {
        this.pending.delete(id);
        reject(error);
      });
      this.pending.set(id, {
        resolve: value => { timer.cancel(); resolve(value); },
        reject: error => { timer.cancel(); reject(error); },
        timer,
      });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        timer.cancel();
        reject(error instanceof ParentAgentError ? error : parentError('engine', String(error)));
      }
    });
  }

  private respond(id: number | string, result: Record<string, unknown>): void {
    try { this.write({ jsonrpc: '2.0', id, result }); } catch { /* the process is gone; the failure path owns reporting */ }
  }

  private respondError(id: number | string, message: string): void {
    try { this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: clipPublicText(message, 400) } }); } catch { /* the process is gone */ }
  }

  private waitForStartup(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = startTimer(this.waits.startupMs, 'codex startup', error => {
        remove();
        reject(error);
      });
      const entry = {
        resolve: () => { timer.cancel(); remove(); resolve(); },
        reject: (error: ParentAgentError) => { timer.cancel(); remove(); reject(error); },
      };
      const remove = () => {
        const index = this.startupWaiters.indexOf(entry);
        if (index >= 0) this.startupWaiters.splice(index, 1);
      };
      this.startupWaiters.push(entry);
    });
  }

  private async handshake(): Promise<void> {
    const init = await this.request('initialize', { clientInfo: { name: 'weaver-im-parent', title: 'Weaver IM parent agent', version: '0.5.0' } }, this.waits.startupMs, 'codex initialize');
    const userAgent = typeof init?.userAgent === 'string' ? init.userAgent : '';
    const match = /\/(\d+\.\d+\.\d+)/.exec(userAgent);
    this.serverVersion = match?.[1];
    this.write({ jsonrpc: '2.0', method: 'initialized' });
    let effectiveConfig: Record<string, unknown> | undefined;
    const config: Record<string, unknown> = { model_reasoning_effort: this.prepared.effort };
    if (this.prepared.additionalWorkspaces?.length) {
      const read = await this.request('config/read', { cwd: this.prepared.workspace, includeLayers: false }, this.waits.startupMs, 'codex config/read');
      const effective = read?.config as Record<string, unknown> | undefined;
      if (!effective || typeof effective !== 'object' || Array.isArray(effective)) throw parentError('protocol', 'codex effective project config is unavailable');
      effectiveConfig = effective;
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(String(effective.sandbox_mode)) || effective.approval_policy == null) throw parentError('protocol', 'codex effective permissions cannot be verified for additional workspaces');
      if (effective.sandbox_mode === 'workspace-write') {
        const section = effective.sandbox_workspace_write as Record<string, unknown> | undefined;
        if (section != null && (typeof section !== 'object' || Array.isArray(section))) throw parentError('protocol', 'codex effective workspace policy is invalid');
        const roots = section?.writable_roots ?? [];
        if (!Array.isArray(roots) || !roots.every(root => typeof root === 'string')) throw parentError('protocol', 'codex effective writable roots are invalid');
        config.sandbox_workspace_write = { ...section, writable_roots: [...new Set([...roots, ...this.prepared.additionalWorkspaces])] };
      }
    }
    const started = await this.request('thread/start', {
      ephemeral: true,
      developerInstructions: this.prepared.instructions,
      cwd: this.prepared.workspace,
      model: this.prepared.model,
      config,
    }, this.waits.startupMs, 'codex thread/start');
    const threadId = (started?.thread as Record<string, unknown> | undefined)?.id;
    if (typeof threadId !== 'string' || !threadId) {
      throw parentError('protocol', 'codex thread/start response did not include a thread id; the app-server protocol is not compatible');
    }
    if (this.prepared.additionalWorkspaces?.length) {
      const policy = started?.sandbox as Record<string, unknown> | undefined;
      const expectedType = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }[String(effectiveConfig?.sandbox_mode)];
      if (!isDeepStrictEqual(started?.approvalPolicy, effectiveConfig?.approval_policy) || effectiveConfig?.approvals_reviewer != null && started?.approvalsReviewer !== effectiveConfig.approvals_reviewer) throw parentError('protocol', 'codex effective approval policy changed during startup');
      if (policy?.type !== expectedType) throw parentError('protocol', 'codex effective sandbox mode changed during startup');
      if (!policy || typeof policy !== 'object' || !['workspaceWrite', 'dangerFullAccess', 'readOnly', 'externalSandbox'].includes(String(policy.type))) {
        throw parentError('protocol', 'codex did not report a recognized effective sandbox policy');
      }
      if (policy.type === 'workspaceWrite') {
        if (!Array.isArray(policy.writableRoots) || !policy.writableRoots.every(root => typeof root === 'string')) throw parentError('protocol', 'codex effective writable roots are invalid');
        const expectedSection = config.sandbox_workspace_write as Record<string, unknown>;
        for (const [snake, camel] of [['network_access', 'networkAccess'], ['exclude_slash_tmp', 'excludeSlashTmp'], ['exclude_tmpdir_env_var', 'excludeTmpdirEnvVar']]) {
          if ((policy[camel] ?? false) !== (expectedSection[snake] ?? false)) throw parentError('protocol', 'codex effective workspace restrictions changed during startup');
        }
        const actualRoots = policy.writableRoots as string[];
        const allowedRoots = new Set([...(expectedSection.writable_roots as string[]), this.prepared.workspace]);
        if (actualRoots.some(root => !allowedRoots.has(root))) throw parentError('protocol', 'codex added an unexpected writable root during startup');
        if ((expectedSection.writable_roots as string[]).some(root => !actualRoots.includes(root))) throw parentError('protocol', 'codex did not retain the effective writable roots');
        if (this.prepared.additionalWorkspaces.some(root => !actualRoots.includes(root))) throw parentError('protocol', 'codex did not retain the requested additional workspace roots');
        this.sandboxPolicy = { ...policy };
      }
    }
    this.threadId = threadId;
    for (const waiter of this.startupWaiters.splice(0)) waiter.resolve();
  }

  private failAll(error: ParentAgentError): void {
    for (const waiter of this.startupWaiters.splice(0)) waiter.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.preBindFrames.clear();
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

  private failSession(error: ParentAgentError): void {
    this.signalUnavailable();
    this.failAll(error);
    void this.close().catch(() => { /* close remains observable to callers */ });
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.failSession(parentError('protocol', `codex app-server sent a non-JSON protocol line: ${clipPublicText(line, 200)}`));
      return;
    }
    if (frame && frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const pending = this.pending.get(frame.id as number);
      if (!pending) return;
      this.pending.delete(frame.id as number);
      if (frame.error !== undefined) {
        const error = frame.error as Record<string, unknown>;
        pending.reject(parentError('protocol', `codex rejected the request: ${String(error.message ?? 'unknown error')} ${clipPublicText(JSON.stringify(error.data ?? ''), 600)}`));
      } else {
        pending.resolve(frame.result as Record<string, unknown> | undefined);
      }
      return;
    }
    if (frame && typeof frame.method === 'string') {
      if (frame.id !== undefined) this.answerServerRequest(frame.id as number | string, frame.method);
      else this.handleNotification(frame.method, frame.params as Record<string, unknown> | undefined);
      return;
    }
    this.failSession(parentError('protocol', `codex app-server sent an unrecognized protocol frame: ${clipPublicText(line, 200)}`));
  }

  /** Every server request gets an explicit answer; approval-shaped ones are declined, never approved. */
  private answerServerRequest(id: number | string, method: string): void {
    const decline = (result: Record<string, unknown>) => {
      this.noteDecline();
      this.respond(id, result);
    };
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval':
        decline({ decision: 'cancel' });
        return;
      case 'execCommandApproval':
        decline({ decision: 'abort' });
        return;
      default:
        this.noteDecline();
        this.respondError(id, `Weaver IM parent session does not support codex server request ${method}`);
    }
  }

  private noteDecline(): void {
    const active = this.active;
    if (active && !active.settled) active.declineReason = DENY_NOTE;
  }

  /** Turn ids whose terminal frame was already consumed while their slot was abandoned. */
  private rememberSettledTurn(turnId: string | undefined): void {
    if (!turnId) return;
    this.settledTurnIds.add(turnId);
    if (this.settledTurnIds.size > 16) {
      const oldest = this.settledTurnIds.values().next().value;
      if (oldest) this.settledTurnIds.delete(oldest);
    }
  }

  private handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    const active = this.active;
    if (!active) return;
    if (params?.threadId !== active.threadId) return;
    const turn = params?.turn as Record<string, unknown> | undefined;
    const turnId = method === 'turn/started' || method === 'turn/completed' ? turn?.id : params?.turnId;
    if (typeof turnId !== 'string' || !turnId || this.settledTurnIds.has(turnId)) return;
    if (!active.turnId) {
      const frames = this.preBindFrames.get(turnId) ?? [];
      if (frames.length >= 1000 || this.preBindFrames.size >= 32) {
        this.failSession(parentError('protocol', 'codex unbound turn notification buffer exceeded limit'));
        return;
      }
      frames.push({ method, params });
      this.preBindFrames.set(turnId, frames);
      return;
    }
    if (turnId !== active.turnId) return;
    switch (method) {
      case 'turn/started': {
        const turn = params?.turn as Record<string, unknown> | undefined;
        return;
      }
      case 'item/agentMessage/delta': {
        if (typeof params?.delta === 'string' && params.delta && active.onDelta && !active.cancelError) {
          // 独立 agentMessage item 切换时补段落分隔；同一 item 内 token 原样连接。
          // 无 itemId 的帧视为传输分片，不做边界判断。
          const itemId = typeof params?.itemId === 'string' && params.itemId ? params.itemId : undefined;
          if (itemId && active.streamItemId !== itemId) {
            if (active.streamItemId !== undefined) active.boundary.noteBoundary();
            active.streamItemId = itemId;
          }
          this.forwardDelta(active, params.delta);
        }
        return;
      }
      case 'item/completed': {
        const item = params?.item as Record<string, unknown> | undefined;
        if (item?.type !== 'agentMessage' || typeof item.text !== 'string' || !item.text.trim()) return;
        if (item.phase === 'final_answer') active.finalText = item.text;
        else if (item.phase == null) active.lastPlain = item.text;
        return;
      }
      case 'turn/completed': {
        const turn = params?.turn as Record<string, unknown> | undefined;
        if (active.turnId && typeof turn?.id === 'string' && turn.id !== active.turnId) return;
        if (!active.turnId && typeof turn?.id === 'string' && this.settledTurnIds.has(turn.id)) return;
        this.finishTurn(active, turn);
        return;
      }
      case 'error': {
        if (params?.willRetry === true) return;
        const error = params?.error as Record<string, unknown> | undefined;
        const message = typeof error?.message === 'string' && error.message ? error.message : 'codex reported a turn error';
        this.failSession(parentError('engine', message));
        return;
      }
      default:
        return;
    }
  }

  private forwardDelta(active: ActiveTurn, chunk: string): void {
    const callback = active.onDelta;
    if (!callback) return;
    try {
      callback(active.boundary.format(chunk));
    } catch (error) {
      this.failSession(parentError('engine', error instanceof Error ? error.message : String(error)));
    }
  }

  /** Deliver the terminal outcome and release the turn slot. */
  private finishTurn(active: ActiveTurn, turn: Record<string, unknown> | undefined): void {
    if (this.active !== active) return;
    if (active.cancelError && !active.interruptDone) {
      active.terminal = turn;
      return;
    }
    this.active = undefined;
    this.preBindFrames.clear();
    this.rememberSettledTurn(active.turnId);
    active.timer.cancel();
    active.settled = true;
    active.onDelta = undefined;
    if (active.cancelError) { active.reject?.(new ConfirmedParentCancellation()); return; }
    const status = turn?.status;
    if (status === 'completed') {
      const fallback = this.finalTextFromItems(turn);
      const text = active.finalText ?? (active.lastPlain?.trim() ? active.lastPlain : undefined) ?? fallback;
      if (typeof text === 'string' && text.trim()) active.resolve?.(text);
      else {
        active.reject?.(parentError('protocol', 'codex turn completed without a final assistant message'));
        void this.close().catch(() => {});
      }
      return;
    }
    if (status === 'failed') {
      const error = turn?.error as Record<string, unknown> | undefined;
      const message = typeof error?.message === 'string' && error.message ? error.message : 'codex turn failed';
      active.reject?.(parentError('engine', `codex turn failed: ${message}${this.failureDetail()}`));
      return;
    }
    if (status === 'interrupted') {
      active.reject?.(parentError('engine', active.declineReason ?? 'codex turn was interrupted'));
      return;
    }
    active.reject?.(parentError('protocol', `codex turn ended with unexpected status ${String(status)}`));
    void this.close().catch(() => {});
  }

  private finalTextFromItems(turn: Record<string, unknown> | undefined): string | undefined {
    const items = Array.isArray(turn?.items) ? turn.items as Array<Record<string, unknown>> : [];
    let lastPlain: string | undefined;
    let finalAnswer: string | undefined;
    for (const item of items) {
      if (item?.type !== 'agentMessage' || typeof item.text !== 'string') continue;
      if (item.phase === 'final_answer') finalAnswer = item.text;
      else if (item.phase == null) lastPlain = item.text;
    }
    return finalAnswer ?? lastPlain;
  }

  private cancelTurn(active: ActiveTurn, error: Error): void {
    if (this.active !== active || active.settled || active.cancelError) return;
    active.cancelError = error;
    active.onDelta = undefined;
    active.timer.cancel();
    active.timer = startTimer(this.waits.closeMs, 'codex interrupt terminal', failure => this.failSession(failure));
    this.interruptActive(active);
  }

  private interruptActive(active: ActiveTurn): void {
    if (this.active !== active || !active.turnId || !active.cancelError || active.interruptSent) return;
    active.interruptSent = true;
    void this.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, this.waits.closeMs, 'codex turn/interrupt').then(() => {
      active.interruptDone = true;
      if (active.terminal) this.finishTurn(active, active.terminal);
    }, error => { if (this.active === active) this.failSession(error); });
  }

  async send(text: string, signal?: AbortSignal, onDelta?: (chunk: string) => void): Promise<string> {
    if (typeof text !== 'string' || !text.trim() || text.length > PARENT_TEXT_MAX) throw parentError('invalid_input', `send text must be 1–${PARENT_TEXT_MAX} characters`);
    if (signal?.aborted) throw abortReason(signal);
    if (this.closed) throw parentError('closed', 'codex parent session is closed');
    if (this.exited) throw parentError('engine', `codex app-server has exited${this.failureDetail()}`);
    if (this.active) throw parentError('engine', 'another send is still in progress on this session');
    if (typeof this.threadId !== 'string') throw parentError('protocol', 'codex session was not started');
    const active: ActiveTurn = {
      threadId: this.threadId,
      timer: { cancel: () => undefined },
      settled: false,
      boundary: new PublicTextBoundary(),
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
    active.timer = startTimer(this.waits.turnMs, 'codex turn', error => this.failSession(error));
    this.active = active;
    void (async () => {
      try {
        const response = await this.request('turn/start', {
          threadId: this.threadId,
          input: [{ type: 'text', text }],
          effort: this.prepared.effort,
          ...(this.sandboxPolicy ? { sandboxPolicy: this.sandboxPolicy } : {}),
        }, this.waits.turnMs, 'codex turn/start');
        if (this.active !== active) return;
        const turnId = (response?.turn as Record<string, unknown> | undefined)?.id;
        if (typeof turnId !== 'string' || !turnId || this.settledTurnIds.has(turnId)) {
          throw parentError('protocol', 'codex turn/start response did not include a valid new turn id');
        }
        active.turnId = turnId;
        const frames = this.preBindFrames.get(turnId) ?? [];
        this.preBindFrames.clear();
        this.interruptActive(active);
        for (const frame of frames) this.handleNotification(frame.method, frame.params);
      } catch (error) {
        if (this.active === active) this.failSession(error instanceof ParentAgentError ? error : parentError('engine', String(error)));
      }
    })().catch(() => { /* the send promise below already carries the failure */ });
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
    this.failAll(parentError('closed', 'codex parent session is closing'));
    try { this.scope.stdin?.end(); } catch { /* stdin may already be gone */ }
    if (!this.sawScopeClose) {
      const graceful = await this.waitForScopeClose(Math.min(2000, this.waits.closeMs)).catch(() => false);
      if (!graceful) {
        this.scope.kill('SIGTERM');
        await this.waitForScopeClose(this.waits.closeMs);
      }
    }
  }

  private waitForScopeClose(ms: number): Promise<boolean> {
    if (this.sawScopeClose) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      const timer = startTimer(ms, 'codex scope close', error => {
        remove();
        reject(error);
      });
      const entry = {
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

export async function startCodexParentSession(prepared: PreparedParentAgent, waits: CodexParentWaits): Promise<ParentAgentSession> {
  return CodexParentSession.start(prepared, waits);
}
