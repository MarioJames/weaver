import type { TaskEvent } from '../shared/types';
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
    items.push({ type: 'steps', from: run[0], to: run[run.length - 1], count: tools.reduce((sum, tool) => sum + tool.count, 0), tools, events: [...run], inProgress: false });
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

const TERMINAL_LIFECYCLE = /(?:^| )exited|stopped|cancel(?:led|ed)|receipt|native run complete|owner review:/i;
export function timelineActive(events: TaskEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'lifecycle') continue;
    return !TERMINAL_LIFECYCLE.test(event.message);
  }
  return false;
}
