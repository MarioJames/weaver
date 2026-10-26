import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { taskStyles as styles } from '../../src/renderer/features/tasks/task-style';
import { styleClass } from './style-helpers';
import { TaskBoard, TaskFacets } from '../../src/renderer/features/tasks/TaskBoard';
import { ArchiveList, archiveColumns } from '../../src/renderer/features/tasks/ArchiveDrawer';
import { archivedTasks } from '../../src/renderer/features/tasks/task-archive';
import { FILTER_DIMENSIONS, TIME_RANGES, ARCHIVE_ALL_VALUE, applyTaskFilters, archiveRows, archiveRowValues, archiveSelectOptions, emptySelection, facetOptions, filterLabels, filterOptions, filterSummary, hasFilters, resolveSelection, selectedEntries } from '../../src/renderer/features/tasks/task-filters';
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
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'dark', children: node }) }));
}
/** The pressed chip buttons of a render, as text-bearing markup. */
const pressed = (html: string) => [...html.matchAll(/<button\b[^>]*aria-pressed="true"[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
const board = (selection: TaskSelection, extra: Record<string, unknown> = {}) =>
  storage({}, () => markup(React.createElement(TaskBoard, { tasks, filters: selection, now, loading: false, onSelect: () => {}, ...extra })));

/** Walks a rendered element tree (function components without hooks only) and visits every element. */
function walk(node: React.ReactNode, visit: (element: React.ReactElement) => void): void {
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return; }
  if (!React.isValidElement(node)) return;
  visit(node);
  const props = node.props as { children?: React.ReactNode; leading?: React.ReactNode };
  walk(props.children, visit);
  walk(props.leading, visit);
}
/** The 「全部」 chips of a facet render, as their elements. */
const allChips = (facets: React.ReactElement) => {
  const found: React.ReactElement<{ ariaLabel?: string; checked?: boolean; count?: number; label?: string; onClick: () => void }>[] = [];
  walk(facets, element => {
    const label = (element.props as { ariaLabel?: string }).ariaLabel;
    if (typeof label === 'string' && label.endsWith(' 全部')) found.push(element as React.ReactElement<{ ariaLabel?: string; checked?: boolean; count?: number; label?: string; onClick: () => void }>);
  });
  return found;
};
const facets = (selection: TaskSelection) => TaskFacets({ board: tasks, all: tasks, selection, collapsed: false, now, onChange: () => {}, onCollapse: () => {} });

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
  assert.match(some, new RegExp(`class="${styleClass(styles.facetSelected)}[^"]*"`));
  assert.match(none, new RegExp(`class="${styleClass(styles.facetSelected)}[^"]*"`));
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
  for (const label of ['按时间筛选归档任务', '按状态筛选归档任务', '按父 Agent 筛选归档任务', '按子 Agent 筛选归档任务']) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /按父 Agent筛选|按子 Agent筛选/);
  assert.equal((html.match(new RegExp(`class="${styleClass(styles.archiveFilters)}`, 'g')) ?? []).length, 1);
  const outcome = archiveColumns().find(column => column.key === 'outcome')!;
  const cell = (task: Task) => markup(React.createElement(React.Fragment, null, outcome.render?.(task.title, task, 0) as React.ReactNode));
  assert.match(cell(old[0]), /失败/);
  assert.match(cell(old[1]), /已通过/);
  assert.match(cell(old[2]), /已取消/);
});

test('the card title uses one text flow with the sub agent tag before the title', () => {
  const html = board(sel({}));
  const block = html.match(new RegExp(`<span class="${styleClass(styles.cardTitle)}[^"]*">([\\s\\S]*?)</strong></span>`))?.[1];
  assert.ok(block, 'card title block');
  assert.match(block, /<strong[^>]*>T_/);
  assert.match(block, /w\d/);
  assert.match(block, /w\d[\s\S]*<strong[^>]*>T_/);
  assert.equal((block.match(/<strong/g) ?? []).length, 1);
});

test('tasks without a workspace answer for one 未指定工作目录 option that filters them', () => {
  const draft: Task = { ...make('f', 'queued', 'o1', 'w1', '/p/alpha', hoursAgo(0.3)), workspace: undefined, dispatch: undefined };
  const pool = [...tasks, draft];
  const options = filterOptions(pool, 'workspace', sel({}), now);
  assert.deepEqual(options.filter(option => option.value === '').map(option => [option.label, option.count]), [['未指定工作目录', 1]]);
  assert.deepEqual(applyTaskFilters(pool, sel({ workspace: [''] }), undefined, now).map(task => task.id), ['f']);
  assert.deepEqual(applyTaskFilters(pool, sel({ workspace: ['/p/alpha'] }), undefined, now).map(task => task.id), ['a', 'c']);
  // The empty value can never collide with a real absolute path, and a saved '' choice survives while such a task exists.
  storage({ [TASK_FILTERS_KEY]: JSON.stringify({ time: 'all', workspace: [''] }) }, () => {
    assert.deepEqual(resolveSelection(readTaskFilters(), pool, now).workspace, ['']);
  });
  assert.match(board(sel({}), { tasks: pool }), /未指定工作目录/);
});

test('every multi-select row opens with a 全部 chip: selected on an empty row, cleared rows show it unselected, the time row has none', () => {
  const html = board(sel({}));
  for (const label of ['状态 全部', '父 Agent 全部', '子 Agent 全部', '工作目录 全部']) {
    const chip = [...html.matchAll(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`, 'g'))].map(match => match[0]);
    assert.equal(chip.length, 1, label);
    assert.match(chip[0], /aria-pressed="true"/);
  }
  assert.doesNotMatch(html, /aria-label="时间 全部"/);
  const narrowed = board(sel({ status: ['running'], owner: ['o1'] }));
  assert.match(narrowed, /aria-label="状态 全部"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*aria-label="状态 全部"/);
  assert.match(narrowed, /aria-label="父 Agent 全部"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*aria-label="父 Agent 全部"/);
  for (const label of ['子 Agent 全部', '工作目录 全部']) {
    const chip = [...narrowed.matchAll(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`, 'g'))].map(match => match[0]);
    assert.match(chip[0], /aria-pressed="true"/, label);
  }
});

test('clicking 全部 clears only its own row and writes no sentinel into the selection', () => {
  const calls: TaskSelection[] = [];
  const selection = sel({ status: ['running'], owner: ['o1'], workspace: ['/p/alpha'] });
  const element = TaskFacets({ board: tasks, all: tasks, selection, collapsed: false, now, onChange: next => calls.push(next), onCollapse: () => {} });
  const chips = allChips(element);
  assert.deepEqual(chips.map(chip => chip.props.ariaLabel), ['状态 全部', '父 Agent 全部', '子 Agent 全部', '工作目录 全部']);
  chips.find(chip => chip.props.ariaLabel === '父 Agent 全部')!.props.onClick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], sel({ status: ['running'], workspace: ['/p/alpha'] }));
  assert.ok(!JSON.stringify(calls).includes('__all__'));
  // An already-selected 全部 (empty row) clicks without any change.
  const empty = TaskFacets({ board: tasks, all: tasks, selection: sel({ status: ['running'] }), collapsed: false, now, onChange: next => calls.push(next), onCollapse: () => {} });
  allChips(empty).find(chip => chip.props.ariaLabel === '父 Agent 全部')!.props.onClick();
  assert.equal(calls.length, 1);
});

test('the 全部 chip counts the tasks that match when only its own row is ignored', () => {
  const selection = sel({ status: ['running'], worker: ['w1'] });
  const chips = allChips(facets(selection));
  for (const dimension of FILTER_DIMENSIONS) {
    const chip = chips.find(item => item.props.ariaLabel === `${filterLabels[dimension]} 全部`)!;
    assert.equal(chip.props.count, applyTaskFilters(tasks, selection, dimension, now, tasks).length, dimension);
    assert.equal(chip.props.checked, !selection[dimension].length, dimension);
  }
  assert.equal(chips.find(chip => chip.props.ariaLabel === '子 Agent 全部')!.props.count, 2);
  assert.equal(chips.find(chip => chip.props.ariaLabel === '状态 全部')!.props.count, 3);
});

test('全部 never enters the 已选 summary, the removable entries or hasFilters', () => {
  const html = board(sel({ time: 'today', status: ['running'] }));
  assert.doesNotMatch(html, /移除 全部/);
  assert.doesNotMatch(html, /已选：[\s\S]*全部 [0-9]/);
  const afterAll = sel({ time: 'today', status: [] });
  assert.equal(hasFilters(afterAll), false);
  assert.equal(filterSummary(afterAll, Object.fromEntries(FILTER_DIMENSIONS.map(dimension => [dimension, filterOptions(tasks, dimension, afterAll, now)])) as never), '筛选：今天');
});

test('rows with many options keep every 全部 visible next to 更多', () => {
  const many = Array.from({ length: 12 }, (_, index) => make(`m${index}`, 'queued', 'o1', 'w1', `/p/many${index}`, hoursAgo(0.1)));
  const html = storage({}, () => markup(React.createElement(TaskBoard, { tasks: many, filters: sel({ time: 'today' }), now, loading: false, onSelect: () => {} })));
  assert.match(html, /更多/);
  for (const label of ['状态 全部', '父 Agent 全部', '子 Agent 全部', '工作目录 全部']) assert.match(html, new RegExp(`aria-label="${label}"`), label);
  const workspaceRow = html.slice(html.indexOf('>工作目录<'), html.indexOf('已选：'));
  assert.ok(workspaceRow.indexOf('aria-label="工作目录 全部"') < workspaceRow.indexOf('更多'));
});

test('a row with no options shows its 全部 chip instead of 暂无', () => {
  const html = board(sel({ time: '1h' }));
  const workspaceRow = html.slice(html.indexOf('>工作目录<'), html.indexOf('已选：'));
  assert.match(workspaceRow, /aria-label="工作目录 全部"/);
  assert.doesNotMatch(workspaceRow, /暂无/);
});

test('archive dropdowns open with 全部 N first, counted with the row ignored', () => {
  const old = [
    make('x1', 'failed', 'o1', 'w1', '/p/alpha', hoursAgo(30)),
    make('x2', 'completed', 'o2', 'w2', '/p/beta', hoursAgo(50), { reviewState: 'accepted' }),
    make('x3', 'cancelled', 'o2', 'w1', '/p/beta', hoursAgo(80)),
  ];
  const base = { ...emptySelection(), time: 'all' as const };
  const owner = archiveSelectOptions(old, 'owner', base, now);
  assert.equal(owner[0].value, ARCHIVE_ALL_VALUE);
  assert.equal(owner[0].label, '全部 3');
  assert.deepEqual(owner.slice(1).map(option => option.value), ['o2', 'o1']);
  // The count respects the other rows: status narrowed, the owner row itself never is.
  const narrowed = archiveSelectOptions(old, 'owner', { ...base, status: ['cancelled'] }, now);
  assert.equal(narrowed[0].label, '全部 1');
  assert.deepEqual(narrowed.slice(1).map(option => option.label), ['o2 1']);
  assert.equal(archiveSelectOptions(old, 'status', base, now)[0].label, '全部 3');
  assert.equal(archiveSelectOptions(old, 'worker', { ...base, owner: ['o1'] }, now)[0].label, '全部 1');
});

test('choosing the archive 全部 entry clears the row and never stores the sentinel', () => {
  // An empty row reads as 全部 chosen, so picking values drops it.
  assert.deepEqual(archiveRowValues([], [ARCHIVE_ALL_VALUE, 'o2']), ['o2']);
  assert.deepEqual(archiveRowValues([], ['o1', 'o2']), ['o1', 'o2']);
  // Choosing 全部 over chosen values clears the row.
  assert.deepEqual(archiveRowValues(['o1'], ['o1', ARCHIVE_ALL_VALUE]), []);
  assert.deepEqual(archiveRowValues(['o1', 'o2'], [ARCHIVE_ALL_VALUE]), []);
  // Deselecting 全部 from an empty row stays empty; ordinary changes pass through.
  assert.deepEqual(archiveRowValues([], []), []);
  assert.deepEqual(archiveRowValues(['o1'], []), []);
  assert.deepEqual(archiveRowValues(['o1'], ['o1', 'o2']), ['o1', 'o2']);
  for (const next of [[], [ARCHIVE_ALL_VALUE], [ARCHIVE_ALL_VALUE, 'x'], ['x']]) {
    assert.ok(!archiveRowValues(['o1'], next).includes(ARCHIVE_ALL_VALUE));
    assert.ok(!archiveRowValues([], next).includes(ARCHIVE_ALL_VALUE));
  }
});
