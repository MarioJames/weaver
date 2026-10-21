import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../../src/main/runtime';
import { TaskStore } from '../../src/main/store';
import { PolicyStore } from '../../src/main/policy/store';
import { ImBootstrapBudgetError } from '../../src/main/im/bootstrap';
import { quotaSettings, freeChannelProbeSettings } from '../../src/shared/policy/settings';

function isolatedPolicy(dir: string): void {
 const store = new TaskStore(join(dir, 'weaver.db'));
 try {
  const policy = new PolicyStore(store.db); const saved = policy.snapshot();
  saved.config.quota = { ...quotaSettings(saved.config), auto_refresh: false };
  saved.config.free_channel_probe = { ...freeChannelProbeSettings(saved.config), enabled: false };
  for (const owner of Object.values(saved.config.owners)) owner.enabled = false;
  saved.config.engines.codex = { enabled: true, kind: 'codex' };
  policy.save({ revision: saved.revision, config: saved.config, blocks: [] }, { allowEngineEnable: true });
 } finally { store.close(); }
}

test('真实runtime HTTP 默认禁用、secret保存保留清除/revision、同源guard、无对话任务卡片',async t=>{
 const dir=await mkdtemp(join(tmpdir(), 'r-'));let network=0;
 isolatedPolicy(dir);
 const runtime=await startRuntime({dataDir:dir,im:{parentFactory:async()=>{throw new Error('must not start a model');},channelFactory:()=>{network++;throw new Error('must not connect');}}});
 t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
 async function rpc(method:string,args:unknown[]=[],origin=runtime.url){const response=await fetch(`${runtime.url}/api/rpc`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({method,args})});return {status:response.status,body:await response.json() as any};}
 const initial=await rpc('getImSettings');assert.equal(initial.body.result.config.enabled,false);assert.equal(initial.body.result.status.connection,'disabled');assert.equal(network,0);
 const config={enabled:false,appId:'cli_test',appSecret:'VERY_DISTINCT_IM_SECRET',allowedOpenIds:['ou_test'],engine:'',model:'',effort:'medium',workspaces:[],idleTimeoutMinutes:30};
 const saved=await rpc('saveImSettings',[{expectedRevision:0,config}]);assert.equal(saved.body.result.revision,1);assert.equal(saved.body.result.config.appSecretConfigured,true);assert.ok(!JSON.stringify(saved).includes(config.appSecret));
 const mode=(await stat(`${dir}/im-settings.json`)).mode&0o777;assert.equal(mode,0o600);assert.match(await readFile(`${dir}/im-settings.json`,'utf8'),/VERY_DISTINCT_IM_SECRET/);
 const {appSecret,...keep}=config;void appSecret;
 const retained=await rpc('saveImSettings',[{expectedRevision:1,config:keep}]);assert.equal(retained.body.result.config.appSecretConfigured,true);
 const stale=await rpc('saveImSettings',[{expectedRevision:1,config:keep}]);assert.equal(stale.body.error.code,'IM_SETTINGS_CONFLICT');assert.ok(!JSON.stringify(stale).includes('VERY_DISTINCT_IM_SECRET'));
 const cleared=await rpc('saveImSettings',[{expectedRevision:2,config:{...keep,appSecret:''}}]);assert.equal(cleared.body.result.config.appSecretConfigured,false);
 const reconnected=await rpc('reconnectIm');assert.equal(reconnected.body.result.status.connection,'disabled');assert.equal(network,0);
 assert.deepEqual((await rpc('listTasks')).body.result,[]);assert.equal((await rpc('getImSettings',[],'https://evil.invalid')).status,403);
});
test('HTTP同配置保存不重建通道/父进程，凭据变化才重建', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'r-')); isolatedPolicy(dir);
  let channels = 0; let parents = 0; let closes = 0;
  const runtime = await startRuntime({ dataDir: dir, im: {
    parentFactory: async () => { parents++; return { send: async () => 'ok', close: async () => { closes++; } }; },
    channelFactory: () => { channels++; return { connect: async () => {}, close: async () => {}, send: async () => {}, stream: async () => '', updateCard: async () => {}, retireCard: async () => {}, state: () => 'connected' }; },
  } });
  t.after(async () => { try { await runtime.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  const rpc = async (method: string, args: unknown[] = []) => {
    const response = await fetch(`${runtime.url}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: runtime.url }, body: JSON.stringify({ method, args }) });
    return { status: response.status, body: await response.json() as any };
  };
  const config = { enabled: true, appId: 'cli_test', appSecret: 'RUNTIME_SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30 };
  const first = await rpc('saveImSettings', [{ expectedRevision: 0, config }]);
  assert.equal(first.status, 200); assert.equal(channels, 1); assert.equal(parents, 1);
  const { appSecret, ...keep } = config; void appSecret;
  const noop = await rpc('saveImSettings', [{ expectedRevision: 1, config: keep }]);
  assert.equal(noop.status, 200); assert.equal(channels, 1); assert.equal(parents, 1); assert.equal(closes, 0);
  const secretChange = await rpc('saveImSettings', [{ expectedRevision: 2, config: { ...config, appSecret: 'RUNTIME_SECRET_TWO' } }]);
  assert.equal(secretChange.status, 200); assert.equal(channels, 2); assert.equal(parents, 2); assert.equal(closes, 1);
  assert.ok(!JSON.stringify(secretChange).includes('RUNTIME_SECRET'));
});
test('真实HTTP新engine save路径：pi/opencode可启用，同配置不重建，CAS与secret规则保持', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'r-')); isolatedPolicy(dir);
  {
    const store = new TaskStore(join(dir, 'weaver.db'));
    try {
      const policy = new PolicyStore(store.db); const saved = policy.snapshot();
      saved.config.engines.pi = { enabled: true, kind: 'pi' };
      saved.config.engines.ocode = { enabled: true, kind: 'opencode' };
      policy.save({ revision: saved.revision, config: saved.config, blocks: [] }, { allowEngineEnable: true });
    } finally { store.close(); }
  }
  let parents = 0; let closes = 0; let channels = 0;
  const runtime = await startRuntime({ dataDir: dir, im: {
    parentFactory: async () => { parents++; return { send: async () => 'ok', close: async () => { closes++; } }; },
    channelFactory: () => { channels++; return { connect: async () => {}, close: async () => {}, send: async () => {}, stream: async () => '', updateCard: async () => {}, retireCard: async () => {}, state: () => 'connected' }; },
  } });
  t.after(async () => { try { await runtime.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  const rpc = async (method: string, args: unknown[] = []) => {
    const response = await fetch(`${runtime.url}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: runtime.url }, body: JSON.stringify({ method, args }) });
    return { status: response.status, body: await response.json() as any };
  };
  const config = { enabled: true, appId: 'cli_test', appSecret: 'RUNTIME_PI_SECRET', allowedOpenIds: ['ou_a'], engine: 'pi', model: 'm', effort: 'minimal', workspaces: [dir], idleTimeoutMinutes: 30 };
  const first = await rpc('saveImSettings', [{ expectedRevision: 0, config }]);
  assert.equal(first.status, 200); assert.equal(first.body.result.revision, 1);
  assert.equal(first.body.result.config.engine, 'pi');
  assert.equal(channels, 1); assert.equal(parents, 1);
  assert.ok(!JSON.stringify(first).includes('RUNTIME_PI_SECRET'));
  const { appSecret, ...keep } = config; void appSecret;
  const noop = await rpc('saveImSettings', [{ expectedRevision: 1, config: keep }]);
  assert.equal(noop.status, 200); assert.equal(noop.body.result.revision, 2);
  assert.equal(channels, 1); assert.equal(parents, 1); assert.equal(closes, 0);
  const unknown = await rpc('saveImSettings', [{ expectedRevision: 2, config: { ...keep, engine: 'nope' } }]);
  assert.equal(unknown.status, 400); assert.equal(unknown.body.error.code, 'IM_CONFIG_UNAVAILABLE');
  assert.equal((await rpc('getImSettings')).body.result.revision, 2);
  const stale = await rpc('saveImSettings', [{ expectedRevision: 1, config: keep }]);
  assert.equal(stale.body.error.code, 'IM_SETTINGS_CONFLICT');
  assert.ok(!JSON.stringify(stale).includes('RUNTIME_PI_SECRET'));
  const rotated = await rpc('saveImSettings', [{ expectedRevision: 2, config: { ...config, appSecret: 'RUNTIME_PI_SECRET_TWO' } }]);
  assert.equal(rotated.status, 200); assert.equal(channels, 2); assert.equal(parents, 2); assert.equal(closes, 1);
  const opencode = await rpc('saveImSettings', [{ expectedRevision: 3, config: { ...keep, engine: 'ocode', effort: 'custom-variant' } }]);
  assert.equal(opencode.status, 200); assert.equal(opencode.body.result.config.effort, 'custom-variant');
  assert.equal(channels, 3); assert.equal(parents, 3); assert.equal(closes, 2);
  assert.ok(!JSON.stringify(opencode).includes('RUNTIME_PI_SECRET'));
});
test('IM close 失败仍关闭 HTTP/IPC 并完成 done，不伪装关闭成功',async t=>{
 const dir=await mkdtemp(join(tmpdir(), 'r-'));
 t.after(async()=>{await rm(dir,{recursive:true,force:true});});
 // Enable only the isolated fake transport; no SDK or model connection.
 const {ImSettingsStore}=await import('../../src/main/im/settings'); isolatedPolicy(dir);
 new ImSettingsStore(dir).save({expectedRevision:0,config:{enabled:true,appId:'cli_test',appSecret:'SECRET',allowedOpenIds:['ou_a'],engine:'codex',model:'gpt-test',effort:'medium',workspaces:[dir],idleTimeoutMinutes:30}});
 const runtime=await startRuntime({dataDir:dir,im:{parentFactory:async()=>({send:async()=>'',close:async()=>{}}),channelFactory:()=>({connect:async()=>{},close:async()=>{throw new Error('PRIVATE_VENDOR_ERROR');},send:async()=>{},stream:async()=>'',updateCard:async()=>{},retireCard:async()=>{},state:()=> 'connected'})}});
 await new Promise<void>(resolve=>setImmediate(resolve));
 await assert.rejects(runtime.close(),error=>error instanceof Error&&error.message.includes('IM 操作失败')&&!error.message.includes('PRIVATE_VENDOR_ERROR'));await runtime.done;
 await assert.rejects(fetch(`${runtime.url}/api/rpc`,{method:'POST',headers:{Origin:runtime.url},body:'{}'}));
 const {readdir}=await import('node:fs/promises');
 assert.equal((await readdir(dir)).some(name=>name.endsWith('.sock')),false);
});


test('真实HTTP保存完整bootstrap超预算给固定可操作中文，原配置与revision不变且无私密输入', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'r-')); isolatedPolicy(dir);
 let modelSends = 0; let channelSends = 0;
 const runtime = await startRuntime({ dataDir: dir, im: {
  parentFactory: async () => ({ send: async () => { modelSends++; throw new Error('MODEL_FORBIDDEN'); }, close: async () => {} }),
  channelFactory: (_config, h) => ({ connect: async () => { h.connected(); }, close: async () => {},
   send: async () => { channelSends++; throw new Error('FEISHU_FORBIDDEN'); }, stream: async () => { throw new Error('STREAM_FORBIDDEN'); }, updateCard: async () => {}, retireCard: async () => {}, state: () => 'connected' }),
 } });
 t.after(async () => { try { await runtime.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
 const rpc = async (method: string, args: unknown[] = []) => {
  const response = await fetch(`${runtime.url}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: runtime.url }, body: JSON.stringify({ method, args }) });
  return { status: response.status, body: await response.json() as any };
 };
 const config = { enabled: true, appId: 'cli_test', appSecret: 'DISTINCT_FAKE_BUDGET_SECRET', allowedOpenIds: ['ou_fake'], engine: 'codex', model: 'gpt-test', effort: 'low', workspaces: [dir], idleTimeoutMinutes: 30 };
 const first = await rpc('saveImSettings', [{ expectedRevision: 0, config }]);
 assert.equal(first.status, 200); assert.equal(first.body.result.revision, 1);
 const before = await readFile(join(dir, 'im-settings.json'), 'utf8');
 const nested = join(dir, ...Array.from({ length: 7 }, (_, n) => `${n}-${'q'.repeat(90)}`)); await mkdir(nested, { recursive: true });
 const workspaces = Array.from({ length: 32 }, (_, n) => join(nested, `project-${n}`));
 for (const path of workspaces) { await mkdir(path); assert.ok(path.length <= 2000); }
 const rejected = await rpc('saveImSettings', [{ expectedRevision: 1, config: { ...config, workspaces } }]);
 assert.equal(rejected.status, 400);
 assert.equal(rejected.body.error.code, 'IM_BOOTSTRAP_TOO_LARGE');
 assert.equal(rejected.body.error.message, new ImBootstrapBudgetError().message);
 assert.match(rejected.body.error.message, /减少工作空间/);
 for (const privateValue of [config.appSecret, dir, await realpath(dir), ...workspaces]) assert.equal(JSON.stringify(rejected).includes(privateValue), false);
 assert.equal(await readFile(join(dir, 'im-settings.json'), 'utf8'), before);
 const current = await rpc('getImSettings');
 assert.equal(current.body.result.revision, 1); assert.deepEqual(current.body.result.config.workspaces, [await realpath(dir)]);
 assert.equal(current.body.result.config.effort, 'low'); assert.equal(current.body.result.config.appSecretConfigured, true);
 const stale = await rpc('saveImSettings', [{ expectedRevision: 0, config }]);
 assert.equal(stale.body.error.code, 'IM_SETTINGS_CONFLICT');
 assert.equal(stale.body.error.message, 'IM 操作失败，请检查配置或重新连接。', 'other safe defaults are unchanged');
 assert.equal(modelSends, 0); assert.equal(channelSends, 0);
});
