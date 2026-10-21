import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { boardRows, workspaceGroups } from '../../src/renderer/features/tasks/task-columns';
import { ARCHIVE_PAGINATION_BAR, ARCHIVE_TABLE_HEADER, ARCHIVE_TABLE_MIN_BODY, archiveScrollY } from '../../src/renderer/features/tasks/task-archive';
import { ArchiveList } from '../../src/renderer/features/tasks/ArchiveDrawer';
import { SSR_ROWS, VirtualLane } from '../../src/renderer/features/tasks/VirtualLane';

function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const now = Date.parse('2026-10-18T02:00:00Z');
const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 'unverified', pane: 'unverified' };
/** Hundreds of finished tasks spread over a few directories, older than a day so they live in the archive. */
function crowd(count: number, directories = 5, hoursAgo = 30): Task[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`, title: `CROWD_${index}`, instruction: '', owner, status: 'cancelled' as const, progress: 0,
    workspace: `/projects/dir-${index % directories}`,
    createdAt: new Date(now - (hoursAgo * 60 + index) * 60_000).toISOString(), updatedAt: new Date(now - (hoursAgo * 60 + index) * 60_000).toISOString(),
    events: [], artifacts: [],
  }));
}

test('column rows flatten workspace groups into a heading plus its cards, and a single group still gets a heading', () => {
  const tasks = crowd(12, 3);
  const rows = boardRows(workspaceGroups(tasks));
  assert.equal(rows.length, 12 + 3);
  assert.deepEqual(rows.map(row => row.kind).slice(0, 5), ['heading', 'card', 'card', 'card', 'card']);
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length, 'every row has its own key');
  const heading = rows[0];
  assert.ok(heading.kind === 'heading' && heading.count === 4 && heading.label.startsWith('dir-') && heading.title.startsWith('/projects/dir-'));
  const single = boardRows(workspaceGroups(crowd(7, 1)));
  assert.equal(single.length, 7 + 1);
  const singleHeading = single[0];
  assert.ok(singleHeading.kind === 'heading' && singleHeading.count === 7 && singleHeading.label === 'dir-0' && singleHeading.title === '/projects/dir-0');
  assert.ok(single.slice(1).every(row => row.kind === 'card'));
  const unnamed = boardRows(workspaceGroups([{} as Task]));
  const unnamedHeading = unnamed[0];
  assert.ok(unnamedHeading.kind === 'heading' && unnamedHeading.label === '未指定工作目录' && unnamedHeading.title === '未指定工作目录' && unnamedHeading.count === 1);
  assert.deepEqual(boardRows([]), []);
});

test('a lane of hundreds of rows mounts only a window of them, in order', () => {
  const rows = boardRows(workspaceGroups(crowd(300)));
  assert.equal(rows.length, 305);
  const html = markup(React.createElement(VirtualLane<typeof rows[number]>, { rows, rowKey: row => row.key, rowKind: row => row.kind,
    children: row => row.kind === 'card' ? React.createElement('span', null, row.task.title) : React.createElement('h3', null, row.label) }));
  const mounted = html.match(/data-row="(card|heading)"/g) ?? [];
  assert.equal(mounted.length, SSR_ROWS);
  assert.ok(mounted.length < rows.length / 5);
  assert.match(html, /CROWD_/);
  assert.doesNotMatch(html, /CROWD_299\b/, 'the tail of the list is not mounted');
  const small = markup(React.createElement(VirtualLane<string>, { rows: ['a', 'b', 'c'], rowKey: row => row, rowKind: () => 'card', children: row => React.createElement('b', null, row) }));
  assert.equal((small.match(/data-row="card"/g) ?? []).length, 3, 'a short lane still shows every row');
});

test('the archive table is virtual with a numeric body height, so 300 archived tasks mount only the rows near the top', () => {
  const html = markup(React.createElement(ArchiveList, { tasks: crowd(300), onSelect: () => {}, now }));
  const rows = html.match(/CROWD_\d+/g) ?? [];
  assert.ok(rows.length > 0, 'the visible rows are rendered');
  assert.ok(rows.length < 40, `only a window of rows is mounted, got ${rows.length}`);
  assert.doesNotMatch(html, /CROWD_299\b/);
  const source = readFileSync(new URL('../../src/renderer/features/tasks/ArchiveDrawer.tsx', import.meta.url), 'utf8');
  assert.match(source, /<Table<Task>[^>]*\svirtual\s/);
  assert.match(source, /scroll=\{\{[^}]*y: archiveScrollY\(/);
});

test('the archive body height follows the room the drawer leaves, once the header and the pager are paid for', () => {
  assert.equal(archiveScrollY(900, ARCHIVE_PAGINATION_BAR), 900 - ARCHIVE_TABLE_HEADER - ARCHIVE_PAGINATION_BAR);
  assert.equal(archiveScrollY(435.7, ARCHIVE_PAGINATION_BAR), 355);
  assert.equal(archiveScrollY(900, ARCHIVE_PAGINATION_BAR * 2), 900 - ARCHIVE_TABLE_HEADER - ARCHIVE_PAGINATION_BAR * 2);
  assert.equal(archiveScrollY(undefined, ARCHIVE_PAGINATION_BAR), ARCHIVE_TABLE_MIN_BODY);
  assert.equal(archiveScrollY(0, ARCHIVE_PAGINATION_BAR), ARCHIVE_TABLE_MIN_BODY);
  assert.equal(archiveScrollY(120, ARCHIVE_PAGINATION_BAR), ARCHIVE_TABLE_MIN_BODY);
});

test('the board columns render through the virtual lane and keep the selected card mounted', () => {
  const source = readFileSync(new URL('../../src/renderer/features/tasks/TaskBoard.tsx', import.meta.url), 'utf8');
  assert.match(source, /<VirtualLane rows=\{rows\}/);
  assert.match(source, /pinned=\{[^}]*task\.id === selected/);
  assert.doesNotMatch(source, /group\.tasks\.map/);
});
