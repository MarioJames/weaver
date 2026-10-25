import { roleChannels } from '../../shared/policy/channels';
import type { Block,Config } from '../../shared/contracts/policy';
/** Carry existing restrictions across the role rebinding done by a native import. */
export function remapImportedBlocks(config:Config,blocks:Block[],roleChanges:{before:string;after:string}[],subscriptions:Map<string,Set<string>>):Block[]{
 const targets=new Map<string,Set<string>>();
 for(const change of roleChanges){if(change.before===change.after)continue;const set=targets.get(change.before)??new Set<string>();set.add(change.after);targets.set(change.before,set);}
 const referenced=new Set([...Object.values(config.owners),...Object.values(config.workers)].flatMap(role=>[...roleChannels(role)]));
 const remapped:Block[]=[];
 for(const block of blocks){
  // An explicit account scope always wins over the worker's other pool members.
  if(block.worker&&!block.channel){
   const worker=config.workers[block.worker];
   if(worker?.channels.length===1&&config.channels[worker.channels[0]!]?.engine===block.engine){remapped.push({...block,channel:worker.channels[0]});continue;}
  }
  let channels=block.channel?targets.get(block.channel):undefined;
  if(channels){
   const worker=block.worker?config.workers[block.worker]:undefined;
   const quota=/^weaver-quota:/.test(block.by??'');
   const official=subscriptions.get(block.engine);
   // A legacy quota belongs to the unique official source, even when an API
   // provider wins the placeholder role. Multiple identities are never guessed.
   if(quota&&block.channel?.startsWith('default_')&&official?.size===1)channels=official;
   channels=new Set([...channels].filter(id=>(!worker||worker.channels.includes(id))&&(!quota||official?.has(id))));
  }
  if(channels?.size){for(const channel of channels)remapped.push({...block,channel});if(block.worker?config.workers[block.worker]?.channels.includes(block.channel!):referenced.has(block.channel!))remapped.push(block);}
  else remapped.push(block);
 }
 const unique=new Map<string,Block>();
 for(const block of remapped){
  const key=JSON.stringify([block.engine,block.channel??null,block.model??null,block.worker??null]);const previous=unique.get(key);
  if(!previous){unique.set(key,block);continue;}
  // Colliding restrictions retain the longer (or indefinite) restriction.
  const release_at=previous.release_at&&block.release_at?(Date.parse(previous.release_at)>=Date.parse(block.release_at)?previous.release_at:block.release_at):undefined;
  const merged={...previous,since:Date.parse(previous.since)<=Date.parse(block.since)?previous.since:block.since};
  if(release_at)merged.release_at=release_at;else delete merged.release_at;
  unique.set(key,merged);
 }
 return [...unique.values()];
}
