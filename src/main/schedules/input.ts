import { Cron } from 'croner';
import type { ScheduleInput, ScheduleTiming } from '../../shared/contracts/schedules';
import { isValidTimezone } from '../../shared/policy/settings';
import { object, text } from '../../shared/validation';
import { fail } from '../application/commands/errors';
import type { PolicyStore } from '../policy/store';
import { absoluteExistingWorkspace } from '../workspace';

export function exact(a: Record<string, unknown>, keys: readonly string[]): void {
 if(Object.keys(a).some(k=>!keys.includes(k)))fail('INVALID_REQUEST','Unexpected schedule field');
}
export function integer(value:unknown,name:string,min:number,max:number):number {
 if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)fail('INVALID_REQUEST',`${name} must be an integer between ${min} and ${max}`);
 return Number(value);
}
export function timing(value:unknown):ScheduleTiming {
 const a=object(value);
 if(a.mode==='interval'){exact(a,['mode','seconds']);return {mode:'interval',seconds:integer(a.seconds,'seconds',1,31536000)};}
 if(a.mode!=='cron')return fail('INVALID_REQUEST','timing mode must be interval or cron');
 exact(a,['mode','expression','timezone']);
 const expression=text(a.expression,'expression',300).trim(),timezone=text(a.timezone,'timezone',100);
 if(![5,6].includes(expression.split(/\s+/).length)||!isValidTimezone(timezone))fail('INVALID_REQUEST','Cron requires 5/6 fields and a valid IANA timezone');
 let next:Date|null;
 try{next=new Cron(expression,{timezone,paused:true}).nextRun(new Date());}catch{return fail('INVALID_REQUEST','Invalid cron expression');}
 if(next===null)fail('INVALID_REQUEST','Cron expression has no future trigger time');
 return {mode:'cron',expression,timezone};
}
export function nextRun(t:ScheduleTiming,now:number):string|null {
 return t.mode==='interval'?new Date(now+t.seconds*1000).toISOString():new Cron(t.expression,{timezone:t.timezone,paused:true}).nextRun(new Date(now))?.toISOString()??null;
}
function lines(value:unknown,name:string):string[]|undefined {
 if(value===undefined)return undefined;
 if(!Array.isArray(value)||value.length>30)fail('INVALID_REQUEST',`${name} must have at most 30 items`);
 return (value as unknown[]).map(v=>text(v,name,1000));
}
export const INPUT_KEYS=['name','kind','enabled','timing','workspace','script','agent'] as const;
export function input(value:unknown,policy:PolicyStore):ScheduleInput & {enabled:boolean} {
 const a=object(value);exact(a,INPUT_KEYS);
 const name=text(a.name,'name',160).trim();
 if(!name)fail('INVALID_REQUEST','name cannot be empty');
 if(a.enabled!==undefined&&typeof a.enabled!=='boolean')fail('INVALID_REQUEST','enabled must be boolean');
 const enabled=a.enabled??true;
 const base={name,enabled:enabled as boolean,timing:timing(a.timing),workspace:absoluteExistingWorkspace(a.workspace)};
 if(a.kind==='script'){
  if(a.agent!==undefined)fail('INVALID_REQUEST','script schedule cannot contain agent');
  const s=object(a.script);exact(s,['command','timeoutSeconds']);
  return {...base,kind:'script',script:{command:text(s.command,'command',16000),timeoutSeconds:integer(s.timeoutSeconds,'timeoutSeconds',1,86400)}};
 }
 if(a.kind!=='agent'||a.script!==undefined)fail('INVALID_REQUEST','kind must be script or agent with matching configuration');
 const agent=object(a.agent);exact(agent,['goal','ownerProfileId','acceptanceCriteria','constraints']);
 const ownerProfileId=text(agent.ownerProfileId,'ownerProfileId',120),snapshot=policy.snapshot(),profile=snapshot.config.owners[ownerProfileId];
 const kind=profile&&snapshot.config.engines[profile.engine]?.kind;
 if(!profile||snapshot.owners[ownerProfileId]?.status!=='available'||!['claude','codex'].includes(kind))fail('POLICY_DENIED','Agent requires an available claude/codex owner profile');
 return {...base,kind:'agent',agent:{goal:text(agent.goal,'goal',16000),ownerProfileId,acceptanceCriteria:lines(agent.acceptanceCriteria,'acceptanceCriteria'),constraints:lines(agent.constraints,'constraints')}};
}
