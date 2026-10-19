import { Text, Tooltip } from '@lobehub/ui/base-ui';
import { connectionStyles } from './connection-notice-style';
import type { ConnectionState } from '../hooks/reconnect';

/** Toast supplies the portal and corner placement; this content never enters page flow. */
export function ConnectionNotice({ state }: { state: ConnectionState }) {
  if (state.status === 'idle') return null;
  return <div role="status" aria-live="polite" className={connectionStyles.content}>
    {state.status === 'connected' ? <Text>已重新连接</Text> : <Tooltip title={`重试次数：${state.attempt}`}><Text>正在重新连接…</Text></Tooltip>}
  </div>;
}
