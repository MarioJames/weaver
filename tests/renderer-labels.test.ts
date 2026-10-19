import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../src/main/policy/routing';
import { RolesPage } from '../src/renderer/pages/RolesPage';
import { TaskComposer } from '../src/renderer/components/TaskComposer';
import type { PolicyDraft } from '../src/renderer/usePolicyDraft';

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

function roles() {
  const config = defaultConfig();
  config.workers = { opencode_worker: config.workers.opencode_worker };
  return React.createElement(RolesPage, { section: 'workers', policy: { config } as PolicyDraft });
}

function composer() {
  return React.createElement(TaskComposer, { disabled: false, draft: { title: '', goal: '', workspace: '.', profile: '', acceptance: '' }, onDraft: () => {}, onCreate: async () => true, onImport: () => {} });
}

test('role native inputs have visible label links, including config id and freeform effort', () => {
  nativeFieldLinks(markup(React.createElement(React.Fragment, null, roles(), roles())), ['配置 ID', '模型', '推理强度', '用途说明'], 2);
});

test('task native input and textareas have visible label links even with workspace validation shown', () => {
  nativeFieldLinks(markup(React.createElement(React.Fragment, null, composer(), composer())), ['任务标题', '目标与约束', '目标项目目录', '验收标准'], 2);
});
