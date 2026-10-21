import type { TaskEvent, TaskStatus } from '../../../shared/contracts/tasks';
import { redactSecrets } from '../../../shared/redact';
import { DISPLAY_LABELS, DISPLAY_TONES, type DisplayStatus, type StatusTone } from '../../format/status-colors';
/** Best-effort display redaction with the one shared rule set. Never claim this catches every secret. */
export function redactLog(value: string): string { return redactSecrets(value); }

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

/** Translate known lifecycle messages only at the display boundary; exports preserve source text. */
export function displayLog(value: string): string {
  return redactLog(value)
    .replace(/^Frozen work package created$/, '已冻结工作包')
    .replace(/^Draft edited before start$/, '已在启动前编辑草稿')
    .replace(/^Owner generated task title and acceptance criteria$/, '父 Agent 已生成任务标题和验收标准')
    .replace(/^Result receipt acknowledged; acceptance unchanged$/, '已确认收到结果，验收状态未变')
    .replace(/^Dispatch admitted to queue; waiting for an execution slot$/, '派发已进入队列，等待执行名额')
    .replace(/^Worker exited successfully; output is ready for owner review$/, '子 Agent 已成功退出，等待父 Agent 验收')
    .replace(/^Worker stopped after cancellation$/, '子 Agent 已在取消后停止')
    .replace(/^Cancelled before dispatch$/, '已在派发前取消')
    .replace(/^Cancelled; the owner should stop its built-in subagent$/, '已取消，父 Agent 应停止其内置子 Agent')
    .replace(/^Cancellation requested; waiting for worker exit$/, '已请求取消，等待子 Agent 退出')
    .replace(/^Started (.+) in Herdr \((.+)\)$/, '已在 Herdr 启动 $1（$2）')
    .replace(/^Vendor limit rerouted queued worker to (.+)$/, '因供应商限制，队列中的子 Agent 已改派至 $1')
    .replace(/^Linked as a retry of task (.+) and frozen with its package$/, '已关联为任务 $1 的重试，并冻结工作包')
    .replace(/^Retried as task (.+); engines excluded for the chain: none$/, '已重试为任务 $1；本次重试链无排除引擎')
    .replace(/^Retried as task (.+); engines excluded for the chain: (.+)$/, '已重试为任务 $1；本次重试链排除的引擎：$2')
    .replace(/; engines excluded because they failed earlier in this retry chain: (.+)$/, '；因在本次重试链中曾失败而排除的引擎：$1')
    .replace(/^Launching explicit mock-jsonl provider$/, '正在启动显式 mock-jsonl 模拟执行')
    .replace(/^Launching (.+) with requested model (.+)$/, '正在启动 $1，请求模型：$2')
    .replace(/^Launching (.+) in (.+)$/, '正在启动 $1，工作目录：$2')
    .replace(/^Launching /, '正在启动 ')
    .replace(/^Received /, '已收到 ')
    .replace(/^(?:tool|file_change) started (.+)$/, '调用工具 $1')
    .replace(/^(?:tool|file_change) finished (.+)$/, '工具完成 $1')
    .replace(/^(?:tool|file_change) failed (.+)$/, '工具失败 $1')
    .replace(/^owned scope started$/, '已开始执行授权范围')
    .replace(/^opencode step started$/, 'OpenCode 步骤已开始')
    .replace(/^codex thread started$/, 'Codex 会话已开始')
    .replace(/^((?:[a-z0-9_.:-]+ )?)session started$/i, '$1会话已开始')
    .replace(/; no Herdr session was contacted\.$/, '；未联系 Herdr 会话。')
    .replace(/^Owner runs ([a-zA-Z0-9_-]+).*$/, '父 Agent 派发给子 Agent $1')
    .replace(/^Owner reported the native run complete; output is ready for review$/, '父 Agent 已报告原生执行完成，等待验收')
    .replace(/^Owner reported the native run failed:\s*/, '父 Agent 已报告原生执行失败：')
    .replace(/^Policy selected ([^;]+) on the owner's engine;[^；]*?(；.*)?$/, '策略已选择子 Agent $1，由父 Agent 使用内置工具执行$2')
    .replace(/^Policy selected ([^;]+); launching ([^；]+) in ([^；]+)(.*)$/, '策略已选择子 Agent $1，正在 $3 启动 $2$4')
    .replace(/^Policy selected ([^;]+); explicit mock-jsonl provider(；.*)?$/, '策略已选择子 Agent $1，使用显式模拟执行$2')
    .replace(/^Policy selected ([^;]+); launching$/, '策略已选择子 Agent $1，正在启动')
    .replace(/Owner reference is metadata only/g, '父 Agent 引用仅用于记录')
    .replace(/^Task queued\.?\s*/, '任务待执行。')
    .replace(/^Owner review: accepted/, '父 Agent 验收：已通过')
    .replace(/^Owner review: rejected/, '父 Agent 验收：需修改');
}
