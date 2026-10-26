import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import type { Route } from '../../src/renderer/app/router';
import { TaskInspectorView, type TaskInspectorViewProps } from '../../src/renderer/features/tasks/TaskInspector';
import { failureKindAdvice, failureKindLabels, inspectorArtifacts } from '../../src/renderer/features/tasks/inspector-view';

function markup(node: React.ReactNode) {
  const props = { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'dark', children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}

const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 'unverified', pane: 'unverified' };
const dispatch = { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'sonnet', effort: 'high', execution: 'real' as const, maxParallel: 2, workspace: '/home/mocha/opensource/weaver' };
const base: Task = { id: 't1', title: '检查器任务', instruction: 'do the thing', owner, status: 'running', progress: 20, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T01:00:00Z', events: [], artifacts: [], dispatch };
const taskRoute = (taskId: string): Route => ({ page: 'tasks', view: 'all', taskId });
const view = (task: Task, tasks: Task[] = [task], extra: Partial<TaskInspectorViewProps> = {}) =>
  markup(React.createElement(TaskInspectorView, { task, tasks, busy: false, action: async () => true, taskRoute, onClose: () => {}, onEdit: () => {}, ...extra }));
/** The tab buttons in order, tags stripped. */
const tabLabels = (html: string) => [...html.matchAll(/role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));

test('the inspector has four tabs and no prompt, artifact, review or continuation tabs', () => {
  assert.deepEqual(tabLabels(view(base)), ['概况', '时间线0', '结果与验收', '要求']);
  assert.match(view({ ...base, events: [{ id: 'e1', at: base.updatedAt, kind: 'lifecycle', message: 'Task queued.' }] }), /时间线[\s\S]*?<span[^>]*>1<\/span>/);
  const html = view(base);
  assert.doesNotMatch(html, /role="tab"[^>]*>Prompt/);
  assert.doesNotMatch(html, /role="tab"[^>]*>产物/);
  assert.doesNotMatch(html, /role="tab"[^>]*>验收</);
  assert.doesNotMatch(html, /接续/);
});

test('the overview keeps the status tag, the activity line, the summary and the fact rows', () => {
  const html = view(base);
  assert.match(html, /aria-label="任务检查器"/);
  assert.match(html, /执行中/);
  assert.match(html, /lucide-loader/);
  const dts = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map(match => match[1]);
  assert.deepEqual(dts, ['子 Agent', '模型', '会话', '工作目录', '派发时间', '最近更新']);
  assert.match(html, /claude_worker/);
  assert.match(html, /claude \/ sonnet · high/);
  assert.match(html, /aria-label="复制工作目录"/);
  const done = view({ ...base, status: 'completed', summary: '# 检查结果\n\n**通过**' });
  assert.match(done, /<h1[^>]*>检查结果<\/h1>/);
  assert.doesNotMatch(done, /lucide-loader/);
});

test('the header closes with its own button and keeps at most one primary action', () => {
  const draft = { ...base, status: 'queued' as const, dispatch: undefined, workspace: '/tmp/proj' };
  const html = view(draft);
  assert.match(html, /aria-label="关闭任务详情"/);
  assert.match(html, />编辑</);
  assert.match(html, />开始执行</);
  assert.equal(html.match(/data-type="primary"/g)?.length ?? 0, 1);
  const pending = view({ ...base, status: 'completed' as const });
  assert.match(pending, />验收</);
  assert.match(pending, />新建重试任务</);
  assert.doesNotMatch(pending, />开始执行|取消任务</);
  assert.equal(pending.match(/data-type="primary"/g)?.length ?? 0, 1);
});

test('a failed task banners the kind, the advice and the message with expandable raw output', () => {
  const failed: Task = { ...base, status: 'failed', failure: { kind: 'quota', message: 'plan quota exceeded', stderrTail: 'stderr line 9', vendorError: 'AI_APICallError 429' } };
  const html = view(failed);
  assert.match(html, /执行失败 · 额度耗尽/);
  assert.match(html, /补充额度或切换渠道后重试/);
  assert.match(html, /plan quota exceeded/);
  assert.match(html, /aria-expanded="false"[^>]*>[\s\S]*?错误详情/);
  assert.match(html, /aria-label="复制失败信息"/);
  assert.doesNotMatch(html, /stderr line 9|AI_APICallError 429/);
});

test('every failure kind has a Chinese label and a recovery hint', () => {
  const kinds = ['early_exit', 'no_output', 'rate_limit', 'quota', 'auth', 'vendor', 'cancelled', 'other', 'unknown_outcome'] as const;
  assert.deepEqual(kinds.map(kind => failureKindLabels[kind]), ['提前退出', '无输出', '供应商限流', '额度耗尽', '认证失败', '供应商错误', '已取消', '其他错误', '结果未知']);
  for (const kind of kinds) assert.ok(failureKindAdvice[kind].length > 5, kind);
  assert.match(failureKindAdvice.rate_limit, /限流/);
  assert.match(failureKindAdvice.auth, /登录/);
});

test('a failed banner never pops a toast: failures are banner content only', () => {
  const source = readFileSync(new URL('../../src/renderer/features/tasks/TaskInspector.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /useNotifyError/);
  assert.doesNotMatch(source, /OwnerInspector/);
});

test('queued and cancelled banners reuse the existing wording', () => {
  const queued = view({ ...base, status: 'queued', scheduled: true, queueReason: { code: 'waiting_for_capacity', message: 'at its current concurrency limit' } });
  assert.match(queued, /调度请求已排队/);
  assert.match(queued, /等待执行槽位/);
  assert.match(queued, /at its current concurrency limit/);
  assert.match(view({ ...base, status: 'cancelled' }), /执行已取消/);
});

test('a superseded task links to its replacement', () => {
  const next: Task = { ...base, id: 't-new', title: '替代任务' };
  const html = view({ ...base, status: 'cancelled', supersededBy: 't-new', supersededReason: '已重试接管' }, [base, next]);
  assert.match(html, /已被替代/);
  assert.match(html, /已重试接管/);
  assert.match(html, /href="#\/tasks\/all\/t\/t-new"/);
  assert.match(html, />替代任务</);
});

test('the retry source is a route link, never bare text', () => {
  const first: Task = { ...base, id: 't0', title: '首次尝试' };
  const retry = { ...base, id: 't1', retryOf: 't0' };
  const html = view(retry, [first, retry]);
  assert.match(html, /<dt[^>]*>重试来源<\/dt><dd[^>]*>[\s\S]*?href="#\/tasks\/all\/t\/t0"[\s\S]*?首次尝试/);
  assert.doesNotMatch(view(base), /重试来源/);
});

test('a root task lists its own children as route links', () => {
  const root: Task = { ...base, id: 'root', title: '根任务', executionRole: 'owner', dispatch: undefined, status: 'completed' };
  const children: Task[] = [
    { ...base, id: 'child-1', title: '实现子任务', parentTaskId: 'root' },
    { ...base, id: 'child-2', title: '不相关任务', parentTaskId: 'other-root' },
  ];
  const html = view(root, [root, ...children]);
  assert.match(html, /子任务 · 1/);
  assert.match(html, /href="#\/tasks\/all\/t\/child-1"/);
  assert.match(html, /实现子任务/);
  assert.doesNotMatch(html, /不相关任务/);
});

test('the session fact links when a route is provided and stays text otherwise', () => {
  const session = (task: Task): Route => ({ page: 'tasks', view: 'sessions', sessionKey: `o-${task.ownerId ?? 'x'}` });
  assert.match(view(base, [base], { sessionRoute: session }), /<dt[^>]*>会话<\/dt><dd[^>]*>[\s\S]*?href="#\/tasks\/s\/o-x"/);
  const plain = view({ ...base, owner: { ...owner, name: 'claude_owner' } });
  assert.match(plain, /<dt[^>]*>会话<\/dt><dd[^>]*>[\s\S]*?claude_owner/);
  assert.doesNotMatch(plain, /<dt[^>]*>会话<\/dt><dd[^>]*>[\s\S]*?<a /);
});

test('the timeline tab keeps the search and the events', () => {
  const html = view({ ...base, events: [{ id: 'e1', at: base.updatedAt, kind: 'lifecycle', message: 'Policy selected codex; launching' }] }, undefined, { initialTab: 'timeline' });
  assert.match(html, /搜索已加载事件/);
  assert.match(html, /策略已选择子 Agent codex，正在启动/);
});

test('the result tab explains the wait, then reviews and lists artifacts', () => {
  const waiting = view({ ...base, status: 'running' }, [base], { initialTab: 'result' });
  assert.match(waiting, /执行成功后进入验收/);
  const done = view({ ...base, status: 'completed', summary: 'UNIQUE_SUMMARY', artifacts: [{ id: 'a', name: 'notes.md', mediaType: 'text/markdown', content: 'different', createdAt: base.updatedAt }] }, undefined, { initialTab: 'result' });
  assert.match(done, /正在读取结果清单/);
  assert.match(done, /different/);
  assert.doesNotMatch(done, /UNIQUE_SUMMARY.*UNIQUE_SUMMARY/);
});

test('the requirements tab folds the prompt with a copy action', () => {
  const html = view({ ...base, instruction: '<script>bad()</script>\n' + 'A long instruction. '.repeat(100), constraints: ['约束一'], acceptanceCriteria: [] }, [base], { initialTab: 'requirements' });
  assert.match(html, /约束一/);
  assert.match(html, /等待父 Agent 生成验收标准/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(html, /复制Prompt/);
  assert.match(html, /aria-label="展开Prompt"/);
});

test('artifacts duplicating the trimmed summary fold into the result block', () => {
  const artifact = { id: 'result', name: 'result.md', content: '  UNIQUE_SUMMARY\n', mediaType: 'text/markdown' as const, createdAt: base.updatedAt };
  assert.equal(inspectorArtifacts({ ...base, summary: 'UNIQUE_SUMMARY', artifacts: [artifact] }).length, 0);
  assert.equal(inspectorArtifacts({ ...base, summary: 'UNIQUE_SUMMARY', artifacts: [artifact, { ...artifact, id: 'other', name: 'notes.md', content: 'different' }] }).length, 1);
});

test('the session fact names the root task or the human host clock, never the full machine name', () => {
  const root: Task = { ...base, id: 'root', title: '迁移构建脚本', executionRole: 'owner', owner: { ...owner, name: 'Claude · weaver · 21:30' } };
  const child: Task = { ...base, id: 'child', parentTaskId: 'root', owner: root.owner };
  const named = view(child, [root, child]);
  assert.match(named, /<dt[^>]*>会话<\/dt><dd[^>]*>[\s\S]*?迁移构建脚本/);
  assert.doesNotMatch(named, /Claude · weaver · 21:30/);
  const host = view({ ...base, id: 'host', title: '宿主任务', owner: { ...owner, name: 'Claude · weaver · 21:30' }, dispatch: undefined });
  assert.match(host, /<dt[^>]*>会话<\/dt><dd[^>]*>[\s\S]*?Claude · 21:30/);
  assert.doesNotMatch(host, />Claude · weaver · 21:30</);
  assert.match(host, /title="Claude · weaver · 21:30"/);
});
