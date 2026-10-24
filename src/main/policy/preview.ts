import { object } from '../../shared/validation';
import type { Block, Config, RoutePreview, RouteOptions } from '../../shared/contracts/policy';
import { activeBlocks } from '../../shared/policy/availability';
import { chatgptReviewEnabled } from '../../shared/policy/settings';
import { resolveDispatch, workerCap } from './routing';
import { exact, text } from './input';

/** A dry run of dispatch routing against the saved config and the blocks in force at `now`; writes nothing. */
export function previewRoute(config: Config, blocks: Block[], now: number, value: unknown): RoutePreview {
  const input=object(value); exact(input,['owner','worker','runningCount','workerLoad','excludeEngines','excludeWorkers','excludeChannels']);
  const opts: RouteOptions={owner:text(input.owner,'owner')};
  if(input.worker!==undefined) opts.worker=text(input.worker,'worker');
  if(input.excludeEngines!==undefined){
   if(!Array.isArray(input.excludeEngines)||input.excludeEngines.length>50) throw new Error('Invalid excluded engines');
   opts.excludeEngines=input.excludeEngines.map(engine=>text(engine,'excluded engine'));
  }
  if(input.excludeChannels!==undefined){
   if(!Array.isArray(input.excludeChannels)||input.excludeChannels.length>200) throw new Error('Invalid excluded channels');
   opts.excludeChannels=input.excludeChannels.map(channel=>text(channel,'excluded channel'));
  }
  if(input.excludeWorkers!==undefined){
   if(!Array.isArray(input.excludeWorkers)||input.excludeWorkers.length>200) throw new Error('Invalid excluded workers');
   opts.excludeWorkers=input.excludeWorkers.map(worker=>text(worker,'excluded worker'));
  }
  if(input.workerLoad!==undefined){
   const load=object(input.workerLoad);
   for(const n of Object.values(load)) if(!Number.isSafeInteger(n)||Number(n)<0) throw new Error('Invalid worker load');
   opts.workerLoad=load as Record<string,number>;
  }
  const count=input.runningCount??0; if(!Number.isSafeInteger(count)||Number(count)<0) throw new Error('Invalid running count');
  const route=resolveDispatch(config,activeBlocks({version:1,blocks},now),opts);
  const ownerConf=config.owners[opts.owner];
  const limit=workerCap(config.workers[route.worker]);
  // A worker at its own max_parallel is out of room even when the owner still has a free slot;
  // without a load report the route assumes it is idle, as the running count does.
  const running=opts.workerLoad?.[route.worker]??0;
  return {...route,maxParallel:ownerConf.max_parallel,capacityAvailable:Number(count)<ownerConf.max_parallel&&(!limit||running<limit),
   ...(limit!==undefined?{workerCapacity:{limit,running}}:{}),chatgptReview:chatgptReviewEnabled(config)};
}
