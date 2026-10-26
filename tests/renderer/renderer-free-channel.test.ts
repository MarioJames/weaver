import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../../src/main/policy/routing';
import { FREE_PROBE_BLOCK_BY } from '../../src/shared/policy/blocks';
import type { Block, Config } from '../../src/shared/contracts/policy';
import type { Task } from '../../src/shared/contracts/tasks';
import { RolesPage } from '../../src/renderer/features/roles/RolesPage';
import { OwnerScheduleFields } from '../../src/renderer/features/roles/OwnerSchedule';
import { TaskAgents } from '../../src/renderer/features/tasks/TaskAgents';
import { TaskBoard } from '../../src/renderer/features/tasks/TaskBoard';
import { freeChannelLookup } from '../../src/renderer/features/tasks/task-view';
import { emptySelection } from '../../src/renderer/features/tasks/task-filters';
import { ENDED_EXPANDED_KEY } from '../../src/renderer/features/tasks/task-persistence';
import type { PolicyDraft } from '../../src/renderer/policy/usePolicyDraft';

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'dark', children: node }) }));
}
function withStorage<T>(run: () => T): T {
  const values: Record<string, string> = { [ENDED_EXPANDED_KEY]: 'true' };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } } });
  try { return run(); } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('freeChannelLookup answers from the saved policy and is false for anything unconfigured', () => {
  const config = defaultConfig();
  const freeChannel = freeChannelLookup(config);
  assert.equal(freeChannel('qoder_worker'), true);
  assert.equal(freeChannel('claude_worker'), false);
  assert.equal(freeChannel('gone_worker'), false);
  assert.equal(freeChannel(undefined), false);
  assert.equal(freeChannelLookup(undefined)('qoder_worker'), false);
  const draft = defaultConfig();
  delete (draft.workers.qoder_worker as Config['workers'][string]).free_channel;
  assert.equal(freeChannelLookup(draft)('qoder_worker'), false);
});

/** The sub agent list pane only: the editor form mentions 免费渠道 in its own checkbox label. */
function workerList(config: Config): string {
  const html = markup(React.createElement(RolesPage, { section: 'workers', policy: { config } as PolicyDraft }));
  const start = html.indexOf('<nav aria-label="子 Agent 列表"');
  const end = html.indexOf('</nav>', start);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}

test('the sub agent list shows the cyan free-channel tag exactly on the free workers, beside any pause note', () => {
  const html = workerList(defaultConfig());
  assert.equal((html.match(/免费渠道</g) ?? []).length, 2, 'qoder_worker and opencode_worker are free, the others are not');
  const rowOf = (id: string) => {
    const start = html.indexOf(`>${id}</strong>`);
    assert.ok(start >= 0, `${id} is listed`);
    const end = html.indexOf('</button>', start);
    return html.slice(start, end);
  };
  for (const id of ['qoder_worker', 'opencode_worker']) {
    const row = rowOf(id);
    assert.match(row, /免费渠道/);
    assert.match(row, /--lobe-cyan/, 'the badge uses the freeChannel color, not the plain default');
    assert.ok(row.indexOf('免费渠道') < row.indexOf(' · '), 'the badge sits in the title row before the engine · model line');
  }
  assert.doesNotMatch(rowOf('claude_worker'), /免费渠道/);
});

test('a sub agent without the flag gets no free-channel badge in the list', () => {
  const config = defaultConfig();
  delete config.workers.qoder_worker!.free_channel;
  delete config.workers.opencode_worker!.free_channel;
  const html = workerList(config);
  assert.doesNotMatch(html, /免费渠道/);
  assert.doesNotMatch(html, /--lobe-cyan/);
});

/** A saved policy whose qoder_worker is paused by the free probe, so the list item carries a pause note. */
function pausedPolicy() {
  const config = defaultConfig();
  const profile = config.workers.qoder_worker!;
  const block: Block = { engine: defaultConfig().channels[profile.channels[0]!]!.engine, model: profile.model, reason: '额度耗尽：免费额度已用完', since: '2026-10-19T00:00:00Z', by: FREE_PROBE_BLOCK_BY };
  const snapshot = { revision: 1, config, blocks: [block], activeBlocks: [block], owners: {}, workers: { qoder_worker: { status: 'blocked', reason: '免费额度已用完' } }, execution: 'disabled' } as unknown as PolicyDraft['snapshot'];
  return { config, snapshot };
}

/** A free worker that is also paused keeps both the badge and the note, and neither overflows the pane. */
test('the free-channel badge and a pause note coexist in one list item, badge first, both wrapped', () => {
  const { config, snapshot } = pausedPolicy();
  const html = markup(React.createElement(RolesPage, { section: 'workers', policy: { config, snapshot } as PolicyDraft }));
  const start = html.indexOf('>qoder_worker</strong>');
  const row = html.slice(start, html.indexOf('</button>', start));
  assert.match(row, /免费额度用完/);
  assert.match(row, /免费渠道/);
  assert.ok(row.indexOf('免费渠道') < row.indexOf('免费额度用完'), 'the badge sits in the title row, the pause note below it');
});

test('the schedule weights show the free-channel tag per row; paid rows stay plain', () => {
  const config = defaultConfig();
  const html = withStorage(() => markup(React.createElement(OwnerScheduleFields, { config, blocks: [], record: config.owners.claude_owner, update: () => {} })));
  // claude_owner lists claude_worker (paid), qoder_worker and opencode_worker (free), grok_worker (paid).
  assert.equal((html.match(/免费渠道</g) ?? []).length, 2);
  const rows = html.split('aria-label="claude_worker 的权重"');
  assert.doesNotMatch(rows[0].slice(rows[0].lastIndexOf('listRow')), /免费渠道/);
});

test('board cards show the same free-channel badge for dispatches to free workers only', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const base: Task = {
    id: 'card', ownerId: 'parent-instance', title: 'FREE_CARD', workspace: '/projects/alpha', instruction: '',
    owner: { name: 'Parent', transport: 'herdr-visible', session: '', pane: '' },
    status: 'running', progress: 0, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    events: [], artifacts: [],
    dispatch: { owner: 'parent', worker: 'qoder_worker', engine: 'qoder', engineKind: 'qodercli', model: '', effort: '', execution: 'real', maxParallel: 1, workspace: '/frozen' },
  };
  const board = (task: Task, freeChannel?: (workerId?: string) => boolean) => withStorage(() =>
    markup(React.createElement(TaskBoard, { tasks: [task], filters: { ...emptySelection(), time: 'all' }, now, loading: false, onSelect: () => {}, freeChannel })));
  const card = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(match => match[0].includes('FREE_CARD'))![0];
  const free = card(board(base, freeChannelLookup(defaultConfig())));
  assert.match(free, /免费渠道/);
  assert.match(free, /--lobe-cyan/);
  assert.doesNotMatch(card(board({ ...base, dispatch: { ...base.dispatch!, worker: 'claude_worker', engine: 'claude', engineKind: 'claude' } }, freeChannelLookup(defaultConfig()))), /免费渠道/);
  assert.doesNotMatch(card(board(base)), /免费渠道/, 'no policy, no badge');
  // An undispatched task and the 父 Agent role tag never carry it.
  assert.doesNotMatch(board({ ...base, dispatch: undefined }, freeChannelLookup(defaultConfig())), /免费渠道/);
});

test('the root task child list marks children dispatched to free workers', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 's', pane: 'p' };
  const make = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: `任务 ${id}`, instruction: 'x', owner, status: 'running', progress: 0, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), events: [], artifacts: [], ...extra });
  const root = make('root', { executionRole: 'owner', title: '根任务' });
  const child = (id: string, worker: string, engine: string, engineKind: string): Task => make(id, {
    parentTaskId: 'root', title: `子任务 ${id}`,
    dispatch: { owner: 'parent', worker, engine, engineKind, model: '', effort: '', execution: 'real', maxParallel: 1, workspace: '/frozen' },
  });
  const tasks = [root, child('free', 'qoder_worker', 'qoder', 'qodercli'), child('paid', 'claude_worker', 'claude', 'claude'), make('nodispatch', { parentTaskId: 'root' })];
  const html = withStorage(() => markup(React.createElement(TaskAgents, { task: root, tasks, onSelect: () => {}, freeChannel: freeChannelLookup(defaultConfig()) })));
  assert.equal((html.match(/免费渠道</g) ?? []).length, 1);
  const freeRow = html.slice(html.indexOf('子任务 free'), html.indexOf('子任务 paid'));
  assert.match(freeRow, /--lobe-cyan/);
  assert.doesNotMatch(html, /任务 nodispatch[\s\S]*免费渠道/);
  const paid = withStorage(() => markup(React.createElement(TaskAgents, { task: root, tasks: [root, tasks[2]], onSelect: () => {}, freeChannel: freeChannelLookup(defaultConfig()) })));
  assert.doesNotMatch(paid, /免费渠道/);
});
