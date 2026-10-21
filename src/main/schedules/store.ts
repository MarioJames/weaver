import type { ScheduleDefinition, ScheduleRun } from '../../shared/contracts/schedules';
import type { TaskStore } from '../store';

export interface StoredRun extends ScheduleRun { definition: ScheduleDefinition; process?: {unit:string;invocation?:string}; recoveryError?:string; cancelRequested?:boolean; outputRef?:boolean; outputSlot?:number }
export interface ScheduleState {definitions:ScheduleDefinition[];runs:Record<string,StoredRun[]>}
/** Definitions, per-schedule metadata and full output occupy separate KV rows. A normal tick never reads historical output. */
export class ScheduleStore {
 constructor(readonly tasks:TaskStore){}
 read():ScheduleState {
  const definitions=this.tasks.getValue<{definitions:ScheduleDefinition[]}>('schedules.v1')?.definitions??[];
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
