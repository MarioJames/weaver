import { redactSecrets } from '../../shared/redact';
import type { ParentProgressEvent } from './parent-agent';

/**
 * Progress-line rendering and scrubbing: turns a parent Agent session's `onProgress`
 * short-label events into single progress lines inside streaming card content
 * (e.g. "⏺ 调用工具：shell", "⏺ 阶段：步骤1").
 *
 * Safety invariants:
 * - Upstream only passes short labels such as tool/stage names; thinking bodies,
 *   tool arguments, full commands never reach this module (the dsh adapter only takes
 *   the name from `tool_call.tool` and never forwards `input`/`thinking`/`tool_result`).
 * - This module scrubs again as a backstop: absolute paths are reduced to basename,
 *   credential-shaped strings are masked via `redactSecrets`, `<>&` (the characters
 *   forming the card control prefix `<weaver-actions`) are stripped outright, control
 *   characters are stripped, label names are truncated to 32 chars and whole lines to
 *   80 chars.
 * - Progress lines do not count toward the answer `REPLY_BYTES` quota (see service.ts),
 *   but carry their own line/byte caps, so the combined total stays far below
 *   `streamMaxElementChars` (30000). The separator break service.ts inserts before a
 *   progress line counts toward this progress byte budget, never toward the answer.
 */

export const PROGRESS_LINE_MAX_CHARS = 80;
export const PROGRESS_NAME_MAX_CHARS = 32;
export const PROGRESS_MAX_LINES = 20;
export const PROGRESS_MAX_BYTES = 2000;

const TOOL_PREFIX = '⏺ 调用工具：';
const STAGE_PREFIX = '⏺ 阶段：';

/** Scrub a single label: basename, strip control/card-control chars, redact, truncate. */
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

/** Render a progress event as one card text line; undefined means the caller skips it. */
export function formatParentProgress(event: ParentProgressEvent): string | undefined {
  if (!event || (event.kind !== 'tool' && event.kind !== 'stage')) return undefined;
  const name = sanitizeProgressName(event.name);
  if (!name) return undefined;
  const line = `${event.kind === 'tool' ? TOOL_PREFIX : STAGE_PREFIX}${name}`;
  return [...redactSecrets(line)].slice(0, PROGRESS_LINE_MAX_CHARS).join('');
}
