import { useNotifyError } from '../api/notify';
import type { ReactNode } from 'react';
import { Save } from 'lucide-react';
import { PageHeader } from '@lobehub/ui/dashboard';
import { Button, Text } from '@lobehub/ui/base-ui';
import type { PolicyDraft } from './usePolicyDraft';
import { styles } from '../ui/styles';
import { resourceStyles } from '../ui/resource-style';

/** Page header for pages that edit the saved policy: one save path, one place for its outcome. */
export function PolicyHeader({ title, description, policy, extra, saveBlockReason }: { title: string; description: ReactNode; policy: PolicyDraft; extra?: ReactNode; saveBlockReason?: string }) {
  const state = policy.loading && !policy.config ? '正在读取配置…' : policy.dirty ? '有未保存的修改' : policy.snapshot ? '已保存' : '';
  useNotifyError(policy.loadError, '配置读取失败');
  useNotifyError(policy.saveError ? [policy.saveError, ...policy.issues.map(issue => `${issue.path}：${issue.message}`)].join('\n') : '', '保存失败');
  useNotifyError(policy.conflict ? '配置已在别处更新，草稿仍保留。重新读取会放弃本页草稿。' : '', '配置冲突');
  return <>
    <PageHeader title={title} description={description} action={<div className={styles.row}>
      {extra}
      <Text type={policy.dirty ? 'warning' : 'secondary'} role="status" aria-live="polite" className={resourceStyles.headerStatus}>{state}</Text>
      <Button disabled={!policy.dirty || policy.busy || policy.loading} onClick={() => void policy.load(true)}>放弃修改</Button>
      <Button type="primary" icon={Save} loading={policy.busy} disabled={!policy.config || !policy.dirty || !!saveBlockReason} title={saveBlockReason || undefined} onClick={() => { if (!saveBlockReason) void policy.save(); }}>保存</Button>
    </div>} />
  </>;
}
