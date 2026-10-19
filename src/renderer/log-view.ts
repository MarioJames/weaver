import type { TaskEvent, TaskStatus } from '../shared/types';
import { DISPLAY_LABELS, DISPLAY_TONES, type DisplayStatus, type StatusTone } from './status-colors';
/** Best-effort display redaction. Never claim this catches every secret. */
export function redactLog(value: string): string {
 return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi,'[REDACTED PRIVATE KEY]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[REDACTED]@').replace(/\b(Bearer\s+)[^\s"'<>]+/gi,'$1[REDACTED]')
  .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)\s*[=:]\s*["']?)[^\s,"';&]+/gi,'$1[REDACTED]')
  .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/g,'[REDACTED]');
}
export function selectEvents(events: TaskEvent[], kind: string, query: string): TaskEvent[] {
 const needle=query.trim().toLocaleLowerCase();
 return events.filter(event=>(kind==='all'||event.kind===kind)&&(!needle||redactLog(event.message).toLocaleLowerCase().includes(needle)));
}
export function exportEvents(taskId: string, events: TaskEvent[]): string {
  return JSON.stringify({schema:'weaver.event-export.v1',taskId,redaction:'best-effort; review before sharing',events:events.map(event=>({...event,message:redactLog(event.message)}))},null,2);
}

const NOISE_LOG = /^(?:tool|file_change) (?:started|finished|failed)\b/;
const STEP_ONLY_PROGRESS = [/^owned scope started$/, /^opencode step started$/, /^codex thread started$/, /^(?:[a-z0-9_.:-]+ )?session started$/i];
export function isTimelineNoise(event: TaskEvent): boolean {
  const message = event.message.trim();
  if (event.kind === 'log') return NOISE_LOG.test(message);
  if (event.kind === 'progress') return STEP_ONLY_PROGRESS.some(pattern => pattern.test(message));
  return false;
}

const TOOL_ALIASES: Record<string, string> = { bash: 'Bash', command_execution: 'Bash', edit: 'Edit', file_change: 'Edit', read: 'Read', grep: 'Grep', write: 'Write' };
export function normalizeToolName(name: string): string {
  const key = name.trim();
  if (!key) return 'Other';
  const lower = key.toLocaleLowerCase();
  if (TOOL_ALIASES[lower]) return TOOL_ALIASES[lower];
  if (/[A-Z]/.test(key.slice(1))) return key;
  return key[0].toUpperCase() + key.slice(1);
}

const TOOL_NOTE = /(?:^| )(?:tool|file_change) (started|finished|failed) (.+)$/;
export const kindLabels: Record<TaskEvent['kind'], string> = { lifecycle: '状态', result: '结果', artifact: '产物', error: '错误', log: '日志', progress: '进展' };
export interface ToolSummary { name: string; count: number }
export type TimelineItem =
  | { type: 'event'; event: TaskEvent }
  | { type: 'steps'; from: TaskEvent; to: TaskEvent; count: number; tools: ToolSummary[]; events: TaskEvent[]; inProgress: boolean };
export interface CondenseOptions { active: boolean }

function toolCount(run: TaskEvent[]): ToolSummary[] {
  const counts = new Map<string, { started: number; ended: number }>();
  for (const event of run) {
    if (event.kind !== 'log') continue;
    const match = TOOL_NOTE.exec(event.message);
    if (!match) continue;
    const name = normalizeToolName(match[2].trim());
    const entry = counts.get(name) ?? { started: 0, ended: 0 };
    if (match[1] === 'started') entry.started += 1;
    else entry.ended += 1;
    counts.set(name, entry);
  }
  return [...counts]
    .map(([name, entry]) => ({ name, count: entry.started > 0 ? entry.started : entry.ended }))
    .filter(tool => tool.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function condenseEvents(events: TaskEvent[], options: CondenseOptions): TimelineItem[] {
  const items: TimelineItem[] = [];
  let run: TaskEvent[] = [];
  const flush = () => {
    if (!run.length) return;
    const tools = toolCount(run);
    if (!tools.length) items.push(...run.map(event => ({ type: 'event' as const, event })));
    else items.push({ type: 'steps', from: run[0], to: run[run.length - 1], count: tools.reduce((sum, tool) => sum + tool.count, 0), tools, events: [...run], inProgress: false });
    run = [];
  };
  for (const event of events) {
    if (isTimelineNoise(event)) run.push(event);
    else { flush(); items.push({ type: 'event', event }); }
  }
  flush();
  const last = items[items.length - 1];
  if (options.active && last?.type === 'steps') last.inProgress = true;
  return items;
}

export function filterCondensed(items: TimelineItem[], query: string): TimelineItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  return items.filter(item => (item.type === 'event' ? [item.event.message] : item.events.map(event => event.message)).some(message => redactLog(message).toLocaleLowerCase().includes(needle)));
}

/** Task state is authoritative even when only an early page of events is loaded. */
export function timelineActive(status: TaskStatus): boolean {
  return status === 'running' || status === 'cancelling';
}

/** Short Chinese relative time ("3 分钟前"); the absolute time lives in a tooltip next to it. */
export function relativeTime(at: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(at).getTime());
  const minutes = Math.floor(diff / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** A tag in front of a timeline event: a status (solid, status scheme) or an outcome (outlined). */
export interface EventBadge { label: string; tone: StatusTone; outcome: boolean }

const LIFECYCLE_STATUS: [RegExp, DisplayStatus][] = [
  [/^Cancellation requested/, 'cancelling'],
  [/^Dispatch admitted to queue/, 'scheduled'],
  [/^Task queued/, 'queued'],
  [/output is ready for (?:owner )?review|native run complete/i, 'review'],
  [/^Started .* in Herdr|^Policy selected|launching|waiting for its report|^Owner runs /, 'running'],
];
const LIFECYCLE_OUTCOME: [RegExp, EventBadge][] = [
  [/^(?:Cancelled|Worker stopped after cancellation)/, { label: DISPLAY_LABELS.cancelled, tone: DISPLAY_TONES.cancelled, outcome: true }],
  [/^Owner review: accepted/, { label: '通过', tone: 'success', outcome: true }],
  [/^Owner review: rejected/, { label: DISPLAY_LABELS.rejected, tone: DISPLAY_TONES.rejected, outcome: true }],
];

/** The tag an event carries; lifecycle steps are status tags, outcomes (passed, failed, cancelled) are outlined. */
export function eventBadge(event: TaskEvent): EventBadge | undefined {
  if (event.kind === 'error') return { label: DISPLAY_LABELS.failed, tone: DISPLAY_TONES.failed, outcome: true };
  if (event.kind === 'artifact') return { label: kindLabels.artifact, tone: 'default', outcome: false };
  if (event.kind !== 'lifecycle') return undefined;
  const message = event.message.trim();
  const outcome = LIFECYCLE_OUTCOME.find(([pattern]) => pattern.test(message));
  if (outcome) return outcome[1];
  const status = LIFECYCLE_STATUS.find(([pattern]) => pattern.test(message))?.[1];
  return status ? { label: DISPLAY_LABELS[status], tone: DISPLAY_TONES[status], outcome: false } : undefined;
}

/** One tool call inside a merged step run. */
export interface ToolStep { id: string; name: string; at: string; durationMs?: number; failed: boolean }

/** Pair started notes with their finished/failed note (same tool, oldest first) into one row per call. */
export function toolSteps(events: TaskEvent[]): ToolStep[] {
  const steps: ToolStep[] = [];
  const open = new Map<string, ToolStep[]>();
  for (const event of events) {
    if (event.kind !== 'log') continue;
    const match = TOOL_NOTE.exec(event.message);
    if (!match) continue;
    const name = normalizeToolName(match[2].trim());
    if (match[1] === 'started') {
      const step: ToolStep = { id: event.id, name, at: event.at, failed: false };
      steps.push(step);
      open.set(name, [...(open.get(name) ?? []), step]);
      continue;
    }
    const step = open.get(name)?.shift();
    const failed = match[1] === 'failed';
    if (step) { step.durationMs = Math.max(0, new Date(event.at).getTime() - new Date(step.at).getTime()); step.failed = failed; }
    else steps.push({ id: event.id, name, at: event.at, failed });
  }
  return steps;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** Tag color preset of a status tone; the neutral tone uses the Tag default. */
export function toneColor(tone: StatusTone): string | undefined { return tone === 'default' ? undefined : tone; }
