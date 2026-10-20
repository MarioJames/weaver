import assert from 'node:assert/strict';
import test from 'node:test';
import { Reconnector, isTransientError } from '../src/renderer/api/reconnect';

test('classifies transport failures without retrying business failures or user aborts', () => {
  for (const error of ['TIMEOUT: 超时', 'NETWORK: Failed to fetch', 'HTTP_502: 网关', 'HTTP_503: unavailable', 'HTTP_504: 超时', 'APP_NOT_RUNNING: absent', new TypeError('Failed to fetch'), new DOMException('deadline', 'TimeoutError')]) assert.equal(isTransientError(error), true, String(error));
  for (const error of ['CONFLICT: changed', 'HTTP_400: bad', 'VALIDATION: invalid', 'BUSINESS: failed', 'VALIDATION: Failed to fetch', new DOMException('cancel', 'AbortError')]) assert.equal(isTransientError(error), false);
});

test('shared reconnect backs off, pauses hidden and recovers after all readers succeed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let hidden = false; let attempts = 0; let success = false;
  const states: string[] = [];
  const retry = new Reconnector(state => states.push(state.status), () => hidden);
  const result = retry.recover(async () => { attempts++; if (!success) throw Error('TIMEOUT: slow'); return 42; });
  const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
  for (const gap of [1000,2000,4000,8000,15000,15000]) { t.mock.timers.tick(gap-1); await flush(); const before=attempts; t.mock.timers.tick(1); await flush(); assert.equal(attempts,before+1); }
  hidden = true; retry.visibilityChanged(); t.mock.timers.tick(60000); await flush(); assert.equal(attempts,6);
  success = true; hidden = false; retry.visibilityChanged(); await flush(); assert.equal(await result,42); assert.equal(states.at(-1),'connected');
  t.mock.timers.tick(2000); assert.equal(states.at(-1),'idle'); retry.dispose();
});

test('concurrent readers share one attempt and one recovery notification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states: string[]=[]; const retry=new Reconnector(s=>states.push(s.status),()=>false);
  const one=retry.recover(async()=>1); const two=retry.recover(async()=>2);
  t.mock.timers.tick(1000); for(let i=0;i<12;i++)await Promise.resolve();
  assert.deepEqual(await Promise.all([one,two]),[1,2]); assert.equal(states.filter(s=>s==='connected').length,1); retry.dispose();
});


test('new outage replaces success timer and permanent retry failure does not claim reconnection', async t => {
  t.mock.timers.enable({apis:['setTimeout']}); const states: string[]=[];
  const retry=new Reconnector(s=>states.push(s.status),()=>false);
  const first=retry.recover(async()=>true); t.mock.timers.tick(1000); for(let i=0;i<12;i++)await Promise.resolve(); await first;
  const second=retry.recover(async()=>{throw Error('VALIDATION: invalid');});const failure=assert.rejects(second,/VALIDATION/);
  t.mock.timers.tick(1000);for(let i=0;i<12;i++)await Promise.resolve();await failure;
  assert.equal(states.at(-1),'idle');assert.equal(states.filter(s=>s==='connected').length,1);retry.dispose();
});

test('unsubscribe cancels only its pending reader', async t => {
  t.mock.timers.enable({apis:['setTimeout']});const controller=new AbortController();
  const retry=new Reconnector(()=>{},()=>false);let runs=0;
  const pending=retry.recover(async()=>{runs++;},controller.signal);const rejected=assert.rejects(pending,{name:'AbortError'});
  controller.abort();await rejected;t.mock.timers.tick(10000);assert.equal(runs,0);retry.dispose();
});
