import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Config } from '../../src/shared/contracts/policy';
import type { Task } from '../../src/shared/contracts/tasks';
import type { Route } from '../../src/renderer/app/router';
import { ownerKindLookup } from '../../src/renderer/features/tasks/task-view';
import { AgentFacts } from '../../src/renderer/features/tasks/AgentFacts';
import { AgentLabel, EngineIcon } from '../../src/renderer/ui/EngineIcon';
import { TaskInspectorView } from '../../src/renderer/features/tasks/TaskInspector';

function markup(node: React.ReactNode) {
  const props = { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'dark', children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 'unverified', pane: 'unverified' };
const bare: Task = { id: 't1', title: '重排任务面板', instruction: 'Rework the board', owner, status: 'completed', progress: 100, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z', events: [], artifacts: [] };
const dispatch = { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'sonnet', effort: 'high', execution: 'real' as const, maxParallel: 2, workspace: '/home/mocha/opensource/weaver' };
const claude: Task = { ...bare, id: 't2', title: '接入新引擎', status: 'running', progress: 20, updatedAt: '2026-10-18T01:00:00Z', dispatch };

const policyConfig = {
  version: 1,
  engines: { claude: { enabled: true, kind: 'claude', quota_refresh: true }, qoder: { enabled: false, kind: 'qodercli', quota_refresh: false } },
  channels: { default_claude: { engine: 'claude', label: 'Claude 工作账号', kind: 'subscription', enabled: true } },
  owners: { claude_owner: { enabled: true, channel: 'default_claude', model: 'claude-opus-5-5', effort: 'high', workers: ['claude_worker'], max_parallel: 4 } },
  workers: { claude_worker: { enabled: true, channels: ['default_claude'], model: 'sonnet', effort: 'high' } },
  herdr: { max_wait_minutes: 15 },
} as unknown as Config;
const ownerKind = ownerKindLookup(policyConfig);

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
  assert.match(labeled, /<span class="[^"]+"><svg[^>]*>[\s\S]*?<\/svg><span[^>]*>claude_owner<\/span><\/span>/);
});

test('facts name the owner, the worker and the workspace as one key value block', () => {
  const html = markup(React.createElement(AgentFacts, { task: claude, ownerKind }));
  assert.match(html, /<dt[^>]*>父 Agent<\/dt><dd[^>]*>[\s\S]*?claude_owner[\s\S]*?<\/dd>/);
  assert.match(html, /<dt[^>]*>子 Agent<\/dt><dd[^>]*>[\s\S]*?claude_worker[\s\S]*?<\/dd>/);
  assert.match(html, /<dt[^>]*>模型<\/dt><dd[^>]*>[\s\S]*?claude \/ sonnet · high[\s\S]*?<\/dd>/);
  assert.match(html, /<dt[^>]*>更新时间<\/dt><dd[^>]*><time[^>]*dateTime="2026-10-18T01:00:00Z"/);
  assert.match(html, /<dt[^>]*>工作目录<\/dt><dd[^>]*>[\s\S]*?\/home\/mocha\/opensource\/weaver[\s\S]*?<\/dd>/);
  assert.match(html, /fill="#D97757"/);
});

test('the worker mark follows the dispatch engine kind, the owner mark the policy engine', () => {
  const qoder: Task = { ...claude, dispatch: { ...dispatch, engine: 'qoder', engineKind: 'qodercli' } };
  const html = markup(React.createElement(AgentFacts, { task: qoder, ownerKind }));
  assert.match(html, /<dt[^>]*>父 Agent<\/dt><dd[^>]*>[\s\S]*?fill="#D97757"/);
  assert.match(html, /<dt[^>]*>子 Agent<\/dt><dd[^>]*>[\s\S]*?fill="#2ADB5C"[\s\S]*?claude_worker/);
});

test('facts drop the rows a task has no value for', () => {
  const html = markup(React.createElement(AgentFacts, { task: bare }));
  assert.match(html, /未指定父 Agent/);
  assert.doesNotMatch(html, /子 Agent|模型|工作目录/);
  assert.match(html, /<dt[^>]*>更新时间<\/dt>/);
  assert.match(markup(React.createElement(AgentFacts, { task: { ...bare, workspace: '/tmp/weaver-tasks/server-4VDE' } })), /\/tmp\/weaver-tasks\/server-4VDE/);
});

test('an owner the policy does not know still gets a mark in its fact row', () => {
  const html = markup(React.createElement(AgentFacts, { task: claude }));
  assert.match(html, /<dt[^>]*>父 Agent<\/dt><dd[^>]*>[\s\S]*?lucide lucide-bot[\s\S]*?claude_owner/);
});

test('the workspace path stays whole, ellipsizes and offers a copy button', () => {
  const html = markup(React.createElement(AgentFacts, { task: claude, ownerKind }));
  assert.match(html, /<div[^>]*style="-webkit-line-clamp:1"[^>]*>\/home\/mocha\/opensource\/weaver<\/div>/);
  assert.match(html, /<button[^>]*aria-label="复制工作目录"/);
  assert.match(html, /data-base-ui-tooltip-trigger=/);
});

test('inspector hands worker, model, session and workspace to the facts block in the overview tab', () => {
  const html = markup(React.createElement(TaskInspectorView, { task: claude, tasks: [claude], busy: false, action: async () => true, taskRoute: (taskId: string): Route => ({ page: 'tasks', view: 'all', taskId }), ownerKind, onClose: () => {}, onEdit: () => {} }));
  assert.ok(html.indexOf('aria-label="任务详情页"') > 0);
  assert.doesNotMatch(html.slice(0, html.indexOf('aria-label="任务详情页"')), /<dt/);
  assert.match(html, /role="tabpanel"[\s\S]*<dt[^>]*>子 Agent<\/dt>[\s\S]*?claude_worker/);
  assert.doesNotMatch(html, /更新于/);
  assert.doesNotMatch(html, /→/);
  assert.doesNotMatch(html, / · weaver · /);
});

test('the compact block shows only the parent agent even with a worker and workspace', () => {
  const html = markup(React.createElement(AgentFacts, { task: claude, ownerKind, compact: true }));
  assert.match(html, /aria-label="父 Agent：claude_owner"[\s\S]*?claude_owner<\/span>/);
  assert.doesNotMatch(html, /<dt|<dl/);
  assert.doesNotMatch(html, /claude_worker|目录|复制工作目录/);
  assert.match(html, /fill="#D97757"/);
});

test('the compact block resolves an unassigned parent and omits standalone workspace', () => {
  const html = markup(React.createElement(AgentFacts, { task: { ...bare, workspace: '/tmp/standalone' }, compact: true }));
  assert.match(html, /未指定父 Agent/);
  assert.doesNotMatch(html, /<dt|<dl/);
  assert.doesNotMatch(html, /standalone|目录|子 Agent/);
});

test('owner icons use the frozen profile even when ownerId is an instance UUID', () => {
  for (const compact of [true, false]) {
    const task = { ...claude, ownerId: 'instance-uuid' };
    const html = markup(React.createElement(AgentFacts, { task, ownerKind, compact }));
    assert.match(html, compact ? /aria-label="父 Agent：claude_owner"[\s\S]*<title>Claude Code<\/title>/ : /<dt[^>]*>父 Agent<\/dt><dd[^>]*>[\s\S]*?<title>Claude Code<\/title>/);
  }
});
