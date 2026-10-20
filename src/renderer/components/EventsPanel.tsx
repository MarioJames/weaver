import { notifyError } from '../notify';
import { NamedSelect } from './NamedControls';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CopyButton, Icon } from '@lobehub/ui';
import { Button, Input, Segmented, Steps, Tag, Text, Tooltip } from '@lobehub/ui/base-ui';
import { ChevronRight, FilePen, FileText, Loader2, Search, Terminal, Wrench } from 'lucide-react';
import type { TaskEvent, TaskFailure } from '../../shared/contracts/tasks';
import { command } from '../commands';
import { condenseEvents, displayLog, eventBadge, exportEvents, filterCondensed, formatDuration, kindLabels, redactLog, relativeTime, selectEvents, toneColor, toolSteps, type TimelineItem } from '../log-view';
import { styles } from '../style';
import { styles as eventStyles } from './events-style';
import { TaskTextBlock } from './TaskTextBlock';
import { TimeText } from './TimeText';
import { compactTime, fullTime, useProjectTimeZone } from '../timezone';

interface EventPage { events: TaskEvent[]; nextCursor: string | null; hasMore: boolean }
const kinds = ['all', 'lifecycle', 'log', 'progress', 'artifact', 'result', 'error'];
const MODE_KEY = 'weaver-timeline-mode';
type Mode = 'condensed' | 'all';
const MODE_OPTIONS = [{ value: 'condensed', label: '精简' }, { value: 'all', label: '全部' }] as const;
const TOOL_ICONS: Record<string, typeof Wrench> = { Bash: Terminal, Read: FileText, Edit: FilePen, Write: FilePen, Grep: Search };

function readMode(): Mode {
  try { return localStorage.getItem(MODE_KEY) === 'all' ? 'all' : 'condensed'; } catch { return 'condensed'; }
}
function saveMode(mode: Mode) { try { localStorage.setItem(MODE_KEY, mode); } catch {} }

function timeLabel(at: string) { return compactTime(at); }

/** Relative time, right aligned, with the absolute time in a tooltip. */
function RelativeTime({ at }: { at: string }) {
  const zone = useProjectTimeZone();
  return <Tooltip title={fullTime(at, zone)}>
    <time className={eventStyles.time} dateTime={at}>{relativeTime(at)}</time>
  </Tooltip>;
}

function EventRow({ event }: { event: TaskEvent }) {
  return <div className={eventStyles.rawRow}>
    <TimeText className={eventStyles.rawTime} value={event.at} />
    <Tag size="small" className={eventStyles.tag}>{kindLabels[event.kind]}</Tag>
    <Text className={styles.wrap} type={event.kind === 'error' ? 'danger' : 'secondary'}>{displayLog(event.message)}</Text>
  </div>;
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

function StepsNode({ item, open, onToggle }: { item: Extract<TimelineItem, { type: 'steps' }>; open: boolean; onToggle: () => void }) {
  const fromTime = timeLabel(item.from.at);
  const toTime = timeLabel(item.to.at);
  const range = fromTime === toTime ? fromTime : `${fromTime}–${toTime}`;
  const steps = open ? toolSteps(item.events) : [];
  return <div>
    <div className={eventStyles.head}>
      <button type="button" className={eventStyles.stepButton} aria-expanded={open} aria-label={`步骤明细 ${range}`} onClick={onToggle}>
        {item.inProgress && <Icon icon={Loader2} spin size="small" />}
        <Text>执行了 {item.count} 个步骤</Text>
        {item.tools.map(tool => <Tag key={tool.name} size="small" className={eventStyles.tag}>{tool.name} {tool.count}</Tag>)}
        <span className={eventStyles.chevron} data-expanded={open} aria-hidden="true"><Icon icon={ChevronRight} size="small" /></span>
      </button>
      <RelativeTime at={item.to.at} />
    </div>
    {open && <ul className={eventStyles.stepList} aria-label={`原始事件 ${range}`}>{steps.map(step => <li key={step.id} className={`${eventStyles.stepItem}${step.failed ? ` ${eventStyles.stepItemFailed}` : ''}`}>
      <Icon icon={TOOL_ICONS[step.name] ?? Wrench} size="small" />
      <span className={eventStyles.stepName}>{step.name}</span>
      {step.failed && <span>失败</span>}
      <span className={eventStyles.stepDuration}>{step.durationMs === undefined ? '' : formatDuration(step.durationMs)}</span>
    </li>)}</ul>}
  </div>;
}

export function EventsPanel({ events, taskId, active = false, failure }: { events: TaskEvent[]; taskId: string; active?: boolean; failure?: TaskFailure }) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<EventPage>({ events, nextCursor: null, hasMore: false });
  const [busy, setBusy] = useState(false);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const generation = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    const id = ++generation.current;
    setBusy(true);
    void command<EventPage>('tasks.events', { taskId, limit: 100 }).then(result => { if (id === generation.current) setPage(result); }).catch(cause => { if (id === generation.current) notifyError(cause); }).finally(() => { if (id === generation.current) setBusy(false); });
    return () => { generation.current += 1; };
  }, [taskId, events.length]);
  async function more() {
    if (lock.current || busy || !page.nextCursor) return;
    lock.current = true; setBusy(true); const id = generation.current;
    try { const result = await command<EventPage>('tasks.events', { taskId, after: page.nextCursor, limit: 100 }); if (id === generation.current) setPage(current => ({ ...result, events: [...current.events, ...result.events] })); }
    catch (cause) { if (id === generation.current) notifyError(cause); }
    finally { lock.current = false; if (id === generation.current) setBusy(false); }
  }
  const condensed = useMemo(() => filterCondensed(condenseEvents(page.events, { active }), query), [page.events, active, query]);
  const visible = selectEvents(page.events, kind, query);
  const lastError = [...page.events].reverse().find(event => event.kind === 'error');
  function download() {
    const url = URL.createObjectURL(new Blob([exportEvents(taskId, visible)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `weaver-events-${taskId}.json`; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function toggleGroup(id: string) { setOpenGroups(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  const empty = query.trim() ? '没有匹配的已加载事件。' : busy ? '正在加载事件…' : '暂无事件。任务状态和子 Agent 输出会记在这里。';
  return <div aria-busy={busy} className={styles.stack}>
    <div role="group" aria-label="时间线视图" className={styles.row}>
      <Segmented options={[...MODE_OPTIONS]} value={mode} onChange={value => { setMode(value); saveMode(value); }} />
      {mode === 'all' && <NamedSelect aria-label="事件类型" value={kind} options={kinds.map(value => ({ value, label: value === 'all' ? '全部' : value }))} onChange={value => { if (typeof value === 'string') setKind(value); }} />}
      <div className={styles.grow}><Input aria-label="搜索已加载事件" placeholder="按消息内容筛选" value={query} onChange={event => setQuery(event.target.value)} /></div>
      {mode === 'all' && <Button disabled={!visible.length} onClick={download}>导出已筛选日志</Button>}
    </div>
    {mode === 'all' && <Text type="secondary">已加载 {page.events.length} 条 · 导出会遮盖常见凭据格式</Text>}
    {mode === 'condensed' ? (!condensed.length ? <Text type="secondary">{empty}</Text> : <Steps className={eventStyles.timeline} orientation="vertical" classNames={{ indicator: eventStyles.indicator, title: eventStyles.nodeTitle }} items={condensed.map(item => item.type === 'steps'
      ? { key: item.from.id, icon: <Dot />, title: <StepsNode item={item} open={openGroups.has(item.from.id)} onToggle={() => toggleGroup(item.from.id)} /> }
      : { key: item.event.id, icon: <Dot className={dotClass(item.event)} />, title: <EventNode event={item.event} failure={item.event.id === lastError?.id ? failure : undefined} /> })} />)
      : (!visible.length ? <Text type="secondary">{empty}</Text> : visible.map(event => <EventRow key={event.id} event={event} />))}
    {page.hasMore && <Button disabled={busy} onClick={() => void more()}>{busy ? '加载中…' : '加载更多事件'}</Button>}
  </div>;
}
