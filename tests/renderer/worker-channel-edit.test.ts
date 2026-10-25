import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config, Worker } from '../../src/shared/contracts/policy';
import { withWorkerChannels, workerChannelsError } from '../../src/renderer/policy/policy-edit';
import * as policyEdit from '../../src/renderer/policy/policy-edit';
import { ModelListSession } from '../../src/renderer/features/engines/engine-models';
import type { EngineModelList, EngineModelListInput } from '../../src/shared/engines';

function fixture(): { config: Config; worker: Worker } {
  const engines = { codex: { enabled: true, kind: 'codex' }, otherCodex: { enabled: true, kind: 'codex' }, dsh: { enabled: true, kind: 'dsh' }, opencode: { enabled: true, kind: 'opencode' } };
  const channels = Object.fromEntries(Object.entries({ a: 'codex', b: 'codex', c: 'otherCodex', d: 'dsh', o: 'opencode', p: 'opencode' }).map(([id, engine]) => [id, { engine, label: id, enabled: true, kind: 'subscription' as const }]));
  return {
    config: { version: 1, engines, channels, owners: {}, workers: {}, herdr: { max_wait_minutes: 10 } },
    worker: { channels: ['a'], enabled: true, model: 'gpt-model', effort: 'xhigh', description: 'keep draft', max_parallel: 3 },
  };
}

test('a different engine clears the model and replaces only an unsupported effort', () => {
  const { config, worker } = fixture();
  const before = structuredClone(worker);
  assert.deepEqual(withWorkerChannels(config, worker, ['d']), { ...worker, channels: ['d'], model: '', effort: 'off' });
  assert.deepEqual(withWorkerChannels(config, { ...worker, effort: 'high' }, ['d']), { ...worker, channels: ['d'], model: '', effort: 'high' });
  assert.equal(withWorkerChannels(config, worker, ['c']).model, '', 'distinct engine IDs still reset when both are Codex');
  assert.equal(withWorkerChannels(config, worker, ['o']).effort, 'xhigh', 'engines without a fixed effort list keep the editable variant');
  assert.deepEqual(worker, before, 'editing never mutates the previous draft');
});

test('replacing, adding, removing or reordering same-engine accounts retains the shared model and effort', () => {
  const { config, worker } = fixture();
  for (const channels of [['a'], ['b'], ['a', 'b'], ['b', 'a']]) {
    assert.deepEqual(withWorkerChannels(config, worker, channels), { ...worker, channels });
  }
  const pool = withWorkerChannels(config, worker, ['a', 'b']);
  assert.deepEqual(withWorkerChannels(config, pool, ['b']), { ...worker, channels: ['b'] });
});

test('removing the last account preserves an editable draft; selecting a new engine resets unbound model', () => {
  const { config, worker } = fixture();
  const empty = withWorkerChannels(config, worker, []);
  assert.deepEqual(empty, { ...worker, channels: [] });
  assert.equal(workerChannelsError(config, empty), '请至少选择一个账号或渠道');
  assert.equal(workerChannelsError(config, withWorkerChannels(config, empty, ['a'])), '');
  assert.deepEqual(withWorkerChannels(config, empty, ['d']), { ...worker, channels: ['d'], model: '', effort: 'off' });
});

test('channel edits preserve official-pool, same-engine, free and OpenCode model validation', () => {
  const { config, worker } = fixture();
  assert.equal(workerChannelsError(config, withWorkerChannels(config, worker, ['a', 'b'])), '');
  assert.match(workerChannelsError(config, withWorkerChannels(config, worker, ['a', 'c'])), /同一个执行引擎 ID/);
  assert.match(workerChannelsError(config, withWorkerChannels(config, { ...worker, free_channel: true }, ['a', 'b'])), /免费渠道/);
  config.channels.b!.kind = 'api';
  assert.match(workerChannelsError(config, withWorkerChannels(config, worker, ['a', 'b'])), /API/);
  const open = { ...worker, channels: ['o'], model: 'opencode-go/model' };
  assert.equal(workerChannelsError(config, withWorkerChannels(config, open, ['o', 'p'])), '', 'adding a second OpenCode account keeps its required model prefix');
  assert.match(workerChannelsError(config, withWorkerChannels(config, { ...open, model: 'other/model' }, ['o', 'p'])), /opencode-go/);
});

test('late model catalogs from an old account cannot populate a new engine or account', async () => {
  const pending: Array<{ input: EngineModelListInput; resolve: (list: EngineModelList) => void }> = [];
  let list: EngineModelList | undefined;
  const session = new ModelListSession({ list: next => { list = next; }, loading: () => {}, failed: () => assert.fail('unexpected catalog failure') }, input => new Promise(resolve => { pending.push({ input, resolve }); }));
  const result = (engine: string, id: string): EngineModelList => ({ engine, status: 'ok', source: 'test', fetchedAt: '2026-10-25T00:00:00Z', models: [{ id }] });
  session.sync('codex', 'a');
  session.sync('dsh', 'd');
  pending[1]!.resolve(result('dsh', 'new-model'));
  await new Promise(resolve => setImmediate(resolve));
  pending[0]!.resolve(result('codex', 'stale-model'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(list?.engine, 'dsh');
  assert.deepEqual(list?.models, [{ id: 'new-model' }]);
  session.sync('codex', 'a');
  assert.equal(list, undefined);
  session.sync('codex', 'b');
  pending[3]!.resolve(result('codex', 'account-b-model'));
  await new Promise(resolve => setImmediate(resolve));
  pending[2]!.resolve(result('codex', 'account-a-model'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((list as EngineModelList | undefined)?.models, [{ id: 'account-b-model' }]);
  assert.deepEqual(pending.map(request => request.input), [{ engine: 'codex', channel: 'a' }, { engine: 'dsh', channel: 'd' }, { engine: 'codex', channel: 'a' }, { engine: 'codex', channel: 'b' }]);
});


test('save validation locates every draft worker and clears after repair without rejecting supported configurations', () => {
  const { config, worker } = fixture();
  config.channels.api = { ...config.channels.a!, kind: 'api' };
  config.workers = {
    valid: { ...worker, channels: ['a', 'b'] },
    api: { ...worker, channels: ['api'] },
    free: { ...worker, channels: ['d'], free_channel: true },
  };
  assert.equal(policyEdit.workerChannelsSaveBlockReason(config), '');
  config.workers.hidden = { ...worker, enabled: false, channels: [] };
  config.workers.another = { ...worker, channels: [] };
  assert.equal(policyEdit.workerChannelsSaveBlockReason(config), '子 Agent hidden：请至少选择一个账号或渠道');
  config.workers.hidden = withWorkerChannels(config, config.workers.hidden, ['a']);
  assert.equal(policyEdit.workerChannelsSaveBlockReason(config), '子 Agent another：请至少选择一个账号或渠道');
  config.workers.another = withWorkerChannels(config, config.workers.another, ['a']);
  assert.equal(policyEdit.workerChannelsSaveBlockReason(config), '');
  config.workers.hidden.channels = ['a', 'c'];
  assert.match(policyEdit.workerChannelsSaveBlockReason(config), /子 Agent hidden：.*同一个执行引擎 ID/);
});
