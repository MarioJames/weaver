import React, { useState } from 'react';
import type { WeaverAPI } from '../shared/types';
import { CapabilitiesPanel } from './components/CapabilitiesPanel';
import { command } from './commands';
import { Settings } from './Settings';
import { useWorkbench } from './hooks/useWorkbench';
import { NewTaskDialog } from './components/NewTaskDialog';
import { TaskBoard } from './components/TaskBoard';
import { TaskDetail } from './components/TaskDetail';
declare global { interface Window { weaver: WeaverAPI } }
export function App() {
 const { tasks, caps, error, busy, loading, lastSync, syncState, refresh, action, dismissError }=useWorkbench();
 const [creating,setCreating]=useState(false);
 const [selected,setSelected]=useState<string>(); const [page,setPage]=useState<'tasks'|'settings'>('tasks');
 const task=tasks.find(item=>item.id===selected);
 return <div className="shell"><header><div className="brand"><span className="logo">W</span><div><h1>Weaver</h1><span className="muted">本地任务控制台</span></div></div><nav aria-label="主导航"><button aria-current={page==='tasks'?'page':undefined} onClick={()=>setPage('tasks')}>任务工作台</button><button aria-current={page==='settings'?'page':undefined} onClick={()=>setPage('settings')}>路由与配额</button></nav><div className="mode"><span className="dot"/> MOCK MODE <small>真实代理未连接</small></div></header>
 <div className="notice">当前为本地模拟工作区。Owner 与 worker 均使用 mock 承载；真实 provider 尚未连接。</div>
 {error&&<div className="error" role="alert"><span>{error}</span><div className="actions"><button disabled={busy||loading} onClick={()=>void refresh()}>重试连接</button><button onClick={dismissError} aria-label="关闭错误">×</button></div></div>}
 {page==='tasks'?<main><aside><div className="workspace-label">WORKSPACE<span>本地任务</span></div><button className="primary full new-task-button" disabled={busy||!caps||loading} onClick={()=>setCreating(true)}>＋ 新建任务</button><TaskBoard tasks={tasks} selected={selected} loading={loading} onSelect={setSelected}/></aside><TaskDetail key={selected??'empty'} task={task} action={action} busy={busy||!caps} onRetry={id=>void action(async()=>{const next=await command<{id:string}>('tasks.retry',{taskId:id},true);setSelected(next.id);})} onStart={id=>void action(()=>window.weaver.startTask(id))} onCancel={id=>void action(()=>window.weaver.cancelTask(id))}/></main>:<section className="settings-page"><div className="page-heading"><h2>路由与配额</h2><p className="muted">查看真实可用能力，保存本地策略并预览路由决策。</p></div><CapabilitiesPanel/><Settings/></section>}
 {creating&&<NewTaskDialog busy={busy} close={()=>setCreating(false)} create={input=>action(async()=>{const created=await command<{id:string}>('tasks.create',{...input},true);setSelected(created.id);})} importTask={()=>void action(async()=>{const imported=await window.weaver.importTask();if(imported){setSelected(imported.id);setCreating(false);}})}/>}<footer><span>{caps?`${caps.maxParallel} 个 worker 槽位 · 本地原子 JSON 存储`:loading?'正在连接桌面…':'桌面未连接'}</span><span className={`sync-status ${syncState}`}><i/>{busy?'正在处理…':syncState==='live'?`实时同步 · ${lastSync?new Date(lastSync).toLocaleTimeString():''}`:syncState==='stale'?'同步中断 · 显示上次快照':syncState==='disconnected'?'桌面未连接':'正在同步…'}</span></footer></div>;
}
