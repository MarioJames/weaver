import React, { useEffect, useState } from 'react';
import { command } from '../commands';
interface ControlCapabilities { apiVersion: string; ownerSpawn: string; manualAttach: string; workerProviders: string[]; realExecution: boolean; mcp: boolean; policyAdmission: boolean; maxParallel: number }
export function CapabilitiesPanel() {
 const [caps,setCaps]=useState<ControlCapabilities>(); const [error,setError]=useState(''); const [retry,setRetry]=useState(0);
 useEffect(()=>{let current=true;setError('');void command<ControlCapabilities>('capabilities.get',{}).then(value=>{if(current)setCaps(value);}).catch(error=>{if(current)setError(String(error));});return()=>{current=false;};},[retry]);
 if(error)return <div className="capability-error" role="alert"><p>{error}</p><button onClick={()=>setRetry(value=>value+1)}>重新读取能力</button></div>;
 if(!caps)return <p role="status" className="muted">正在查询控制面能力…</p>;
 return <div className="capability-grid"><article><h3>Worker 执行</h3><p>{caps.workerProviders.join(' · ')||'无可用 worker'}</p><span className="status">{caps.realExecution?'已启用真实执行':'仅本地 mock'} · {caps.maxParallel} 槽位</span></article><article><h3>Owner 承载</h3><p>创建：{caps.ownerSpawn}<br/>手动绑定：{caps.manualAttach}</p><span className="status cancelled">真实会话连接未实现</span></article><article><h3>统一控制接口</h3><p>{caps.apiVersion} · 路由准入{caps.policyAdmission?'已启用':'未启用'}</p><span className="status">MCP {caps.mcp?'已启用':'未启用'}</span></article></div>;
}
