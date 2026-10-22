import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,existsSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawn,execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { TaskStore } from '../../src/main/store';
import { PolicyStore } from '../../src/main/policy/store';
import { ScheduleService } from '../../src/main/schedules/service';
import { recoverOwnedScope } from '../../src/main/adapters/cli/scope';
import type { StoredRun } from '../../src/main/schedules/store';

const ROOT=process.env.ACCEPTANCE_TMPDIR??tmpdir();
const pause=()=>new Promise(r=>setTimeout(r,25));
const waitFor=async(predicate:()=>boolean,{timeout=15000,step=20}={}):Promise<void>=>{const started=Date.now();while(!predicate()&&Date.now()-started<timeout)await new Promise(r=>setTimeout(r,step));if(!predicate())throw new Error('waitFor timeout');};
// `systemctl --user show` fails with exit 1 ("could not be found") once a collected scope is gone;
// that absence is a meaningful answer, so the helper resolves '' instead of rejecting for it.
const execShowProperty=(unit:string,property:string)=>new Promise<string>((resolve,reject)=>{
 execFile('systemctl',['--user','show',`${unit}.scope`,'--property',property,'--value','--no-pager'],(error,stdout,stderr)=>{
  if(error){if(String(stderr).includes('could not be found'))return resolve('');return reject(error);}
  resolve(stdout.trim());
 });
});

test('restart terminates the persisted UUID scope before releasing the schedule claim, never repeats the side effect',async()=>{
 const dir=mkdtempSync(join(ROOT,'wv-sch-')),db=join(dir,'weaver.db'),pidFile=join(dir,'pid'),effect=join(dir,'effect');
 let store:TaskStore|undefined,service:ScheduleService|undefined;
 const code=`
 import { TaskStore } from ${JSON.stringify(resolve('src/main/store.ts'))};
 import { PolicyStore } from ${JSON.stringify(resolve('src/main/policy/store.ts'))};
 import { ScheduleService } from ${JSON.stringify(resolve('src/main/schedules/service.ts'))};
 const store=new TaskStore(${JSON.stringify(db)}),policy=new PolicyStore(store.db);
 const s=new ScheduleService({store,policy,notify:()=>{},createTask:()=>{},command:()=>({apiVersion:'weaver.v1',ok:true})});
 const d=s.create({name:'crash',kind:'script',enabled:true,timing:{mode:'interval',seconds:60},workspace:${JSON.stringify(dir)},script:{command:${JSON.stringify(`printf x >> '${effect}'; printf $$ > '${pidFile}'; sleep 60`)},timeoutSeconds:90}});
 s.run({scheduleId:d.id});
 setInterval(()=>{},1000);
 `;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:resolve('.'),stdio:['ignore','pipe','pipe']});
 let childError='';child.stderr.on('data',c=>{childError+=String(c);});
 try{
  for(let i=0;i<200&&!existsSync(pidFile)&&child.exitCode===null;i++)await pause();
  assert.ok(existsSync(pidFile),childError);
  const pid=Number(readFileSync(pidFile,'utf8'));process.kill(pid,0);
  // Simulated abrupt Weaver loss: no runner/manager cleanup executes.
  child.kill('SIGKILL');await new Promise<void>(r=>child.once('close',()=>r()));
  process.kill(pid,0);
  store=new TaskStore(db);const policy=new PolicyStore(store.db);
  service=new ScheduleService({store,policy,now:()=>Date.now()+3600_000,notify:()=>{},createTask:()=>{throw new Error('unexpected');},command:()=>({apiVersion:'weaver.v1',ok:true})});
  const before=service.list({}).schedules.find(d=>d.name==='crash')!;assert.ok(before.activeRunId);
  assert.throws(()=>service!.run({scheduleId:before.id}));
  await service.start(60000);
  const run=service.runs({scheduleId:before.id,runId:before.activeRunId}).runs[0];
  assert.equal(run.status,'interrupted',JSON.stringify(run));assert.equal(service.get({scheduleId:before.id}).activeRunId,undefined);
  assert.throws(()=>process.kill(pid,0));assert.equal(readFileSync(effect,'utf8'),'x');assert.equal(service.runs({scheduleId:before.id}).total,1,'missed deadlines while the old run was active are skipped');
 }finally{
  child.kill('SIGKILL');await service?.stop();
  const state=service?.storage.read();
  for(const d of state?.definitions??[])for(const r of state!.runs[d.id])if(r.process)await recoverOwnedScope(r.process.unit,r.process.invocation);
  await service?.stop();store?.close();rmSync(dir,{recursive:true,force:true});
 }
});

test('unverifiable process identity blocks the claim and enable cannot bypass recovery',async()=>{
 const dir=mkdtempSync(join(ROOT,'wv-sch-')),store=new TaskStore(join(dir,'weaver.db')),policy=new PolicyStore(store.db);
 const service=new ScheduleService({store,policy,notify:()=>{},createTask:()=>{},command:()=>({apiVersion:'weaver.v1',ok:true})});
 try{
  const d=service.create({name:'unknown identity',kind:'script',enabled:false,timing:{mode:'interval',seconds:60},workspace:dir,script:{command:'true',timeoutSeconds:10}});
  const run=(service as any).claim(d.id,'manual');
  service.storage.transaction(s=>{s.runs[d.id][0].process={unit:'unverified-identity'};});
  await service.start(60000);
  const active=service.get({scheduleId:d.id});assert.equal(active.activeRunId,run.id);assert.match(active.lastRun!.error!,/identity/);
  const enabled=service.enable({scheduleId:d.id,expectedRevision:active.revision},true);assert.ok(enabled.enabled);assert.equal(enabled.activeRunId,run.id);assert.throws(()=>service!.run({scheduleId:d.id}));
 }finally{await service.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('cancel during recovery only records intent and releases the claim when cleanup confirms',async()=>{
 const dir=mkdtempSync(join(ROOT,'wv-sch-')),store=new TaskStore(join(dir,'weaver.db')),policy=new PolicyStore(store.db);
 let service:ScheduleService|undefined;let failFirst=true;
 try{
  let phase=0,releaseFirst:()=>void=()=>{};
  service=new ScheduleService({store,policy,notify:()=>{},createTask:()=>({}),command:()=>({apiVersion:'weaver.v1',ok:true}),
   recoverScope:unit=>{
    if(phase!==0)return recoverOwnedScope(unit);
    phase=1;
    return new Promise<void>((resolve,reject)=>{releaseFirst=()=>failFirst?reject(new Error(`Cannot inspect schedule scope ${unit}; systemd user session is unavailable`)):resolve();});
   }});
  const d=service.create({name:'cancel during recovery',kind:'script',enabled:false,timing:{mode:'interval',seconds:60},workspace:dir,script:{command:'true',timeoutSeconds:5}});
  const run=(service as any).claim(d.id,'manual') as StoredRun;
  assert.match(run.process!.unit,/^weaver-schedule-[0-9a-f-]{36}$/);
  const starting=service.start(60000);
  await waitFor(()=>phase===1);
  assert.equal(service.cancel({scheduleId:d.id,runId:run.id}).status,'running');
  assert.equal(service.cancel({scheduleId:d.id,runId:run.id}).status,'running');
  assert.equal(service.get({scheduleId:d.id}).activeRunId,run.id);
  assert.throws(()=>service!.run({scheduleId:d.id}),/active run/);
  releaseFirst();
  await starting;
  await waitFor(()=>!!service!.storage.read().runs[d.id][0].recoveryError);
  let recorded=service.storage.read().runs[d.id][0];
  assert.equal(recorded.status,'running');assert.equal(service.get({scheduleId:d.id}).activeRunId,run.id);
  assert.match(recorded.recoveryError!,/systemd user session is unavailable/);
  failFirst=false;service.tick();
  await waitFor(()=>service!.storage.read().runs[d.id][0].status==='cancelled');
  recorded=service.storage.read().runs[d.id][0];
  assert.equal(recorded.status,'cancelled');
  assert.equal(service.get({scheduleId:d.id}).activeRunId,undefined);
  assert.equal(service.runs({scheduleId:d.id,runId:run.id}).runs[0].error,'Previous service execution ended; owned process cleanup confirmed');
 }finally{await service?.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('recovery verifies the scope InvocationID before stopping and still cleans a live scope without one',async()=>{
 const dir=mkdtempSync(join(ROOT,'wv-sch-')),db=join(dir,'weaver.db'),pidFile=join(dir,'pid');
 let store:TaskStore|undefined,service:ScheduleService|undefined,launcher:ChildProcess|undefined;
 let unit='';
 try{
  store=new TaskStore(db);
  const policy=new PolicyStore(store.db);
  service=new ScheduleService({store,policy,notify:()=>{},createTask:()=>({}),command:()=>({apiVersion:'weaver.v1',ok:true})});
  const d=service.create({name:'scope identity',kind:'script',enabled:false,timing:{mode:'interval',seconds:60},workspace:dir,script:{command:`printf $$ > '${pidFile}'; sleep 30`,timeoutSeconds:90}});
  const run=(service as any).claim(d.id,'manual') as StoredRun;
  unit=run.process!.unit;
  launcher=spawn('systemd-run',['--user','--scope','--collect','--quiet',`--unit=${unit}`,`--working-directory=${dir}`,'-p','MemoryHigh=8G','-p','MemoryMax=10G','-p','KillMode=control-group','--','/bin/sh','-c',`printf $$ > '${pidFile}'; sleep 30`],{cwd:dir,env:process.env,stdio:['ignore','ignore','ignore'],detached:true});
  await waitFor(()=>existsSync(pidFile));
  const pid=Number(readFileSync(pidFile,'utf8'));
  const invocation:string=await (async()=>{
   for(let i=0;i<200;i++){await pause();try{const value=await execShowProperty(unit,'InvocationID');if(value&&value!=='n/a')return value;}catch{/* scope briefly missing between registration frames */}}
   throw new Error('no InvocationID observed');
  })();
  service.storage.transaction(s=>{s.runs[d.id][0].process!.invocation='00000000000000000000000000000000';});
  // A mismatched InvocationID is a replaced scope: fail closed, keep the claim, never stop it.
  await assert.rejects(()=>recoverOwnedScope(unit,'00000000-0000-0000-0000-000000000000'),/identity changed/);
  process.kill(pid,0);
  await service.start(60000);
  await waitFor(()=>!!service!.storage.read().runs[d.id][0].recoveryError);
  let recorded=service.storage.read().runs[d.id][0];
  assert.equal(recorded.status,'running');
  assert.equal(service.get({scheduleId:d.id}).activeRunId,run.id);
  assert.match(recorded.recoveryError!,/identity changed|ownership inspection required/);
  process.kill(pid,0);
  // Without a persisted InvocationID the schedule-owned unit is still recovered by its run-scoped
  // name, and the claim is only released behind a confirmed SIGKILL+stop of that same scope.
  await service.stop();
  service.storage.transaction(s=>{delete s.runs[d.id][0].process!.invocation;});
  service=new ScheduleService({store,policy,notify:()=>{},createTask:()=>({}),command:()=>({apiVersion:'weaver.v1',ok:true})});
  await service.start(60000);
  await waitFor(()=>service!.storage.read().runs[d.id][0].status==='interrupted');
  recorded=service.storage.read().runs[d.id][0];
  assert.equal(recorded.status,'interrupted');
  assert.equal(service.get({scheduleId:d.id}).activeRunId,undefined);
  assert.throws(()=>process.kill(pid,0),/ESRCH/);
  // SIGKILL can leave a short-lived failed/unregistered frame behind; what must never survive is an active scope.
  for(let i=0;i<60;i++){await pause();const active=await execShowProperty(unit,'ActiveState');if(active!=='active')break;if(i===59)assert.fail(`scope still active after recovery: ${active}`);}
 }finally{
  launcher?.kill('SIGKILL');
  const state=service?.storage.read();
  for(const def of state?.definitions??[])for(const r of state!.runs[def.id]??[])if(r.process)try{await recoverOwnedScope(r.process.unit,r.process.invocation);}catch{/* keep the workspace clean even if the run never settled */}
  await service?.stop();store?.close();rmSync(dir,{recursive:true,force:true});
 }
});


const cliUnit=()=>`weaver-cli-codex-${randomBytes(4).toString('hex')}`;
// Single-quote helper for shell fixtures: user-controlled paths are only ever path literals.
const shQuote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
const activeState=async(unit:string)=>execShowProperty(unit,'ActiveState');
const invocationOf=async(unit:string)=>{
 for(let i=0;i<200;i++){await pause();try{const value=await execShowProperty(unit,'InvocationID');if(value&&value!=='n/a')return value;}catch{/* scope briefly missing between registration frames */}}
 throw new Error('no InvocationID observed');
};
const waitGone=async(unit:string)=>{for(let i=0;i<200;i++){await pause();const load=await execShowProperty(unit,'LoadState');const active=await activeState(unit);if(load==='not-found'||!active||active==='inactive'||active==='failed')return;}throw new Error(`scope still active: ${unit}`);};
const exactScopeCleanup=async(unit:string)=>{
 await new Promise<void>(resolve=>{execFile('systemctl',['--user','stop',`${unit}.scope`],()=>resolve());});
};

test('only exact real CLI unit names are accepted for recovery',async()=>{
 for(const unit of ['weaver-cli-unknown-abcdef12','weaver-cli-codex-ABCDEF12','weaver-cli-codex-abcdef1','weaver-cli-codex-abcdef123','weaver-cli-codex-e7d6975g']){
  await assert.rejects(()=>recoverOwnedScope(unit),/Cannot verify persisted schedule process identity/);
 }
});

test('collected CLI scope is already clean, but a live replacement needs its exact invocation',async()=>{
 const dir=mkdtempSync(join(ROOT,'wv-cli-scope-')),pidFile=join(dir,'pid');
 const unit=cliUnit();let launcher:ChildProcess|undefined;
 try{
  launcher=spawn('systemd-run',['--user','--scope','--collect','--quiet',`--unit=${unit}`,'--working-directory='+dir,'-p','MemoryHigh=8G','-p','MemoryMax=10G','-p','KillMode=control-group','--','/bin/sh','-c',`printf $$ > '${pidFile}'; sleep 30`],{cwd:dir,env:process.env,stdio:['ignore','ignore','ignore'],detached:true});
  await waitFor(()=>existsSync(pidFile));
  const pid=Number(readFileSync(pidFile,'utf8')), invocation=await invocationOf(unit);
  // No persisted invocation and a wrong one are both unverifiable: refuse and leave the process alive.
  await assert.rejects(()=>recoverOwnedScope(unit),/identity is missing/);
  process.kill(pid,0);
  await assert.rejects(()=>recoverOwnedScope(unit,'00000000000000000000000000000000'),/identity changed/);
  process.kill(pid,0);
  await recoverOwnedScope(unit,invocation);
  await waitFor(()=>{try{process.kill(pid,0);return false;}catch{return true;}});
  await waitGone(unit);
  // A collected unit under a fresh name is already clean and must return success.
  const collectedUnit=cliUnit();
  await new Promise<void>((resolve,reject)=>{
   const child=spawn('systemd-run',['--user','--scope','--collect','--quiet',`--unit=${collectedUnit}`,'--working-directory='+dir,'--','/bin/true'],{cwd:dir,env:process.env,stdio:['ignore','ignore','ignore'],detached:true});
   child.once('error',reject);child.once('exit',()=>resolve());
  });
  await waitGone(collectedUnit);
  await recoverOwnedScope(collectedUnit,invocation);
  await recoverOwnedScope(collectedUnit);
 }finally{
  launcher?.kill('SIGKILL');
  await exactScopeCleanup(unit);
  rmSync(dir,{recursive:true,force:true});
 }
});

test('recovery kills only an exact late systemd-run launcher, never a similar unit',async()=>{
 const dir=mkdtempSync(join(ROOT,'wv-late-')),marker=join(dir,'launched'),decoyMarker=join(dir,'decoy-launched');
 const unit=cliUnit(), other=cliUnit();
 const script=(name:string,mark:string)=>`sleep 1; touch ${shQuote(mark)}; exec /usr/bin/systemd-run --user --scope --quiet --collect --unit='${name}' -- /bin/sleep 30`;
 const late=spawn('/bin/bash',['-c',`exec -a systemd-run /bin/sh -c ${shQuote(script(unit,marker))} --unit='${unit}'`],{env:process.env,stdio:['ignore','ignore','ignore'],detached:true});
 const decoy=spawn('/bin/bash',['-c',`exec -a systemd-run /bin/sh -c ${shQuote(script(other,decoyMarker))} --unit='${other}'`],{env:process.env,stdio:['ignore','ignore','ignore'],detached:true});
 try{
  await waitFor(()=>!!late.pid&&!!decoy.pid);
  await recoverOwnedScope(unit);
  await waitFor(()=>{try{process.kill(late.pid!,0);return false;}catch{return true;}});
  // The decoy launcher is a different exact unit and must survive.
  process.kill(decoy.pid!,0);
  await new Promise(r=>setTimeout(r,1500));
  assert.equal(existsSync(marker),false,'the killed launcher must not start any real scope');
  assert.equal(existsSync(decoyMarker),true,'the different unit launcher was not killed');
  process.kill(decoy.pid!,0);
  assert.ok(!['active','activating','deactivating'].includes(await activeState(unit)));
 }finally{
  late.kill('SIGKILL');decoy.kill('SIGKILL');
  await exactScopeCleanup(unit);await exactScopeCleanup(other);
  rmSync(dir,{recursive:true,force:true});
 }
});
