import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { TaskEvent } from '../src/shared/types';
import { condenseEvents, filterCondensed, isTimelineNoise, normalizeToolName, timelineActive } from '../src/renderer/log-view';
import { EventsPanel } from '../src/renderer/components/EventsPanel';

function event(id: string, kind: TaskEvent['kind'], message: string, seconds = 0): TaskEvent {
  return { id, at: `2026-10-18T00:00:${String(seconds).padStart(2, '0')}Z`, kind, message };
}

function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

test('noise classifier keeps lifecycle, result, artifact, error and non-tool logs', () => {
  assert.equal(isTimelineNoise(event('a', 'lifecycle', 'Worker exited successfully; output is ready for owner review')), false);
  assert.equal(isTimelineNoise(event('b', 'result', 'done')), false);
  assert.equal(isTimelineNoise(event('c', 'artifact', 'report.md')), false);
  assert.equal(isTimelineNoise(event('d', 'error', 'boom')), false);
  assert.equal(isTimelineNoise(event('e', 'log', 'Launching codex with requested model gpt-5')), false);
  assert.equal(isTimelineNoise(event('f', 'log', 'retained evidence clipped: field=assistant limitCharacters=20000')), false);
  assert.equal(isTimelineNoise(event('g', 'log', 'tool started bash')), true);
  assert.equal(isTimelineNoise(event('h', 'log', 'tool finished command_execution')), true);
  assert.equal(isTimelineNoise(event('i', 'log', 'tool started file_change')), true);
  assert.equal(isTimelineNoise(event('j', 'progress', 'opencode step started')), true);
  assert.equal(isTimelineNoise(event('k', 'progress', 'owned scope started')), true);
  assert.equal(isTimelineNoise(event('l', 'progress', 'qodercli session started')), true);
  assert.equal(isTimelineNoise(event('m', 'progress', 'Scanning repository')), false);
});

test('tool names normalize case-insensitively and collapse aliases', () => {
  assert.equal(normalizeToolName('bash'), 'Bash');
  assert.equal(normalizeToolName('Bash'), 'Bash');
  assert.equal(normalizeToolName('command_execution'), 'Bash');
  assert.equal(normalizeToolName('edit'), 'Edit');
  assert.equal(normalizeToolName('file_change'), 'Edit');
  assert.equal(normalizeToolName('read'), 'Read');
  assert.equal(normalizeToolName('grep'), 'Grep');
  assert.equal(normalizeToolName('write'), 'Write');
  assert.equal(normalizeToolName('WebSearch'), 'WebSearch');
  assert.equal(normalizeToolName('custom_tool'), 'Custom_tool');
});

test('steps groups merge maximal noise runs with sorted per-tool invocation counts', () => {
  const items = condenseEvents([
    event('1', 'lifecycle', 'Frozen work package created'),
    event('2', 'log', 'tool started bash'),
    event('3', 'log', 'tool finished bash'),
    event('4', 'progress', 'owned scope started'),
    event('5', 'log', 'tool started Bash', 1),
    event('6', 'log', 'tool started Edit', 2),
    event('7', 'log', 'tool finished Edit', 3),
    event('8', 'lifecycle', 'Policy selected weaver; launching'),
  ], { active: false });
  assert.equal(items.length, 3);
  assert.equal(items[0].type, 'event');
  const group = items[1];
  assert.equal(group.type, 'steps');
  if (group.type !== 'steps') return;
  assert.deepEqual(group.tools, [{ name: 'Bash', count: 2 }, { name: 'Edit', count: 1 }]);
  assert.equal(group.count, 3);
  assert.equal(group.events.length, 6);
  assert.equal(group.from.id, '2');
  assert.equal(group.to.id, '7');
  assert.equal(items[2].type, 'event');
});

test('a run with only finished notes still counts invocations', () => {
  const items = condenseEvents([
    event('1', 'log', 'tool finished read'),
    event('2', 'log', 'tool finished Grep'),
    event('3', 'log', 'tool failed grep'),
  ], { active: false });
  assert.equal(items.length, 1);
  const group = items[0];
  if (group.type !== 'steps') return assert.fail('expected steps');
  assert.deepEqual(group.tools, [{ name: 'Grep', count: 2 }, { name: 'Read', count: 1 }]);
  assert.equal(group.count, 3);
});

test('events can look like tool notes without the noise prefix and stay visible', () => {
  const items = condenseEvents([event('1', 'log', 'start bash tool'), event('2', 'log', 'tool started Bash')], { active: false });
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'event');
});

test('the last steps group is marked in-progress only while the task is active', () => {
  const events = [event('1', 'progress', 'owned scope started'), event('2', 'log', 'tool started bash')];
  const running = condenseEvents(events, { active: true });
  const idle = condenseEvents(events, { active: false });
  assert.equal(running[0].type === 'steps' && running[0].inProgress, true);
  assert.equal(idle[0].type === 'steps' && idle[0].inProgress, false);
  const settled = [event('1', 'log', 'tool started bash'), event('2', 'lifecycle', 'Worker exited successfully; output is ready for owner review')];
  const closed = condenseEvents(settled, { active: true });
  assert.equal(closed[0].type === 'steps' && closed[0].inProgress, false);
  assert.equal(closed[1].type, 'event');
});

test('timeline activity follows task status regardless of loaded lifecycle history', () => {
  for (const status of ['queued', 'completed', 'failed', 'cancelled'] as const) assert.equal(timelineActive(status), false);
  for (const status of ['running', 'cancelling'] as const) assert.equal(timelineActive(status), true);
});

test('search keeps important events whose redacted message matches and groups with matching raw events', () => {
  const events = [
    event('1', 'log', 'token=hidden bash -lc ls'),
    event('2', 'log', 'tool finished bash'),
    event('3', 'lifecycle', 'Frozen work package created'),
  ];
  const condensed = condenseEvents(events, { active: false });
  assert.equal(filterCondensed(condensed, 'bash').length, 2);
  assert.equal(filterCondensed(condensed, 'hidden').length, 0);
  assert.equal(filterCondensed(condensed, 'created').length, 1);
  assert.equal(filterCondensed(condensed, '').length, 3);
});

test('condensed timeline renders step summaries and keeps hidden raw chatter collapsed', () => {
  const events = [
    event('1', 'lifecycle', 'Policy selected codex; launching'),
    event('2', 'log', 'tool started bash', 1),
    event('3', 'log', 'tool finished bash', 2),
    event('4', 'progress', 'owned scope started', 3),
    event('5', 'result', 'done summary'),
  ];
  const html = markup(React.createElement(EventsPanel, { events, taskId: 't' }));
  assert.match(html, /精简/);
  assert.match(html, /全部/);
  assert.match(html, /执行了 1 个步骤 · Bash 1/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /tool started bash/);
  assert.match(html, /Policy selected codex; launching/);
  assert.match(html, /状态/);
  assert.match(html, /done summary/);
  assert.doesNotMatch(html, /已加载 \d+ 条/);
});

test('all-events mode keeps today view with export note and load control', () => {
  const original = (globalThis as Record<string, unknown>).localStorage;
  (globalThis as Record<string, unknown>).localStorage = { getItem: () => 'all', setItem: () => {} };
  try {
    const events = [event('1', 'log', 'tool started bash'), event('2', 'lifecycle', 'Task queued.')];
    const html = markup(React.createElement(EventsPanel, { events, taskId: 't' }));
    assert.match(html, /已加载 2 条 · 导出会遮盖常见凭据格式/);
    assert.match(html, /事件类型/);
    assert.doesNotMatch(html, /执行了 \d+ 个步骤/);
    assert.match(html, /tool started bash/);
  } finally {
    (globalThis as Record<string, unknown>).localStorage = original;
  }
});

test('condensed empty state still explains the timeline when nothing loaded', () => {
  const html = markup(React.createElement(EventsPanel, { events: [], taskId: 't' }));
  assert.match(html, /暂无事件。任务状态和 worker 输出会记在这里。/);
});


test('progress-only chatter and malformed tool notes never render zero-step groups', () => {
  const events = [event('1', 'progress', 'owned scope started'), event('2', 'log', 'tool started'), event('3', 'log', 'plain output')];
  const items = condenseEvents(events, { active: true });
  assert.equal(items.length, 3);
  assert.ok(items.every(item => item.type === 'event'));
  const html = markup(React.createElement(EventsPanel, { events, taskId: 't', active: true }));
  assert.doesNotMatch(html, /执行了 0 个步骤/);
  assert.match(html, /plain output/);
});

test('a terminal task with only the first timeline page loaded never spins', () => {
  const events = [event('1', 'lifecycle', 'Policy selected codex; launching'), event('2', 'log', 'tool started bash')];
  const idle = markup(React.createElement(EventsPanel, { events, taskId: 't', active: false }));
  const active = markup(React.createElement(EventsPanel, { events, taskId: 't', active: true }));
  assert.match(idle, /执行了 1 个步骤/);
  assert.doesNotMatch(idle, /lucide-loader/);
  assert.match(active, /lucide-loader/);
  assert.doesNotMatch(markup(React.createElement(EventsPanel, { events, taskId: 't' })), /lucide-loader/);
});
