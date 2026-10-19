/** Coalesce push invalidations and limit snapshot reads, including changes during a read. */
export function createTaskSynchronizer<T>(load:()=>Promise<T>, publish:(value:T)=>void, failure:(error:unknown)=>void,
 options: { minIntervalMs?: number; isVisible?: () => boolean } = {}) {
 const interval=options.minIntervalMs??1000;
 const visible=options.isVisible??(()=>true);
 let dirty=false;let running:Promise<void>|undefined;let disposed=false;let lastStart=-Infinity;
 let timer:ReturnType<typeof setTimeout>|undefined;let wake:(()=>void)|undefined;
 async function drain(){
  while(dirty&&!disposed&&visible()){
   const delay=lastStart+interval-Date.now();
   if(delay>0)await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(()=>{timer=undefined;wake=undefined;resolve();},delay);});
   if(disposed||!visible())break;
   dirty=false;lastStart=Date.now();
   try{const value=await load();if(!disposed&&!dirty)publish(value);}
   catch(error){if(!disposed)failure(error);if(!dirty)throw error;}
  }
 }
 return {
  refresh():Promise<void>{if(disposed)return Promise.resolve();dirty=true;if(!running)running=drain().finally(()=>{running=undefined;});return running;},
  dispose(){disposed=true;dirty=false;if(timer!==undefined)clearTimeout(timer);wake?.();wake=undefined;}
 };
}
