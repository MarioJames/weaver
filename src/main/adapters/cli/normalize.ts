import type { WorkerRecord } from '../../../shared/contracts/tasks';
import type { RealEngineKind } from '../../../shared/contracts/tasks';
import { redactSecrets } from '../../../shared/redact';
import { clip } from './redact';

const LOG_MAX = 4000;
const ARTIFACT_MAX = 30000;
const SUMMARY_MAX = 4000;
// Match existing artifact and persisted evidence budgets. Transport snapshots
// are not retained; completed assistant text uses a bounded tail window.
const EVIDENCE_ID_MAX = 512;
const STOP_REASON_MAX = 80;
type RetainedField = 'assistant_text' | 'vendor_session_id' | 'vendor_model' | 'failure_detail' | 'stop_reason';

export interface NormalizerEvidence {
  vendorSessionId?: string;
  vendorModel?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  terminal: 'pending' | 'success' | 'error' | 'cancelled' | 'missing' | 'truncated';
  assistantText: string;
}

interface MutableEvidence extends NormalizerEvidence {
  vendorTerminal: boolean;
  /** Pi has emitted agent_end or a non-aborted agent_settled. That alone is not a completed turn. */
  sessionClosed?: boolean;
  stopReason?: string;
  failure?: string;
  /** Bounded vendor reason kept on the failure log. Not a success signal. */
  failureDetail?: string;
  assistantClipped: boolean;
  clipped: Partial<Record<RetainedField, { limit: number; observedAtLeast: number }>>;
  /** dsh callId → tool name for this run, bounded to avoid unbounded growth. */
  dshTools?: Map<string, string>;
}

function record(type: 'log' | 'progress', message: string, percent?: number): WorkerRecord {
  const text = clip(redactSecrets(message), LOG_MAX);
  return type === 'progress' ? { type: 'progress', percent: percent ?? 0, message: text } : { type: 'log', message: text };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

function rememberUsage(state: MutableEvidence, input: unknown, output: unknown): void {
  const inputTokens = integer(input);
  const outputTokens = integer(output);
  if (inputTokens === undefined && outputTokens === undefined) return;
  state.usage = { ...state.usage, ...inputTokens === undefined ? {} : { inputTokens }, ...outputTokens === undefined ? {} : { outputTokens } };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    const item = asRecord(part);
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('');
}

function noteFailure(state: MutableEvidence, detail: string): void {
  const text = detail.trim();
  if (!text || state.failureDetail) return;
  noteClipped(state, 'failure_detail', text.length, LOG_MAX);
  state.failureDetail = clip(redactSecrets(text), LOG_MAX);
}

function noteClipped(state: MutableEvidence, field: RetainedField, length: number, limit: number): void {
  if (length > limit) state.clipped[field] = { limit, observedAtLeast: limit + 1 };
}

function identifier(state: MutableEvidence, field: 'vendor_model' | 'vendor_session_id', value: string): string | undefined {
  noteClipped(state, field, value.length, EVIDENCE_ID_MAX);
  // A shortened identifier would not be a vendor-reported ID/model. Leave it
  // unknown and report omission rather than persisting an invented value.
  return value.length <= EVIDENCE_ID_MAX ? value : undefined;
}

function stopReason(state: MutableEvidence, value: string): string {
  noteClipped(state, 'stop_reason', value.length, STOP_REASON_MAX);
  return value.length <= STOP_REASON_MAX ? value : 'unknown';
}

function rememberAssistant(state: MutableEvidence, text: string, append = false): void {
  // Redact the complete completed message before selecting a window; slicing a
  // raw credential at the window boundary would leave an unrecognizable tail.
  const safe = redactSecrets(text);
  const separator = append && state.assistantText ? '\n' : '';
  const length = (append ? state.assistantText.length : 0) + separator.length + safe.length;
  noteClipped(state, 'assistant_text', length, ARTIFACT_MAX);
  state.assistantClipped = (append && state.assistantClipped) || length > ARTIFACT_MAX;
  if (safe.length >= ARTIFACT_MAX) state.assistantText = safe.slice(-ARTIFACT_MAX);
  else {
    const room = ARTIFACT_MAX - safe.length - separator.length;
    const previous = append && room > 0 ? state.assistantText.slice(-room) : '';
    state.assistantText = `${previous}${separator}${safe}`;
  }
}

function toolNote(name: unknown, status: string): WorkerRecord | undefined {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(name)) return record('log', `tool ${status}`);
  return record('log', `tool ${status} ${name}`);
}

export function createNormalizer(engine: RealEngineKind): {
  push(line: string): WorkerRecord[];
  finish(outcome: { exitCode: number | null; cancelled: boolean; truncated: boolean }): { records: WorkerRecord[]; evidence: NormalizerEvidence };
  /** The vendor session or thread id once an event has carried it, before the run ends. */
  sessionId(): string | undefined;
} {
  const state: MutableEvidence = { terminal: 'pending', assistantText: '', vendorTerminal: false, assistantClipped: false, clipped: {} };
  let unparsed = 0;
  let sawError = false;
  const push = (line: string): WorkerRecord[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { unparsed = Math.min(Number.MAX_SAFE_INTEGER, unparsed + 1); return []; }
    const event = asRecord(parsed);
    if (!event || typeof event.type !== 'string') { unparsed = Math.min(Number.MAX_SAFE_INTEGER, unparsed + 1); return []; }
    return accept(engine, state, event, () => { sawError = true; });
  };
  return {
    push,
    sessionId: () => state.vendorSessionId,
    finish(outcome) {
      const records: WorkerRecord[] = [];
      if (unparsed > 0) records.push(record('log', `ignored ${unparsed} non-JSON vendor lines`));
      for (const [field, clipped] of Object.entries(state.clipped)) records.push(record('log', `retained evidence clipped: field=${field} limitCharacters=${clipped.limit} observedCharactersAtLeast=${clipped.observedAtLeast}; assistant policy=last ${ARTIFACT_MAX} characters of completed text; oversized identifiers omitted`));
      const text = state.assistantText.trim();
      if (engine === 'pi') state.vendorTerminal = state.sessionClosed === true && state.stopReason === 'stop';
      const vendorOk = state.vendorTerminal && !sawError && !state.failure && text.length > 0;
      let terminal: NormalizerEvidence['terminal'] = 'missing';
      if (outcome.cancelled) terminal = 'cancelled';
      else if (outcome.truncated || state.stopReason === 'length' || state.stopReason === 'max_tokens') terminal = 'truncated';
      else if (sawError || state.failure || (outcome.exitCode !== 0 && outcome.exitCode !== null)) terminal = 'error';
      else if (vendorOk && outcome.exitCode === 0) terminal = 'success';
      state.terminal = terminal;
      state.assistantText = text;
      if (terminal === 'success') {
        const marker = state.assistantClipped ? '[Earlier assistant text omitted; retained bounded final text]\n' : '';
        const safeText = redactSecrets(text);
        const body = `${marker}${marker ? safeText.slice(-(ARTIFACT_MAX - marker.length)) : clip(safeText, ARTIFACT_MAX)}`;
        records.push({ type: 'artifact', name: 'result.md', mediaType: 'text/markdown', content: body });
        records.push({ type: 'result', summary: clip(body, SUMMARY_MAX) });
      } else {
        const exit = outcome.exitCode === null ? '' : ` exit ${outcome.exitCode}`;
        const detail = state.failureDetail ? `: ${state.failureDetail}` : '';
        const source = outcome.truncated ? 'local protocol' : 'vendor';
        records.push(record('log', `${source} terminal ${terminal}${exit}${detail}`));
      }
      return { records, evidence: { vendorSessionId: state.vendorSessionId, vendorModel: state.vendorModel, usage: state.usage, terminal, assistantText: text } };
    },
  };
}

function accept(engine: RealEngineKind, state: MutableEvidence, event: Record<string, unknown>, markError: () => void): WorkerRecord[] {
  switch (engine) {
    case 'pi': return acceptPi(state, event, markError);
    case 'opencode': return acceptOpencode(state, event, markError);
    case 'grok': return acceptGrok(state, event, markError);
    case 'codex': return acceptCodex(state, event, markError);
    case 'qodercli': return acceptQoder(state, event, markError);
    case 'dsh': return acceptDsh(state, event, markError);
  }
}

function acceptPi(state: MutableEvidence, event: Record<string, unknown>, markError: () => void): WorkerRecord[] {
  const out: WorkerRecord[] = [];
  if (event.type === 'session' && typeof event.id === 'string') state.vendorSessionId = identifier(state, 'vendor_session_id', event.id);
  else if (event.type === 'agent_start') out.push(record('progress', 'pi agent started', 20));
  else if (event.type === 'message_end') {
    const message = asRecord(event.message);
    if (message?.role === 'assistant') {
      if (typeof message.model === 'string') {
        const provider = typeof message.provider === 'string' ? message.provider : '';
        state.vendorModel = identifier(state, 'vendor_model', provider && !message.model.includes('/') ? `${provider}/${message.model}` : message.model);
      }
      const usage = asRecord(message.usage);
      rememberUsage(state, usage?.input, usage?.output);
      const stop = typeof message.stopReason === 'string' ? message.stopReason : '';
      state.stopReason = stopReason(state, stop);
      rememberAssistant(state, contentText(message.content));
      if (stop === 'error' || stop === 'aborted') {
        state.failure = stop;
        markError();
        noteFailure(state, textOf(message.errorMessage).trim() || 'unknown pi error');
        out.push(record('log', state.failureDetail || 'unknown pi error'));
      }
    }
  } else if (event.type === 'tool_execution_start') {
    const note = toolNote(event.toolName, 'started');
    if (note) out.push(note);
  } else if (event.type === 'tool_execution_end') {
    const note = toolNote(event.toolName, event.isError === true ? 'failed' : 'finished');
    if (note) out.push(note);
  } else if (event.type === 'agent_end') state.sessionClosed = true;
  else if (event.type === 'agent_settled') {
    if (event.aborted === true) { state.failure = 'aborted'; markError(); }
    else state.sessionClosed = true;
  }
  return out;
}

function acceptOpencode(state: MutableEvidence, event: Record<string, unknown>, markError: () => void): WorkerRecord[] {
  const out: WorkerRecord[] = [];
  if (typeof event.sessionID === 'string') state.vendorSessionId = identifier(state, 'vendor_session_id', event.sessionID);
  if (event.type === 'step_start') out.push(record('progress', 'opencode step started', 20));
  else if (event.type === 'text') {
    const part = asRecord(event.part);
    const text = textOf(part?.text);
    if (text.trim()) rememberAssistant(state, text, true);
  } else if (event.type === 'tool_use') {
    const part = asRecord(event.part);
    const toolState = asRecord(part?.state);
    const status = toolState?.status === 'error' ? 'failed' : 'finished';
    const note = toolNote(part?.tool, status);
    if (note) out.push(note);
  } else if (event.type === 'step_finish') {
    const part = asRecord(event.part);
    const tokens = asRecord(part?.tokens);
    rememberUsage(state, tokens?.input, tokens?.output);
    const reason = typeof part?.reason === 'string' ? part.reason : '';
    state.stopReason = stopReason(state, reason);
    // tool-calls and any other non-stop reason are intermediate. A later stop can still succeed.
    // error and aborted stay sticky across that later stop.
    if (reason === 'error' || reason === 'aborted') {
      state.failure = reason;
      state.vendorTerminal = false;
      markError();
    } else state.vendorTerminal = reason === 'stop' && state.failure === undefined;
  } else if (event.type === 'error') {
    state.failure = 'error';
    markError();
    const error = asRecord(event.error);
    const message = textOf(error?.message) || textOf(asRecord(error?.data)?.message) || textOf(error?.name) || 'opencode error';
    noteFailure(state, message);
    out.push(record('log', message));
  }
  return out;
}

function acceptGrok(state: MutableEvidence, event: Record<string, unknown>, markError: () => void): WorkerRecord[] {
  const out: WorkerRecord[] = [];
  if (event.type === 'system') {
    if (typeof event.session_id === 'string') state.vendorSessionId = identifier(state, 'vendor_session_id', event.session_id);
    if (typeof event.model === 'string') state.vendorModel = identifier(state, 'vendor_model', event.model);
    out.push(record('progress', 'grok session started', 20));
  } else if (event.type === 'assistant') {
    const message = asRecord(event.message);
    if (typeof message?.model === 'string') state.vendorModel = identifier(state, 'vendor_model', message.model);
    const usage = asRecord(message?.usage);
    rememberUsage(state, usage?.input_tokens, usage?.output_tokens);
    const text = contentText(message?.content);
    if (text.trim()) rememberAssistant(state, text);
    if (typeof message?.stop_reason === 'string') state.stopReason = stopReason(state, message.stop_reason);
  } else if (event.type === 'result') {
    if (typeof event.session_id === 'string') state.vendorSessionId = identifier(state, 'vendor_session_id', event.session_id);
    const usage = asRecord(event.usage);
    rememberUsage(state, usage?.input_tokens, usage?.output_tokens);
    const text = textOf(event.result);
    if (text.trim()) rememberAssistant(state, text);
    const stop = typeof event.stop_reason === 'string' ? event.stop_reason : '';
    if (stop) state.stopReason = stopReason(state, stop);
    if (event.is_error === true || event.subtype !== 'success') {
      state.failure = 'result';
      markError();
      noteFailure(state, grokFailureText(event));
      out.push(record('log', state.failureDetail || 'unknown grok error'));
    } else state.vendorTerminal = true;
  } else if (event.type === 'error') {
    state.failure = 'error';
    markError();
    out.push(record('log', textOf(event.message) || 'grok error'));
  }
  return out;
}

function grokFailureText(event: Record<string, unknown>): string {
  const parts: string[] = [];
  const result = textOf(event.result).trim();
  if (result) parts.push(result);
  const errors = event.errors;
  if (typeof errors === 'string' && errors.trim()) parts.push(errors.trim());
  else if (Array.isArray(errors)) {
    for (const item of errors) {
      if (typeof item === 'string' && item.trim()) parts.push(item.trim());
      else {
        const row = asRecord(item);
        const message = textOf(row?.message).trim() || textOf(row?.error).trim();
        if (message) parts.push(message);
      }
    }
  }
  return parts.join('; ') || 'unknown grok error';
}

function acceptCodex(state: MutableEvidence, event: Record<string, unknown>, markError: () => void): WorkerRecord[] {
  const out: WorkerRecord[] = [];
  if (event.type === 'thread.started') {
    if (typeof event.thread_id === 'string') state.vendorSessionId = identifier(state, 'vendor_session_id', event.thread_id);
    out.push(record('progress', 'codex thread started', 20));
  } else if (event.type === 'item.completed' || event.type === 'item.started') {
    const item = asRecord(event.item);
    const kind = textOf(item?.type);
    if (kind === 'agent_message' && event.type === 'item.completed') {
      const text = textOf(item?.text);
      if (text.trim()) rememberAssistant(state, text, true);
    } else if (kind && kind !== 'agent_message' && kind !== 'reasoning') {
      const note = toolNote(kind, event.type === 'item.started' ? 'started' : 'finished');
      if (note) out.push(note);
    }
  } else if (event.type === 'turn.completed') {
    const usage = asRecord(event.usage);
    rememberUsage(state, usage?.input_tokens, usage?.output_tokens);
    state.vendorTerminal = true;
    state.stopReason = 'completed';
  } else if (event.type === 'turn.failed' || event.type === 'error') {
    state.failure = event.type;
    markError();
    const error = asRecord(event.error);
    const message = textOf(event.message) || textOf(error?.message) || event.type;
    noteFailure(state, message);
    out.push(record('log', message));
  }
  return out;
}

/** qodercli stream-json follows the Claude Code shape: system init, assistant/user turns, one result. */
function acceptQoder(state: MutableEvidence, event: Record<string, unknown>, markError: () => void): WorkerRecord[] {
  const out: WorkerRecord[] = [];
  if (event.type === 'system') {
    if (event.subtype !== 'init') return out;
    if (typeof event.session_id === 'string') state.vendorSessionId = identifier(state, 'vendor_session_id', event.session_id);
    out.push(record('progress', 'qodercli session started', 20));
  } else if (event.type === 'assistant') {
    const message = asRecord(event.message);
    if (typeof message?.model === 'string') state.vendorModel = identifier(state, 'vendor_model', message.model);
    const usage = asRecord(message?.usage);
    rememberUsage(state, usage?.input_tokens, usage?.output_tokens);
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        const item = asRecord(part);
        if (item?.type === 'tool_use') { const note = toolNote(item.name, 'started'); if (note) out.push(note); }
      }
    }
    const text = contentText(message?.content);
    if (text.trim()) rememberAssistant(state, text);
    if (typeof message?.stop_reason === 'string') state.stopReason = stopReason(state, message.stop_reason);
  } else if (event.type === 'result') {
    if (typeof event.session_id === 'string') state.vendorSessionId = identifier(state, 'vendor_session_id', event.session_id);
    const usage = asRecord(event.usage);
    rememberUsage(state, usage?.input_tokens, usage?.output_tokens);
    const text = textOf(event.result);
    if (event.is_error === true || event.subtype !== 'success') {
      state.failure = 'result';
      markError();
      noteFailure(state, text.trim() || textOf(event.subtype) || 'unknown qodercli error');
      out.push(record('log', state.failureDetail || 'unknown qodercli error'));
    } else {
      if (text.trim()) rememberAssistant(state, text);
      const stop = typeof event.stop_reason === 'string' ? event.stop_reason : '';
      if (stop) state.stopReason = stopReason(state, stop);
      state.vendorTerminal = true;
    }
  } else if (event.type === 'error') {
    state.failure = 'error';
    markError();
    const message = textOf(event.message) || 'qodercli error';
    noteFailure(state, message);
    out.push(record('log', message));
  }
  return out;
}

/** Cap on the per-run dsh callId → tool map; the oldest entry is evicted past it. */
const DSH_TOOL_MAP_MAX = 50;

/**
 * dsh turn_end reason is an object shaped like {kind:'completed'}, {kind:'aborted'} or
 * {kind:'error',error:{code,message}} (dsh-headless json-stream projects turn/end verbatim,
 * and the CLI exits 0 only when reason.kind is 'completed'). A bare string is
 * accepted defensively for older fixtures.
 */
function dshTurnReason(reason: unknown): { kind: string; detail: string } {
  const shape = asRecord(reason);
  const kind = textOf(shape?.kind) || textOf(reason) || 'unknown';
  if (kind === 'error') {
    const error = asRecord(shape?.error);
    const code = textOf(error?.code).trim();
    const message = textOf(error?.message).trim();
    return { kind, detail: [code, message].filter(part => part.length > 0).join(': ') || 'unknown dsh error' };
  }
  return { kind, detail: kind === 'unknown' ? 'unknown dsh error' : kind };
}

function rememberDshTool(state: MutableEvidence, callId: unknown, tool: unknown): void {
  const id = textOf(callId);
  const name = textOf(tool);
  if (!id || !name) return;
  let map = state.dshTools;
  if (!map) { map = new Map(); state.dshTools = map; }
  if (!map.has(id) && map.size >= DSH_TOOL_MAP_MAX) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(id, name);
}

/**
 * dsh --json headless NDJSON: session, status (turn_start/step_start/step_end/turn_end),
 * thinking, text, tool_call, tool_result, then final (success path) or error (turn-outside
 * failure, no final). A failed in-turn run still ends with final (often empty) plus a
 * non-completed turn_end reason and exit 1, so the turn_end reason is the failure signal.
 * text/thinking carry committed chunks of the same answer final delivers losslessly, so only
 * final becomes the result body; intermediate chunks stay out of the retained records.
 */
function acceptDsh(state: MutableEvidence, event: Record<string, unknown>, markError: () => void): WorkerRecord[] {
  const out: WorkerRecord[] = [];
  if (event.type === 'session') {
    if (typeof event.sessionId === 'string') state.vendorSessionId = identifier(state, 'vendor_session_id', event.sessionId);
    out.push(record('progress', 'dsh session started', 20));
  } else if (event.type === 'status') {
    const phase = textOf(event.phase);
    if (phase === 'turn_start') out.push(record('progress', 'dsh turn started', 30));
    else if (phase === 'step_end') {
      const usage = asRecord(event.usage);
      if (usage) rememberUsage(state, usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens, usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens);
    } else if (phase === 'turn_end') {
      const turned = dshTurnReason(event.reason);
      state.stopReason = stopReason(state, turned.kind);
      if (turned.kind === 'completed') state.vendorTerminal = true;
      else {
        state.failure = turned.kind;
        markError();
        noteFailure(state, turned.detail);
        out.push(record('log', state.failureDetail || 'unknown dsh error'));
      }
    }
  } else if (event.type === 'tool_call') {
    rememberDshTool(state, event.callId, event.tool);
    const note = toolNote(event.tool, 'started');
    if (note) out.push(note);
  } else if (event.type === 'tool_result') {
    // A tool-level error is ordinary agent flow; only the turn_end reason fails the run.
    // tool_result carries no tool name, so resolve it through the tool_call map and
    // never fall back to the callId; unknown calls get the generic wording.
    const callId = textOf(event.callId);
    const note = toolNote(callId ? state.dshTools?.get(callId) : undefined, event.status === 'error' ? 'failed' : 'finished');
    if (note) out.push(note);
  } else if (event.type === 'final') {
    const text = textOf(event.text);
    if (text.trim()) replaceAssistant(state, text);
  } else if (event.type === 'error') {
    state.failure = 'error';
    markError();
    const message = textOf(event.message) || 'dsh error';
    noteFailure(state, message);
    out.push(record('log', message));
  }
  return out;
}

/** The lossless final answer replaces any committed chunks; intermediate text/thinking events are never retained. */
function replaceAssistant(state: MutableEvidence, text: string): void {
  const safe = redactSecrets(text);
  noteClipped(state, 'assistant_text', safe.length, ARTIFACT_MAX);
  state.assistantClipped = safe.length > ARTIFACT_MAX;
  state.assistantText = safe.length >= ARTIFACT_MAX ? safe.slice(-ARTIFACT_MAX) : safe;
}
