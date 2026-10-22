import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { taskStyles as styles } from '../../src/renderer/features/tasks/task-style';
import { TaskBoard } from '../../src/renderer/features/tasks/TaskBoard';
import { emptySelection } from '../../src/renderer/features/tasks/task-filters';
import { ENDED_EXPANDED_KEY } from '../../src/renderer/features/tasks/task-persistence';

const now = new Date(2026, 9, 19, 23, 0).getTime();
const at = (hour: number, minute: number) => new Date(2026, 9, 19, hour, minute).toISOString();
const LONG_OWNER = '接入本机 DeepSeek Harness（dsh）引擎';
const LONG_WORKER = 'opencode_muse_worker_with_a_very_long_instance_name';
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const long: Task = {
  id: 'long', ownerId: 'instance-long', title: 'LONG_TITLE', instruction: '',
  owner: { name: LONG_OWNER, transport: 'herdr-visible', session: 's', pane: 'p' },
  workspace: '/projects/alpha', status: 'running', progress: 0,
  createdAt: at(21, 0), updatedAt: at(22, 50),
  events: [{ id: 'event', at: at(22, 41), kind: 'log', message: 'ok' }],
  artifacts: [],
  run: { id: 'run', adapter: 'x', status: 'running', startedAt: at(21, 5) },
  dispatch: { owner: 'parent-profile', worker: LONG_WORKER, engine: 'opencode', model: 'm', effort: 'high', execution: 'real', maxParallel: 1 },
};

function storage<T>(run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => key === ENDED_EXPANDED_KEY ? 'true' : null, setItem: () => {} } });
  try { return run(); } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

function card(task: Task) {
  const html = storage(() => renderToStaticMarkup(React.createElement(ConfigProvider, {
    motion,
    children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: React.createElement(TaskBoard, { tasks: [task], filters: { ...emptySelection(), time: 'all' }, now, loading: false, onSelect: () => {} }) }),
  })));
  const result = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(match => match[0].includes(task.title));
  assert.ok(result);
  return result[0];
}

/** Only the named rule's generated CSS: the same source the browser receives. */
async function cssOf(className: string) {
  const { extractStaticStyle } = await import('antd-style');
  return extractStaticStyle(`<div class="${className}"></div>`, { includeAntd: false }).map(item => item.css).join('\n');
}

test('the footer names the parent once and keeps the full instance name on hover', () => {
  const html = card(long);
  const meta = html.slice(html.indexOf(`class="${styles.cardMeta}"`));
  assert.match(meta, new RegExp(`<span class="${styles.cardWho}">由 <span class="${styles.cardParent}" aria-label="父 Agent：${escape(LONG_OWNER)}" title="${escape(LONG_OWNER)}"`));
  assert.ok(meta.indexOf(styles.cardParent) < meta.indexOf('于 '));
  assert.ok(meta.indexOf('于 ') < meta.indexOf('最新上报'));
  assert.match(meta, new RegExp(`<span class="${styles.cardTail}">于 <time class="${styles.cardTime}"[^>]*>21:05</time> 派发`));
  assert.match(meta, new RegExp(`<span class="${styles.cardTail}">最新上报 <time class="${styles.cardTime}"[^>]*>22:41</time>`));
});

test('the parent name is the only footer part that shrinks, and it ellipsizes in one line', async () => {
  const parent = await cssOf(styles.cardParent);
  assert.match(parent, /min-inline-size:0/);
  assert.match(parent, /overflow:hidden/);
  assert.match(parent, /text-overflow:ellipsis/);
  assert.match(parent, /white-space:nowrap/);
  assert.match(parent, /flex:1 1 auto/);
  assert.match(parent, /max-inline-size:100%/);

  const who = await cssOf(styles.cardWho);
  const whoBase = who.slice(0, who.indexOf('@container'));
  const query = who.slice(who.indexOf('@container'));
  assert.match(whoBase, /min-inline-size:0/);
  assert.match(query, /@container \(min-width: 300px\)/);
  assert.match(query, /display:flex/);
  assert.match(query, /-webkit-flex-wrap:nowrap|flex-wrap:nowrap/);

  for (const part of [styles.cardTail, styles.cardTime]) assert.match(await cssOf(part), /flex:none/, part);
});

test('the narrow footer keeps 由 beside the parent name instead of orphaning the prefix on its own line', async () => {
  const meta = await cssOf(styles.cardMeta);
  const base = meta.slice(0, meta.indexOf('@container'));
  // Narrow cards stay running text so a time fragment wraps as a whole instead of being split.
  assert.match(base, /display:block/);
  assert.match(await cssOf(styles.cardTail), /white-space:nowrap/);
  const who = await cssOf(styles.cardWho);
  const whoBase = who.slice(0, who.indexOf('@container'));
  assert.doesNotMatch(whoBase, /display:flex|white-space:nowrap/);
  // The name is capped short of the card's full width: the 由 prefix plus its space always fits
  // before the inline-block, so a long name ellipsizes on that same line and the time fragments
  // are the only part that may move to the next line.
  const parent = await cssOf(styles.cardParent);
  const parentBase = parent.slice(0, parent.indexOf('@container'));
  assert.match(parentBase, /max-inline-size:calc\(100% - 2em\)/);
  assert.match(parentBase, /overflow:hidden/);
  assert.match(parentBase, /text-overflow:ellipsis/);
  assert.match(parentBase, /white-space:nowrap/);
  // From 300px up the flex row gives the name the whole row again and lets flexbox decide its width.
  const parentWide = parent.slice(parent.indexOf('@container'));
  assert.match(parentWide, /max-inline-size:100%/);
});

test('a long sub agent tag ellipsizes inside the capped title row and keeps its full name on hover', async () => {
  const html = card(long);
  assert.match(html, new RegExp(`<span class="[^"]+"[^>]*title="${escape(LONG_WORKER)}">[\\s\\S]*?<span class="${styles.cardTagText}">${escape(LONG_WORKER)}</span>`));
  const tag = await cssOf(styles.cardTag);
  assert.match(tag, /overflow:hidden/);
  assert.match(tag, /text-overflow:ellipsis/);
  assert.match(tag, /white-space:nowrap/);
  assert.match(tag, /max-inline-size:60%/);
  assert.match(tag, />\s*svg\{[^}]*flex:none/);
  const tagText = await cssOf(styles.cardTagText);
  assert.match(tagText, /min-inline-size:0/);
  assert.match(tagText, /overflow:hidden/);
  assert.match(tagText, /text-overflow:ellipsis/);
  assert.match(tagText, /white-space:nowrap/);
  const title = await cssOf(styles.cardTitle);
  assert.match(title, /-webkit-line-clamp:2/);
  assert.match(title, /line-clamp:2/);
});
