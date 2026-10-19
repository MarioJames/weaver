import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Config } from '../src/shared/policy';
import type { Task } from '../src/shared/types';
import { ownerKindLookup } from '../src/renderer/task-view';
import { AgentFacts } from '../src/renderer/components/AgentFacts';
import { AgentLabel, EngineIcon } from '../src/renderer/components/EngineIcon';
import { TaskDetail } from '../src/renderer/components/TaskDetail';

function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 'unverified', pane: 'unverified' };
const bare: Task = { id: 't1', title: '重排任务面板', instruction: 'Rework the board', owner, status: 'completed', progress: 100, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z', events: [], artifacts: [] };
const dispatch = { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'sonnet', effort: 'high', execution: 'real' as const, maxParallel: 2, workspace: '/home/mocha/opensource/weaver' };
const claude: Task = { ...bare, id: 't2', title: '接入新引擎', status: 'running', progress: 20, updatedAt: '2026-10-18T01:00:00Z', dispatch };

const policyConfig = {
  version: 1,
  engines: { claude: { enabled: true, kind: 'claude', quota_refresh: true }, qoder: { enabled: false, kind: 'qodercli', quota_refresh: false } },
  owners: { claude_owner: { enabled: true, engine: 'claude', model: 'claude-opus-5-5', effort: 'high', workers: ['claude_worker'], max_parallel: 4 } },
  workers: { claude_worker: { enabled: true, engine: 'claude', model: 'sonnet', effort: 'high' } },
  herdr: { max_wait_minutes: 15 },
} as unknown as Config;
const ownerKind = ownerKindLookup(policyConfig);

const detailProps = { busy: false, onStart: () => {}, onCancel: () => {}, action: async () => true };

/** The rendered icon on its own: the theme injects global styles that would blur a color check. */
function icon(kind?: string) {
  const html = markup(React.createElement(EngineIcon, { kind }));
  const svg = html.match(/<svg[\s\S]*<\/svg>/)?.[0];
  assert.ok(svg, `engine icon for ${kind ?? 'none'} must render an svg`);
  return svg;
}

test('brand marks use the colored variant wherever the icon set ships one', () => {
  assert.match(icon('claude'), /fill="#D97757"/);
  assert.match(icon('codex'), /<linearGradient[\s\S]*stop-color="#B1A7FF"/);
  assert.match(icon('qoder'), /fill="#2ADB5C"/);
  assert.match(icon('qodercli'), /fill="#2ADB5C"/);
});

test('a colored mark stops coloring with the text', () => {
  for (const kind of ['claude', 'codex']) assert.doesNotMatch(icon(kind), /fill="currentColor"/);
});

test('brands without a colored variant keep the mono mark', () => {
  for (const kind of ['opencode', 'pi', 'grok']) {
    assert.match(icon(kind), /^<svg[^>]*fill="currentColor"/);
    assert.doesNotMatch(icon(kind), /fill="#/);
  }
});

test('an unknown or missing engine kind still gets the neutral bot mark', () => {
  for (const kind of ['gemini', undefined]) assert.match(icon(kind), /lucide lucide-bot/);
});

test('the brand icon is the first item of one inline row with the name', () => {
  const labeled = markup(React.createElement(AgentLabel, { kind: 'claude', name: 'claude_owner' }));
  assert.match(labeled, /<span class="[^"]+"><svg[^>]*>[\s\S]*?<\/svg>claude_owner<\/span>/);
});

test('facts name the owner, the worker and the workspace as one key value block', () => {
  const html = markup(React.createElement(AgentFacts, { task: claude, ownerKind }));
  assert.match(html, /<dt[^>]*>Owner<\/dt><dd[^>]*>[\s\S]*?claude_owner<\/span><\/dd>/);
  assert.match(html, /<dt[^>]*>Worker<\/dt><dd[^>]*>[\s\S]*?claude_worker<\/span><\/dd>/);
  assert.match(html, /<dt[^>]*>工作目录<\/dt><dd[^>]*>[\s\S]*?\/home\/mocha\/opensource\/weaver[\s\S]*?<\/dd>/);
  assert.match(html, /fill="#D97757"/);
});

test('the worker mark follows the dispatch engine kind, the owner mark the policy engine', () => {
  const qoder: Task = { ...claude, dispatch: { ...dispatch, engine: 'qoder', engineKind: 'qodercli' } };
  const html = markup(React.createElement(AgentFacts, { task: qoder, ownerKind }));
  assert.match(html, /<dt[^>]*>Owner<\/dt><dd[^>]*>[\s\S]*?fill="#D97757"[\s\S]*?<\/dd><dt[^>]*>Worker<\/dt>/);
  assert.match(html, /<dt[^>]*>Worker<\/dt><dd[^>]*>[\s\S]*?fill="#2ADB5C"[\s\S]*?claude_worker/);
});

test('facts drop the rows a task has no value for', () => {
  const html = markup(React.createElement(AgentFacts, { task: bare }));
  assert.match(html, /未指定负责人/);
  assert.doesNotMatch(html, /Worker|工作目录/);
  assert.match(markup(React.createElement(AgentFacts, { task: { ...bare, workspace: '/tmp/weaver-tasks/server-4VDE' } })), /\/tmp\/weaver-tasks\/server-4VDE/);
});

test('an owner the policy does not know still gets a mark in its fact row', () => {
  const html = markup(React.createElement(AgentFacts, { task: claude }));
  assert.match(html, /<dt[^>]*>Owner<\/dt><dd[^>]*>[\s\S]*?lucide lucide-bot[\s\S]*?claude_owner/);
});

test('the workspace path stays whole, ellipsizes and offers a copy button', () => {
  const html = markup(React.createElement(AgentFacts, { task: claude, ownerKind }));
  assert.match(html, /<div[^>]*style="-webkit-line-clamp:1"[^>]*>\/home\/mocha\/opensource\/weaver<\/div>/);
  assert.match(html, /<button[^>]*aria-label="复制工作目录"/);
  assert.match(html, /data-base-ui-tooltip-trigger=/);
});

test('detail hands owner, worker and workspace to the facts block under the header', () => {
  const html = markup(React.createElement(TaskDetail, { task: claude, ...detailProps, ownerKind }));
  assert.match(html, /<\/div><\/div><dl class="[^"]*"><dt[^>]*>Owner<\/dt>/);
  assert.match(html, /claude \/ sonnet · high · 更新于/);
  assert.doesNotMatch(html, /→/);
  assert.doesNotMatch(html, / · weaver · /);
});

test('the compact block keeps the two agents and trades the path for its directory', () => {
  const html = markup(React.createElement(AgentFacts, { task: claude, ownerKind, compact: true }));
  assert.match(html, /<dt[^>]*>Owner<\/dt><dd[^>]*>[\s\S]*?claude_owner<\/span><\/dd>/);
  assert.match(html, /<dt[^>]*>Worker<\/dt><dd[^>]*>[\s\S]*?claude_worker<\/span><\/dd>/);
  /** A card has room for a directory name, not for the whole path: the path is the tooltip. */
  assert.match(html, /<dt[^>]*>目录<\/dt><dd[^>]*>[\s\S]*?>weaver<\/div>/);
  assert.doesNotMatch(html, /\/home\/mocha\/opensource\/weaver/);
  assert.doesNotMatch(html, /工作目录/);
  assert.match(html, /data-base-ui-tooltip-trigger=/);
  assert.doesNotMatch(html, /复制工作目录|<button/);
  assert.match(html, /fill="#D97757"/);
});

test('the compact block still drops what the task does not record', () => {
  const html = markup(React.createElement(AgentFacts, { task: bare, compact: true }));
  assert.match(html, /未指定负责人/);
  assert.doesNotMatch(html, /Worker|目录/);
  const workspaceOnly = markup(React.createElement(AgentFacts, { task: { ...bare, workspace: '/tmp/weaver-tasks/server-4VDE' }, compact: true }));
  assert.match(workspaceOnly, /<dt[^>]*>目录<\/dt><dd[^>]*>[\s\S]*?>server-4VDE<\/div>/);
  assert.doesNotMatch(workspaceOnly, /\/tmp\/weaver-tasks\/server-4VDE/);
});
