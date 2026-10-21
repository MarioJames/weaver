import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../../src/main/policy/routing';
import { RolesPage } from '../../src/renderer/features/roles/RolesPage';
import { TaskComposer } from '../../src/renderer/features/tasks/TaskComposer';
import type { PolicyDraft } from '../../src/renderer/policy/usePolicyDraft';

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { enableCustomFonts: false }, node) }));
}

function nativeFieldLinks(html: string, names: string[], instances = 1) {
  const controls = [...html.matchAll(/<(input|textarea)\b[^>]*>/g)].map(([tag]) => tag);
  const labels = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)];
  for (const name of names) {
    const matching = controls.filter(tag => tag.includes(`aria-label="${name}"`));
    assert.equal(matching.length, instances, `${name}: expected native controls`);
    for (const control of matching) {
      const id = control.match(/\bid="([^"]+)"/)?.[1];
      assert.ok(id, `${name}: native control needs an id`);
      const linked = labels.filter(([, attributes, content]) => attributes.includes(`for="${id}"`) && content.replace(/<[^>]*>/g, '').includes(name));
      assert.equal(linked.length, 1, `${name}: exactly one visible Form label must target the native control`);
      const description = control.match(/\baria-describedby="([^"]+)"/)?.[1];
      if (description) assert.ok(html.includes(`id="${description}" role="alert"`), `${name}: error description must remain associated`);
    }
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id);
  assert.equal(new Set(ids).size, ids.length, 'rendered control ids must be unique');
}

/** The model field is one combobox (AutoComplete): its native input carries the id the visible Form label targets. */
function comboboxLinks(html: string, name: string, instances = 1) {
  const controls = [...html.matchAll(/<input\b[^>]*role="combobox"[^>]*>/g)].map(([tag]) => tag);
  assert.equal(controls.length, instances, `${name}: exactly one combobox per field`);
  const labels = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)];
  for (const control of controls) {
    const id = control.match(/\bid="([^"]+)"/)?.[1];
    assert.ok(id, `${name}: combobox needs an id`);
    const linked = labels.filter(([, attributes, content]) => attributes.includes(`for="${id}"`) && content.replace(/<[^>]*>/g, '').includes(name));
    assert.equal(linked.length, 1, `${name}: exactly one visible label must target the combobox`);
  }
}

function roles() {
  const config = defaultConfig();
  config.workers = { opencode_worker: config.workers.opencode_worker };
  return React.createElement(RolesPage, { section: 'workers', policy: { config } as PolicyDraft });
}

function composer() {
  return React.createElement(TaskComposer, { disabled: false, draft: { goal: '', workspace: '', profile: '' }, onDraft: () => {}, onCreate: async () => true });
}

test('role native inputs have visible label links, including config id and freeform effort', () => {
  const html = markup(React.createElement(React.Fragment, null, roles(), roles()));
  nativeFieldLinks(html, ['配置 ID', '推理强度', '用途说明'], 2);
  comboboxLinks(html, '模型', 2);
  // One control per model field: no separate picker select next to the text input.
  assert.equal((html.match(/aria-label="模型列表"/g) ?? []).length, 0);
});

test('a sortable role list has one dedicated drag handle per row and none while saving', () => {
  const config = defaultConfig();
  config.workers = { opencode_worker: config.workers.opencode_worker!, claude_worker: config.workers.claude_worker! };
  const html = markup(React.createElement(RolesPage, { section: 'workers', policy: { config } as PolicyDraft }));
  assert.equal((html.match(/aria-label="拖动排序 /g) ?? []).length, 2);
  for (const id of ['opencode_worker', 'claude_worker']) assert.match(html, new RegExp(`aria-label="拖动排序 ${id}"`));
  assert.match(html, /touch-action:\s*none/);
  const busy = markup(React.createElement(RolesPage, { section: 'workers', policy: { config, busy: true } as PolicyDraft }));
  assert.doesNotMatch(busy, /aria-label="拖动排序 /);
});

test('task native input and textareas have visible label links even with workspace validation shown', () => {
  nativeFieldLinks(markup(React.createElement(React.Fragment, null, composer(), composer())), ['目标与约束'], 2);
});

test('the model field is one input with suggestions: typing narrows, a complete name offers the whole list again', async () => {
  const { matchModel } = await import('../../src/renderer/features/engines/engine-models');
  const { ModelPicker } = await import('../../src/renderer/features/engines/ModelPicker');
  const options = [{ value: 'gpt-5', label: 'gpt-5 · GPT-5' }, { value: 'gpt-5-mini' }, { value: 'claude-opus-4-1', label: 'claude-opus-4-1 · Claude Opus 4.1' }];
  const shown = (query: string) => options.filter(item => matchModel(options, query, item)).map(item => item.value);
  assert.deepEqual(shown(''), ['gpt-5', 'gpt-5-mini', 'claude-opus-4-1']);
  assert.deepEqual(shown('mini'), ['gpt-5-mini']);
  assert.deepEqual(shown('OPUS'), ['claude-opus-4-1']);
  assert.deepEqual(shown('no-such-model'), []);
  assert.deepEqual(shown('Claude Opus 4.1'), ['claude-opus-4-1']);
  assert.deepEqual(shown('gpt-5'), ['gpt-5', 'gpt-5-mini', 'claude-opus-4-1']);
  const html = markup(React.createElement(ModelPicker, { engine: 'claude', value: '', onChange: () => {}, label: 'claude 探测模型' }));
  assert.equal((html.match(/role="combobox"/g) ?? []).length, 1);
  assert.equal((html.match(/<input\b[^>]*aria-hidden="true"/g) ?? []).length, 1, 'only the library\'s own hidden form input besides the visible one');
  assert.match(html, /<label[^>]*>claude 探测模型<\/label>/);
  assert.match(html, /aria-label="刷新 claude 模型列表"/);
  assert.doesNotMatch(html, /模型列表"[^>]*role="combobox"|从引擎的模型列表选择|选中后填入上方输入框/);
});
