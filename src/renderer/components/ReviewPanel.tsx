import { useNotifyError } from '../notify';
import { useEffect, useRef, useState } from 'react';
import { Button, Descriptions, Modal, Tag, Text, TextArea } from '@lobehub/ui/base-ui';
import type { Task } from '../../shared/types';
import { command } from '../commands';
import { toneColor } from '../log-view';
import { DISPLAY_LABELS, DISPLAY_TONES, type DisplayStatus } from '../status-colors';
import { ownerLabel, taskOwnerId } from '../task-view';
import { styles } from '../style';
import { AgentLabel } from './EngineIcon';
import { styles as detailStyles } from './task-detail-style';

interface ResultManifest { taskId: string; execution: string; manifestDigest: string; delivery: 'pending' | 'acknowledged'; acceptance: 'pending' | 'accepted' | 'rejected' }
const DECISION_STATUS: Record<ResultManifest['acceptance'], DisplayStatus> = { pending: 'review', accepted: 'accepted', rejected: 'rejected' };

/** When the owner's decision was recorded: the last "Owner review" lifecycle event. */
export function decisionEvent(task: Task) {
  return [...task.events].reverse().find(event => event.kind === 'lifecycle' && /^Owner review: (?:accepted|rejected)/.test(event.message));
}

export interface ReviewViewProps { task: Task; manifest: ResultManifest; busy: boolean; ownerKind?: (ownerId?: string) => string | undefined; open: boolean; comment: string; onOpen: () => void; onClose: () => void; onComment: (value: string) => void; onSubmit: (name: string, extra: Record<string, unknown>) => void }

/** Read-only delivery state and decision; the manual review lives in a modal. */
export function ReviewView({ task, manifest, busy, ownerKind, open, comment, onOpen, onClose, onComment, onSubmit }: ReviewViewProps) {
  const decided = manifest.acceptance !== 'pending';
  const decision = decided ? decisionEvent(task) : undefined;
  const status = DECISION_STATUS[manifest.acceptance];
  const note = comment.trim() ? { comment: comment.trim() } : {};
  const items = [
    { key: 'delivery', label: '交付', children: <Tag size="small" variant="outlined" color={manifest.delivery === 'acknowledged' ? 'success' : undefined}>{manifest.delivery === 'acknowledged' ? '已确认收到' : '待确认收到'}</Tag> },
    { key: 'decision', label: '验收结论', children: <Tag size="small" variant="solid" color={toneColor(DISPLAY_TONES[status])}>{DISPLAY_LABELS[status]}</Tag> },
    ...(decided ? [
      { key: 'by', label: '决定者', children: <AgentLabel kind={ownerKind?.(taskOwnerId(task))} name={ownerLabel(task)} /> },
      ...(decision ? [{ key: 'at', label: '决定时间', children: <time dateTime={decision.at}>{new Date(decision.at).toLocaleString()}</time> }] : []),
    ] : []),
    ...(task.reviewComment ? [{ key: 'comment', label: '验收说明', span: 2, children: <Text className={styles.wrap}>{task.reviewComment}</Text> }] : []),
  ];
  return <>
    <Descriptions colon={false} column={2} items={items} />
    <div className={styles.row}><Button disabled={busy} onClick={onOpen}>手动验收</Button></div>
    <Modal open={open} title="手动验收" onCancel={onClose} footer={<div className={detailStyles.modalFooter}>
      {manifest.delivery !== 'acknowledged' && <Button disabled={busy} onClick={() => onSubmit('results.ack', {})}>确认收到</Button>}
      <Button disabled={busy || manifest.acceptance === 'rejected'} onClick={() => onSubmit('reviews.submit', { decision: 'rejected', ...note })}>要求修改</Button>
      <Button type="primary" disabled={busy || manifest.acceptance === 'accepted'} onClick={() => onSubmit('reviews.submit', { decision: 'accepted', ...note })}>验收通过</Button>
    </div>}>
      <TextArea aria-label="验收说明（可选）" rows={4} maxLength={4000} disabled={busy} value={comment} placeholder="补充检查结果，或需要修改的内容（可选）" onChange={event => onComment(event.target.value)} />
    </Modal>
  </>;
}

export function ReviewPanel({ task, busy, action, ownerKind }: { task: Task; busy: boolean; action: (fn: () => Promise<unknown>) => Promise<boolean>; ownerKind?: (ownerId?: string) => string | undefined }) {
  const [manifest, setManifest] = useState<ResultManifest>();
  const [error, setError] = useState('');
  useNotifyError(error);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const locked = useRef(false);
  useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    void command<ResultManifest>('tasks.results', { taskId: task.id }).then(result => { if (current) setManifest(result); }).catch(cause => { if (current) setError(String(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [task.id, task.revision, task.updatedAt, attempt]);
  async function submit(name: string, extra: Record<string, unknown>) {
    if (!manifest || locked.current || busy) return;
    locked.current = true;
    try {
      const succeeded = await action(() => command(name, { taskId: task.id, manifestDigest: manifest.manifestDigest, expectedRevision: task.revision ?? 0, ...extra }, true));
      if (succeeded) { setComment(''); setOpen(false); }
      setAttempt(value => value + 1);
    } finally { locked.current = false; }
  }
  return <section aria-label="交付验收" className={styles.stack}>
    {loading && !manifest ? <Text role="status" type="secondary">正在读取结果清单…</Text> : !error && manifest && <ReviewView task={task} manifest={manifest} busy={busy} ownerKind={ownerKind} open={open} comment={comment} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} onComment={setComment} onSubmit={(name, extra) => void submit(name, extra)} />}
  </section>;
}
