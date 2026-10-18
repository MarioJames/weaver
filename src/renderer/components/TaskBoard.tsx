import React, { useState } from 'react';
import type { Task } from '../../shared/types';
import { filterTasks, reviewLabel, statusLabels, type TaskFilter } from '../task-view';
export function TaskBoard({ tasks, selected, loading, onSelect }: { tasks: Task[]; selected?: string; loading: boolean; onSelect: (id: string) => void }) {
 const [query, setQuery] = useState(''); const [filter, setFilter] = useState<TaskFilter>('all');
 const visible = filterTasks(tasks, filter, query);
 return <section aria-label="任务看板"><div className="section-title board-title"><h2>任务看板</h2><span className="count">{tasks.length}</span></div>
 <label className="search-label">搜索任务<input type="search" placeholder="标题、Owner 或任务 ID" value={query} onChange={event => setQuery(event.target.value)}/></label>
 <div className="filters" aria-label="任务筛选">{(['all','active','review','closed'] as TaskFilter[]).map((value, i) => <button key={value} aria-pressed={filter===value} className={filter===value?'active':''} onClick={()=>setFilter(value)}>{['全部','进行中','待验收','已结束'][i]}</button>)}</div>
 <div className="task-list" aria-busy={loading}>{loading && !tasks.length ? <p role="status" className="empty muted">正在加载本地任务…</p> : !visible.length ? <p className="empty muted">{tasks.length?'没有符合筛选的任务':'还没有任务。从上方创建第一个任务。'}</p> : visible.map(task => <button key={task.id} aria-current={selected===task.id?'true':undefined} className={`task-card ${selected===task.id?'selected':''}`} onClick={()=>onSelect(task.id)}><div className="card-top"><span className={`status ${task.status}`}>{statusLabels[task.status]}</span><span>{task.progress}%</span></div><strong>{task.title}</strong><small>{task.owner.name} · {task.status==='completed'?reviewLabel(task):new Date(task.createdAt).toLocaleString()}</small></button>)}</div></section>;
}
