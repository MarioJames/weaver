import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Route } from '../../src/renderer/app/router';
import { parseRoute, routeHref } from '../../src/renderer/app/router';
import { blockedProfileCount, navigationGroups } from '../../src/renderer/app/navigation';

const routes: Route[] = [
  { page: 'tasks', view: 'sessions' },
  { page: 'tasks', view: 'sessions', sessionKey: 'o-abc' },
  { page: 'tasks', view: 'sessions', sessionKey: 'unowned' },
  { page: 'tasks', view: 'sessions', sessionKey: 'o-a/b 中', taskId: 'task/一' },
  { page: 'tasks', view: 'sessions', taskId: 'only-task' },
  { page: 'tasks', view: 'all' },
  { page: 'tasks', view: 'all', taskId: 'task-1' },
  { page: 'schedules' },
  { page: 'schedules', id: 'sched/1' },
  { page: 'owners' },
  { page: 'owners', id: 'owner profile' },
  { page: 'workers' },
  { page: 'workers', id: 'w' },
  { page: 'channels' },
  { page: 'channels', id: 'channel/中' },
  { page: 'bots' },
  { page: 'settings' },
];

test('every route round-trips through routeHref and parseRoute, ids included', () => {
  for (const route of routes) {
    const href = routeHref(route);
    assert.match(href, /^#\//);
    assert.deepEqual(parseRoute(href), route, href);
  }
});

test('ids are encoded inside a segment and decoded back to the same opaque string', () => {
  const href = routeHref({ page: 'tasks', view: 'sessions', sessionKey: 'o-a/b 中', taskId: 'task/一' });
  assert.equal(href, '#/tasks/s/o-a%2Fb%20%E4%B8%AD/t/task%2F%E4%B8%80');
  assert.deepEqual(parseRoute(href), { page: 'tasks', view: 'sessions', sessionKey: 'o-a/b 中', taskId: 'task/一' });
  assert.equal(routeHref({ page: 'channels', id: 'a/b' }), '#/channels/a%2Fb');
  assert.deepEqual(parseRoute('#/channels/a%2Fb'), { page: 'channels', id: 'a/b' });
});

test('older pathname links resolve without a hash', () => {
  assert.deepEqual(parseRoute('', '/channels'), { page: 'channels' });
  assert.deepEqual(parseRoute('', '/owners/o%2Fx'), { page: 'owners', id: 'o/x' });
  assert.deepEqual(parseRoute('', '/'), { page: 'tasks', view: 'sessions' });
  assert.deepEqual(parseRoute('', '/unknown'), { page: 'tasks', view: 'sessions' });
});

test('unknown pages and malformed task segments fall back to the session view', () => {
  for (const hash of ['#/nope', '#/tasks/nope', '#/tasks/s', '']) {
    assert.deepEqual(parseRoute(hash), { page: 'tasks', view: 'sessions' }, hash);
  }
  assert.deepEqual(parseRoute('#/tasks/s/key/nope'), { page: 'tasks', view: 'sessions', sessionKey: 'key' });
  assert.deepEqual(parseRoute('#/schedules/gone'), { page: 'schedules', id: 'gone' });
  assert.deepEqual(parseRoute('#/tasks/all/t/'), { page: 'tasks', view: 'all' });
});

test('navigation is grouped 工作 / 编排 / 接入 / 系统 with the agreed labels and route hrefs', () => {
  const groups = navigationGroups({ attention: 3, blockedOwners: 1, blockedWorkers: 2 });
  assert.deepEqual(groups.map(group => [group.key, group.label]), [
    ['work', '工作'], ['orchestration', '编排'], ['access', '接入'], ['system', '系统'],
  ]);
  assert.deepEqual(groups.map(group => group.items?.map(item => item.label)), [
    ['工作台', '定时任务'], ['父 Agent', '子 Agent', '账号与渠道'], ['Bot'], ['设置'],
  ]);
  assert.deepEqual(groups.map(group => group.items?.map(item => item.href)), [
    ['#/tasks', '#/schedules'], ['#/owners', '#/workers', '#/channels'], ['#/bots'], ['#/settings'],
  ]);
  const flat = groups.flatMap(group => group.items ?? []);
  assert.deepEqual(flat.map(item => item.badge), [3, undefined, 1, 2, undefined, undefined, undefined]);
});

test('only saved blocked profiles are counted for the parent and sub Agent badges', () => {
  assert.equal(blockedProfileCount(undefined), 0);
  assert.equal(blockedProfileCount({ a: { status: 'available' }, b: { status: 'disabled' }, c: { status: 'blocked' }, d: { status: 'blocked' } }), 2);
});

test('zero counts hide the badge instead of rendering a zero', () => {
  const flat = navigationGroups({ attention: 0, blockedOwners: 0, blockedWorkers: 0 }).flatMap(group => group.items ?? []);
  assert.ok(flat.every(item => item.badge === undefined));
});

test('schedule history links use the same route generator, and no requestedTaskId channel remains', () => {
  const history = readFileSync(new URL('../../src/renderer/features/schedules/ScheduleHistoryList.tsx', import.meta.url), 'utf8');
  assert.match(history, /route=\{\{ page: 'tasks', view: 'all', taskId: run\.taskId \}\}/);
  assert.doesNotMatch(history, /onViewTask/);
  const app = readFileSync(new URL('../../src/renderer/app/App.tsx', import.meta.url), 'utf8');
  const tasks = readFileSync(new URL('../../src/renderer/features/tasks/TasksPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /requestedTaskId/);
  assert.doesNotMatch(tasks, /requestedTaskId/);
});
