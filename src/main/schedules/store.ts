import type { ScheduleAgent, ScheduleDefinition, ScheduleRun } from '../../shared/contracts/schedules';
import type { TaskStore } from '../store';

export interface StoredRun extends ScheduleRun { definition: ScheduleDefinition; process?: {unit:string;invocation?:string}; recoveryError?:string; cancelRequested?:boolean; outputRef?:boolean; outputSlot?:number }
export interface ScheduleState {definitions:ScheduleDefinition[];runs:Record<string,StoredRun[]>}

const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function invalid(message:string):never {throw new Error(`Cannot upgrade schedules.v1: ${message}. The stored schedules were left unchanged.`);}
function legacyLines(value:unknown,field:string):string[]|undefined {
 if(value===undefined)return undefined;
 if(!Array.isArray(value)||value.some(line=>typeof line!=='string'))invalid(`definition agent.${field} is not a string array`);
 const lines=(value as string[]).filter(line=>line.trim()!=='');
 return lines.length?lines:undefined;
}
/** Keep every old requirement in the prompt: the original goal stays verbatim, and non-empty legacy fields follow under explicit Chinese headings. */
function legacyGoal(goal:string,criteria:string[]|undefined,constraints:string[]|undefined):string {
 const sections:string[]=[];
 if(criteria?.length)sections.push(`验收标准：\n${criteria.map(line=>`- ${line}`).join('\n')}`);
 if(constraints?.length)sections.push(`约束：\n${constraints.map(line=>`- ${line}`).join('\n')}`);
 return sections.length?`${goal}\n\n${sections.join('\n\n')}`:goal;
}
function legacyAgent(value:Record<string,unknown>):ScheduleAgent {
 if(Object.keys(value).some(key=>!['goal','ownerProfileId','acceptanceCriteria','constraints'].includes(key)))invalid('definition agent has unknown fields');
 if(typeof value.goal!=='string'||!value.goal.trim())invalid('definition agent.goal is empty');
 if(typeof value.ownerProfileId!=='string'||!value.ownerProfileId.trim())invalid('definition agent.ownerProfileId is empty');
 return {
  goal:legacyGoal(value.goal,legacyLines(value.acceptanceCriteria,'acceptanceCriteria'),legacyLines(value.constraints,'constraints')),
  executor:{role:'owner',profileId:value.ownerProfileId},
 };
}
function currentAgent(value:Record<string,unknown>):ScheduleAgent {
 if(Object.keys(value).some(key=>key!=='goal'&&key!=='executor'))invalid('definition agent has unknown fields');
 if(typeof value.goal!=='string'||!value.goal.trim())invalid('definition agent.goal is empty');
 if(!isRecord(value.executor))invalid('definition agent.executor is not an object');
 const executor=value.executor;
 if(Object.keys(executor).some(key=>key!=='role'&&key!=='profileId'))invalid('definition agent.executor has unknown fields');
 if((executor.role!=='owner'&&executor.role!=='worker')||typeof executor.profileId!=='string'||!executor.profileId.trim())invalid('definition agent.executor is invalid');
 return {goal:value.goal,executor:{role:executor.role,profileId:executor.profileId}};
}
/** One-time, idempotent read-side upgrade. It only rewrites definitions and never touches runs, tasks, timing or active claims. */
function upgradeDefinitions(value:unknown):{definitions:ScheduleDefinition[];changed:boolean} {
 if(!isRecord(value)||Object.keys(value).length!==1||!Array.isArray(value.definitions))invalid('stored value is not a definitions container');
 let changed=false;
 const definitions=value.definitions.map((raw,index)=>{
  if(!isRecord(raw)||(raw.kind!=='script'&&raw.kind!=='agent'))invalid(`definition ${index} has no valid kind`);
  if(raw.kind==='script'){
   if(raw.agent!==undefined)invalid(`script definition ${index} also carries an agent`);
   return raw as unknown as ScheduleDefinition;
  }
  if(!isRecord(raw.agent))invalid(`agent definition ${index} has no agent object`);
  if(raw.script!==undefined)invalid(`agent definition ${index} also carries a script`);
  const legacy=Object.hasOwn(raw.agent,'ownerProfileId'),current=Object.hasOwn(raw.agent,'executor');
  if(legacy&&current)invalid(`agent definition ${index} mixes legacy ownerProfileId with executor`);
  const agent=legacy?legacyAgent(raw.agent):currentAgent(raw.agent);
  if(legacy)changed=true;
  return {...raw,agent} as ScheduleDefinition;
 });
 return {definitions,changed};
}
/** Definitions, per-schedule metadata and full output occupy separate KV rows. A normal tick never reads historical output. */
export class ScheduleStore {
 constructor(readonly tasks:TaskStore){}
 read():ScheduleState {
  const stored=this.tasks.getValue<unknown>('schedules.v1');
  let definitions:ScheduleDefinition[]=[];
  if(stored!==undefined){
   const upgraded=upgradeDefinitions(stored);definitions=upgraded.definitions;
   if(upgraded.changed)this.tasks.putValue('schedules.v1',{definitions});
  }
  const loaded:Record<string,StoredRun[]>={};
  const runs=new Proxy(loaded,{
   get:(target,key)=>{if(typeof key!=='string')return Reflect.get(target,key);if(!Object.hasOwn(target,key))target[key]=this.tasks.getValue<StoredRun[]>(`schedules.runs.${key}`)??[];return target[key];},
   deleteProperty:(target,key)=>{if(typeof key==='string')target[key]=[];return true;},
  });
  return {definitions,runs};
 }
 write(state:ScheduleState):void {
  this.tasks.putValue('schedules.v1',{definitions:state.definitions});
  for(const [id,runs] of Object.entries(state.runs)){
   for(const run of runs){
    if(run.output.length>256){this.tasks.putValue(`schedules.output.${id}.${run.outputSlot}`,run.output);run.output=run.output.slice(0,256);run.outputRef=true;}
   }
   const previous=this.tasks.getValue<StoredRun[]>(`schedules.runs.${id}`)??[];
   for(const old of previous)if(old.outputRef&&!runs.some(r=>r.outputSlot===old.outputSlot))this.tasks.putValue(`schedules.output.${id}.${old.outputSlot}`,null);
   this.tasks.putValue(`schedules.runs.${id}`,runs);
  }
 }
 detail(run:StoredRun):ScheduleRun{return publicRun({...run,output:run.outputRef?this.tasks.getValue<string>(`schedules.output.${run.scheduleId}.${run.outputSlot}`)??run.output:run.output},true);}
 transaction<T>(fn:(state:ScheduleState)=>T):T{return this.tasks.transaction(()=>{const state=this.read();const result=fn(state);this.write(state);return result;});}
}
/** Lists carry summaries; full 64KiB output is fetched by runId. */
export function publicRun(run:ScheduleRun,detail=false):ScheduleRun {
 const {id,scheduleId,trigger,status,scheduledFor,startedAt,finishedAt,taskId,exitCode}=run;
 const output=detail?run.output:run.output.slice(0,256),error=detail?run.error:run.error?.slice(0,256);
 return {id,scheduleId,trigger,status,scheduledFor,startedAt,finishedAt,taskId,exitCode,error,output,truncated:!!run.truncated||!detail&&(!!(run as StoredRun).outputRef||output.length<run.output.length)};
}
export function publicDefinition(def:ScheduleDefinition):ScheduleDefinition{return {...def,lastRun:def.lastRun?publicRun(def.lastRun):undefined};}
