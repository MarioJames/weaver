import { Button, Text } from '@lobehub/ui/base-ui';
import { connectionStyles } from './connection-notice-style';
import type { ConnectionState } from '../hooks/reconnect';

/** Toast supplies the portal and corner placement; this content never enters page flow. */
export function ConnectionNotice({ state, retry }: { state: ConnectionState; retry: () => void }) {
  if (state.status === 'idle') return null;
  return <div role="status" aria-live="polite" className={connectionStyles.content}>
    {state.status === 'connected' ? <Text>已重新连接</Text> : <>
      <div className={connectionStyles.details}><Text>正在重新连接…</Text>
      <Text>重试次数：{state.attempt}</Text></div>
      <Button type="text" size="small" onClick={retry}>立即重试</Button>
    </>}
  </div>;
}
