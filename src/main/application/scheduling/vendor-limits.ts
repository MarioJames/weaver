import type { Block } from '../../../shared/contracts/policy';
import { vendorBlockReason } from '../../adapters/cli/vendor-errors';
import { VENDOR_LADDER_MINUTES } from '../../domain/penalties';
import type { TaskManager } from '../../manager';
import { VENDOR_BLOCK_SOURCE, escalateEngineBlock } from '../../policy/routing';
import type { PolicyStore } from '../../policy/store';
import { engineLadderKey } from '../../store';
export class VendorLimits {
 private readonly vendorBlockedAttempts=new Set<string>();
 constructor(private readonly manager:TaskManager,private readonly policy:PolicyStore){
  // Historical failures must not recreate a block after an explicit unblock or restart.
  for(const task of manager.store.listHeads())if(task.failure)this.vendorBlockedAttempts.add(task.run?.id??task.id);
 }
 /**
  * A rate limit or exhausted quota blocks the dispatched worker first (ladder per worker). Once every enabled worker
  * of its engine is out, the engine is blocked too. A dispatch that names no known worker blocks the whole engine.
  */
 applyVendorBlocks():void {
  for(const task of this.manager.store.listHeads()){
   const f=task.failure;const engine=task.dispatch?.engine;const key=task.run?.id??task.id;
   if(!engine||!f||!['rate_limit','quota'].includes(f.kind)||this.vendorBlockedAttempts.has(key))continue;
   const snapshot=this.policy.snapshot();
   const now=Date.now();
   const dispatched=task.dispatch?.worker;
   const worker=dispatched&&Object.hasOwn(snapshot.config.workers,dispatched)&&snapshot.config.workers[dispatched]!.engine===engine?dispatched:undefined;
   const existing=snapshot.blocks.find(block=>block.engine===engine&&block.model===undefined&&block.worker===worker);
   if(existing&&existing.by!==VENDOR_BLOCK_SOURCE){this.vendorBlockedAttempts.add(key);continue;}
   // Another source already keeps the whole engine out of routing; a worker block would only stack on it.
   if(worker&&snapshot.blocks.some(block=>block.engine===engine&&block.model===undefined&&block.worker===undefined&&block.by!==VENDOR_BLOCK_SOURCE&&(!block.release_at||Date.parse(block.release_at)>now))){this.vendorBlockedAttempts.add(key);continue;}
   // Keep the ladder in the existing durable task metadata, including after explicit block removal.
   let minutes: number = VENDOR_LADDER_MINUTES[0];
   if(f.kind==='rate_limit'){
    const ladder=worker??engineLadderKey(engine);
    const previous=this.manager.store.getVendorLimit(ladder);
    const level=previous&&now-previous.lastTriggerAt<2*60*60_000?Math.min(previous.level+1,3):1;
    minutes=VENDOR_LADDER_MINUTES[level-1]!;
    this.manager.store.putVendorLimit(ladder,{level,lastTriggerAt:now});
   }
   const retryAt=f.retryAt?Date.parse(f.retryAt):NaN;
   const release=f.kind==='rate_limit'?Math.max(now+minutes*60_000,Number.isFinite(retryAt)?retryAt:0):retryAt;
   const release_at=Number.isFinite(release)&&release>now?new Date(release).toISOString():undefined;
   const block:Block={engine,...(worker?{worker}:{}),reason:vendorBlockReason(f),since:new Date(now).toISOString(),by:VENDOR_BLOCK_SOURCE,...(release_at?{release_at}:{})};
   const written=existing?snapshot.blocks.map(item=>item===existing?block:item):[...snapshot.blocks,block];
   this.policy.save({revision:snapshot.revision,config:snapshot.config,blocks:worker?escalateEngineBlock(snapshot.config,written,engine,now):written});
   this.vendorBlockedAttempts.add(key);
  }
 }
}
