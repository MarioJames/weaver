import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../../src/main/policy/routing';
import type { Availability, Config, PolicySnapshot } from '../../src/shared/contracts/policy';
import type { Task } from '../../src/shared/contracts/tasks';
import type { PolicyDraft } from '../../src/renderer/policy/usePolicyDraft';
import { RolesPage } from '../../src/renderer/features/roles/RolesPage';
import { RoleEditor } from '../../src/renderer/features/roles/RoleEditor';
import { rolesStyles } from '../../src/renderer/features/roles/roles-style';
import { selectableListStyles } from '../../src/renderer/ui/selectable-list-style';
import { blankOwner, blankWorker, renameRole } from '../../src/renderer/policy/policy-edit';
import {
  DESCRIPTIONS, dirtyRoleCount, fallbackRoleId, filterRoleIds, incompleteRoleIds, moveRoleOrder, recentWorkerTasks, roleFieldIssues, roleMetrics, roleStatusView, visibleFieldError,
} from '../../src/renderer/features/roles/roles-view';
import { styleCss } from './style-helpers';

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, {
    motion, enableCustomFonts: false,
    children: React.createElement(ThemeScope, { appearance: 'light', children: node }),
  })).replace(/<style[\s\S]*?<\/style>/g, '');
}

function withWindow<T>(hash: string, run: () => T): T {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  class FakeElement {}
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeElement });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { hash, pathname: '/' },
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    },
  });
  try { return run(); } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousElement) Object.defineProperty(globalThis, 'HTMLElement', previousElement);
    else Reflect.deleteProperty(globalThis, 'HTMLElement');
  }
}

const available: Availability = { status: 'available' };
const blocked: Availability = { status: 'blocked', reason: '额度耗尽' };
const disabled: Availability = { status: 'disabled' };
const channelOff: Availability = { status: 'channel_disabled', channel: 'default_grok' };

function snapshotOf(config: Config): PolicySnapshot {
  return {
    revision: 4,
    config: structuredClone(config),
    blocks: [],
    activeBlocks: [],
    owners: { claude_owner: available, codex_owner: blocked, pi_owner: disabled },
    workers: {
      claude_worker: available, codex_worker: available, grok_worker: channelOff,
      qoder_worker: blocked, opencode_worker: available, pi_worker: disabled, dsh_worker: disabled,
    },
    execution: 'disabled',
  };
}

const owner = { name: 'Parent', transport: 'herdr-visible' as const, session: '', pane: '' };
const task = (id: string, worker: string, updatedAt: string, status: Task['status'] = 'completed'): Task => ({
  id, title: `任务 ${id}`, instruction: '', owner, status, progress: 0, createdAt: updatedAt, updatedAt,
  events: [], artifacts: [], dispatch: { owner: 'claude_owner', worker, engine: 'claude', engineKind: 'claude', model: 'sonnet', effort: 'high', execution: 'real', maxParallel: 1 },
});

function draft(config: Config, snapshot: PolicySnapshot, dirty = false): PolicyDraft {
  return {
    snapshot, config, blocks: [], setConfig: () => {}, setBlocks: () => {}, loading: false, busy: false,
    loadError: '', saveError: '', issues: [], conflict: false, dirty,
    load: async () => true, save: async () => true, commit: async () => {}, rebase: () => {}, applyServerSnapshot: () => true,
  } as PolicyDraft;
}

test('role metrics count enabled roles, saved dispatchability, references and pauses on both pages', () => {
  const config = defaultConfig();
  const snapshot = snapshotOf(config);
  assert.deepEqual(roleMetrics(config, snapshot, 'owners'), { enabled: 2, total: 3, dispatchable: 1, referenced: 5, paused: 1 });
  assert.deepEqual(roleMetrics(config, snapshot, 'workers'), { enabled: 2, total: 7, dispatchable: 3, referenced: 6, paused: 1 });
  assert.deepEqual(roleMetrics(undefined, undefined, 'workers'), { enabled: 0, total: 0, dispatchable: 0, referenced: 0, paused: 0 });
});

test('role search matches id, account name and model and returns config order', () => {
  const config = defaultConfig();
  config.channels.default_codex.label = 'Team Codex';
  assert.deepEqual(filterRoleIds(config, 'workers', 'team codex'), ['codex_worker']);
  assert.deepEqual(filterRoleIds(config, 'workers', 'QWEN'), ['qoder_worker']);
  assert.deepEqual(filterRoleIds(config, 'workers', 'default_claude'), ['claude_worker']);
  assert.deepEqual(filterRoleIds(config, 'workers', '  '), Object.keys(config.workers));
  assert.deepEqual(filterRoleIds(config, 'workers', 'nothing'), []);
  assert.deepEqual(filterRoleIds(config, 'owners', 'codex'), ['codex_owner']);
});

test('the list status dot leads with a pause, then disabled, then saved availability', () => {
  assert.deepEqual(roleStatusView({ enabled: true }, available), { label: '可用', tone: 'success', hint: '已保存的策略允许派发。' });
  assert.deepEqual(roleStatusView({ enabled: true }, blocked), { label: '已暂停', tone: 'warning', hint: '已限制：额度耗尽' });
  assert.equal(roleStatusView({ enabled: true }, channelOff).label, '渠道停用');
  assert.equal(roleStatusView({ enabled: false }, available).label, '已停用');
  assert.equal(roleStatusView({ enabled: true }, undefined).label, '尚未保存');
  const probe = { status: 'blocked' as const, reason: '额度耗尽' };
  const withBlock = roleStatusView({ enabled: true }, probe, { engine: 'qoder', reason: '额度耗尽', since: '2026-10-19T00:00:00Z', by: 'weaver-free-probe' });
  assert.equal(withBlock.label, '免费额度用完');
  assert.equal(withBlock.tone, 'orange');
});

test('the save bar counts changed agents across both sections of the shared draft', () => {
  const saved = defaultConfig();
  const config = structuredClone(saved);
  config.owners.claude_owner.max_parallel = 9;
  config.workers.claude_worker.model = 'changed';
  assert.equal(dirtyRoleCount(config, { config: saved }), 2);
  assert.equal(dirtyRoleCount(saved, { config: saved }), 0);
  assert.equal(dirtyRoleCount(undefined, { config: saved }), 0);
  config.workers.new = { ...config.workers.claude_worker };
  assert.equal(dirtyRoleCount(config, { config: saved }), 3);
  delete config.workers.claude_worker;
  assert.equal(dirtyRoleCount(config, { config: saved }), 3);
  // A rename is one agent, including the owner rows whose worker references follow it.
  const renamedWorker = renameRole(saved, 'workers', 'claude_worker', 'claude_renamed');
  assert.equal(dirtyRoleCount(renamedWorker, { config: saved }), 1);
  const renamedOwner = renameRole(saved, 'owners', 'claude_owner', 'claude_parent');
  assert.equal(dirtyRoleCount(renamedOwner, { config: saved }), 1);
  const renamedAndEdited = renameRole(saved, 'owners', 'claude_owner', 'claude_parent');
  renamedAndEdited.owners.claude_parent!.max_parallel = 12;
  assert.equal(dirtyRoleCount(renamedAndEdited, { config: saved }), 2);
  const reordered = structuredClone(saved);
  const owners = Object.keys(reordered.owners);
  reordered.owners = Object.fromEntries([owners[1]!, owners[0]!, ...owners.slice(2)].map(id => [id, reordered.owners[id]!]));
  assert.equal(dirtyRoleCount(reordered, { config: saved }), 1);
});

test('drag reorder moves one id to the target index and never mutates the input', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveRoleOrder(ids, 'a', 'c'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveRoleOrder(ids, 'd', 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveRoleOrder(ids, 'a', 'a'), ids);
  assert.deepEqual(moveRoleOrder(ids, 'missing', 'a'), ids);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
});

test('recent worker tasks are that worker only, newest first and capped at five', () => {
  const tasks = [
    task('old', 'claude_worker', '2026-10-20T10:00:00Z'),
    task('new', 'claude_worker', '2026-10-22T10:00:00Z'),
    task('other', 'codex_worker', '2026-10-23T10:00:00Z'),
    task('mid', 'claude_worker', '2026-10-21T10:00:00Z'),
    ...Array.from({ length: 4 }, (_, index) => task(`extra${index}`, 'claude_worker', `2026-10-1${index + 1}T10:00:00Z`)),
  ];
  assert.deepEqual(recentWorkerTasks(tasks, 'claude_worker').map(item => item.id), ['new', 'mid', 'old', 'extra3', 'extra2']);
  assert.equal(recentWorkerTasks(tasks, 'claude_worker', 2).length, 2);
  assert.deepEqual(recentWorkerTasks(tasks, 'nobody'), []);
});

test('the parent page renders the master-detail skeleton, tips, metrics, relation links and save bar', () => {
  const saved = defaultConfig();
  const config = structuredClone(saved);
  config.owners.claude_owner.max_parallel = 9;
  config.workers.claude_worker.model = 'changed';
  const snapshot = snapshotOf(saved);
  const html = markup(React.createElement(RolesPage, { section: 'owners', policy: draft(config, snapshot, true) }));
  assert.match(html, /aria-label="父 Agent 内容"/);
  assert.match(html, /aria-label="父 Agent 列表"/);
  assert.match(html, /aria-label="父 Agent 详情"/);
  assert.match(html, /lobe-dashboard-title-with-tips/);
  assert.doesNotMatch(html, new RegExp(DESCRIPTIONS.owners.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(html, /拖动左侧手柄调整顺序/);
  // Compact metrics: same labels, values and hints as the tall strip, packed in one row.
  assert.match(html, /aria-label="父 Agent指标"/);
  assert.doesNotMatch(html, /lobe-dashboard-metric-strip/);
  for (const label of ['启用', '可派发', '覆盖子 Agent', '已暂停']) assert.match(html, new RegExp(label));
  assert.match(html, /2\/3/);
  assert.match(html, /data-tone="warning"/);
  assert.match(html, /href="#\/workers\/claude_worker"/);
  assert.match(html, /aria-label="未保存的修改"/);
  assert.match(html, /2 个 Agent 有未保存的修改/);
  assert.match(html, />放弃修改</);
  assert.match(html, />保存</);
  assert.match(html, /引用的子 Agent/);
});

test('the child page shows reverse parent links, the latest tasks and the selected URL id', () => {
  const saved = defaultConfig();
  const config = structuredClone(saved);
  config.owners.claude_owner.max_parallel = 9;
  config.workers.claude_worker.model = 'changed';
  const snapshot = snapshotOf(saved);
  const tasks = [
    task('a'.repeat(8), 'claude_worker', '2026-10-20T10:00:00Z'),
    task('b'.repeat(8), 'claude_worker', '2026-10-22T10:00:00Z', 'running'),
    task('c'.repeat(8), 'codex_worker', '2026-10-23T10:00:00Z'),
  ];
  const html = withWindow('#/workers/claude_worker', () => markup(React.createElement(RolesPage, { section: 'workers', policy: draft(config, snapshot, true), tasks })));
  assert.match(html, /aria-label="子 Agent 内容"/);
  assert.match(html, /title="claude_worker"/);
  assert.match(html, /href="#\/owners\/claude_owner"/);
  assert.doesNotMatch(html, /href="#\/owners\/codex_owner"/);
  assert.match(html, /被父 Agent 引用/);
  assert.match(html, /最近执行的任务/);
  assert.match(html, new RegExp(`href="#/tasks/all/t/${'b'.repeat(8)}"`));
  assert.match(html, new RegExp(`href="#/tasks/all/t/${'a'.repeat(8)}"`));
  assert.doesNotMatch(html, new RegExp(`href="#/tasks/all/t/${'c'.repeat(8)}"`));
  assert.match(html, /2 个 Agent 有未保存的修改/);
});

test('an unknown id keeps the URL state and shows the not-found action instead of a record', () => {
  const saved = defaultConfig();
  const html = withWindow('#/owners/missing_owner', () => markup(React.createElement(RolesPage, { section: 'owners', policy: draft(structuredClone(saved), snapshotOf(saved)) })));
  assert.match(html, /未找到这个父 Agent/);
  assert.match(html, />返回列表</);
  assert.doesNotMatch(html, /id="[^"]+-channel"/);
});

test('a discarded rename falls back to the first role, anything else keeps the URL', () => {
  const saved = defaultConfig();
  assert.equal(fallbackRoleId(saved, 'owners', 'claude_renamed'), 'claude_owner');
  assert.equal(fallbackRoleId(saved, 'workers', 'claude_worker'), undefined);
  assert.equal(fallbackRoleId(saved, 'owners', undefined), undefined);
  assert.equal(fallbackRoleId(undefined, 'owners', 'claude_renamed'), undefined);
  assert.equal(fallbackRoleId({ ...saved, owners: {} }, 'owners', 'claude_renamed'), '');
});


test('new role drafts keep every required choice empty until the user fills it', () => {
  const config = defaultConfig();
  assert.deepEqual(blankOwner(config), { enabled: false, channel: '', model: '', effort: '', workers: [], max_parallel: 1 });
  assert.deepEqual(blankWorker(config), { enabled: false, channels: [], model: '', effort: '', description: '' });
  assert.deepEqual(roleFieldIssues('owners', blankOwner(config)).map(issue => issue.field), ['channel', 'model', 'effort', 'workers']);
  assert.deepEqual(roleFieldIssues('workers', blankWorker(config)).map(issue => issue.field), ['channel', 'model', 'effort']);
  const withNew = { ...config, owners: { ...config.owners, new: blankOwner(config) } };
  assert.deepEqual(incompleteRoleIds(withNew, 'owners'), ['new']);
  assert.deepEqual(incompleteRoleIds(config, 'owners'), []);
});

test('the new parent Agent editor renders placeholders instead of prefilled values', () => {
  const saved = defaultConfig();
  const config = structuredClone(saved);
  config.owners.new = blankOwner(config);
  const snapshot = snapshotOf(saved);
  const editor = {
    pendingId: '', setPendingId: () => {}, freshId: 'new', startNew: () => {}, idError: '', setIdError: () => {},
    acceptId: () => true, askDelete: false, setAskDelete: () => {}, deleting: false, deleteError: '', setDeleteError: () => {},
    confirmDelete: async () => {}, toggling: '', toggle: async () => {}, resuming: '', resume: async () => {},
    diagnostics: {}, setDiagnostics: () => {}, touched: new Set(), touch: () => {}, touchAll: () => {},
  } as React.ComponentProps<typeof RoleEditor>['editor'];
  const html = markup(React.createElement(RoleEditor, {
    section: 'owners', policy: draft(config, snapshot, true), current: 'new', editor,
    freeProbe: { unavailable: false, probing: new Set<string>(), probeNow: async () => {} },
    tasks: [], narrow: false, onBack: () => {}, onAdd: () => {},
  }));
  const idInput = html.match(/<input[^>]*aria-label="配置 ID"[^>]*>/)?.[0] ?? '';
  assert.doesNotMatch(idInput, /value="new"/);
  assert.match(html, /placeholder="例如：codex"/);
  assert.match(html, /选择账号或渠道/);
  assert.doesNotMatch(html, /claude-opus-5-5/);
  assert.match(html, /placeholder="例如：max"/);
  assert.match(html, /新建父 Agent/);
});

test('the shared save bar waits while the current new agent lacks required choices', () => {
  const saved = defaultConfig();
  const config = structuredClone(saved);
  config.owners.new = blankOwner(config);
  const html = withWindow('#/owners/new', () => markup(React.createElement(RolesPage, { section: 'owners', policy: draft(config, snapshotOf(saved), true) })));
  const save = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0])
    .find(button => button.replace(/<[^>]+>/g, '').trim() === '保存');
  assert.ok(save, 'the save button is shown for a dirty draft');
  assert.match(save, /disabled/);
});

test('editing an existing parent Agent still prefills its saved values', () => {
  const saved = defaultConfig();
  const html = withWindow('#/owners/claude_owner', () => markup(React.createElement(RolesPage, { section: 'owners', policy: draft(structuredClone(saved), snapshotOf(saved)) })));
  assert.match(html, /aria-label="配置 ID"[^>]*value="claude_owner"/);
  assert.match(html, /claude-opus-5-5/);
  assert.match(html, /推理强度/);
});

test('editor sections use the settings page rhythm instead of a 24px gap', () => {
  const url = new URL('../../src/renderer/features/roles/roles-style.ts', import.meta.url);
  assert.match(styleCss(url, rolesStyles.mainBody), /gap:12px/);
});

test('role list rows keep the two-line rhythm: padded rows, a gap above the list, no collapsed options', () => {
  const url = new URL('../../src/renderer/features/roles/roles-style.ts', import.meta.url);
  assert.match(styleCss(url, rolesStyles.row), /padding-block:2px/);
  // StyleX emits the logical start padding as physical top padding in LTR output.
  assert.match(styleCss(url, rolesStyles.listBody), /padding-top:8px/);
  const shared = new URL('../../src/renderer/ui/selectable-list-style.ts', import.meta.url);
  assert.match(styleCss(shared, selectableListStyles.list), /flex:1 1 auto/);
});

test('required hints wait for a touch: a server rejection always shows', () => {
  assert.equal(visibleFieldError('选择模型。', '', false), '');
  assert.equal(visibleFieldError('选择模型。', '', true), '选择模型。');
  assert.equal(visibleFieldError('选择模型。', '模型不存在。', false), '模型不存在。');
  assert.equal(visibleFieldError('', '模型不存在。', true), '模型不存在。');
});

function editorWith(touched: string[]) {
  return {
    pendingId: '', setPendingId: () => {}, freshId: 'new', startNew: () => {}, idError: '', setIdError: () => {},
    acceptId: () => true, askDelete: false, setAskDelete: () => {}, deleting: false, deleteError: '', setDeleteError: () => {},
    confirmDelete: async () => {}, toggling: '', toggle: async () => {}, resuming: '', resume: async () => {},
    diagnostics: {}, setDiagnostics: () => {}, touched: new Set(touched), touch: () => {}, touchAll: () => {},
  } as unknown as React.ComponentProps<typeof RoleEditor>['editor'];
}

function editorHtml(section: 'owners' | 'workers', current: string, touched: string[]) {
  const saved = defaultConfig();
  const config = structuredClone(saved);
  if (section === 'owners') config.owners[current] = blankOwner(config);
  else config.workers[current] = blankWorker(config);
  return markup(React.createElement(RoleEditor, {
    section, policy: draft(config, snapshotOf(saved), true), current, editor: editorWith(touched),
    freeProbe: { unavailable: false, probing: new Set<string>(), probeNow: async () => {} },
    tasks: [], narrow: false, onBack: () => {}, onAdd: () => {},
  }));
}

test('a fresh child form shows no required errors; touching the channel field reveals its hint', () => {
  assert.doesNotMatch(editorHtml('workers', 'new', []), /请至少选择一个账号或渠道/);
  assert.match(editorHtml('workers', 'new', ['channel']), /请至少选择一个账号或渠道/);
});

test('a fresh parent form shows no required errors; touching a field reveals its hint', () => {
  assert.doesNotMatch(editorHtml('owners', 'new', []), /至少添加一个子 Agent/);
  assert.doesNotMatch(editorHtml('owners', 'new', []), /选择账号或渠道。/);
  assert.match(editorHtml('owners', 'new', ['workers']), /至少添加一个子 Agent/);
  assert.match(editorHtml('owners', 'new', ['channel']), /选择账号或渠道。/);
  assert.match(editorHtml('workers', 'new', ['model']), /选择模型。/);
});

test('the shared save bar also waits while the new child agent lacks required choices', () => {
  const saved = defaultConfig();
  const config = structuredClone(saved);
  config.workers.new = blankWorker(config);
  const html = withWindow('#/workers/new', () => markup(React.createElement(RolesPage, { section: 'workers', policy: draft(config, snapshotOf(saved), true) })));
  const save = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0])
    .find(button => button.replace(/<[^>]+>/g, '').trim() === '保存');
  assert.ok(save, 'the save button is shown for a dirty draft');
  assert.match(save, /disabled/);
});
