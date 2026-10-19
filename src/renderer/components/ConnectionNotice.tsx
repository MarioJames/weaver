import { Button, Spin, Text } from '@lobehub/ui/base-ui';
import { connectionStyles } from './connection-notice-style';
import type { ConnectionState } from '../hooks/reconnect';

/** Toast supplies the portal and corner placement; this content never enters page flow. */
export function ConnectionNotice({ state, retry }: { state: ConnectionState; retry: () => void }) {
  if (state.status === 'idle') return null;
  return <div role="status" aria-live="polite" className={connectionStyles.content}>
    {state.status === 'connected' ? <Text>已重新连接</Text> : <>
      <Spin size="small" aria-label="正在重新连接" />
      <div className={connectionStyles.details}><Text>控制面暂时没有响应，正在重新连接…</Text>
      <Text type="secondary">重试次数：{state.attempt}</Text></div>
      <Button type="text" size="small" onClick={retry}>立即重试</Button>
    </>}
  </div>;
}
