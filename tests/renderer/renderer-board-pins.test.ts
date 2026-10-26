import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { TaskBoard } from '../../src/renderer/features/tasks/TaskBoard';
import { afterZone, boardRows, pinnedRows, workspaceGroups } from '../../src/renderer/features/tasks/task-columns';
import { emptySelection } from '../../src/renderer/features/tasks/task-filters';
import { taskStyles as styles } from '../../src/renderer/features/tasks/task-style';
import { styleClass } from './style-helpers';
import { ENDED_EXPANDED_KEY, TASK_PINS_KEY, readTaskPins, writeTaskPins } from '../../src/renderer/features/tasks/task-persistence';
import { NEW_TASK_WINDOW_MS, isNewTask, isPinned, nextNewExpiry, nextPinTime, pruneStalePins, splitPinned, togglePin } from '../../src/renderer/features/tasks/task-pins';
import type { TaskPins } from '../../src/renderer/features/tasks/task-pins';
import { TAG_COLORS, tagColor } from '../../src/renderer/format/tag-colors';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const base: Task = {
  id: 'one', title: 'T_ONE', workspace: '/projects/alpha', instruction: '',
  owner: { name: 'Parent', transport: 'herdr-visible', session: '', pane: '' },
  status: 'running', progress: 0, createdAt: ago(3_600_000), updatedAt: ago(3_600_000),
  events: [], artifacts: [],
};
/** Title is the id upper-cased, so ids without dashes keep every assertion readable. */
function make(id: string, overrides: Partial<Task> = {}): Task {
  return { ...base, id, title: `T_${id.toUpperCase()}`, ...overrides };
}

type StorageLike = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
function swapStorage<T>(handler: unknown, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: handler });
  try { return run(); } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}
function storage<T>(values: Record<string, string>, run: () => T): T {
  return swapStorage({ getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } }, run);
}
function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'dark', children: node }) }));
}
function board(tasks: Task[], pins: TaskPins | string = {}, at: number = NOW) {
  return storage({ [ENDED_EXPANDED_KEY]: 'true', [TASK_PINS_KEY]: typeof pins === 'string' ? pins : JSON.stringify(pins) },
    () => markup(React.createElement(TaskBoard, { tasks, filters: { ...emptySelection(), time: 'all' }, now: at, loading: false, onSelect: () => {} })));
}
function columnSlice(html: string, key: string): string {
  return html.slice(html.indexOf(`data-status-column="${key}"`) + 1).split(/data-status-column=/)[0];
}
function cardButton(html: string, title: string): string {
  const found = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(match => match[0].includes(title));
  assert.ok(found, `card ${title} should be mounted`);
  return found[0];
}
function pinButton(html: string, label: string): string {
  const found = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(match => match[0].includes(`aria-label="${label}"`));
  assert.ok(found, `a pin button labelled ${label} should be mounted`);
  return found[0];
}

test('新任务判定：恰好 2 分钟以内算新，超过、未来时间与无效时间都不算', () => {
  assert.equal(isNewTask({ ...base, createdAt: ago(NEW_TASK_WINDOW_MS) }, NOW), true, '刚好 2 分钟仍算新');
  assert.equal(isNewTask({ ...base, createdAt: ago(NEW_TASK_WINDOW_MS + 1) }, NOW), false, '超过 2 分钟不再算新');
  assert.equal(isNewTask({ ...base, createdAt: ago(0) }, NOW), true);
  assert.equal(isNewTask({ ...base, createdAt: ago(60_000) }, NOW), true);
  assert.equal(isNewTask({ ...base, createdAt: ago(-60_000) }, NOW), false, '时钟回拨（未来 createdAt）不算新');
  assert.equal(isNewTask({ ...base, createdAt: 'not-a-time' }, NOW), false, '无效 createdAt 不算新');
});

test('到期时间计算：取最近一个新任务的到期时刻，没有新任务时为空', () => {
  assert.equal(nextNewExpiry([], NOW), null);
  assert.equal(nextNewExpiry([base], NOW), null, '没有新任务就没有到期时刻');
  const freshA = { ...base, id: 'a', createdAt: ago(30_000) };
  const freshB = { ...base, id: 'b', createdAt: ago(60_000) };
  const stale = { ...base, id: 's', createdAt: ago(NEW_TASK_WINDOW_MS + 1) };
  const future = { ...base, id: 'f', createdAt: ago(-5_000) };
  assert.equal(nextNewExpiry([stale, future, freshA, freshB], NOW), Date.parse(freshB.createdAt) + NEW_TASK_WINDOW_MS);
  assert.equal(nextNewExpiry([freshA, stale], NOW), Date.parse(freshA.createdAt) + NEW_TASK_WINDOW_MS);
});

test('置顶区拆分与排序：手动置顶按置顶时间倒序在前，新任务按 createdAt 倒序在后，其余保持原序', () => {
  const plain = make('plain', { updatedAt: ago(500) });
  const manualEarly = make('m1', { updatedAt: ago(1000) });
  const manualLate = make('m2', { updatedAt: ago(2000) });
  const freshNew = make('f1', { createdAt: ago(10_000), updatedAt: ago(10_000) });
  const freshOlder = make('f2', { createdAt: ago(50_000), updatedAt: ago(50_000) });
  const items = [plain, manualEarly, manualLate, freshNew, freshOlder];
  const pins: TaskPins = { m1: NOW - 1000, m2: NOW - 5000 };
  const { pinned, rest } = splitPinned(items, pins, NOW);
  assert.deepEqual(pinned.map(item => item.id), ['m1', 'm2', 'f1', 'f2'], '手动置顶按置顶时间倒序在前，新任务按 createdAt 倒序在后');
  assert.deepEqual(rest.map(item => item.id), ['plain'], '其余任务保持列内原有顺序');
  assert.deepEqual([...pinned, ...rest].map(item => item.id).sort(), items.map(item => item.id).sort(), '拆分不重不漏');

  const both = make('both', { createdAt: ago(5_000), updatedAt: ago(5_000) });
  const overlap = splitPinned([both], { both: NOW - 100 }, NOW);
  assert.deepEqual(overlap.pinned.map(item => item.id), ['both'], '既手动置顶又新：只算手动置顶');
  assert.deepEqual(overlap.rest, []);
});

test('togglePin：首次置顶记下时刻，再次点击取消，其他置顶不受影响', () => {
  assert.deepEqual(togglePin({}, 'a', NOW), { a: NOW });
  const pins = togglePin({ a: 1 }, 'b', 99);
  assert.deepEqual(pins, { a: 1, b: 99 });
  assert.deepEqual(togglePin(pins, 'a', NOW), { b: 99 }, '再点取消置顶');
  assert.equal(isPinned(pins, 'b'), true);
});

test('置顶时刻：取点击时的墙钟而非过期的渲染时钟，且严格晚于已有置顶，连续点击也保持倒序', () => {
  assert.equal(nextPinTime({}, NOW, NOW + 15_000), NOW + 15_000, '渲染时钟过期时用墙钟');
  assert.equal(nextPinTime({}, NOW + 5, NOW), NOW + 5, '墙钟回拨时不早于渲染时钟');
  assert.equal(nextPinTime({ a: NOW + 20 }, NOW, NOW + 10), NOW + 21, '同一时刻内连续点击仍严格晚于上一次置顶');
  const first = togglePin({}, 'a', nextPinTime({}, NOW, NOW));
  const second = togglePin(first, 'b', nextPinTime(first, NOW, NOW));
  assert.ok(second.b > second.a, '后置顶的在前');
  assert.deepEqual(splitPinned([make('a'), make('b')], second, NOW).pinned.map(task => task.id), ['b', 'a']);
});

test('清理失效 id：不在任务列表中的置顶被丢弃，没有变化时原样返回', () => {
  const pins = { keep: 1, gone: 2 };
  assert.deepEqual(pruneStalePins(pins, ['keep', 'other']), { keep: 1 });
  const untouched = { keep: 1 };
  assert.equal(pruneStalePins(untouched, ['keep']), untouched, '无失效时返回原对象，不触发多余渲染');
  const empty: TaskPins = {};
  assert.equal(pruneStalePins(empty, ['a']), empty);
  assert.deepEqual(pruneStalePins({ keep: 1 }, ['keep']), { keep: 1 });
});

test('置顶存储：写入可读回，JSON 异常、数组与非数字条目都视为空或被丢弃', () => {
  storage({}, () => {
    writeTaskPins({ a: 1, b: 2 });
    assert.deepEqual(readTaskPins(), { a: 1, b: 2 });
  });
  assert.deepEqual(storage({ [TASK_PINS_KEY]: '{broken' }, readTaskPins), {}, 'JSON 异常视为空');
  assert.deepEqual(storage({ [TASK_PINS_KEY]: '[1,2]' }, readTaskPins), {}, '数组不是 pin 表');
  assert.deepEqual(storage({ [TASK_PINS_KEY]: 'null' }, readTaskPins), {});
  assert.deepEqual(storage({ [TASK_PINS_KEY]: '{"a":"x","b":5}' }, readTaskPins), { b: 5 }, '非数字条目被丢弃');
  swapStorage({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } }, () => {
    assert.deepEqual(readTaskPins(), {}, '读取失败视为空');
    assert.doesNotThrow(() => writeTaskPins({ a: 1 }), '写入失败静默');
  });
});

test('「新」标签走 tag-colors 的 fresh 语义色，与其他语义不撞色', () => {
  assert.equal(TAG_COLORS.fresh, 'magenta');
  assert.equal(tagColor('fresh'), 'magenta');
  const values = Object.values(TAG_COLORS);
  assert.equal(new Set(values).size, values.length);
});

test('2 分钟内的卡片在标题行最前显示「新」标签，并自动进入所在列的置顶区', () => {
  const fresh = make('fresh', { createdAt: ago(60_000), updatedAt: ago(60_000) });
  const html = board([fresh]);
  const card = cardButton(html, fresh.title);
  const title = card.slice(card.indexOf(`class="${styleClass(styles.cardTitle)}"`), card.indexOf(`class="${styleClass(styles.cardStatus)}"`));
  assert.match(title, />新</);
  assert.ok(title.indexOf('>新<') < title.indexOf('<strong'), '「新」标签在标题行最前');
  const running = columnSlice(html, 'running');
  assert.match(running, /置顶 · 1/);
  assert.match(running, /lucide-pin[\s\S]*?置顶 · 1/, '区头带 Pin 小图标');
  assert.ok(running.indexOf('置顶 · 1') < running.indexOf('title="/projects/alpha"'), '置顶区头在目录组头之前');
  assert.ok(running.indexOf('置顶 · 1') < running.indexOf(fresh.title));
});

test('没有新任务也没有手动置顶时，不渲染置顶区', () => {
  const html = board([base]);
  assert.doesNotMatch(html, /置顶 ·/);
  assert.match(html, /<h3[^>]*title="\/projects\/alpha"/, '普通目录分组仍在');
});

test('到期后「新」标签与自动置顶消失，卡片回到普通分组', () => {
  const fresh = make('fresh', { createdAt: ago(60_000), updatedAt: ago(60_000) });
  const before = board([fresh]);
  assert.match(columnSlice(before, 'running'), /置顶 · 1/);
  assert.match(cardButton(before, fresh.title), />新</);
  const after = board([fresh], {}, NOW + NEW_TASK_WINDOW_MS + 1);
  assert.doesNotMatch(after, /置顶 ·/);
  assert.doesNotMatch(cardButton(after, fresh.title), />新</);
  assert.match(columnSlice(after, 'running'), /<h3[^>]*title="\/projects\/alpha"/);
});

test('手动置顶：Pin 按钮是卡片按钮的兄弟（不嵌套其中），aria 状态正确且常显', () => {
  const html = board([base], { one: NOW - 1000 });
  const card = cardButton(html, base.title);
  assert.doesNotMatch(card, /aria-pressed|lucide-pin/, '卡片 button 内没有嵌套的置顶按钮');
  const pin = pinButton(html, '取消置顶');
  assert.match(pin, /aria-pressed="true"/);
  assert.match(pin, /data-pinned="true"/, '已置顶时按钮常显');
  assert.ok(html.indexOf(pin) > html.indexOf(card), 'Tab 顺序：先卡片后置顶按钮');
  assert.match(pin, /data-icon="pin"[^>]*>[\s\S]*?lucide-pin\b/, '已置顶常显的是 Pin 图钉，不是带斜杠的 PinOff');
  assert.ok(pin.indexOf('lucide-pin-off') > pin.indexOf('data-icon="unpin"') && pin.indexOf('data-icon="unpin"') > pin.indexOf('data-icon="pin"'), 'PinOff 只作为悬停/聚焦时替换的第二个图标存在');
  assert.doesNotMatch(card, />新</, '非新任务不显示「新」标签');

  const idle = board([base]);
  const pinIdle = pinButton(idle, '置顶');
  assert.match(pinIdle, /aria-pressed="false"/);
  assert.match(pinIdle, /data-pinned="false"/);
  assert.doesNotMatch(pinIdle, /lucide-pin-off|data-icon="unpin"/, '未置顶时只有 Pin，行为不变');
  assert.doesNotMatch(idle, /置顶 ·/, '无置顶无区头');
});

test('置顶区拆分计数：列头总数不变，置顶卡片不在普通分组重复出现，普通分组计数相应减少', () => {
  const a1 = make('a1', { workspace: '/projects/alpha', updatedAt: ago(1000) });
  const a2 = make('a2', { workspace: '/projects/alpha', updatedAt: ago(2000) });
  const html = board([a1, a2], { a1: NOW - 100 });
  const running = columnSlice(html, 'running');
  assert.match(running, /<strong>执行中<\/strong><span[^>]*>2<\/span>/, '列头总数不变');
  assert.equal((running.match(/<h3/g) ?? []).length, 2, '置顶区与普通区各有一个 alpha 组头');
  assert.equal((running.match(new RegExp(`>${a1.title}<`)) ?? []).length, 1, '置顶卡片只在置顶区出现一次');
  const [zoneHeading, plainHeading] = running.match(/<h3[^>]*>[\s\S]*?<\/h3>/g) ?? [];
  assert.match(zoneHeading!, />1</, '置顶区组头计数为组内卡片数');
  assert.match(plainHeading!, />1</, '普通分组计数相应减少');
});

test('置顶区与普通分组的行 key 不冲突，同一目录可以同时出现在两个区', () => {
  const pinnedTask = make('pinned', { workspace: '/projects/alpha', updatedAt: ago(1000) });
  const plainTask = make('plain', { workspace: '/projects/alpha', updatedAt: ago(2000) });
  const split = splitPinned([pinnedTask, plainTask], { pinned: NOW - 1 }, NOW);
  const rows = [...pinnedRows(split.pinned), ...boardRows(workspaceGroups(split.rest))];
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length, '每行的 key 都唯一');
  assert.ok(rows.some(row => row.key === 'group:/projects/alpha'), '普通分组沿用 group: 前缀');
  assert.ok(rows.some(row => row.key === 'pinned:group:/projects/alpha'), '置顶区组头带 pinned: 前缀');
  const zone = pinnedRows(split.pinned);
  assert.equal(new Set(zone.map(row => row.key)).size, zone.length);
});

test('置顶区与普通分组之间有分隔线，两侧缺一则没有，分隔标记不改变行 key', () => {
  const pinnedTask = make('pinned', { workspace: '/projects/alpha', updatedAt: ago(1000) });
  const plainTask = make('plain', { workspace: '/projects/alpha', updatedAt: ago(2000) });
  const split = splitPinned([pinnedTask, plainTask], { pinned: NOW - 1 }, NOW);
  const zone = pinnedRows(split.pinned);
  const plain = boardRows(workspaceGroups(split.rest));
  const marked = afterZone(zone, plain);
  assert.equal(marked.length, plain.length, '只做标记，不增减行');
  assert.equal(marked[0].kind === 'heading' && marked[0].afterZone, true, '置顶区之后的第一个组头带分隔标记');
  assert.ok(marked.slice(1).every(row => !('afterZone' in row)), '其余行不带标记');
  assert.deepEqual(afterZone([], plain), plain, '没有置顶区时不标记');
  assert.deepEqual(afterZone(zone, []), [], '置顶区之后没有普通分组时没有可标记的行');

  const html = board([pinnedTask, plainTask], { pinned: NOW - 1 });
  const running = columnSlice(html, 'running');
  assert.match(running, /role="separator"/, '同一目录出现在两个区时，之间有分隔线');
  assert.ok(running.indexOf('置顶 ·') < running.indexOf('role="separator"') && running.indexOf('role="separator"') < running.lastIndexOf('<h3'), '分隔线在置顶区之后、普通分组之前');
  assert.doesNotMatch(columnSlice(board([pinnedTask], { pinned: NOW - 1 }), 'running'), /role="separator"/, '只有置顶区时没有分隔线');
});

test('置顶跟随任务换列：任务换列后仍在新列置顶，原列不再出现', () => {
  const moved = make('moved', { status: 'completed', updatedAt: ago(60_000) });
  const html = board([moved], { moved: NOW - 100 });
  const review = columnSlice(html, 'review');
  assert.match(review, /置顶 · 1/);
  assert.match(review, new RegExp(moved.title));
  assert.doesNotMatch(columnSlice(html, 'running'), new RegExp(moved.title));
});

test('已结束列折叠不因置顶或新任务而展开，展开后置顶区完整显示', () => {
  const failed = make('gone', { status: 'failed', updatedAt: ago(3_600_000) });
  const closedFolded = storage({}, () => markup(React.createElement(TaskBoard, { tasks: [failed], filters: { ...emptySelection(), time: 'all' }, now: NOW, loading: false, onSelect: () => {} })));
  assert.match(closedFolded, /data-status-column="closed"[^>]*data-collapsed="true"/);
  assert.doesNotMatch(closedFolded, /置顶 ·|T_GONE/, '折叠时整列内容不显示');

  const failedFresh = make('ff', { status: 'failed', createdAt: ago(60_000), updatedAt: ago(60_000) });
  const foldedFresh = storage({}, () => markup(React.createElement(TaskBoard, { tasks: [failedFresh], filters: { ...emptySelection(), time: 'all' }, now: NOW, loading: false, onSelect: () => {} })));
  assert.match(foldedFresh, /data-status-column="closed"[^>]*data-collapsed="true"/, '新任务也不展开已结束列');

  const opened = board([failed], { gone: NOW - 100 });
  const closed = columnSlice(opened, 'closed');
  assert.match(closed, /置顶 · 1/);
  assert.match(closed, new RegExp(failed.title));
});

test('「展开更多」截断只作用于普通分组，置顶区始终完整', () => {
  const pinned = Array.from({ length: 3 }, (_, n) => make(`pinned${n}`, { workspace: '/projects/pinned', updatedAt: ago(1000 * (n + 1)) }));
  const rest = Array.from({ length: 23 }, (_, n) => make(`rest${n}`, { workspace: '/projects/alpha', updatedAt: ago(10_000 * (n + 1)) }));
  const pins: TaskPins = Object.fromEntries(pinned.map((item, n) => [item.id, NOW - n - 1]));
  const html = board([...pinned, ...rest], pins);
  const running = columnSlice(html, 'running');
  for (const item of pinned) assert.match(running, new RegExp(item.title), '置顶区三张卡都在');
  const mounted = running.match(/<strong[^>]*>T_[A-Z0-9]+<\/strong>/g) ?? [];
  assert.equal(mounted.length, 23, '置顶区 3 张 + 普通分组截断到 20 张');
  assert.doesNotMatch(running, /T_REST20|T_REST21|T_REST22/, '普通分组的第 21 张起不挂载');
  assert.match(running, /查看全部 23/);
});

test('看板级的损坏 pin 数据同样视为空：损坏存储下看板不渲染置顶区', () => {
  const html = board([base], '{broken');
  assert.doesNotMatch(html, /置顶 ·/);
  assert.match(pinButton(html, '置顶'), /aria-pressed="false"/);
});
