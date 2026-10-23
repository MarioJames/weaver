import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Input, Modal, Text } from '@lobehub/ui/base-ui';
import { Form, useForm } from '@lobehub/ui/base-ui/form';
import { createStaticStyles } from 'antd-style';
import { fullTime } from '../../format/timezone';
import { NamedSwitch } from '../../ui/NamedControls';
import type { CleanupReport, EngineCleanupInput, EngineCleanupJob } from '../../../shared/contracts/engine-cleanup';

const css = createStaticStyles(({ css, cssVar }) => ({
 body: css`display: flex; flex-direction: column; gap: 16px;`,
 options: css`display: flex; justify-content: space-between; align-items: center; gap: 16px;`,

 actions: css`display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap;`,
}));
const megabytes = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const bytes = (n: number) => `${megabytes.format(n / 1024 / 1024)} MiB`;
const total = (values: Record<string, number>) => Object.values(values).reduce((sum, n) => sum + n, 0);
const vacuumText = (status: string) => ({ completed: '已完成', 'not-requested': '未请求', 'skipped-active-opencode': '数据已清理；OpenCode 正在使用数据库，空间整理已跳过', 'skipped-busy': '数据已清理；数据库正忙，空间整理已跳过', 'vacuum-completed-checkpoint-busy': '压缩已完成；日志文件正忙，暂未收缩' }[status] || '数据已清理，空间整理失败，可稍后重试');
const reasons: Record<string, string> = { 'active-opencode': 'OpenCode 正在使用这个数据库，请结束相关会话后重试。', 'cleanup-running': '已有清理任务占用数据库，请稍后重试。', 'database-busy': '数据库正忙，本次没有删除数据，请稍后重试。' };
function Facts({ report }: { report: CleanupReport }) {
 const applied = report.status === 'applied';
 const items = [
  { label: '数据库 / 日志文件', children: `${bytes(report.bytesBefore.database ?? 0)} / ${bytes(report.bytesBefore['-wal'] ?? 0)}` },
  { label: applied ? '已删除会话' : '待删除会话', children: applied ? report.deleted.session : report.expiredIds.length },
  { label: '保留会话', children: report.retainedCount },
  { label: applied ? '已删除事件' : '待删除事件（含过期会话）', children: applied ? report.deleted.event : report.before.event - report.retained.event - report.retained.orphanEvents + report.eventPruning.candidateEvents },
  { label: '保留会话待裁剪事件', children: report.eventPruning.candidateEvents },
  { label: applied ? '剩余事件' : '预计保留事件', children: applied ? report.after.event : report.retained.event + report.retained.orphanEvents - report.eventPruning.candidateEvents },
 ];
 if (applied) items.push(
  { label: '释放空间（含日志文件）', children: bytes(Math.max(0, total(report.bytesBefore) - total(report.bytesAfter))) },
  { label: '当前数据库 / 日志文件', children: `${bytes(report.bytesAfter.database ?? 0)} / ${bytes(report.bytesAfter['-wal'] ?? 0)}` },
  { label: '空间整理', children: vacuumText(report.vacuum) },
 );
 return <Descriptions colon={false} column={1} items={items} aria-label={applied ? '清理结果' : '清理预览'} />;
}
export function EngineCleanup() {
 const [open, setOpen] = useState(false);
 const [days, setDays] = useState('1'); const [idle, setIdle] = useState('60');
 const [pruneEvents, setPrune] = useState(false); const [vacuum, setVacuum] = useState(true);
 const [job, setJob] = useState<EngineCleanupJob>(); const [sending, setSending] = useState(false);
 const [confirm, setConfirm] = useState(false); const [pollFailed, setPollFailed] = useState(false);
 const draftVersion = useRef(0); const uncertain = useRef(false);
 const mounted = useRef(true); const submitting = useRef(false); const form = useForm();
 const running = sending || job?.status === 'running';
 const daysError = !/^[1-9]\d*$/.test(days) || Number(days) > 36500 ? '请输入 1–36500 的整数' : undefined;
 const idleError = pruneEvents && (!/^(0|[1-9]\d*)$/.test(idle) || Number(idle) > 52560000) ? '请输入 0–52560000 的整数' : undefined;
 const report = job?.result && (job.result.status === 'preview' || job.result.status === 'applied') ? job.result : undefined;
 const preview = report?.status === 'preview' ? report : undefined;
 const hasDeletions = !!preview && (preview.expiredIds.length > 0 || preview.eventPruning.candidateEvents > 0);
 const invalidate = () => { draftVersion.current++; setJob(undefined); setConfirm(false); };
 function restore(next: EngineCleanupJob) {
  setJob(next); setDays(String(next.input.keepDays)); setIdle(String(next.input.eventIdleMinutes)); setPrune(next.input.pruneEvents); setVacuum(next.input.vacuum);
 }
 async function recover() {
  const version = draftVersion.current;
  try {
   const next = await window.weaver.getEngineCleanup('opencode');
   if (!mounted.current || version !== draftVersion.current) return;
   if (next && (next.status === 'running' || uncertain.current || (!job && version === 0))) { restore(next); uncertain.current = false; }
  } catch { /* API reports request failures once. */ }
 }
 useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
 useEffect(() => { if (open) void recover(); }, [open]);
 useEffect(() => {
  if (job?.status !== 'running' || pollFailed) return;
  let stopped = false; let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
   try { const next = await window.weaver.getEngineCleanup(job.id); if (stopped) return; if (next) setJob(next); else { setPollFailed(true); return; } if (next.status === 'running') timer = setTimeout(() => void poll(), 750); }
   catch { if (!stopped) setPollFailed(true); }
  };
  timer = setTimeout(() => void poll(), 500);
  return () => { stopped = true; clearTimeout(timer); };
 }, [job?.id, job?.status, pollFailed]);
 async function start(mode: 'preview' | 'apply') {
  if (submitting.current || running || daysError || idleError || (mode === 'apply' && !preview)) return;
  draftVersion.current++;
  submitting.current = true; setSending(true); setConfirm(false); setPollFailed(false);
  const input: EngineCleanupInput = { engine: 'opencode', mode, keepDays: Number(days), eventIdleMinutes: pruneEvents ? Number(idle) : 60, pruneEvents, vacuum, ...(mode === 'apply' ? { previewId: job!.id } : {}) };
  try { const next = await window.weaver.startEngineCleanup(input); if (mounted.current) setJob(next); }
  catch { uncertain.current = true; await recover(); }
  finally { submitting.current = false; if (mounted.current) setSending(false); }
 }
 return <>
  <Button size="small" onClick={() => setOpen(true)}>清理数据库{job?.status === 'running' ? ' · 运行中' : ''}</Button>
  <Modal open={open} title="清理 OpenCode 数据库" width={580} destroyOnHidden={false} onCancel={() => setOpen(false)} footer={null}>
   <div className={css.body}>
    <Text type="secondary">按北京时间的自然日保留最近会话，默认保留今天。预览不会删除数据；执行前请结束使用这个数据库的 OpenCode 进程。</Text>
    <Form form={form} layout="vertical">
     <Form.Field label="保留天数" required extra={daysError && <Text type="danger">{daysError}</Text>}>
      <Input id="cleanup-days" placeholder="例如：1（保留北京时间今天）" aria-label="保留天数" inputMode="numeric" value={days} disabled={running} onChange={event => { setDays(event.target.value); invalidate(); }} />
     </Form.Field>
     <Form.Field label="裁剪保留会话的事件历史" desc="默认关闭。开启会损失所选会话的事件同步与回放历史，保留本地消息和工具结果。">
      <NamedSwitch id="cleanup-prune" aria-label="裁剪保留会话的事件历史" checked={pruneEvents} disabled={running} onChange={value => { setPrune(value); invalidate(); }} />
     </Form.Field>
     {pruneEvents && <Form.Field label="会话至少空闲多少分钟" required desc="0 表示所有保留会话；依据会话最后更新时间筛选。" extra={idleError && <Text type="danger">{idleError}</Text>}>
      <Input id="cleanup-idle" placeholder="例如：60；0 表示全部保留会话" aria-label="会话至少空闲多少分钟" inputMode="numeric" value={idle} disabled={running} onChange={event => { setIdle(event.target.value); invalidate(); }} />
     </Form.Field>}
     <div className={css.options}><Text>执行后整理空间（压缩数据库）</Text><NamedSwitch aria-label="执行后整理空间" checked={vacuum} disabled={running} onChange={value => { setVacuum(value); invalidate(); }} /></div>
    </Form>
    {running && <Alert type="info" title="任务在后台运行，关闭窗口后仍会继续" description={job?.progress || '正在启动清理进程…'} />}
    {pollFailed && <Alert type="warning" title="暂时无法读取进度" action={<Button size="small" onClick={() => setPollFailed(false)}>重新读取进度</Button>} />}
    {report && <><Text>{report.status === 'preview' ? '预览范围' : '清理已完成'}：删除北京时间 {fullTime(report.cutoff, 'Asia/Shanghai')} 之前更新的会话。</Text><Facts report={report} /></>}
    {job?.result?.status === 'error' && <Alert type="error" title="清理未完成" description={job.result.error} />}
    {job?.result?.status === 'skipped' && <Alert type="warning" title="本次未执行清理" description={reasons[job.result.reason] || job.result.reason} />}
    <div className={css.actions}><Button onClick={() => setOpen(false)}>关闭</Button><Button loading={sending && !confirm} disabled={running || !!daysError || !!idleError} onClick={() => void start('preview')}>预览清理范围</Button><Button type="primary" danger={hasDeletions} disabled={running || !preview || !!daysError || !!idleError} onClick={() => setConfirm(true)}>{hasDeletions ? '确认清理…' : vacuum ? '确认整理空间…' : '确认执行…'}</Button></div>
   </div>
  </Modal>
  <Modal open={confirm} title={hasDeletions ? "确认永久删除这些数据？" : vacuum ? "确认整理数据库空间？" : "确认检查数据库？"} width={480} okText={hasDeletions ? "永久删除并执行清理" : vacuum ? "确认整理空间" : "确认执行"} cancelText="取消" okButtonProps={{ danger: hasDeletions }} onCancel={() => setConfirm(false)} onOk={() => void start('apply')}>
   {preview && <div className={css.body}><Text>{hasDeletions ? <>将删除 {preview.expiredIds.length} 个过期会话及其消息、工具调用和事件历史，保留 {preview.retainedCount} 个会话。此操作无法撤销。</> : <>当前没有待删除的会话或事件，将保留 {preview.retainedCount} 个会话。{vacuum ? "本次仅整理数据库空间。" : "本次仅检查数据库。"}</>}</Text>{pruneEvents && <Alert type="warning" title={`另将裁剪 ${preview.eventPruning.candidateSessions} 个保留会话的 ${preview.eventPruning.candidateEvents} 条事件`} description={`至少空闲 ${idle} 分钟的保留会话将失去事件同步与回放历史。本地消息和工具结果保留。`} />}<Text>{vacuum ? '删除完成后会整理数据库空间，可能需要较长时间。' : '本次不整理空间，数据库文件可能不会立即缩小。'}</Text></div>}
  </Modal>
 </>;
}
