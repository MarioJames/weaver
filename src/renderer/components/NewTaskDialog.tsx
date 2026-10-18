import React, { useEffect, useRef } from 'react';
import { TaskComposer, type CreateTaskDraft } from './TaskComposer';
export function NewTaskDialog({ busy, close, create, importTask }: {busy:boolean;close:()=>void;create:(input:CreateTaskDraft)=>Promise<boolean>;importTask:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 return <dialog ref={dialog} className="task-dialog" onCancel={event=>{event.preventDefault();if(!busy)close();}} aria-label="创建任务"><div className="dialog-topline"><span>NEW TASK · 任务交接</span><button disabled={busy} onClick={close} aria-label="关闭新建任务">×</button></div><p className="dialog-intro">把目标交给 Weaver<br/><small>明确目标与验收标准，执行过程留在同一份记录里。</small></p><TaskComposer disabled={busy} onCreate={async input=>{const ok=await create(input);if(ok)close();return ok;}} onImport={importTask}/></dialog>;
}
