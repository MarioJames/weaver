import { useEffect, useRef, useState } from 'react';
import { Button, Text, TextArea } from '@lobehub/ui/base-ui';
import type { Task } from '../../shared/types';
import { command } from '../commands';
import { styles } from '../style';

interface ResultManifest { taskId: string; execution: string; manifestDigest: string; delivery: 'pending' | 'acknowledged'; acceptance: 'pending' | 'accepted' | 'rejected' }
const acceptanceLabel = { pending: '待验收', accepted: '已通过', rejected: '需修改' };

export function ReviewPanel({ task, busy, action }: { task: Task; busy: boolean; action: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [manifest, setManifest] = useState<ResultManifest>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState('');
  const [attempt, setAttempt] = useState(0);
  const locked = useRef(false);
  useEffect(() => {
    let current = true;
    setLoading(true); setManifest(undefined); setError('');
    void command<ResultManifest>('tasks.results', { taskId: task.id }).then(result => { if (current) setManifest(result); }).catch(cause => { if (current) setError(String(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [task.id, task.revision, task.updatedAt, attempt]);
  async function submit(name: string, extra: Record<string, unknown>) {
    if (!manifest || locked.current || busy) return;
    locked.current = true;
    try {
      const succeeded = await action(() => command(name, { taskId: task.id, manifestDigest: manifest.manifestDigest, expectedRevision: task.revision ?? 0, ...extra }, true));
      if (succeeded) setComment('');
      setAttempt(value => value + 1);
    } finally { locked.current = false; }
  }
  return <section aria-label="交付验收" className={styles.stack}>
    <Text style={{ fontWeight: 600 }}>交付与验收</Text>
    <Text type="secondary">执行完成、确认收到结果和验收通过分别记录。此处确认是当前操作者的结果确认，不代表外部 Owner 宿主自动收到。先读取并检查产物，再提交结论。</Text>
    {loading ? <Text role="status" type="secondary">正在读取结果清单…</Text> : error ? <div role="alert" className={styles.stack}><Text type="danger">{error}</Text><Button onClick={() => setAttempt(value => value + 1)}>重新读取结果</Button></div> : manifest && <>
      <Text>交付：{manifest.delivery === 'acknowledged' ? '已确认收到' : '待确认收到'} · 验收：{acceptanceLabel[manifest.acceptance]} · 执行：{manifest.execution}</Text>
      {task.reviewComment && <Text className={styles.wrap}>已保存的验收说明：{task.reviewComment}</Text>}
      <TextArea aria-label="验收说明" rows={3} maxLength={4000} disabled={busy} value={comment} placeholder="补充检查结果，或需要修改的内容" onChange={event => setComment(event.target.value)} />
      <div className={styles.row}>
        <Button disabled={busy || manifest.delivery === 'acknowledged'} onClick={() => void submit('results.ack', {})}>{manifest.delivery === 'acknowledged' ? '已确认收到' : '确认收到'}</Button>
        <Button type="primary" disabled={busy || manifest.acceptance === 'accepted'} onClick={() => void submit('reviews.submit', { decision: 'accepted', ...(comment.trim() ? { comment: comment.trim() } : {}) })}>验收通过</Button>
        <Button disabled={busy || manifest.acceptance === 'rejected'} onClick={() => void submit('reviews.submit', { decision: 'rejected', ...(comment.trim() ? { comment: comment.trim() } : {}) })}>要求修改</Button>
      </div>
      <Text type="secondary" className={styles.wrap}>结果清单指纹 {manifest.manifestDigest}</Text>
    </>}
  </section>;
}
