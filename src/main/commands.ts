import type { CommandResponse } from '../shared/contracts/commands';
import type { OwnerMessage } from '../shared/contracts/owners';
import { MockOwnerHostAdapter, type OwnerHostEvidence } from './adapters/logical';
import { CommandGateway, EffectRunner } from './application/commands/gateway';
import { createRegistry } from './application/commands/registry';
import type { AsyncOwnerHost } from './application/commands/types';
import { OwnerLifecycle } from './application/owners/lifecycle';
import { Coordinator } from './application/scheduling/coordinator';
import { Dispatcher } from './application/scheduling/dispatch';
import { Retries } from './application/scheduling/retry';
import { VendorLimits } from './application/scheduling/vendor-limits';
import { Mutations } from './application/tasks/mutations';
import { Queries, type TaskDiagnostics } from './application/tasks/queries';
import { TaskRecords } from './application/tasks/records';
import { Results } from './application/tasks/results';
import { ContinuationService } from './continuation';
import { TaskManager } from './manager';
import { launchOwner, herdrOnPath } from './owner-host';
import { PolicyStore } from './policy/store';

/** The one app-owned command handler shared by the loopback UI and CLI. It only wires the application units together:
 * the gateway owns the envelope and receipts, the registry routes each command, and tasks, scheduling and owners hold the use cases.
 * The local principal is deliberately trusted-local-machine scope, not an OS-user login or a real-agent grant. */
export class CommandHandler {
 draining=false;
 transportStatus:'ready'|'unavailable'|'not-started'='not-started';
 private readonly gateway:CommandGateway;
 private readonly runner:EffectRunner;
 private readonly coordinator:Coordinator;
 private readonly continuation:ContinuationService;
  constructor(readonly manager:TaskManager,readonly policy:PolicyStore,
   hostLauncher: typeof launchOwner = launchOwner, herdrPresent: () => boolean = () => herdrOnPath(),
   diagnostics?: TaskDiagnostics, asyncHost:AsyncOwnerHost = {}){
   const ownerHost=new MockOwnerHostAdapter();
   const isDraining=()=>this.draining;
   this.continuation=new ContinuationService(manager.store,ownerHost);
   // Historical vendor failures must not recreate a block after an explicit unblock or restart; the seed happens on construction.
   const vendor=new VendorLimits(manager,policy);
   const applyVendorBlocks=()=>vendor.applyVendorBlocks();
   const records=new TaskRecords(manager);
   this.runner=new EffectRunner(manager,hostLauncher,asyncHost);
   const dispatch=new Dispatcher(manager,policy,records,this.continuation);
   const retries=new Retries(manager,policy,records,dispatch,applyVendorBlocks);
   const results=new Results(manager,records,ownerHost);
   const owners=new OwnerLifecycle(manager,policy,records,this.continuation,ownerHost,this.runner,isDraining);
   const queries=new Queries(manager,policy,records,diagnostics,{transportStatus:()=>this.transportStatus,herdrPresent},task=>dispatch.nextFor(task));
   const mutations=new Mutations(manager,records,a=>owners.register('owners.spawn',a),task=>owners.closeCancelledRoot(task));
   this.coordinator=new Coordinator(manager,policy,records,dispatch,applyVendorBlocks,taskId=>{results.deliver({taskId});},isDraining);
   this.gateway=new CommandGateway(manager,this.runner,createRegistry({queries,mutations,results,owners,dispatch,retries}),isDraining);
   manager.listeners.add(()=>this.pump());
   for(const owner of manager.store.listOwners()) if(owner.host)ownerHost.restore(owner.host as OwnerHostEvidence,(owner.messages??[]) as OwnerMessage[]);
   this.pump();
  }
 handle(value:unknown):CommandResponse {return this.gateway.handle(value);}
 handleAsync(value:unknown):Promise<CommandResponse> {return this.gateway.handleAsync(value);}
 pump():void {this.coordinator.pump();}
 async drain():Promise<void>{
  this.draining=true;this.coordinator.stop();
  await this.runner.drain();
 }
}
