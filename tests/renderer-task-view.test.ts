import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Config } from '../src/shared/policy';
import type { Task } from '../src/shared/types';
import { ALL_OWNERS, COLLAPSED_LANES_KEY, OWNER_FILTER_KEY, UNASSIGNED_OWNER, dispatchKind, filterByOwner, filterTasks, ownerFacets, ownerKindLookup, ownerLabel, ownerLanes, projectLabel, resolveOwnerFilter, taskOwnerId } from '../src/renderer/task-view';
import { EngineIcon, AgentLabel } from '../src/renderer/components/EngineIcon';
import { TaskBoard } from '../src/renderer/components/TaskBoard';
import { TaskDetail } from '../src/renderer/components/TaskDetail';
import { OwnerInspector } from '../src/renderer/components/OwnerInspector';

function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 'unverified', pane: 'unverified' };
const unassigned: Task = { id: 't1', title: '重排任务面板', instruction: 'Rework the board', owner, status: 'completed', progress: 100, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z', events: [], artifacts: [] };
const dispatch = { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'sonnet', effort: 'high', execution: 'real' as const, maxParallel: 2, workspace: '/home/mocha/opensource/weaver' };
const claude: Task = { ...unassigned, id: 't2', title: '接入新引擎', status: 'running', progress: 20, updatedAt: '2026-10-18T01:00:00Z', dispatch, events: [{ id: 'e1', at: '2026-10-18T01:00:00Z', kind: 'log', message: 'Reading TaskBoard.tsx' }] };
const codex: Task = { ...unassigned, id: 't3', title: '补齐接续包', owner: { ...owner, name: 'codex_owner' }, updatedAt: '2026-10-18T01:30:00Z', dispatch: { ...dispatch, owner: 'codex_owner', worker: 'codex_worker', workspace: '/tmp/weaver-tasks/server-4VDE/frontend/' } };
const items = [codex, claude, unassigned];

const policyConfig = {
  version: 1,
  engines: { claude: { enabled: true, kind: 'claude', quota_refresh: true }, qoder: { enabled: false, kind: 'qodercli', quota_refresh: false } },
  owners: { claude_owner: { enabled: true, engine: 'claude', model: 'claude-opus-5-5', effort: 'high', workers: ['claude_worker'], max_parallel: 4 } },
  workers: { claude_worker: { enabled: true, engine: 'claude', model: 'sonnet', effort: 'high' } },
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
  assert.match(labeled, /<span[^>]*><svg[^>]*><title>Qoder<\/title>[\s\S]*?<\/svg>qoder_worker<\/span>/);
});

test('owner attribution prefers the frozen dispatch over the placeholder owner name', () => {
  assert.equal(ownerLabel(claude), 'claude_owner');
  assert.equal(ownerLabel(codex), 'codex_owner');
  assert.equal(ownerLabel(unassigned), '未指定负责人');
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

test('owner filter offers every owner with its count and narrows the list', () => {
  assert.deepEqual(ownerFacets(items), [{ value: ALL_OWNERS, label: '全部', count: 3 }, { value: 'claude_owner', label: 'claude_owner', count: 1 }, { value: 'codex_owner', label: 'codex_owner', count: 1 }, { value: '未指定负责人', label: '未指定负责人', count: 1 }]);
  assert.deepEqual(ownerFacets([]), [{ value: ALL_OWNERS, label: '全部', count: 0 }]);
  assert.deepEqual(filterByOwner(items, 'claude_owner').map(task => task.id), ['t2']);
  assert.equal(filterByOwner(items, ALL_OWNERS).length, 3);
  assert.deepEqual(filterByOwner(items, 'missing'), []);
});

test('search reaches the real owner and the project, not only the placeholder name', () => {
  assert.deepEqual(filterTasks(items, 'all', 'claude_owner').map(task => task.id), ['t2']);
  assert.deepEqual(filterTasks(items, 'all', 'FRONTEND').map(task => task.id), ['t3']);
  assert.deepEqual(filterTasks(items, 'all', '未指定').map(task => task.id), ['t1']);
});

/** localStorage swap so board state tests can seed and observe persistence. */
function withStorage(seed: Record<string, string>, run: () => void): void {
  const store = {
    getItem: (key: string) => (key in seed ? seed[key] : null),
    setItem: (key: string, value: string) => { seed[key] = value; },
    removeItem: (key: string) => { delete seed[key]; },
  } as unknown as Storage;
  const previous = Object.hasOwn(globalThis, 'localStorage') ? globalThis.localStorage : undefined;
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  try { run(); } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', { value: previous, configurable: true, writable: true });
  }
}

test('board filters by owner and shows counts next to the search box', () => {
  const html = markup(React.createElement(TaskBoard, { tasks: items, loading: false, onSelect: () => {}, ownerKind }));
  assert.match(html, /按负责人筛选/);
  assert.match(html, /全部 3/);
  assert.match(html, /claude_owner 1/);
  assert.match(html, /搜索标题、负责人、项目或任务 ID/);
  assert.match(html, /claude_owner<\/span> → <span[^>]*>[\s\S]{0,800}claude_worker<\/span> · weaver/);
  assert.match(html, /<title>Claude Code<\/title>/);
  assert.match(html, /未指定负责人/);
  assert.doesNotMatch(html, /role="progressbar"/);
});

test('running and queued cards spin, finished cards do not, and a running card carries exactly one loader', () => {
  const spinning = markup(React.createElement(TaskBoard, { tasks: [claude], loading: false, onSelect: () => {} }));
  assert.match(spinning, /lucide-loader-2/);
  assert.match(spinning, /Reading TaskBoard\.tsx/);
  assert.equal((spinning.match(/lucide-loader-2/g) ?? []).length, 1);
  const waiting = markup(React.createElement(TaskBoard, { tasks: [{ ...claude, status: 'queued', scheduled: true }], loading: false, onSelect: () => {} }));
  assert.match(waiting, /lucide-loader-2/);
  assert.match(waiting, /排队中/);
  assert.equal((waiting.match(/lucide-loader-2/g) ?? []).length, 1);
  const stopped = markup(React.createElement(TaskBoard, { tasks: [unassigned], loading: false, onSelect: () => {} }));
  assert.doesNotMatch(stopped, /lucide-loader-2/);
});

test('a stored owner filter that no longer matches any facet falls back to 全部', () => {
  assert.equal(resolveOwnerFilter('legacy_owner', items), ALL_OWNERS);
  assert.equal(resolveOwnerFilter('claude_owner', items), 'claude_owner');
  assert.equal(resolveOwnerFilter(ALL_OWNERS, items), ALL_OWNERS);
  assert.equal(resolveOwnerFilter('legacy_owner', []), ALL_OWNERS);
  withStorage({ [OWNER_FILTER_KEY]: 'legacy_owner' }, () => {
    const html = markup(React.createElement(TaskBoard, { tasks: items, loading: false, onSelect: () => {} }));
    assert.match(html, /全部 3/);
    assert.match(html, /接入新引擎|补齐接续包/);
    assert.match(html, /claude_owner/);
  });
});

/* ---- owner swimlanes on the board ---- */

const queued = { status: 'queued' as const, progress: 0 };
/** Two lanes: claude_owner (2 active / 4 total) ranks before codex_owner (1 active / 4 total). */
const laneTasks = [
  claude,  // claude_owner · running
  { ...claude, id: 'b2', title: '排队任务甲', ...queued },
  { ...claude, id: 'b3', title: '验收任务甲', status: 'completed' as const },
  { ...claude, id: 'b4', title: '结束任务甲', status: 'failed' as const },
  codex,  // codex_owner · completed awaiting review
  { ...codex, id: 'c2', title: '排队任务乙', ...queued },
  { ...codex, id: 'c3', title: '验收任务乙', status: 'completed' as const },
  { ...codex, id: 'c4' , title: '结束任务乙', status: 'cancelled' as const },
] as Task[];

test('owner lanes group and order the board: active tasks first, then total, then the name', () => {
  const grokQueued = (id: string) => ({ ...claude, id, title: `grok ${id}`, ...queued, dispatch: { ...dispatch, owner: 'grok_owner', worker: 'grok_worker' } });
  assert.deepEqual(ownerLanes([grokQueued('g1'), grokQueued('g2'), grokQueued('g3'), ...laneTasks]).map(lane => lane.owner), ['grok_owner', 'claude_owner', 'codex_owner']);
  assert.equal(ownerLanes(laneTasks)[0].owner, 'claude_owner');
  const [claudeLane, codexLane] = ownerLanes(laneTasks);
  assert.deepEqual(claudeLane.counts, [1, 1, 1, 1]);
  assert.equal(claudeLane.total, 4);
  assert.deepEqual(codexLane.counts, [1, 0, 2, 1]);
  assert.equal(codexLane.total, 4);
  const tie = ownerLanes([claude, codex, { ...codex, id: 'x2', title: 'tie', ...queued }]);
  assert.deepEqual(tie.map(lane => lane.owner), ['codex_owner', 'claude_owner']);
  const names = ownerLanes([{ ...claude, id: 'x1', title: 'n1', ...queued }, { ...codex, id: 'x2', title: 'n2', ...queued }]);
  assert.deepEqual(names.map(lane => lane.owner), ['claude_owner', 'codex_owner']);
});

test('the board renders a swimlane per owner with the lane counts in the header', () => {
  const html = markup(React.createElement(TaskBoard, { tasks: laneTasks, loading: false, onSelect: () => {}, ownerKind }));
  assert.match(html, /执行中 1 · 待验收 1 · 共 4/);
  assert.match(html, /执行中 0 · 待验收 2 · 共 4/);
  assert.match(html, /aria-label="claude_owner 的任务"/);
  assert.match(html, /aria-label="codex_owner 的任务"/);
  assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /aria-expanded="false"/);
});

test('collapsible lanes persist the fold per owner in localStorage', () => {
  withStorage({ [COLLAPSED_LANES_KEY]: JSON.stringify({ claude_owner: true }) }, () => {
    const html = markup(React.createElement(TaskBoard, { tasks: laneTasks, loading: false, onSelect: () => {}, ownerKind }));
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /执行中 1 · 待验收 1 · 共 4/);
    assert.doesNotMatch(html, /排队任务甲|验收任务甲|结束任务甲/);
    assert.match(html, /排队任务乙/);
  });
  const quiet = { ...claude, id: 's1', title: '单独任务', ...queued };
  const solo = markup(React.createElement(TaskBoard, { tasks: [quiet], loading: false, onSelect: () => {} }));
  assert.match(solo, /执行中 0 · 待验收 0 · 共 1/);
  assert.equal((solo.match(/—/g) ?? []).length, 3);
});

test('selecting one owner in the filter shows only that lane, forced open', () => {
  withStorage({ [OWNER_FILTER_KEY]: 'codex_owner', [COLLAPSED_LANES_KEY]: JSON.stringify({ codex_owner: true, claude_owner: true }) }, () => {
    const html = markup(React.createElement(TaskBoard, { tasks: laneTasks, loading: false, onSelect: () => {}, ownerKind }));
    assert.doesNotMatch(html, /aria-label="claude_owner 的任务"/);
    assert.match(html, /aria-label="codex_owner 的任务"/);
    assert.match(html, /aria-expanded="true"/);
    assert.doesNotMatch(html, /aria-expanded="false"/);
    assert.match(html, /排队任务乙/);
    assert.doesNotMatch(html, /排队任务甲|结束任务甲/);
  });
});

const detailProps = { busy: false, onStart: () => {}, onCancel: () => {}, action: async () => true };

test('detail is one column: status tag, meta line, no progress bar or lifecycle tally', () => {
  const html = markup(React.createElement(TaskDetail, { task: claude, ...detailProps, ownerKind }));
  assert.match(html, /执行中/);
  assert.match(html, /lucide-loader-2/);
  assert.doesNotMatch(html, /lucide-loader-2[\s\S]*lucide-loader-2/);
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.doesNotMatch(html, /执行进度/);
  assert.doesNotMatch(html, /已创建 ·/);
  assert.doesNotMatch(html, /最近活动/);
  assert.match(html, /claude_owner<\/span> → <span[^>]*>[\s\S]{0,800}claude_worker<\/span> · claude \/ sonnet · high · weaver · 更新于/);
  assert.match(html, /<title>Claude Code<\/title>/);
  assert.doesNotMatch(html, /待验收|已通过/);
  const noPolicy = markup(React.createElement(TaskDetail, { task: claude, ...detailProps }));
  assert.match(noPolicy, /claude_owner<\/span> →/);
  assert.match(noPolicy, /lucide lucide-bot/);
});

test('the review tag appears only once execution completed', () => {
  const done = markup(React.createElement(TaskDetail, { task: { ...claude, status: 'completed', summary: '面板已重排' }, ...detailProps }));
  assert.match(done, /待验收/);
  assert.doesNotMatch(done, /lucide-loader-2/);
  assert.match(done, /执行结果/);
  assert.match(done, /面板已重排/);
  assert.doesNotMatch(done, /执行完成与验收通过分别记录/);
  assert.match(markup(React.createElement(TaskDetail, { task: { ...claude, status: 'completed', reviewState: 'accepted' as const }, ...detailProps })), /已通过/);
  assert.doesNotMatch(markup(React.createElement(TaskDetail, { task: { ...claude, status: 'completed' }, ...detailProps })), /执行结果/);
});

test('detail notes only the states that need explaining', () => {
  const queued = markup(React.createElement(TaskDetail, { task: { ...claude, status: 'queued', scheduled: true, queueReason: { code: 'waiting_for_capacity', message: 'at its current concurrency limit' } }, ...detailProps }));
  assert.match(queued, /调度请求已排队/);
  assert.match(queued, /等待执行槽位/);
  assert.match(queued, /at its current concurrency limit/);
  assert.doesNotMatch(queued, /执行失败|执行已取消/);
  const failed = markup(React.createElement(TaskDetail, { task: { ...claude, status: 'failed', events: [{ id: 'e9', at: claude.updatedAt, kind: 'error', message: 'engine exited 1' }] }, ...detailProps }));
  assert.match(failed, /执行失败/);
  assert.match(failed, /engine exited 1/);
  assert.doesNotMatch(failed, /调度请求已排队|执行已取消/);
  const cancelled = markup(React.createElement(TaskDetail, { task: { ...claude, status: 'cancelled' }, ...detailProps }));
  assert.match(cancelled, /执行已取消/);
  assert.doesNotMatch(cancelled, /调度请求已排队|执行失败/);
  assert.doesNotMatch(markup(React.createElement(TaskDetail, { task: { ...claude, status: 'completed' }, ...detailProps })), /调度请求已排队|执行失败|执行已取消/);
});

test('long instructions clamp to a few lines and expand on demand', () => {
  const long = `${'Remove every progress bar and rework the header. '.repeat(8)}Then keep tabs.`;
  const folded = markup(React.createElement(TaskDetail, { task: { ...claude, instruction: long }, ...detailProps }));
  assert.match(folded, /-webkit-line-clamp:4/);
  assert.match(folded, /展开/);
  assert.doesNotMatch(folded, /收起/);
  const short = markup(React.createElement(TaskDetail, { task: { ...claude, instruction: 'Rework the board' }, ...detailProps }));
  assert.doesNotMatch(short, /展开|收起/);
  assert.match(short, /-webkit-line-clamp:4/);
});

test('retry lineage is a quiet line only when it exists', () => {
  assert.match(markup(React.createElement(TaskDetail, { task: { ...claude, retryOf: 't0' }, ...detailProps })), /重试来源：t0/);
  assert.doesNotMatch(markup(React.createElement(TaskDetail, { task: claude, ...detailProps })), /重试来源/);
});

test('handover moves into the fourth tab of the same record', () => {
  const html = markup(React.createElement(TaskDetail, { task: claude, ...detailProps }));
  assert.match(html, /id="task-tab-continuation"/);
  assert.match(html, /aria-controls="task-panel-continuation"/);
  assert.doesNotMatch(html, /执行上下文/);
});

test('inspector names the dispatch owner and project without a fake percentage', () => {
  const routed = markup(React.createElement(OwnerInspector, { task: claude, busy: false, action: async () => true }));
  assert.match(routed, /Owner claude_owner/);
  assert.match(routed, /工作目录 \/home\/mocha\/opensource\/weaver/);
  assert.doesNotMatch(routed, /当前进度|尚未记录调度结果/);
  const legacy = markup(React.createElement(OwnerInspector, { task: unassigned, busy: false, action: async () => true }));
  assert.match(legacy, /Owner 未指定负责人/);
  assert.match(legacy, /尚未记录调度结果/);
  assert.match(legacy, /工作目录 旧任务未记录/);
  assert.doesNotMatch(legacy, /当前进度/);
});
