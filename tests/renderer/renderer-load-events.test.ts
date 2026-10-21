import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskEvent } from '../../src/shared/contracts/tasks';
import { EVENT_PAGE_LIMIT, loadAllEvents, progressiveFor } from '../../src/renderer/features/tasks/load-events';

function event(id: string): TaskEvent {
  return { id, at: '2026-10-18T00:00:00Z', kind: 'log', message: `event ${id}` };
}
function page(ids: string[], nextCursor: string | null, hasMore: boolean) {
  return { events: ids.map(event), nextCursor, hasMore };
}
/** A paged server: pages is a list of per-cursor responses (index 0 answers the first request). */
function server(pages: Array<{ events: string[]; nextCursor: string | null; hasMore: boolean }>, failAt?: number) {
  const cursors: Array<string | undefined> = [];
  const delivered: TaskEvent[][] = [];
  let calls = 0;
  const fetchPage = async (after?: string) => {
    cursors.push(after);
    const index = calls;
    calls += 1;
    if (failAt === index) throw new Error(`page ${index} failed`);
    return page(pages[index].events, pages[index].nextCursor, pages[index].hasMore);
  };
  return {
    fetchPage,
    onProgress: (events: TaskEvent[]) => { delivered.push(events); },
    cursors,
    delivered,
    get calls() { return calls; },
  };
}

test('progressiveFor only echoes pages back on the first load of a task', () => {
  // First load ever (nothing loaded, no task tracked yet).
  assert.equal(progressiveFor(null, 't1', 0), true);
  // First load after a task switch, even with the previous task's events gone.
  assert.equal(progressiveFor('t1', 't2', 0), true);
  // Retry triggered with nothing loaded yet still echoes progressively.
  assert.equal(progressiveFor('t1', 't1', 0), true);
});

test('progressiveFor keeps same-task refreshes silent until the full result arrives', () => {
  // Same task with events already on screen: a refresh (events.length changed) must not echo pages.
  assert.equal(progressiveFor('t1', 't1', 100), false);
  assert.equal(progressiveFor('t1', 't1', 1), false);
  // Task switch away from a task with loaded events is still a first load for the new task.
  assert.equal(progressiveFor('t1', 't2', 42), true);
});

// The refresh pattern built on progressiveFor: silent during the load, one replacement at the end.
test('a same-task refresh surfaces no partial progress and resolves with the full page set', async () => {
  const fake = server([
    { events: ['a', 'b'], nextCursor: 'c1', hasMore: true },
    { events: ['c', 'd'], nextCursor: null, hasMore: false },
  ]);
  const progressive = progressiveFor('t1', 't1', 2);
  assert.equal(progressive, false);
  // In refresh mode the panel ignores progress callbacks (keeps the current view); model that here.
  const echoes: TaskEvent[][] = [];
  const all = await loadAllEvents(fake.fetchPage, () => true, events => { if (progressive) echoes.push(events); });
  assert.deepEqual(all.map(item => item.id), ['a', 'b', 'c', 'd']);
  assert.equal(echoes.length, 0);
  assert.equal(fake.delivered.length, 0);
});

// The progressive pattern: every page is echoed back and the resolved value matches the last echo.
test('a first load echoes every page back and ends with the full page set', async () => {
  const fake = server([
    { events: ['a'], nextCursor: 'c1', hasMore: true },
    { events: ['b'], nextCursor: null, hasMore: false },
  ]);
  assert.equal(progressiveFor(null, 't1', 0), true);
  const all = await loadAllEvents(fake.fetchPage, () => true, fake.onProgress);
  assert.equal(fake.delivered.length, 2);
  assert.deepEqual(fake.delivered[0].map(item => item.id), ['a']);
  assert.deepEqual(all.map(item => item.id), ['a', 'b']);
  assert.deepEqual(fake.delivered[1], all);
});

test('loadAllEvents concatenates pages in server order and delivers progress after each page', async () => {
  const fake = server([
    { events: ['a', 'b'], nextCursor: 'c1', hasMore: true },
    { events: ['c'], nextCursor: 'c2', hasMore: true },
    { events: ['d', 'e'], nextCursor: null, hasMore: false },
  ]);
  const all = await loadAllEvents(fake.fetchPage, () => true, fake.onProgress);
  assert.deepEqual(all.map(item => item.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(fake.cursors, [undefined, 'c1', 'c2']);
  assert.equal(fake.calls, 3);
  assert.equal(fake.delivered.length, 3);
  assert.deepEqual(fake.delivered[0].map(item => item.id), ['a', 'b']);
  assert.deepEqual(fake.delivered[1].map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(fake.delivered[2].map(item => item.id), ['a', 'b', 'c', 'd', 'e']);
});

test('loadAllEvents stops when hasMore is false even if a cursor remains', async () => {
  const fake = server([
    { events: ['a'], nextCursor: 'c1', hasMore: false },
  ]);
  const all = await loadAllEvents(fake.fetchPage, () => true, fake.onProgress);
  assert.deepEqual(all.map(item => item.id), ['a']);
  assert.equal(fake.calls, 1);
});

test('loadAllEvents stops when the cursor is empty even if hasMore is true', async () => {
  const fake = server([
    { events: ['a'], nextCursor: null, hasMore: true },
    { events: ['never'], nextCursor: 'c', hasMore: true },
  ]);
  const all = await loadAllEvents(fake.fetchPage, () => true, fake.onProgress);
  assert.deepEqual(all.map(item => item.id), ['a']);
  assert.equal(fake.calls, 1);
});

test('loadAllEvents stops and never calls back once isCurrent turns false', async () => {
  const fake = server([
    { events: ['a', 'b'], nextCursor: 'c1', hasMore: true },
    { events: ['c'], nextCursor: 'c2', hasMore: true },
    { events: ['never'], nextCursor: null, hasMore: false },
  ]);
  const all = await loadAllEvents(fake.fetchPage, () => fake.calls < 2, fake.onProgress);
  assert.deepEqual(all.map(item => item.id), ['a', 'b']);
  assert.equal(fake.calls, 2);
  assert.equal(fake.delivered.length, 1);
  assert.deepEqual(fake.delivered[0].map(item => item.id), ['a', 'b']);
});

test('loadAllEvents makes no request at all when the task is already stale', async () => {
  const fake = server([{ events: ['a'], nextCursor: null, hasMore: false }]);
  const all = await loadAllEvents(fake.fetchPage, () => false, fake.onProgress);
  assert.deepEqual(all, []);
  assert.equal(fake.calls, 0);
  assert.equal(fake.delivered.length, 0);
});

test('loadAllEvents stops at the page cap so a broken cursor cannot loop forever', async () => {
  let calls = 0;
  const delivered: TaskEvent[][] = [];
  const endless = async (after?: string) => { calls += 1; return page([`p${calls}`], `cursor-${calls}`, true); };
  const all = await loadAllEvents(endless, () => true, events => { delivered.push(events); });
  assert.equal(calls, EVENT_PAGE_LIMIT);
  assert.equal(EVENT_PAGE_LIMIT, 200);
  assert.deepEqual(all, delivered.at(-1) ?? []);
});

test('loadAllEvents throws when a page fails and keeps the pages already delivered', async () => {
  const fake = server([
    { events: ['a'], nextCursor: 'c1', hasMore: true },
    { events: ['b'], nextCursor: null, hasMore: false },
  ], 1);
  await assert.rejects(loadAllEvents(fake.fetchPage, () => true, fake.onProgress), /page 1 failed/);
  assert.equal(fake.delivered.length, 1);
  assert.deepEqual(fake.delivered[0].map(item => item.id), ['a']);
});
