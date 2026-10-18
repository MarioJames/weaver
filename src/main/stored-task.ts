import { validateContinuationFields } from './continuation';
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
  if(value.adapter!=='mock-jsonl' || !['idle','running','stopping','stopped'].includes(String(value.status))) throw new Error('Invalid stored agent run');
  run={id:parseId(value.id),adapter:'mock-jsonl',status:value.status as AgentRun['status']};
  if(value.pid!==undefined) {if(typeof value.pid!=='number'||!Number.isSafeInteger(value.pid)||value.pid<=0)throw new Error('Invalid PID');run.pid=value.pid;}
  if(value.startedAt!==undefined)run.startedAt=date(value.startedAt);
  if(value.endedAt!==undefined)run.endedAt=date(value.endedAt);
  if(value.exitCode!==undefined) {if(value.exitCode!==null&&(typeof value.exitCode!=='number'||!Number.isSafeInteger(value.exitCode)))throw new Error('Invalid exit code');run.exitCode=value.exitCode as number|null;}
 }
 const extra: Partial<Task>=validateContinuationFields(raw);
 if(raw.revision!==undefined) {if(!Number.isSafeInteger(raw.revision)||Number(raw.revision)<0)throw new Error('Invalid revision');extra.revision=Number(raw.revision);}
 if(raw.scheduled!==undefined) {if(typeof raw.scheduled!=='boolean')throw new Error('Invalid scheduled flag');extra.scheduled=raw.scheduled;}
 for(const key of ['ownerId','packageId','retryOf'] as const) if(raw[key]!==undefined) extra[key]=parseId(raw[key]);
 if(raw.acknowledged!==undefined) {if(typeof raw.acknowledged!=='boolean')throw new Error('Invalid acknowledgment');extra.acknowledged=raw.acknowledged;}
 if(raw.reviewState!==undefined) {if(!['pending','accepted','rejected'].includes(String(raw.reviewState)))throw new Error('Invalid review');extra.reviewState=raw.reviewState as Task['reviewState'];}
 if(raw.reviewComment!==undefined)extra.reviewComment=text(raw.reviewComment,'review comment',4000,true);
 if(raw.dispatch!==undefined) {const d=object(raw.dispatch);if(d.execution!=='mock'||!Number.isSafeInteger(d.maxParallel)||Number(d.maxParallel)<1)throw new Error('Invalid dispatch');extra.dispatch={owner:text(d.owner,'owner',120),worker:text(d.worker,'worker',120),engine:text(d.engine,'engine',120),model:text(d.model,'model',200),effort:text(d.effort,'effort',120),execution:'mock',maxParallel:Number(d.maxParallel)};}
 return {...input,...extra,id:parseId(raw.id),createdAt:date(raw.createdAt),updatedAt:date(raw.updatedAt),status:raw.status as Task['status'],progress:raw.progress,events,artifacts,...(run?{run}:{}),...(raw.summary!==undefined?{summary:text(raw.summary,'summary',8000)}:{})};
}
