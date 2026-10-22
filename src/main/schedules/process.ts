import { StringDecoder } from 'node:string_decoder';
import { startOwnedScope } from '../adapters/cli/scope';
import { redactContext } from '../redact-context';
import { REDACTED } from '../../shared/redact';
import type { ScheduleDefinition } from '../../shared/contracts/schedules';

export const OUTPUT_BYTES=64*1024;
export interface ScriptResult {status:'succeeded'|'failed'|'cancelled'|'interrupted';output:string;error?:string;exitCode:number|null;truncated:boolean}
export interface ScriptExecution {done:Promise<ScriptResult>;cancel(status?:'cancelled'|'interrupted'):void}
/** Mask byte ranges before decoding or applying any text length limit. A hard capture cut
 * has an unknown tail: conservatively hide the longest possible secret suffix. Merge that
 * range with every complete match so overlapping secrets cannot expose an earlier prefix. */
function maskCapturedSecrets(raw:Buffer,secrets:string[],hardCut:boolean):string {
 const values=secrets.map(s=>Buffer.from(s));
 const ranges:Array<[number,number]>=[];
 if(hardCut&&values.length)ranges.push([Math.max(0,raw.length-Math.max(...values.map(v=>v.length))+1),raw.length]);
 for(const value of values){
  for(let offset=0;(offset=raw.indexOf(value,offset))>=0;offset++)ranges.push([offset,offset+value.length]);
 }
 ranges.sort((a,b)=>a[0]-b[0]);
 const merged:Array<[number,number]>=[];
 for(const range of ranges){const last=merged.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else merged.push([...range]);}
 const parts:Buffer[]=[];let cursor=0;
 for(const [start,end] of merged){parts.push(raw.subarray(cursor,start),Buffer.from(REDACTED));cursor=end;}
 parts.push(raw.subarray(cursor));
 // Do not flush an incomplete UTF-8 sequence at a capture boundary into U+FFFD.
 const decoder=new StringDecoder('utf8'),decoded=decoder.write(Buffer.concat(parts));
 return decoded+(hardCut?'':decoder.end());
}
/** Uses the existing systemd ownership/descendant cleanup launcher. No naked PID survives a restart. */
export function executeScript(def: ScheduleDefinition,unit:string,identity:(invocation:string)=>void,effectiveWorkspace?:string):ScriptExecution {
 const secrets=Object.entries(process.env).filter(([k,v])=>v&&/secret|token|password|credential|api.?key|private.?key/i.test(k)).map(([,v])=>v!).sort((a,b)=>b.length-a.length);
 const redact=(s:string)=>redactContext(secrets.reduce((v,secret)=>v.split(secret).join(REDACTED),s),OUTPUT_BYTES+65536);
 let bytes=0,overflow=false,error:string|undefined,reason:'cancelled'|'interrupted'|undefined,timedOut=false;
 const chunks:Buffer[]=[];
 // Keep enough tail for redacting a secret that straddles the output boundary.
 const captureLimit=OUTPUT_BYTES+Math.max(0,...secrets.map(s=>Buffer.byteLength(s)));
  const child=startOwnedScope({command:['/bin/sh','-c',def.script!.command],cwd:effectiveWorkspace ?? def.workspace!,env:process.env,stdin:null,unit,detached:true});
 child.on('identity',identity);
 const capture=(chunk:Buffer)=>{const buffer=Buffer.from(chunk);if(bytes+buffer.length>OUTPUT_BYTES)overflow=true;const remaining=captureLimit-bytes;if(remaining>0)chunks.push(buffer.subarray(0,remaining));bytes+=buffer.length;};
 child.stdout.on('data',capture);child.stderr.on('data',capture);
 child.on('error',(e:Error)=>{error=redact(e.message);});
 const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},def.script!.timeoutSeconds*1000);
 const done=new Promise<ScriptResult>(resolve=>child.once('close',(code:number|null,signal:NodeJS.Signals|null)=>{
  clearTimeout(timeout);
  const safe=redact(maskCapturedSecrets(Buffer.concat(chunks),secrets,bytes>captureLimit));
  const decoded=Buffer.from(safe,'utf8');
  const output=new StringDecoder('utf8').write(decoded.subarray(0,OUTPUT_BYTES));
  if(timedOut)error='Script timed out';else if(signal&&!reason)error=`Script terminated by ${signal}`;
  resolve({status:reason??(timedOut||error||code!==0?'failed':'succeeded'),output,error,exitCode:code,truncated:overflow||decoded.length>OUTPUT_BYTES});
 }));
 return {done,cancel(status='cancelled'){reason=status;child.kill('SIGKILL');}};
}
