import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskSynchronizer } from '../src/renderer/task-sync';
const deferred=<T>()=>{let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
test('burst invalidations coalesce and suppress stale in-flight snapshot',async()=>{const a=deferred<number>(),b=deferred<number>();let loads=0;const values:number[]=[];const sync=createTaskSynchronizer(()=>++loads===1?a.promise:b.promise,value=>values.push(value),()=>{},{minIntervalMs:0});const first=sync.refresh();sync.refresh();sync.refresh();a.resolve(1);await Promise.resolve();await Promise.resolve();assert.deepEqual(values,[]);b.resolve(2);await first;assert.equal(loads,2);assert.deepEqual(values,[2]);});
test('failed snapshot can recover on next invalidation',async()=>{let count=0;const values:number[]=[];const errors:unknown[]=[];const sync=createTaskSynchronizer(async()=>{if(++count===1)throw new Error('Disconnected');return count;},value=>values.push(value),error=>errors.push(error),{minIntervalMs:0});await assert.rejects(sync.refresh(),/Disconnected/);await sync.refresh();assert.equal(errors.length,1);assert.deepEqual(values,[2]);});
test('unmounted subscriptions cannot publish pending snapshots',async()=>{const pending=deferred<number>();const values:number[]=[];let loads=0;const sync=createTaskSynchronizer(()=>{loads++;return pending.promise;},value=>values.push(value),()=>{});const work=sync.refresh();sync.dispose();pending.resolve(1);await work;await sync.refresh();assert.deepEqual(values,[]);assert.equal(loads,1);});

test('list refreshes are limited to one per second and hidden tabs defer reads',async(t)=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});
 let loads=0;let visible=true;const values:number[]=[];
 const sync=createTaskSynchronizer(async()=>++loads,value=>values.push(value),()=>{},{isVisible:()=>visible});
 await sync.refresh();
 const next=sync.refresh();sync.refresh();
 t.mock.timers.tick(999);await Promise.resolve();assert.equal(loads,1);
 t.mock.timers.tick(1);await next;assert.equal(loads,2);
 visible=false;await sync.refresh();t.mock.timers.tick(5000);assert.equal(loads,2);
 visible=true;await sync.refresh();assert.equal(loads,3);
 const pending=sync.refresh();visible=false;t.mock.timers.tick(1000);await pending;assert.equal(loads,3);
 visible=true;await sync.refresh();assert.equal(loads,4);
 sync.dispose();t.mock.timers.reset();
});
test('disposing a throttled refresh cancels its pending load',async(t)=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});let loads=0;
 const sync=createTaskSynchronizer(async()=>++loads,()=>{},()=>{});
 await sync.refresh();const pending=sync.refresh();sync.dispose();await pending;
 t.mock.timers.tick(1000);assert.equal(loads,1);t.mock.timers.reset();
});
