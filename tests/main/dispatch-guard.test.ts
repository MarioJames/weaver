import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync }  from 'node:fs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../../src/main/store';
import { TaskManager } from '../../src/main/manager';
import { MockWorkerAdapter, type ManagedProcess } from '../../src/main/adapters/worker';
import { RoutingWorkerAdapter } from '../../src/main/adapters/routing';
import type { CliAgentInput, StartCliAgent } from '../../src/main/adapters/launch';
import { CommandHandler } from '../../src/main/commands';
import { PolicyStore } from '../../src/main/policy/store';
import { workspaceIdentity } from '../../src/main/workspace';
import { metadataOf } from '../helpers/store-metadata';

function hangProcess(): ManagedProcess {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const emitter = new EventEmitter();
  let closed = false;
  return Object.assign(emitter, {
    stdout, stderr, pid: 7,
    kill() { if (!closed) { closed = true; emitter.emit('close', null, 'SIGTERM'); } return true; },
  }) as ManagedProcess;
}

function successProcess(): ManagedProcess {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const emitter = new EventEmitter();
  const proc = Object.assign(emitter, { stdout, stderr, pid: 4242, kill: () => true }) as ManagedProcess;
  setImmediate(() => {
    stdout.push(Buffer.from(JSON.stringify({ type: 'result', summary: 'real ok' }) + '\n'));
    stdout.push(null);
    emitter.emit('close', 0, null);
  });
  return proc;
}

function setup(launch?: StartCliAgent, mockTestTimeoutMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-dispatch-'));
  const store = new TaskStore(join(dir,'weaver.db'));
  let mockStarts = 0;
  const mock = { id: 'mock-jsonl', start() { mockStarts += 1; throw new Error('mock fallback'); } };
  const seen: CliAgentInput[] = [];
  const adapter = new RoutingWorkerAdapter(mock, launch ? (input) => { seen.push(input); return launch(input); } : undefined, join(dir, 'agent-state'), id => metadataOf(store).packages.find(pkg => pkg.id === id));
  const manager = new TaskManager(store, adapter, () => {}, mockTestTimeoutMs, error => { throw error; });
  const policy = new PolicyStore(join(dir,'weaver.db'));
  const handler = new CommandHandler(manager, policy);
  const raw = (command: string, args: Record<string, unknown> = {}, commandId = randomUUID()): any => handler.handle({ apiVersion: 'weaver.v1', commandId, command, args });
  return { dir, store, handler, policy, raw, seen, mockStarts: () => mockStarts, close: async () => { handler.draining = true; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

const owner = { name: 'demo', transport: 'herdr-visible' as const, session: 'reference', pane: 'reference' };

test('server create does not invent a workspace and real dispatch never falls back', async () => {
  const f = setup();
  try {
    const created = f.raw('tasks.create', { title: 'Bare', instruction: 'no workspace', owner });
    assert.equal(created.ok, true);
    assert.equal(created.data.workspace, undefined);
    const missing = f.raw('workers.spawn', { taskId: created.data.id, owner: 'claude_owner', worker: 'codex_worker' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, 'CAPABILITY_UNAVAILABLE');
    assert.match(missing.error?.message ?? '', /not loaded|No mock/);
    assert.equal(f.mockStarts(), 0);
    assert.equal(f.seen.length, 0);
    const stored = f.store.get(created.data.id);
    assert.equal(stored.status, 'queued');
    assert.equal(stored.run, undefined);
    assert.equal(stored.dispatch, undefined);
    const claude = f.raw('tasks.create', { title: 'Claude', instruction: 'deferred', owner, workspace: '/tmp' });
    const denied = f.raw('workers.spawn', { taskId: claude.data.id, owner: 'codex_owner', worker: 'claude_worker' });
    assert.equal(denied.ok, false);
    assert.match(denied.error?.message ?? '', /Claude Code real execution is deferred/);
    assert.equal(f.store.get(claude.data.id).status, 'queued');
    assert.equal(f.mockStarts(), 0);
  } finally { await f.close(); }
});

test('real dispatch freezes an existing absolute workspace and does not launch when it is missing', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'weaver-project-'));
  const f = setup(() => successProcess());
  try {
    const relative = f.raw('tasks.create', { title: 'Relative', instruction: 'no', owner, workspace: 'relative/project' });
    const rejected = f.raw('workers.spawn', { taskId: relative.data.id, owner: 'claude_owner', worker: 'codex_worker' });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error?.message ?? '', /absolute project directory/);
    assert.equal(f.seen.length, 0);
    assert.equal(f.store.get(relative.data.id).status, 'queued');
    assert.equal(f.mockStarts(), 0);
    const absent = f.raw('tasks.create', { title: 'Gone', instruction: 'no', owner, workspace: join(workspace, 'missing') });
    const notFound = f.raw('workers.spawn', { taskId: absent.data.id, owner: 'claude_owner', worker: 'codex_worker' });
    assert.equal(notFound.ok, false);
    assert.match(notFound.error?.message ?? '', /does not exist/);
    assert.equal(f.seen.length, 0);
    assert.equal(f.store.get(absent.data.id).status, 'queued');
    const created = f.raw('tasks.create', { title: 'Real', instruction: 'edit the fixture', owner, workspace, constraints:['Only edit the fixture'],acceptanceCriteria:['Verify actual fixture contents'] });
    const pkg=f.raw('packages.create',{taskId:created.data.id,scope:['Read fixture.txt','Write fixture.txt only'],acceptanceCriteria:['Verify actual fixture contents']});
    assert.equal(pkg.ok,true);
    const spawned = f.raw('workers.spawn', { taskId: created.data.id, owner: 'claude_owner', worker: 'codex_worker' });
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    assert.equal(spawned.data.dispatch.execution, 'real');
    assert.equal(spawned.data.dispatch.workspace, realpathSync(workspace));
    assert.equal(spawned.data.dispatch.model, 'gpt-6.1-sol');
    assert.equal(spawned.data.run.adapter, 'codex');
    assert.equal(spawned.data.dispatch.maxWaitMinutes, 15);
    assert.equal(spawned.data.run.timeoutMs, undefined);
    assert.equal(f.mockStarts(), 0);
    assert.equal(f.seen[0].engine, 'codex');
    assert.equal(f.seen[0].workspace, realpathSync(workspace));
    assert.equal(f.seen[0].role, 'worker');
    assert.match(f.seen[0].instruction,/not an owner/);
    assert.match(f.seen[0].instruction,/Do not delegate/);
    assert.match(f.seen[0].instruction,/commit, or push/);
    for(const phrase of ['Read fixture.txt','Write fixture.txt only','Only edit the fixture','Verify actual fixture contents'])assert.ok(f.seen[0].instruction.includes(phrase),phrase);
    assert.equal(f.seen[0].stateDir.startsWith(join(f.dir, 'agent-state')), true);
    const deadline = Date.now() + 2000;
    let done = f.store.get(created.data.id);
    while (done.status !== 'completed' && Date.now() < deadline) { await new Promise(r => setTimeout(r, 15)); done = f.store.get(created.data.id); }
    assert.equal(done.status, 'completed');
    assert.equal(done.dispatch?.worker, 'codex_worker');
    assert.equal(done.dispatch?.model, 'gpt-6.1-sol');
  } finally { await f.close(); rmSync(workspace, { recursive: true, force: true }); }
});

test('a real run outlives its frozen wait bound and the mock test hook; only the owner stops it', async () => {
  const f = setup(() => hangProcess(), 50);
  try {
    const created = f.raw('tasks.create', { title: 'Patient', instruction: 'fixture', owner, workspace: f.dir });
    const spawned = f.raw('workers.spawn', { taskId: created.data.id, owner: 'claude_owner', worker: 'codex_worker' });
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    assert.equal(spawned.data.dispatch.execution, 'real');
    assert.equal(spawned.data.dispatch.maxWaitMinutes, 15);
    assert.equal(spawned.data.run.timeoutMs, undefined);
    await new Promise(resolve => setTimeout(resolve, 400));
    const running = f.store.get(created.data.id);
    assert.equal(running.status, 'running');
    assert.equal(running.events.some(e => e.kind === 'error'), false);
    assert.equal(f.seen.length, 1);
    assert.equal(f.raw('tasks.cancel', { taskId: created.data.id }).data.status, 'cancelling');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.store.get(created.data.id).status, 'cancelled');
  } finally { await f.close(); }
});

test('a queued route stays frozen when the saved model changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-freeze-'));
  const store = new TaskStore(join(dir,'weaver.db'));
  const manager = new TaskManager(store, new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs')));
  const policy = new PolicyStore(join(dir,'weaver.db'));
  const handler = new CommandHandler(manager, policy);
  try {
    const created = handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command: 'tasks.create', args: { title: 'Hold', instruction: 'wait', owner } });
    assert.equal(created.ok, true);
    const task = store.get((created.data as { id: string }).id);
    task.scheduled = true;
    task.dispatch = { owner: 'codex_owner', worker: 'codex_worker', engine: 'codex', model: 'frozen-model', effort: 'high', execution: 'mock', maxParallel: 4, maxWaitMinutes: 15, adapter: 'mock-jsonl' };
    store.put(task);
    const snapshot = policy.snapshot();
    snapshot.config.workers.codex_worker.model = 'changed-model';
    policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [] });
    handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));
    const held = store.get(task.id);
    assert.equal(held.status, 'queued');
    assert.equal(held.dispatch?.model, 'frozen-model');
    assert.equal(held.dispatch?.worker, 'codex_worker');
    assert.equal(held.run, undefined);
  } finally { handler.draining = true; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('a lower max_parallel blocks the next start and does not stop work already running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-parallel-'));
  const store = new TaskStore(join(dir,'weaver.db'));
  const manager = new TaskManager(store, { id: 'mock-jsonl', start: () => hangProcess() });
  const policy = new PolicyStore(join(dir,'weaver.db'));
  const handler = new CommandHandler(manager, policy);
  const saveParallel = (value: number) => {
    const snapshot = policy.snapshot();
    snapshot.config.owners.codex_owner.max_parallel = value;
    policy.save({ revision: snapshot.revision, config: snapshot.config, blocks: [] });
  };
  const spawn = (taskId: string) => handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command: 'workers.spawn', args: { taskId, owner: 'codex_owner', provider: 'mock-jsonl' } });
  try {
    saveParallel(1);
    const first = handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command: 'tasks.create', args: { title: 'Running', instruction: 'hold', owner } });
    const second = handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command: 'tasks.create', args: { title: 'Waiting', instruction: 'hold', owner } });
    const firstId = (first.data as { id: string }).id;
    const secondId = (second.data as { id: string }).id;
    assert.equal(spawn(firstId).ok, true);
    assert.equal(store.get(firstId).status, 'running');
    assert.equal(store.get(firstId).dispatch?.maxParallel, 1);
    const queued = spawn(secondId);
    assert.equal(queued.ok, true);
    assert.equal(store.get(secondId).status, 'queued');
    assert.equal(store.get(secondId).queueReason?.code, 'waiting_for_capacity');
    saveParallel(2);
    handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));
    const started = store.get(secondId);
    assert.equal(started.status, 'running');
    assert.equal(started.queueReason, undefined);
    assert.equal(started.dispatch?.maxParallel, 1);
    assert.equal(started.dispatch?.model, 'gpt-6.1-sol');
    assert.equal(store.get(firstId).status, 'running');
    saveParallel(1);
    const third = handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command: 'tasks.create', args: { title: 'Blocked', instruction: 'hold', owner } });
    const thirdId = (third.data as { id: string }).id;
    assert.equal(spawn(thirdId).ok, true);
    assert.equal(store.get(thirdId).status, 'queued');
    handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(store.get(firstId).status, 'running');
    assert.equal(store.get(secondId).status, 'running');
    assert.equal(store.get(thirdId).status, 'queued');
    assert.equal(store.get(thirdId).dispatch?.model, 'gpt-6.1-sol');
    const caps = handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command: 'capabilities.get', args: {} });
    const config = policy.snapshot().config;
    const derived = Object.values(config.owners).filter(owner => owner.enabled).reduce((sum, owner) => sum + owner.max_parallel, 0);
    assert.equal((caps.data as { maxParallel: number }).maxParallel, derived);
    assert.equal(Object.hasOwn(config, 'maxParallel'), false);
    assert.equal(Object.hasOwn(config, 'max_parallel'), false);
  } finally { handler.draining = true; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('explicit mock provider still runs the mock worker from the real runtime adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-explicit-mock-'));
  const store = new TaskStore(join(dir,'weaver.db'));
  let launched = 0;
  const adapter = new RoutingWorkerAdapter(new MockWorkerAdapter(process.execPath, resolve('scripts/mock-worker.mjs')), () => { launched += 1; return successProcess(); }, join(dir, 'agent-state'), id => metadataOf(store).packages.find(pkg => pkg.id === id));
  const manager = new TaskManager(store, adapter);
  const policy = new PolicyStore(join(dir,'weaver.db'));
  const handler = new CommandHandler(manager, policy);
  try {
    const created = handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command: 'tasks.create', args: { title: 'Mock', instruction: 'fixture', owner } });
    const createdId = (created.data as { id: string }).id;
    const spawned = handler.handle({ apiVersion: 'weaver.v1', commandId: randomUUID(), command: 'workers.spawn', args: { taskId: createdId, provider: 'mock-jsonl' } });
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    assert.equal((spawned.data as { dispatch: { execution: string } }).dispatch.execution, 'mock');
    assert.deepEqual((spawned.data as { next?: { action: string; command: string } }).next, { action: 'wait', command: `weaver tasks wait --task-id ${createdId}` });
    assert.equal(launched, 0);
    const deadline = Date.now() + 4000;
    let done = store.get(createdId);
    while (!['completed', 'failed', 'cancelled'].includes(done.status) && Date.now() < deadline) { await new Promise(r => setTimeout(r, 15)); done = store.get(createdId); }
    assert.equal(done.status, 'completed');
    assert.equal(done.run?.adapter, 'mock-jsonl');
    assert.equal('timeoutMs' in done.run!, false);
  } finally { handler.draining = true; await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});


test('oversized complete instructions fail before package admission or launch',async()=>{
 const f=setup(()=>successProcess());try{
  const created=f.raw('tasks.create',{title:'Too large',instruction:'x'.repeat(15500),owner,workspace:f.dir,constraints:['Must not disappear']});
  assert.equal(created.ok,true);
  const dispatched=f.raw('workers.spawn',{taskId:created.data.id,owner:'claude_owner',worker:'codex_worker'});
  assert.equal(dispatched.ok,false);assert.match(dispatched.error.message,/exceeds 16000/);
  const task=f.store.get(created.data.id);assert.equal(task.status,'queued');assert.equal(task.packageId,undefined);assert.equal(task.dispatch,undefined);assert.equal(f.seen.length,0);assert.equal(metadataOf(f.store).packages.length,0);
 }finally{await f.close();}
});

test('requested and observed provider facts survive completion and reload, bounded and separate',async()=>{
 const f=setup(input=>{
  const proc=successProcess();
  return Object.assign(proc,{scopeUnit:'weaver-cli-codex-owned-fixture',evidence:{engine:'codex' as const,requestedModel:input.model,requestedEffort:input.effort,workspace:input.workspace,terminal:'success' as const,vendorModel:'reported-model',vendorSessionId:'session-'+ 'x'.repeat(1000),usage:{inputTokens:12,outputTokens:3}}});
 });try{
  const created=f.raw('tasks.create',{title:'Evidence',instruction:'inspect fixture',owner,workspace:f.dir});
  const spawned=f.raw('workers.spawn',{taskId:created.data.id,owner:'claude_owner',worker:'codex_worker'});assert.equal(spawned.ok,true,JSON.stringify(spawned));
  await new Promise(resolve=>setImmediate(resolve));
  const task=f.store.get(created.data.id);assert.equal(task.status,'completed');assert.equal(task.dispatch?.model,'gpt-6.1-sol');
  assert.equal(task.run?.scopeUnit,'weaver-cli-codex-owned-fixture');assert.equal(task.run?.evidence?.vendorModel,'reported-model');assert.equal(task.run?.evidence?.terminal,'success');assert.equal(task.run?.evidence?.vendorSessionId?.length,512);
  const trace=f.raw('observability.get',{taskId:task.id}).data;assert.equal(trace.run.evidence.vendorModel,'reported-model');assert.equal(trace.run.scopeUnit,task.run?.scopeUnit);
  const reopened=new TaskStore(f.store.path);assert.deepEqual(reopened.get(task.id).run?.evidence,task.run?.evidence);assert.equal(f.raw('tasks.get',{taskId:task.id}).data.run.pid,undefined);
 }finally{await f.close();}
});

function queuedReal(f:ReturnType<typeof setup>) {
 const created=f.raw('tasks.create',{title:'Frozen',instruction:'fixture',owner,workspace:f.dir});
 const task=f.store.get(created.data.id);task.scheduled=true;
 task.dispatch={owner:'codex_owner',worker:'codex_worker',engine:'codex',engineKind:'codex',model:'gpt-6.1-sol',effort:'high',execution:'real',maxParallel:1,maxWaitMinutes:15,adapter:'codex',workspace:realpathSync(f.dir)};
 f.store.put(task);return task;
}

test('queue reasons expose policy and frozen-route blocks without repeated writes or rerouting',async()=>{
 const f=setup(()=>hangProcess());try{
  const task=queuedReal(f);const snapshot=f.policy.snapshot();snapshot.config.owners.codex_owner.worker_weights={codex_worker:0};
  f.policy.save({revision:snapshot.revision,config:snapshot.config,blocks:[]});f.handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));
  const blocked=f.store.get(task.id);assert.equal(blocked.status,'queued');assert.equal(blocked.queueReason?.code,'policy_blocked');assert.match(blocked.queueReason?.message??'',/weight|excluded|eligible|disabled/i);
  const revision=f.store.revision;f.handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.store.revision,revision);
  const restored=f.policy.snapshot();delete restored.config.owners.codex_owner.worker_weights;restored.config.workers.codex_worker.model='changed-model';
  f.policy.save({revision:restored.revision,config:restored.config,blocks:[]});f.handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.store.get(task.id).queueReason?.code,'frozen_route_changed');assert.equal(f.store.get(task.id).dispatch?.model,'gpt-6.1-sol');assert.equal(f.seen.length,0);
  const trace=f.raw('observability.get',{taskId:task.id}).data;assert.equal(trace.stage,'frozen_route_changed');assert.equal(trace.queueReason.code,'frozen_route_changed');
  const reopened=new TaskStore(f.store.path);assert.deepEqual(reopened.get(task.id).queueReason,f.store.get(task.id).queueReason);
 }finally{await f.close();}
});

test('queued engine kind and replaced workspace cannot change frozen execution authority',async()=>{
 const f=setup(()=>hangProcess());try{
  const task=queuedReal(f);const snapshot=f.policy.snapshot();snapshot.config.engines.codex.kind='claude';
  f.policy.save({revision:snapshot.revision,config:snapshot.config,blocks:[]});f.handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.store.get(task.id).queueReason?.code,'frozen_route_changed');assert.equal(f.seen.length,0);
  const restored=f.policy.snapshot();restored.config.engines.codex.kind='codex';f.policy.save({revision:restored.revision,config:restored.config,blocks:[]});
  const canonical=join(f.dir,'project');mkdirSync(canonical);
  const current=f.store.get(task.id);current.dispatch!.workspace=realpathSync(canonical);current.dispatch!.workspaceIdentity=workspaceIdentity(canonical);f.store.put(current);
  renameSync(canonical,canonical+'-old');mkdirSync(canonical);f.handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.store.get(task.id).queueReason?.code,'workspace_changed');assert.match(f.store.get(task.id).queueReason?.message??'',/changed or was replaced/);assert.equal(f.seen.length,0);
  rmSync(canonical,{recursive:true});symlinkSync(canonical+'-old',canonical);f.handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.store.get(task.id).queueReason?.code,'workspace_changed');assert.equal(f.seen.length,0);
 }finally{await f.close();}
});

test('pump never makes an attempted worker runnable again after PID persistence fails',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'weaver-pump-failure-'));
 const store=new TaskStore(join(dir,'weaver.db'));let starts=0;
 const manager=new TaskManager(store,{id:'mock-jsonl',start:()=>{starts++;return hangProcess();}});
 const policy=new PolicyStore(join(dir,'weaver.db'));const handler=new CommandHandler(manager,policy);
 try{
  const task=manager.create({title:'Persistence failure',instruction:'fixture',owner});
  task.scheduled=true;task.dispatch={owner:'codex_owner',worker:'codex_worker',engine:'codex',model:'gpt-6.1-sol',effort:'high',execution:'mock',adapter:'mock-jsonl',maxParallel:1,maxWaitMinutes:15};store.put(task);
  const put=store.put.bind(store);let failOnce=true;
  store.put=current=>{if(current.run?.pid!==undefined&&failOnce){failOnce=false;throw new Error('PID persistence failed');}put(current);};
  handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(starts,1);assert.equal(store.get(task.id).status,'failed');assert.equal(store.get(task.id).scheduled,false);
  handler.pump();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(starts,1);assert.equal(store.get(task.id).run?.status,'stopped');
 }finally{handler.draining=true;await manager.shutdown();rmSync(dir,{recursive:true,force:true});}
});

test('the dispatch response names the owner one next step, never an engine',async()=>{
 const f=setup(()=>hangProcess());
 try{
  const s=f.policy.snapshot();s.config.owners.claude_owner.max_parallel=1;
  f.policy.save({revision:s.revision,config:s.config,blocks:[]});
  const running=f.raw('tasks.create',{title:'Real',instruction:'fixture',owner,workspace:f.dir});
  const spawned=f.raw('workers.spawn',{taskId:running.data.id,owner:'claude_owner',worker:'codex_worker'});
  assert.equal(spawned.ok,true,JSON.stringify(spawned));
  assert.equal(spawned.data.dispatch.execution,'real');
  assert.deepEqual(spawned.data.next,{action:'wait',command:`weaver tasks wait --task-id ${running.data.id}`});
  // Work that has only been admitted to the queue is waited for too.
  const waiting=f.raw('tasks.create',{title:'Held',instruction:'fixture',owner,workspace:f.dir});
  const queued=f.raw('workers.spawn',{taskId:waiting.data.id,owner:'claude_owner',worker:'codex_worker'});
  assert.equal(queued.ok,true,JSON.stringify(queued));
  assert.equal(queued.data.scheduled,true);
  assert.deepEqual(queued.data.next,{action:'wait',command:`weaver tasks wait --task-id ${waiting.data.id}`});
  assert.equal(f.raw('tasks.get',{taskId:queued.data.id}).data.next,undefined);
 }finally{await f.close();}
});

/** One attempt as a finished run leaves it: routed to an engine, terminal, and optionally frozen with a package. */
function attempt(f:ReturnType<typeof setup>,engine:'claude'|'codex',status:'failed'|'cancelled'|'completed'='failed',retryOf?:string,freeze?:{scope:string[];criteria:string[]}):string {
 const created=f.raw('tasks.create',{title:`Attempt on ${engine}`,instruction:'fixture',owner,workspace:f.dir});
 if(freeze)assert.equal(f.raw('packages.create',{taskId:created.data.id,scope:freeze.scope,acceptanceCriteria:freeze.criteria}).ok,true);
 const task=f.store.get(created.data.id);
 task.status=status;
 if(retryOf)task.retryOf=retryOf;
 task.dispatch={owner:'claude_owner',worker:engine==='claude'?'claude_worker':'codex_alt_worker',engine,model:'frozen-model',effort:'high',execution:'real',maxParallel:4,adapter:engine,workspace:realpathSync(f.dir)};
 f.store.put(task);
 return task.id;
}

/** Claude owns this owner, so only a second engine gives dispatch somewhere to move. */
function addCodexWorker(f:ReturnType<typeof setup>):void {
 const s=f.policy.snapshot();
 s.config.workers.codex_alt_worker={enabled:true,engine:'codex',model:'gpt-6.1-sol',effort:'high',description:'Second codex worker for retry routing.'};
 s.config.owners.claude_owner.workers=[...s.config.owners.claude_owner.workers,'codex_alt_worker'];
 f.policy.save({revision:s.revision,config:s.config,blocks:[]});
}

test('a retry routes away from the worker that failed it and dispatches the linked child in one call',async()=>{
 const f=setup(()=>successProcess());
 try{
  addCodexWorker(f);
  const first=attempt(f,'codex','failed',undefined,{scope:['Read fixture.txt','Write fixture.txt only'],criteria:['Verify actual fixture contents']});
  const originalPackage=f.store.get(first).packageId!;
  const retry=f.raw('tasks.retry',{taskId:first});
  assert.equal(retry.ok,true,JSON.stringify(retry));
  // One owner action: the linked child is routed and dispatched by the same command, with no second call.
  assert.equal(retry.data.retryOf,first);
  assert.equal(retry.data.status,'running','tasks.retry dispatches the child it just created');
  assert.deepEqual(retry.data.excludedWorkers,['codex_alt_worker']);
  assert.equal(retry.data.excludedEngines,undefined);
  assert.equal(retry.data.dispatch.engine,'claude');
  assert.equal(retry.data.dispatch.execution,'native');
  assert.equal(f.seen.length,0,'a native handoff launches no process');
  const note=f.store.get(retry.data.id).events.find(e=>e.message.startsWith('Policy selected'))!;
  assert.match(note.message,/workers excluded because they failed earlier in this retry chain/);
  assert.match(note.message,/codex_alt_worker/);
  // The child is frozen with its own package: the original scope and criteria, the chain note, then the original goal.
  assert.notEqual(retry.data.packageId,originalPackage);
  const child=f.raw('packages.get',{packageId:retry.data.packageId}).data;
  assert.equal(child.taskId,retry.data.id);
  assert.deepEqual(child.scope,['Read fixture.txt','Write fixture.txt only']);
  assert.deepEqual(child.acceptanceCriteria,['Verify actual fixture contents']);
  assert.ok(child.instruction.includes(`task ${first.slice(0,8)}`),'the note names the attempt it replaces');
  assert.ok(child.instruction.includes('git diff'),'the note makes the worker read the workspace back first');
  assert.ok(child.instruction.endsWith('\n\nfixture'),'the original instruction is preserved verbatim at the end');
  // The untouched original: its own package, record and route stay exactly as the failed attempt left them.
  assert.equal(f.raw('packages.get',{packageId:originalPackage}).data.instruction,'fixture');
  assert.equal(f.store.get(first).status,'failed');
  assert.equal(f.store.get(first).packageId,originalPackage);
  assert.equal(f.store.get(first).dispatch?.engine,'codex');
  // A native handoff carries the same full instruction a real worker would be launched with.
  assert.equal(retry.data.next.action,'run_subagent');
  assert.equal(retry.data.next.model,'sonnet');
  assert.equal(retry.data.next.effort,'high');
  assert.equal(retry.data.next.then,`weaver workers complete --task-id ${retry.data.id} --input report.json`);
  assert.match(retry.data.next.prompt,/You are a Weaver worker/);
  assert.ok(retry.data.next.prompt.includes('Read fixture.txt'),'the frozen scope reaches the handoff prompt');
  assert.ok(retry.data.next.prompt.includes(child.instruction.slice(0,120)),'the handoff prompt carries the retried goal');
 }finally{await f.close();}
});

test('a completed worker stays on the table while a cancelled worker is closed to the chain',async()=>{
 const f=setup(()=>successProcess());
 try{
  addCodexWorker(f);
  // A completed chain entry is not a failure, so codex stays routable for the next attempt.
  const succeeded=attempt(f,'codex','completed');
  const reuse=f.raw('tasks.create',{title:'Reused',instruction:'fixture',owner,workspace:f.dir});
  const reuseChild=f.store.get(reuse.data.id);reuseChild.retryOf=succeeded;f.store.put(reuseChild);
  const spawned=f.raw('workers.spawn',{taskId:reuseChild.id,owner:'claude_owner',worker:'codex_alt_worker'});
  assert.equal(spawned.ok,true,JSON.stringify(spawned));
  assert.equal(spawned.data.dispatch.engine,'codex');
  assert.equal(spawned.data.excludedWorkers,undefined);
  const launched=f.seen.length;
  // A cancelled chain entry closes its worker to the whole chain, an explicit worker choice included.
  const cancelled=attempt(f,'codex','cancelled');
  const refuse=f.raw('tasks.create',{title:'Refused',instruction:'fixture',owner,workspace:f.dir});
  const refusedChild=f.store.get(refuse.data.id);refusedChild.retryOf=cancelled;f.store.put(refusedChild);
  const rejected=f.raw('workers.spawn',{taskId:refusedChild.id,owner:'claude_owner',worker:'codex_alt_worker'});
  assert.equal(rejected.error?.code,'NO_ALTERNATIVE_WORKER');
  assert.match(rejected.error?.message??'',/^NO_ALTERNATIVE_WORKER/);
  assert.match(rejected.error?.message??'',/codex_alt_worker/);
  assert.equal(f.store.get(refusedChild.id).status,'queued');
  assert.equal(f.store.get(refusedChild.id).dispatch,undefined);
  assert.equal(f.seen.length,launched,'the refused dispatch launches nothing');
 }finally{await f.close();}
});

test('a chain with no worker left is refused by the retry itself before anything is created',async()=>{
 const f=setup(()=>successProcess());
 try{
  addCodexWorker(f);
  const cancelled=attempt(f,'codex','cancelled');
  // Two levels: the chain closes every worker its parent and grandparent ran on.
  const second=attempt(f,'claude','failed',cancelled);
  const tasks=f.store.list().length;const events=f.store.get(second).events.length;
  const blocked=f.raw('tasks.retry',{taskId:second});
  assert.equal(blocked.error?.code,'NO_ALTERNATIVE_WORKER');
  assert.match(blocked.error?.message??'',/^NO_ALTERNATIVE_WORKER/);
  for(const worker of ['claude_worker','codex_alt_worker'])assert.ok(blocked.error?.message?.includes(worker),worker);
  assert.equal(f.store.list().length,tasks,'a retry that cannot route creates no child');
  assert.equal(f.store.get(second).status,'failed');
  assert.equal(f.store.get(second).events.length,events,'the failed attempt is left exactly as it was');
  assert.equal(f.seen.length,0);
  assert.equal(f.mockStarts(),0);
 }finally{await f.close();}
});
