import * as stylex from '@stylexjs/stylex';
import { Text, Tooltip } from '@lobehub/ui';
import { connectionStyles } from './connection-notice-style';
import type { ConnectionState } from './reconnect';

/** Toast supplies the portal and corner placement; this content never enters page flow. */
export function ConnectionNotice({ state }: { state: ConnectionState }) {
  if (state.status === 'idle') return null;
  return <div role="status" aria-live="polite" {...stylex.props(connectionStyles.content)}>
    {state.status === 'connected' ? <Text>已重新连接</Text> : <Tooltip title={`重试次数：${state.attempt}`}><Text>正在重新连接…</Text></Tooltip>}
  </div>;
}
