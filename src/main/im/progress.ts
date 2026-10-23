import { redactSecrets } from '../../shared/redact';
import type { ParentProgressEvent } from './parent-agent';

/**
 * Batched Bot progress state machine (pure logic layer).
 *
 * Observable batching contract:
 * - A `stage` event renders the fixed Markdown `*深度思考中……*`, at most once
 *   per turn. A run of consecutive `tool` events forms one batch: the first
 *   tool renders `*工具调用中……*`, the 3rd tool appends `*继续努力中……*`
 *   once, the 4th and later tools render nothing. Tool/stage names are never
 *   rendered, so thinking bodies, arguments, commands, paths, credentials and
 *   results cannot leak into status lines.
 * - Public body text tokens arrive via `{ type: 'text' }` already cleaned and
 *   displayable; they are concatenated verbatim in input order. The reducer
 *   never guesses paragraph breaks from tokens. Status and body are separated
 *   by exactly one blank line; consecutive status lines sit on adjacent lines.
 *   A body token that already starts with `\n` keeps its text untouched and
 *   only the still-missing separator is added. A token made only of newlines
 *   extends the previous trailing run (capped at 2) instead of resetting it,
 *   so no extra blank line is inserted after an existing one.
 * - Atomic batch display: opening a batch reserves one line plus the
 *   worst-case bytes for its `*调用结束*`. When the reserve does not fit, the
 *   whole batch stays silent — tools are still counted and text still flows —
 *   so every displayed start keeps its matching end and no isolated end or
 *   continue line can appear. Later statuses (the batch's own continue line,
 *   a thinking line) are shown only while the pending close still fits.
 * - Budgets (`PROGRESS_MAX_LINES`, `PROGRESS_MAX_BYTES`, single line
 *   `PROGRESS_LINE_MAX_CHARS`) cover only status fragments and the blank-line
 *   separators inserted around them. Body text is never truncated or
 *   swallowed: a status fragment that does not fit is dropped while the text
 *   still flows, falling back to no separator. The body-text byte budget
 *   lives elsewhere and is independent of this status budget.
 *
 * The reducer is pure: state enters as a parameter and is never mutated,
 * there is no I/O, and the same input sequence always yields the same output
 * sequence.
 *
 * Service calling convention: feed adapter events as
 * `{ type: 'progress', event }` (only `event.kind` is read), cleaned public
 * deltas as `{ type: 'text', text }`, and the turn end as `{ type: 'end' }`
 * (idempotent); append each returned `append` fragment to the streaming card
 * verbatim.
 */

export const PROGRESS_LINE_MAX_CHARS = 80;
export const PROGRESS_NAME_MAX_CHARS = 32;
export const PROGRESS_MAX_LINES = 20;
export const PROGRESS_MAX_BYTES = 2000;

/** Fixed status copy. No dynamic tool/stage label may ever enter these lines. */
export const PROGRESS_THINKING_LINE = '*深度思考中……*';
export const PROGRESS_TOOL_LINE = '*工具调用中……*';
export const PROGRESS_ENCOURAGE_LINE = '*继续努力中……*';
export const PROGRESS_END_LINE = '*调用结束*';

/**
 * Scrub a single adapter label: keep the last path segment, strip control and
 * card-control characters, mask credential-shaped strings, truncate to
 * `PROGRESS_NAME_MAX_CHARS`. The batch reducer ignores names entirely; this
 * stays as the shared cleaning helper.
 */
export function sanitizeProgressName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Keep only the last segment of absolute/relative paths; split on both `/` and `\`.
  const last = raw.split(/[\\/]/).pop() ?? '';
  let name = last.replace(/[\x00-\x1f\x7f]/g, '').replace(/[<>&]/g, '').trim();
  if (!name) return '';
  name = redactSecrets(name);
  if (!name) return '';
  return [...name].slice(0, PROGRESS_NAME_MAX_CHARS).join('');
}

/** Single-event fixed mapping: tool/stage kinds render their fixed lines only. */
export function formatParentProgress(event: ParentProgressEvent): string | undefined {
  if (!event || (event.kind !== 'tool' && event.kind !== 'stage')) return undefined;
  return event.kind === 'tool' ? PROGRESS_TOOL_LINE : PROGRESS_THINKING_LINE;
}

/** Immutable batch progress state. Create with `createProgressBatchState`. */
export interface ProgressBatchState {
  readonly thinkingShown: boolean;
  readonly toolOpen: boolean;
  readonly toolCount: number;
  /** Whether the open batch displayed its start line (and owns a reserved close). */
  readonly toolStartShown: boolean;
  readonly encouraged: boolean;
  readonly statusLines: number;
  readonly statusBytes: number;
  readonly hasOutput: boolean;
  /** Trailing `\n` count of the total output so far, capped at 2. */
  readonly trailingNewlines: number;
  /** True when the last emitted fragment was a status line. */
  readonly lastWasStatus: boolean;
  /** True after a turn-end; further progress events are ignored. */
  readonly closed: boolean;
}

export function createProgressBatchState(): ProgressBatchState {
  return {
    thinkingShown: false,
    toolOpen: false,
    toolCount: 0,
    toolStartShown: false,
    encouraged: false,
    statusLines: 0,
    statusBytes: 0,
    hasOutput: false,
    trailingNewlines: 0,
    lastWasStatus: false,
    closed: false,
  };
}

/**
 * Reducer inputs:
 * - `{ type: 'progress', event }`: one adapter `ParentProgressEvent`
 *   (`stage` turn-start / deduped top-level `tool`; only `kind` is read).
 * - `{ type: 'text', text }`: one already-cleaned displayable body token.
 * - `{ type: 'end' }`: turn end; closes an open tool batch.
 */
export type ProgressBatchInput =
  | { type: 'progress'; event: ParentProgressEvent }
  | { type: 'text'; text: string }
  | { type: 'end' };

export interface ProgressBatchOutput {
  readonly state: ProgressBatchState;
  /** Fragment to append to the streaming card verbatim (may be ''). */
  readonly append: string;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value);
}

function trailingCount(value: string): number {
  let count = 0;
  for (let i = value.length - 1; i >= 0 && value[i] === '\n' && count < 2; i--) count++;
  return count;
}

function leadingCount(value: string): number {
  let count = 0;
  while (count < 2 && value[count] === '\n') count++;
  return count;
}

/**
 * Worst-case bytes of the pending batch close: the fixed end line plus its
 * newline plus the largest separator a close may need (`\n\n`).
 */
const END_RESERVE_BYTES = byteLength(PROGRESS_END_LINE) + 1 + 2;
/** A pending batch close always costs exactly one counted line. */
const END_RESERVE_LINES = 1;

/** Reserve kept while a displayed batch is open, so its close always fits. */
function pendingEndReserve(state: ProgressBatchState): { lines: number; bytes: number } {
  if (!state.toolOpen || !state.toolStartShown) return { lines: 0, bytes: 0 };
  return { lines: END_RESERVE_LINES, bytes: END_RESERVE_BYTES };
}

function fitsBudget(
  state: ProgressBatchState,
  fragmentBytes: number,
  reserveLines: number,
  reserveBytes: number,
): boolean {
  return (
    state.statusLines + 1 + reserveLines <= PROGRESS_MAX_LINES &&
    state.statusBytes + fragmentBytes + reserveBytes <= PROGRESS_MAX_BYTES
  );
}

function applyStatus(state: ProgressBatchState, fragment: string): ProgressBatchState {
  return {
    ...state,
    statusLines: state.statusLines + 1,
    statusBytes: state.statusBytes + byteLength(fragment),
    hasOutput: true,
    trailingNewlines: 1,
    lastWasStatus: true,
  };
}

/**
 * Leading gap before a status line. Status lines each end with a single `\n`,
 * so consecutive statuses need no extra gap; a status following body text gets
 * enough `\n` to leave exactly one blank line.
 */
function statusPrefix(state: ProgressBatchState): string {
  if (!state.hasOutput) return '';
  if (state.lastWasStatus) return '';
  if (state.trailingNewlines >= 2) return '';
  if (state.trailingNewlines === 1) return '\n';
  return '\n\n';
}

/**
 * Leading gap before body text that follows status: enough `\n` for exactly
 * one blank line, minus the newlines the text token itself already brings.
 * The text is always kept verbatim; only the missing part is inserted.
 */
function textGapPrefix(state: ProgressBatchState, text: string): string {
  if (!state.hasOutput || !state.lastWasStatus) return '';
  const need = 2 - state.trailingNewlines - leadingCount(text);
  if (need <= 0) return '';
  if (need === 1) return '\n';
  return '\n\n';
}

/**
 * Try to emit one fixed status line. `reserveLines`/`reserveBytes` stay
 * untouched for the caller (e.g. a displayed batch's pending close); the
 * fragment is emitted only when both it and the reserve fit.
 */
function emitStatus(
  state: ProgressBatchState,
  line: string,
  reserve: { lines: number; bytes: number } = { lines: 0, bytes: 0 },
): { state: ProgressBatchState; append: string } {
  const fragment = `${statusPrefix(state)}${line}\n`;
  if (!fitsBudget(state, byteLength(fragment), reserve.lines, reserve.bytes)) {
    return { state, append: '' };
  }
  return { state: applyStatus(state, fragment), append: fragment };
}

/** Close an open tool batch. Silent batches close silently: never an isolated end. */
function closeBatch(state: ProgressBatchState): { state: ProgressBatchState; append: string } {
  if (!state.toolOpen) return { state, append: '' };
  const cleared: ProgressBatchState = { ...state, toolOpen: false, toolCount: 0, encouraged: false, toolStartShown: false };
  if (!state.toolStartShown) return { state: cleared, append: '' };
  return emitStatus(cleared, PROGRESS_END_LINE);
}

function nextTrailing(state: ProgressBatchState, text: string): number {
  // A token made only of newlines extends the previous trailing run (capped);
  // any other token decides the run by its own ending alone.
  if (/^\n+$/.test(text)) return Math.min(2, state.trailingNewlines + trailingCount(text));
  return trailingCount(text);
}

function appendText(
  state: ProgressBatchState,
  text: string,
): { state: ProgressBatchState; append: string } {
  const gap = textGapPrefix(state, text);
  const trailingNewlines = nextTrailing(state, text);
  if (!gap) {
    return {
      state: { ...state, hasOutput: true, trailingNewlines, lastWasStatus: false },
      append: text,
    };
  }
  // The gap separator counts toward the status byte budget, never the body:
  // when it does not fit, the text still flows without the separator.
  if (state.statusBytes + byteLength(gap) > PROGRESS_MAX_BYTES) {
    return {
      state: { ...state, hasOutput: true, trailingNewlines, lastWasStatus: false },
      append: text,
    };
  }
  return {
    state: {
      ...state,
      statusBytes: state.statusBytes + byteLength(gap),
      hasOutput: true,
      trailingNewlines,
      lastWasStatus: false,
    },
    append: `${gap}${text}`,
  };
}

export function reduceProgressBatch(
  state: ProgressBatchState,
  input: ProgressBatchInput,
): ProgressBatchOutput {
  const base: ProgressBatchState = { ...state };
  if (!input || typeof input !== 'object') return { state: base, append: '' };

  if (input.type === 'end') {
    if (base.closed) return { state: base, append: '' };
    const closed: ProgressBatchState = { ...base, closed: true };
    if (!closed.toolOpen) return { state: closed, append: '' };
    const out = closeBatch(closed);
    return { state: { ...out.state, closed: true }, append: out.append };
  }

  if (input.type === 'text') {
    if (typeof input.text !== 'string' || input.text === '') return { state: base, append: '' };
    if (base.toolOpen && !base.closed) {
      const out = closeBatch(base);
      const tail = appendText(out.state, input.text);
      return { state: tail.state, append: `${out.append}${tail.append}` };
    }
    return appendText(base, input.text);
  }

  if (input.type === 'progress') {
    const event = (input as { event?: ParentProgressEvent }).event;
    if (base.closed || !event || (event.kind !== 'tool' && event.kind !== 'stage')) {
      return { state: base, append: '' };
    }
    // Only the event kind drives output; names (possibly attacker-controlled
    // labels, thinking text, paths, credentials) are deliberately ignored.
    if (event.kind === 'stage') {
      if (base.thinkingShown) return { state: base, append: '' };
      const marked: ProgressBatchState = { ...base, thinkingShown: true };
      return emitStatus(marked, PROGRESS_THINKING_LINE, pendingEndReserve(marked));
    }
    if (!base.toolOpen) {
      const opened: ProgressBatchState = { ...base, toolOpen: true, toolCount: 1, encouraged: false, toolStartShown: false };
      // Atomic open: display the start only when its matching close still
      // fits afterwards; otherwise run the whole batch silently while tools
      // keep counting and text keeps flowing.
      const fragment = `${statusPrefix(opened)}${PROGRESS_TOOL_LINE}\n`;
      if (!fitsBudget(opened, byteLength(fragment), END_RESERVE_LINES, END_RESERVE_BYTES)) {
        return { state: opened, append: '' };
      }
      return { state: { ...applyStatus(opened, fragment), toolStartShown: true }, append: fragment };
    }
    const count = base.toolCount + 1;
    // The continue line needs a displayed start and must leave the pending
    // close fitting; otherwise it is dropped without an isolated trace.
    if (count === 3 && !base.encouraged && base.toolStartShown) {
      const marked: ProgressBatchState = { ...base, toolCount: count, encouraged: true };
      const out = emitStatus(marked, PROGRESS_ENCOURAGE_LINE, pendingEndReserve(marked));
      if (out.append !== '') return out;
      return { state: { ...base, toolCount: count }, append: '' };
    }
    return { state: { ...base, toolCount: count }, append: '' };
  }

  return { state: base, append: '' };
}
