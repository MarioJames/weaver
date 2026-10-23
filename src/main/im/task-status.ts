import type { RootTaskOverview, TaskOverview } from '../../shared/contracts/tasks';
import { redactSecrets } from '../../shared/redact';
import { buildTaskOverview } from '../application/tasks/owner-report';
import type { TaskStore } from '../store';

/**
 * Bot status-menu text for first-class root-owner progress push.
 *
 * Overview shape and build rules come from the frozen core contract
 * (`src/shared/contracts/tasks.ts`: `OwnerReport`, `RootTaskOverview`,
 * `TaskOverview`) and the shared builder
 * (`src/main/application/tasks/owner-report.ts:buildTaskOverview`), the same
 * builder the Master API `tasks.overview` uses. This file only formats the
 * shared result; individual fields are bounded, but no root is ever dropped by
 * an overall length cap.
 */
export type { RootTaskOverview, TaskOverview };

export interface OverviewOptions {
  staleAfterSeconds?: number;
  now?: number;
}

const MAX_TITLE = 80;
const MAX_SUMMARY = 200;
const MAX_PHASE = 60;
const MAX_BLOCKER = 120;
const MAX_BLOCKERS_SHOWN = 3;
const MAX_ERROR = 200;
const REPORT_TIME_ZONE = 'Asia/Shanghai';

/** Bound by code point so a truncation never splits a surrogate pair. */
function truncate(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Collapse to one clean line: redact secrets, strip control chars, fold whitespace, bound length. */
function clean(value: unknown, max: number): string {
  const text = redactSecrets(String(value ?? ''))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, max);
}

/** Report timestamp in the same fixed zone the Bot uses for dates; relative age still carries freshness. */
function reportTimeText(reportedAt: string | null | undefined): string {
  if (!reportedAt) return '上报时间未知';
  const at = Date.parse(reportedAt);
  if (!Number.isFinite(at)) return '上报时间未知';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: REPORT_TIME_ZONE,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
    const month = value('month');
    const day = value('day');
    const hour = value('hour');
    const minute = value('minute');
    if (!month || !day || !hour || !minute) return '上报时间未知';
    return `上报于 ${month}-${day} ${hour}:${minute}`;
  } catch {
    return '上报时间未知';
  }
}

function ageText(ageSeconds: number | null): string {
  if (ageSeconds === null || !Number.isFinite(ageSeconds) || ageSeconds < 0) return '';
  if (ageSeconds < 60) return '刚刚';
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)} 分钟前`;
  return `${Math.floor(ageSeconds / 3600)} 小时前`;
}

/** Report time, relative age and freshness; an unknown age is never presented as fresh. */
function reportMeta(root: RootTaskOverview): string {
  const age = ageText(root.reportAgeSeconds);
  const freshness = root.reportStale
    ? '已过期，需重新上报'
    : root.reportAgeSeconds === null || !Number.isFinite(root.reportAgeSeconds) || root.reportAgeSeconds < 0
      ? '新鲜度未知'
      : '新鲜';
  return `${reportTimeText(root.ownerReport?.reportedAt)}（${[age, freshness].filter(Boolean).join('，')}）`;
}

function countsText(counts: RootTaskOverview['childCounts']): string {
  return (
    `子任务 共${counts.total}` +
    `（排队${counts.queued}/运行${counts.running}/取消中${counts.cancelling}` +
    `/完成${counts.completed}/失败${counts.failed}/已取消${counts.cancelled}）`
  );
}

function blockersText(blockers: string[]): string | null {
  const items = blockers.map(item => clean(item, MAX_BLOCKER)).filter(Boolean);
  if (!items.length) return null;
  const shown = items.slice(0, MAX_BLOCKERS_SHOWN).join('；');
  return items.length > MAX_BLOCKERS_SHOWN ? `阻塞：${shown}；等共${items.length}项` : `阻塞：${shown}`;
}

function formatRoot(root: RootTaskOverview): string {
  const lines = [`【${clean(root.title, MAX_TITLE) || '(未命名)'}】`];
  if (root.ownerId) lines[0] += ` owner ${clean(root.ownerId, 12)}`;
  if (root.ownerReport) {
    const report = root.ownerReport;
    const head = [`状态 ${root.status}`];
    if (typeof report.percent === 'number' && Number.isFinite(report.percent)) head.push(`上报进度 ${report.percent}%`);
    if (report.phase !== null && report.phase !== undefined && String(report.phase).trim() !== '') {
      head.push(`阶段 ${clean(report.phase, MAX_PHASE)}`);
    }
    lines.push(head.join(' · '));
    lines.push(reportMeta(root));
    const summary = clean(report.summary, MAX_SUMMARY);
    if (summary) lines.push(`摘要：${summary}`);
    const blockers = blockersText(report.blockers ?? []);
    if (blockers) lines.push(blockers);
  } else {
    lines.push(`尚未上报 · 状态 ${root.status} · 任务进度 ${root.progress}%`);
    const error = clean(root.lastError, MAX_ERROR);
    if (error) lines.push(`最近错误：${error}`);
  }
  lines.push(countsText(root.childCounts));
  return lines.join('\n');
}

/**
 * Pure formatter: every running owner root gets one block with per-field bounds
 * (title, report percent/phase when present, concise summary, blockers, report
 * age/freshness, direct child state counts). There is deliberately no overall
 * length cap: hiding later roots, reports or blockers would make the status text
 * lie about the task list. Never traverses into child detail and never
 * manufactures a percentage from children: an unreported root shows the stored
 * root progress only.
 */
export function formatTaskOverview(overview: TaskOverview): string {
  const roots = Array.isArray(overview?.roots) ? overview.roots : [];
  if (!roots.length) {
    return '当前没有正在运行的根任务。需要开始新工作时，直接告诉我要处理的项目和目标即可。';
  }
  const owners = new Set(roots.map(root => root.ownerId ?? ''));
  const header =
    owners.size > 1
      ? `运行中的根任务共 ${roots.length} 项（${owners.size} 个 owner）。`
      : `运行中的根任务共 ${roots.length} 项。`;
  return `${header}\n\n${roots.map(formatRoot).join('\n\n')}`;
}

/**
 * Current committed overview for ALL running owner roots (no child detail).
 * Delegates to the shared `buildTaskOverview` — the same builder the Master
 * API `tasks.overview` uses — on every call, so a second report or a newly
 * stale report is never served from a cache.
 */
export function resolveTaskOverview(store: TaskStore, options?: OverviewOptions): TaskOverview {
  return buildTaskOverview(store, { staleAfterSeconds: options?.staleAfterSeconds, now: options?.now });
}

/**
 * Fresh status-menu text on every call: rebuilds the committed overview each
 * time, so a second report or newly stale report is never served from a cache.
 */
export function formatStoreStatus(store: TaskStore, options?: OverviewOptions): string {
  return formatTaskOverview(resolveTaskOverview(store, options));
}
