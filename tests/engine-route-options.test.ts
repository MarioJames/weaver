import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig, availabilityOf, resolveDispatch, validateConfig, type Block } from '../src/main/policy/routing';
import { proxyEnvironment, validateProxy } from '../src/shared/proxy';
import { PolicyStore } from '../src/main/policy/store';
import { createNormalizer } from '../src/main/adapters/cli/normalize';
import { HELLO_ENGINES } from '../src/main/engines/hello';

const quota: Block = { engine: 'codex', reason: 'exhausted', since: '2026-10-19T00:00:00Z', by: 'weaver-quota:codex' };
test('free channels share an engine with paid models, keep independent weights, and bypass only native quota blocks', () => {
  const config = defaultConfig();
  config.workers.free_worker = { ...config.workers.codex_worker!, model: 'free-model', free_channel: true };
  const owner = config.owners.claude_owner!;
  owner.workers = ['codex_worker', 'free_worker'];
  owner.worker_weights = { codex_worker: 10, free_worker: 2 };
  assert.deepEqual(validateConfig(config), []);
  assert.equal(resolveDispatch(config, [], { owner: 'claude_owner' }).worker, 'codex_worker');
  assert.equal(resolveDispatch(config, [quota], { owner: 'claude_owner' }).worker, 'free_worker');
  assert.equal(availabilityOf(config, [quota], config.workers.codex_worker!).status, 'blocked');
  for (const by of ['manual', 'weaver-vendor-limit', 'weaver-stall', 'weaver-free-probe']) {
    assert.equal(availabilityOf(config, [{ ...quota, by }], config.workers.free_worker).status, 'blocked', `a ${by} block keeps the free channel out`);
  }
  assert.equal(availabilityOf(config, [{ ...quota, model: 'other-model', by: 'manual' }], config.workers.free_worker).status, 'available');
  assert.equal(availabilityOf(config, [{ ...quota, model: 'free-model', by: 'weaver-free-probe' }], config.workers.codex_worker!).status, 'available', 'a probe ban is model-scoped: the paid model on the same engine stays usable');
});

test('the free-channel probe interval is validated like the quota refresh interval', () => {
  const config = defaultConfig();
  config.free_channel_probe = { enabled: true, interval_minutes: 4 };
  assert.deepEqual(validateConfig(config), [{ path: '$.free_channel_probe.interval_minutes', message: 'must be >= 5' }]);
  config.free_channel_probe = { enabled: true, interval_minutes: 1441 };
  assert.equal(validateConfig(config).length > 0, true);
  config.free_channel_probe = { enabled: true, interval_minutes: 5 };
  assert.deepEqual(validateConfig(config), []);
  config.free_channel_probe = { enabled: true, interval_minutes: 1440 };
  assert.deepEqual(validateConfig(config), []);
});

test('proxy modes isolate role environments and reject credentials and malformed protocols', () => {
  const source = { HTTPS_PROXY: 'http://old:80', ALL_PROXY: 'socks5://old:90', NO_PROXY: '*', KEEP: 'yes' };
  assert.deepEqual(proxyEnvironment(source), source);
  assert.deepEqual(proxyEnvironment(source, 'direct'), { KEEP: 'yes' });
  const custom = proxyEnvironment(source, 'http://127.0.0.1:7890');
  assert.equal(custom.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(custom.http_proxy, custom.HTTPS_PROXY);
  assert.equal(custom.ALL_PROXY, undefined);
  assert.equal(custom.NO_PROXY, undefined);
  assert.equal(source.ALL_PROXY, 'socks5://old:90');
  for (const value of ['', 'socks5://localhost:1', 'http://user:secret@localhost:1', 'http://host/path', 'http://host?key=value', 'http://host\nBAD=1']) assert.throws(() => validateProxy(value));
});

test('role proxy and free channel roundtrip; route preview freezes the selected proxy', () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-options-'));
  try {
    const file = join(root,'weaver.db');
    const store = new PolicyStore(file);
    const snapshot = store.snapshot();
    snapshot.config.owners.claude_owner!.proxy = 'direct';
    snapshot.config.workers.codex_worker!.proxy = 'http://127.0.0.1:7890';
    snapshot.config.workers.codex_worker!.free_channel = true;
    store.save({ revision: snapshot.revision, config: snapshot.config, blocks: snapshot.blocks });
    const reloaded = new PolicyStore(file);
    assert.equal(reloaded.snapshot().config.workers.codex_worker!.free_channel, true);
    assert.equal(reloaded.snapshot().config.owners.claude_owner!.proxy, 'direct');
    assert.equal(reloaded.preview({ owner: 'claude_owner', worker: 'codex_worker' }).proxy, 'http://127.0.0.1:7890');
    snapshot.config.workers.codex_worker!.proxy = 'ftp://localhost';
    assert.ok(validateConfig(snapshot.config).some(issue => issue.path === '$.workers.codex_worker.proxy'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ZCode official response envelope produces success only with a final response and zero exit', () => {
  for (const [exitCode, response, expected] of [[0, 'done', 'success'], [1, 'done', 'error'], [0, '', 'error']] as const) {
    const normalizer = createNormalizer('zcode');
    normalizer.push(JSON.stringify({ type: 'result', sessionId: 's-1', response }));
    const result = normalizer.finish({ exitCode, cancelled: false, truncated: false });
    assert.equal(result.evidence.terminal, expected);
    assert.equal(result.records.some(record => record.type === 'result'), expected === 'success');
  }
  assert.deepEqual(HELLO_ENGINES.zcode!.parse('{"response":"hi"}'), { reply: 'hi' });
  assert.ok(HELLO_ENGINES.zcode!.parse('not json').error);
});
