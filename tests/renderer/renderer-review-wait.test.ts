import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { taskStyles as styles } from '../../src/renderer/features/tasks/task-style';
import { styleClass } from './style-helpers';
import { TaskBoard } from '../../src/renderer/features/tasks/TaskBoard';
import { columnize } from '../../src/renderer/features/tasks/task-columns';
import { REVIEW_OVERDUE_HINT, REVIEW_WAIT_WARN_MINUTES, RECEIPT_ACK_MESSAGE, formatWait, reviewWait } from '../../src/renderer/features/tasks/task-wait';
import { emptySelection } from '../../src/renderer/features/tasks/task-filters';
import { ENDED_EXPANDED_KEY } from '../../src/renderer/features/tasks/task-persistence';

const now = new Date(2026, 9, 19, 23, 0).getTime();
const at = (hour: number, minute: number) => new Date(2026, 9, 19, hour, minute).toISOString();
const ago = (minutes: number) => new Date(now - minutes * 60000).toISOString();
const owner = { name: 'Claude · enterprise · 21:30', transport: 'herdr-visible' as const, session: 's', pane: 'p' };
const make = (id: string, extra: Partial<Task> = {}): Task => ({
  id, ownerId: `instance-${id}`, owner, title: `卡片 ${id}`, instruction: '', workspace: '/projects/enterprise', status: 'completed', progress: 100,
  createdAt: at(20, 0), updatedAt: ago(10), events: [], artifacts: [], ...extra,
});
const run = (endedAt: string): Task['run'] => ({ id: 'run', adapter: 'x', status: 'stopped', startedAt: at(20, 5), endedAt });
const ack = (time: string): Task['events'][number] => ({ id: `ack-${time}`, at: time, kind: 'lifecycle', message: RECEIPT_ACK_MESSAGE });

test('wait durations: under an hour in minutes, from an hour as hours and minutes', () => {
  assert.equal(formatWait(0), '0 分钟');
  assert.equal(formatWait(59), '59 分钟');
  assert.equal(formatWait(60), '1 小时 0 分钟');
  assert.equal(formatWait(125), '2 小时 5 分钟');
});

test('an unacknowledged review counts from completion, taken the way the footer takes 完成于', () => {
  // run.endedAt wins over updatedAt (the footer's source); the minutes floor, never round up.
  const task = make('a', { run: run(ago(59)), updatedAt: ago(5) });
  assert.deepEqual(reviewWait(task, now + 30_000), { acknowledged: false, text: '待父 Agent 确认收到 · 已等 59 分钟', minutes: 59, overdue: true, title: REVIEW_OVERDUE_HINT });
  assert.equal(reviewWait(make('b', { run: run(ago(60)) }), now)!.text, '待父 Agent 确认收到 · 已等 1 小时 0 分钟');
  assert.equal(reviewWait(make('c', { run: run(ago(125)) }), now)!.text, '待父 Agent 确认收到 · 已等 2 小时 5 分钟');
  // Without a run end the last update is the completion time.
  assert.equal(reviewWait(make('d', { updatedAt: ago(7) }), now)!.text, '待父 Agent 确认收到 · 已等 7 分钟');
});

test('an acknowledged review counts from the receipt event, and falls back to updatedAt without one', () => {
  const task = make('e', { acknowledged: true, run: run(ago(200)), updatedAt: ago(1), events: [ack(ago(100)), { id: 'x', at: ago(2), kind: 'log', message: 'later' }] });
  assert.equal(reviewWait(task, now)!.text, '已确认收到 · 待验收结论 · 已等 1 小时 40 分钟');
  // The latest receipt event wins.
  assert.equal(reviewWait({ ...task, events: [ack(ago(100)), ack(ago(20))] }, now)!.minutes, 20);
  // No receipt event (or an unreadable one): updatedAt, never the completion time.
  assert.equal(reviewWait({ ...task, events: [] }, now)!.text, '已确认收到 · 待验收结论 · 已等 1 分钟');
  assert.equal(reviewWait({ ...task, events: [ack('nope')] }, now)!.minutes, 1);
});

test('the warning starts after the named threshold and carries the hover hint', () => {
  assert.equal(REVIEW_WAIT_WARN_MINUTES, 30);
  const wait = (minutes: number) => reviewWait(make('t', { updatedAt: ago(minutes) }), now)!;
  assert.deepEqual([wait(29).overdue, wait(30).overdue, wait(31).overdue], [false, false, true]);
  assert.equal(wait(30).title, undefined);
  assert.equal(wait(31).title, '父 Agent 尚未提交验收，请检查其运行状态');
  assert.equal(reviewWait(make('t', { acknowledged: true, events: [ack(ago(45))] }), now)!.overdue, true);
});

test('only review-lane cards have a wait line', () => {
  for (const extra of [{ status: 'running' }, { status: 'queued' }, { status: 'failed' }, { reviewState: 'accepted' }, { reviewState: 'rejected' }] as Partial<Task>[]) {
    assert.equal(reviewWait(make('n', extra), now), null, JSON.stringify(extra));
  }
});

function board(tasks: Task[]) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => key === ENDED_EXPANDED_KEY ? 'true' : null, setItem: () => {} } });
  try {
    return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'light', children: React.createElement(TaskBoard, { tasks, filters: { ...emptySelection(), time: 'all' }, now, loading: false, onSelect: () => {} }) }) }));
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
}

test('the board shows the wait line on review cards only, warning-marked once overdue', () => {
  const html = board([
    make('p', { title: 'CARD_PENDING', updatedAt: ago(10) }),
    make('q', { title: 'CARD_ACKED', acknowledged: true, events: [ack(ago(125))] }),
    make('r', { title: 'CARD_DONE', reviewState: 'accepted' }),
    make('s', { title: 'CARD_RUNNING', status: 'running' }),
  ]);
  const cards = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).filter(card => /CARD_/.test(card));
  const byTitle = (title: string) => cards.find(card => card.includes(title))!;
  const pending = byTitle('CARD_PENDING');
  assert.match(pending, new RegExp(`<span class="${styleClass(styles.cardWait)}" data-overdue="false" data-wait="pending">待父 Agent 确认收到 · 已等 10 分钟</span>`));
  assert.doesNotMatch(pending, /请检查其运行状态/);
  const acked = byTitle('CARD_ACKED');
  assert.match(acked, new RegExp(`class="${styleClass(styles.cardWait)}" data-overdue="true" data-wait="acknowledged" title="父 Agent 尚未提交验收，请检查其运行状态">已确认收到 · 待验收结论 · 已等 2 小时 5 分钟</span>`));
  // The line sits between the status tag and the footer sentence, and no other card has one.
  assert.ok(acked.indexOf(styleClass(styles.cardStatus)) < acked.indexOf(styleClass(styles.cardWait)) && acked.indexOf(styleClass(styles.cardWait)) < acked.indexOf(styleClass(styles.cardMeta)));
  assert.doesNotMatch(byTitle('CARD_DONE') + byTitle('CARD_RUNNING'), new RegExp(styleClass(styles.cardWait)));
});

test('the review lane keeps its updatedAt ordering: the wait line does not reorder cards', () => {
  const older = make('old', { updatedAt: ago(90) });
  const newer = make('new', { updatedAt: ago(5) });
  assert.deepEqual(columnize([older, newer])[2]!.map(task => task.id), ['new', 'old']);
});
