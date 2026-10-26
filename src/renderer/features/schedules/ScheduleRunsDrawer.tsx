import { useEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ChevronDown, ChevronUp, ExternalLink, Square } from 'lucide-react';
import { Alert, Button, Drawer, Empty, Skeleton, Tag, Text } from '@lobehub/ui';
import { command } from '../../api/commands';
import { TimeText } from '../../ui/TimeText';
import { TaskTextBlock } from '../tasks/TaskTextBlock';
import { statusTagColor } from '../../format/tag-colors';
import { styles } from '../../ui/styles';
import { schedulesStyles } from './schedules-style';
import { RUN_LABELS, RUN_TONES, TRIGGER_LABELS } from './schedules-view';
import { ScheduleHistory, type ScheduleHistoryState } from './schedule-history';
import type { SchedulePendingNotice } from './ScheduleFormModal';
import type { ScheduleDefinition, ScheduleRun } from '../../../shared/contracts/schedules';

/** One page of the summary list; full output belongs to the per-run read. */
/** The gateway shortens summary output above this; a runId query returns that run in full. */
const SUMMARY_CHARS = 256;
/** Change pushes arrive per task event; history reads stay at least this far apart. */
const MIN_REFRESH_GAP_MS = 3000;


function runHeadline(run: ScheduleRun): string {
  const parts = [TRIGGER_LABELS[run.trigger]];
  if (run.scheduledFor) parts.push(`应触发 ${run.scheduledFor}`);
  return parts.join(' · ');
}

/** One run block: settled statuses, output (summary up front, full on expand), the agent task link and per-run cancel. */
function RunSection({ run, expanded, detail, detailLoading, detailError, active, cancelBusy, onCancelRun, onToggle, onRetryDetail, onViewTask }: {
  run: ScheduleRun;
  expanded: boolean;
  detail?: ScheduleRun;
  detailLoading: boolean;
  detailError: string;
  active: boolean;
  cancelBusy: boolean;
  onCancelRun: (runId: string) => void;
  onToggle: () => void;
  onRetryDetail: () => void;
  onViewTask?: (taskId: string) => void;
}) {
  const hasOutput = !!run.output || !!run.error || !!run.truncated;
  const shown = expanded && detail ? detail : run;
  return <section {...stylex.props(schedulesStyles.run)} aria-label={`${RUN_LABELS[run.status]}的运行`}>
    <div {...stylex.props(schedulesStyles.runHead)}>
      <Tag size="small" color={statusTagColor(RUN_TONES[run.status])}>{RUN_LABELS[run.status]}</Tag>
      <Text type="secondary">{runHeadline(run)}</Text>
      <span {...stylex.props(schedulesStyles.meta)}>
        <TimeText value={run.startedAt} />
        {run.finishedAt && <> → <TimeText value={run.finishedAt} /></>}
      </span>
      {run.exitCode !== undefined && run.exitCode !== null && <Text type="secondary">退出码 {run.exitCode}</Text>}
      {(expanded ? detail?.truncated : run.truncated) && <Tag size="small">{expanded ? '输出已截断' : `摘录前 ${SUMMARY_CHARS} 字`}</Tag>}
    </div>
    {run.taskId && <div {...stylex.props(schedulesStyles.runHead)}>
      <Text type="secondary" className={stylex.props(styles.numbers).className}>任务 {run.taskId}</Text>
      {onViewTask
        ? <Button size="small" type="text" icon={ExternalLink} aria-label={`在任务页查看 ${run.taskId}`} onClick={() => onViewTask(run.taskId!)}>在任务页查看</Button>
        : <Text type="secondary">任务页入口未接入。</Text>}
    </div>}
    {expanded && (detailLoading
      ? <div role="status" aria-label="正在读取本次运行完整输出"><Skeleton animated /></div>
      : detailError
        ? <div {...stylex.props(styles.row)}>
          <Text type="danger">完整输出读取失败：{detailError}</Text>
          <Button size="small" type="text" onClick={onRetryDetail}>重试</Button>
        </div>
        : detail && <TaskTextBlock title="输出" content={detail.output} clamp={20} />)}
    {!expanded && hasOutput && <>
      <TaskTextBlock title="输出" description={`列表只展示摘要（前 ${SUMMARY_CHARS} 字）；展开本条读取完整输出。`} content={run.output} clamp={8} />
      <div {...stylex.props(schedulesStyles.runHead)}>
        <Button size="small" type="text" icon={ChevronDown} aria-expanded={false} aria-label="查看完整输出" onClick={onToggle}>查看完整输出</Button>
      </div>
    </>}
    {expanded
      ? <div {...stylex.props(schedulesStyles.runHead)}>
        <Button size="small" type="text" icon={ChevronUp} aria-expanded aria-label="收起完整输出" onClick={onToggle}>收起，回到摘要</Button>
      </div>
      : undefined}
    {shown.error && <TaskTextBlock title="错误" content={shown.error} />}
    {active && <div {...stylex.props(schedulesStyles.rowHead)}>
      <Button size="small" icon={Square} loading={cancelBusy} disabled={cancelBusy} aria-label={`停止这次运行（${runHeadline(run)}）`} onClick={() => onCancelRun(run.id)}>停止本次运行</Button>
    </div>}
  </section>;
}

/**
 * The history of one schedule: the list reads paged run summaries, expanding a run fetches exactly
 * that runId with its full output, and agent runs link straight to their task detail. Failures keep
 * the shown data and offer retry; a slow old read (list or detail) never overwrites a newer one and
 * unmount ignores everything.
 */
export function ScheduleRunsDrawer({ schedule, open, onClose, cancelBusy, onCancelRun, onViewTask, pendingNotice }: {
  schedule: ScheduleDefinition;
  open: boolean;
  onClose: () => void;
  cancelBusy: boolean;
  onCancelRun: (runId: string) => void;
  /** Opens the exact task detail; wired through the app's requestedTaskId channel. */
  onViewTask?: (taskId: string) => void;
  pendingNotice?: SchedulePendingNotice;
}) {
  const [state,setState] = useState<ScheduleHistoryState>({total:0,error:'',problem:'',loadingMore:false,detailLoading:false,detailError:''});
  const history = useMemo(() => new ScheduleHistory(args=>command('schedules.runs',args),setState),[]);
  const lastFetch = useRef(0);
  useEffect(() => {
    if(!open)return;
    history.activate(schedule.id);
    lastFetch.current=Date.now();
    void history.refresh();
    return ()=>history.stop();
  },[open,schedule.id,history]);
  useEffect(() => {
    if(!open)return;
    const invalidate=()=>{
      if(Date.now()-lastFetch.current<MIN_REFRESH_GAP_MS)return;
      lastFetch.current=Date.now();void history.refresh();
    };
    const unsubscribe=window.weaver?.onTasksChanged(invalidate);
    const timer=setInterval(invalidate,15000);
    return ()=>{unsubscribe?.();clearInterval(timer);};
  },[open,history]);
  const {runs,total,error,problem,loadingMore,expandId,detail,detailLoading,detailError}=state;
  const retry=()=>{lastFetch.current=Date.now();void history.refresh();};
  const loadMore=()=>void history.loadMore();
  const openDetail=(run:ScheduleRun)=>void history.openDetail(run.id);
  const collapseDetail=()=>history.collapse();
  const retryDetail=()=>void history.retryDetail();
  const loading = open && runs === undefined && !error;
  return <Drawer open={open} title={`运行历史 · ${schedule.name}`} placement="right" width="min(720px, 92vw)" onClose={onClose}>
    {pendingNotice && <Alert type="warning" title={`上一次提交没有拿到完整回执：${pendingNotice.context}`} description={pendingNotice.reason}
      action={<><Button size="small" loading={pendingNotice.checking} onClick={pendingNotice.onVerify}>核对结果</Button><Button size="small" disabled={pendingNotice.checking} onClick={pendingNotice.onResend}>重试同一请求</Button></>} />}
    {schedule.builtin && schedule.activeRunId && <Text type="secondary">停止会等待当前额度请求完成，再结束本次刷新；后续目标不再请求。</Text>}
    {loading && <div role="status" aria-label="正在加载运行历史"><Skeleton animated /></div>}
    {!loading && error && !runs && <div {...stylex.props(styles.stack)}>
      <Text type="danger">运行历史读取失败：{error}</Text>
      <Button size="small" onClick={retry}>重试</Button>
    </div>}
    {!loading && runs && <>
      {problem && <div {...stylex.props(styles.row)}>
        <Text type="secondary" role="status">这次读取没有完成：{problem}。已显示的记录保留，可再试读取。</Text>
        <Button size="small" type="text" onClick={retry}>重新读取</Button>
      </div>}
      {runs.length
        ? <div {...stylex.props(schedulesStyles.runs)}>
          {runs.map(run => <RunSection key={run.id} run={run}
            expanded={expandId === run.id}
            detail={expandId === run.id ? detail : undefined}
            detailLoading={expandId === run.id && detailLoading}
            detailError={expandId === run.id ? detailError : ''}
            active={run.status === 'running' && schedule.activeRunId === run.id}
            cancelBusy={cancelBusy}
            onCancelRun={onCancelRun}
            onToggle={() => (expandId === run.id ? collapseDetail() : openDetail(run))}
            onRetryDetail={retryDetail}
            onViewTask={onViewTask}
          />)}
          {total > runs.length && <Button block size="small" loading={loadingMore} aria-label={`加载更多运行历史，共 ${total} 条`} onClick={loadMore}>加载更多（已显示 {runs.length} / {total} 条）</Button>}
        </div>
        : <Empty title="还没有运行记录" description="到下次触发时间后这里会出现记录，也可以在列表里点「立即运行」。" />}
    </>}
  </Drawer>;
}
