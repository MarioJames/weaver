import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { toast } from '@lobehub/ui/base-ui';
import { motion } from 'motion/react';
import { defaultConfig } from '../src/main/policy/routing';
import type { Task } from '../src/shared/contracts/tasks';
import { TaskBoard } from '../src/renderer/features/tasks/TaskBoard';
import { TimeText } from '../src/renderer/ui/TimeText';
import { TimeZoneSelect, timeZoneOptions, FOLLOW_BROWSER } from '../src/renderer/features/settings/TimeZoneSelect';
import { Setting, SettingsPage } from '../src/renderer/features/settings/SettingsPage';
import { displayTimeZone, displayWithTimeZone, fieldErrorText, isFieldError } from '../src/renderer/policy/policy-edit';
import { cardFooter, cardFooterText } from '../src/renderer/features/tasks/task-footer';
import { applyTaskFilters, emptySelection, facetOptions, filterByTime, ownerChipLabel } from '../src/renderer/features/tasks/task-filters';
import { TimeZoneProvider, browserTimeZone, compactTime, fullTime, listTimeZones, offsetLabel, projectTimeZone, setProjectTimeZone, startOfZonedDay, zonedParts } from '../src/renderer/format/timezone';
import { dateText } from '../src/renderer/features/quota/quota-view';
import type { PolicyDraft } from '../src/renderer/policy/usePolicyDraft';

const SH = 'Asia/Shanghai';
const NY = 'America/New_York';
const at = (value: string) => Date.parse(value);
afterEach(() => setProjectTimeZone(undefined));

const markup = (node: React.ReactNode) => renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { enableCustomFonts: false, children: node }) }));

test('compact time: HH:mm on the zone\'s own today, MM-DD HH:mm on another day, across a year boundary and in two zones', () => {
  // 2027-01-01 03:00Z is New Year's Day in Shanghai (11:00) and still New Year's Eve in New York (22:00).
  const instant = '2027-01-01T03:00:00Z';
  const now = at('2027-01-01T06:00:00Z'); // Shanghai Jan 1 14:00, New York Jan 1 01:00
  assert.equal(compactTime(instant, now, SH), '11:00');
  assert.equal(compactTime(instant, now, NY), '12-31 22:00');
  assert.equal(compactTime(instant, now, 'UTC'), '03:00');
  // The same instant, seen from "tomorrow": every zone prints the date.
  const later = at('2027-01-03T06:00:00Z');
  assert.equal(compactTime(instant, later, SH), '01-01 11:00');
  assert.equal(compactTime(instant, later, NY), '12-31 22:00');
  // Within one calendar year the format never grows a year.
  assert.equal(compactTime('2026-03-05T23:30:00Z', at('2026-10-19T00:00:00Z'), SH), '03-06 07:30');
  assert.equal(compactTime(at('2027-01-01T03:00:00Z'), now, SH), '11:00');
  assert.equal(compactTime('nope', now, SH), '时间未知');
  assert.equal(compactTime(null, now, SH), '时间未知');
});

test('the hover text carries the full time and the zone: offset and IANA name', () => {
  assert.equal(fullTime('2027-01-01T03:00:00Z', SH), '2027-01-01 11:00:00 UTC+08:00 (Asia/Shanghai)');
  assert.equal(fullTime('2027-01-01T03:00:00Z', NY), '2026-12-31 22:00:00 UTC-05:00 (America/New_York)');
  assert.equal(fullTime('2026-07-01T12:00:00Z', NY), '2026-07-01 08:00:00 UTC-04:00 (America/New_York)');
  assert.equal(offsetLabel(at('2026-01-15T00:00:00Z'), 'Asia/Kolkata'), 'UTC+05:30');
  assert.equal(offsetLabel(at('2026-01-15T00:00:00Z'), 'UTC'), 'UTC+00:00');
  assert.deepEqual(zonedParts(at('2026-12-31T23:59:59Z'), SH), { year: 2027, month: 1, day: 1, hour: 7, minute: 59, second: 59 });
});

test('the start of the day is 00:00 of the zone, also on the days the clocks change', () => {
  const now = at('2026-10-20T03:40:00Z');
  assert.equal(new Date(startOfZonedDay(now, SH)).toISOString(), '2026-10-19T16:00:00.000Z');
  assert.equal(new Date(startOfZonedDay(now, NY)).toISOString(), '2026-10-19T04:00:00.000Z');
  assert.equal(new Date(startOfZonedDay(now, 'UTC')).toISOString(), '2026-10-20T00:00:00.000Z');
  // Spring forward (2026-03-08): midnight is still EST (UTC-5); fall back (2026-11-01): midnight is EDT (UTC-4).
  assert.equal(new Date(startOfZonedDay(at('2026-03-08T18:00:00Z'), NY)).toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(new Date(startOfZonedDay(at('2026-11-01T18:00:00Z'), NY)).toISOString(), '2026-11-01T04:00:00.000Z');
});

test('without a project zone the browser zone applies; an unknown name is ignored', () => {
  assert.equal(projectTimeZone(), browserTimeZone());
  setProjectTimeZone(SH);
  assert.equal(projectTimeZone(), SH);
  setProjectTimeZone('Mars/Olympus');
  assert.equal(projectTimeZone(), browserTimeZone());
  setProjectTimeZone(SH);
  setProjectTimeZone('');
  assert.equal(projectTimeZone(), browserTimeZone());
  const instant = '2026-10-19T16:30:00Z';
  const now = at('2026-10-20T03:40:00Z');
  assert.equal(compactTime(instant, now), compactTime(instant, now, browserTimeZone()));
  setProjectTimeZone(SH);
  assert.equal(compactTime(instant, now), '00:30');
  assert.equal(dateText(instant, now), '00:30');
  setProjectTimeZone(NY);
  assert.equal(dateText(instant, now), '12:30');
  // The provider applies the zone for what renders below it.
  setProjectTimeZone(undefined);
  const html = markup(React.createElement(TimeZoneProvider, { zone: SH }, React.createElement(TimeText, { value: instant, now })));
  assert.match(html, /<time dateTime="2026-10-19T16:30:00Z" title="2026-10-20 00:30:00 UTC\+08:00 \(Asia\/Shanghai\)">00:30<\/time>/);
});

const owner = { name: 'Claude · weaver · 21:30', transport: 'herdr-visible' as const, session: 's', pane: 'p' };
const make = (id: string, updatedAt: string, extra: Partial<Task> = {}): Task => ({
  id, ownerId: `instance-${id}`, title: `样本 ${id}`, instruction: '', owner, workspace: '/projects/weaver', status: 'running', progress: 0,
  createdAt: updatedAt, updatedAt, events: [], artifacts: [], run: { id: 'run', adapter: 'x', status: 'running', startedAt: updatedAt }, ...extra,
});
const NOW = at('2026-10-20T03:40:00Z'); // Shanghai Oct 20 11:40, New York Oct 19 23:40
const A = make('a', '2026-10-19T16:30:00Z'); // Shanghai 00:30 on the 20th, New York 12:30 on the 19th
const B = make('b', '2026-10-19T10:00:00Z'); // Shanghai 18:00 on the 19th, New York 06:00 on the 19th
const C = make('c', '2026-10-19T02:00:00Z'); // Shanghai 10:00 on the 19th, New York 22:00 on the 18th
const D = make('d', '2026-10-20T03:10:00Z');
const SAMPLES = [A, B, C, D];
const ids = (tasks: Task[]) => tasks.map(task => task.id).sort();

test('今天 starts at 00:00 of the project zone: the same tasks fall on different sides in two zones', () => {
  assert.deepEqual(ids(filterByTime(SAMPLES, 'today', NOW, SH)), ['a', 'd']);
  assert.deepEqual(ids(filterByTime(SAMPLES, 'today', NOW, NY)), ['a', 'b', 'd']);
  assert.deepEqual(ids(filterByTime(SAMPLES, 'today', NOW, 'UTC')), ['d']);
  // The boundary itself is in, one millisecond before is out.
  const start = at('2026-10-19T16:00:00Z');
  const edge = [make('in', new Date(start).toISOString()), make('out', new Date(start - 1).toISOString())];
  assert.deepEqual(ids(filterByTime(edge, 'today', NOW, SH)), ['in']);
  // It follows the configured zone when no zone is passed.
  setProjectTimeZone(SH);
  assert.deepEqual(ids(filterByTime(SAMPLES, 'today', NOW)), ['a', 'd']);
  setProjectTimeZone(NY);
  assert.deepEqual(ids(filterByTime(SAMPLES, 'today', NOW)), ['a', 'b', 'd']);
});

test('rolling windows do not depend on the zone', () => {
  for (const range of ['1h', '24h', '7d', '30d'] as const) {
    assert.deepEqual(ids(filterByTime(SAMPLES, range, NOW, SH)), ids(filterByTime(SAMPLES, range, NOW, NY)), range);
    assert.deepEqual(ids(filterByTime(SAMPLES, range, NOW, SH)), ids(filterByTime(SAMPLES, range, NOW, 'Pacific/Kiritimati')), range);
  }
  assert.deepEqual(ids(filterByTime(SAMPLES, '1h', NOW, SH)), ['d']);
  assert.deepEqual(ids(filterByTime(SAMPLES, '24h', NOW, SH)), ['a', 'b', 'd']);
  assert.equal(filterByTime(SAMPLES, 'all', NOW, SH).length, 4);
});

test('the board chips, counts and lanes agree on the zone', () => {
  const count = (html: string, label: string) => Number(html.match(new RegExp(`${label}</span><span[^>]*>(\\d+)</span>`))?.[1]);
  const render = (zone: string) => markup(React.createElement(TimeZoneProvider, { zone }, React.createElement(TaskBoard, { tasks: SAMPLES, filters: emptySelection(), now: NOW, loading: false, onSelect: () => {} })));
  const sh = render(SH);
  const ny = render(NY);
  assert.equal(count(sh, '今天'), 2);
  assert.equal(count(ny, '今天'), 3);
  for (const label of ['近 1 小时', '近 24 小时', '近 7 天', '全部']) assert.equal(count(sh, label), count(ny, label), label);
  // Lane content matches the chip: 执行中 holds exactly the tasks of 今天.
  const lane = (html: string) => (html.match(/data-status-column="running"[\s\S]*?(?=data-status-column="review")/)?.[0].match(/样本 [a-z]/g) ?? []).sort();
  assert.deepEqual(lane(sh), ['样本 a', '样本 d']);
  assert.deepEqual(lane(ny), ['样本 a', '样本 b', '样本 d']);
  // The same count the chip prints is what the filter returns for the zone.
  setProjectTimeZone(SH);
  assert.equal(applyTaskFilters(SAMPLES, emptySelection(), undefined, NOW, SAMPLES).length, 2);
  setProjectTimeZone(NY);
  assert.equal(applyTaskFilters(SAMPLES, emptySelection(), undefined, NOW, SAMPLES).length, 3);
});

test('card times follow the zone: footer text, time element and hover', () => {
  const task = make('x', '2026-10-19T16:30:00Z', { run: { id: 'r', adapter: 'x', status: 'running', startedAt: '2026-10-19T16:10:00Z' }, events: [{ id: 'e', at: '2026-10-19T16:30:00Z', kind: 'log', message: 'ok' }] });
  assert.equal(cardFooterText(cardFooter(task), NOW, SH), '由 Claude 于 00:10 派发 · 最新上报 00:30');
  assert.equal(cardFooterText(cardFooter(task), NOW, NY), '由 Claude 于 12:10 派发 · 最新上报 12:30');
  const html = markup(React.createElement(TimeZoneProvider, { zone: NY }, React.createElement(TaskBoard, { tasks: [task], filters: { ...emptySelection(), time: 'all' }, now: NOW, loading: false, onSelect: () => {} })));
  assert.match(html, /title="2026-10-19 12:10:00 UTC-04:00 \(America\/New_York\)">12:10<\/time>/);
  assert.match(html, /title="2026-10-19 12:30:00 UTC-04:00 \(America\/New_York\)">12:30<\/time>/);
  const shanghai = markup(React.createElement(TimeZoneProvider, { zone: SH }, React.createElement(TaskBoard, { tasks: [task], filters: { ...emptySelection(), time: 'all' }, now: NOW, loading: false, onSelect: () => {} })));
  assert.match(shanghai, /title="2026-10-20 00:10:00 UTC\+08:00 \(Asia\/Shanghai\)">00:10<\/time>/);
});

test('the policy carries the zone as display.timezone; clearing it drops the key', () => {
  const config = defaultConfig();
  assert.equal(displayTimeZone(config), undefined);
  assert.equal(displayTimeZone({ display: { timezone: ' Asia/Shanghai ' } }), SH);
  assert.equal(displayTimeZone({ display: { timezone: '' } }), undefined);
  assert.equal(displayTimeZone({ display: { timezone: 7 } }), undefined);
  assert.deepEqual(displayWithTimeZone(config, SH), { timezone: SH });
  assert.equal(displayWithTimeZone({ display: { timezone: SH } }, undefined), undefined);
  assert.deepEqual(displayWithTimeZone({ display: { timezone: SH, other: 1 } }, undefined), { other: 1 });
  assert.deepEqual(displayWithTimeZone({ display: { timezone: SH } }, NY), { timezone: NY });
});

test('a rejected field is said under the field, in the server\'s words', () => {
  const rejected = Object.assign(new Error('VALIDATION: $.display.timezone: unknown time zone Mars/Olympus'), { code: 'VALIDATION' });
  assert.equal(isFieldError(rejected), true);
  assert.equal(isFieldError(new Error('$.display.timezone: bad')), true);
  assert.equal(isFieldError(new Error('NETWORK: 断线')), false);
  assert.equal(isFieldError(new Error('CONFLICT: Settings changed')), false);
  assert.equal(fieldErrorText(rejected), '$.display.timezone: unknown time zone Mars/Olympus');
  assert.equal(fieldErrorText('Error: HTTP_500: boom'), 'boom');
  // The server's own timezone refusal is said in the page's words.
  const real = Object.assign(new Error('VALIDATION: $.display.timezone: timezone Mars/Base is not an IANA timezone name Intl supports'), { code: 'VALIDATION' });
  assert.equal(fieldErrorText(real), '「Mars/Base」不是有效的 IANA 时区名，例如 Asia/Shanghai。');
});

test('a setting shows its error inline under the control and raises no notice', t => {
  const calls: unknown[] = [];
  t.mock.method(toast, 'error', (options: unknown) => { calls.push(options); return { id: 'x', close() {}, update() {} }; });
  const html = markup(React.createElement(Setting, { label: '刷新间隔（分钟）', desc: '5 到 1440 分钟。', htmlFor: 'f', error: '请输入 5 到 1440 之间的整数。', children: React.createElement('input', { id: 'f' }) }));
  assert.match(html, /<p id="f-error" role="alert"[^>]*>请输入 5 到 1440 之间的整数。<\/p>/);
  assert.ok(html.indexOf('<input') < html.indexOf('role="alert"'), 'the message sits under the control');
  assert.equal(calls.length, 0);
  assert.doesNotMatch(markup(React.createElement(Setting, { label: 'x', desc: 'y', htmlFor: 'g', children: React.createElement('input', { id: 'g' }) })), /role="alert"/);
});

function settings(zone?: string) {
  const config = defaultConfig();
  if (zone) (config as unknown as { display: { timezone: string } }).display = { timezone: zone };
  const policy = { snapshot: { revision: 1, config, blocks: [] }, loadError: '', commit: async () => {} } as unknown as PolicyDraft;
  return markup(React.createElement(SettingsPage, { policy }));
}

test('settings offer 项目时区: browser first, then every zone with its offset', () => {
  const options = timeZoneOptions(undefined, at('2026-10-19T00:00:00Z'), 'Asia/Tokyo');
  assert.deepEqual(options[0], { value: FOLLOW_BROWSER, label: '跟随浏览器（当前：Asia/Tokyo）' });
  assert.ok(options.some(option => option.value === SH && option.label === 'Asia/Shanghai UTC+08:00'));
  assert.ok(options.some(option => option.value === NY && option.label === 'America/New_York UTC-04:00'));
  assert.ok(listTimeZones().includes(browserTimeZone()));
  assert.ok(timeZoneOptions('Zone/Unknown').every(option => option.value !== 'Zone/Unknown'), 'an unknown saved name is not offered');
  const follow = settings();
  assert.match(follow, /项目时区/);
  assert.match(follow, new RegExp(`跟随浏览器（当前：${browserTimeZone().replace('/', '\\/')}）`));
  assert.match(settings(SH), /Asia\/Shanghai UTC\+08:00/);
  assert.match(markup(React.createElement(TimeZoneSelect, { id: 'tz', onChange: () => {} })), /role="combobox"/);
});

test('parent Agent chips read "host · session time"; the workspace stays in the hover; same host and time stay distinguishable', () => {
  assert.equal(ownerChipLabel('Claude · weaver · 21:30'), 'Claude · 21:30');
  assert.equal(ownerChipLabel('Claude'), 'Claude');
  assert.equal(ownerChipLabel('Claude · 21:30'), 'Claude · 21:30');
  const one = make('o1', '2026-10-20T03:10:00Z', { owner: { ...owner, name: 'Claude · weaver · 21:30' } });
  const two = make('o2', '2026-10-20T03:11:00Z', { owner: { ...owner, name: 'Claude · weaver · 21:45' } });
  const three = make('o3', '2026-10-20T03:12:00Z', { owner: { ...owner, name: 'Claude · docs · 21:30' } });
  const alone = facetOptions([one, two], 'owner', emptySelection(), NOW);
  assert.deepEqual(alone.map(option => [option.label, option.title]).sort(), [['Claude · 21:30', 'Claude · weaver · 21:30'], ['Claude · 21:45', 'Claude · weaver · 21:45']]);
  const clash = facetOptions([one, three], 'owner', emptySelection(), NOW);
  assert.deepEqual(clash.map(option => option.label).sort(), ['Claude · docs · 21:30', 'Claude · weaver · 21:30']);
  const board = markup(React.createElement(TaskBoard, { tasks: [one, two], filters: emptySelection(), now: NOW, loading: false, onSelect: () => {} }));
  assert.match(board, /title="Claude · weaver · 21:30"[^>]*>(?:<[^>]*>)*<span[^>]*>Claude · 21:30<\/span>/);
  assert.doesNotMatch(board.slice(board.indexOf('aria-label="任务筛选"'), board.indexOf('任务状态列')).replace(/title="[^"]*"/g, ''), /weaver · 21/);
});

test('no renderer module formats a time on its own: everything goes through timezone.ts', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.(ts|tsx)$/.test(name)) files.push(path); } };
  walk(join(import.meta.dirname, '..', 'src', 'renderer'));
  const bypass = /toLocale(?:Date|Time)?String|Intl\.DateTimeFormat|\.get(?:Full)?(?:Year|Month|Date|Day|Hours|Minutes|Seconds)\(|\.set(?:Hours|Minutes|Date)\(|toDateString|toTimeString|toISOString\(\)\.slice/;
  const hits = files.filter(file => !file.endsWith('timezone.ts')).flatMap(file => readFileSync(file, 'utf8').split('\n').map((line, index) => ({ file, line: index + 1, text: line })).filter(entry => bypass.test(entry.text)));
  assert.deepEqual(hits.filter(hit => !/\.length\.toLocaleString\(\)/.test(hit.text)), []);
});
