import { NamedSelect } from './NamedControls';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@lobehub/ui';
import { Button, Input, Segmented, Tag, Text } from '@lobehub/ui/base-ui';
import { ChevronRight, Loader2 } from 'lucide-react';
import type { TaskEvent } from '../../shared/types';
import { command } from '../commands';
import { condenseEvents, exportEvents, filterCondensed, kindLabels, redactLog, selectEvents, type TimelineItem } from '../log-view';
import { styles } from '../style';
import { styles as eventStyles } from './events-style';

interface EventPage { events: TaskEvent[]; nextCursor: string | null; hasMore: boolean }
const kinds = ['all', 'lifecycle', 'log', 'progress', 'artifact', 'result', 'error'];
const MODE_KEY = 'weaver-timeline-mode';
type Mode = 'condensed' | 'all';
const MODE_OPTIONS = [{ value: 'condensed', label: '精简' }, { value: 'all', label: '全部' }] as const;

function readMode(): Mode {
  try { return localStorage.getItem(MODE_KEY) === 'all' ? 'all' : 'condensed'; } catch { return 'condensed'; }
}
function saveMode(mode: Mode) { try { localStorage.setItem(MODE_KEY, mode); } catch {} }
function timeLabel(at: string) { return new Date(at).toLocaleTimeString(); }

function EventRow({ event }: { event: TaskEvent }) {
  return <div className={eventStyles.rawRow}>
    <time className={eventStyles.time} dateTime={event.at}>{timeLabel(event.at)}</time>
    <Tag size="small" className={event.kind === 'error' ? `${eventStyles.kindTag} ${eventStyles.kindDanger}` : eventStyles.kindTag}>{kindLabels[event.kind]}</Tag>
    <Text className={styles.wrap} type={event.kind === 'error' ? 'danger' : 'secondary'}>{redactLog(event.message)}</Text>
  </div>;
}

function StepsGroup({ item, open, onToggle }: { item: Extract<TimelineItem, { type: 'steps' }>; open: boolean; onToggle: () => void }) {
  const tools = item.tools.map(tool => `${tool.name} ${tool.count}`).join(' · ');
  const fromTime = timeLabel(item.from.at);
  const toTime = timeLabel(item.to.at);
  const range = fromTime === toTime ? fromTime : `${fromTime}–${toTime}`;
  return <div className={styles.tight}>
    <button type="button" className={eventStyles.stepRow} aria-expanded={open} aria-label={`步骤明细 ${range}`} onClick={onToggle}>
      <span className={eventStyles.time}>{range}</span>
      {item.inProgress && <Icon icon={Loader2} spin size="small" />}
      <Text className={eventStyles.tools}>执行了 {item.count} 个步骤{tools ? ` · ${tools}` : ''}</Text>
      <span className={eventStyles.chevron} data-expanded={open} aria-hidden="true"><Icon icon={ChevronRight} size="small" /></span>
    </button>
    {open && <div className={eventStyles.stepBody} role="region" aria-label={`原始事件 ${range}`}>{item.events.map(event => <EventRow key={event.id} event={event} />)}</div>}
  </div>;
}

export function EventsPanel({ events, taskId, active = false }: { events: TaskEvent[]; taskId: string; active?: boolean }) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<EventPage>({ events, nextCursor: null, hasMore: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const generation = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    const id = ++generation.current;
    setBusy(true); setError('');
    void command<EventPage>('tasks.events', { taskId, limit: 100 }).then(result => { if (id === generation.current) setPage(result); }).catch(cause => { if (id === generation.current) setError(String(cause)); }).finally(() => { if (id === generation.current) setBusy(false); });
    return () => { generation.current += 1; };
  }, [taskId, events.length, attempt]);
  async function more() {
    if (lock.current || busy || !page.nextCursor) return;
    lock.current = true; setBusy(true); const id = generation.current;
    try { const result = await command<EventPage>('tasks.events', { taskId, after: page.nextCursor, limit: 100 }); if (id === generation.current) setPage(current => ({ ...result, events: [...current.events, ...result.events] })); }
    catch (cause) { if (id === generation.current) setError(String(cause)); }
    finally { lock.current = false; if (id === generation.current) setBusy(false); }
  }
  const condensed = useMemo(() => filterCondensed(condenseEvents(page.events, { active }), query), [page.events, active, query]);
  const visible = selectEvents(page.events, kind, query);
  function download() {
    const url = URL.createObjectURL(new Blob([exportEvents(taskId, visible)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `weaver-events-${taskId}.json`; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function toggleGroup(id: string) { setOpenGroups(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  const empty = query.trim() ? '没有匹配的已加载事件。' : busy ? '正在加载事件…' : '暂无事件。任务状态和 worker 输出会记在这里。';
  return <div aria-busy={busy} className={styles.stack}>
    <div role="group" aria-label="时间线视图" className={styles.row}>
      <Segmented options={[...MODE_OPTIONS]} value={mode} onChange={value => { setMode(value); saveMode(value); }} />
      {mode === 'all' && <NamedSelect aria-label="事件类型" value={kind} options={kinds.map(value => ({ value, label: value === 'all' ? '全部' : value }))} onChange={value => { if (typeof value === 'string') setKind(value); }} />}
      <div className={styles.grow}><Input aria-label="搜索已加载事件" placeholder="按消息内容筛选" value={query} onChange={event => setQuery(event.target.value)} /></div>
      {mode === 'all' && <Button disabled={!visible.length} onClick={download}>导出已筛选日志</Button>}
    </div>
    {mode === 'all' && <Text type="secondary">已加载 {page.events.length} 条 · 导出会遮盖常见凭据格式</Text>}
    {error && <div role="alert" className={styles.stack}><Text type="danger">{error}</Text><Button disabled={busy} onClick={() => setAttempt(value => value + 1)}>重新读取时间线</Button></div>}
    {mode === 'condensed' ? (!condensed.length ? <Text type="secondary">{empty}</Text> : condensed.map(item => item.type === 'steps'
      ? <StepsGroup key={item.from.id} item={item} open={openGroups.has(item.from.id)} onToggle={() => toggleGroup(item.from.id)} />
      : <EventRow key={item.event.id} event={item.event} />))
      : (!visible.length ? <Text type="secondary">{empty}</Text> : visible.map(event => <EventRow key={event.id} event={event} />))}
    {page.hasMore && <Button disabled={busy} onClick={() => void more()}>{busy ? '加载中…' : '加载更多事件'}</Button>}
  </div>;
}
