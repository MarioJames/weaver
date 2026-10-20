import { object } from '../../shared/validation';
import type { Block, Config, RoutePreview, RouteOptions } from '../../shared/contracts/policy';
import { activeBlocks } from '../../shared/policy/availability';
import { chatgptReviewEnabled } from '../../shared/policy/settings';
import { resolveDispatch } from './routing';
import { exact, text } from './input';

/** A dry run of dispatch routing against the saved config and the blocks in force at `now`; writes nothing. */
export function previewRoute(config: Config, blocks: Block[], now: number, value: unknown): RoutePreview {
  const input=object(value); exact(input,['owner','worker','runningCount','workerLoad','excludeEngines','excludeWorkers']);
  const opts: RouteOptions={owner:text(input.owner,'owner')};
  if(input.worker!==undefined) opts.worker=text(input.worker,'worker');
  if(input.excludeEngines!==undefined){
   if(!Array.isArray(input.excludeEngines)||input.excludeEngines.length>50) throw new Error('Invalid excluded engines');
   opts.excludeEngines=input.excludeEngines.map(engine=>text(engine,'excluded engine'));
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
  const maxParallel=config.owners[opts.owner].max_parallel;
  return {...route,maxParallel,capacityAvailable:Number(count)<maxParallel,chatgptReview:chatgptReviewEnabled(config)};
}
