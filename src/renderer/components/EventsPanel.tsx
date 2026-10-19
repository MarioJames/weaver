import { NamedSelect } from './NamedControls';
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Text } from '@lobehub/ui/base-ui';
import type { TaskEvent } from '../../shared/types';
import { command } from '../commands';
import { exportEvents, redactLog, selectEvents } from '../log-view';
import { styles } from '../style';

interface EventPage { events: TaskEvent[]; nextCursor: string | null; hasMore: boolean }
const kinds = ['all', 'lifecycle', 'log', 'progress', 'artifact', 'result', 'error'];

export function EventsPanel({ events, taskId }: { events: TaskEvent[]; taskId: string }) {
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<EventPage>({ events, nextCursor: null, hasMore: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
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
  const visible = selectEvents(page.events, kind, query);
  function download() {
    const url = URL.createObjectURL(new Blob([exportEvents(taskId, visible)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `weaver-events-${taskId}.json`; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div aria-busy={busy} className={styles.stack}>
    <div className={styles.row}>
      <NamedSelect aria-label="事件类型" value={kind} options={kinds.map(value => ({ value, label: value === 'all' ? '全部' : value }))} onChange={value => { if (typeof value === 'string') setKind(value); }} />
      <div className={styles.grow}><Input aria-label="搜索已加载事件" placeholder="按消息内容筛选" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <Button disabled={!visible.length} onClick={download}>导出已筛选日志</Button>
    </div>
    <Text type="secondary">显示和导出会遮盖常见凭据格式，分享前仍需检查。已加载 {page.events.length} 条，筛选后 {visible.length} 条。</Text>
    {error && <div role="alert" className={styles.stack}><Text type="danger">{error}</Text><Button disabled={busy} onClick={() => setAttempt(value => value + 1)}>重新读取时间线</Button></div>}
    {!visible.length ? <Text type="secondary">{busy ? '正在加载事件…' : '暂无事件。任务状态和 worker 输出会记在这里。'}</Text> : visible.map(event => <div key={event.id} className={styles.row}><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time><Text type={event.kind === 'error' ? 'danger' : 'secondary'}>{event.kind}</Text><Text className={styles.wrap}>{redactLog(event.message)}</Text></div>)}
    {page.hasMore && <Button disabled={busy} onClick={() => void more()}>{busy ? '加载中…' : '加载更多事件'}</Button>}
  </div>;
}
