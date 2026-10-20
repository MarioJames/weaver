import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { taskStyles as styles } from '../../src/renderer/features/tasks/task-style';
import { TaskBoard } from '../../src/renderer/features/tasks/TaskBoard';
import { ArchiveList, archiveColumns } from '../../src/renderer/features/tasks/ArchiveDrawer';
import { archivedTasks } from '../../src/renderer/features/tasks/task-archive';
import { FILTER_DIMENSIONS, TIME_RANGES, applyTaskFilters, archiveRows, emptySelection, facetOptions, filterOptions, filterSummary, resolveSelection, selectedEntries } from '../../src/renderer/features/tasks/task-filters';
import { FILTERS_COLLAPSED_KEY, TASK_FILTERS_KEY, readFiltersCollapsed, readTaskFilters, writeFiltersCollapsed } from '../../src/renderer/features/tasks/task-persistence';
import type { TaskSelection } from '../../src/renderer/features/tasks/task-filters';

const now = Date.parse('2026-10-18T12:00:00Z');
const hoursAgo = (hours: number) => new Date(now - hours * 3600000).toISOString();
const make = (id: string, status: Task['status'], owner: string, worker: string, workspace: string, updatedAt: string, extra: Partial<Task> = {}): Task => ({
  id, title: `T_${id}`, workspace, instruction: '', owner: { name: 'Task owner', transport: 'herdr-visible', session: '', pane: '' },
  status, progress: 0, createdAt: updatedAt, updatedAt, events: [], artifacts: [],
  dispatch: { owner, worker, engine: 'custom', engineKind: 'claude', model: '', effort: '', execution: 'real', maxParallel: 1, workspace },
  ...extra,
});
const tasks: Task[] = [
  make('a', 'running', 'o1', 'w1', '/p/alpha', hoursAgo(0.2)),
  make('b', 'queued', 'o1', 'w2', '/p/beta', hoursAgo(0.5)),
  make('c', 'completed', 'o2', 'w2', '/p/alpha', hoursAgo(3), { reviewState: 'accepted' }),
  make('d', 'failed', 'o2', 'w1', '/p/gamma', hoursAgo(12)),
  make('e', 'running', 'o1', 'w1', '/p/delta', hoursAgo(100)),
];
const sel = (part: Partial<TaskSelection>): TaskSelection => ({ ...emptySelection(), time: 'all', ...part });
const rows = (dimension: (typeof FILTER_DIMENSIONS)[number], selection: TaskSelection) => filterOptions(tasks, dimension, selection, now).map(option => [option.value, option.count]);

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
/** The pressed chip buttons of a render, as text-bearing markup. */
const pressed = (html: string) => [...html.matchAll(/<button\b[^>]*aria-pressed="true"[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
const board = (selection: TaskSelection, extra: Record<string, unknown> = {}) =>
  storage({}, () => markup(React.createElement(TaskBoard, { tasks, filters: selection, now, loading: false, onSelect: () => {}, ...extra })));

test('dimensions are 状态, 父 Agent, 子 Agent, 工作目录 and the time ranges start with 今天', () => {
  assert.deepEqual([...FILTER_DIMENSIONS], ['status', 'owner', 'worker', 'workspace']);
  assert.deepEqual(TIME_RANGES.map(range => range.label), ['今天', '近 1 小时', '近 24 小时', '近 7 天', '近 30 天', '全部']);
  assert.deepEqual(emptySelection(), { status: [], owner: [], worker: [], workspace: [], time: 'today' });
});

test('time scopes every row: options exist only for tasks inside the range and counts are taken there', () => {
  assert.deepEqual(rows('owner', sel({ time: '1h' })), [['o1', 2]]);
  assert.deepEqual(rows('workspace', sel({ time: '1h' })), [['/p/alpha', 1], ['/p/beta', 1]]);
  assert.deepEqual(rows('owner', sel({ time: '24h' })), [['o1', 2], ['o2', 2]]);
  assert.deepEqual(rows('worker', sel({ time: 'all' })), [['w1', 3], ['w2', 2]]);
  assert.deepEqual(rows('status', sel({ time: 'all' })), [['queued', 1], ['running', 2], ['accepted', 1], ['failed', 1]]);
});

test('counts are faceted: other rows narrow them, a row never narrows itself', () => {
  assert.deepEqual(rows('owner', sel({ worker: ['w1'] })), [['o1', 2], ['o2', 1]]);
  assert.deepEqual(rows('worker', sel({ worker: ['w1'], owner: ['o2'] })), [['w1', 1], ['w2', 1]]);
  assert.deepEqual(rows('status', sel({ owner: ['o1'], workspace: ['/p/alpha', '/p/beta'] })), [['queued', 1], ['running', 1]]);
});

test('a selected value with nothing in scope stays listed with count 0; unselected empty values do not', () => {
  const selection = sel({ time: '1h', owner: ['o2'] });
  assert.deepEqual(rows('owner', selection), [['o1', 2], ['o2', 0]]);
  assert.deepEqual(applyTaskFilters(tasks, selection, undefined, now), []);
  assert.deepEqual(rows('workspace', selection), []);
  assert.deepEqual(rows('status', sel({ time: '1h', status: ['failed'] })), [['queued', 1], ['running', 1], ['failed', 0]]);
});

test('OR within a row, AND across rows, including the status row', () => {
  assert.deepEqual(applyTaskFilters(tasks, sel({ status: ['running', 'failed'] }), undefined, now).map(task => task.id), ['a', 'd', 'e']);
  assert.deepEqual(applyTaskFilters(tasks, sel({ status: ['running', 'failed'], owner: ['o1'] }), undefined, now).map(task => task.id), ['a', 'e']);
  assert.deepEqual(applyTaskFilters(tasks, sel({ time: '24h', status: ['running'], worker: ['w1'], workspace: ['/p/alpha'] }), undefined, now).map(task => task.id), ['a']);
});

test('status values are display statuses and sort in the shared scheme order', () => {
  const options = facetOptions(tasks, 'status', sel({}), now);
  assert.deepEqual(options.map(option => option.label), ['待执行', '执行中', '已通过', '失败']);
});

test('summary lists chosen values as entries and as one line; chosen but absent values keep their name', () => {
  const selection = sel({ time: 'today', status: ['running'], owner: ['o1', 'ghost'] });
  const options = Object.fromEntries(FILTER_DIMENSIONS.map(dimension => [dimension, filterOptions(tasks, dimension, selection, now)])) as never;
  assert.deepEqual(selectedEntries(selection, options).map(entry => [entry.dimension, entry.value, entry.label]), [['status', 'running', '执行中'], ['owner', 'o1', 'o1'], ['owner', 'ghost', 'ghost']]);
  assert.equal(filterSummary(selection, options), '筛选：今天 · 执行中 · o1 · ghost');
  assert.equal(filterSummary(emptySelection(), options), '筛选：今天');
});

test('collapsed state persists; selection with legacy and dropped dimensions loads', () => {
  const values: Record<string, string> = {};
  storage(values, () => {
    assert.equal(readFiltersCollapsed(), false);
    writeFiltersCollapsed(true);
    assert.equal(values[FILTERS_COLLAPSED_KEY], 'true');
    assert.equal(readFiltersCollapsed(), true);
    values[TASK_FILTERS_KEY] = JSON.stringify({ owner: ['o1'], engine: ['x'], time: '7d' });
    assert.deepEqual(readTaskFilters(), { status: [], owner: ['o1'], worker: [], workspace: [], time: '7d' });
  });
});

test('stale choices are dropped but ones that still name board work survive outside the time scope', () => {
  const stored = sel({ time: '1h', status: ['failed', 'cancelled'], owner: ['o2', 'ghost'] });
  assert.deepEqual(resolveSelection(stored, tasks, now), sel({ time: '1h', status: ['failed'], owner: ['o2'] }));
});

test('the board renders rows in order with chips, counts, status dots and no search box', () => {
  const html = board(sel({ time: '24h' }));
  const order = ['时间', '状态', '父 Agent', '子 Agent', '工作目录', '已选：'].map(label => html.indexOf(`>${label}<`));
  assert.ok(order.every(index => index > 0), `labels missing: ${order}`);
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.doesNotMatch(html, /搜索|aria-label="搜索任务"|<input/);
  assert.ok(pressed(html).some(chip => chip.includes('近 24 小时')));
  assert.match(html, /执行中[\s\S]{0,120}>1</);
  assert.match(html, /data-tone="processing"/);
  assert.match(html, /<title>Claude Code<\/title>/);
  assert.match(html, /title="\/p\/alpha"/);
  assert.match(html, /清除全部/);
  /** Time scopes the options: o1/o2 exist at 24h, 100h-old delta does not. */
  assert.doesNotMatch(html, />delta</);
});

test('a chosen value without tasks in scope renders checked with count 0', () => {
  const html = board(sel({ time: '1h', owner: ['o2'] }));
  assert.ok(pressed(html).some(chip => chip.includes('o2') && /<span[^>]*>0<\/span>/.test(chip)));
});

test('the 已选 row is always present so selecting does not move the board', () => {
  const none = board(emptySelection());
  const some = board(sel({ time: 'today', owner: ['o1'] }));
  assert.match(none, /已选：/);
  assert.match(some, /已选：/);
  assert.equal(none.indexOf('data-status-column="queued"') > 0, true);
  assert.match(some, new RegExp(`class="${styles.facetSelected}[^"]*"`));
  assert.match(none, new RegExp(`class="${styles.facetSelected}[^"]*"`));
});

test('collapsed block is one summary line and keeps the board', () => {
  const html = storage({ [FILTERS_COLLAPSED_KEY]: 'true' }, () => markup(React.createElement(TaskBoard, { tasks, filters: sel({ time: 'today', status: ['running'], owner: ['o1'] }), now, loading: false, onSelect: () => {} })));
  assert.match(html, /筛选：今天 · 执行中 · o1/);
  assert.doesNotMatch(html, />工作目录</);
  assert.match(html, /data-status-column="running"/);
});

test('rows with many options offer 更多 and stay one line', () => {
  const many = Array.from({ length: 12 }, (_, index) => make(`m${index}`, 'queued', 'o1', 'w1', `/p/many${index}`, hoursAgo(0.1)));
  const html = storage({}, () => markup(React.createElement(TaskBoard, { tasks: many, filters: sel({ time: 'today' }), now, loading: false, onSelect: () => {} })));
  assert.match(html, /更多/);
  assert.match(html, /aria-expanded="false"[^>]*>(?:(?!<\/button>)[\s\S])*更多/);
});

test('archive: one row of selects, no search box, shared status tags, 全部 time by default', () => {
  const old = [
    make('x1', 'failed', 'o1', 'w1', '/p/alpha', hoursAgo(30)),
    make('x2', 'completed', 'o2', 'w2', '/p/beta', hoursAgo(50), { reviewState: 'accepted' }),
    make('x3', 'cancelled', 'o2', 'w1', '/p/beta', hoursAgo(80)),
  ];
  assert.deepEqual(archiveRows(old, sel({}), now).map(task => task.id), ['x1', 'x2', 'x3']);
  assert.deepEqual(archiveRows(old, sel({ owner: ['o2'], status: ['cancelled'] }), now).map(task => task.id), ['x3']);
  assert.deepEqual(archiveRows(old, sel({ time: '7d', status: ['failed', 'accepted'] }), now).map(task => task.id), ['x1', 'x2']);
  assert.equal(archivedTasks(old, now).length, 3);
  /** The table itself needs the bundled module graph, so the selects render over an empty archive and the cells render directly. */
  const html = markup(React.createElement(ArchiveList, { tasks: [], onSelect: () => {}, now }));
  assert.doesNotMatch(html, /搜索|<input[^>]*placeholder/);
  for (const label of ['时间', '父 Agent', '子 Agent', '状态']) assert.match(html, new RegExp(`按${label}\\s*筛选归档任务`));
  assert.equal((html.match(new RegExp(`class="${styles.archiveFilters}`, 'g')) ?? []).length, 1);
  const outcome = archiveColumns().find(column => column.key === 'outcome')!;
  const cell = (task: Task) => markup(React.createElement(React.Fragment, null, outcome.render?.(task.title, task, 0) as React.ReactNode));
  assert.match(cell(old[0]), /失败/);
  assert.match(cell(old[1]), /已通过/);
  assert.match(cell(old[2]), /已取消/);
});

test('the card title uses one text flow with the sub agent tag before the title', () => {
  const html = board(sel({}));
  const block = html.match(new RegExp(`<span class="${styles.cardTitle}[^"]*">([\\s\\S]*?)</strong></span>`))?.[1];
  assert.ok(block, 'card title block');
  assert.match(block, /<strong[^>]*>T_/);
  assert.match(block, /w\d/);
  assert.match(block, /w\d[\s\S]*<strong[^>]*>T_/);
  assert.equal((block.match(/<strong/g) ?? []).length, 1);
  const source = styles.cardTitle;
  assert.ok(source.length > 0);
});
