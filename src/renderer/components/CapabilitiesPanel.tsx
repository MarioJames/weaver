import { useEffect, useState } from 'react';
import { Button, Text } from '@lobehub/ui/base-ui';
import { command } from '../commands';
import { styles } from '../style';

interface ControlCapabilities { apiVersion: string; ownerSpawn: string; manualAttach: string; workerProviders: string[]; realExecution: boolean; mcp: boolean; policyAdmission: boolean; maxParallel: number }

export function CapabilitiesPanel() {
  const [caps, setCaps] = useState<ControlCapabilities>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setError('');
    void command<ControlCapabilities>('capabilities.get', {}).then(value => { if (current) setCaps(value); }).catch(cause => { if (current) setError(String(cause)); });
    return () => { current = false; };
  }, [retry]);
  if (error) return <div role="alert" className={styles.stack}><Text type="danger">{error}</Text><Button onClick={() => setRetry(value => value + 1)}>重新读取能力</Button></div>;
  if (!caps) return <Text role="status" type="secondary">正在查询控制面能力…</Text>;
  return <div className={styles.grid}>
    <div className={styles.stack}><Text style={{ fontWeight: 600 }}>Worker 执行</Text><Text className={styles.wrap}>{caps.workerProviders.join(' · ') || '无可用 worker'}</Text><Text type="secondary">能力报告：真实执行{caps.realExecution ? '已启用' : '未启用'} · {caps.maxParallel} 个并行槽位</Text></div>
    <div className={styles.stack}><Text style={{ fontWeight: 600 }}>Owner 承载</Text><Text className={styles.wrap}>创建：{caps.ownerSpawn}</Text><Text className={styles.wrap}>手动绑定：{caps.manualAttach}</Text><Text type="secondary">这里显示控制面报告，不代表已经启动模型进程。</Text></div>
    <div className={styles.stack}><Text style={{ fontWeight: 600 }}>统一控制接口</Text><Text>{caps.apiVersion} · 路由准入{caps.policyAdmission ? '已启用' : '未启用'}</Text><Text type="secondary">MCP {caps.mcp ? '已启用' : '未启用'}</Text></div>
  </div>;
}
