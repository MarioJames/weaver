import { NamedInputNumber } from './NamedControls';
import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Text } from '@lobehub/ui/base-ui';
import type { Task } from '../../shared/types';
import type { HandoffRecord } from '../../main/continuation';
import { command } from '../commands';
import { redactLog } from '../log-view';
import { styles } from '../style';

interface Continuation { taskId: string; ownerId?: string; ownerEpoch?: number; policy: { idleRotationMinutes: number | null }; lastActivityAt?: string; due: boolean; history: HandoffRecord[]; contextPack: { goal?: string; plan?: string[]; pendingApprovals?: string[]; limitations?: string[] } | null }

export function OwnerInspector({ task, busy, action }: { task: Task; busy: boolean; action: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [state, setState] = useState<Continuation>();
  const [error, setError] = useState('');
  const [minutes, setMinutes] = useState<number | null>(60);
  const [enabled, setEnabled] = useState(true);
  const [preview, setPreview] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const locked = useRef(false);
  useEffect(() => {
    let current = true;
    setError(''); setState(undefined);
    if (!task.ownerId) return;
    void command<Continuation>('owners.continuation.get', { taskId: task.id }).then(result => { if (current) { setState(result); setMinutes(result.policy.idleRotationMinutes ?? 60); setEnabled(result.policy.idleRotationMinutes !== null); } }).catch(cause => { if (current) setError(String(cause)); });
    return () => { current = false; };
  }, [task.id, task.revision, attempt]);
  const blocked = task.status === 'running' || task.status === 'cancelling' || task.scheduled;
  const minutesValid = !enabled || (Number.isInteger(minutes) && Number(minutes) >= 1 && Number(minutes) <= 10080);
  async function run(name: string, args: Record<string, unknown>) {
    if (locked.current || busy) return;
    locked.current = true;
    try { const ok = await action(() => command(name, { taskId: task.id, expectedRevision: task.revision ?? 0, ...args }, true)); if (ok) setPreview(false); setAttempt(value => value + 1); }
    finally { locked.current = false; }
  }
  return <aside aria-label="执行上下文" className={styles.stack}>
    <Text style={{ fontWeight: 600 }}>执行上下文</Text>
    <Text className={styles.wrap}>Owner {task.owner.name}</Text>
    <Text className={styles.wrap}>Worker {task.dispatch?.worker ?? '尚未分配'}</Text>
    <Text className={styles.wrap}>Worker 执行记录 {task.dispatch?.execution ?? '尚未记录'} · 适配器 {task.run?.adapter ?? '尚未记录'}</Text>
    <Text type="secondary">Owner 是逻辑登记。外部 CLI 宿主引用未经验证，登记不代表已启动新的 AI。</Text>
    <Text className={styles.wrap}>工作目录 {task.workspace ?? '旧任务未记录'}</Text>
    <Text type="secondary">Token 和费用未知。worker 未报告实际计量。</Text>
    <Text style={{ fontWeight: 600 }}>Owner 手动接续</Text>
    <Text type="secondary">空闲到期仅提醒外部 Owner 手动接续。真实 CLI 负责切换上下文并自行读取接续包；Weaver 不会自动替换外部 AI、投递接续包或确认宿主收到。</Text>
    {!task.ownerId ? <Text type="secondary">此旧任务仅有手动引用，无法轮换。</Text> : error ? <div role="alert" className={styles.stack}><Text type="danger">{error}</Text><Button disabled={busy} onClick={() => setAttempt(value => value + 1)}>重新读取</Button></div> : !state ? <Text role="status" type="secondary">正在读取上下文…</Text> : <>
      <Text>Epoch {state.ownerEpoch ?? 0} · {state.due ? '达到空闲阈值，需手动接续' : '未达到空闲阈值'}</Text>
      <Checkbox checked={enabled} disabled={busy} onChange={setEnabled}>启用空闲接续提醒</Checkbox>
      <NamedInputNumber aria-label="空闲阈值（分钟）" min={1} max={10080} step={1} value={minutes} disabled={busy || !enabled} onChange={setMinutes} />
      <Button block disabled={busy || !minutesValid} onClick={() => void run('owners.continuation.configure', { idleRotationMinutes: enabled ? minutes : null })}>保存空闲策略</Button>
      <Button block disabled={busy || blocked} onClick={() => setPreview(value => !value)}>登记手动接续</Button>
      {blocked && <Text type="secondary">worker 执行或等待调度期间不可切换。</Text>}
      {preview && <div className={styles.stack}><Text style={{ fontWeight: 600 }}>确认登记接续</Text><Text>将冻结当前交接信息、生成接续包并更新逻辑 Owner 绑定。任务和已有产物保留。外部模式不会启动新 AI，也不会取得宿主接收确认；请由真实 CLI 自行读取接续包并切换上下文。</Text><Text className={styles.wrap}>{redactLog(state.contextPack?.goal ?? task.instruction)}</Text><Text>当前进度 {task.progress}% · {task.artifacts.length} 项已有产物</Text><Text className={styles.wrap}>验收标准：{task.acceptanceCriteria?.join('；') ?? '未单独记录'}</Text><Button type="primary" block disabled={busy || blocked} onClick={() => void run('owners.switch', {})}>生成接续包并更新登记</Button></div>}
      {state.contextPack && <details><summary>已生成的接续包 · 需外部 CLI 自行读取</summary><pre className={styles.clip}>{redactLog(JSON.stringify(state.contextPack, null, 2))}</pre></details>}
      {state.history.length > 0 && <div className={styles.stack}><Text>历史交接 · {state.history.length}</Text><ol>{state.history.map(record => <li key={record.id} className={styles.wrap}>Epoch {record.epoch} · {record.reason === 'manual' ? '手动交接' : '空闲轮换'} · {record.acknowledgementId === null ? '仅逻辑登记，无外部宿主确认' : 'mock 宿主已确认接续包'} · {new Date(record.at).toLocaleString()}</li>)}</ol></div>}
    </>}
    <Text type="secondary" className={styles.wrap}>Task {task.id}</Text>
    <Text type="secondary" className={styles.wrap}>Owner handle {task.ownerId ?? '无逻辑 ID'} · Attempt {task.run?.id ?? '尚未开始'}</Text>
    <Text type="secondary" className={styles.wrap}>Package {task.packageId ?? '尚未冻结'} · Revision {task.revision ?? 0}</Text>
  </aside>;
}
