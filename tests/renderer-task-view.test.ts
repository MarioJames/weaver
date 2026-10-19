import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Config } from '../src/shared/policy';
import type { Task } from '../src/shared/types';
import { ALL_OWNERS, ARCHIVE_AFTER_MS, ENDED_EXPANDED_KEY, TASK_FILTERS_KEY, UNASSIGNED_OWNER, applyTaskFilters, archiveRows, archivedTasks, columnize, dispatchKind, emptySelection, filterButtonLabel, filterByOwner, filterOptions, filterTasks, hasFilters, isArchived, isOpenTask, nonArchived, ownerKindLookup, ownerLabel, projectLabel, readEndedExpanded, readTaskFilters, resolveSelection, taskColumn, taskOwnerId, taskOption, toggleOption, writeEndedExpanded, writeTaskFilters } from '../src/renderer/task-view';
import type { FilterDimension, TaskSelection } from '../src/renderer/task-view';
import { EngineIcon, AgentLabel } from '../src/renderer/components/EngineIcon';
import { ArchiveList, archiveColumns, archiveRowProps } from '../src/renderer/components/ArchiveDrawer';
import { TaskBoard, filterItems, filterReveal } from '../src/renderer/components/TaskBoard';
import { TaskDetail } from '../src/renderer/components/TaskDetail';
import { OwnerInspector } from '../src/renderer/components/OwnerInspector';

function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 'unverified', pane: 'unverified' };
const unassigned: Task = { id: 't1', title: '重排任务面板', instruction: 'Rework the board', owner, status: 'completed', progress: 100, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z', events: [], artifacts: [] };
const dispatch = { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'sonnet', effort: 'high', execution: 'real' as const, maxParallel: 2, workspace: '/home/mocha/opensource/weaver' };
const claude: Task = { ...unassigned, id: 't2', title: '接入新引擎', status: 'running', progress: 20, updatedAt: '2026-10-18T01:00:00Z', dispatch, events: [{ id: 'e1', at: '2026-10-18T01:00:00Z', kind: 'log', message: 'Reading TaskBoard.tsx' }] };
const codex: Task = { ...unassigned, id: 't3', title: '补齐接续包', owner: { ...owner, name: 'codex_owner' }, updatedAt: '2026-10-18T01:30:00Z', dispatch: { ...dispatch, owner: 'codex_owner', worker: 'codex_worker', workspace: '/tmp/weaver-tasks/server-4VDE/frontend/' } };
const items = [codex, claude, unassigned];

/** Fixed clock for the board tests: every fixture above ended within a day of it. */
const now = Date.parse('2026-10-18T02:00:00Z');
/** An ISO stamp `hours` before that clock. */
const ago = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();
/** Closed work older than a day: it has left the board for the archive. */
const staleFailed: Task = { ...claude, id: 'a1', title: '归档失败案', status: 'failed', updatedAt: ago(30) };
const staleAccepted: Task = { ...codex, id: 'a2', title: '归档通过案', status: 'completed', reviewState: 'accepted', updatedAt: ago(100) };
const staleCancelled: Task = { ...codex, id: 'a3', title: '归档取消案', status: 'cancelled', updatedAt: ago(25) };
/** Exactly a day old: the boundary the board has not crossed yet. */
const onTheDay: Task = { ...claude, id: 'a4', title: '刚满一天', status: 'failed', updatedAt: ago(24) };
const archived = [staleCancelled, staleFailed, staleAccepted];

const policyConfig = {
  version: 1,
  engines: { claude: { enabled: true, kind: 'claude', quota_refresh: true }, qoder: { enabled: false, kind: 'qodercli', quota_refresh: false } },
  owners: { claude_owner: { enabled: true, engine: 'claude', model: 'claude-opus-5-5', effort: 'high', workers: ['claude_worker'], max_parallel: 4 } },
  workers: { claude_worker: { enabled: true, engine: 'claude', model: 'sonnet', effort: 'high' } },
  herdr: { max_wait_minutes: 15 },
} as unknown as Config;
const ownerKind = ownerKindLookup(policyConfig);

test('dispatch and owner engine kinds come from the frozen dispatch and the saved policy', () => {
  assert.equal(dispatchKind(claude), 'claude');
  assert.equal(dispatchKind({ ...claude, dispatch: { ...dispatch, engine: 'qoder', engineKind: 'qodercli' } }), 'qodercli');
  assert.equal(dispatchKind(unassigned), undefined);
  assert.equal(ownerKind('claude_owner'), 'claude');
  assert.equal(ownerKind('codex_owner'), undefined);
  assert.equal(ownerKind(), undefined);
  assert.equal(ownerKindLookup()('claude_owner'), undefined);
  assert.equal(taskOwnerId(claude), 'claude_owner');
  assert.equal(taskOwnerId(unassigned), undefined);
});

test('engine icons map every known kind and fall back to a neutral bot for unknown or missing kinds', () => {
  const titles = [['claude', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'opencode'], ['qoder', 'Qoder'], ['qodercli', 'Qoder'], ['pi', 'Pi'], ['grok', 'Grok']] as const;
  for (const [kind, title] of titles) assert.match(markup(React.createElement(EngineIcon, { kind })), new RegExp(`<title>${title}</title>`));
  const fallback = markup(React.createElement(EngineIcon, { kind: 'gemini' }));
  assert.match(fallback, /lucide lucide-bot/);
  assert.doesNotMatch(fallback, /<title>/);
  assert.match(markup(React.createElement(EngineIcon)), /lucide lucide-bot/);
  assert.match(markup(React.createElement(EngineIcon, { kind: 'claude' })), /aria-hidden="true"/);
});

test('agent labels pair the brand icon with the name in one inline row', () => {
  const labeled = markup(React.createElement(AgentLabel, { kind: 'qodercli', name: 'qoder_worker' }));
  assert.match(labeled, /<span[^>]*><svg[^>]*><title>Qoder<\/title>[\s\S]*?<\/svg>qoder_worker<\/span>/);
});

test('owner attribution prefers the frozen dispatch over the placeholder owner name', () => {
  assert.equal(ownerLabel(claude), 'claude_owner');
  assert.equal(ownerLabel(codex), 'codex_owner');
  assert.equal(ownerLabel(unassigned), '未指定负责人');
  assert.equal(ownerLabel({ ...unassigned, owner: { ...owner, name: 'Mario' } }), 'Mario');
  assert.equal(ownerLabel({ ...unassigned, owner: { ...owner, name: 'Mario' }, dispatch }), 'claude_owner');
});

test('project label is the recorded workspace directory name', () => {
  assert.equal(projectLabel(claude), 'weaver');
  assert.equal(projectLabel(codex), 'frontend');
  assert.equal(projectLabel({ ...unassigned, workspace: '/tmp/weaver-tasks/server-4VDE' }), 'server-4VDE');
  assert.equal(projectLabel({ ...unassigned, workspace: '/tmp/a/b', dispatch }), 'weaver');
  assert.equal(projectLabel(unassigned), '');
});

/** localStorage swap so board state tests can seed and observe persistence. */
function withStorage<T>(seed: Record<string, string>, run: () => T): T {
  const store = {
    getItem: (key: string) => (key in seed ? seed[key] : null),
    setItem: (key: string, value: string) => { seed[key] = value; },
    removeItem: (key: string) => { delete seed[key]; },
  } as unknown as Storage;
  const previous = Object.hasOwn(globalThis, 'localStorage') ? globalThis.localStorage : undefined;
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  try { return run(); } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', { value: previous, configurable: true, writable: true });
  }
}

/* ---- the filter bar above one board ---- */

/** Work on the board: two owners, two engines, two workers, each lifecycle state once. */
const onBoard = (id: string, title: string, route: { owner: string; worker: string; engine: string }, status: Task['status'], updatedAt = claude.updatedAt): Task =>
  ({ ...unassigned, id, title, status, updatedAt, dispatch: { ...dispatch, ...route } });
const live: Task[] = [
  onBoard('f1', '看板甲', { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude' }, 'running'),
  onBoard('f2', '看板乙', { owner: 'claude_owner', worker: 'codex_worker', engine: 'codex' }, 'queued'),
  onBoard('f3', '看板丙', { owner: 'codex_owner', worker: 'codex_worker', engine: 'codex' }, 'completed'),
  onBoard('f4', '看板丁', { owner: 'codex_owner', worker: 'claude_worker', engine: 'claude' }, 'failed', ago(1)),
];
/** Aged out of the board. */
const aged = onBoard('f5', '看板戊', { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude' }, 'failed', ago(30));
const tasks = [...live, aged];
/** A selection over an otherwise untouched board. */
const sel = (part: Partial<TaskSelection>): TaskSelection => ({ ...emptySelection(), ...part });
const optionsFor = (dimension: FilterDimension, chosen: TaskSelection = emptySelection()) => filterOptions(tasks, dimension, chosen, now);

test('each dimension offers the values the board holds, busiest first', () => {
  assert.deepEqual(optionsFor('owner').map(option => [option.value, option.label, option.open]), [['claude_owner', 'claude_owner', 2], ['codex_owner', 'codex_owner', 1]]);
  assert.deepEqual(optionsFor('engine').map(option => [option.value, option.open]), [['codex', 2], ['claude', 1]]);
  assert.deepEqual(optionsFor('worker').map(option => [option.value, option.open]), [['codex_worker', 2], ['claude_worker', 1]]);
  /** A task with no owner recorded is still somebody's task; a task with no dispatch has no engine. */
  assert.deepEqual(filterOptions(items, 'owner', emptySelection(), now).map(option => option.value), ['claude_owner', 'codex_owner', UNASSIGNED_OWNER]);
  /** The legacy task offers no engine and adds nothing to the one the dispatched pair share. */
  assert.deepEqual(filterOptions(items, 'engine', emptySelection(), now).map(option => [option.value, option.open]), [['claude', 2]]);
  /** Work that has aged out is neither a choice nor a count. */
  assert.equal(optionsFor('worker').find(option => option.value === 'claude_worker')?.open, 1);
  assert.deepEqual(filterOptions([], 'owner', emptySelection(), now), []);
});

test('a choice counts the live work the other dimensions leave standing', () => {
  /** Narrowed to codex_worker, each owner has one open task left of their own. */
  assert.deepEqual(optionsFor('owner', sel({ worker: ['codex_worker'] })).map(option => [option.value, option.open]), [['claude_owner', 1], ['codex_owner', 1]]);
  assert.deepEqual(optionsFor('engine', sel({ owner: ['claude_owner'] })).map(option => [option.value, option.open]), [['claude', 1], ['codex', 1]]);
  /** A dimension never applies to its own counts, or a choice could only ever add to itself. */
  assert.equal(optionsFor('engine', sel({ engine: ['codex'] })).find(option => option.value === 'claude')?.open, 1);
});

test('choices OR within a dimension and AND across dimensions', () => {
  /** Filtering keeps the list as it was handed over: order is the columns' business, not the filter's. */
  assert.deepEqual(applyTaskFilters(tasks, sel({ owner: ['claude_owner', 'codex_owner'] })).map(task => task.id), ['f1', 'f2', 'f3', 'f4', 'f5']);
  assert.deepEqual(applyTaskFilters(tasks, sel({ owner: ['claude_owner'] })).map(task => task.id), ['f1', 'f2', 'f5']);
  assert.deepEqual(applyTaskFilters(tasks, sel({ owner: ['claude_owner'], worker: ['codex_worker'] })).map(task => task.id), ['f2']);
  assert.deepEqual(applyTaskFilters(tasks, sel({ engine: ['codex'], worker: ['claude_worker'] })), []);
  assert.equal(applyTaskFilters(tasks, emptySelection()).length, 5);
  /** A task with no value for a narrowed dimension drops out: only an unused dimension is forgiving. */
  assert.deepEqual(applyTaskFilters(items, sel({ engine: ['claude'] })).map(task => task.id), ['t3', 't2']);
  assert.deepEqual(toggleOption(toggleOption([], 'claude'), 'codex'), ['claude', 'codex']);
  assert.deepEqual(toggleOption(['claude', 'codex'], 'claude'), ['codex']);
  assert.equal(hasFilters(emptySelection()), false);
  assert.equal(hasFilters(sel({ engine: ['claude'] })), true);
});

test('a filter button says the dimension, one choice by name, or how many are on', () => {
  const owners = optionsFor('owner');
  assert.equal(filterButtonLabel('owner', owners, []), '负责人');
  assert.equal(filterButtonLabel('owner', owners, ['codex_owner']), '负责人：codex_owner');
  assert.equal(filterButtonLabel('owner', owners, ['claude_owner', 'codex_owner']), '负责人：2 个');
  assert.equal(filterButtonLabel('engine', optionsFor('engine'), ['claude']), '引擎：claude');
  assert.equal(filterButtonLabel('worker', optionsFor('worker'), ['claude_worker', 'codex_worker']), '工作代理：2 个');
  /** A value the board no longer names still says what was picked. */
  assert.equal(filterButtonLabel('owner', owners, ['gone_owner']), '负责人：gone_owner');
});

test('the option a board narrows by is the owner key, the engine kind and the worker', () => {
  assert.deepEqual(taskOption(claude, 'owner'), { value: 'claude_owner', label: 'claude_owner' });
  /** A task carrying its own owner name is labelled by it and grouped by its policy key. */
  assert.deepEqual(taskOption({ ...claude, ownerId: 'p9', owner: { ...owner, name: 'Mario' } }, 'owner'), { value: 'p9', label: 'Mario' });
  assert.deepEqual(taskOption(unassigned, 'owner'), { value: UNASSIGNED_OWNER, label: UNASSIGNED_OWNER });
  assert.deepEqual(taskOption({ ...claude, dispatch: { ...dispatch, engine: 'qoder', engineKind: 'qodercli' } }, 'engine'), { value: 'qodercli', label: 'qodercli' });
  assert.deepEqual(taskOption(claude, 'worker'), { value: 'claude_worker', label: 'claude_worker' });
  /** A legacy task with no frozen dispatch has no engine and no worker to filter on. */
  assert.equal(taskOption(unassigned, 'engine'), undefined);
  assert.equal(taskOption(unassigned, 'worker'), undefined);
});

test('a saved selection round-trips, and values that name nothing are dropped', () => {
  const seed: Record<string, string> = {};
  withStorage(seed, () => {
    writeTaskFilters(sel({ owner: ['claude_owner'] }));
    assert.deepEqual(readTaskFilters(), sel({ owner: ['claude_owner'] }));
    assert.equal(seed[TASK_FILTERS_KEY], JSON.stringify(sel({ owner: ['claude_owner'] })));
  });
  assert.deepEqual(withStorage({}, () => readTaskFilters()), emptySelection());
  /** Nothing in a broken payload can be trusted, so nothing is kept. */
  for (const junk of ['{oops', 'null', '["claude_owner"]', '"claude_owner"', '3']) assert.deepEqual(withStorage({ [TASK_FILTERS_KEY]: junk }, () => readTaskFilters()), emptySelection(), junk);
  /** A dimension holding what it cannot use keeps only the strings. */
  assert.deepEqual(withStorage({ [TASK_FILTERS_KEY]: JSON.stringify({ owner: ['claude_owner', 7, null], engine: 'claude' }) }, () => readTaskFilters()), sel({ owner: ['claude_owner'] }));
  /** A stale choice falls away; one that still names board work survives. */
  assert.deepEqual(resolveSelection(sel({ owner: ['ghost_owner'], engine: ['claude'], worker: ['ghost_worker'] }), tasks, now), sel({ engine: ['claude'] }));
  /** Work that has aged out is not a choice either, so an owner left with nothing on the board is forgotten. */
  assert.deepEqual(resolveSelection(sel({ owner: ['claude_owner'] }), [staleFailed], now), emptySelection());
  assert.deepEqual(resolveSelection(emptySelection(), [], now), emptySelection());
});

test('the board is one column grid under a filter bar, with no owner swimlanes', () => {
  const html = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, ownerKind, now }));
  assert.match(html, /搜索标题、负责人、项目或任务 ID/);
  assert.match(html, /负责人/);
  assert.match(html, /引擎/);
  assert.match(html, /工作代理/);
  /** The owner Segmented and the lanes are gone. */
  assert.doesNotMatch(html, /按负责人筛选/);
  assert.doesNotMatch(html, /aria-label="[^"]* 的任务"/);
  assert.doesNotMatch(html, /全部 3/);
  assert.doesNotMatch(html, /清除/);
  /** One board: the live columns are open and every card appears once. */
  assert.match(html, /待执行/);
  assert.match(html, /执行中/);
  assert.match(html, /待验收/);
  assert.match(html, /看板甲/);
  assert.match(html, /看板丙/);
  assert.equal((html.match(/看板乙/g) ?? []).length, 1);
  assert.equal((html.match(/待执行/g) ?? []).length, 1);
});

test('the saved selection narrows one board and the button names the choice', () => {
  withStorage({ [TASK_FILTERS_KEY]: JSON.stringify(sel({ owner: ['claude_owner'] })) }, () => {
    const html = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, ownerKind, now }));
    assert.match(html, /负责人：claude_owner/);
    assert.match(html, /清除/);
    assert.match(html, /看板甲/);
    assert.doesNotMatch(html, /看板丙|看板丁/);
  });
  withStorage({ [TASK_FILTERS_KEY]: JSON.stringify(sel({ owner: ['claude_owner', 'codex_owner'], engine: ['claude'] })) }, () => {
    const html = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, ownerKind, now }));
    assert.match(html, /负责人：2 个/);
    assert.match(html, /引擎：claude/);
    /** AND across dimensions: only the claude-engine work of both owners is left standing. */
    assert.match(html, /看板甲/);
    assert.doesNotMatch(html, /看板乙|看板丙/);
  });
  /** A stored choice that no task carries is ignored rather than emptying the board. */
  withStorage({ [TASK_FILTERS_KEY]: JSON.stringify(sel({ owner: ['gone_owner'] })) }, () => {
    const html = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, ownerKind, now }));
    assert.doesNotMatch(html, /负责人：|清除/);
    assert.match(html, /看板甲/);
  });
});

test('the checklist offers each choice with its live count and stays open for the next click', () => {
  const rows = filterItems('owner', optionsFor('owner'), ['codex_owner'], () => {}, ownerKind);
  assert.deepEqual(rows.map(row => [row.key, row.checked]), [['claude_owner', false], ['codex_owner', true]]);
  for (const row of rows) assert.equal(row.type, 'checkbox');
  /** A menu that closed on the first tick could not hold an OR of two choices. */
  assert.equal(rows[0].closeOnClick, false);
  assert.match(markup(rows[0].label as React.ReactNode), /claude_owner/);
  assert.match(markup(rows[0].extra as React.ReactNode), /2/);
  assert.match(markup(rows[0].icon as React.ReactNode), /<title>Claude Code<\/title>/);
  /** Engines and workers carry their dispatch brand; an owner the policy does not know gets the neutral mark. */
  assert.match(markup(filterItems('worker', optionsFor('worker'), [], () => {}, ownerKind)[0].icon as React.ReactNode), /<title>Codex<\/title>/);
  assert.match(markup(filterItems('engine', optionsFor('engine'), [], () => {}, ownerKind)[0].icon as React.ReactNode), /<title>Codex<\/title>/);
  assert.match(markup(filterItems('owner', [{ value: 'codex_owner', label: 'codex_owner', open: 1 }], [], () => {}, ownerKind)[0].icon as React.ReactNode), /lucide lucide-bot/);
  /** Ticking a row is the only way the menu changes the selection. */
  const toggled: string[] = [];
  filterItems('owner', optionsFor('owner'), [], value => toggled.push(value))[0].onCheckedChange?.(true);
  assert.deepEqual(toggled, ['claude_owner']);
});

test('choices with nothing live wait behind 显示全部, but a picked one stays in sight', () => {
  const quiet = [...optionsFor('owner'), { value: 'idle_owner', label: 'idle_owner', open: 0 }];
  assert.deepEqual(filterItems('owner', quiet, [], () => {}).map(row => row.key), ['claude_owner', 'codex_owner']);
  assert.match(markup(React.createElement('div', null, filterReveal(quiet, [], () => {}))), /显示全部/);
  /** Nothing to hide, so no row. */
  assert.equal(filterReveal(optionsFor('owner'), [], () => {}), undefined);
  /** A picked owner whose work has all ended stays listed, so it can be unticked. */
  assert.deepEqual(filterItems('owner', quiet, ['idle_owner'], () => {}).map(row => row.key), ['claude_owner', 'codex_owner', 'idle_owner']);
  assert.equal(filterReveal(quiet, ['idle_owner'], () => {}), undefined);
});

test('the 已结束 column is folded by default and opens for the whole board', () => {
  const folded = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, ownerKind, now }));
  assert.match(folded, /已结束/);
  assert.equal(readEndedExpanded(), false);
  /** Folded: a header button counting the column, with nothing rendered under it to point at. */
  assert.match(folded, /aria-expanded="false"[^>]*>[\s\S]{0,600}已结束<\/div><div[^>]*>1<\/div>/);
  assert.doesNotMatch(folded, /aria-controls="board-ended"/);
  assert.doesNotMatch(folded, /看板丁/);
  assert.doesNotMatch(folded, /归档失败案/);
  withStorage({ [ENDED_EXPANDED_KEY]: 'true' }, () => {
    assert.equal(readEndedExpanded(), true);
    const open = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, ownerKind, now }));
    assert.match(open, /看板丁/);
    assert.match(open, /aria-expanded="true"[^>]*aria-controls="board-ended"/);
    assert.match(open, /id="board-ended"/);
  });
  /** An owner-keyed map from the swimlane board is not an open column. */
  withStorage({ [ENDED_EXPANDED_KEY]: JSON.stringify({ claude_owner: true }) }, () => assert.equal(readEndedExpanded(), false));
  const seed: Record<string, string> = {};
  withStorage(seed, () => writeEndedExpanded(true));
  assert.equal(seed[ENDED_EXPANDED_KEY], 'true');
});

test('the columns hold the live board work, newest first, with archived work kept off them', () => {
  const [queued, running, review, closed] = columnize(nonArchived([...tasks, staleFailed, onTheDay], now));
  assert.deepEqual(queued.map(task => task.id), ['f2']);
  assert.deepEqual(running.map(task => task.id), ['f1']);
  assert.deepEqual(review.map(task => task.id), ['f3']);
  /** A day on the clock is not yet archived, so it sits in 已结束 with the rest. */
  assert.deepEqual(closed.map(task => task.id), ['f4', 'a4']);
  assert.deepEqual(nonArchived(tasks, now).map(task => task.id), ['f1', 'f2', 'f3', 'f4']);
  const html = withStorage({ [ENDED_EXPANDED_KEY]: 'true' }, () =>
    markup(React.createElement(TaskBoard, { tasks: [...tasks, staleFailed], loading: false, onSelect: () => {}, ownerKind, now })));
  assert.doesNotMatch(html, /归档失败案|看板戊/);
  assert.match(html, /已结束[\s\S]{0,400}看板丁/);
});

test('a card is its title, its status, its agents and the directory it worked in', () => {
  const html = markup(React.createElement(TaskBoard, { tasks: [claude], loading: false, onSelect: () => {}, ownerKind, now }));
  assert.match(html, /接入新引擎/);
  assert.match(html, /<dt[^>]*>Owner<\/dt><dd[^>]*>[\s\S]*?claude_owner<\/span>/);
  assert.match(html, /<dt[^>]*>Worker<\/dt><dd[^>]*>[\s\S]*?claude_worker<\/span>/);
  /** The compact facts name the directory and keep the whole path for a hover. */
  assert.match(html, /<dt[^>]*>目录<\/dt><dd[^>]*>[\s\S]*?>weaver<\/div>/);
  assert.match(html, /data-base-ui-tooltip-trigger=/);
  assert.doesNotMatch(html, /\/home\/mocha\/opensource\/weaver/);
  assert.doesNotMatch(html, /复制工作目录/);
  assert.match(html, /Reading TaskBoard\.tsx/);
});

/* ---- a day off the board: the archive ---- */

test('a closed task leaves the board a day after it ended, and live work never does', () => {
  assert.equal(taskColumn(staleFailed), 'closed');
  assert.equal(isArchived(onTheDay, now), false);
  assert.equal(isArchived({ ...onTheDay, updatedAt: new Date(now - ARCHIVE_AFTER_MS - 1).toISOString() }, now), true);
  for (const endedTask of [staleFailed, staleCancelled, staleAccepted]) assert.equal(isArchived(endedTask, now), true);
  const alive = [claude, { ...claude, status: 'queued' as const }, codex, { ...claude, status: 'cancelling' as const }];
  for (const task of alive) {
    assert.equal(isOpenTask(task), true);
    assert.equal(isArchived({ ...task, updatedAt: ago(5000) }, now), false);
  }
  assert.equal(isOpenTask(staleFailed), false);
  assert.equal(isArchived({ ...staleFailed, updatedAt: 'never' }, now), false);
});

test('archive rows are the aged-out work, newest first, narrowed by search and owner', () => {
  assert.deepEqual(archivedTasks([...tasks, ...archived, onTheDay], now).map(task => task.id), ['a3', 'f5', 'a1', 'a2']);
  assert.deepEqual(archiveRows([...archived, onTheDay], '', ALL_OWNERS, now).map(task => task.id), ['a3', 'a1', 'a2']);
  assert.deepEqual(archiveRows([...archived, onTheDay], '', 'codex_owner', now).map(task => task.id), ['a3', 'a2']);
  assert.deepEqual(archiveRows(archived, '通过', ALL_OWNERS, now).map(task => task.id), ['a2']);
  assert.deepEqual(archiveRows(archived, 'FRONTEND', ALL_OWNERS, now).map(task => task.id), ['a3', 'a2']);
  assert.deepEqual(archiveRows(archived, 'a1', ALL_OWNERS, now).map(task => task.id), ['a1']);
  assert.deepEqual(archiveRows(items, '', ALL_OWNERS, now), []);
  /** The drawer keeps its own owner select, by the label a task shows rather than the board's policy key. */
  assert.deepEqual(filterByOwner(items, 'claude_owner').map(task => task.id), ['t2']);
  assert.equal(filterByOwner(items, ALL_OWNERS).length, 3);
  assert.deepEqual(filterByOwner(items, 'missing'), []);
});

test('the archive table names, pairs and tags each archived row, newest first', () => {
  const columns = archiveColumns(ownerKind);
  assert.deepEqual(columns.map(column => column.title), ['任务', '负责人 → 工作代理', '项目', '结果', '结束于']);
  const rows = archiveRows([...archived, onTheDay], '', ALL_OWNERS, now);
  assert.deepEqual(rows.map(task => task.title), ['归档取消案', '归档失败案', '归档通过案']);
  const cell = (key: string, task: Task) => {
    const column = columns.find(item => item.key === key)!;
    return markup(React.createElement(React.Fragment, null, column.render?.(task.title, task, 0) as React.ReactNode));
  };
  assert.match(cell('agents', rows[1]), /claude_owner<\/span>[\s\S]{0,120}→[\s\S]{0,1500}claude_worker/);
  assert.match(cell('agents', rows[0]), /codex_owner[\s\S]{0,1500}codex_worker/);
  assert.match(cell('project', rows[1]), /weaver/);
  assert.match(cell('project', rows[0]), /frontend/);
  assert.deepEqual(rows.map(task => /失败|已取消|已通过/.exec(cell('outcome', task))?.[0]), ['已取消', '失败', '已通过']);
  assert.match(cell('ended', rows[0]), /2026/);
  assert.match(cell('title', rows[2]), /归档通过案/);
  /** A legacy task with no frozen dispatch still names its owner and admits the agent is unknown. */
  assert.match(cell('agents', { ...staleFailed, id: 'a9', dispatch: undefined }), /未记录代理/);
});

test('an archive row opens the record by click and by key', () => {
  const opened: string[] = [];
  const prevented: string[] = [];
  const row = archiveRowProps(staleFailed, staleFailed.id, id => opened.push(id));
  assert.equal(row.tabIndex, 0);
  assert.equal(row['aria-current'], 'true');
  assert.equal(archiveRowProps(staleFailed, 'other', () => {})['aria-current'], undefined);
  const key = (k: string) => row.onKeyDown?.({ key: k, preventDefault: () => prevented.push(k) } as never);
  row.onClick?.({} as never);
  key('Enter');
  key(' ');
  key('x');
  assert.deepEqual(opened, [staleFailed.id, staleFailed.id, staleFailed.id]);
  assert.deepEqual(prevented, ['Enter', ' ']);
});

test('the archive list is quiet when nothing has aged out yet', () => {
  const html = markup(React.createElement(ArchiveList, { tasks: items, onSelect: () => {}, now }));
  assert.match(html, /还没有归档任务/);
  assert.match(html, /搜索标题、负责人、项目或任务 ID/);
  assert.match(html, /按负责人筛选归档任务/);
  assert.doesNotMatch(html, /重排任务面板/);
});

test('search reaches the real owner and the project, not only the placeholder name', () => {
  assert.deepEqual(filterTasks(items, 'all', 'claude_owner').map(task => task.id), ['t2']);
  assert.deepEqual(filterTasks(items, 'all', 'FRONTEND').map(task => task.id), ['t3']);
  assert.deepEqual(filterTasks(items, 'all', '未指定').map(task => task.id), ['t1']);
});

test('running and queued cards spin, finished cards do not, and a running card carries exactly one loader', () => {
  const spinning = markup(React.createElement(TaskBoard, { tasks: [claude], loading: false, onSelect: () => {} }));
  assert.match(spinning, /lucide-loader-2/);
  assert.match(spinning, /Reading TaskBoard\.tsx/);
  assert.equal((spinning.match(/lucide-loader-2/g) ?? []).length, 1);
  const waiting = markup(React.createElement(TaskBoard, { tasks: [{ ...claude, status: 'queued', scheduled: true }], loading: false, onSelect: () => {} }));
  assert.match(waiting, /lucide-loader-2/);
  assert.match(waiting, /排队中/);
  assert.equal((waiting.match(/lucide-loader-2/g) ?? []).length, 1);
  const stopped = markup(React.createElement(TaskBoard, { tasks: [unassigned], loading: false, onSelect: () => {} }));
  assert.doesNotMatch(stopped, /lucide-loader-2/);
});

const detailProps = { busy: false, onStart: () => {}, onCancel: () => {}, action: async () => true };

test('detail is one column: status tag, facts block and route line, no progress bar or lifecycle tally', () => {
  const html = markup(React.createElement(TaskDetail, { task: claude, ...detailProps, ownerKind }));
  assert.match(html, /执行中/);
  assert.match(html, /lucide-loader-2/);
  assert.doesNotMatch(html, /lucide-loader-2[\s\S]*lucide-loader-2/);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.doesNotMatch(html, /执行进度/);
  assert.doesNotMatch(html, /已创建 ·/);
  assert.doesNotMatch(html, /最近活动/);
  /** The agents and the directory are the facts block; what is left of the meta line is the route and the clock. */
  assert.match(html, /<dt[^>]*>Owner<\/dt><dd[^>]*>[\s\S]*?claude_owner<\/span><\/dd>/);
  assert.match(html, /<dt[^>]*>Worker<\/dt><dd[^>]*>[\s\S]*?claude_worker<\/span><\/dd>/);
  assert.match(html, /<dt[^>]*>工作目录<\/dt><dd[^>]*>[\s\S]*?\/home\/mocha\/opensource\/weaver[\s\S]*?<\/dd>/);
  assert.match(html, /claude \/ sonnet · high · 更新于/);
  assert.match(html, /<title>Claude Code<\/title>/);
  assert.doesNotMatch(html, /→/);
  assert.doesNotMatch(html, /待验收|已通过/);
  const noPolicy = markup(React.createElement(TaskDetail, { task: claude, ...detailProps }));
  assert.match(noPolicy, /<dt[^>]*>Owner<\/dt>[\s\S]*?lucide lucide-bot[\s\S]*?claude_owner/);
});

test('the review tag appears only once execution completed', () => {
  const done = markup(React.createElement(TaskDetail, { task: { ...claude, status: 'completed', summary: '面板已重排' }, ...detailProps }));
  assert.match(done, /待验收/);
  assert.doesNotMatch(done, /lucide-loader-2/);
  assert.match(done, /执行结果/);
  assert.match(done, /面板已重排/);
  assert.doesNotMatch(done, /执行完成与验收通过分别记录/);
  assert.match(markup(React.createElement(TaskDetail, { task: { ...claude, status: 'completed', reviewState: 'accepted' as const }, ...detailProps })), /已通过/);
  assert.doesNotMatch(markup(React.createElement(TaskDetail, { task: { ...claude, status: 'completed' }, ...detailProps })), /执行结果/);
});

test('detail notes only the states that need explaining', () => {
  const queued = markup(React.createElement(TaskDetail, { task: { ...claude, status: 'queued', scheduled: true, queueReason: { code: 'waiting_for_capacity', message: 'at its current concurrency limit' } }, ...detailProps }));
  assert.match(queued, /调度请求已排队/);
  assert.match(queued, /等待执行槽位/);
  assert.match(queued, /at its current concurrency limit/);
  assert.doesNotMatch(queued, /执行失败|执行已取消/);
  const failed = markup(React.createElement(TaskDetail, { task: { ...claude, status: 'failed', events: [{ id: 'e9', at: claude.updatedAt, kind: 'error', message: 'engine exited 1' }] }, ...detailProps }));
  assert.match(failed, /执行失败/);
  assert.match(failed, /engine exited 1/);
  assert.doesNotMatch(failed, /调度请求已排队|执行已取消/);
  const cancelled = markup(React.createElement(TaskDetail, { task: { ...claude, status: 'cancelled' }, ...detailProps }));
  assert.match(cancelled, /执行已取消/);
  assert.doesNotMatch(cancelled, /调度请求已排队|执行失败/);
  assert.doesNotMatch(markup(React.createElement(TaskDetail, { task: { ...claude, status: 'completed' }, ...detailProps })), /调度请求已排队|执行失败|执行已取消/);
});

test('retry lineage is a quiet line only when it exists', () => {
  assert.match(markup(React.createElement(TaskDetail, { task: { ...claude, retryOf: 't0' }, ...detailProps })), /重试来源：t0/);
  assert.doesNotMatch(markup(React.createElement(TaskDetail, { task: claude, ...detailProps })), /重试来源/);
});

test('handover stays in a tab of the same record', () => {
  const html = markup(React.createElement(TaskDetail, { task: claude, ...detailProps }));
  assert.match(html, /role="tab"[^>]*>接续<\/button>/);
  assert.doesNotMatch(html, /执行上下文/);
});

test('the inspector row is the owner, its status and one action', () => {
  const routed = markup(React.createElement(OwnerInspector, { task: claude, busy: false, action: async () => true, owners: [{ id: 'claude_owner', kind: 'claude' }] }));
  assert.match(routed, /claude_owner/);
  assert.match(routed, /接续给…/);
  assert.doesNotMatch(routed, /工作目录|尚未记录调度结果|当前进度/);
  const legacy = markup(React.createElement(OwnerInspector, { task: unassigned, busy: false, action: async () => true }));
  assert.match(legacy, /未指定负责人/);
  assert.doesNotMatch(legacy, /工作目录 旧任务未记录|Epoch|Revision/);
});
