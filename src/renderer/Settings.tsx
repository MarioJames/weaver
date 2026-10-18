import React, { useEffect, useRef, useState } from 'react';
import type { PolicySnapshot, RoutePreview } from '../shared/policy';
export function Settings() {
 const lock=useRef(false);
 const [snapshot,setSnapshot]=useState<PolicySnapshot>(); const [draft,setDraft]=useState(''); const [blocks,setBlocks]=useState('');
 const [owner,setOwner]=useState(''); const [cls,setClass]=useState('judgment'); const [tag,setTag]=useState(''); const [count,setCount]=useState(0);
 const [result,setResult]=useState<RoutePreview>(); const [message,setMessage]=useState(''); const [busy,setBusy]=useState(false);
 function accept(s: PolicySnapshot) {setSnapshot(s);setDraft(JSON.stringify(s.config,null,2));setBlocks(JSON.stringify(s.blocks,null,2));setOwner(current=>Object.hasOwn(s.config.owners,current)?current:Object.keys(s.config.owners)[0]??'');setResult(undefined);}
 async function run(fn:()=>Promise<void>) {if(lock.current)return;lock.current=true;setBusy(true);setMessage('');try {await fn();} catch(e) {setMessage(String(e));}finally{lock.current=false;setBusy(false);}}
 useEffect(()=>{if(window.weaver) void run(async()=>accept(await window.weaver.getPolicy()));else setMessage('桌面连接不可用，策略设置暂不可用。');},[]);
 return <details className="policy-settings" open><summary>路由策略与配额设置（仅预览）</summary>
  <p>保存的策略用于调度准入与路由选择，但不会启用真实 provider。当前仅执行内置 mock，任务详情会记录实际调度结果。</p>
  <p>Engine 与 model 是策略配置词汇，不代表已安装的执行能力。herdr.max_wait_minutes 仅为兼容保留，不影响运行时。</p>
  <div className="policy-grid"><label>策略配置 JSON<textarea rows={14} spellCheck={false} maxLength={262144} value={draft} disabled={busy||!snapshot} onChange={e=>{setDraft(e.target.value);setResult(undefined);}}/></label>
  <label>配额限制 JSON<textarea rows={14} spellCheck={false} maxLength={262144} value={blocks} disabled={busy||!snapshot} onChange={e=>{setBlocks(e.target.value);setResult(undefined);}}/><small>每项包含 engine、reason、since（含时区的 ISO 时间）；可选 model、release_at、by。不填 release_at 表示手动限制；移除条目可解除限制。已过期的限制不会参与路由。</small></label></div>
  <div className="actions"><button disabled={busy||!snapshot} onClick={()=>void run(async()=>{const issues=await window.weaver.validatePolicy(JSON.parse(draft));setMessage(issues.length?issues.map(i=>`${i.path}: ${i.message}`).join('\n'):'策略配置有效；配额限制会在保存时校验。');})}>验证配置</button>
  <button disabled={busy||!snapshot} onClick={()=>void run(async()=>{accept(await window.weaver.savePolicy({revision:snapshot!.revision,config:JSON.parse(draft),blocks:JSON.parse(blocks)}));setMessage('策略已保存到本地。真实 provider 执行仍未启用。');})}>保存策略与配额</button>
  <button disabled={busy||!window.weaver} onClick={()=>void run(async()=>{accept(await window.weaver.getPolicy());setMessage('已重新加载保存的配置，未保存的修改已丢弃。');})}>重新加载已保存配置</button></div>
  {snapshot&&<><h3>已保存策略的路由预览</h3><div className="policy-controls"><label>Owner<select value={owner} onChange={e=>{setOwner(e.target.value);setResult(undefined);}}>{Object.keys(snapshot.config.owners).map(id=><option key={id}>{id}</option>)}</select></label>
  <label>Class<select value={cls} onChange={e=>{setClass(e.target.value);setResult(undefined);}}>{['mechanical','routine','judgment'].map(c=><option key={c}>{c}</option>)}</select></label>
  <label>领域标签（仅 judgment）<input value={tag} disabled={cls!=='judgment'} onChange={e=>{setTag(e.target.value);setResult(undefined);}}/></label>
  <label>假设正在运行的 worker 数<input type="number" min={0} step={1} value={count} onChange={e=>{setCount(Number(e.target.value));setResult(undefined);}}/></label>
  <button disabled={busy||!owner} onClick={()=>void run(async()=>{setResult(undefined);setResult(await window.weaver.previewRoute({owner,class:cls,...(cls==='judgment'&&tag?{tag}:{}),runningCount:count}));})}>预览路由</button></div>
  <p>已保存版本 {snapshot.revision} · 加载时有 {snapshot.activeBlocks.length} 项生效限制 · 真实 provider 未启用</p></>}
  {message&&<pre role="status">{message}</pre>}{result&&<pre aria-label="Route preview">{JSON.stringify(result,null,2)}</pre>}
 </details>;
}
