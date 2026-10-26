import type { TaskPins } from './task-pins';
/** localStorage key holding the workbench session list preferences. */
export const WORKBENCH_SESSIONS_KEY = 'weaver-workbench-sessions';
export type WorkbenchScope = 'attention' | 'active' | 'all';
export type WorkbenchTime = 'today' | '24h' | '7d' | '30d' | 'all';
export interface WorkbenchSessions {
  query: string;
  time: WorkbenchTime;
  scope: WorkbenchScope;
}
export const WORKBENCH_TIMES: readonly { value: WorkbenchTime; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'all', label: '全部' },
];
export function defaultWorkbenchSessions(): WorkbenchSessions {
  return { query: '', time: '24h', scope: 'active' };
}
/** The saved session preferences; unreadable or misshapen storage is the default view. */
export function readWorkbenchSessions(): WorkbenchSessions {
  const fallback = defaultWorkbenchSessions();
  try {
    const raw = localStorage.getItem(WORKBENCH_SESSIONS_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
    const stored = parsed as Record<string, unknown>;
    return {
      query: typeof stored.query === 'string' ? stored.query : fallback.query,
      time: WORKBENCH_TIMES.some(item => item.value === stored.time) ? (stored.time as WorkbenchTime) : fallback.time,
      scope: stored.scope === 'attention' || stored.scope === 'active' || stored.scope === 'all' ? stored.scope : fallback.scope,
    };
  } catch { return fallback; }
}
/** Persist the session preferences; a private-mode or full storage only loses the memory. */
export function writeWorkbenchSessions(selection: WorkbenchSessions): void {
  try { localStorage.setItem(WORKBENCH_SESSIONS_KEY, JSON.stringify(selection)); } catch { /* The choice stays for this session only. */ }
}
/** localStorage key recording whether the workbench 已结束 task section is open. */
export const WORKBENCH_ENDED_KEY = 'weaver-workbench-ended';
/** 已结束 stays folded unless the user left it open. */
export function readWorkbenchEnded(): boolean {
  try { return localStorage.getItem(WORKBENCH_ENDED_KEY) === 'true'; } catch { return false; }
}
export function writeWorkbenchEnded(open: boolean): void {
  try { localStorage.setItem(WORKBENCH_ENDED_KEY, String(open)); } catch { /* The choice stays for this session only. */ }
}
/** localStorage key holding the workbench board (看板) preferences: one row of filters plus per-group folding. */
export const WORKBENCH_BOARD_KEY = 'weaver-workbench-board';
export interface WorkbenchBoard {
  query: string;
  workspaces: string[];
  owners: string[];
  /** Collapsed workspace groups by `<column>:<workspace>`; absent means the column default (open, except 已结束). */
  collapsed: Record<string, boolean>;
}
export function defaultWorkbenchBoard(): WorkbenchBoard {
  return { query: '', workspaces: [], owners: [], collapsed: {} };
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function collapsedMap(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const collapsed: Record<string, boolean> = {};
  for (const [key, at] of Object.entries(value)) if (typeof at === 'boolean') collapsed[key] = at;
  return collapsed;
}
/** The saved board preferences; unreadable or misshapen storage is the default view. */
export function readWorkbenchBoard(): WorkbenchBoard {
  const fallback = defaultWorkbenchBoard();
  try {
    const raw = localStorage.getItem(WORKBENCH_BOARD_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
    const stored = parsed as Record<string, unknown>;
    return {
      query: typeof stored.query === 'string' ? stored.query : fallback.query,
      workspaces: stringList(stored.workspaces),
      owners: stringList(stored.owners),
      collapsed: collapsedMap(stored.collapsed),
    };
  } catch { return fallback; }
}
/** Persist the board preferences; a private-mode or full storage only loses the memory. */
export function writeWorkbenchBoard(selection: WorkbenchBoard): void {
  try { localStorage.setItem(WORKBENCH_BOARD_KEY, JSON.stringify(selection)); } catch { /* The choice stays for this session only. */ }
}
/** localStorage key recording which task ids the reader pinned, with the moment of each pin. */
export const TASK_PINS_KEY = 'weaver-task-pins';
/** A stored payload decodes to id -> pin time; anything malformed or off-shape counts no pin. */
function parsePins(raw: string | null): TaskPins {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const pins: TaskPins = {};
    for (const [id, at] of Object.entries(parsed)) if (typeof at === 'number' && Number.isFinite(at)) pins[id] = at;
    return pins;
  } catch { return {}; }
}
/** The saved pins; unreadable storage is the same as none. */
export function readTaskPins(): TaskPins {
  try { return parsePins(localStorage.getItem(TASK_PINS_KEY)); } catch { return {}; }
}
/** Persist the pins; a private-mode or full storage only loses the memory. */
export function writeTaskPins(pins: TaskPins): void {
  try { localStorage.setItem(TASK_PINS_KEY, JSON.stringify(pins)); } catch { /* The pins stay for this session only. */ }
}
