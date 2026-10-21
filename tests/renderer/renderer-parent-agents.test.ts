import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { TaskBoard } from '../../src/renderer/features/tasks/TaskBoard';
import { archiveColumns } from '../../src/renderer/features/tasks/ArchiveDrawer';
import { cardOwner, emptyRootNotice, withOwnerProfiles } from '../../src/renderer/features/tasks/task-view';
import { cardFooter, cardFooterText } from '../../src/renderer/features/tasks/task-footer';
import { archivedTasks, nonArchived } from '../../src/renderer/features/tasks/task-archive';
import { applyTaskFilters, emptySelection, facetOptions, filterOptions, resolveSelection, rootIndex, taskOption } from '../../src/renderer/features/tasks/task-filters';
import { ENDED_EXPANDED_KEY } from '../../src/renderer/features/tasks/task-persistence';

const now = Date.parse('2026-10-19T12:00:00Z');
const hoursAgo = (hours: number) => new Date(now - hours * 3600000).toISOString();
const placeholder = { name: 'Task owner', transport: 'herdr-visible' as const, session: '', pane: '' };
const make = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `任务 ${id}`, instruction: '', owner: placeholder, status: 'running', progress: 0,
  createdAt: hoursAgo(1), updatedAt: hoursAgo(1), events: [], artifacts: [], ...extra,
});
const dispatch = (owner: string, worker: string): Task['dispatch'] => ({ owner, worker, engine: 'claude', engineKind: 'claude', model: '', effort: 'high', execution: 'real', maxParallel: 1 });

/** A-type: a page-created root with its children; the children answer for the root by parentTaskId. */
const root1 = make('root1', { executionRole: 'owner', title: '重构登录页', ownerId: 'inst-root1' });
const childA1 = make('c1', { parentTaskId: 'root1', ownerId: 'inst-root1', status: 'running', dispatch: dispatch('claude_owner', 'w1') });
const childA2 = make('c2', { parentTaskId: 'root1', ownerId: 'inst-root1', status: 'queued', dispatch: dispatch('claude_owner', 'w2') });
/** B-type: a manually attached parent Agent instance; its tasks carry the instance id and no root. */
const taskB = make('b1', { ownerId: 'inst-b', owner: { ...placeholder, name: 'Claude · weaver · 22:37' }, dispatch: dispatch('claude_owner', 'w3') });
/** Legacy fallback: no registration name, no root; the frozen policy profile answers. */
const legacy = make('l1', { status: 'failed', dispatch: dispatch('legacy_owner', 'w4') });
/** A-type roots with no children at all: one splitting, one failed. */
const root2 = make('root2', { executionRole: 'owner', title: '迁移数据库' });
const root3 = make('root3', { executionRole: 'owner', title: '部署预览环境', status: 'failed', failure: { kind: 'other', message: 'herdr 未安装' } });
const tasks = [root1, childA1, childA2, taskB, legacy, root2, root3];
const everything = { ...emptySelection(), time: 'all' as const };

function storage<T>(values: Record<string, string>, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } } });
  try { return run(); } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}
function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) }));
}
function board(selection: Partial<typeof everything> = {}, list: Task[] = tasks) {
  return storage({ [ENDED_EXPANDED_KEY]: 'true' }, () => markup(React.createElement(TaskBoard, { tasks: list, filters: { ...everything, ...selection }, now, loading: false, onSelect: () => {} })));
}
const cards = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).filter(card => card.includes('<time'));

test('the board columns hold exactly the sub agent tasks, each in its own status column', () => {
  const lanes = nonArchived(tasks, now).map(task => task.id);
  assert.deepEqual(lanes, ['c1', 'c2', 'b1', 'l1']);
  const html = board();
  const rendered = cards(html).map(card => card.match(/任务 (c1|c2|b1|l1|root1)/)?.[1]);
  assert.deepEqual(rendered.sort(), ['b1', 'c1', 'c2', 'l1']);
  assert.ok(cards(html).every(card => !card.includes('父 Agent</span>') || !card.includes('taskCard')));
  // Selecting the root leaves only its children on the board.
  assert.deepEqual(applyTaskFilters(nonArchived(tasks, now), { ...everything, owner: ['root1'] }, undefined, now, tasks).map(task => task.id), ['c1', 'c2']);
  // A retried child is a finished task like any other, shown once in 已结束.
  const retried = [root1, make('c0', { parentTaskId: 'root1', ownerId: 'inst-root1', status: 'failed', updatedAt: hoursAgo(2), dispatch: dispatch('claude_owner', 'w1') }), make('c1r', { parentTaskId: 'root1', ownerId: 'inst-root1', status: 'running', retryOf: 'c0', dispatch: dispatch('claude_owner', 'w1') })];
  const boardHtml = board({}, retried);
  assert.ok(cards(boardHtml).some(card => card.includes('任务 c0')));
  assert.ok(cards(boardHtml).some(card => card.includes('任务 c1r')));
  assert.equal(cards(boardHtml).length, 2);
});

test('A-type parent options answer by root id and are named by the root title, counted by their children', () => {
  const options = filterOptions(tasks, 'owner', everything, now);
  const a = options.find(option => option.value === 'root1');
  assert.ok(a);
  assert.equal(a.label, '重构登录页');
  assert.equal(a.title, '重构登录页');
  assert.equal(a.count, 2);
  // Children and the root itself answer with the same option.
  assert.equal(taskOption(childA1, 'owner', rootIndex(tasks))?.value, 'root1');
  assert.equal(taskOption(root1, 'owner', rootIndex(tasks))?.value, 'root1');
  assert.equal(taskOption(root1, 'owner', rootIndex(tasks))?.status, 'running');
});

test('B-type parent options answer by instance id, named by the abbreviated instance with the full name on hover', () => {
  const options = filterOptions(tasks, 'owner', everything, now);
  const b = options.find(option => option.value === 'inst-b');
  assert.ok(b);
  assert.equal(b.label, 'Claude · 22:37');
  assert.equal(b.title, 'Claude · weaver · 22:37');
  assert.equal(b.count, 1);
  assert.notEqual(b.label, 'Task owner');
});

test('legacy tasks without a name or a root fall back to their policy profile option', () => {
  const options = filterOptions(tasks, 'owner', everything, now);
  const fallback = options.find(option => option.value === 'legacy_owner');
  assert.ok(fallback);
  assert.equal(fallback.label, 'legacy_owner');
  assert.equal(fallback.count, 1);
});

test('a root with no children still offers itself at count 0 with a readable status, and is not hidden by other rows', () => {
  const options = filterOptions(tasks, 'owner', everything, now);
  const splitting = options.find(option => option.value === 'root2');
  const failed = options.find(option => option.value === 'root3');
  assert.ok(splitting && failed);
  assert.equal(splitting.count, 0);
  assert.equal(splitting.ownerStatus, 'running');
  assert.equal(failed.ownerStatus, 'failed');
  // Other rows never hide it; only the time scope counts its (absent) children.
  assert.ok(filterOptions(tasks, 'owner', { ...everything, status: ['failed'] }, now).some(option => option.value === 'root2'));
  // A root that has aged into the archive is not offered on the board.
  const stale = make('root4', { executionRole: 'owner', title: '过期根任务', status: 'failed', updatedAt: hoursAgo(30) });
  assert.ok(!filterOptions([stale], 'owner', everything, now).some(option => option.value === 'root4'));
});

test('the owner chips show the root status dot and a spinner while the root runs', () => {
  const html = board();
  const chip = (value: string) => [...html.matchAll(/<button\b[^>]*aria-pressed="true"[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(() => false);
  const chips = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
  const root2chip = chips.find(chipText => chipText.includes('迁移数据库'));
  const root3chip = chips.find(chipText => chipText.includes('部署预览环境'));
  assert.ok(root2chip && root3chip);
  assert.match(root2chip, /data-tone="processing"/);
  assert.match(root2chip, /lucide-loader-2/);
  assert.match(root3chip, /data-tone="error"/);
  assert.doesNotMatch(root3chip, /lucide-loader-2/);
  assert.equal(chip('root1'), undefined);
});

test('selecting a childless root empties the columns and explains what happens, with a path to the root detail', () => {
  const splitting = board({ owner: ['root2'] });
  assert.match(splitting, /父 Agent「迁移数据库」正在拆分任务，子任务会自动出现在这里。/);
  assert.match(splitting, /aria-label="[^"]*查看父任务|>查看父任务</);
  assert.equal(cards(splitting).length, 0);
  const failed = board({ owner: ['root3'] });
  assert.match(failed, /父 Agent「部署预览环境」启动失败，没有创建子任务：herdr 未安装/);
  assert.match(failed, /查看父任务/);
  // The notice speaks for the root task only; a selected parent with children behaves as before.
  assert.equal(emptyRootNotice(root2), '父 Agent「迁移数据库」正在拆分任务，子任务会自动出现在这里。');
  assert.equal(emptyRootNotice({ ...root2, status: 'cancelled' as const }), '父 Agent「迁移数据库」已取消，没有子任务。');
});

test('stale saved parent values are dropped or remapped, never an error', () => {
  // The old payload named a B-type parent by its full instance name; the new value is the instance id.
  const resolved = resolveSelection({ ...everything, owner: ['Claude · weaver · 22:37', 'inst-b', 'ghost-owner', 'legacy_owner'] }, tasks, now);
  assert.deepEqual(resolved.owner, ['inst-b', 'legacy_owner']);
});

test('card footers name the parent Agent: root title for A-type children, instance abbreviations for B-type', () => {
  const html = board();
  const childCard = cards(html).find(card => card.includes('任务 c1'))!;
  assert.ok(childCard);
  assert.match(childCard, /aria-label="父 Agent：重构登录页"/);
  assert.match(childCard, /title="重构登录页"/);
  assert.match(childCard, /重构登录页/);
  assert.doesNotMatch(childCard, /Task owner|claude_owner/);
  const bCard = cards(html).find(card => card.includes('任务 b1'))!;
  assert.match(bCard, /aria-label="父 Agent：Claude"/);
  assert.match(bCard, /title="Claude · weaver · 22:37"/);
  assert.doesNotMatch(bCard.replace(/title="[^"]*"/g, ''), /weaver/);
  // The pure sentence keeps the same names for text renderings.
  const footer = cardFooter(childA1, cardOwner(childA1, id => rootIndex(tasks).get(id)));
  assert.equal(footer.owner, '重构登录页');
  assert.match(cardFooterText(footer, now), /^由 重构登录页 于/);
});

test('the archive holds the finished children as rows, never the root, with the same parent names and values', () => {
  const old = hoursAgo(40);
  const past = [
    make('oldroot', { executionRole: 'owner', title: '历史根任务', ownerId: 'inst-old', status: 'completed', reviewState: 'accepted', updatedAt: old }),
    make('oldchild', { parentTaskId: 'oldroot', ownerId: 'inst-old', status: 'completed', reviewState: 'accepted', updatedAt: old, dispatch: dispatch('claude_owner', 'w9') }),
  ];
  assert.deepEqual(archivedTasks(past, now).map(task => task.id), ['oldchild']);
  // The archive's owner options come from its child rows and keep the root's value and name (facetOptions over the archived pool, as the drawer does).
  const options = facetOptions(archivedTasks(past, now), 'owner', { ...emptySelection(), time: 'all' }, now, past);
  assert.deepEqual(options.map(option => [option.value, option.label, option.count]), [['oldroot', '历史根任务', 1]]);
});

/** A manually described instance: the backend carries a short title for the instance's current main task. */
const described = { id: 'inst-t', name: 'Claude · weaver · 22:37', profileId: 'claude_owner', title: '修复登录崩溃' };
const taskT = make('t1', { ownerId: 'inst-t', owner: { ...placeholder, name: 'Claude · weaver · 22:37' }, dispatch: dispatch('claude_owner', 'w5') });
const enriched = withOwnerProfiles([root1, childA1, taskB, legacy, taskT], [described, { id: 'inst-b', name: 'Claude · weaver · 22:37', profileId: 'claude_owner' }]);

test('a described B-type instance names the filter option by its title with the full instance name on hover', () => {
  const options = filterOptions(enriched, 'owner', everything, now);
  const titled = options.find(option => option.value === 'inst-t');
  assert.ok(titled);
  assert.equal(titled.label, '修复登录崩溃');
  assert.equal(titled.title, '修复登录崩溃 · Claude · weaver · 22:37');
  assert.equal(titled.count, 1);
  // The value stays the instance id, so filter memory is untouched.
  assert.equal(taskOption(taskT, 'owner', rootIndex(tasks))?.value, 'inst-t');
  // An instance without a title keeps the abbreviated instance name.
  const untitled = options.find(option => option.value === 'inst-b');
  assert.equal(untitled?.label, 'Claude · 22:37');
  assert.equal(untitled?.title, 'Claude · weaver · 22:37');
});

test('card bottoms show the described title and hover the full instance name; A-type children are untouched', () => {
  const enrichedT = enriched.find(task => task.id === 't1')!;
  const owner = cardOwner(enrichedT);
  assert.deepEqual(owner, { name: '修复登录崩溃', title: '修复登录崩溃 · Claude · weaver · 22:37' });
  // Without a description the abbreviation stays.
  const bare = cardOwner(taskB);
  assert.deepEqual(bare, { name: 'Claude', title: 'Claude · weaver · 22:37' });
  // A-type children still answer by their root task even when instance titles are present.
  assert.deepEqual(cardOwner(childA1, id => rootIndex(tasks).get(id)), { name: '重构登录页', title: '重构登录页' });
  // The board card and its footer sentence read the same names.
  const html = board({}, enriched);
  const card = cards(html).find(card => card.includes('任务 t1'))!;
  assert.match(card, /aria-label="父 Agent：修复登录崩溃"/);
  assert.match(card, /title="修复登录崩溃 · Claude · weaver · 22:37"/);
  assert.match(card, /修复登录崩溃/);
  assert.doesNotMatch(card.replace(/title="[^"]*"/g, ''), /weaver/);
  const footer = cardFooter(taskT, owner);
  assert.equal(footer.owner, '修复登录崩溃');
});

test('the archive parent Agent column shows the described title with the full instance name on hover', () => {
  const agents = archiveColumns().find(column => column.key === 'agents')!;
  const cell = (task: Task) => markup(React.createElement(React.Fragment, null, agents.render?.('', task, 0) as React.ReactNode));
  const titled = cell(enriched.find(task => task.id === 't1')!);
  assert.match(titled, /title="修复登录崩溃 · Claude · weaver · 22:37"/);
  assert.match(titled, /修复登录崩溃/);
  const bare = cell(taskB);
  assert.match(bare, /title="Claude · weaver · 22:37"/);
  assert.match(bare.replace(/title="[^"]*"/g, ''), /Claude(?!\s*·\s*weaver)/);
});
