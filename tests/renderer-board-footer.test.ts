import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../src/shared/types';
import { styles } from '../src/renderer/style';
import { TaskBoard } from '../src/renderer/components/TaskBoard';
import { ENDED_EXPANDED_KEY, applyTaskFilters, archiveRows, cardFooter, cardFooterText, columnize, emptySelection, facetOptions, filterOptions, nonArchived, ownerHostName, ownerLabel, resolveSelection, taskOptions, childIndex } from '../src/renderer/task-view';

const now = new Date(2026, 9, 19, 23, 0).getTime();
const at = (hour: number, minute: number, day = 19) => new Date(2026, 9, day, hour, minute).toISOString();
const INSTANCE = 'Claude · enterprise · 21:30';
const owner = { name: INSTANCE, transport: 'herdr-visible' as const, session: 's', pane: 'p' };
const make = (id: string, extra: Partial<Task> = {}): Task => ({
  id, ownerId: `instance-${id}`, title: `卡片 ${id}`, instruction: '', owner, workspace: '/projects/enterprise', status: 'running', progress: 0,
  createdAt: at(21, 0), updatedAt: at(22, 50), events: [], artifacts: [], ...extra,
});
const run = (startedAt?: string, endedAt?: string): Task['run'] => ({ id: 'run', adapter: 'x', status: endedAt ? 'stopped' : 'running', ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}) });
const event = (time: string): Task['events'][number] => ({ id: time, at: time, kind: 'log', message: 'ok' });
const text = (task: Task) => cardFooterText(cardFooter(task), now);

test('a task that never started was created, not dispatched, and has reported nothing', () => {
  for (const status of ['queued'] as const) assert.equal(text(make('q', { status })), '由 Claude 于 21:00 创建');
  assert.equal(cardFooter(make('q', { status: 'queued' })).tail, undefined);
});

test('an active task says when it was dispatched and when it last reported', () => {
  const task = make('r', { run: run(at(21, 5)), events: [event(at(21, 10)), event(at(22, 41))] });
  assert.equal(text(task), '由 Claude 于 21:05 派发 · 最新上报 22:41');
  // With no events the last word is the last update; a stopping task is still active.
  assert.equal(text(make('r2', { run: run(at(21, 5)) })), '由 Claude 于 21:05 派发 · 最新上报 22:50');
  assert.equal(text({ ...task, status: 'cancelling' }), '由 Claude 于 21:05 派发 · 最新上报 22:41');
});

test('a finished task says when it completed or ended instead of its last report', () => {
  const done = make('d', { status: 'completed', run: run(at(21, 5), at(22, 20)), events: [event(at(22, 19))] });
  assert.equal(text(done), '由 Claude 于 21:05 派发 · 完成于 22:20');
  assert.equal(text({ ...done, reviewState: 'accepted' }), '由 Claude 于 21:05 派发 · 完成于 22:20');
  assert.equal(text({ ...done, reviewState: 'rejected' }), '由 Claude 于 21:05 派发 · 完成于 22:20');
  assert.equal(text({ ...done, run: run(at(21, 5)) }), '由 Claude 于 21:05 派发 · 完成于 22:50');
  assert.equal(text({ ...done, status: 'failed' }), '由 Claude 于 21:05 派发 · 结束于 22:20');
  assert.equal(text({ ...done, status: 'cancelled' }), '由 Claude 于 21:05 派发 · 结束于 22:20');
  // Cancelled before it ever started: created, then ended.
  assert.equal(text(make('c', { status: 'cancelled', run: undefined })), '由 Claude 于 21:00 创建 · 结束于 22:50');
});

test('times follow the compact rule: today HH:mm, other days MM-DD HH:mm; unreadable times fall back', () => {
  const old = make('o', { status: 'failed', run: run(at(20, 0, 17), at(21, 30, 18)) });
  assert.equal(text(old), '由 Claude 于 10-17 20:00 派发 · 结束于 10-18 21:30');
  // A start that cannot be read is no start; an unreadable last event falls back to the last update.
  assert.equal(text(make('b', { run: run('not a time'), events: [event('nope')] })), '由 Claude 于 21:00 创建');
  assert.equal(text(make('b', { run: run(at(21, 5)), events: [event('nope')] })), '由 Claude 于 21:05 派发 · 最新上报 22:50');
});

test('a root parent task counts its Herdr launch as its dispatch', () => {
  const root = make('root', { executionRole: 'owner', ownerHost: { kind: 'herdr', session: 's', workspaceId: 'w', paneId: 'p', agentName: 'a', launchedAt: at(21, 15) } });
  assert.equal(text(root), '由 Claude 于 21:15 派发 · 最新上报 22:50');
  assert.equal(text({ ...root, ownerHost: undefined }), '由 Claude 于 21:00 创建');
});

test('the parent shows its host alone; the full instance name stays in the tooltip', () => {
  assert.equal(ownerLabel(make('x')), INSTANCE);
  assert.equal(ownerHostName(make('x')), 'Claude');
  assert.equal(ownerHostName(make('x', { owner: { ...owner, name: 'Codex' } })), 'Codex');
  assert.equal(ownerHostName(make('x', { owner: { ...owner, name: ' · enterprise · 21:30' } })), ' · enterprise · 21:30');
  // A frozen policy profile has no instance suffix and is shown as is.
  assert.equal(ownerHostName(make('x', { ownerId: undefined, dispatch: { owner: 'claude_owner', worker: 'w', engine: 'claude', model: 'm', effort: 'high', execution: 'real', maxParallel: 1 } })), 'claude_owner');
  assert.equal(cardFooter(make('x')).ownerTitle, INSTANCE);
});

function board(tasks: Task[]) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => key === ENDED_EXPANDED_KEY ? 'true' : null, setItem: () => {} } });
  try {
    return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: React.createElement(TaskBoard, { tasks, filters: { ...emptySelection(), time: 'all' }, now, loading: false, onSelect: () => {} }) }) }));
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
}

test('cards in every lane carry the footer sentence once, with the host only and no directory or second clock', () => {
  const tasks = [
    make('queued', { status: 'queued', title: 'LANE_QUEUED' }),
    make('running', { run: run(at(21, 5)), events: [event(at(22, 41))], title: 'LANE_RUNNING' }),
    make('review', { status: 'completed', run: run(at(21, 5), at(22, 20)), title: 'LANE_REVIEW' }),
    make('failed', { status: 'failed', run: run(at(21, 5), at(22, 30)), title: 'LANE_FAILED' }),
  ];
  const html = board(tasks);
  const cards = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).filter(card => /LANE_/.test(card));
  assert.equal(cards.length, 4);
  const expected: Record<string, RegExp> = {
    LANE_QUEUED: /由 <span[^>]*>.*?Claude<\/span><\/span> <span[^>]*>于 <time[^>]*>21:00<\/time> 创建<\/span><\/span><\/span><\/button>$/,
    LANE_RUNNING: /于 <time[^>]*>21:05<\/time> 派发(?:<span[^>]*> ·<\/span>)?<\/span>[\s\S]*最新上报 <time[^>]*>22:41<\/time>/,
    LANE_REVIEW: /于 <time[^>]*>21:05<\/time> 派发(?:<span[^>]*> ·<\/span>)?<\/span>[\s\S]*完成于 <time[^>]*>22:20<\/time>/,
    LANE_FAILED: /于 <time[^>]*>21:05<\/time> 派发(?:<span[^>]*> ·<\/span>)?<\/span>[\s\S]*结束于 <time[^>]*>22:30<\/time>/,
  };
  for (const card of cards) {
    const title = card.match(/LANE_[A-Z]+/)![0];
    const footer = card.slice(card.indexOf(`class="${styles.cardMeta}"`));
    assert.match(footer, expected[title]!, title);
    // Times appear only inside the footer; the instance's directory and session clock appear nowhere.
    assert.equal(card.slice(0, card.indexOf(`class="${styles.cardMeta}"`)).includes('<time'), false, title);
    assert.doesNotMatch(card.replace(/<[^>]*>/g, ''), /enterprise|21:30/, title);
    assert.match(card, /aria-label="父 Agent：Claude"[^>]*title="Claude · enterprise · 21:30"/, title);
    assert.equal((card.match(/aria-label="父 Agent/g) ?? []).length, 1, title);
    // One sentence: the dot closes the first part when there is a second one, and a card that has not started has no dot.
    assert.equal(/ ·<\/span>/.test(footer), title !== 'LANE_QUEUED', title);
  }
});

/* ---- sub agent facet over root tasks ---- */

const child = (id: string, parent: string, worker: string, extra: Partial<Task> = {}): Task => make(id, {
  parentTaskId: parent, dispatch: { owner: 'claude_owner', worker, engine: worker.split('_')[0]!, model: 'm', effort: 'high', execution: 'real', maxParallel: 1 }, ...extra,
});
const root = (id: string, extra: Partial<Task> = {}): Task => make(id, { executionRole: 'owner', ...extra });
const all = [
  root('r1'), child('r1a', 'r1', 'codex_worker'), child('r1b', 'r1', 'qoder_worker'),
  root('r2', { status: 'completed' }), child('r2a', 'r2', 'qoder_worker', { status: 'completed' }), child('r2b', 'r2', 'qoder_worker', { status: 'completed' }),
  root('r3', { status: 'queued' }),
  make('solo', { dispatch: { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'm', effort: 'high', execution: 'real', maxParallel: 1 } }),
];
const everything = { ...emptySelection(), time: 'all' as const };

test('a root answers for the sub agents its children ran on, once each', () => {
  const index = childIndex(all);
  assert.deepEqual(taskOptions(all[0]!, 'worker', index).map(option => option.value), ['codex_worker', 'qoder_worker']);
  assert.deepEqual(taskOptions(all[3]!, 'worker', index).map(option => option.value), ['qoder_worker']);
  assert.deepEqual(taskOptions(all[6]!, 'worker', index), []);
  assert.deepEqual(taskOptions(all[7]!, 'worker', index).map(option => option.value), ['claude_worker']);
  assert.deepEqual(taskOptions(all[0]!, 'status').map(option => option.value), ['running']);
});

test('sub agent chips count root tasks, the way the board lays them out', () => {
  const options = filterOptions(all, 'worker', everything, now);
  assert.deepEqual(options.map(option => [option.value, option.count]), [['qoder_worker', 2], ['claude_worker', 1], ['codex_worker', 1]]);
  assert.equal(options.find(option => option.value === 'codex_worker')?.kind, 'codex');
  // The chip's count is what choosing it leaves on the board.
  for (const option of options) {
    const shown = applyTaskFilters(nonArchived(all, now), { ...everything, worker: [option.value] }, undefined, now, all);
    assert.equal(shown.length, option.count, option.value);
    assert.equal(columnize(shown).flat().length, option.count, option.value);
  }
});

test('choosing a sub agent shows the roots that contain its children and ORs sub agents', () => {
  const pick = (...worker: string[]) => applyTaskFilters(nonArchived(all, now), { ...everything, worker }, undefined, now, all).map(task => task.id);
  assert.deepEqual(pick('qoder_worker'), ['r1', 'r2']);
  assert.deepEqual(pick('codex_worker'), ['r1']);
  assert.deepEqual(pick('codex_worker', 'claude_worker'), ['r1', 'solo']);
  assert.deepEqual(pick('ghost_worker'), []);
  // Without the full list a root cannot be matched: the old per-card behaviour is only for tasks that carry their own dispatch.
  assert.deepEqual(applyTaskFilters(nonArchived(all, now), { ...everything, worker: ['qoder_worker'] }, undefined, now).map(task => task.id), []);
});

test('other rows narrow the sub agent counts, and sub agent counts narrow the other rows', () => {
  const running = { ...everything, status: ['running' as const] };
  assert.deepEqual(filterOptions(all, 'worker', running, now).map(option => [option.value, option.count]), [['claude_worker', 1], ['codex_worker', 1], ['qoder_worker', 1]]);
  const qoder = { ...everything, worker: ['qoder_worker'] };
  assert.deepEqual(filterOptions(all, 'status', qoder, now).map(option => [option.value, option.count]), [['running', 1], ['review', 1]]);
});

test('a chosen sub agent survives resolution while any child still carries it', () => {
  assert.deepEqual(resolveSelection({ ...everything, worker: ['qoder_worker', 'ghost_worker'] }, all, now).worker, ['qoder_worker']);
  assert.deepEqual(facetOptions(nonArchived(all, now), 'worker', everything, now, all).map(option => option.value), ['qoder_worker', 'claude_worker', 'codex_worker']);
});

test('the archive filters finished roots by their children too', () => {
  const old = (id: string) => new Date(now - 3 * 24 * 3600e3 - id.length).toISOString();
  const tasks = [
    root('a1', { status: 'completed', reviewState: 'accepted', updatedAt: old('a1') }), child('a1c', 'a1', 'qoder_worker', { status: 'completed', updatedAt: old('a1c') }),
    root('a2', { status: 'failed', updatedAt: old('a2') }), child('a2c', 'a2', 'codex_worker', { status: 'failed', updatedAt: old('a2c') }),
  ];
  assert.deepEqual(archiveRows(tasks, { ...everything, worker: ['qoder_worker'] }, now).map(task => task.id), ['a1']);
  assert.deepEqual(facetOptions(tasks.filter(task => !task.parentTaskId), 'worker', everything, now, tasks).map(option => option.value).sort(), ['codex_worker', 'qoder_worker']);
});
