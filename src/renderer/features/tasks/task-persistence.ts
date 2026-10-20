import { FILTER_DIMENSIONS, TIME_RANGES, emptySelection, type TaskSelection } from './task-filters';
/** localStorage key holding the board's filter selection. */
export const TASK_FILTERS_KEY = 'weaver-task-filters';
/** A stored payload decodes to a selection; anything malformed or of the wrong shape is no selection at all. */
function parseSelection(raw: string | null): TaskSelection {
  if (!raw) return emptySelection();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptySelection();
    const stored = parsed as Record<string, unknown>;
    const initial = emptySelection();
    initial.time = TIME_RANGES.find(range => range.value === stored.time)?.value ?? initial.time;
    return FILTER_DIMENSIONS.reduce((selection, dimension) => {
      const values = stored[dimension];
      selection[dimension] = Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];
      return selection;
    }, initial);
  } catch { return emptySelection(); }
}
/** The saved selection; unreadable storage is the same as none. */
export function readTaskFilters(): TaskSelection {
  try { return parseSelection(localStorage.getItem(TASK_FILTERS_KEY)); } catch { return emptySelection(); }
}
/** Persist the selection; a private-mode or full storage only loses the memory. */
export function writeTaskFilters(selection: TaskSelection): void {
  try { localStorage.setItem(TASK_FILTERS_KEY, JSON.stringify(selection)); } catch { /* The choice stays for this session only. */ }
}
/** localStorage key recording whether the facet block is collapsed to its summary line. */
export const FILTERS_COLLAPSED_KEY = 'weaver-task-filters-collapsed';
export function readFiltersCollapsed(): boolean {
  try { return localStorage.getItem(FILTERS_COLLAPSED_KEY) === 'true'; } catch { return false; }
}
export function writeFiltersCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(FILTERS_COLLAPSED_KEY, String(collapsed)); } catch { /* The choice stays for this session only. */ }
}
/** localStorage key recording whether the board's 已结束 column is open. */
export const ENDED_EXPANDED_KEY = 'weaver-task-ended-expanded';
/** 已结束 stays folded unless the user left it open; anything else stored there is not an open column. */
export function readEndedExpanded(): boolean {
  try { return localStorage.getItem(ENDED_EXPANDED_KEY) === 'true'; } catch { return false; }
}
export function writeEndedExpanded(open: boolean): void {
  try { localStorage.setItem(ENDED_EXPANDED_KEY, String(open)); } catch { /* The choice stays for this session only. */ }
}
