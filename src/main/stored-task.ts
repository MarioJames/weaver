import { validateProxy } from '../shared/proxy';
import { validateContinuationFields } from './continuation';
import { isRealEngineKind } from './workspace';
import type { Task, TaskEvent, AgentRun } from '../shared/types';
import { object, parseId, parseTaskInput, parseWorkerRecord, text } from '../shared/validation';
function date(value: unknown): string {const raw=text(value,'timestamp',40);if (!Number.isFinite(Date.parse(raw))) throw new Error('Invalid timestamp');return raw;}
/** Persisted local files are data too: validate nested fields before exposing anything to the UI. */
export function parseStoredTask(value: unknown): Task {
 const raw=object(value); const input=parseTaskInput(raw);
 if (!['queued','running','cancelling','completed','failed','cancelled'].includes(String(raw.status))) throw new Error('Invalid stored task status');
 if (typeof raw.progress!=='number' || !Number.isFinite(raw.progress) || raw.progress<0 || raw.progress>100) throw new Error('Invalid stored progress');
 if (!Array.isArray(raw.events) || raw.events.length>500 || !Array.isArray(raw.artifacts) || raw.artifacts.length>20) throw new Error('Invalid stored task collections');
 const events=raw.events.map(value => {
  const event=object(value);
  if (!['lifecycle','log','progress','artifact','result','error'].includes(String(event.kind))) throw new Error('Invalid event kind');
  return {id:parseId(event.id),at:date(event.at),kind:event.kind as TaskEvent['kind'],message:text(event.message,'event message',40000,true)};
 });
 const artifacts=raw.artifacts.map(value => {
  const artifact=object(value);const parsed=parseWorkerRecord({...artifact,type:'artifact'});
  if (parsed.type!=='artifact') throw new Error('Invalid stored artifact');
  return {id:parseId(artifact.id),createdAt:date(artifact.createdAt),name:parsed.name,mediaType:parsed.mediaType,content:parsed.content};
 });
 let run: AgentRun | undefined;
 if (raw.run!==undefined) {
  const value=object(raw.run);
  const adapter=text(value.adapter,'adapter',80);
  const execution=value.execution===undefined?'mock':value.execution;
  if((execution!=='mock'&&execution!=='real'&&execution!=='native') || !['idle','running','stopping','stopped'].includes(String(value.status))) throw new Error('Invalid stored agent run');
  if(execution==='native'&&adapter!=='native') throw new Error('Invalid stored agent run');
  if(execution==='mock'&&adapter!=='mock-jsonl') throw new Error('Invalid stored agent run');
  if(execution==='real'&&!isRealEngineKind(adapter)) throw new Error('Invalid stored agent run');
  run={id:parseId(value.id),adapter,execution,status:value.status as AgentRun['status']};
  if(value.scopeUnit!==undefined)run.scopeUnit=text(value.scopeUnit,'scopeUnit',200);
  if(value.evidence!==undefined){
   const e=object(value.evidence);
   if(!isRealEngineKind(String(e.engine))||!['pending','success','error','cancelled','missing','truncated'].includes(String(e.terminal)))throw new Error('Invalid provider evidence');
   const evidence:NonNullable<AgentRun['evidence']>={engine:e.engine as NonNullable<AgentRun['evidence']>['engine'],requestedModel:text(e.requestedModel,'requestedModel',200),requestedEffort:text(e.requestedEffort,'requestedEffort',120),workspace:text(e.workspace,'workspace',2000),terminal:e.terminal as NonNullable<AgentRun['evidence']>['terminal']};
   if(e.role!==undefined){if(e.role!=='worker'&&e.role!=='owner')throw new Error('Invalid evidence role');evidence.role=e.role;}
   for(const key of ['vendorSessionId','vendorModel'] as const)if(e[key]!==undefined)evidence[key]=text(e[key],key,512);
   for(const key of ['promptPath','sessionDir'] as const)if(e[key]!==undefined)evidence[key]=text(e[key],key,2000);
   if(e.usage!==undefined){const usage=object(e.usage);evidence.usage={};for(const key of ['inputTokens','outputTokens'] as const)if(usage[key]!==undefined){if(!Number.isSafeInteger(usage[key])||Number(usage[key])<0)throw new Error('Invalid provider usage');evidence.usage[key]=Number(usage[key]);}}
   run.evidence=evidence;
  }
  for (const key of ['engine','model','effort','workspace'] as const) if(value[key]!==undefined) run[key]=text(value[key],key,key==='workspace'?2000:200);
  // Runs no longer write a timeout; older stores may still carry one, so it stays accepted here.
  if(value.timeoutMs!==undefined){if(!Number.isSafeInteger(value.timeoutMs)||Number(value.timeoutMs)<1)throw new Error('Invalid timeout');run.timeoutMs=Number(value.timeoutMs);}
  if(value.pid!==undefined) {if(typeof value.pid!=='number'||!Number.isSafeInteger(value.pid)||value.pid<=0)throw new Error('Invalid PID');run.pid=value.pid;}
  if(value.firstOutputAt!==undefined)run.firstOutputAt=date(value.firstOutputAt);
  if(value.startedAt!==undefined)run.startedAt=date(value.startedAt);
  if(value.endedAt!==undefined)run.endedAt=date(value.endedAt);
  if(value.exitCode!==undefined) {if(value.exitCode!==null&&(typeof value.exitCode!=='number'||!Number.isSafeInteger(value.exitCode)))throw new Error('Invalid exit code');run.exitCode=value.exitCode as number|null;}
 }
 const extra: Partial<Task>=validateContinuationFields(raw);
 if(raw.failure!==undefined){
  const f=object(raw.failure);
  if(!['early_exit','no_output','rate_limit','quota','auth','vendor','cancelled','other'].includes(String(f.kind)))throw new Error('Invalid failure kind');
  extra.failure={kind:f.kind as NonNullable<Task['failure']>['kind'],message:text(f.message,'failure message',8000)};
  for(const key of ['stderrTail','vendorError'] as const)if(f[key]!==undefined)extra.failure[key]=text(f[key],key,2048,true);
  if(f.retryAt!==undefined)extra.failure.retryAt=date(f.retryAt);
  if(f.exitCode!==undefined){if(!Number.isSafeInteger(f.exitCode))throw new Error('Invalid failure exit code');extra.failure.exitCode=Number(f.exitCode);}
 }

 if(raw.revision!==undefined) {if(!Number.isSafeInteger(raw.revision)||Number(raw.revision)<0)throw new Error('Invalid revision');extra.revision=Number(raw.revision);}
 if(raw.queueReason!==undefined){const q=object(raw.queueReason);if(!['waiting_for_capacity','policy_blocked','frozen_route_changed','workspace_changed','launch_blocked'].includes(String(q.code)))throw new Error('Invalid queue reason');extra.queueReason={code:q.code as NonNullable<Task['queueReason']>['code'],message:text(q.message,'queue reason',700)};}
 if(raw.scheduled!==undefined) {if(typeof raw.scheduled!=='boolean')throw new Error('Invalid scheduled flag');extra.scheduled=raw.scheduled;}
 if(raw.executionRole!==undefined){if(raw.executionRole!=='owner')throw new Error('Invalid execution role');extra.executionRole='owner';}
 for(const key of ['ownerId','packageId','retryOf','parentTaskId'] as const) if(raw[key]!==undefined) extra[key]=parseId(raw[key]);
 if(raw.ownerHost!==undefined) {
  const host=object(raw.ownerHost);
  if(host.kind!=='herdr')throw new Error('Invalid stored owner host');
  const agentName=text(host.agentName,'ownerHost agentName',40);
  if(!/^[a-z][a-z0-9_-]{0,31}$/.test(agentName))throw new Error('Invalid stored owner host');
  extra.ownerHost={kind:'herdr',session:text(host.session,'ownerHost session',120),workspaceId:text(host.workspaceId,'ownerHost workspaceId',80),paneId:text(host.paneId,'ownerHost paneId',80),agentName,launchedAt:date(host.launchedAt)};
 }
 if(raw.acknowledged!==undefined) {if(typeof raw.acknowledged!=='boolean')throw new Error('Invalid acknowledgment');extra.acknowledged=raw.acknowledged;}
 if(raw.reviewState!==undefined) {if(!['pending','accepted','rejected'].includes(String(raw.reviewState)))throw new Error('Invalid review');extra.reviewState=raw.reviewState as Task['reviewState'];}
 if(raw.reviewComment!==undefined)extra.reviewComment=text(raw.reviewComment,'review comment',4000,true);
 if(raw.dispatch!==undefined) {const d=object(raw.dispatch);if((d.execution!=='mock'&&d.execution!=='real'&&d.execution!=='native')||!Number.isSafeInteger(d.maxParallel)||Number(d.maxParallel)<1)throw new Error('Invalid dispatch');extra.dispatch={owner:text(d.owner,'owner',120),worker:text(d.worker,'worker',120),engine:text(d.engine,'engine',120),model:text(d.model,'model',200),effort:text(d.effort,'effort',120),execution:d.execution,maxParallel:Number(d.maxParallel)};if(d.maxWaitMinutes!==undefined){if(!Number.isSafeInteger(d.maxWaitMinutes)||Number(d.maxWaitMinutes)<1||Number(d.maxWaitMinutes)>1440)throw new Error('Invalid dispatch');extra.dispatch.maxWaitMinutes=Number(d.maxWaitMinutes);}if(d.proxy!==undefined){validateProxy(d.proxy as string);extra.dispatch.proxy=d.proxy as string;}if(d.adapter!==undefined)extra.dispatch.adapter=text(d.adapter,'adapter',80);if(d.workspace!==undefined)extra.dispatch.workspace=text(d.workspace,'workspace',2000);if(d.engineKind!==undefined)extra.dispatch.engineKind=text(d.engineKind,'engineKind',80);if(d.workspaceIdentity!==undefined)extra.dispatch.workspaceIdentity=text(d.workspaceIdentity,'workspaceIdentity',100);}
 return {...input,...extra,id:parseId(raw.id),createdAt:date(raw.createdAt),updatedAt:date(raw.updatedAt),status:raw.status as Task['status'],progress:raw.progress,events,artifacts,...(run?{run}:{}),...(raw.summary!==undefined?{summary:text(raw.summary,'summary',8000)}:{})};
}
