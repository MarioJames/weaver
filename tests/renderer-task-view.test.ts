import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Config } from '../src/shared/policy';
import type { Task } from '../src/shared/types';
import { ARCHIVE_AFTER_MS, ENDED_EXPANDED_KEY, TASK_FILTERS_KEY, UNASSIGNED_OWNER, applyTaskFilters, archiveRows, archivedTasks, columnize, dispatchKind, emptySelection, filterByTime, filterOptions, filterTasks, hasFilters, isArchived, isOpenTask, nonArchived, ownerKindLookup, ownerLabel, projectLabel, readEndedExpanded, readTaskFilters, resolveSelection, taskColumn, taskOwnerId, taskOption, toggleOption, writeEndedExpanded, writeTaskFilters, withOwnerProfiles } from '../src/renderer/task-view';
import type { FilterDimension, TaskSelection } from '../src/renderer/task-view';
import { EngineIcon, AgentLabel } from '../src/renderer/components/EngineIcon';
import { ArchiveList, archiveColumns, archiveRowProps } from '../src/renderer/components/ArchiveDrawer';
import { TaskBoard } from '../src/renderer/components/TaskBoard';
import { TaskDetail } from '../src/renderer/components/TaskDetail';
import { TaskTextBlock } from '../src/renderer/components/TaskTextBlock';
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
  assert.equal(ownerLabel(unassigned), '未指定父 Agent');
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

test('each dimension offers the values the board holds in the chosen range, busiest first', () => {
  assert.deepEqual(optionsFor('owner').map(option => [option.value, option.label, option.count]), [['claude_owner', 'claude_owner', 2], ['codex_owner', 'codex_owner', 2]]);
  assert.deepEqual(optionsFor('worker').map(option => [option.value, option.count]), [['claude_worker', 2], ['codex_worker', 2]]);
  /** A task with no owner recorded is still somebody's task; a task with no dispatch has no worker. */
  assert.deepEqual(filterOptions(items, 'owner', emptySelection(), now).map(option => option.value), ['claude_owner', 'codex_owner', UNASSIGNED_OWNER]);
  /** Work that has aged out is neither a choice nor a count. */
  assert.equal(optionsFor('worker').find(option => option.value === 'claude_worker')?.count, 2);
  assert.deepEqual(filterOptions([], 'owner', emptySelection(), now), []);
});

test('a choice counts the tasks the other rows leave standing', () => {
  /** Narrowed to codex_worker, each owner has one task left of their own. */
  assert.deepEqual(optionsFor('owner', sel({ worker: ['codex_worker'] })).map(option => [option.value, option.count]), [['claude_owner', 1], ['codex_owner', 1]]);
  /** A row never applies to its own counts. */
  assert.equal(optionsFor('worker', sel({ worker: ['codex_worker'] })).find(option => option.value === 'claude_worker')?.count, 2);
});

test('choices OR within a dimension and AND across dimensions', () => {
  /** Filtering keeps the list as it was handed over: order is the columns' business, not the filter's. */
  assert.deepEqual(applyTaskFilters(tasks, sel({ time: 'all', owner: ['claude_owner', 'codex_owner'] })).map(task => task.id), ['f1', 'f2', 'f3', 'f4', 'f5']);
  assert.deepEqual(applyTaskFilters(tasks, sel({ time: 'all', owner: ['claude_owner'] })).map(task => task.id), ['f1', 'f2', 'f5']);
  assert.deepEqual(applyTaskFilters(tasks, sel({ time: 'all', owner: ['claude_owner'], worker: ['codex_worker'] })).map(task => task.id), ['f2']);
  assert.deepEqual(applyTaskFilters(tasks, sel({ time: 'all', owner: ['codex_owner'], worker: ['codex_worker'] })).map(task => task.id), ['f3']);
  assert.equal(applyTaskFilters(tasks, sel({ time: 'all' })).length, 5);
  /** A task with no value for a narrowed dimension drops out: only an unused dimension is forgiving. */
  assert.deepEqual(applyTaskFilters(items, sel({ time: 'all', worker: ['claude_worker'] })).map(task => task.id), ['t2']);
  assert.deepEqual(toggleOption(toggleOption([], 'claude'), 'codex'), ['claude', 'codex']);
  assert.deepEqual(toggleOption(['claude', 'codex'], 'claude'), ['codex']);
  assert.equal(hasFilters(emptySelection()), false);
  assert.equal(hasFilters(sel({ time: 'all', worker: ['claude_worker'] })), true);
});

test('the option a board narrows by is the owner key and the worker', () => {
  assert.deepEqual(taskOption(claude, 'owner'), { value: 'claude_owner', label: 'claude_owner' });
  /** A named instance uses its display name rather than joining the profile group. */
  assert.deepEqual(taskOption({ ...claude, ownerId: 'p9', owner: { ...owner, name: 'Mario' } }, 'owner'), { value: 'Mario', label: 'Mario' });
  assert.deepEqual(taskOption(unassigned, 'owner'), { value: UNASSIGNED_OWNER, label: UNASSIGNED_OWNER });
  assert.deepEqual(taskOption(claude, 'worker'), { value: 'claude_worker', label: 'claude_worker' });
  /** A legacy task with no frozen dispatch has no worker to filter on. */
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
  assert.deepEqual(resolveSelection(sel({ owner: ['ghost_owner'], worker: ['ghost_worker'] }), tasks, now), emptySelection());
  /** Work that has aged out is not a choice either, so an owner left with nothing on the board is forgotten. */
  assert.deepEqual(resolveSelection(sel({ owner: ['claude_owner'] }), [staleFailed], now), emptySelection());
  assert.deepEqual(resolveSelection(emptySelection(), [], now), emptySelection());
});

test('the board is one lane grid under a facet block, with no search box and no owner swimlanes', () => {
  const html = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, ownerKind, now }));
  assert.doesNotMatch(html, /搜索|<input/);
  for (const label of ['时间', '状态', '父 Agent', '子 Agent', '工作目录']) assert.match(html, new RegExp(`>${label}<`));
  assert.doesNotMatch(html, /工作代理/);
  assert.doesNotMatch(html, /按负责人筛选/);
  assert.doesNotMatch(html, /aria-label="[^"]* 的任务"/);
  /** One board: the live lanes are open and every card appears once. */
  assert.match(html, /看板甲/);
  assert.match(html, /看板丙/);
  assert.equal((html.match(/看板乙/g) ?? []).length, 1);
  assert.match(html, /待执行/);
  assert.match(html, /执行中/);
  assert.match(html, /待验收/);
});

test('the saved selection narrows one board and shows as checked chips and 已选 tags', () => {
  withStorage({ [TASK_FILTERS_KEY]: JSON.stringify(sel({ owner: ['claude_owner'] })) }, () => {
    const html = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, ownerKind, now }));
    assert.ok([...html.matchAll(/<button\b[^>]*aria-pressed="true"[^>]*>[\s\S]*?<\/button>/g)].some(match => match[0].includes('claude_owner')));
    assert.match(html, /移除 claude_owner/);
    assert.match(html, /看板甲/);
    assert.doesNotMatch(html, /看板丙|看板丁/);
  });
  withStorage({ [TASK_FILTERS_KEY]: JSON.stringify(sel({ owner: ['claude_owner', 'codex_owner'], worker: ['claude_worker'] })) }, () => {
    const html = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, ownerKind, now }));
    /** AND across rows: only the claude worker work of both owners remains. */
    assert.match(html, /看板甲/);
    assert.doesNotMatch(html, /看板乙|看板丙/);
  });
  /** A stored choice that no task carries is ignored rather than emptying the board. */
  withStorage({ [TASK_FILTERS_KEY]: JSON.stringify(sel({ owner: ['gone_owner'] })) }, () => {
    const html = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, ownerKind, now }));
    assert.doesNotMatch(html, /移除 gone_owner/);
    assert.match(html, /看板甲/);
  });
});

test('the 已结束 column is folded by default and opens for the whole board', () => {
  const folded = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, ownerKind, now }));
  assert.match(folded, /已结束/);
  assert.equal(readEndedExpanded(), false);
  /** Folded: a header button counting the column, with nothing rendered under it to point at. */
  assert.match(folded, /aria-expanded="false"[^>]*>[\s\S]{0,600}已结束<\/strong>\s*<span[^>]*>1<\/span>/);
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
  assert.match(html, /data-status-column="closed"[\s\S]*<strong[^>]*>看板丁<\/strong>/);
});

test('a card shows sub agent before its title, with only the parent in compact facts', () => {
  const html = markup(React.createElement(TaskBoard, { tasks: [claude], loading: false, onSelect: () => {}, ownerKind, now }));
  assert.match(html, /接入新引擎/);
  assert.match(html, /aria-label="父 Agent：claude_owner"[\s\S]*?claude_owner<\/span>/);
  assert.match(html, /claude_worker[\s\S]*<strong[^>]*>接入新引擎<\/strong>/);
  assert.equal((html.match(/<dt/g) ?? []).length, 0);
  assert.doesNotMatch(html, /<dt[^>]*>Worker|<dt[^>]*>目录|复制工作目录/);
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

test('archive rows are the aged-out work, newest first, narrowed by the drawer selects', () => {
  const all = { ...emptySelection(), time: 'all' as const };
  assert.deepEqual(archivedTasks([...tasks, ...archived, onTheDay], now).map(task => task.id), ['a3', 'f5', 'a1', 'a2']);
  assert.deepEqual(archiveRows([...archived, onTheDay], all, now).map(task => task.id), ['a3', 'a1', 'a2']);
  assert.deepEqual(archiveRows([...archived, onTheDay], { ...all, owner: ['codex_owner'] }, now).map(task => task.id), ['a3', 'a2']);
  assert.deepEqual(archiveRows(archived, { ...all, status: ['accepted'] }, now).map(task => task.id), ['a2']);
  assert.deepEqual(archiveRows(archived, { ...all, worker: ['claude_worker'] }, now).map(task => task.id), ['a1']);
  assert.deepEqual(archiveRows(items, all, now), []);
});

test('the archive table names, pairs and tags each archived row, newest first', () => {
  const columns = archiveColumns(ownerKind);
  assert.deepEqual(columns.map(column => column.title), ['任务', '父 Agent → 子 Agent', '工作目录', '结果', '结束于']);
  const rows = archiveRows([...archived, onTheDay], { ...emptySelection(), time: 'all' }, now);
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
  assert.match(cell('agents', { ...staleFailed, id: 'a9', dispatch: undefined }), /未记录子 Agent/);
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
  assert.doesNotMatch(html, /搜索/);
  assert.match(html, /按父 Agent筛选归档任务/);
  assert.doesNotMatch(html, /重排任务面板/);
});

test('only active execution cards spin and scheduled cards use a static clock', () => {
  const spinning = markup(React.createElement(TaskBoard, { tasks: [claude], loading: false, onSelect: () => {}, now }));
  assert.match(spinning, /lucide-loader-2/);
  assert.match(spinning, /Reading TaskBoard\.tsx/);
  assert.equal((spinning.match(/lucide-loader-2/g) ?? []).length, 1);
  const waiting = markup(React.createElement(TaskBoard, { tasks: [{ ...claude, status: 'queued', scheduled: true }], loading: false, onSelect: () => {}, now }));
  assert.match(waiting, /lucide-clock/);
  assert.match(waiting, /排队中/);
  assert.equal((waiting.match(/lucide-loader-2/g) ?? []).length, 0);
  const stopped = markup(React.createElement(TaskBoard, { tasks: [unassigned], loading: false, onSelect: () => {}, now }));
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
  assert.match(html, /<dt[^>]*>父 Agent<\/dt><dd[^>]*>[\s\S]*?claude_owner<\/span><\/dd>/);
  assert.match(html, /<dt[^>]*>子 Agent<\/dt><dd[^>]*>[\s\S]*?claude_worker<\/span><\/dd>/);
  assert.match(html, /<dt[^>]*>工作目录<\/dt><dd[^>]*>[\s\S]*?\/home\/mocha\/opensource\/weaver[\s\S]*?<\/dd>/);
  assert.match(html, /<dt[^>]*>模型<\/dt>/);
  assert.match(html, /<dt[^>]*>更新时间<\/dt>/);
  assert.match(html, /<title>Claude Code<\/title>/);
  assert.doesNotMatch(html, /→/);
  assert.doesNotMatch(html, /已通过/);
  const noPolicy = markup(React.createElement(TaskDetail, { task: claude, ...detailProps }));
  assert.match(noPolicy, /<dt[^>]*>父 Agent<\/dt>[\s\S]*?lucide lucide-bot[\s\S]*?claude_owner/);
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
  assert.match(legacy, /未指定父 Agent/);
  assert.doesNotMatch(legacy, /工作目录 旧任务未记录|Epoch|Revision/);
});


test('throwaway owner instances group by profile while named instances group by name', () => {
  const first = { ...claude, id: 'first', ownerId: 'instance-1' };
  const second = { ...claude, id: 'second', ownerId: 'instance-2' };
  const named = { ...claude, id: 'named', ownerId: 'attached-1', owner: { ...owner, name: 'Mario' } };
  assert.equal(taskOwnerId(first), 'claude_owner');
  assert.deepEqual(taskOption(named, 'owner'), { value: 'Mario', label: 'Mario' });
  const options = filterOptions([first, second, named], 'owner', emptySelection(), now);
  assert.deepEqual(options.map(({ value, label, count }) => ({ value, label, count })), [
    { value: 'claude_owner', label: 'claude_owner', count: 2 },
    { value: 'Mario', label: 'Mario', count: 1 },
  ]);
  assert.deepEqual(applyTaskFilters([first, second, named], sel({ owner: ['claude_owner'] }), undefined, now).map(task => task.id), ['first', 'second']);
});


test('queued throwaways use registry profiles without changing original task records', () => {
  const queued = { ...unassigned, id: 'queued', status: 'queued' as const, ownerId: 'instance-queued' };
  const [task] = withOwnerProfiles([queued], [{ id: queued.ownerId, name: 'Task owner', profileId: 'claude_owner' }]);
  assert.deepEqual(taskOption(task, 'owner'), { value: 'claude_owner', label: 'claude_owner' });
  assert.equal(taskOwnerId(task), 'claude_owner');
  assert.equal(taskOwnerId(queued), 'instance-queued');
  assert.equal(taskOwnerId({ ...task, dispatch: { ...dispatch, owner: 'codex_owner' } }), 'codex_owner');
  assert.strictEqual(withOwnerProfiles([queued], [])[0], queued);
});

test('named registrations merge by name and legacy instance selections resolve to that name', () => {
  const options = filterOptions(['attached-one', 'attached-two'].map(ownerId => ({
    ...claude, id: ownerId, ownerId, owner: { ...owner, name: 'Mario' },
  })), 'owner', emptySelection(), now);
  assert.deepEqual(options.map(({ value, label, count, ownerProfile }) => ({ value, label, count, ownerProfile })), [{ value: 'Mario', label: 'Mario', count: 2, ownerProfile: 'claude_owner' }]);
  const named = ['attached-one', 'attached-two'].map(ownerId => ({ ...claude, id: ownerId, ownerId, owner: { ...owner, name: 'Mario' } }));
  const selection = resolveSelection(sel({ owner: ['attached-one', 'attached-two', 'gone'] }), named, now);
  assert.deepEqual(selection.owner, ['Mario']);
  assert.equal(applyTaskFilters(named, selection, undefined, now).length, 2);
  assert.deepEqual(taskOption({ ...named[0], dispatch: undefined }, 'owner'), { value: 'Mario', label: 'Mario' });
  assert.equal(filterOptions([...named, { ...named[0], id: 'closed', status: 'failed' }], 'owner', emptySelection(), now)[0].count, 3);
});


test('time ranges use last activity with inclusive cutoffs and a supplied clock', () => {
  const clock = new Date(2026, 9, 19, 14, 30).getTime();
  for (const [time, hours] of [['1h', 1], ['24h', 24], ['7d', 168], ['30d', 720]] as const) {
    const cutoff = clock - hours * 3600000;
    const entries = [cutoff - 1, cutoff, clock].map((stamp, index) => ({ ...claude, id: String(index), updatedAt: new Date(stamp).toISOString() }));
    assert.deepEqual(filterByTime(entries, time, clock).map(task => task.id), ['1', '2']);
    assert.equal(filterByTime(entries, 'all', clock).length, 3);
  }
  const midnight = new Date(2026, 9, 19).getTime();
  const entries = [midnight - 1, midnight, clock, clock + 1].map((stamp, index) => ({ ...claude, id: String(index), updatedAt: new Date(stamp).toISOString() }));
  assert.deepEqual(filterByTime(entries, 'today', clock).map(task => task.id), ['1', '2']);
});

test('time ANDs with dimensions and constrains their open counts without dropping selected dimensions', () => {
  const recent = { ...claude, id: 'recent', updatedAt: ago(0.5) };
  const old = { ...codex, id: 'old', updatedAt: ago(2) };
  const selection = sel({ time: '1h', owner: ['codex_owner'] });
  assert.deepEqual(applyTaskFilters([recent, old], selection, undefined, now), []);
  assert.deepEqual(resolveSelection(selection, [recent, old], now), selection);
  for (const dimension of ['owner', 'worker'] as const) {
    const options = filterOptions([recent, old], dimension, sel({ time: '1h' }), now);
    assert.equal(options.reduce((sum, option) => sum + option.count, 0), 1);
  }
  assert.equal(hasFilters(sel({ time: '1h' })), true);

});

test('time selection persists, defaults old payloads, and resets with clear', () => {
  const seed: Record<string, string> = {};
  withStorage(seed, () => {
    writeTaskFilters(sel({ time: '7d' }));
    assert.deepEqual(readTaskFilters(), sel({ time: '7d' }));
    const html = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, now }));
    assert.match(html, /aria-pressed="true"[^>]*>(?:(?!<\/button>)[\s\S])*近 7 天/);
    assert.match(html, /移除 近 7 天/);
    writeTaskFilters(emptySelection());
    assert.equal(readTaskFilters().time, 'today');
    assert.equal(hasFilters(readTaskFilters()), false);
  });
  for (const time of [undefined, 'bad', [], 7]) {
    assert.deepEqual(withStorage({ [TASK_FILTERS_KEY]: JSON.stringify({ owner: ['claude_owner'], time }) }, readTaskFilters), sel({ owner: ['claude_owner'] }));
  }
});


test('today is the default for fresh storage, legacy payloads and clear; explicit ranges survive', () => {
  const expected = { status: [], owner: [], worker: [], workspace: [], time: 'today' };
  assert.deepEqual(emptySelection(), expected);
  assert.deepEqual(withStorage({}, readTaskFilters), expected);
  assert.deepEqual(withStorage({ [TASK_FILTERS_KEY]: '{}' }, readTaskFilters), expected);
  assert.equal(hasFilters(sel({ time: 'today' })), false);
  for (const time of ['all', '1h', '24h', '7d', '30d'] as const) {
    assert.equal(withStorage({ [TASK_FILTERS_KEY]: JSON.stringify({ time }) }, readTaskFilters).time, time);
    assert.equal(hasFilters(sel({ time })), true);
  }
  const html = withStorage({}, () => markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, now })));
  assert.match(html, /aria-pressed="true"[^>]*>(?:(?!<\/button>)[\s\S])*今天/);
  assert.doesNotMatch(html, /移除 今天/);
  const all = markup(React.createElement(TaskBoard, { tasks, filters: sel({ time: 'all' }), loading: false, onSelect: () => {}, now }));
  assert.match(all, /aria-pressed="true"[^>]*>(?:(?!<\/button>)[\s\S])*全部/);
  assert.match(all, /移除 全部/);
});

test('archive keeps old work across board time choices and still narrows by owner, worker and status', () => {
  const tooOld = { ...staleFailed, id: 'older', updatedAt: ago(31 * 24) };
  const entries = [...archived, tooOld];
  for (const time of ['today', '1h', 'all'] as const) {
    withStorage({ [TASK_FILTERS_KEY]: JSON.stringify(sel({ time })) }, () => {
      assert.equal(archiveRows(entries, { ...emptySelection(), time: 'all' }, now).length, 4);
      assert.deepEqual(archiveRows(entries, { ...emptySelection(), time: 'all', owner: ['claude_owner'], status: ['failed'] }, now).map(task => task.id), ['a1', 'older']);
      assert.deepEqual(archiveRows(entries, { ...emptySelection(), time: 'all', owner: ['codex_owner'], worker: ['claude_worker'] }, now), []);
    });
  }
});

test('an empty today board offers all time only when matching older open work can be revealed', () => {
  const clock = new Date(2026, 9, 19, 14, 30).getTime();
  const yesterday = new Date(2026, 9, 18, 14, 30).toISOString();
  const older = { ...claude, updatedAt: yesterday };
  const props = { tasks: [older], loading: false, onSelect: () => {}, now: clock, filters: sel({ time: 'today' }) };
  const html = markup(React.createElement(TaskBoard, props));
  assert.match(html, /今天没有任务/);
  assert.match(html, /<button[^>]*>[\s\S]*?查看全部<\/button>/);
  const all = markup(React.createElement(TaskBoard, { ...props, filters: sel({ time: 'all' }) }));
  assert.match(all, /接入新引擎/);
  assert.doesNotMatch(all, /今天没有任务/);
  for (const tasks of [[{ ...older, status: 'failed' as const }], [staleFailed]]) {
    assert.doesNotMatch(markup(React.createElement(TaskBoard, { ...props, tasks })), /今天没有任务|查看全部/);
  }
  assert.doesNotMatch(markup(React.createElement(TaskBoard, { ...props, filters: sel({ time: '1h' }) })), /今天没有任务|查看全部/);
  assert.doesNotMatch(markup(React.createElement(TaskBoard, { ...props, tasks: [older, { ...codex, updatedAt: yesterday, dispatch: { ...codex.dispatch!, engine: 'codex' } }], filters: sel({ owner: ['codex_owner'], worker: ['claude_worker'] }) })), /今天没有任务|查看全部/);
});


test('detail default overview excludes prompt and requirements and keeps all facts below the tabs', () => {
  const html = markup(React.createElement(TaskDetail, { task: { ...claude, instruction: 'PRIVATE_PROMPT', constraints: ['ONLY_REQUIREMENT'], acceptanceCriteria: ['CRITERION_ONE'], summary: 'RESULT_TEXT' }, ...detailProps }));
  const labels = [...html.matchAll(/role="tab"[^>]*>([^<]+)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(labels, ['概览', 'Prompt', '要求 2', '时间线 1', '产物 0', '验收', '接续']);
  assert.doesNotMatch(html, /PRIVATE_PROMPT|ONLY_REQUIREMENT|CRITERION_ONE|此旧任务未记录/);
  assert.match(html, /RESULT_TEXT/);
  const beforeTabs = html.slice(0, html.indexOf('aria-label="任务记录"'));
  assert.doesNotMatch(beforeTabs, /<dt|更新于|RESULT_TEXT|Reading TaskBoard/);
  assert.match(html, /Reading TaskBoard.tsx/);
});

test('detail hides artifacts duplicating trimmed execution summary and counts only remaining artifacts', () => {
  const artifact = { id: 'result', name: 'result.md', content: '  UNIQUE_SUMMARY\n', mediaType: 'text/markdown' as const, createdAt: claude.updatedAt };
  const render = (artifacts: Task['artifacts']) => markup(React.createElement(TaskDetail, { task: { ...claude, summary: 'UNIQUE_SUMMARY', artifacts }, ...detailProps }));
  assert.match(render([artifact]), /产物 0/);
  assert.equal((render([artifact]).match(/UNIQUE_SUMMARY/g) ?? []).length, 1);
  assert.match(render([artifact, { ...artifact, id: 'other', name: 'notes.md', content: 'different' }]), /产物 1/);
});

test('summary clamp offers expansion only for long text and preserves copy', () => {
  const short = markup(React.createElement(TaskTextBlock, { title: '执行结果', content: 'short result', clamp: 6 }));
  assert.match(short, /复制执行结果/);
  assert.doesNotMatch(short, /aria-expanded/);
  const long = markup(React.createElement(TaskTextBlock, { title: '执行结果', content: Array(10).fill('result line').join('\n'), clamp: 6 }));
  assert.match(long, /aria-expanded="false"/);
  assert.match(long, /展开/);
  assert.match(long, /aria-controls=/);
});

test('legacy engine selection is ignored while owner worker and time survive', () => {
  const stored = { owner: ['claude_owner'], worker: ['claude_worker'], engine: ['missing-engine'], time: 'all' };
  const loaded = withStorage({ [TASK_FILTERS_KEY]: JSON.stringify(stored) }, readTaskFilters);
  assert.deepEqual(loaded, sel({ owner: stored.owner, worker: stored.worker, time: 'all' }));
  assert.deepEqual(applyTaskFilters(live, loaded, undefined, now).map(task => task.id), ['f1']);
});

test('board exposes all four status containers including the folded closed column', () => {
  const html = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, now }));
  for (const key of ['queued', 'running', 'review', 'closed']) assert.match(html, new RegExp('data-status-column="' + key + '"'));
  assert.match(html, /data-status-column="closed"[^>]*data-collapsed="true"/);
});
