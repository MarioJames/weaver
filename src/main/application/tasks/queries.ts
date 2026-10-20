import { API_VERSION, READ_COMMANDS, WRITE_COMMANDS, type DispatchNext } from '../../../shared/contracts/commands';
import type { StallStatus } from '../../../shared/contracts/monitoring';
import type { Task } from '../../../shared/contracts/tasks';
import { ownerSession } from '../../../shared/policy/owner-instance';
import { parseId, text } from '../../../shared/validation';
import type { TaskManager } from '../../manager';
import { QUOTA_CAPABILITIES } from '../../policy/quota';
import type { PolicyStore } from '../../policy/store';
import { redactContext } from '../../redact-context';
import { engineLadderKey } from '../../store';
import type { StallMonitor } from '../../stall';
import { REAL_ENGINE_KINDS, listWorkspaceDirectories } from '../../workspace';
import { fail } from '../commands/errors';
import type { CommandArgs } from '../commands/types';
import { publicTask, type TaskRecords } from './records';

/** Scale hint, not an admission rule: admission is per owner instance, so this sum over enabled profiles caps nothing by itself. */
export function configuredParallel(policy: PolicyStore): number {
 return Object.values(policy.snapshot().config.owners).filter(owner => owner.enabled).reduce((sum, owner) => sum + owner.max_parallel, 0);
}
/** The stall monitor is the only judge of silence, idle CPU and penalties, so the command face reads it
 * through the narrowest view that answers: one task's health, the engine status, one explicit unblock. */
export type TaskDiagnostics = Pick<StallMonitor, 'taskHealth' | 'status' | 'unblock'>;
/** What an owner sees per engine without the retained history: the same numbers the monitor armed its penalty with. */
const engineSummary=(item: StallStatus['engines'][string]) => ({level:item.level,lastTriggerAt:item.lastTriggerAt,needsAttention:item.needsAttention,blocked:item.blocked,blockedUntil:item.blockedUntil,nextProbeAt:item.nextProbeAt,probeSuccesses:item.probeSuccesses});
/** What the control plane can read without changing it: snapshots, task pages, traces, capabilities and the stall monitor's answers. */
export class Queries {
 constructor(private readonly manager:TaskManager,private readonly policy:PolicyStore,private readonly records:TaskRecords,
  private readonly diagnostics:TaskDiagnostics|undefined,
  private readonly environment:{transportStatus:()=>'ready'|'unavailable'|'not-started';herdrPresent:()=>boolean},
  private readonly nextFor:(task:Task)=>DispatchNext|undefined){}
  /** Health and penalties are the monitor's own answers; a process without one has nothing to invent them from. */
  private monitor():TaskDiagnostics {if(!this.diagnostics)fail('CAPABILITY_UNAVAILABLE','No stall monitor runs in this process, so health and penalty state cannot be read');return this.diagnostics!;}
 snapshot(a:CommandArgs):unknown{return {revision:this.manager.store.revision,tasks:this.manager.store.listHeads().map(t=>({id:t.id,title:t.title,status:t.status,revision:t.revision??0,ownerId:t.ownerId,updatedAt:t.updatedAt,reviewState:t.reviewState??'pending'})),owners:this.manager.store.listOwners().map(o=>({id:o.id,name:o.name,profileId:o.profileId,session:ownerSession(o),mode:o.mode,state:o.state}))};}
 status(a:CommandArgs):unknown{return {revision:this.manager.store.revision,changed:a.after!==this.manager.store.revision,recovery:'refresh sync.snapshot; push invalidation is not a durable event stream'};}
 capabilities(a:CommandArgs):unknown{return {apiVersion:API_VERSION,cliTransport:this.environment.transportStatus(),authentication:'ephemeral-local-trusted-user-demo',ownerScopedAuthorization:false,ownerSpawn:this.environment.herdrPresent()?'herdr':'logical-registration',manualAttach:'metadata-only',ownerModelSpawned:false,attachmentVerified:false,authenticated:false,modelUsable:false,workerProviders:this.manager.canLaunchReal?['mock-jsonl',...REAL_ENGINE_KINDS]:['mock-jsonl'],realExecution:this.manager.canLaunchReal,mcp:false,maxParallel:configuredParallel(this.policy),capacity:{unit:'owner-instance',aggregate:'sum of enabled owner profile max_parallel',admission:'Each attached owner instance holds its own profile max_parallel slots, so maxParallel is a scale hint, not a profile-wide or global cap.'},policyAdmission:true,quota:QUOTA_CAPABILITIES,commands:[...READ_COMMANDS,...WRITE_COMMANDS],limits:{eventsPerPage:100},durability:'durable intent before effect; interrupted commands require reconciliation, not automatic replay'};}
 workspaces(a:CommandArgs):unknown{return listWorkspaceDirectories(a.path);}
 taskGet(a:CommandArgs):unknown{
    const task=this.records.task(a);
    // A running native task is the owner's own subagent, so its instruction is recoverable here even if the spawn response was lost.
    const next=task.status==='running'&&task.dispatch?.execution==='native'?this.nextFor(task):undefined;
    return {...publicTask(task),...(next?{next}:{})};
   }
 taskList(a:CommandArgs):unknown{
    const offset=a.offset??0;const limit=a.limit??25;if(!Number.isSafeInteger(offset)||Number(offset)<0||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>100)fail('INVALID_REQUEST','Invalid pagination');
    if(a.parentTaskId!==undefined)parseId(a.parentTaskId);
    const all=this.manager.store.listSummaries().filter(t=>(a.ownerId===undefined||t.ownerId===a.ownerId)&&(a.parentTaskId===undefined||t.parentTaskId===a.parentTaskId));const tasks=all.slice(Number(offset),Number(offset)+Number(limit)).map(t=>{const {events,artifacts,...summary}=publicTask(t);return {...summary,artifactCount:artifacts.length};});return {tasks,nextOffset:Number(offset)+tasks.length<all.length?Number(offset)+tasks.length:null};
   }
 packageGet(a:CommandArgs):unknown{const pkg=this.manager.store.getPackage(parseId(a.packageId));if(!pkg)fail('NOT_FOUND','Package not found');return pkg;}
 taskEvents(a:CommandArgs):unknown{
    const task=this.records.task(a);const limit=a.limit??50;if(!Number.isInteger(limit)||Number(limit)<1||Number(limit)>100)fail('INVALID_REQUEST','Event limit must be 1–100');let start=0;
    if(a.after!==undefined){const i=task.events.findIndex(e=>e.id===a.after);if(i<0)fail('CURSOR_EXPIRED','Cursor not retained; refresh task snapshot');start=i+1;}
    const events=task.events.slice(start,start+Number(limit));return {events,nextCursor:events.at(-1)?.id??a.after??null,hasMore:start+events.length<task.events.length};
   }
 observability(command:'observability.get'|'observability.export',a:CommandArgs):unknown{
    const task=this.records.task(a);const redact=(value:string)=>redactContext(value,40000);
    const trace={taskId:task.id,ownerId:task.ownerId??null,packageId:task.packageId??null,attemptId:task.run?.id??null,revision:task.revision??0,execution:task.status,stage:task.scheduled?(task.queueReason?.code??'waiting_for_capacity'):task.status==='completed'?(task.reviewState==='accepted'?'accepted':'awaiting_review'):task.status,lastActivityAt:task.updatedAt,retryOf:task.retryOf??null,route:task.dispatch??null,queueReason:task.queueReason??null,run:task.run?{scopeUnit:task.run.scopeUnit??null,evidence:task.run.evidence??null}:null,artifacts:task.artifacts.map(v=>({id:v.id,name:redact(v.name)})),events:task.events.filter(e=>a.kind===undefined||e.kind===a.kind).map(e=>({...e,message:redact(e.message)})),metrics:{tokens:null,cost:null,contextUsage:null,source:task.dispatch?.execution==='real'?'not reported unless the provider emits evidence':'not reported by mock provider'},redaction:'best-effort pattern redaction; inspect before sharing'};return command==='observability.export'?{mediaType:'application/json',name:`weaver-trace-${task.id}.json`,content:JSON.stringify(trace,null,2)}:trace;
   }
   /** The monitor's own reading of one task, never a second classifier and never a guess about CPU. */
 taskHealth(a:CommandArgs):unknown{const task=this.records.task(a);return this.monitor().taskHealth(task);}
   /** Every configured engine as the monitor armed it, minus the retained history: that stays one call away. */
 enginesHealth(a:CommandArgs):unknown{
    const status=this.monitor().status();
    return {engines:Object.fromEntries(Object.entries(status.engines).map(([engine,item])=>[engine,engineSummary(item)])),config:status.config};
   }
 enginesPenalty(a:CommandArgs):unknown{
    const engine=text(a.engine,'engine',120);
    const engines=this.monitor().status().engines;
    if(!Object.hasOwn(engines,engine))fail('NOT_FOUND',`Engine ${engine} is not configured and has no penalty record`);
    // The ladder is per worker; the engine view reports the most recently triggered step among its workers.
    const config=this.policy.snapshot().config;const ladders=this.manager.store.listVendorLimits();
    const keys=[...Object.keys(config.workers).filter(id=>config.workers[id]!.engine===engine),engineLadderKey(engine)].filter(key=>ladders[key]);
    const latest=keys.sort((a,b)=>ladders[b]!.lastTriggerAt-ladders[a]!.lastTriggerAt)[0];
    return {engine,...engines[engine],vendorLimit:latest?{level:ladders[latest]!.level,lastTriggerAt:new Date(ladders[latest]!.lastTriggerAt).toISOString()}:null};
   }
 enginesUnblock(a:CommandArgs):unknown{
    // The engine table is checked before the monitor is asked, so a typo never reaches a policy write.
    const engine=text(a.engine,'engine',120);
    if(!Object.hasOwn(this.policy.snapshot().config.engines,engine))fail('NOT_FOUND',`Engine ${engine} is not configured`);
    const monitor=this.monitor();
    const wasBlocked=monitor.status().engines[engine]?.blocked===true;
    monitor.unblock(engine);
    const status=monitor.status();
    const after=status.engines[engine]!;
    return {engine,wasBlocked,cleared:engineSummary(after),retainedHistory:after.history,otherEngines:Object.fromEntries(Object.entries(status.engines).filter(([name])=>name!==engine).map(([name,item])=>[name,engineSummary(item)]))};
   }
 artifactRead(a:CommandArgs):unknown{const task=this.records.task(a);const artifact=task.artifacts.find(v=>v.id===parseId(a.artifactId));if(!artifact)fail('NOT_FOUND','Artifact not found');return artifact;}
 operationGet(a:CommandArgs):unknown{const id=text(a.commandId,'commandId',120);const receipt=this.manager.store.getReceipt(`local-demo:${id}`);if(!receipt)fail('NOT_FOUND','Command receipt not found');return {commandId:id,state:receipt!.response?'settled':'indeterminate',response:receipt!.response};}
}
