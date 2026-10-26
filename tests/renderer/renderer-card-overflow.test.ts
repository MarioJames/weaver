import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { taskStyles as styles } from '../../src/renderer/features/tasks/task-style';
import { TaskBoard } from '../../src/renderer/features/tasks/TaskBoard';
import { emptySelection } from '../../src/renderer/features/tasks/task-filters';
import { ENDED_EXPANDED_KEY } from '../../src/renderer/features/tasks/task-persistence';
import { styleClass, styleCss } from './style-helpers';

const taskStyleUrl = new URL('../../src/renderer/features/tasks/task-style.ts', import.meta.url);

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
    enableCustomFonts: false,
    children: React.createElement(ThemeScope, { appearance: 'dark', children: React.createElement(TaskBoard, { tasks: [task], filters: { ...emptySelection(), time: 'all' }, now, loading: false, onSelect: () => {} }) }),
  })));
  const result = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(match => match[0].includes(task.title));
  assert.ok(result);
  return result[0];
}

/** CSS emitted by the official StyleX compiler for one compiled style. */
function cssOf(style: Parameters<typeof styleClass>[0]) {
  return styleCss(taskStyleUrl, style);
}

function splitContainer(css: string) {
  const lines = css.split('\n');
  return {
    base: lines.filter(line => !line.startsWith('@container')).join('\n'),
    query: lines.filter(line => line.startsWith('@container')).join('\n'),
  };
}

test('the footer names the parent once and keeps the full instance name on hover', () => {
  const html = card(long);
  const meta = html.slice(html.indexOf(`class="${styleClass(styles.cardMeta)}"`));
  assert.match(meta, new RegExp(`<span class="${styleClass(styles.cardWho)}">由 <span class="${styleClass(styles.cardParent)}" aria-label="父 Agent：${escape(LONG_OWNER)}" title="${escape(LONG_OWNER)}"`));
  assert.ok(meta.indexOf(styleClass(styles.cardParent)) < meta.indexOf('于 '));
  assert.ok(meta.indexOf('于 ') < meta.indexOf('最新上报'));
  assert.match(meta, new RegExp(`<span class="${styleClass(styles.cardTail)}">于 <time class="${styleClass(styles.cardTime)}"[^>]*>21:05</time> 派发`));
  assert.match(meta, new RegExp(`<span class="${styleClass(styles.cardTail)}">最新上报 <time class="${styleClass(styles.cardTime)}"[^>]*>22:41</time>`));
});

test('the parent name is the only footer part that shrinks, and it ellipsizes in one line', async () => {
  const parent = cssOf(styles.cardParent);
  assert.match(parent, /min-width:0/);
  assert.match(parent, /overflow:hidden/);
  assert.match(parent, /text-overflow:ellipsis/);
  assert.match(parent, /white-space:nowrap/);
  assert.match(parent, /flex:1 1 auto/);
  assert.match(parent, /max-width:100%/);

  const who = cssOf(styles.cardWho);
  const { base: whoBase, query } = splitContainer(who);
  assert.match(whoBase, /min-width:0/);
  assert.match(query, /@container \(min-width: 300px\)/);
  assert.match(query, /display:flex/);
  assert.match(query, /-webkit-flex-wrap:nowrap|flex-wrap:nowrap/);

  for (const part of [styles.cardTail, styles.cardTime]) assert.match(cssOf(part), /flex:none/, styleClass(part));
});

test('the narrow footer keeps 由 beside the parent name instead of orphaning the prefix on its own line', async () => {
  const { base } = splitContainer(cssOf(styles.cardMeta));
  // Narrow cards stay running text so a time fragment wraps as a whole instead of being split.
  assert.match(base, /display:block/);
  assert.match(cssOf(styles.cardTail), /white-space:nowrap/);
  const who = cssOf(styles.cardWho);
  const { base: whoBase } = splitContainer(who);
  assert.doesNotMatch(whoBase, /display:flex|white-space:nowrap/);
  // The name is capped short of the card's full width: the 由 prefix plus its space always fits
  // before the inline-block, so a long name ellipsizes on that same line and the time fragments
  // are the only part that may move to the next line.
  const parent = cssOf(styles.cardParent);
  const { base: parentBase, query: parentWide } = splitContainer(parent);
  assert.match(parentBase, /max-width:calc\(100% - 2em\)/);
  assert.match(parentBase, /overflow:hidden/);
  assert.match(parentBase, /text-overflow:ellipsis/);
  assert.match(parentBase, /white-space:nowrap/);
  // From 300px up the flex row gives the name the whole row again and lets flexbox decide its width.
  assert.match(parentWide, /max-width:100%/);
});

test('a long sub agent tag ellipsizes inside the capped title row and keeps its full name on hover', async () => {
  const html = card(long);
  assert.match(html, new RegExp(`<span class="[^"]+"[^>]*title="${escape(LONG_WORKER)}">[\\s\\S]*?<span class="${styleClass(styles.cardTagText)}">${escape(LONG_WORKER)}</span>`));
  const tag = cssOf(styles.cardTag);
  assert.match(tag, /overflow:hidden/);
  assert.match(tag, /text-overflow:ellipsis/);
  assert.match(tag, /white-space:nowrap/);
  assert.match(tag, /max-width:60%/);
  const tagText = cssOf(styles.cardTagText);
  assert.match(tagText, /min-width:0/);
  assert.match(tagText, /overflow:hidden/);
  assert.match(tagText, /text-overflow:ellipsis/);
  assert.match(tagText, /white-space:nowrap/);
  const title = cssOf(styles.cardTitle);
  assert.match(title, /-webkit-line-clamp:2/);
});
