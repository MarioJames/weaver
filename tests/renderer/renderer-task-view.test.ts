import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Config } from '../../src/shared/contracts/policy';
import type { Task } from '../../src/shared/contracts/tasks';
import type { Route } from '../../src/renderer/app/router';
import { dispatchKind, ownerKindLookup, ownerLabel, projectLabel, taskOwnerId } from '../../src/renderer/features/tasks/task-view';
import { inspectorArtifacts } from '../../src/renderer/features/tasks/inspector-view';
import { EngineIcon, AgentLabel } from '../../src/renderer/ui/EngineIcon';
import { StatusBadge } from '../../src/renderer/ui/StatusBadge';
import { readWorkbenchEnded, writeWorkbenchEnded, WORKBENCH_ENDED_KEY } from '../../src/renderer/features/tasks/task-persistence';
import { TaskInspectorView, type TaskInspectorViewProps } from '../../src/renderer/features/tasks/TaskInspector';
import { TaskTextBlock } from '../../src/renderer/features/tasks/TaskTextBlock';

function markup(node: React.ReactNode) {
  const props = { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'dark', children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 'unverified', pane: 'unverified' };
const unassigned: Task = { id: 't1', title: '重排任务面板', instruction: 'Rework the board', owner, status: 'completed', progress: 100, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z', events: [], artifacts: [] };
const dispatch = { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'sonnet', effort: 'high', execution: 'real' as const, maxParallel: 2, workspace: '/home/mocha/opensource/weaver' };
const claude: Task = { ...unassigned, id: 't2', title: '接入新引擎', status: 'running', progress: 20, updatedAt: '2026-10-18T01:00:00Z', dispatch, events: [{ id: 'e1', at: '2026-10-18T01:00:00Z', kind: 'log', message: 'Reading TaskBoard.tsx' }] };
const codex: Task = { ...unassigned, id: 't3', title: '补齐接续包', owner: { ...owner, name: 'codex_owner' }, updatedAt: '2026-10-18T01:30:00Z', dispatch: { ...dispatch, owner: 'codex_owner', worker: 'codex_worker', workspace: '/tmp/weaver-tasks/server-4VDE/frontend/' } };

const policyConfig = {
  version: 1,
  engines: { claude: { enabled: true, kind: 'claude', quota_refresh: true }, qoder: { enabled: false, kind: 'qodercli', quota_refresh: false } },
  channels: { default_claude: { engine: 'claude', label: 'Claude 工作账号', kind: 'subscription', enabled: true } },
  owners: { claude_owner: { enabled: true, channel: 'default_claude', model: 'claude-opus-5-5', effort: 'high', workers: ['claude_worker'], max_parallel: 4 } },
  workers: { claude_worker: { enabled: true, channels: ['default_claude'], model: 'sonnet', effort: 'high' } },
  herdr: { max_wait_minutes: 15 },
} as unknown as Config;
const ownerKind = ownerKindLookup(policyConfig);

test('dispatch and owner engine kinds come from the frozen dispatch and the saved policy', () => {
  assert.equal(dispatchKind(claude), 'claude');
  assert.equal(dispatchKind({ ...claude, dispatch: { ...dispatch, engine: 'qoder', engineKind: 'qodercli' } }), 'qodercli');
  assert.equal(dispatchKind(unassigned), undefined);
  assert.equal(ownerKind('claude_owner'), 'claude');
  assert.equal(ownerKind('codex_owner'), undefined);
  assert.equal(ownerKind(), undefined);
  assert.equal(ownerKindLookup()('claude_owner'), undefined);
  assert.equal(taskOwnerId(claude), 'claude_owner');
  assert.equal(taskOwnerId(unassigned), undefined);
});

test('engine icons map every known kind and fall back to a neutral bot for unknown or missing kinds', () => {
  const titles = [['claude', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'opencode'], ['qoder', 'Qoder'], ['qodercli', 'Qoder'], ['pi', 'Pi'], ['grok', 'Grok']] as const;
  for (const [kind, title] of titles) assert.match(markup(React.createElement(EngineIcon, { kind })), new RegExp(`<title>${title}</title>`));
  const fallback = markup(React.createElement(EngineIcon, { kind: 'gemini' }));
  assert.match(fallback, /lucide lucide-bot/);
  assert.doesNotMatch(fallback, /<title>/);
  assert.match(markup(React.createElement(EngineIcon)), /lucide lucide-bot/);
  assert.match(markup(React.createElement(EngineIcon, { kind: 'claude' })), /aria-hidden="true"/);
});

test('agent labels pair the brand icon with the name in one inline row', () => {
  const labeled = markup(React.createElement(AgentLabel, { kind: 'qodercli', name: 'qoder_worker' }));
  assert.match(labeled, /<span[^>]*><svg[^>]*><title>Qoder<\/title>[\s\S]*?<\/svg><span[^>]*>qoder_worker<\/span><\/span>/);
});

test('owner attribution prefers the frozen dispatch over the placeholder owner name', () => {
  assert.equal(ownerLabel(claude), 'claude_owner');
  assert.equal(ownerLabel(codex), 'codex_owner');
  assert.equal(ownerLabel(unassigned), '未指定父 Agent');
  assert.equal(ownerLabel({ ...unassigned, owner: { ...owner, name: 'Mario' } }), 'Mario');
  assert.equal(ownerLabel({ ...unassigned, owner: { ...owner, name: 'Mario' }, dispatch }), 'claude_owner');
});

test('project label is the recorded workspace directory name', () => {
  assert.equal(projectLabel(claude), 'weaver');
  assert.equal(projectLabel(codex), 'frontend');
  assert.equal(projectLabel({ ...unassigned, workspace: '/tmp/weaver-tasks/server-4VDE' }), 'server-4VDE');
  assert.equal(projectLabel({ ...unassigned, workspace: '/tmp/a/b', dispatch }), 'weaver');
  assert.equal(projectLabel(unassigned), '');
});

/** localStorage swap so board state tests can seed and observe persistence. */
function withStorage<T>(seed: Record<string, string>, run: () => T): T {
  const store = {
    getItem: (key: string) => (key in seed ? seed[key] : null),
    setItem: (key: string, value: string) => { seed[key] = value; },
    removeItem: (key: string) => { delete seed[key]; },
  } as unknown as Storage;
  const previous = Object.hasOwn(globalThis, 'localStorage') ? globalThis.localStorage : undefined;
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  try { return run(); } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', { value: previous, configurable: true, writable: true });
  }
}

/* ---- workbench persistence ---- */

test('the workbench 已结束 section is folded by default and opens for the whole workbench', () => {
  const seed: Record<string, string> = {};
  withStorage(seed, () => writeWorkbenchEnded(true));
  assert.equal(seed[WORKBENCH_ENDED_KEY], 'true');
  assert.equal(withStorage(seed, readWorkbenchEnded), true);
  assert.equal(WORKBENCH_ENDED_KEY, 'weaver-workbench-ended');
});

test('only active execution badges spin', () => {
  const spinning = markup(React.createElement(StatusBadge, { status: 'running', variant: 'tag' }));
  assert.match(spinning, /lucide-loader-2/);
  assert.match(spinning, /执行中/);
  const stopped = markup(React.createElement(StatusBadge, { status: 'accepted' }));
  assert.doesNotMatch(stopped, /lucide-loader-2/);
  assert.match(stopped, /已通过/);
});

const taskRoute = (taskId: string): Route => ({ page: 'tasks', view: 'all', taskId });
const inspect = (value: Task, tasks: Task[] = [value], extra: Partial<TaskInspectorViewProps> = {}) =>
  markup(React.createElement(TaskInspectorView, { task: value, tasks, busy: false, action: async () => true, taskRoute, onClose: () => {}, onEdit: () => {}, ...extra }));

test('inspector is one column: status tag, facts block and child links, no progress bar or lifecycle tally', () => {
  const html = inspect(claude, [claude], { ownerKind });
  assert.match(html, /执行中/);
  assert.match(html, /lucide-loader-2/);
  assert.doesNotMatch(html, /lucide-loader-2[\s\S]*lucide-loader-2/);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.doesNotMatch(html, /执行进度/);
  assert.doesNotMatch(html, /已创建 ·/);
  assert.doesNotMatch(html, /最近活动/);
  /** The agents and the directory are the facts block; the session answers with the owner name. */
  assert.match(html, /<dt[^>]*>子 Agent<\/dt><dd[^>]*>[\s\S]*?claude_worker[\s\S]*?<\/dd>/);
  assert.match(html, /<dt[^>]*>工作目录<\/dt><dd[^>]*>[\s\S]*?\/home\/mocha\/opensource\/weaver[\s\S]*?<\/dd>/);
  assert.match(html, /<dt[^>]*>模型<\/dt>/);
  assert.match(html, /<dt[^>]*>最近更新<\/dt>/);
  assert.match(html, /<dt[^>]*>会话<\/dt><dd[^>]*>[\s\S]*?claude_owner[\s\S]*?<\/dd>/);
  assert.match(html, /<title>Claude Code<\/title>/);
  assert.doesNotMatch(html, /→/);
  assert.doesNotMatch(html, /已通过/);
  const unknown = inspect({ ...claude, dispatch: { ...dispatch, engine: 'mystery' } });
  assert.match(unknown, /<dt[^>]*>子 Agent<\/dt>[\s\S]*?lucide lucide-bot/);
});

test('the review tag appears only once execution completed', () => {
  const done = inspect({ ...claude, status: 'completed', summary: '面板已重排' });
  assert.match(done, /待验收/);
  assert.doesNotMatch(done, /lucide-loader-2/);
  assert.match(done, /执行结果/);
  assert.match(done, /面板已重排/);
  assert.doesNotMatch(done, /执行完成与验收通过分别记录/);
  assert.match(inspect({ ...claude, status: 'completed', reviewState: 'accepted' as const }), /已通过/);
  assert.doesNotMatch(inspect({ ...claude, status: 'completed' }), /执行结果/);
});

test('inspector notes only the states that need explaining', () => {
  const queued = inspect({ ...claude, status: 'queued', scheduled: true, queueReason: { code: 'waiting_for_capacity', message: 'at its current concurrency limit' } });
  assert.match(queued, /调度请求已排队/);
  assert.match(queued, /等待执行槽位/);
  assert.match(queued, /at its current concurrency limit/);
  assert.doesNotMatch(queued, /执行失败|执行已取消/);
  const failed = inspect({ ...claude, status: 'failed', events: [{ id: 'e9', at: claude.updatedAt, kind: 'error', message: 'engine exited 1' }] });
  assert.match(failed, /执行失败/);
  assert.match(failed, /engine exited 1/);
  assert.doesNotMatch(failed, /展开错误详情/);
  assert.doesNotMatch(failed, /调度请求已排队|执行已取消/);
  const cancelled = inspect({ ...claude, status: 'cancelled' });
  assert.match(cancelled, /执行已取消/);
  assert.doesNotMatch(cancelled, /调度请求已排队|执行失败/);
  assert.doesNotMatch(inspect({ ...claude, status: 'completed' }), /调度请求已排队|执行失败|执行已取消/);
});

test('retry lineage is a route link only when it exists', () => {
  const first = { ...claude, id: 't0', title: '首次尝试' };
  const html = inspect({ ...claude, retryOf: 't0' }, [first, claude]);
  assert.match(html, /<dt[^>]*>重试来源<\/dt><dd[^>]*>[\s\S]*?href="#\/tasks\/all\/t\/t0"[\s\S]*?首次尝试/);
  assert.doesNotMatch(inspect(claude), /重试来源/);
});

test('continuation lives at the session level, not in a task tab', () => {
  const labels = [...inspect(claude).matchAll(/role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));
  assert.deepEqual(labels, ['概况', '时间线1', '结果与验收', '要求']);
});

test('inspector default overview excludes prompt and requirements and keeps all facts in the panel', () => {
  const html = inspect({ ...claude, instruction: 'PRIVATE_PROMPT', constraints: ['ONLY_REQUIREMENT'], acceptanceCriteria: ['CRITERION_ONE'], summary: 'RESULT_TEXT' });
  const labels = [...html.matchAll(/role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));
  assert.deepEqual(labels, ['概况', '时间线1', '结果与验收', '要求']);
  assert.doesNotMatch(html, /PRIVATE_PROMPT|ONLY_REQUIREMENT|CRITERION_ONE|此旧任务未记录/);
  assert.match(html, /RESULT_TEXT/);
  assert.match(html, /Reading TaskBoard.tsx/);
});

test('inspector hides artifacts duplicating trimmed execution summary', () => {
  const artifact = { id: 'result', name: 'result.md', content: '  UNIQUE_SUMMARY\n', mediaType: 'text/markdown' as const, createdAt: claude.updatedAt };
  const task = { ...claude, summary: 'UNIQUE_SUMMARY' };
  assert.equal(inspectorArtifacts({ ...task, artifacts: [artifact] }).length, 0);
  assert.equal(inspectorArtifacts({ ...task, artifacts: [artifact, { ...artifact, id: 'other', name: 'notes.md', content: 'different' }] }).length, 1);
});

test('summary clamp offers expansion only for long text and preserves copy', () => {
  const short = markup(React.createElement(TaskTextBlock, { title: '执行结果', content: 'short result', clamp: 6 }));
  assert.match(short, /复制执行结果/);
  assert.doesNotMatch(short, /aria-expanded/);
  const long = markup(React.createElement(TaskTextBlock, { title: '执行结果', content: Array(10).fill('result line').join('\n'), clamp: 6 }));
  assert.match(long, /aria-expanded="false"/);
  assert.match(long, /展开/);
  assert.match(long, /aria-controls=/);
});
