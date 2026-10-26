import { notifyError } from '../../api/notify';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button, CopyButton, Icon, Input, Steps, Tag, Text, Tooltip } from '@lobehub/ui';
import { Loader2 } from 'lucide-react';
import type { TaskEvent, TaskFailure } from '../../../shared/contracts/tasks';
import { command } from '../../api/commands';
import { condenseEvents, displayLog, eventBadge, filterCondensed, kindLabels, redactLog, relativeTime, type TimelineItem } from './log-view';
import { loadAllEvents, progressiveFor, type EventPage } from './load-events';
import { statusTagColor, tagColor } from '../../format/tag-colors';
import { styles } from '../../ui/styles';
import { styles as eventStyles } from './events-style';
import { TaskTextBlock } from './TaskTextBlock';
import { fullTime, useProjectTimeZone } from '../../format/timezone';

/** Relative time, right aligned, with the absolute time in a tooltip. */
function RelativeTime({ at }: { at: string }) {
  const zone = useProjectTimeZone();
  return <Tooltip title={fullTime(at, zone)}>
    <time {...stylex.props(eventStyles.time)} dateTime={at}>{relativeTime(at)}</time>
  </Tooltip>;
}

/** Long text folds to a few lines with an expand toggle. */
function FoldText({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.split('\n').length > 6 || text.length > 600;
  return <>
    <pre {...stylex.props(eventStyles.cardText, long && !expanded && eventStyles.cardClamped)}>{text}</pre>
    {long && <div><Button size="small" type="text" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}${label}`} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开'}</Button></div>}
  </>;
}

function ResultCard({ event }: { event: TaskEvent }) {
  return <div {...stylex.props(eventStyles.card, eventStyles.cardSuccess)}>
    <div {...stylex.props(eventStyles.cardHead)}><Text strong>执行完成</Text><RelativeTime at={event.at} /></div>
    <TaskTextBlock flat title="执行结果" content={redactLog(event.message)} markdown clamp={6} />
  </div>;
}

function FailureCard({ failure }: { failure: TaskFailure }) {
  const message = redactLog(failure.message);
  return <div {...stylex.props(eventStyles.card, eventStyles.cardError)}>
    <div {...stylex.props(eventStyles.cardHead)}>
      <Text strong type="danger">失败原因</Text>
      <CopyButton content={[message, failure.stderrTail && redactLog(failure.stderrTail), failure.vendorError && redactLog(failure.vendorError)].filter(Boolean).join('\n\n')} size="small" aria-label="复制失败信息" title="复制失败信息" />
    </div>
    <FoldText text={message} label="失败原因" />
    {failure.vendorError && <div><Text type="secondary" fontSize={12}>供应商错误</Text><pre {...stylex.props(eventStyles.cardCode)}>{redactLog(failure.vendorError)}</pre></div>}
    {failure.stderrTail && <div><Text type="secondary" fontSize={12}>stderr 末尾</Text><pre {...stylex.props(eventStyles.cardCode)}>{redactLog(failure.stderrTail)}</pre></div>}
  </div>;
}

/** Status tags are solid in the shared status scheme; outcomes are outlined so the two never look alike. */
function BadgeTag({ event }: { event: TaskEvent }): ReactNode {
  const badge = eventBadge(event);
  if (!badge) return null;
  return <Tag size="small" className={stylex.props(eventStyles.tag).className} variant={badge.outcome ? 'outlined' : 'solid'} color={statusTagColor(badge.tone)}>{badge.label}</Tag>;
}

const dotTones = {
  lifecycle: eventStyles.dotLifecycle,
  success: eventStyles.dotSuccess,
  error: eventStyles.dotError,
  info: eventStyles.dotInfo,
} as const;

type DotTone = keyof typeof dotTones;

function dotTone(event: TaskEvent): DotTone | undefined {
  switch (event.kind) {
    case 'lifecycle': return 'lifecycle';
    case 'result': return 'success';
    case 'error': return 'error';
    case 'artifact': return 'info';
    default: return undefined;
  }
}

const Dot = ({ tone }: { tone?: DotTone }) => <span aria-hidden="true" {...stylex.props(eventStyles.dot, tone && dotTones[tone])} />;

function EventNode({ event, failure }: { event: TaskEvent; failure?: TaskFailure }) {
  if (event.kind === 'result') return <ResultCard event={event} />;
  const message = displayLog(event.message).trim() || kindLabels[event.kind];
  const covered = event.kind === 'error' && !!failure && redactLog(failure.message) === message;
  return <div>
    <div {...stylex.props(eventStyles.head)}>
      <div {...stylex.props(eventStyles.headMain)}>
        <BadgeTag event={event} />
        {!covered && <Text className={stylex.props(styles.wrap).className} type={event.kind === 'error' ? 'danger' : event.kind === 'lifecycle' ? undefined : 'secondary'}>{message}</Text>}
      </div>
      <RelativeTime at={event.at} />
    </div>
    {event.kind === 'error' && failure && <FailureCard failure={failure} />}
  </div>;
}

/** Merged tool calls: a static summary line with the count and per-tool tags; no per-call details. */
function StepsNode({ item }: { item: Extract<TimelineItem, { type: 'steps' }> }) {
  return <div {...stylex.props(eventStyles.head)}>
    <div {...stylex.props(eventStyles.headMain)}>
      {item.inProgress && <Icon icon={Loader2} spin size="small" />}
      <Text>执行了 {item.count} 个步骤</Text>
      {item.tools.map(tool => <Tag key={tool.name} size="small" className={stylex.props(eventStyles.tag).className} color={tagColor('neutral')}>{tool.name} {tool.count}</Tag>)}
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
  return <div aria-busy={busy} {...stylex.props(styles.stack)}>
    <Input aria-label="搜索已加载事件" placeholder="按消息内容筛选" value={query} onChange={event => setQuery(event.target.value)} />
    {!condensed.length ? <Text type="secondary">{empty}</Text> : <Steps className={stylex.props(eventStyles.timeline).className} orientation="vertical" classNames={{ indicator: stylex.props(eventStyles.indicator).className }} items={condensed.map(item => item.type === 'steps'
      ? { key: item.from.id, icon: <Dot />, title: <div {...stylex.props(eventStyles.nodeTitle)}><StepsNode item={item} /></div> }
      : { key: item.event.id, icon: <Dot tone={dotTone(item.event)} />, title: <div {...stylex.props(eventStyles.nodeTitle)}><EventNode event={item.event} failure={item.event.id === lastError?.id ? failure : undefined} /></div> })} />}
  </div>;
}
