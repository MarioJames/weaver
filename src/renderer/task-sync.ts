/** Coalesce push invalidations; only publish a snapshot after all known invalidations. */
export function createTaskSynchronizer<T>(load:()=>Promise<T>, publish:(value:T)=>void, failure:(error:unknown)=>void) {
 let dirty=false;let running:Promise<void>|undefined;let disposed=false;
 async function drain(){
  while(dirty&&!disposed){dirty=false;try{const value=await load();if(!disposed&&!dirty)publish(value);}catch(error){if(!disposed)failure(error);if(!dirty)throw error;}}
 }
 return {
  refresh():Promise<void>{if(disposed)return Promise.resolve();dirty=true;if(!running)running=drain().finally(()=>{running=undefined;});return running;},
  dispose(){disposed=true;dirty=false;}
 };
}
