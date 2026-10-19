import type { RoutePreview } from '../shared/policy';

export interface PreviewState { key: string; request: number; result?: RoutePreview; error?: string }
export type PreviewAction = { type: 'invalidate'; key: string } | { type: 'request'; key: string; request: number } | { type: 'settled'; key: string; request: number; result?: RoutePreview; error?: string };

export function routePreviewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  if (action.type === 'invalidate') return { key: action.key, request: 0 };
  if (action.type === 'request') return { key: action.key, request: action.request };
  if (action.key !== state.key || action.request !== state.request) return state;
  return { key: action.key, request: action.request, ...(action.result ? { result: action.result } : {}), ...(action.error ? { error: action.error } : {}) };
}
