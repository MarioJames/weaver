import test from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleHistory, type RunsPage } from '../../src/renderer/features/schedules/schedule-history';
import { builtinPatch, draftFromDefinition } from '../../src/renderer/features/schedules/schedules-view';
import type { ScheduleDefinition,ScheduleRun } from '../../src/shared/contracts/schedules';

const run=(id:string):ScheduleRun=>({id,scheduleId:'schedule',trigger:'manual',status:'succeeded',startedAt:'2030-01-01T00:00:00Z',finishedAt:'2030-01-01T00:00:01Z',output:'excerpt',truncated:true});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

test('history preserves all loaded pages and selected full detail across refresh; overlapping load-more clicks send once',async()=>{
 const all=Array.from({length:100},(_,i)=>run(String(i))),requests:Record<string,unknown>[]=[];
 const more=deferred<RunsPage>();
 const history=new ScheduleHistory(async args=>{
  requests.push(args);
  if(args.runId)return {runs:[{...run(String(args.runId)),output:'complete',truncated:false}],total:1};
  if(args.offset===50)return more.promise;
  return {runs:all.slice(0,Number(args.limit)),total:100};
 },()=>{});
 history.activate('schedule');await history.refresh();assert.equal(history.state.runs!.length,50);
 await history.openDetail('0');assert.equal(history.state.detail!.truncated,false);
 const loading=history.loadMore();await history.loadMore();
 assert.equal(requests.filter(a=>a.offset===50).length,1);
 // A repeated id at the page boundary cannot create duplicate sections.
 more.resolve({runs:[all[49],...all.slice(50)],total:100});await loading;
 assert.equal(history.state.runs!.length,100);
 await history.refresh();assert.equal(requests.at(-1)!.limit,100);
 assert.equal(history.state.runs!.length,100);assert.equal(history.state.expandId,'0');assert.equal(history.state.detail!.output,'complete');
});

test('detail failure retries the same runId and old selection/unmount responses cannot replace current detail',async()=>{
 const old=deferred<RunsPage>();let count=0,updates=0;
 const history=new ScheduleHistory(async args=>{
  if(args.runId==='old')return old.promise;
  count++;if(count===1)throw new Error('one lost detail read');
  return {runs:[{...run(String(args.runId)),output:'',error:'full error '.repeat(100),truncated:false}],total:1};
 },()=>{updates++;});
 history.activate('schedule');await history.openDetail('error');assert.match(history.state.detailError,/lost detail/);
 await history.retryDetail();assert.equal(count,2);assert.equal(history.state.detail!.id,'error');assert.equal(history.state.detail!.error!.length,1100);assert.equal(history.state.detailError,'');
 const pending=history.openDetail('old');await history.openDetail('new');old.resolve({runs:[run('old')],total:1});await pending;
 assert.equal(history.state.detail!.id,'new');
 const closed=deferred<RunsPage>();const closedHistory=new ScheduleHistory(()=>closed.promise,()=>{updates++;});closedHistory.activate('schedule');const request=closedHistory.openDetail('late');closedHistory.stop();const before=updates;
 closed.resolve({runs:[run('late')],total:1});await request;assert.equal(updates,before);
});

test('a failed refresh retains rows, and old pagination from another drawer session cannot update them',async()=>{
 const pending=deferred<RunsPage>();let calls=0;
 const history=new ScheduleHistory(async args=>{
  if(args.scheduleId==='other')return {runs:[run('other-run')],total:1};
  if(args.offset===50)return pending.promise;
  if(++calls===2)throw new Error('refresh offline');
  return {runs:Array.from({length:50},(_,i)=>run(String(i))),total:100};
 },()=>{});
 history.activate('schedule');await history.refresh();await history.refresh();assert.equal(history.state.runs!.length,50);assert.match(history.state.problem,/offline/);
 const older=history.loadMore();history.activate('other');await history.refresh();pending.resolve({runs:[run('stale')],total:100});await older;
 assert.deepEqual(history.state.runs!.map(r=>r.id),['other-run']);assert.equal(history.state.loadingMore,false);assert.equal(history.state.problem,'');
});

test('active builtin updates carry only enabled; inactive edits carry enabled and timing atomically',()=>{
 const d:ScheduleDefinition={id:'s',name:'quota',kind:'script',enabled:true,builtin:'quota.refresh',activeRunId:'run',timing:{mode:'interval',seconds:900},revision:1,createdAt:'',updatedAt:'',nextRunAt:null,lastRunAt:null};
 const draft={...draftFromDefinition(d),enabled:false,intervalSeconds:1800};
 assert.deepEqual(builtinPatch(draft,d),{enabled:false});
 assert.deepEqual(builtinPatch(draft,d,false),{timing:{mode:'interval',seconds:1800},enabled:false},'live run completion unlocks timing without replacing the edit revision snapshot');
 assert.deepEqual(builtinPatch(draft,{...d,activeRunId:undefined}),{timing:{mode:'interval',seconds:1800},enabled:false});
});
