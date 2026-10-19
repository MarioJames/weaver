import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decodeLines, processInScope, startOwnedScope } from '../src/main/adapters/cli/scope';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for scope fixture');
}

test('owned scope kills a detached grandchild and does not signal an unrelated process', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-cli-scope-'));
  const pidfile = join(dir, 'grand.pid');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  unrelated.unref();
  const unit = `weaver-cli-scope-${randomBytes(3).toString('hex')}`;
  const scope = startOwnedScope({
    command: [process.execPath, '-e', 'const {spawn}=require("node:child_process"); const fs=require("node:fs"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}); child.unref(); fs.writeFileSync(process.env.GRAND_PIDFILE, String(child.pid)); setInterval(()=>{},1000);'],
    cwd: dir,
    env: { ...process.env, GRAND_PIDFILE: pidfile },
    stdin: null,
    unit,
  });
  const errors: string[] = [];
  scope.on('error', error => errors.push(error instanceof Error ? error.message : String(error)));
  try {
    await waitFor(() => {
      try { return Number(readFileSync(pidfile, 'utf8')) > 1; } catch { return false; }
    });
    const grandchild = Number(readFileSync(pidfile, 'utf8'));
    await waitFor(() => processInScope(grandchild, unit) && processInScope(scope.pid ?? 0, unit));
    assert.equal(processInScope(unrelated.pid ?? 0, unit), false);
    const closed = new Promise<void>(resolve => scope.once('close', () => resolve()));
    assert.equal(scope.kill('SIGTERM'), true);
    await closed;
    await waitFor(() => !alive(grandchild));
    assert.equal(alive(unrelated.pid ?? 0), true);
    assert.equal(errors.length, 0);
  } finally {
    if (unrelated.pid) try { process.kill(unrelated.pid, 'SIGKILL'); } catch { /* already gone */ }
    try { scope.kill('SIGKILL'); } catch { /* scope already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('owned scope returns command stdout and a zero exit', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-cli-echo-'));
  const unit = `weaver-cli-echo-${randomBytes(3).toString('hex')}`;
  const rejections: unknown[] = [];
  const onRejection = (error: unknown) => { rejections.push(error); };
  process.on('unhandledRejection', onRejection);
  const scope = startOwnedScope({ command: ['/bin/echo', 'SCOPE_OK'], cwd: dir, env: { ...process.env }, stdin: null, unit });
  scope.on('error', () => {});
  let stdout = '';
  scope.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  const code = await new Promise<number | null>(resolve => scope.once('close', value => resolve(value)));
  const active = await new Promise<string>(resolve => {
    execFile('systemctl', ['--user', 'show', `${unit}.scope`, '-p', 'ActiveState', '--no-pager'], { timeout: 8000 }, (_error, out) => {
      resolve(out ?? '');
    });
  });
  try {
    assert.equal(stdout.trim(), 'SCOPE_OK');
    assert.equal(code, 0);
    assert.equal(active.includes('ActiveState=active'), false);
    assert.equal(rejections.length, 0);
  } finally {
    process.off('unhandledRejection', onRejection);
    rmSync(dir, { recursive: true, force: true });
  }
});


const run = promisify(execFile);
async function inspectScope(unit: string): Promise<string> {
  try { return (await run('systemctl', ['--user', 'show', `${unit}.scope`, '-p', 'ActiveState', '-p', 'ControlGroup', '-p', 'InvocationID', '--no-pager'], {timeout:8000})).stdout; }
  catch (error) { return (error as {stdout?:string}).stdout ?? ''; }
}
async function cleanupScope(unit: string): Promise<void> {
  for (const args of [['kill','-s','SIGKILL','--kill-whom=all',`${unit}.scope`],['stop',`${unit}.scope`]]) {
    await run('systemctl',['--user',...args],{timeout:8000}).catch(()=>{});
  }
}

test('immediate cancellation waits for a delayed owned scope and leaves no live descendants', {timeout:20000}, async t=>{
  const dir=mkdtempSync(join(tmpdir(),'wv-scope-start-'));
  const wrapper=join(dir,'systemd-run');
  const pidfile=join(dir,'started.json');
  writeFileSync(wrapper,'#!/bin/sh\n/usr/bin/sleep 0.4\nexec /usr/bin/systemd-run "$@"\n');chmodSync(wrapper,0o700);
  const unit=`weaver-cli-start-${randomBytes(6).toString('hex')}`;
  const began=Date.now();let closed=false;let closeCode:number|null|undefined;let closeSignal:NodeJS.Signals|null|undefined;
  const errors:string[]=[];
  let pids:{parent:number;grand:number}|undefined;
  const scope=startOwnedScope({command:[process.execPath,'-e','const {spawn}=require("node:child_process");const fs=require("node:fs");const grand=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});grand.unref();fs.writeFileSync(process.env.SCOPE_PIDFILE,JSON.stringify({parent:process.pid,grand:grand.pid}));setInterval(()=>{},1000);'],cwd:dir,env:{...process.env,PATH:dir+':'+process.env.PATH,SCOPE_PIDFILE:pidfile},stdin:null,unit});
  const launcher=scope.pid;
  scope.on('error',error=>errors.push(String(error)));
  scope.on('close',(code,signal)=>{closed=true;closeCode=code;closeSignal=signal;});
  try{
    assert.equal(scope.kill('SIGTERM'),true);
    await waitFor(()=>closed).catch(()=>{});
    try{pids=JSON.parse(readFileSync(pidfile,'utf8'));}catch{/* cancellation may prevent command startup */}
    const active=await inspectScope(unit);
    const observed={unit,launcherPid:launcher,elapsed:Date.now()-began,closed,closeCode,closeSignal,errors,pids,active,parentAlive:pids?alive(pids.parent):false,grandAlive:pids?alive(pids.grand):false,parentInScope:pids?processInScope(pids.parent,unit):false,grandInScope:pids?processInScope(pids.grand,unit):false};
    t.diagnostic(JSON.stringify(observed));
    assert.equal(closed,true,JSON.stringify(observed));
    assert.doesNotMatch(active,/ActiveState=(active|activating|deactivating)(?:\n|$)/);
    if(pids){await waitFor(()=>!alive(pids!.parent)&&!alive(pids!.grand));}
    assert.deepEqual(errors,[]);
  }finally{
    await cleanupScope(unit);
    if(launcher&&!closed){
      let command='';try{command=readFileSync(`/proc/${launcher}/cmdline`,'utf8');}catch{/* already gone */}
      if(command.includes(wrapper)||processInScope(launcher,unit))try{process.kill(launcher,'SIGKILL');}catch{/* already gone */}
    }
    await cleanupScope(unit);
    await waitFor(()=>closed).catch(()=>{});
    const cleanup=await inspectScope(unit);
    t.diagnostic(JSON.stringify({phase:'cleanup',unit,launcherPid:launcher,closed,elapsed:Date.now()-began,active:cleanup,launcherAlive:launcher?alive(launcher):false,parentAlive:pids?alive(pids.parent):false,grandAlive:pids?alive(pids.grand):false}));
    rmSync(dir,{recursive:true,force:true});
  }
});


test('cancelled failed launcher and fast command exit both close without a live scope', {timeout:20000}, async t=>{
  for(const mode of ['failed-launcher','fast-exit'] as const){
    const dir=mkdtempSync(join(tmpdir(),'wv-scope-end-'));
    const wrapper=join(dir,'systemd-run');
    writeFileSync(wrapper,mode==='failed-launcher'?'#!/bin/sh\n/usr/bin/sleep 0.4\nexit 17\n':'#!/bin/sh\n/usr/bin/sleep 0.4\nexec /usr/bin/systemd-run "$@"\n');chmodSync(wrapper,0o700);
    const unit=`weaver-cli-end-${randomBytes(6).toString('hex')}`;
    const began=Date.now();let closed=false;let code:number|null|undefined;const errors:string[]=[];
    const scope=startOwnedScope({command:['/bin/echo','FAST_EXIT'],cwd:dir,env:{...process.env,PATH:dir+':'+process.env.PATH},stdin:null,unit});
    scope.on('error',error=>errors.push(String(error)));scope.on('close',value=>{closed=true;code=value;});
    try{
      assert.equal(scope.kill('SIGTERM'),true);await waitFor(()=>closed);
      const active=await inspectScope(unit);t.diagnostic(JSON.stringify({mode,unit,launcherPid:scope.pid??null,closed,code,elapsed:Date.now()-began,errors,active}));
      if(mode==='failed-launcher')assert.equal(code,17);
      assert.doesNotMatch(active,/ActiveState=(active|activating|deactivating)(?:\n|$)/);assert.deepEqual(errors,[]);
    }finally{
      await cleanupScope(unit);
      const cleanup=await inspectScope(unit);t.diagnostic(JSON.stringify({phase:'cleanup',mode,unit,launcherPid:scope.pid??null,closed,active:cleanup,launcherAlive:scope.pid?alive(scope.pid):false}));
      rmSync(dir,{recursive:true,force:true});
    }
  }
});

test('SIGKILL upgrades a pending cancellation after SIGTERM was ignored', {timeout:20000}, async t=>{
  const dir=mkdtempSync(join(tmpdir(),'wv-scope-kill-'));
  const ready=join(dir,'ready');const term=join(dir,'term');
  const unit=`weaver-cli-kill-${randomBytes(6).toString('hex')}`;
  const began=Date.now();let closed=false;let signal:NodeJS.Signals|null|undefined;const errors:string[]=[];
  const scope=startOwnedScope({command:[process.execPath,'-e','const fs=require("node:fs");process.on("SIGTERM",()=>fs.writeFileSync(process.env.TERM_FILE,"seen"));fs.writeFileSync(process.env.READY_FILE,String(process.pid));setInterval(()=>{},1000);'],cwd:dir,env:{...process.env,READY_FILE:ready,TERM_FILE:term},stdin:null,unit});
  const launcher=scope.pid;
  scope.on('error',error=>errors.push(String(error)));scope.on('close',(_code,value)=>{closed=true;signal=value;});
  try{
    await waitFor(()=>{try{return Number(readFileSync(ready,'utf8'))>1;}catch{return false;}});
    const pid=Number(readFileSync(ready,'utf8'));assert.equal(processInScope(pid,unit),true);
    assert.equal(scope.kill('SIGTERM'),true);assert.equal(scope.kill('SIGTERM'),false);
    await waitFor(()=>{try{return readFileSync(term,'utf8')==='seen';}catch{return false;}});
    assert.equal(scope.kill('SIGKILL'),true);await waitFor(()=>closed);await waitFor(()=>!alive(pid));
    const active=await inspectScope(unit);t.diagnostic(JSON.stringify({unit,pid,closed,signal,elapsed:Date.now()-began,errors,active,pidAlive:alive(pid)}));
    assert.equal(signal,'SIGKILL');assert.doesNotMatch(active,/ActiveState=(active|activating|deactivating)(?:\n|$)/);assert.deepEqual(errors,[]);
    assert.equal(scope.kill('SIGKILL'),false);
  }finally{
    await cleanupScope(unit);const active=await inspectScope(unit);t.diagnostic(JSON.stringify({phase:'cleanup',unit,launcherPid:launcher,closed,active,launcherAlive:launcher?alive(launcher):false}));rmSync(dir,{recursive:true,force:true});
  }
});

test('missing launcher executable reports an error and closes without waiting for a scope', {timeout:15000}, async t=>{
  const dir=mkdtempSync(join(tmpdir(),'wv-scope-miss-'));
  const unit=`weaver-cli-miss-${randomBytes(6).toString('hex')}`;
  const began=Date.now();let closed=false;let code:number|null|undefined;const errors:string[]=[];
  const scope=startOwnedScope({command:['/bin/echo','UNREACHED'],cwd:dir,env:{...process.env,PATH:dir},stdin:null,unit});
  scope.on('error',error=>errors.push(String(error)));scope.on('close',value=>{closed=true;code=value;});
  try{
    await waitFor(()=>closed);const active=await inspectScope(unit);
    t.diagnostic(JSON.stringify({unit,launcherPid:scope.pid??null,closed,code,elapsed:Date.now()-began,errors,active}));
    assert.notEqual(code,0);assert.ok(errors.some(error=>error.includes('ENOENT')));assert.doesNotMatch(active,/ActiveState=(active|activating|deactivating)(?:\n|$)/);
  }finally{
    await cleanupScope(unit);const active=await inspectScope(unit);t.diagnostic(JSON.stringify({phase:'cleanup',unit,launcherPid:scope.pid??null,closed,active}));rmSync(dir,{recursive:true,force:true});
  }
});


test('oversized complete frames split across chunks never reach the parser',t=>{
  const pushed:number[]=[];const overflows:unknown[]=[];
  const decoder=decodeLines(line=>pushed.push(Buffer.byteLength(line)),(...details:unknown[])=>overflows.push(details[0]));
  decoder.write(Buffer.concat([Buffer.from('before\n'),Buffer.alloc(120*1024,97)]));
  decoder.write(Buffer.concat([Buffer.alloc(60*1024,98),Buffer.from('\nafter\n')]));
  decoder.write(Buffer.from('ignored\n'));decoder.end();
  t.diagnostic(JSON.stringify({case:'split-complete',pushedBytes:pushed,overflows}));
  assert.deepEqual(pushed,[6]);assert.deepEqual(overflows,[{phase:'complete',limitBytes:128*1024,observedBytes:180*1024}]);
});

for(const mode of ['unterminated','end-flush'] as const)test(`frame byte limit also applies to ${mode}`,t=>{
    const pushed:number[]=[];const overflows:unknown[]=[];
    const decoder=decodeLines(line=>pushed.push(Buffer.byteLength(line)),(...details:unknown[])=>overflows.push(details[0]));
    decoder.write(mode==='unterminated'?Buffer.alloc(128*1024+1,97):Buffer.concat([Buffer.alloc(128*1024-2,97),Buffer.from([0xe2])]));
    decoder.end();decoder.write(Buffer.from('ignored\n'));decoder.end();
    t.diagnostic(JSON.stringify({case:mode,pushedBytes:pushed,overflows}));
    assert.deepEqual(pushed,[]);assert.deepEqual(overflows,[{phase:'unterminated',limitBytes:128*1024,observedBytes:128*1024+1}]);
});

test('exact byte-limit UTF-8 frames are accepted when split inside a multibyte character',t=>{
  for(const terminated of [true,false]){
    const line=Buffer.from('汉'.repeat(Math.floor(128*1024/3))+'aa');
    assert.equal(line.length,128*1024);
    const pushed:number[]=[];const overflows:unknown[]=[];
    const decoder=decodeLines(value=>pushed.push(Buffer.byteLength(value)),(...details:unknown[])=>overflows.push(details[0]));
    decoder.write(line.subarray(0,1));decoder.write(line.subarray(1));if(terminated)decoder.write(Buffer.from('\n'));decoder.end();
    t.diagnostic(JSON.stringify({case:'exact-utf8',terminated,pushedBytes:pushed,overflows}));
    assert.deepEqual(pushed,[128*1024]);assert.deepEqual(overflows,[]);
  }
});
