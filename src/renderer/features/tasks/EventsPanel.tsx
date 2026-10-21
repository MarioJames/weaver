import { notifyError } from '../../api/notify';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CopyButton, Icon } from '@lobehub/ui';
import { Button, Input, Steps, Tag, Text, Tooltip } from '@lobehub/ui/base-ui';
import { Loader2 } from 'lucide-react';
import type { TaskEvent, TaskFailure } from '../../../shared/contracts/tasks';
import { command } from '../../api/commands';
import { condenseEvents, displayLog, eventBadge, filterCondensed, kindLabels, redactLog, relativeTime, toneColor, type TimelineItem } from './log-view';
import { loadAllEvents, progressiveFor, type EventPage } from './load-events';
import { styles } from '../../ui/styles';
import { styles as eventStyles } from './events-style';
import { TaskTextBlock } from './TaskTextBlock';
import { fullTime, useProjectTimeZone } from '../../format/timezone';

/** Relative time, right aligned, with the absolute time in a tooltip. */
function RelativeTime({ at }: { at: string }) {
  const zone = useProjectTimeZone();
  return <Tooltip title={fullTime(at, zone)}>
    <time className={eventStyles.time} dateTime={at}>{relativeTime(at)}</time>
  </Tooltip>;
}

/** Long text folds to a few lines with an expand toggle. */
function FoldText({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.split('\n').length > 6 || text.length > 600;
  return <>
    <pre className={`${eventStyles.cardText}${long && !expanded ? ` ${eventStyles.cardClamped}` : ''}`}>{text}</pre>
    {long && <div><Button size="small" type="text" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}${label}`} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开'}</Button></div>}
  </>;
}

function ResultCard({ event }: { event: TaskEvent }) {
  return <div className={`${eventStyles.card} ${eventStyles.cardSuccess}`}>
    <div className={eventStyles.cardHead}><Text style={{ fontWeight: 600 }}>执行完成</Text><RelativeTime at={event.at} /></div>
    <TaskTextBlock className={eventStyles.resultText} title="执行结果" content={redactLog(event.message)} markdown clamp={6} />
  </div>;
}

function FailureCard({ failure }: { failure: TaskFailure }) {
  const message = redactLog(failure.message);
  return <div className={`${eventStyles.card} ${eventStyles.cardError}`}>
    <div className={eventStyles.cardHead}>
      <Text style={{ fontWeight: 600 }} type="danger">失败原因</Text>
      <CopyButton content={[message, failure.stderrTail && redactLog(failure.stderrTail), failure.vendorError && redactLog(failure.vendorError)].filter(Boolean).join('\n\n')} size="small" aria-label="复制失败信息" title="复制失败信息" />
    </div>
    <FoldText text={message} label="失败原因" />
    {failure.vendorError && <div><Text type="secondary" fontSize={12}>供应商错误</Text><pre className={eventStyles.cardCode}>{redactLog(failure.vendorError)}</pre></div>}
    {failure.stderrTail && <div><Text type="secondary" fontSize={12}>stderr 末尾</Text><pre className={eventStyles.cardCode}>{redactLog(failure.stderrTail)}</pre></div>}
  </div>;
}

/** Status tags are solid in the shared status scheme; outcomes are outlined so the two never look alike. */
function BadgeTag({ event }: { event: TaskEvent }): ReactNode {
  const badge = eventBadge(event);
  if (!badge) return null;
  return <Tag size="small" className={eventStyles.tag} variant={badge.outcome ? 'outlined' : 'solid'} color={toneColor(badge.tone)}>{badge.label}</Tag>;
}

function dotClass(event: TaskEvent): string {
  switch (event.kind) {
    case 'lifecycle': return eventStyles.dotLifecycle;
    case 'result': return eventStyles.dotSuccess;
    case 'error': return eventStyles.dotError;
    case 'artifact': return eventStyles.dotInfo;
    default: return '';
  }
}
const Dot = ({ className = '' }: { className?: string }) => <span aria-hidden="true" className={`${eventStyles.dot} ${className}`} />;

function EventNode({ event, failure }: { event: TaskEvent; failure?: TaskFailure }) {
  if (event.kind === 'result') return <ResultCard event={event} />;
  const message = displayLog(event.message).trim() || kindLabels[event.kind];
  const covered = event.kind === 'error' && !!failure && redactLog(failure.message) === message;
  return <div>
    <div className={eventStyles.head}>
      <div className={eventStyles.headMain}>
        <BadgeTag event={event} />
        {!covered && <Text className={styles.wrap} type={event.kind === 'error' ? 'danger' : event.kind === 'lifecycle' ? undefined : 'secondary'}>{message}</Text>}
      </div>
      <RelativeTime at={event.at} />
    </div>
    {event.kind === 'error' && failure && <FailureCard failure={failure} />}
  </div>;
}

/** Merged tool calls: a static summary line with the count and per-tool tags; no per-call details. */
function StepsNode({ item }: { item: Extract<TimelineItem, { type: 'steps' }> }) {
  return <div className={eventStyles.head}>
    <div className={eventStyles.headMain}>
      {item.inProgress && <Icon icon={Loader2} spin size="small" />}
      <Text>执行了 {item.count} 个步骤</Text>
      {item.tools.map(tool => <Tag key={tool.name} size="small" className={eventStyles.tag}>{tool.name} {tool.count}</Tag>)}
    </div>
    <RelativeTime at={item.to.at} />
  </div>;
}

export function EventsPanel({ events, taskId, active = false, failure }: { events: TaskEvent[]; taskId: string; active?: boolean; failure?: TaskFailure }) {
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState<TaskEvent[]>(events);
  const loadedRef = useRef(loaded);
  const applyLoaded = (next: TaskEvent[]) => { loadedRef.current = next; setLoaded(next); };
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const loadedTaskId = useRef<string | null>(null);
  useEffect(() => {
    const id = ++generation.current;
    const isCurrent = () => id === generation.current;
    // The first load of a task shows pages as they arrive; later refreshes of the same task swap in the full list at once, so the timeline never shrinks back.
    const progressive = progressiveFor(loadedTaskId.current, taskId, loadedRef.current.length);
    const switched = loadedTaskId.current !== taskId;
    loadedTaskId.current = taskId;
    if (switched) applyLoaded(events);
    setBusy(true);
    void loadAllEvents(after => command<EventPage>('tasks.events', { taskId, limit: 100, ...(after ? { after } : {}) }), isCurrent, progress => { if (isCurrent() && progressive) applyLoaded(progress); })
      .then(all => { if (isCurrent()) applyLoaded(all); })
      .catch(cause => { if (isCurrent()) notifyError(cause, '事件加载失败', { label: '重试', run: () => setAttempt(count => count + 1) }); })
      .finally(() => { if (isCurrent()) setBusy(false); });
    return () => { generation.current += 1; };
  }, [taskId, events.length, attempt]);
  const condensed = useMemo(() => filterCondensed(condenseEvents(loaded, { active }), query), [loaded, active, query]);
  const lastError = [...loaded].reverse().find(event => event.kind === 'error');
  const empty = query.trim() ? '没有匹配的已加载事件。' : busy ? '正在加载事件…' : '暂无事件。任务状态和子 Agent 输出会记在这里。';
  return <div aria-busy={busy} className={styles.stack}>
    <Input aria-label="搜索已加载事件" placeholder="按消息内容筛选" value={query} onChange={event => setQuery(event.target.value)} />
    {!condensed.length ? <Text type="secondary">{empty}</Text> : <Steps className={eventStyles.timeline} orientation="vertical" classNames={{ indicator: eventStyles.indicator, title: eventStyles.nodeTitle }} items={condensed.map(item => item.type === 'steps'
      ? { key: item.from.id, icon: <Dot />, title: <StepsNode item={item} /> }
      : { key: item.event.id, icon: <Dot className={dotClass(item.event)} />, title: <EventNode event={item.event} failure={item.event.id === lastError?.id ? failure : undefined} /> })} />}
  </div>;
}
