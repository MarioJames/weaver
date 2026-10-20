import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import {
  ARCHIVE_PAGE_SIZES, ARCHIVE_PAGE_SIZE, ARCHIVE_PAGINATION_BAR, ARCHIVE_SIZE_CHANGER_LABEL, applyArchivePage, archivePageCount, archivePageSizeLabel, archivePageSizeOptions, archiveScrollY, archiveTotalLabel, clampArchivePage, resetArchivePage,
} from '../../src/renderer/features/tasks/task-archive';
import { ArchiveList, ArchivePageSizeChanger } from '../../src/renderer/features/tasks/ArchiveDrawer';

function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const now = Date.parse('2026-10-18T02:00:00Z');
const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 'unverified', pane: 'unverified' };
/** Finished work older than a day, so all of it sits in the archive drawer. */
function crowd(count: number): Task[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`, title: `ARCHIVE_${index}`, instruction: '', owner, status: 'cancelled' as const, progress: 0,
    workspace: '/projects/weaver',
    createdAt: new Date(now - (30 * 60 + index) * 60_000).toISOString(), updatedAt: new Date(now - (30 * 60 + index) * 60_000).toISOString(),
    events: [], artifacts: [],
  }));
}

test('the archive pages 50 at a time and offers 20, 50 and 100 as the alternatives', () => {
  assert.deepEqual(ARCHIVE_PAGE_SIZES, [20, ARCHIVE_PAGE_SIZE, 100]);
  assert.equal(archivePageCount(130, ARCHIVE_PAGE_SIZE), 3);
});

test('a page the list no longer has shows its last page, and the first page stays the floor', () => {
  /** Nothing to page through is still one page, so the pager never asks for a page zero. */
  assert.equal(archivePageCount(0, ARCHIVE_PAGE_SIZE), 1);
  assert.equal(clampArchivePage(1, 0, ARCHIVE_PAGE_SIZE), 1);
  assert.equal(clampArchivePage(4, 1, ARCHIVE_PAGE_SIZE), 1);
  /** One page exactly: page 50 of 50 rows is still page 1. */
  assert.equal(clampArchivePage(2, 50, ARCHIVE_PAGE_SIZE), 1);
  /** One row over a page: the third page only exists once the 51st row arrives. */
  assert.equal(clampArchivePage(2, 51, ARCHIVE_PAGE_SIZE), 2);
  assert.equal(clampArchivePage(2, 100, ARCHIVE_PAGE_SIZE), 2);
  assert.equal(clampArchivePage(4, 130, ARCHIVE_PAGE_SIZE), 3);
  assert.equal(clampArchivePage(0, 130, ARCHIVE_PAGE_SIZE), 1);
});

test('filtering starts the new list at its first page, keeping the page size the reader chose', () => {
  assert.deepEqual(resetArchivePage({ page: 3, pageSize: 20 }), { page: 1, pageSize: 20 });
  assert.deepEqual(resetArchivePage({ page: 1, pageSize: 100 }), { page: 1, pageSize: 100 });
});

test('the pager keeps what it asked for, and a wider page takes it to the last page that still exists', () => {
  assert.deepEqual(applyArchivePage({ page: 1, pageSize: 50 }, 130, 3, 50), { page: 3, pageSize: 50 });
  /** 130 rows at 50 sit on page 3; at 100 there are two pages, so page 3 cannot be kept. */
  assert.deepEqual(applyArchivePage({ page: 3, pageSize: 50 }, 130, 3, 100), { page: 2, pageSize: 100 });
  assert.deepEqual(applyArchivePage({ page: 2, pageSize: 100 }, 130, 1, 20), { page: 1, pageSize: 20 });
});

test('only a new selection resets the page: live rows leaving the list just clamp it back', () => {
  const source = readFileSync(new URL('../../src/renderer/features/tasks/ArchiveDrawer.tsx', import.meta.url), 'utf8');
  assert.equal(source.match(/resetArchivePage/g)?.length, 2, 'imported once, and called once — from the filter handler');
  assert.match(source, /const choose = \(next: TaskSelection\) => \{ setSelection\(next\); setPager\(resetArchivePage\); \}/);
  /** Keeping the page while the rows change is the clamp, and nothing else touches the page. */
  assert.match(source, /const page = clampArchivePage\(pager\.page, rows\.length, pager\.pageSize\);/);
  assert.match(source, /setPager\(current => \(\{ \.\.\.current, page \}\)\)/);
  assert.match(source, /pagination=\{\{[^}]*current: page/);
  assert.match(source, /showTotal: archiveTotalLabel/);
});

test('the body yields to the pager the table mounts, whose height the drawer measures', () => {
  assert.equal(archiveScrollY(900, ARCHIVE_PAGINATION_BAR), 900 - 40 - ARCHIVE_PAGINATION_BAR);
  /** A narrow drawer wraps the pager onto a second line, and the body gives up exactly that much more. */
  assert.equal(archiveScrollY(900, ARCHIVE_PAGINATION_BAR + 28), archiveScrollY(900, ARCHIVE_PAGINATION_BAR) - 28);
  const source = readFileSync(new URL('../../src/renderer/features/tasks/ArchiveDrawer.tsx', import.meta.url), 'utf8');
  assert.match(source, /y: archiveScrollY\(room\.available, room\.pager\)/);
});

test('an archived crowd says how much there is and opens on its first page', () => {
  const html = markup(React.createElement(ArchiveList, { tasks: crowd(130), onSelect: () => {}, now }));
  assert.match(html, /共 130 条/);
  assert.ok(html.includes('ARCHIVE_0'), 'the first page is mounted');
  assert.doesNotMatch(html, /ARCHIVE_129\b/, 'the last page waits until the reader asks for it');
  assert.ok(html.includes('20') && html.includes('100'), 'the page sizes are offered');
});

test('a single archived task is still one page of it', () => {
  const html = markup(React.createElement(ArchiveList, { tasks: crowd(1), onSelect: () => {}, now }));
  assert.match(html, /共 1 条/);
  assert.ok(html.includes('ARCHIVE_0'));
});

test('a page size reads as so many rows per page, in Chinese', () => {
  assert.equal(archivePageSizeLabel(50), '50 条/页');
  assert.deepEqual(ARCHIVE_PAGE_SIZES.map(archivePageSizeLabel), ['20 条/页', '50 条/页', '100 条/页']);
});

test('the size changer relabels the options the pager hands it, keeping what each one selects', () => {
  /** Exactly the shape base-ui builds: its own English label over a stringified value. */
  const handed = [20, 50, 100].map(option => ({ label: `${option} / page`, value: String(option) }));
  assert.deepEqual(archivePageSizeOptions(handed), [
    { value: '20', label: '20 条/页' }, { value: '50', label: '50 条/页' }, { value: '100', label: '100 条/页' },
  ]);
  /** Nothing to hand, nothing to relabel: the picker still renders, empty. */
  assert.deepEqual(archivePageSizeOptions([]), []);
});

test('the size changer is the archive picker, named, in the table pagination', () => {
  const source = readFileSync(new URL('../../src/renderer/features/tasks/ArchiveDrawer.tsx', import.meta.url), 'utf8');
  assert.match(source, /components: \{ sizeChanger: ArchivePageSizeChanger \}/);
  assert.match(source, /aria-label=\{ARCHIVE_SIZE_CHANGER_LABEL\}/);
  assert.match(source, /options=\{archivePageSizeOptions\(options \?\? \[\]\)\}/);
  assert.equal(ARCHIVE_SIZE_CHANGER_LABEL, '每页条数');
});

test('the picker shows the archive wording and answers to its own name', () => {
  /** The props the pager passes to whatever replaces its Select: value, size, style, options, onChange. */
  const html = markup(React.createElement(ArchivePageSizeChanger, {
    disabled: false, size: 'small', style: { flex: 'none', marginInlineStart: 8, width: 'auto' },
    value: '50', options: archivePageSizeOptions([20, 50, 100].map(option => ({ label: `${option} / page`, value: String(option) }))),
    onChange: () => {},
  }));
  assert.match(html, /50 条\/页/);
  assert.doesNotMatch(html, /\/ page/, "the library's English label is gone");
  assert.match(html, /<label[^>]*>每页条数<\/label>/);
  const named = /for="([^"]+)"[^>]*>每页条数/.exec(html)?.[1];
  assert.ok(named, 'the name is a label for something');
  assert.ok(html.includes(`id="${named}" role="combobox"`), 'and that something is the picker itself');
});

test('the archive pager speaks Chinese end to end', () => {
  const html = markup(React.createElement(ArchiveList, { tasks: crowd(130), onSelect: () => {}, now }));
  assert.match(html, /共 130 条/);
  assert.match(html, /50 条\/页/);
  assert.doesNotMatch(html, /\/ page/);
  assert.ok(html.includes('每页条数'), 'and the picker says what it picks');
});
