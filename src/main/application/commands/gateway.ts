import { API_VERSION, isWriteCommand, type CommandResponse } from '../../../shared/contracts/commands';
import type { Task } from '../../../shared/contracts/tasks';
import { object, text } from '../../../shared/validation';
import { ContinuationError } from '../../continuation';
import type { TaskManager } from '../../manager';
import { closeOwnerHost, closeOwnerHostAsync, launchOwner, launchOwnerAsync, type OwnerLaunchResult } from '../../owner-host';
import { digest, publicTask } from '../tasks/records';
import { CommandError, fail } from './errors';
import type { CommandRegistry, FlowCommand, SyncCommand } from './registry';
import type { AsyncOwnerHost, CommandFlow } from './types';

/** Runs the external effects a command flow asks for, synchronously or asynchronously, and tracks the asynchronous jobs so drain can abort and await them. */
export class EffectRunner {
 private readonly pending = new Set<Promise<CommandResponse>>();
 private readonly launches = new Set<AbortController>();
 constructor(private readonly manager:TaskManager,private readonly hostLauncher:typeof launchOwner,private readonly asyncHost:AsyncOwnerHost){}
 run(flow:CommandFlow<CommandResponse>):CommandResponse {
  let step=flow.next();
  while(!step.done){
   let host:OwnerLaunchResult|undefined;
   try {
    if(step.value.kind==='first-output'){ /* Synchronous internal callers receive the current snapshot. RPC uses handleAsync. */ }
    else if(step.value.kind==='close')closeOwnerHost(step.value.host);
    else host=this.hostLauncher(step.value.input);
   }catch(error){step=flow.throw(error);continue;}
   step=flow.next(host);
  }
  return step.value;
 }
 runAsync(flow:CommandFlow<CommandResponse>):Promise<CommandResponse> {
  const controller=new AbortController();this.launches.add(controller);
  const job=this.driveAsync(flow,controller.signal);
  return this.track(job,controller);
 }
 /** Starts a flow after the current call stack, for effects that must follow an already persisted receipt. */
 runDeferred(makeFlow:()=>CommandFlow<CommandResponse>):void {
  const controller=new AbortController();this.launches.add(controller);
  const job=Promise.resolve().then(()=>this.driveAsync(makeFlow(),controller.signal));
  this.track(job,controller);
 }
 private track(job:Promise<CommandResponse>,controller:AbortController):Promise<CommandResponse> {
  this.pending.add(job);
  const settled=()=>{this.pending.delete(job);this.launches.delete(controller);};
  job.then(settled,settled);return job;
 }
 private async driveAsync(flow:CommandFlow<CommandResponse>,signal:AbortSignal):Promise<CommandResponse>{
  const deadline=Date.now()+8000;
  let step=flow.next();
  while(!step.done){
   let host:OwnerLaunchResult|undefined;
   try {
    const effect=step.value;
    if(effect.kind==='first-output')await this.manager.waitForFirstOutput(effect.taskId,Math.max(0,deadline-Date.now()));
    else if(effect.kind==='close')await (this.asyncHost.closer??closeOwnerHostAsync)(effect.host);
    else host=await (this.asyncHost.launcher??(this.hostLauncher===launchOwner?launchOwnerAsync:async input=>this.hostLauncher(input)))({...effect.input,signal});
   }catch(error){step=flow.throw(error);continue;}
   step=flow.next(host);
  }
  return step.value;
 }
 async drain():Promise<void>{
  for(const controller of this.launches)controller.abort();
  await Promise.allSettled([...this.pending]);
 }
}
/** The command envelope: validation, durable intent and receipt, routing to the registry, and one error exit for sync and async callers. */
export class CommandGateway {
 constructor(private readonly manager:TaskManager,private readonly runner:EffectRunner,private readonly registry:CommandRegistry,private readonly isDraining:()=>boolean){}
 handle(value:unknown):CommandResponse {return this.runner.run(this.handleFlow(value));}
 handleAsync(value:unknown):Promise<CommandResponse> {return this.runner.runAsync(this.handleFlow(value));}
 private run(command:string,args:Record<string,unknown>):unknown {
  if(!Object.hasOwn(this.registry.sync,command))return fail('COMMAND_UNKNOWN','Unknown logical command');
  return this.registry.sync[command as SyncCommand](args);
 }
 private *handleFlow(value:unknown):CommandFlow<CommandResponse> {
  let commandId:string|undefined; let receiptKey:string|undefined; let effected=false;
  try {
   if(Buffer.byteLength(JSON.stringify(value))>128*1024)fail('INVALID_REQUEST','Request exceeds 128 KiB');
   const r=object(value); if(r.apiVersion!==API_VERSION)fail('VERSION_UNSUPPORTED','Expected weaver.v1');
   const command=text(r.command,'command',80); const args=structuredClone(object(r.args??{}));
   if(r.commandId!==undefined)commandId=text(r.commandId,'commandId',120);
   if(this.isDraining())fail('APP_DRAINING','App is shutting down');
   if(isWriteCommand(command)) {
    if(!commandId)fail('INVALID_REQUEST','Mutation requires commandId');
    receiptKey=`local-demo:${commandId}`;const hash=digest({command,args});const old=this.manager.store.getReceipt(receiptKey);
    if(old) {if(old.hash!==hash)fail('IDEMPOTENCY_CONFLICT','commandId already used for different arguments');if(old.response)return old.response;fail('COMMAND_INDETERMINATE','Previous command was interrupted. Inspect tasks/owners before issuing a new command; no automatic replay was performed.');}
    // Durable intent first: a crash can block a retry, but cannot silently repeat a spawn.
    this.manager.store.putReceipt(receiptKey,{hash});
   }
   let data=Object.hasOwn(this.registry.flow,command)?yield* this.registry.flow[command as FlowCommand](args):this.run(command,args);
   if((command==='workers.spawn'||command==='tasks.retry') && data && typeof data==='object' && 'id' in data){
    const snapshot=data as Task; if(snapshot.dispatch?.execution==='real'&&snapshot.status==='running'){
     yield {kind:'first-output',taskId:snapshot.id};
     data={...data,...publicTask(this.manager.store.get(snapshot.id)),started:!!this.manager.store.get(snapshot.id).run?.firstOutputAt};
    }
   }
   const response:CommandResponse={apiVersion:API_VERSION,commandId,ok:true,data};
   effected=true;if(isWriteCommand(command))this.manager.notify();if(receiptKey)this.finish(receiptKey,response);return response;
  }catch(error){
   if(effected)return {apiVersion:API_VERSION,commandId,ok:false,error:{code:'COMMAND_INDETERMINATE',message:'Command applied but receipt persistence failed; inspect current state before retrying',retryable:false}};
   const response:CommandResponse={apiVersion:API_VERSION,commandId,ok:false,error:{code:error instanceof CommandError||error instanceof ContinuationError?error.code:'INVALID_REQUEST',message:error instanceof Error?error.message:'Command failed',retryable:false}};
   // Never replace a prior receipt on conflict or overwrite an incomplete durable intent.
   if(receiptKey && !['IDEMPOTENCY_CONFLICT','COMMAND_INDETERMINATE'].includes(response.error!.code)) {
    const receipt=this.manager.store.getReceipt(receiptKey);
    if(receipt&&!receipt.response)try{this.finish(receiptKey,response);}catch{return {...response,error:{code:'PERSISTENCE_ERROR',message:'Could not persist receipt; inspect current state before retrying',retryable:false}};}
   }
   return response;
  }
 }
 private finish(key:string,response:CommandResponse){const receipt=this.manager.store.getReceipt(key);if(!receipt)throw new Error('Command intent missing');this.manager.store.putReceipt(key,{...receipt,response});}
}
