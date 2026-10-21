import type { ScheduleRun } from '../../../shared/contracts/schedules';

export interface RunsPage { runs:ScheduleRun[];total:number }
export interface ScheduleHistoryState {
 runs?:ScheduleRun[];total:number;error:string;problem:string;loadingMore:boolean;
 expandId?:string;detail?:ScheduleRun;detailLoading:boolean;detailError:string;
}
const empty=():ScheduleHistoryState=>({total:0,error:'',problem:'',loadingMore:false,detailLoading:false,detailError:''});
const unique=(runs:ScheduleRun[])=>[...new Map(runs.map(run=>[run.id,run])).values()];
/** Drawer-local request ownership. Pagination and selected detail survive refreshes;
 * every request belongs to the current drawer session and selection. */
export class ScheduleHistory {
 state:ScheduleHistoryState=empty();
 private scheduleId?:string;
 private epoch=0;
 private listTicket=0;
 private detailTicket=0;
 constructor(private readonly read:(args:Record<string,unknown>)=>Promise<RunsPage>,private readonly changed:(state:ScheduleHistoryState)=>void){}
 private publish(patch:Partial<ScheduleHistoryState>):void{this.state={...this.state,...patch};this.changed(this.state);}
 activate(id:string):void{this.stop();this.scheduleId=id;this.state=empty();this.changed(this.state);}
 stop():void{this.epoch++;this.listTicket++;this.detailTicket++;this.scheduleId=undefined;}
 async refresh():Promise<void>{
  if(!this.scheduleId)return;
  const epoch=this.epoch,ticket=++this.listTicket,id=this.scheduleId;
  const limit=Math.max(50,this.state.runs?.length??0);
  this.publish({loadingMore:false});
  try{
   const result=await this.read({scheduleId:id,offset:0,limit});
   if(epoch!==this.epoch||ticket!==this.listTicket)return;
   this.publish({runs:unique(result.runs),total:result.total,error:'',problem:''});
   if(this.state.expandId&&this.state.detail?.status==='running')void this.openDetail(this.state.expandId,true);
  }catch(error){
   if(epoch!==this.epoch||ticket!==this.listTicket)return;
   this.publish(this.state.runs===undefined?{error:String(error)}:{problem:String(error)});
  }
 }
 async loadMore():Promise<void>{
  if(!this.scheduleId||!this.state.runs||this.state.loadingMore||this.state.runs.length>=this.state.total)return;
  const epoch=this.epoch,ticket=++this.listTicket,id=this.scheduleId,offset=this.state.runs.length;
  this.publish({loadingMore:true});
  try{
   const result=await this.read({scheduleId:id,offset,limit:50});
   if(epoch!==this.epoch||ticket!==this.listTicket)return;
   this.publish({runs:unique([...(this.state.runs??[]),...result.runs]),total:result.total,problem:'',loadingMore:false});
  }catch(error){if(epoch===this.epoch&&ticket===this.listTicket)this.publish({problem:String(error),loadingMore:false});}
 }
 async openDetail(runId:string,retry=false):Promise<void>{
  if(!this.scheduleId||this.state.expandId===runId&&!retry)return;
  const epoch=this.epoch,ticket=++this.detailTicket,id=this.scheduleId;
  this.publish({expandId:runId,detail:this.state.expandId===runId?this.state.detail:undefined,detailLoading:true,detailError:''});
  try{
   const result=await this.read({scheduleId:id,runId});
   if(epoch!==this.epoch||ticket!==this.detailTicket)return;
   const detail=result.runs.find(r=>r.id===runId);
   if(!detail)throw new Error('找不到这次运行的详情。');
   this.publish({detail,detailLoading:false,detailError:''});
  }catch(error){if(epoch===this.epoch&&ticket===this.detailTicket)this.publish({detailError:String(error),detailLoading:false});}
 }
 collapse():void{this.detailTicket++;this.publish({expandId:undefined,detail:undefined,detailLoading:false,detailError:''});}
 retryDetail():Promise<void>{return this.state.expandId?this.openDetail(this.state.expandId,true):Promise.resolve();}
}
