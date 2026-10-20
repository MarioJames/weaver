import { useNotifyError, isTransientError } from '../../api/notify';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Capabilities, Task } from '../../../shared/contracts/tasks';
import { createTaskSynchronizer } from './task-sync';
export function useWorkbench() {
 const [tasks,setTasks]=useState<Task[]>([]);const [caps,setCaps]=useState<Capabilities>();const [error,setError]=useState('');const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);
 useNotifyError(error, '控制面读取失败');
 const locked=useRef(false);const mounted=useRef(true);const sync=useRef<ReturnType<typeof createTaskSynchronizer<Task[]>> | undefined>(undefined);
 const connect=useCallback(async()=>{
  setLoading(true);setError('');
  if(!window.weaver){setError('控制面不可用。请通过 weaver web 打开这个页面。');setLoading(false);return;}
  try{const[,capabilities]=await Promise.all([sync.current?.refresh(),window.weaver.capabilities()]);if(mounted.current)setCaps(capabilities);}
  catch(error){if(mounted.current){ if(!isTransientError(error)){setError(String(error));} }}
  finally{if(mounted.current)setLoading(false);}
 },[]);
 useEffect(()=>{
  mounted.current=true;
  if(!window.weaver){void connect();return()=>{mounted.current=false;};}
  // Board copies contain preview events and metadata only; TasksPage loads detail through getTask.
  const channel=createTaskSynchronizer(()=>window.weaver.listTasks(),value=>{if(mounted.current)setTasks(value.map(task=>({...task,artifacts:task.artifacts.map(artifact=>({...artifact,content:''}))})));},error=>{if(mounted.current){ if(!isTransientError(error)){setError(String(error));} }},{isVisible:()=>!document.hidden});sync.current=channel;
  // Subscribe before requesting the initial authoritative snapshot to avoid a startup gap.
  const invalidate=()=>{void channel.refresh().catch(()=>{});};
  const unsubscribe=window.weaver.onTasksChanged(invalidate);
  void connect();
  // Snapshot recovery also catches dropped invalidations or resuming a suspended window.
  const timer=setInterval(invalidate,15000);window.addEventListener('focus',invalidate);const visible=()=>{if(document.visibilityState==='visible')invalidate();};document.addEventListener('visibilitychange',visible);
  return()=>{mounted.current=false;channel.dispose();unsubscribe();clearInterval(timer);window.removeEventListener('focus',invalidate);document.removeEventListener('visibilitychange',visible);};
 },[connect]);
 const action=useCallback(async(fn:()=>Promise<unknown>)=>{
  if(locked.current)return false;locked.current=true;setBusy(true);setError('');
  try{await fn();void sync.current?.refresh().catch(()=>{});return true;}
  catch(error){if(mounted.current){ if(!isTransientError(error)){setError(String(error));} }void sync.current?.refresh().catch(()=>{});return false;}
  finally{locked.current=false;if(mounted.current)setBusy(false);}
 },[]);
 return{tasks,caps,error,loading,busy,refresh:connect,action,dismissError:()=>setError('')};
}
