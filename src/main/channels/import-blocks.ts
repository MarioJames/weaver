import type { Block,Config } from '../../shared/contracts/policy';
/** Carry existing restrictions across the role rebinding done by a native import. */
export function remapImportedBlocks(config:Config,blocks:Block[],roleChanges:{before:string;after:string}[],subscriptions:Map<string,Set<string>>):Block[]{
 const targets=new Map<string,Set<string>>();
 for(const change of roleChanges){if(change.before===change.after)continue;const set=targets.get(change.before)??new Set<string>();set.add(change.after);targets.set(change.before,set);}
 const referenced=new Set([...Object.values(config.owners),...Object.values(config.workers)].map(role=>role.channel));
 const remapped:Block[]=[];
 for(const block of blocks){
  if(block.channel&&/^weaver-quota:/.test(block.by??'')&&block.channel.startsWith('default_')){
   const official=subscriptions.get(block.engine);
   if(official?.size){for(const channel of official)remapped.push({...block,channel});if(referenced.has(block.channel))remapped.push(block);continue;}
  }
  if(block.worker){const worker=config.workers[block.worker];if(worker&&config.channels[worker.channel]?.engine===block.engine){remapped.push({...block,channel:worker.channel});continue;}}
  const channels=block.channel?targets.get(block.channel):undefined;
  if(channels?.size){for(const channel of channels)remapped.push({...block,channel});if(referenced.has(block.channel!))remapped.push(block);}
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
