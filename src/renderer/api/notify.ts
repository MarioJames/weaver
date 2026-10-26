import { createElement, useEffect, useRef } from 'react';
import { toast, type ToastInstance } from '@lobehub/ui';
import { ConnectionNotice } from './ConnectionNotice';
import { Reconnector, isTransientError } from './reconnect';
export { isTransientError } from './reconnect';

interface NoticeAction { label: string; run: () => void }
const recent = new Map<string, { at: number; notice: ToastInstance }>();
export function notifyError(error: unknown, context = '请求失败', action?: NoticeAction) {
  if (!error || isTransientError(error)) return;
  const rawMessage = (typeof error === 'object' && 'message' in error ? String(error.message) : String(error)).replace(/^Error: /, '');
  const code = (typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : rawMessage.match(/^([A-Z][A-Z_0-9]+):/)?.[1]) ?? '';
  const detail = rawMessage.replace(/^[A-Z][A-Z_0-9]+:\s*/, '').replace(/\s*\/\s*[A-Z][A-Z_0-9]+$/, '');
  const known: Record<string, string> = { NOT_FOUND: '任务不存在', CONFLICT: '内容已更新，请重新读取后再试', FORBIDDEN: '没有操作权限', UNAUTHORIZED: '请先登录', VALIDATION: '输入有误' };
  const message = code === 'NOT_FOUND' && /^Task not found$/i.test(detail) ? known.NOT_FOUND : /^[A-Z][a-z]+(?: [a-z]+)*$/.test(detail) && known[code] ? known[code] : detail || known[code] || '请求失败';
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
  const notice = toast.error({ title: context, description: message, actions, placement: 'bottom-right' });
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
  if (state.status === 'connected') { toast.dismiss('control-reconnect'); toast.success({ id: 'reconnected', title: '已重新连接', duration: 3000, placement: 'bottom-right' });
    // The toast timer pauses while the window is unfocused or hovered; the confirmation must still go away.
    setTimeout(() => toast.dismiss('reconnected'), 3000); return; }
  toast.dismiss('reconnected');
  toast({ id: 'control-reconnect', type: 'loading', duration: 0, closable: false, placement: 'bottom-right', title: createElement(ConnectionNotice, { state }) });
});
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => reconnect.visibilityChanged());
