import { useNotifyError } from '../../api/notify';
import { useEffect, useRef, useState } from 'react';
import { Button, Descriptions, Modal, Tag, Text, TextArea } from '@lobehub/ui/base-ui';
import type { Task } from '../../../shared/contracts/tasks';
import { command } from '../../api/commands';
import { DISPLAY_LABELS, DISPLAY_TONES, type DisplayStatus } from '../../format/status-colors';
import { statusTagColor, tagColor } from '../../format/tag-colors';
import { ownerLabel, taskOwnerId } from './task-view';
import { styles } from '../../ui/styles';
import { AgentLabel } from '../../ui/EngineIcon';
import { TimeText } from '../../ui/TimeText';
import { styles as detailStyles } from './task-detail-style';

interface ResultManifest { taskId: string; execution: string; manifestDigest: string; delivery: 'pending' | 'acknowledged'; acceptance: 'pending' | 'accepted' | 'rejected' }
const DECISION_STATUS: Record<ResultManifest['acceptance'], DisplayStatus> = { pending: 'review', accepted: 'accepted', rejected: 'rejected' };

/** When the owner's decision was recorded: the last "Owner review" lifecycle event. */
export function decisionEvent(task: Task) {
  return [...task.events].reverse().find(event => event.kind === 'lifecycle' && /^Owner review: (?:accepted|rejected)/.test(event.message));
}

const LoadingNote = () => <Text role="status" type="secondary">正在读取结果清单…</Text>;

export interface ReviewViewProps { task: Task; manifest?: ResultManifest; busy: boolean; ownerKind?: (ownerId?: string) => string | undefined; open: boolean; comment: string; onOpen: () => void; onClose: () => void; onComment: (value: string) => void; onSubmit: (name: string, extra: Record<string, unknown>) => void; ready?: boolean; loading?: boolean }

/** Read-only delivery state and decision; the manual review lives in a modal. */
export function ReviewView({ task, manifest, busy, ownerKind, open, comment, onOpen, onClose, onComment, onSubmit, ready = true, loading = false }: ReviewViewProps) {
  const decided = !!manifest && manifest.acceptance !== 'pending';
  const decision = decided ? decisionEvent(task) : undefined;
  const status = DECISION_STATUS[manifest?.acceptance ?? 'pending'];
  const note = comment.trim() ? { comment: comment.trim() } : {};
  const items = [
    { key: 'delivery', label: '交付', children: <Tag size="small" variant="outlined" color={manifest?.delivery === 'acknowledged' ? tagColor('success') : tagColor('warning')}>{manifest?.delivery === 'acknowledged' ? '已确认收到' : '待确认收到'}</Tag> },
    { key: 'decision', label: '验收结论', children: <Tag size="small" variant="solid" color={statusTagColor(DISPLAY_TONES[status])}>{DISPLAY_LABELS[status]}</Tag> },
    ...(decided ? [
      { key: 'by', label: '决定者', children: <AgentLabel kind={ownerKind?.(taskOwnerId(task))} name={ownerLabel(task)} /> },
      ...(decision ? [{ key: 'at', label: '决定时间', children: <TimeText value={decision.at} /> }] : []),
    ] : []),
    ...(task.reviewComment ? [{ key: 'comment', label: '验收说明', span: 2, children: <Text className={styles.wrap}>{task.reviewComment}</Text> }] : []),
  ];
  return <>
    {manifest && <Descriptions colon={false} column={2} items={items} />}
    <div className={styles.row}><Button disabled={busy} onClick={onOpen}>手动验收</Button></div>
    <Modal open={open} title="手动验收" onCancel={() => { if (!busy) onClose(); }} footer={<div className={detailStyles.modalFooter}>
      {manifest?.delivery !== 'acknowledged' && <Button disabled={busy || !ready || !manifest} onClick={() => onSubmit('results.ack', {})}>确认收到</Button>}
      <Button disabled={busy || !ready || !manifest || manifest.acceptance === 'rejected'} onClick={() => onSubmit('reviews.submit', { decision: 'rejected', ...note })}>要求修改</Button>
      <Button type="primary" disabled={busy || !ready || !manifest || manifest.acceptance === 'accepted'} onClick={() => onSubmit('reviews.submit', { decision: 'accepted', ...note })}>验收通过</Button>
    </div>}>
      {loading && <LoadingNote />}
      <TextArea aria-label="验收说明（可选）" rows={4} maxLength={4000} disabled={busy} value={comment} placeholder="补充检查结果，或需要修改的内容（可选）" onChange={event => onComment(event.target.value)} />
    </Modal>
  </>;
}

export function ReviewPanel({ task, busy, action, ownerKind, open: controlledOpen, onOpenChange }: { task: Task; busy: boolean; action: (fn: () => Promise<unknown>) => Promise<boolean>; ownerKind?: (ownerId?: string) => string | undefined; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [manifest, setManifest] = useState<ResultManifest>();
  const [error, setError] = useState('');
  useNotifyError(error, '结果读取失败', { label: '重试', run: () => setAttempt(value => value + 1) });
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value); };
  const [submitting, setSubmitting] = useState(false);
  const [loadedVersion, setLoadedVersion] = useState('');
  const version = `${task.id}:${task.revision ?? 0}:${task.updatedAt}`;
  const currentVersion = useRef(version);
  currentVersion.current = version;
  const currentTaskId = useRef(task.id);
  currentTaskId.current = task.id;
  const previousTaskId = useRef(task.id);
  useEffect(() => {
    if (previousTaskId.current === task.id) return;
    previousTaskId.current = task.id;
    setComment(''); setOpen(false); setManifest(undefined); setLoadedVersion('');
  }, [task.id]);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const locked = useRef(false);
  useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    void command<ResultManifest>('tasks.results', { taskId: task.id }).then(result => { if (current && currentVersion.current === version && result.taskId === task.id) { setManifest(result); setLoadedVersion(version); } }).catch(cause => { if (current) setError(String(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [task.id, task.revision, task.updatedAt, attempt]);
  async function submit(name: string, extra: Record<string, unknown>) {
    if (!manifest || manifest.taskId !== task.id || loadedVersion !== version || loading || locked.current || busy) return;
    locked.current = true;
    setSubmitting(true);
    try {
      const succeeded = await action(() => command(name, { taskId: task.id, manifestDigest: manifest.manifestDigest, expectedRevision: task.revision ?? 0, ...extra }, true));
      if (!active.current || currentTaskId.current !== task.id) return;
      if (succeeded) { setComment(''); setOpen(false); }
      setAttempt(value => value + 1);
    } finally { locked.current = false; if (active.current) setSubmitting(false); }
  }
  return <section aria-label="交付验收" className={styles.stack}>
    {!open && loading && <LoadingNote />}
    <ReviewView task={task} manifest={manifest?.taskId === task.id ? manifest : undefined} busy={busy || submitting} ready={!loading && loadedVersion === version && !error} loading={loading} ownerKind={ownerKind} open={open} comment={comment} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} onComment={setComment} onSubmit={(name, extra) => void submit(name, extra)} />
  </section>;
}
