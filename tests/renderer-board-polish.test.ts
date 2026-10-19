import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../src/shared/types';
import { TaskBoard, TaskFacets } from '../src/renderer/components/TaskBoard';
import { TasksPage } from '../src/renderer/pages/TasksPage';
import { archiveColumns, archiveRowProps } from '../src/renderer/components/ArchiveDrawer';
import { DISPLAY_TONES } from '../src/renderer/status-colors';
import { emptySelection, ENDED_EXPANDED_KEY } from '../src/renderer/task-view';

const now = new Date(2026, 9, 19, 14, 25).getTime();
const task: Task = { id: 'one', title: 'POLISH_TITLE', status: 'running', owner: { name: 'Parent', transport: 'herdr-visible', session: '', pane: '' }, instruction: '', workspace: '/projects/enterprise', progress: 0, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), events: [], artifacts: [] };
const markup = (node: React.ReactNode) => renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { enableCustomFonts: false, children: node }) }));
function board(tasks: Task[], filters = emptySelection()) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => key === ENDED_EXPANDED_KEY ? 'true' : null } });
  try { return markup(React.createElement(TaskBoard, { tasks, filters, now, loading: false, onSelect: () => {} })); }
  finally { if (prior) Object.defineProperty(globalThis, 'localStorage', prior); else Reflect.deleteProperty(globalThis, 'localStorage'); }
}

test('every lane limits the initial cards to the newest twenty', () => {
  for (const status of ['queued', 'running', 'completed', 'failed'] as const) {
    const tasks = Array.from({ length: 23 }, (_, n) => ({ ...task, status, id: `item-${n}`, title: `POLISH_${n}_END`, updatedAt: new Date(now - n * 1000).toISOString() }));
    const html = board(tasks);
    assert.equal((html.match(/<strong[^>]*>POLISH_\d+_END/g) ?? []).length, 20);
    assert.match(html, /POLISH_0_END/);
    assert.doesNotMatch(html, /POLISH_20_END/);
    assert.match(html, /查看全部 23/);
  }
});

test('no matching tasks show a single empty state and offer a clear action', () => {
  // Use a real but incompatible combination: both status values remain known to the board.
  const noMatch = board([task, { ...task, id: 'failed', status: 'failed', updatedAt: new Date(now - 7200000).toISOString() }], { ...emptySelection(), time: '1h', status: ['failed'] });
  assert.doesNotMatch(noMatch, /data-status-column=|暂无任务/);
  assert.match(noMatch, /没有匹配的任务/);
  assert.match(noMatch, /清除筛选/);
});

test('cards show compact local time and preserve full timestamp in a tooltip', () => {
  const html = board([task]);
  assert.match(html, /<time[^>]*title="[^"]+"[^>]*>14:25<\/time>/);
  const yesterday = board([{ ...task, updatedAt: new Date(2026, 9, 18, 14, 25).toISOString() }], { ...emptySelection(), time: 'all' });
  assert.match(yesterday, />10-18 14:25<\/time>/);
});

test('queue uses a static clock and the shared tones distinguish stopping and rejection', () => {
  const html = board([{ ...task, status: 'queued', scheduled: true }]);
  assert.match(html, /lucide-clock/);
  assert.doesNotMatch(html, /lucide-loader/);
  assert.equal(DISPLAY_TONES.rejected, 'volcano');
  assert.equal(DISPLAY_TONES.cancelling, 'orange');
  assert.equal(DISPLAY_TONES.review, 'warning');
});

test('archive directory cells retain the full path without splitting the directory name', () => {
  const columns = archiveColumns();
  assert.equal(columns.find(c => c.key === 'project')?.title, '工作目录');
  const cell = columns.find(c => c.key === 'project')!;
  const html = markup(React.createElement(React.Fragment, null, cell.render?.('', task, 0) as React.ReactNode));
  assert.match(html, /title="\/projects\/enterprise"/);
  assert.match(html, />enterprise</);
  const opened: string[] = [];
  const props = archiveRowProps(task, undefined, id => opened.push(id));
  assert.equal(props.tabIndex, 0);
  props.onKeyDown?.({ key: 'Enter', preventDefault() {} } as never);
  assert.deepEqual(opened, ['one']);
});

test('default facets hide selected content, while an explicit all-time choice remains removable', () => {
  const facets = (selection = emptySelection()) => markup(React.createElement(TaskFacets, { board: [task], selection, collapsed: false, now, onChange: () => {}, onCollapse: () => {} }));
  const defaults = facets();
  assert.match(defaults, /data-active="false" aria-hidden="true" inert=""/);
  assert.doesNotMatch(defaults, /aria-label="移除 今天"|未选择/);
  const all = facets({ ...emptySelection(), time: 'all' });
  assert.match(all, /data-active="true" aria-hidden="false"/);
  assert.match(all, /aria-label="移除 全部"/);
  assert.match(all, /时间：全部/);
});

test('archive count stays unknown during loading instead of reporting zero', () => {
  const work = { tasks: [], loading: true, busy: false, caps: undefined } as unknown as React.ComponentProps<typeof TasksPage>['work'];
  const html = markup(React.createElement(TasksPage, { work }));
  assert.match(html, /aria-label="正在加载归档数量">…/);
  assert.doesNotMatch(html, /归档 0/);
});
