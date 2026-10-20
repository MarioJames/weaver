import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { readFileSync } from 'node:fs';
import { ModelListSession, type ModelListSink } from '../src/renderer/engine-models';
import type { EngineModelList, EngineModelListInput } from '../src/shared/engines';
import { ModelPicker } from '../src/renderer/components/ModelPicker';

const listOf = (engine: string, ...ids: string[]): EngineModelList => ({ engine, status: 'ok', source: 'test', models: ids.map(id => ({ id })), fetchedAt: '2026-01-01T00:00:00.000Z' });

function harness(answer: (input: EngineModelListInput) => Promise<EngineModelList> = async input => listOf(input.engine, `${input.engine}/m`)) {
  const requests: EngineModelListInput[] = [];
  const state: { list?: EngineModelList; loading: boolean; errors: string[] } = { loading: false, errors: [] };
  const sink: ModelListSink = { list: list => { state.list = list; }, loading: loading => { state.loading = loading; }, failed: (message, title) => { state.errors.push(`${title}:${String(message)}`); } };
  const session = new ModelListSession(sink, input => { requests.push(input); return answer(input); });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { requests, state, session, settle };
}

test('mounting the field fetches the engine models once, without any user action', async () => {
  const h = harness();
  h.session.sync('claude', undefined);
  assert.equal(h.state.loading, true);
  await h.settle();
  assert.deepEqual(h.requests, [{ engine: 'claude' }]);
  assert.equal(h.state.loading, false);
  assert.deepEqual(h.state.list?.models, [{ id: 'claude/m' }]);
});

test('the same engine and proxy never fetches twice (re-renders, strict-mode effect replays)', async () => {
  const h = harness();
  h.session.sync('codex', 'direct');
  h.session.sync('codex', 'direct');
  h.session.sync('codex', 'direct');
  await h.settle();
  h.session.sync('codex', 'direct');
  await h.settle();
  assert.equal(h.requests.length, 1);
});

test('no engine, no request; choosing one later fetches it', async () => {
  const h = harness();
  h.session.sync('', undefined);
  h.session.sync('', 'direct');
  await h.settle();
  assert.equal(h.requests.length, 0);
  assert.equal(h.state.loading, false);
  h.session.sync('grok', undefined);
  await h.settle();
  assert.deepEqual(h.requests, [{ engine: 'grok' }]);
});

test('a changed engine or proxy fetches again, and a slow answer for the old engine cannot overwrite the new list', async () => {
  const pending = new Map<string, (list: EngineModelList) => void>();
  const h = harness(input => new Promise(resolve => pending.set(input.engine + (input.proxy ?? ''), resolve)));
  h.session.sync('claude', undefined);
  h.session.sync('codex', undefined);
  assert.equal((h.state as { list?: EngineModelList }).list, undefined, 'the previous engine list is dropped at once');
  pending.get('codex')!(listOf('codex', 'gpt'));
  await h.settle();
  pending.get('claude')!(listOf('claude', 'late'));
  await h.settle();
  assert.deepEqual(h.state.list?.models, [{ id: 'gpt' }]);
  assert.equal(h.state.loading, false);
  h.session.sync('codex', 'http://127.0.0.1:7890');
  pending.get('codexhttp://127.0.0.1:7890')!(listOf('codex', 'via-proxy'));
  await h.settle();
  assert.deepEqual(h.requests.map(item => [item.engine, item.proxy]), [['claude', undefined], ['codex', undefined], ['codex', 'http://127.0.0.1:7890']]);
  assert.deepEqual(h.state.list?.models, [{ id: 'via-proxy' }]);
});

test('a proxy address still being typed does not trigger a request', async () => {
  const h = harness();
  h.session.sync('claude', 'http://127.0.0.1:7890');
  await h.settle();
  h.session.sync('claude', 'http://');
  h.session.sync('claude', 'http://127.0.0.1:78 90');
  await h.settle();
  assert.equal(h.requests.length, 1);
});

test('refresh forces a new request with refresh=true even for an unchanged engine', async () => {
  const h = harness();
  h.session.sync('claude', undefined);
  await h.settle();
  await h.session.load(true);
  assert.deepEqual(h.requests, [{ engine: 'claude' }, { engine: 'claude', refresh: true }]);
  await h.session.load(true).then(() => h.session.sync('claude', undefined));
  assert.equal(h.requests.length, 3);
});

test('a failed or rejected fetch is reported and leaves the field usable', async () => {
  const failed = harness(async input => ({ ...listOf(input.engine), status: 'failed', message: '命令失败' }));
  failed.session.sync('claude', undefined);
  await failed.settle();
  assert.deepEqual(failed.state.errors, ['模型列表获取失败:命令失败']);
  assert.equal(failed.state.loading, false);
  const rejected = harness(async () => { throw new Error('boom'); });
  rejected.session.sync('claude', undefined);
  await rejected.settle();
  assert.equal(rejected.state.errors.length, 1);
  assert.equal(rejected.state.loading, false);
});

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { enableCustomFonts: false }, node) }));
}

test('the picker no longer tells the user to open the field to fetch models, and keeps the refresh button', () => {
  const html = markup(React.createElement(ModelPicker, { engine: 'claude', value: '', onChange: () => {} }));
  assert.doesNotMatch(html, /点开输入框/);
  assert.match(html, /正在获取 claude 的可用模型/);
  assert.match(html, /aria-label="刷新 claude 模型列表"/);
  assert.match(markup(React.createElement(ModelPicker, { engine: '', value: '', onChange: () => {} })), /选择引擎后自动获取/);
});

test('the engines page has no model probe block, say-hi check or disable conflict', () => {
  const source = readFileSync(new URL('../src/renderer/pages/EnginesPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /EngineModelProbe|HelloCheck|ModelPicker|模型探测|engineDisableConflict|请先停用/);
});
