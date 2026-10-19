import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../src/shared/types';
import { styles } from '../src/renderer/style';
import { TaskBoard } from '../src/renderer/components/TaskBoard';
import { applyTaskFilters, emptySelection, filterOptions, readTaskFilters, writeTaskFilters, TASK_FILTERS_KEY, ENDED_EXPANDED_KEY } from '../src/renderer/task-view';

const now = Date.parse('2026-10-18T12:00:00Z');
const base: Task = {
  id: 'one', ownerId: 'parent-instance', title: 'CARD_ONE', workspace: '/projects/alpha', instruction: '',
  owner: { name: 'Parent', transport: 'herdr-visible', session: '', pane: '' },
  status: 'running', progress: 0, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  events: [{ id: 'log', at: new Date(now).toISOString(), kind: 'log', message: 'ACTIVITY token=secret-value' }], artifacts: [],
  dispatch: { owner: 'parent', worker: 'WORKER', engine: 'custom', engineKind: 'claude', model: '', effort: '', execution: 'real', maxParallel: 1, workspace: '/frozen/other' },
};
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
function board(tasks: Task[]) {
  return storage({ [ENDED_EXPANDED_KEY]: 'true' }, () => markup(React.createElement(TaskBoard, { tasks, filters: { ...emptySelection(), time: 'all' }, now, loading: false, onSelect: () => {} })));
}
function card(task: Task) {
  const html = board([task]);
  const result = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(match => match[0].includes(task.title));
  assert.ok(result);
  return result[0];
}

test('card title stays separate from the dispatched sub agent and compact facts identify the parent', () => {
  const html = card(base);
  assert.match(html, /<strong[^>]*>CARD_ONE<\/strong>[\s\S]*<title>Claude Code<\/title>[\s\S]*WORKER/);
  /** One text flow: tag and title live in the same title block, with no separate title column. */
  const block = html.match(new RegExp(`<span class="${styles.cardTitle}">([\\s\\S]*?)</span></button>|<span class="${styles.cardTitle}">([\\s\\S]*?</strong>)</span>`));
  assert.ok(block);
  const inner = block[1] ?? block[2];
  assert.ok(inner.includes('CARD_ONE'));
  assert.doesNotMatch(inner, /WORKER/);
  assert.equal((html.match(/>WORKER</g) ?? []).length, 1);
  assert.equal((html.match(/<dt/g) ?? []).length, 1);
  assert.match(html, /父 Agent/);
  assert.doesNotMatch(html, /目录|\/projects|\/frozen/);
  assert.doesNotMatch(card({ ...base, dispatch: undefined }), /WORKER|<title>Claude Code/);
});

test('running and cancelling cards show redacted activity after status and compact time', () => {
  for (const task of [base, { ...base, status: 'cancelling' as const }]) {
    const html = card(task);
    const row = html.slice(html.indexOf(`class="${styles.cardStatus}"`), html.indexOf('<dl'));
    assert.ok(row, 'status, activity and time must share one row');
    assert.match(row, /ACTIVITY/);
    assert.doesNotMatch(row, /secret-value/);
    assert.match(row, /<time[^>]*dateTime="2026-10-18T12:00:00.000Z"/i);
    assert.equal((row.match(/lucide-loader-2/g) ?? []).length, 1);
    assert.ok(row.indexOf('ACTIVITY') > row.indexOf('<time'));
  }
  assert.match(card({ ...base, events: [] }), /等待首次调度/);
});

test('completed, failed, cancelled and unscheduled queued cards keep status and time without activity', () => {
  for (const [status, label] of [['completed', '待验收'], ['failed', '失败'], ['cancelled', '已取消'], ['queued', '待执行']] as const) {
    const html = card({ ...base, status });
    const row = html.slice(html.indexOf(`class="${styles.cardStatus}"`), html.indexOf('<dl'));
    assert.ok(row, 'status and time must share one row');
    assert.match(row, new RegExp(label));
    assert.doesNotMatch(html, /ACTIVITY|secret-value|等待首次调度|lucide-loader-2/);
    assert.ok(html.indexOf('</strong>') < html.indexOf(label));
    assert.ok(html.indexOf(label) < html.indexOf('<time'));
    assert.ok(html.indexOf('<time') < html.indexOf('<dl'));
  }
});

test('workspace groups use task workspace, sort by newest task and omit headings for a single group', () => {
  const tasks = [
    { ...base, id: 'old-alpha', title: 'ALPHA_OLD', updatedAt: '2026-10-18T09:00:00Z' },
    { ...base, id: 'beta', title: 'BETA', workspace: '/projects/beta', updatedAt: '2026-10-18T10:00:00Z' },
    { ...base, id: 'new-alpha', title: 'ALPHA_NEW', updatedAt: '2026-10-18T11:00:00Z' },
    { ...base, id: 'queued', title: 'QUEUED', status: 'queued' as const },
  ];
  const html = board(tasks);
  assert.match(html, /<h3[^>]*title="\/projects\/alpha"[\s\S]*?alpha[\s\S]*?>2<\/span>/);
  assert.match(html, /<h3[^>]*title="\/projects\/beta"/);
  assert.ok(html.indexOf('ALPHA_NEW') < html.indexOf('ALPHA_OLD'));
  assert.ok(html.indexOf('ALPHA_OLD') < html.indexOf('>BETA<'));
  assert.equal((html.match(/<h3/g) ?? []).length, 2);
  assert.doesNotMatch(board([base]), /<h3/);
});

test('all four status columns group independently and the closed column remains folded by default', () => {
  const tasks = (['queued', 'running', 'completed', 'failed'] as const).flatMap((status, index) =>
    ['/projects/alpha', '/projects/beta'].map((workspace, group) => ({ ...base, id: `${index}-${group}`, title: `${status}-${group}`, status, workspace })));
  const html = board(tasks);
  for (const column of ['queued', 'running', 'review', 'closed']) {
    const content = html.slice(html.indexOf(`data-status-column="${column}"`) + 1).split(/data-status-column=/)[0];
    assert.equal((content.match(/<h3/g) ?? []).length, 2);
  }
  const folded = storage({}, () => markup(React.createElement(TaskBoard, { tasks, filters: { ...emptySelection(), time: 'all' }, now, loading: false, onSelect: () => {} })));
  assert.match(folded, /data-status-column="closed"[^>]*data-collapsed="true"/);
  assert.doesNotMatch(folded, />failed-0<|>failed-1</);
});

test('workspace multi-select ANDs other filters and time, counts tasks in scope, and keeps a chosen empty value checked', () => {
  const tasks = [base, { ...base, id: 'beta', workspace: '/elsewhere/alpha', status: 'failed' as const }, { ...base, id: 'old', workspace: '/projects/old', updatedAt: '2026-10-18T08:00:00Z' }];
  const selection = { ...emptySelection(), workspace: ['/projects/alpha', '/elsewhere/alpha'], owner: ['Parent'], worker: ['WORKER'], time: '1h' as const };
  assert.deepEqual(applyTaskFilters(tasks, selection, undefined, now).map(task => task.id), ['one', 'beta']);
  assert.deepEqual(applyTaskFilters(tasks, { ...selection, worker: ['other'] }, undefined, now), []);
  /** Time scopes the options: the 4-hour-old directory is not offered; labels are the last segment, full path is identity. */
  const options = filterOptions(tasks, 'workspace', selection, now);
  assert.deepEqual(options.map(option => [option.value, option.label, option.count]), [['/projects/alpha', 'alpha', 1], ['/elsewhere/alpha', 'alpha', 1]]);
  const html = board(tasks);
  assert.match(html, /工作目录/);
  assert.match(html, /title="\/projects\/alpha"/);
});

test('workspace selection persists and legacy payloads initialize the new dimension empty', () => {
  const values: Record<string, string> = {};
  storage(values, () => {
    const selection = { ...emptySelection(), workspace: ['/projects/alpha'] };
    writeTaskFilters(selection);
    assert.deepEqual(readTaskFilters(), selection);
    values[TASK_FILTERS_KEY] = JSON.stringify({ owner: ['Parent'], worker: ['WORKER'], time: 'all' });
    assert.deepEqual(readTaskFilters(), { status: [], owner: ['Parent'], worker: ['WORKER'], workspace: [], time: 'all' });
  });
});
