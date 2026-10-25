import assert from 'node:assert/strict';
import test from 'node:test';
import type { Block, Config } from '../../src/shared/contracts/policy';
import { QUOTA_FRESH_MS, type EngineQuotaRecord, type QuotaWindow } from '../../src/shared/contracts/quota';
import { ChannelSelectionError, selectWorkerChannel, workerChannelCandidates, type ChannelRoutingContext } from '../../src/main/policy/worker-channel-routing';

const now = Date.parse('2026-10-25T12:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
function config(ids = ['a', 'b', 'c']): Config {
  return { version: 1, engines: { native: { enabled: true, kind: 'codex' } },
    channels: Object.fromEntries(ids.map(id => [id, { engine: 'native', label: id, enabled: true, kind: 'subscription' }])),
    workers: { w: { channels: ids, enabled: true, model: 'gpt-5', effort: 'high' } }, owners: {}, herdr: { max_wait_minutes: 1 } };
}
function window(patch: Partial<QuotaWindow> = {}): QuotaWindow {
  return { id: 'account', label: 'account', scope: 'account', model: null, usedPercent: 10, remainingPercent: 90,
    resetsAt: iso(60_000), durationMinutes: 60, used: null, total: null, remaining: null, unit: 'percent', ...patch };
}
function quota(channel: string, patch: Partial<EngineQuotaRecord> = {}): EngineQuotaRecord {
  return { channel, engine: 'codex', source: 'codex_usage', status: 'available', stale: false, checkedAt: iso(), observedAt: iso(),
    windows: [window()], detail: 'private vendor response', retryAt: null, ...patch };
}
function context(records = ['a', 'b', 'c'].map(id => quota(id))): ChannelRoutingContext {
  return { now, quotas: records, credentialsReady: () => true };
}
function failure(run: () => unknown): ChannelSelectionError {
  try { run(); assert.fail('selection should fail'); } catch (error) {
    assert.ok(error instanceof ChannelSelectionError);
    assert.equal(error.code, 'NO_ELIGIBLE_CHANNEL');
    assert.doesNotMatch(JSON.stringify(error), /private vendor response|private block reason/);
    return error;
  }
}

test('mixed quota states admit only available accounts and random receives eligible count, with every index reachable', () => {
  const c = config(['a','b','c','d','e','f','g','h']);
  const ctx = context([quota('a', {status:'unknown'}), quota('b'), quota('c', {status:'exhausted'}), quota('d', {status:'error'}),
    quota('e', {status:'unauthenticated'}), quota('f', {status:'unsupported'}), quota('g'), quota('h', {stale:true})]);
  assert.deepEqual(workerChannelCandidates(c, [], 'w', ctx).filter(x => x.eligible).map(x => x.channel), ['b','g']);
  for (const [index, expected] of ['b','g'].entries()) {
    assert.equal(selectWorkerChannel(c, [], 'w', {...ctx, pickIndex: n => {assert.equal(n, 2); return index;}}), expected);
  }
  for (const index of [-1, 2, 0.5, NaN, Infinity]) assert.throws(() => selectWorkerChannel(c, [], 'w', {...ctx, pickIndex: () => index}), /INVALID_PICK_INDEX/);
});

test('missing, stale, invalid, future observations and wrong binding/source never prove eligibility', () => {
  const patches: Partial<EngineQuotaRecord>[] = [
    {stale:true}, {observedAt:iso(-QUOTA_FRESH_MS)}, {observedAt:null}, {observedAt:'invalid'}, {observedAt:iso(1)},
    {checkedAt:null}, {checkedAt:'invalid'}, {checkedAt:iso(1)}, {channel:'someone_else'}, {engine:'claude'}, {source:'fixture'},
  ];
  for (const patch of patches) {
    const error = failure(() => selectWorkerChannel(config(['a','b']), [], 'w', context([quota('a',patch)])));
    assert.equal(error.candidates.length, 2);
    assert.ok(error.candidates.every(x => !x.eligible));
  }
  failure(() => selectWorkerChannel(config(), [], 'w'));
  failure(() => selectWorkerChannel(config(), [], 'w', {...context(), credentialsReady:undefined}));
  failure(() => selectWorkerChannel(config(), [], 'missing', context()));
  failure(() => selectWorkerChannel(config(), [], 'w', {...context(),now:NaN}));
});

test('any expired account window needs refresh and another live full window still blocks', () => {
  const expired = window({resetsAt:iso()});
  for (const windows of [[expired], [expired,window()], [expired,window({usedPercent:100})]]) {
    failure(() => selectWorkerChannel(config(['a','b']), [], 'w', context([quota('a',{windows})])));
  }
  const candidates = workerChannelCandidates(config(['a','b']), [], 'w', context([quota('a',{windows:[expired,window({usedPercent:100})]})]));
  assert.equal(candidates[0]!.reason, 'QUOTA_WINDOW_EXHAUSTED');
});

test('each applicable 5h/week/month hard cap overrides available status and extra balance for pools and single accounts', () => {
  for (const durationMinutes of [300,10080,43200]) for (const cap of [
    {usedPercent:100}, {usedPercent:120}, {remainingPercent:0}, {remaining:0}, {used:10,total:10},
  ]) for (const ids of [['a'],['a','b']]) {
    const windows = [300,10080,43200].map(duration => window({durationMinutes:duration,...(duration === durationMinutes ? cap : {})}));
    windows.push(window({unit:'credits',remaining:100}));
    const error = failure(() => selectWorkerChannel(config(ids), [], 'w', context([quota('a',{windows})])));
    assert.match(error.message, /窗口.*耗尽/);
    assert.doesNotMatch(error.message, /NO_ELIGIBLE|QUOTA_/);
  }
});

test('all hard windows passing leaves both accounts reachable with one equal-probability draw', () => {
  const records = ['a','b'].map(channel => quota(channel,{windows:[300,10080,43200].map(durationMinutes => window({durationMinutes}))}));
  for (const index of [0,1]) {
    let draws=0;
    const selected=selectWorkerChannel(config(['a','b']), [], 'w', {...context(records),pickIndex:length=>{draws++;assert.equal(length,2);return index;}});
    assert.equal(selected,['a','b'][index]);
    assert.equal(draws,1);
  }
});

test('only exact current model windows constrain a model; unknown scopes cannot invent exhaustion', () => {
  for (const ids of [['a'],['a','b']]) {
    const c = config(ids);
    for (const patch of [{scope:'model' as const,model:'other'}, {scope:'unknown' as const}, {scope:'model' as const,model:null}]) {
      assert.equal(selectWorkerChannel(c, [], 'w', context([quota('a',{windows:[window({usedPercent:100,...patch})]})])), 'a');
    }
    failure(() => selectWorkerChannel(c, [], 'w', context([quota('a',{windows:[window({scope:'model',model:'gpt-5',usedPercent:100})]})])));
  }
});

test('single accounts reject only trustworthy live applicable evidence, including account restrictions and free flag', () => {
  const c = config(['a']);
  for (const patch of [{source:'untrusted'}, {engine:'claude' as const}, {channel:'other'}, {stale:true}, {observedAt:null}, {observedAt:iso(-QUOTA_FRESH_MS)}, {checkedAt:iso(1)}]) {
    assert.equal(selectWorkerChannel(c, [], 'w', context([quota('a',{windows:[window({usedPercent:100})],...patch})])), 'a');
  }
  assert.equal(selectWorkerChannel(c, [], 'w', context([quota('a',{windows:[window({usedPercent:100,resetsAt:iso()})]})])), 'a');
  failure(() => selectWorkerChannel(c, [], 'w', context([quota('a',{status:'exhausted',statusBasis:'account_restriction',windows:[window({resetsAt:iso()})]})])));
  c.workers.w!.free_channel = true;
  failure(() => selectWorkerChannel(c, [], 'w', context([quota('a',{windows:[window({usedPercent:100})]})])));
  for (const kind of ['pi','qoder','dsh']) {
    c.engines.native!.kind=kind;
    assert.equal(selectWorkerChannel(c, [], 'w', context()), 'a');
  }
});

test('OpenCode Go observations never cap other providers or free models', () => {
  const c = config(['a']); c.engines.native!.kind='opencode';
  const ctx=context([quota('a',{engine:'opencode',source:'opencode_go_usage',windows:[window({usedPercent:100})]})]);
  for (const model of ['openai/gpt-5','opencode/free-model','opencode-go-other/model']) {
    c.workers.w!.model=model;
    assert.equal(selectWorkerChannel(c, [], 'w', ctx), 'a');
  }
  c.workers.w!.model='opencode-go/model';
  failure(() => selectWorkerChannel(c, [], 'w', ctx));
});

test('blocks use each concrete channel, model and worker; expired and sibling blocks do not cover it', () => {
  const c = config();
  const block = (patch: Partial<Block>): Block => ({engine:'native',reason:'private block reason',since:iso(-1000),...patch});
  for (const scope of [{}, {model:'gpt-5'}, {worker:'w'}]) {
    failure(() => selectWorkerChannel(c, [block(scope)], 'w', context()));
  }
  const blocks = [block({channel:'a'}),block({channel:'b',worker:'sibling'}),block({channel:'b',model:'other'}),block({channel:'b',release_at:iso()})];
  assert.equal(selectWorkerChannel(c, blocks, 'w', context(), {excludeChannels:['c']}), 'b');
  failure(() => selectWorkerChannel(c, blocks, 'w', context(), {excludeChannels:['b','c']}));
});

test('single account preserves dispatchability for API/free channels without quota or credentials proof', () => {
  const c = config(['a']);
  c.channels.a!.kind = 'api'; c.workers.w!.free_channel = true;
  assert.equal(selectWorkerChannel(c, [], 'w'), 'a');
  assert.equal(selectWorkerChannel(c, [], 'w', {...context([]),credentialsReady:() => false,pickIndex:() => {throw Error('unexpected random');}}), 'a');
  failure(() => selectWorkerChannel(c, [], 'w', undefined, {excludeChannels:['a']}));
  c.channels.a!.enabled = false; failure(() => selectWorkerChannel(c, [], 'w'));
  c.channels.a!.enabled = true; c.workers.w!.enabled = false; failure(() => selectWorkerChannel(c, [], 'w'));
});

test('multi account pools require enabled same-engine official subscriptions and credential proof', () => {
  for (const change of [
    (c: Config) => {c.workers.w!.free_channel = true;},
    (c: Config) => {c.engines.native!.kind = 'pi';},
    (c: Config) => {c.engines.native!.kind = 'opencode';},
    (c: Config) => {c.channels.a!.engine = 'other';},
  ]) { const c=config(['a','b']); change(c); failure(() => selectWorkerChannel(c, [], 'w', context())); }
  for (const change of [(c:Config) => {c.channels.a!.kind='api';}, (c:Config) => {c.channels.a!.enabled=false;}]) {
    const c=config(['a','b']); change(c); assert.equal(selectWorkerChannel(c, [], 'w', context()), 'b');
  }
  assert.equal(selectWorkerChannel(config(['a','b']), [], 'w', {...context(),credentialsReady:id => id==='b'}), 'b');
  for (const [kind,source,model] of [['claude','claude_oauth_usage','sonnet'],['grok','grok_cli_billing','grok'],['opencode','opencode_go_usage','opencode-go/model'],['opencode','opencode_console_status','opencode-go/model']] as const) {
    const c=config(['a','b']); c.engines.native!.kind=kind; c.workers.w!.model=model;
    assert.equal(selectWorkerChannel(c, [], 'w', context([quota('b',{engine:kind,source})])), 'b');
  }
});

test('frozen member validates only its membership and eligibility and never redraws', () => {
  const ctx = {...context(),pickIndex:() => {throw Error('must not redraw');}};
  assert.equal(selectWorkerChannel(config(), [], 'w', ctx, {frozenChannel:'b'}), 'b');
  const unavailable=failure(() => selectWorkerChannel(config(), [], 'w', {...ctx,credentialsReady:id => id!=='b'}, {frozenChannel:'b'}));
  assert.match(unavailable.message, /认证未就绪/);
  const missing=failure(() => selectWorkerChannel(config(), [], 'w', ctx, {frozenChannel:'absent'}));
  assert.match(missing.message, /固定账号不在/);
  failure(() => selectWorkerChannel(config(), [], 'w', ctx, {frozenChannel:'b',excludeChannels:['b']}));
});

test('frozen validation consults only its own credentials and quota eligibility', () => {
  const c = config();
  const seen: string[] = [];
  const ctx = {...context(), credentialsReady: (channel: string) => {seen.push(channel); return channel === 'b';}};
  assert.equal(selectWorkerChannel(c, [], 'w', ctx, {frozenChannel:'b'}), 'b');
  assert.deepEqual(seen, ['b']);
});

test('selection leaves inputs untouched and skips randomness when filtering leaves one account', () => {
  const c = config(); const ctx = context([quota('b')]);
  const before = JSON.stringify({c, ctx});
  ctx.pickIndex = () => {throw Error('unexpected random');};
  assert.equal(selectWorkerChannel(c, [], 'w', ctx), 'b');
  assert.equal(JSON.stringify({c,ctx}), before);
  assert.ok(['a','b','c'].includes(selectWorkerChannel(config(), [], 'w', context())));
});
