import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { PolicyStore } from '../../src/main/policy/store';
import { applyQuotaSnapshot, parseQuotaRefresh } from '../../src/main/policy/quota';
import type { EngineQuotaRecord, QuotaWindow } from '../../src/shared/contracts/quota';
import { QuotaProber } from '../../src/main/quota';
import { dbQuotaStore } from '../../src/main/storage/quota-snapshot';
import { migrate } from '../../src/main/migrate';
import { startRuntime, type WeaverRuntime } from '../../src/main/runtime';
import { previewOn } from '../helpers/policy-preview';

const now = Date.parse('2030-01-01T00:00:00Z');
const since = '2029-12-31T00:00:00Z';
const reset = '2030-01-02T00:00:00.000Z';
function window(resetsAt: string | null = reset): QuotaWindow {
  return { id: 'account', label: 'Account', scope: 'account', model: null, usedPercent: 100, remainingPercent: 0, resetsAt, durationMinutes: null, used: null, total: null, remaining: null, unit: 'percent' };
}
function record(patch: Partial<EngineQuotaRecord> = {}): EngineQuotaRecord {
  return { channel: patch.engine ? `default_${patch.engine}` : 'default_codex', engine: 'codex', status: 'exhausted', source: 'codex_usage', checkedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), stale: false, windows: [window()], detail: 'safe fixture', retryAt: null, ...patch };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'bq-'));
  const policy = new PolicyStore(join(dir,'weaver.db'), () => now);
  return { dir, policy, close: () => rm(dir, { recursive: true, force: true }) };
}

test('quota merge preserves manual/model blocks and applies aliases without changing routing config', async () => {
  const f = await fixture();
  try {
    const current = f.policy.snapshot();
    current.config.engines.codex_alias = { kind: 'codex', enabled: true };
    current.config.engines.codex_foreign = { kind: 'codex', enabled: true };
    current.config.channels.alias = {engine:'codex_alias',kind:'subscription',enabled:true,label:'Alias'};
    current.config.channels.foreign = {engine:'codex_foreign',kind:'subscription',enabled:true,label:'Foreign'};
    current.config.owners.codex_owner.worker_weights = { codex_worker: 4 };
    const manual = { engine: 'codex', reason: 'manual', since, by: 'person' };
    const model = { engine: 'codex_alias', model: 'specific', reason: 'model only', since, by: 'external' };
    const foreign = { engine: 'codex_foreign', channel:'foreign', reason: 'other quota source', since, by: 'weaver-quota:claude' };
    const saved = f.policy.save({ revision: current.revision, config: current.config, blocks: [manual, model, foreign] });
    const result = applyQuotaSnapshot(f.policy, { records: [record({channel:'alias'}),record({channel:'foreign'})] }, {}, now);
    assert.equal(result.policyChanged, true);
    assert.deepEqual(result.snapshot.config, saved.config);
    assert.deepEqual(result.snapshot.blocks.slice(0, 3), [manual, model, foreign]);
    assert.deepEqual(result.snapshot.blocks[3], { engine: 'codex_alias', channel:'alias', by: 'weaver-quota:codex', reason: 'Codex account quota exhausted', since: new Date(now).toISOString(), release_at: reset });
    assert.equal(result.snapshot.blocks.filter(block => block.engine === 'codex' && !block.model).length, 1);
    assert.equal(applyQuotaSnapshot(f.policy, { records: [record({channel:'alias'})] }, {}, now).policyChanged, false);
    assert.equal(f.policy.snapshot().revision, saved.revision + 1);
  } finally { await f.close(); }
});

test('only selected fresh available data clears its own source; unknown and stale preserve blocks', async () => {
  const f = await fixture();
  try {
    assert.equal(applyQuotaSnapshot(f.policy, { records: [record({ status: 'unknown' })] }, {}, now).policyChanged, false);
    assert.equal(f.policy.snapshot().revision, 0);
    applyQuotaSnapshot(f.policy, { records: [record(), record({ engine: 'claude' })] }, {}, now);
    const original = f.policy.snapshot();
    for (const patch of [{ status: 'unknown' }, { status: 'error' }, { status: 'unsupported' }, { status: 'unauthenticated' }, { status: 'available', stale: true }] as Partial<EngineQuotaRecord>[]) {
      assert.equal(applyQuotaSnapshot(f.policy, { records: [record(patch)] }, {}, now).policyChanged, false);
    }
    const result = applyQuotaSnapshot(f.policy, { records: [record({ status: 'available' }), record({ engine: 'claude', status: 'available' })] }, { engine: 'codex' }, now);
    assert.deepEqual(result.snapshot.blocks, original.blocks.filter(block => block.engine !== 'codex'));
    assert.equal(result.snapshot.revision, original.revision + 1);
  } finally { await f.close(); }
});

test('release waits for latest exhausted account window, and any unknown reset removes the deadline', async () => {
  const f = await fixture();
  try {
    const pinned = f.policy.snapshot();
    pinned.config.owners.claude_owner.workers = ['claude_worker', 'codex_worker'];
    pinned.config.owners.claude_owner.worker_weights = { claude_worker: 0 };
    f.policy.save({ revision: pinned.revision, config: pinned.config, blocks: [] });
    const latest = '2030-01-04T00:00:00.000Z';
    let result = applyQuotaSnapshot(f.policy, { records: [record({ windows: [window(reset), { ...window(latest), id: 'weekly' }, { ...window('2029-12-31T23:00:00Z'), id: 'expired' }, { ...window(null), id: 'model', scope: 'model' }] })] }, {}, now);
    assert.equal(result.snapshot.blocks[0].release_at, latest);
    const firstSince = result.snapshot.blocks[0].since;
    result = applyQuotaSnapshot(f.policy, { records: [record({ windows: [window(reset), { ...window(null), id: 'weekly' }] })] }, {}, now + 1000);
    assert.equal(result.snapshot.blocks[0].release_at, undefined);
    assert.equal(result.snapshot.blocks[0].since, firstSince);
    assert.equal(applyQuotaSnapshot(f.policy, { records: [record({ windows: [] })] }, {}, now).policyChanged, false);
    assert.equal(result.snapshot.owners.codex_owner.status, 'blocked');
    assert.throws(() => previewOn(f.policy, { owner: 'claude_owner', worker: 'codex_worker' }, now), /blocked/);
    assert.throws(() => previewOn(f.policy, { owner: 'claude_owner' }, now), /no available worker/);
  } finally { await f.close(); }
});

test('expired foreign engine blocks report an atomic conflict while active foreign blocks are preserved', async () => {
  const f = await fixture();
  try {
    const current = f.policy.snapshot();
    const manual = { engine: 'codex', reason: 'manual retained', since, release_at: '2029-12-31T23:59:59Z', by: 'operator' };
    f.policy.save({ revision: current.revision, config: current.config, blocks: [manual] });
    const before = f.policy.snapshot();
    const history = f.policy.history();
    assert.throws(() => applyQuotaSnapshot(f.policy, { records: [record({ engine: 'claude' }), record()] }, {}, now), { code: 'QUOTA_POLICY_CONFLICT' });
    assert.deepEqual(f.policy.snapshot(), before);
    assert.deepEqual(f.policy.history(), history, 'a refused merge records no revision');
    const saved = f.policy.save({ revision: before.revision, config: before.config, blocks: [{ ...manual, release_at: reset }] });
    const retained = applyQuotaSnapshot(f.policy, { records: [record()] }, {}, now);
    assert.equal(retained.policyChanged, false);
    assert.equal(retained.snapshot.revision, saved.revision);
    assert.deepEqual(retained.snapshot.blocks, saved.blocks);
  } finally { await f.close(); }
});

test('refresh input rejects unknown fields, prototype names and non-enumerated engines', () => {
  assert.deepEqual(parseQuotaRefresh({}), {});
  assert.deepEqual(parseQuotaRefresh({ engine: 'grok' }), { engine: 'grok' });
  assert.deepEqual(parseQuotaRefresh({ engine: 'opencode' }), { engine: 'opencode' });
  for (const value of [null, [], 'codex', { engine: null }, { engine: '__proto__' }, { engine: 'constructor' }, { engine: 'toString' }, { url: 'https://example.test' }, JSON.parse('{"__proto__":{}}'), { commandId: 'x' }, { taskId: 'x' }]) {
    assert.throws(() => parseQuotaRefresh(value));
  }
});

const exec = promisify(execFile);
async function cli(dir: string, args: string[]) {
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args, '--data-dir', dir], { timeout: 15_000 });
    return { status: 0, stdout: result.stdout };
  } catch (error) {
    return { status: 1, stdout: (error as { stdout: string }).stdout };
  }
}
async function rpc(runtime: WeaverRuntime, method: string, args: unknown[]) {
  const response = await fetch(`${runtime.url}/api/rpc`, { method: 'POST', headers: { origin: runtime.url, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
  return { status: response.status, json: await response.json() as any };
}
async function nativeFixture(dir: string) {
  const home = join(dir, 'home');
  const codex = join(home, '.codex');
  await mkdir(codex, { recursive: true });
  const payload = Buffer.from(JSON.stringify({ exp: Date.parse('2100-01-01') / 1000 })).toString('base64url');
  await writeFile(join(codex, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `e30.${payload}.fixture`, account_id: 'fixture-account' } }));
  return { HOME: home, CODEX_HOME: codex };
}
function usage(percent: number) {
  return Response.json({ rate_limit: { allowed: percent < 100, limit_reached: percent >= 100, primary_window: { used_percent: percent, reset_at: Date.parse(reset) / 1000, limit_window_seconds: 3600 } }, credits: { has_credits: false, unlimited: false, balance: '0' } });
}

/** Real native fixture identity scoped to the channel selected by the RPC. */
function channelProber(dir:string,options:ConstructorParameters<typeof QuotaProber>[0]):QuotaProber {
 const db=new DatabaseSync(join(dir,'weaver.db'));const config=new PolicyStore(db).snapshot().config;db.close();
 const env=options?.env??{};const home=env.HOME!;
 const roots:Record<string,string>={codex:env.CODEX_HOME??join(home,'.codex'),claude:env.CLAUDE_CONFIG_DIR??join(home,'.claude'),grok:env.GROK_HOME??join(home,'.grok')};
 return new QuotaProber({...options,root:join(dir,'quota-state'),channels:()=>Object.fromEntries(Object.entries(config.channels).filter(([,channel])=>channel.engine in roots).map(([id,channel])=>[id,{channel,engineKind:config.engines[channel.engine].kind,secret:{authDir:roots[channel.engine]}}]))});
}
async function refreshAccounts(runtime:WeaverRuntime){await rpc(runtime,'refreshQuota',[{channel:'default_codex'}]);return rpc(runtime,'refreshQuota',[{channel:'default_claude'}]);}

test('public CLI supports optional input and all output formats; HTTP shares strict quota validation', async () => {
  const f = await fixture();
  let runtime: WeaverRuntime | undefined;
  let requests = 0;
  try {
    const env = await nativeFixture(f.dir);
    const quotaProber = new QuotaProber({ env, now: () => new Date(now), fetch: async () => { requests++; return usage(100); } });
    runtime = await startRuntime({ dataDir: f.dir, port: 0, open: false, quotaProber });
    const initial = await cli(f.dir, ['quota', 'get']);
    assert.equal(initial.status, 0, initial.stdout);
    const initialData = JSON.parse(initial.stdout).data;
    assert.equal(initialData.records.length, 4);
    assert.ok(initialData.records.every((item: EngineQuotaRecord) => item.status === 'unknown' && item.checkedAt === null));
    assert.equal(requests, 0);
    const caps = JSON.parse((await cli(f.dir, ['capabilities'])).stdout).data;
    assert.equal(caps.quota.get.rpc, 'getQuota');
    assert.equal(caps.quota.refresh.updatesPolicyBlocks, false);
    for (const output of ['json', 'jsonl', 'text']) {
      const result = await cli(f.dir, ['quota', 'refresh', '--output', output]);
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.stdout.trim().split('\n').length, 1);
      if (output !== 'text') {
        const data = JSON.parse(result.stdout).data;
        assert.equal(data.records.find((item: EngineQuotaRecord) => item.engine === 'codex').status, 'exhausted');
        assert.deepEqual(data.snapshot.blocks, []);
        assert.equal(data.policyChanged, false);
      }
    }
    assert.equal(requests, 1, 'cached refreshes do not cause more native HTTP requests');
    const refreshInput = join(f.dir, 'refresh.json');
    await writeFile(refreshInput, JSON.stringify({ engine: 'codex' }));
    const selected = await cli(f.dir, ['quota', 'refresh', '--input', refreshInput]);
    assert.equal(selected.status, 0, selected.stdout);
    assert.equal(JSON.parse(selected.stdout).data.policyChanged, false);
    const read = await rpc(runtime, 'getQuota', []);
    assert.equal(read.status, 200);
    assert.equal(read.json.result.records[0].status, 'exhausted');
    for (const input of [{ engine: '__proto__' }, { engine: 'constructor' }, { url: 'https://example.test' }, { engine: 'codex', taskId: 'x' }, { commandId: 'x' }, null, []]) {
      const invalid = await rpc(runtime, 'refreshQuota', [input]);
      assert.equal(invalid.status, 400);
      assert.equal(invalid.json.error.code, 'INVALID_REQUEST');
    }
    assert.equal((await rpc(runtime, 'refreshQuota', [])).status, 400);
    for (const flag of ['--task-id', '--command-id']) {
      const invalid = await cli(f.dir, ['quota', 'refresh', flag, 'forbidden']);
      assert.equal(invalid.status, 1);
      assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_ARGUMENT');
    }
    const help = JSON.parse((await cli(f.dir, ['quota', 'refresh', '--help', '--output', 'json'])).stdout).data;
    assert.equal(help.mutation, true);
    assert.match(help.inputFields.notes, /policy blocks/);
    assert.match(help.inputFields.notes, /commandId/);
    const required = await cli(f.dir, ['policy', 'save']);
    assert.equal(required.status, 1);
    assert.match(JSON.parse(required.stdout).error.message, /requires --input/);
  } finally { await runtime?.close(); await f.close(); }
});

test('a completed probe merges into latest saved config and preserves newly added manual blocks', async () => {
  const f = await fixture();
  let runtime: WeaverRuntime | undefined;
  let release!: () => void;
  let entered!: () => void;
  const fetching = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise<void>(resolve => { release = resolve; });
  try {
    const env = await nativeFixture(f.dir);
    runtime = await startRuntime({ dataDir: f.dir, port: 0, open: false, quotaProber: channelProber(f.dir,{ env, now: () => new Date(now), fetch: async () => { entered(); await response; return usage(100); } }) });
    const refresh = rpc(runtime, 'refreshQuota', [{ engine: 'codex',channel:'default_codex' }]);
    await fetching;
    const current = (await rpc(runtime, 'getPolicy', [])).json.result;
    current.config.owners.codex_owner.model = 'preserve-concurrent-edit';
    const manual = { engine: 'claude', reason: 'manual during refresh', since, by: 'operator' };
    const saved = await rpc(runtime, 'savePolicy', [{ revision: current.revision, config: current.config, blocks: [manual] }]);
    assert.equal(saved.status, 200);
    release();
    const result = await refresh;
    assert.equal(result.status, 200);
    assert.equal(result.json.result.snapshot.config.owners.codex_owner.model, 'preserve-concurrent-edit');
    assert.deepEqual(result.json.result.snapshot.blocks[0], manual);
    assert.equal(result.json.result.snapshot.blocks[1].by, 'weaver-quota:codex');
    assert.equal(result.json.result.snapshot.revision, saved.json.result.revision + 1);
    const persisted = new PolicyStore(join(f.dir, 'weaver.db')).snapshot();
    assert.deepEqual(persisted.blocks, result.json.result.snapshot.blocks);
    assert.equal(persisted.revision, result.json.result.snapshot.revision, 'the database holds the merged revision');
  } finally { release(); await runtime?.close(); await f.close(); }
});

test('shutdown aborts a pending native request and prevents late policy writes', async () => {
  const f = await fixture();
  let runtime: WeaverRuntime | undefined;
  let entered!: () => void;
  let aborted = false;
  const fetching = new Promise<void>(resolve => { entered = resolve; });
  try {
    const env = await nativeFixture(f.dir);
    runtime = await startRuntime({ dataDir: f.dir, port: 0, open: false, quotaProber: channelProber(f.dir,{ env, fetch: async (_url, init) => {
      entered();
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('fixture abort')); }, { once: true }));
    } }) });
    const refresh = rpc(runtime, 'refreshQuota', [{ engine: 'codex',channel:'default_codex' }]);
    await fetching;
    await runtime.close();
    assert.equal(aborted, true);
    const response = await refresh;
    assert.equal(response.status, 503);
    assert.equal(response.json.error.code, 'APP_DRAINING');
    assert.deepEqual(new PolicyStore(join(f.dir, 'weaver.db')).history(), [], 'no policy revision was written after shutdown');
  } finally { await runtime?.close(); await f.close(); }
});

test('persistence failure is explicit and leaves the in-memory policy unchanged', async () => {
  const f = await fixture();
  let runtime: WeaverRuntime | undefined;
  try {
    const env = await nativeFixture(f.dir);
    runtime = await startRuntime({ dataDir: f.dir, port: 0, open: false, quotaProber: channelProber(f.dir,{ env, now: () => new Date(now), fetch: async () => usage(100) }) });
    const saboteur = new DatabaseSync(join(f.dir, 'weaver.db'));
    saboteur.exec("CREATE TRIGGER refuse_policy BEFORE INSERT ON policy_revisions BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    saboteur.close();
    const failed = await rpc(runtime, 'refreshQuota', [{ engine: 'codex',channel:'default_codex' }]);
    assert.equal(failed.status, 500);
    assert.equal(failed.json.error.code, 'PERSISTENCE_ERROR');
    assert.match(failed.json.error.message, /could not be saved/);
    const policy = (await rpc(runtime, 'getPolicy', [])).json.result;
    assert.equal(policy.revision, 0);
    assert.deepEqual(policy.blocks, []);
  } finally { await runtime?.close(); await f.close(); }
});

test('expired manual conflict reaches HTTP and CLI without overwriting the manual policy', async () => {
  const f = await fixture();
  let runtime: WeaverRuntime | undefined;
  try {
    const env = await nativeFixture(f.dir);
    const policy = new PolicyStore(join(f.dir, 'weaver.db'));
    const current = policy.snapshot();
    const before = policy.save({ revision: current.revision, config: current.config, blocks: [{ engine: 'codex', reason: 'expired manual retained', since: '2020-01-01T00:00:00Z', release_at: '2021-01-01T00:00:00Z' }] });
    const bytes = JSON.stringify(new PolicyStore(policy.path).snapshot());
    runtime = await startRuntime({ dataDir: f.dir, port: 0, open: false, quotaProber: channelProber(f.dir,{ env, now: () => new Date(now), fetch: async () => usage(100) }) });
    const conflict = await rpc(runtime, 'refreshQuota', [{ engine: 'codex',channel:'default_codex' }]);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'QUOTA_POLICY_CONFLICT');
    const fromCli = await cli(f.dir, ['quota', 'refresh']);
    assert.equal(fromCli.status, 0);
    assert.equal(JSON.parse(fromCli.stdout).data.policyChanged,false);
    assert.deepEqual((await rpc(runtime, 'getPolicy', [])).json.result, before);
    assert.equal(JSON.stringify(new PolicyStore(policy.path).snapshot()), bytes, 'the stored policy did not change');
  } finally { await runtime?.close(); await f.close(); }
});

test('live exhausted windows survive an older reset and allowance until official windows recover, clearing only their own quota blocks', async () => {
  const f = await fixture();
  let runtime: WeaverRuntime | undefined;
  let clock = Date.now();
  const expiredReset = Math.floor((clock - 60_000) / 1000);
  const futureReset = Math.floor((clock + 3_600_000) / 1000);
  const futureResetIso = new Date(futureReset * 1000).toISOString();
  let allowance = false;
  let recovered = false;
  const requests = { codex: 0, claude: 0 };
  try {
    const env = await nativeFixture(f.dir);
    await mkdir(join(env.HOME, '.claude'));
    await writeFile(join(env.HOME, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-claude', expiresAt: Date.parse('2100-01-01') } }));
    const quotaProber = channelProber(f.dir,{ env, now: () => new Date(clock), fetch: async url => {
      if (String(url).includes('anthropic.com')) {
        requests.claude++;
        return Response.json({
          five_hour: { utilization: recovered ? 25 : 100, resets_at: recovered ? futureResetIso : new Date(expiredReset * 1000).toISOString() },
          seven_day: { utilization: recovered ? 50 : 100, resets_at: futureResetIso },
          extra_usage: allowance ? { is_enabled: true, monthly_limit: 100, used_credits: 1 } : { is_enabled: false },
        });
      }
      requests.codex++;
      return Response.json({
        rate_limit: { allowed: allowance, limit_reached: !allowance,
          primary_window: { used_percent: recovered ? 25 : 100, reset_at: recovered ? futureReset : expiredReset, limit_window_seconds: 18000 },
          secondary_window: { used_percent: recovered ? 50 : 100, reset_at: futureReset, limit_window_seconds: 604800 } },
        credits: { has_credits: allowance, unlimited: false, balance: allowance ? '99' : '0' },
      });
    } });
    runtime = await startRuntime({ dataDir: f.dir, port: 0, open: false, quotaProber });
    const accounts = (records: EngineQuotaRecord[]) => records.filter(item => item.engine === 'codex' || item.engine === 'claude');
    const assertPublished = async (result: any) => {
      const read = await rpc(runtime!, 'getQuota', []);
      assert.equal(read.status, 200);
      assert.deepEqual(accounts(read.json.result.records), accounts(result.records), 'HTTP reads publish the latest observations');
      const policy = await rpc(runtime!, 'getPolicy', []);
      assert.equal(policy.status, 200);
      assert.deepEqual(policy.json.result.blocks, result.snapshot.blocks);
      const persisted = new PolicyStore(join(f.dir, 'weaver.db')).snapshot();
      assert.deepEqual(persisted.blocks, result.snapshot.blocks, 'the database retains the exact block set');
      assert.equal(persisted.revision, result.snapshot.revision);
    };

    // An elapsed short-window reset cannot erase a still-full weekly window.
    const exhausted = await refreshAccounts(runtime);
    assert.equal(exhausted.status, 200);
    assert.deepEqual(requests, { codex: 1, claude: 1 });
    assert.deepEqual(accounts(exhausted.json.result.records).map(item => item.status), ['exhausted', 'exhausted']);
    for (const item of accounts(exhausted.json.result.records)) {
      assert.equal(item.stale, false);
      assert.ok(item.windows.some(window => window.usedPercent === 100 && window.resetsAt === futureResetIso));
    }
    const quotaBlocks = exhausted.json.result.snapshot.blocks;
    assert.equal(quotaBlocks.length, 2);
    assert.deepEqual(quotaBlocks.map((block: { by: string }) => block.by).sort(), ['weaver-quota:claude', 'weaver-quota:codex']);
    assert.equal(quotaBlocks.find((block: { engine: string }) => block.engine === 'codex').release_at, futureResetIso);
    await assertPublished(exhausted.json.result);

    const retained = [
      { engine: 'codex', channel: 'default_codex', model: 'manual-fixture', reason: 'manual retained', since, by: 'operator' },
      { engine: 'grok', channel: 'default_grok', reason: 'other engine quota retained', since, by: 'weaver-quota:grok' },
      { engine: 'codex', channel: 'default_codex', model: 'vendor-fixture', reason: 'vendor restriction retained', since, by: 'vendor-fixture' },
    ];
    const current = (await rpc(runtime, 'getPolicy', [])).json.result;
    const saved = await rpc(runtime, 'savePolicy', [{ revision: current.revision, config: current.config, blocks: [...quotaBlocks, ...retained] }]);
    assert.equal(saved.status, 200);

    // Allowance and credits change, but the official windows remain at 100%.
    allowance = true;
    clock += 60_001;
    const allowed = await refreshAccounts(runtime);
    assert.equal(allowed.status, 200);
    assert.deepEqual(requests, { codex: 2, claude: 2 }, 'both providers are probed again after pacing');
    assert.deepEqual(accounts(allowed.json.result.records).map(item => item.status), ['exhausted', 'exhausted']);
    assert.ok(accounts(allowed.json.result.records).every(item => !item.stale && item.checkedAt === new Date(clock).toISOString()));
    assert.equal(allowed.json.result.policyChanged, false);
    assert.equal(allowed.json.result.snapshot.revision, saved.json.result.revision);
    assert.deepEqual(allowed.json.result.snapshot.blocks, [...quotaBlocks, ...retained]);
    await assertPublished(allowed.json.result);

    // Recovery requires new official readings below 100%, with valid future resets.
    recovered = true;
    clock += 60_001;
    const codexRestored = await rpc(runtime, 'refreshQuota', [{ channel: 'default_codex' }]);
    assert.equal(codexRestored.status, 200);
    assert.deepEqual(requests, { codex: 3, claude: 2 });
    assert.deepEqual(codexRestored.json.result.snapshot.blocks, [...quotaBlocks.filter((block: { engine: string }) => block.engine === 'claude'), ...retained], 'Codex recovery preserves the Claude quota block');
    await assertPublished(codexRestored.json.result);
    const restored = await rpc(runtime, 'refreshQuota', [{ channel: 'default_claude' }]);
    assert.equal(restored.status, 200);
    assert.deepEqual(requests, { codex: 3, claude: 3 });
    assert.deepEqual(accounts(restored.json.result.records).map(item => item.status), ['available', 'available']);
    for (const item of accounts(restored.json.result.records)) {
      assert.equal(item.stale, false);
      assert.equal(item.checkedAt, new Date(clock).toISOString());
      const included = item.windows.filter(window => window.unit === 'percent');
      assert.ok(included.length >= 2);
      assert.ok(included.every(window => window.usedPercent !== null && window.usedPercent < 100 && window.resetsAt !== null && Date.parse(window.resetsAt) > clock));
    }
    assert.equal(restored.json.result.policyChanged, true);
    assert.deepEqual(restored.json.result.snapshot.blocks, retained, 'only each recovered provider’s own channel quota block is removed');
    await assertPublished(restored.json.result);
  } finally { await runtime?.close(); await f.close(); }
});

test('refresh blocks the existing queue without cancelling its explicit mock fixture run or changing its frozen route', async () => {
  const f = await fixture();
  let runtime: WeaverRuntime | undefined;
  try {
    const env = await nativeFixture(f.dir);
    const policy = new PolicyStore(join(f.dir, 'weaver.db'));
    const current = policy.snapshot();
    current.config.owners.codex_owner.max_parallel = 1;
    policy.save({ revision: current.revision, config: current.config, blocks: [] });
    const workerScript = join(f.dir, 'mock-hang.mjs');
    await writeFile(workerScript, 'process.stdin.resume(); setInterval(() => {}, 1000);');
    runtime = await startRuntime({ dataDir: f.dir, port: 0, open: false, workerScript, quotaProber: channelProber(f.dir,{ env, now: () => new Date(now), fetch: async () => usage(100) }) });
    let id = 0;
    const command = async (command: string, args: Record<string, unknown>) => {
      const result = await rpc(runtime!, 'command', [{ apiVersion: 'weaver.v1', commandId: `quota-fixture-${++id}`, command, args }]);
      assert.equal(result.json.result.ok, true, JSON.stringify(result.json));
      return result.json.result.data;
    };
    const first = await command('tasks.create', { title: 'Running fixture', instruction: 'Explicit mock only', ownerProfileId: 'codex_owner' });
    const second = await command('tasks.create', { title: 'Queued fixture', instruction: 'Explicit mock only', ownerId: first.ownerId });
    await command('workers.spawn', { taskId: first.id, owner: 'codex_owner', worker: 'codex_worker', provider: 'mock-jsonl' });
    const queued = await command('workers.spawn', { taskId: second.id, owner: 'codex_owner', worker: 'codex_worker', provider: 'mock-jsonl' });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.queueReason.code, 'waiting_for_capacity');
    assert.equal((await rpc(runtime, 'refreshQuota', [{ engine: 'codex',channel:'default_codex' }])).status, 200);
    const blocked = await command('tasks.get', { taskId: second.id });
    assert.equal(blocked.status, 'queued');
    assert.equal(blocked.queueReason.code, 'policy_blocked');
    assert.deepEqual(blocked.dispatch, queued.dispatch);
    assert.equal((await command('tasks.get', { taskId: first.id })).status, 'running');
  } finally { await runtime?.close(); await f.close(); }
});

test('fresh global restriction with expired included windows blocks without an invented release deadline', async () => {
  const f = await fixture();
  let runtime: WeaverRuntime | undefined;
  try {
    const env = await nativeFixture(f.dir);
    const clock = Date.now();
    const quotaProber = channelProber(f.dir,{ env, now: () => new Date(clock), fetch: async () => Response.json({
      rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: Math.floor(clock / 1000) - 60 }, secondary_window: { used_percent: 100, reset_at: Math.floor(clock / 1000) + 3600 } },
      credits: { has_credits: false, unlimited: false, balance: '0' }, spend_control: { reached: true },
    }) });
    runtime = await startRuntime({ dataDir: f.dir, port: 0, open: false, quotaProber });
    const result = await rpc(runtime, 'refreshQuota', [{ engine: 'codex',channel:'default_codex' }]);
    assert.equal(result.status, 200);
    const data = result.json.result;
    assert.equal(data.policyChanged, true);
    assert.equal(data.records.find((item:EngineQuotaRecord)=>item.channel==='default_codex').stale,false);
    assert.equal(data.snapshot.blocks[0].release_at, undefined);
    assert.equal(data.snapshot.owners.codex_owner.status, 'blocked');
  } finally { await runtime?.close(); await f.close(); }
});

test('an expired but renewable native token keeps the last published reading instead of reporting a logout over HTTP', async () => {
  const f = await fixture();
  let runtime: WeaverRuntime | undefined;
  let clock = now; let requests = 0;
  try {
    const home = join(f.dir, 'home');
    const codexHome = join(home, '.codex');
    await mkdir(codexHome, { recursive: true });
    const file = join(codexHome, 'auth.json');
    const session = (exp: number, renewable: boolean) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.fixture`, account_id: 'fixture-account', ...(renewable ? { refresh_token: 'never-send' } : {}) } });
    await writeFile(file, session(Date.parse('2100-01-01') / 1000, true));
    const quotaProber = channelProber(f.dir,{ env: { HOME: home, CODEX_HOME: codexHome }, now: () => new Date(clock), fetch: async () => { requests++; return usage(100); } });
    runtime = await startRuntime({ dataDir: f.dir, port: 0, open: false, quotaProber });
    const exhausted = await rpc(runtime, 'refreshQuota', [{ engine: 'codex',channel:'default_codex' }]);
    assert.equal(exhausted.status, 200);
    assert.equal(exhausted.json.result.snapshot.blocks.length, 1);
    await writeFile(file, session(Math.floor(clock / 1000) - 1, true));
    clock += 60_001;
    const pending = await rpc(runtime, 'refreshQuota', [{ engine: 'codex',channel:'default_codex' }]);
    assert.equal(pending.status, 200);
    assert.equal(requests, 1, 'an expired token the native CLI can renew must never reach the quota API');
    const record = pending.json.result.records.find((item: EngineQuotaRecord) => item.engine === 'codex');
    assert.equal(record.status, 'exhausted');
    assert.equal(record.stale, true);
    assert.equal(record.observedAt, new Date(now).toISOString());
    assert.deepEqual(pending.json.result.snapshot.blocks, exhausted.json.result.snapshot.blocks, 'a stale kept reading neither adds nor removes a dispatch block');
    assert.doesNotMatch(JSON.stringify(pending.json.result), /登录|never-send/);
    await writeFile(file, session(Math.floor(clock / 1000) - 1, false));
    clock += 60_001;
    const logout = await rpc(runtime, 'refreshQuota', [{ engine: 'codex',channel:'default_codex' }]);
    assert.equal(logout.json.result.records.find((item: EngineQuotaRecord) => item.engine === 'codex').status, 'unauthenticated');
    assert.match(JSON.stringify(logout.json.result.records), /登录/);
  } finally { await runtime?.close(); await f.close(); }
});

test('an OpenCode observation persists across restarts and manual refresh reuses the same prober', async () => {
  const f = await fixture();
  try {
    const home = join(f.dir, 'home');
    await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true });
    await writeFile(join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'persist-secret' } }));
    const usage = { usage: { rolling: { status: 'ok', percent: 1, resetsAt: reset }, weekly: { status: 'ok', percent: 25, resetsAt: reset }, monthly: { status: 'ok', percent: 29, resetsAt: reset } } };
    const db = new DatabaseSync(join(f.dir, 'weaver.db'));
    migrate(db);
    let requests = 0;
    const first = new QuotaProber({ env: { HOME: home }, now: () => new Date(now), fetch: async () => { requests += 1; return Response.json(usage); }, snapshotStore: dbQuotaStore(db) });
    const probed = await first.refresh({ engine: 'opencode' });
    await first.close();
    assert.equal(requests, 1);
    const live = probed.records.find(item => item.engine === 'opencode')!;
    assert.equal(live.status, 'available');
    assert.deepEqual(live.windows.map(item => item.id), ['opencode:rolling', 'opencode:weekly', 'opencode:monthly']);
    assert.doesNotMatch(JSON.stringify(live), /persist-secret/);
    let afterRestart = 0;
    const second = new QuotaProber({ env: { HOME: home }, now: () => new Date(now), fetch: async () => { afterRestart += 1; return Response.json(usage); }, snapshotStore: dbQuotaStore(db) });
    const restored = second.get().records.find(item => item.engine === 'opencode')!;
    assert.equal(afterRestart, 0, 'reading the stored snapshot costs no request');
    assert.equal(restored.status, 'available');
    assert.deepEqual(restored.windows, live.windows);
    // The same prober serves a manual refresh and the scheduled targets without a new API.
    assert.deepEqual((await second.refresh({ engine: 'opencode' })).records.find(item => item.engine === 'opencode')!.status, 'available');
    await second.close();
    db.close();
  } finally { await f.close(); }
});

test('the quota snapshot is stored in weaver.db and a restarted prober reads it before probing anything', async () => {
  const f = await fixture();
  try {
    const env = await nativeFixture(f.dir);
    const db = new DatabaseSync(join(f.dir, 'weaver.db'));
    migrate(db);
    let requests = 0;
    const first = new QuotaProber({ env, now: () => new Date(now), fetch: async () => { requests += 1; return usage(100); }, snapshotStore: dbQuotaStore(db) });
    const probed = await first.refresh({ engine: 'codex' });
    await first.close();
    assert.equal(requests, 1);
    const live = probed.records.find(item => item.engine === 'codex')!;
    assert.equal(live.status, 'exhausted');
    assert.equal(Number((db.prepare('SELECT count(*) AS n FROM quota_records').get() as { n: number }).n) > 0, true, 'one row per observed engine');
    let afterRestart = 0;
    const second = new QuotaProber({ env, now: () => new Date(now), fetch: async () => { afterRestart += 1; return usage(0); }, snapshotStore: dbQuotaStore(db) });
    const restored = second.get().records.find(item => item.engine === 'codex')!;
    assert.equal(afterRestart, 0, 'reading the stored snapshot costs no request');
    assert.equal(restored.status, 'exhausted');
    assert.equal(restored.checkedAt, live.checkedAt);
    assert.deepEqual(restored.windows, live.windows);
    await second.close();
    db.close();
  } finally { await f.close(); }
});
