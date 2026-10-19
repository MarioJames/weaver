import { createElement, useEffect, useRef } from 'react';
import { toast, Text, type ToastInstance } from '@lobehub/ui/base-ui';
import { ConnectionNotice } from './components/ConnectionNotice';
import { Reconnector, isTransientError } from './hooks/reconnect';
export { isTransientError } from './hooks/reconnect';

interface NoticeAction { label: string; run: () => void }
const recent = new Map<string, { at: number; notice: ToastInstance }>();
export function notifyError(error: unknown, context = '请求失败', action?: NoticeAction) {
  if (!error || isTransientError(error)) return;
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '');
  const code = (typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : message.match(/^([A-Z][A-Z_0-9]+):/)?.[1]) ?? '';
  const key = `${code}:${message}`;
  const now = Date.now();
  const actions = action ? [{ label: action.label, onClick: action.run, variant: 'text' as const }] : undefined;
  const previous = recent.get(key);
  if (previous && now - previous.at < 3000) {
    // Enrich the existing notice with the contextual recovery action, never stack it.
    if (actions) previous.notice.update({ title: context, actions });
    return;
  }
  for (const [id, entry] of recent) if (now - entry.at > 3000) recent.delete(id);
  const notice = toast.error({ title: context, description: createElement('div', null, createElement('div', null, message), code ? createElement(Text, {type:'secondary',fontSize:12}, code) : null), actions, placement: 'bottom-right' });
  recent.set(key, { at: now, notice });
}
export function notifyInfo(message: string, id?: string, duration = 5000) {
  toast.info({ id, duration, title: message, placement: 'bottom-right' });
}
export function useNotifyError(error: unknown, context?: string, action?: NoticeAction) {
  const latestAction = useRef(action);
  latestAction.current = action;
  useEffect(() => {
    const next = latestAction.current;
    notifyError(error, context, next ? { label: next.label, run: () => latestAction.current?.run() } : undefined);
  }, [error, context]);
}
export const reconnect = new Reconnector(state => {
  if (state.status === 'idle') { toast.dismiss('control-reconnect'); return; }
  toast({ id: 'control-reconnect', type: state.status === 'connected' ? 'success' : 'default', duration: 0, closable: false, placement: 'bottom-right', title: createElement(ConnectionNotice, { state, retry: () => { void reconnect.retryNow(); } }) });
});
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => reconnect.visibilityChanged());
