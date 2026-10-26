import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeScope } from '@lobehub/ui';
import { toast, type ToastOptions } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../../src/shared/contracts/tasks';
import { PENDING_TASK_TITLE } from '../../src/shared/validation';
import { DISPLAY_LABELS, DISPLAY_STATUSES, DISPLAY_TONES, displayStatus } from '../../src/renderer/format/status-colors';
import { TaskAgents } from '../../src/renderer/features/tasks/TaskAgents';
import { archiveColumns } from '../../src/renderer/features/tasks/ArchiveDrawer';
import { TaskBoard } from '../../src/renderer/features/tasks/TaskBoard';
import { TaskComposer, composerInput, workspacePathError } from '../../src/renderer/features/tasks/TaskComposer';
import { WorkspacePicker, clearWorkspace, focusDirectoryPicker } from '../../src/renderer/features/tasks/WorkspacePicker';
import { TaskDetail } from '../../src/renderer/features/tasks/TaskDetail';
import { draftEdit, draftFields, notifySaveDraftFailure, taskUpdateArgs, updateTask } from '../../src/renderer/features/tasks/task-create';
import { applyTaskFilters, emptySelection, filterOptions } from '../../src/renderer/features/tasks/task-filters';
import { isDraft, ownerProfileOf, taskTitle } from '../../src/renderer/features/tasks/task-view';

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, enableCustomFonts: false, children: React.createElement(ThemeScope, { appearance: 'dark', children: node }) }));
}
const owner = { name: 'Task owner', transport: 'herdr-visible' as const, session: 's', pane: 'p' };
const NOW = Date.parse('2026-10-19T12:00:00Z');
const make = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: `任务 ${id}`, instruction: 'x', owner, status: 'queued', progress: 0, createdAt: '2026-10-19T11:00:00Z', updatedAt: '2026-10-19T11:30:00Z', events: [], artifacts: [], ...extra });
const pending = (extra: Partial<Task> = {}) => make('0123456789abcdef', { title: PENDING_TASK_TITLE, ...extra });
const dispatch = { owner: 'claude_owner', worker: 'claude_worker', engine: 'claude', model: 'sonnet', effort: 'high', execution: 'real' as const, maxParallel: 2 };

test('a task the parent Agent has not named shows the first meaningful line of its goal', () => {
  assert.equal(taskTitle(pending({ instruction: '修复登录页\n细节在下面' })), '修复登录页');
  assert.equal(taskTitle(pending({ instruction: '\n  \n   整理文档  \n其余' })), '整理文档');
  assert.equal(taskTitle(pending({ instruction: '# 重构任务面板' })), '重构任务面板');
  assert.equal(taskTitle(pending({ instruction: '- [ ] 补测试'.replace('[ ] ', '') })), '补测试');
  assert.equal(taskTitle(pending({ instruction: '> * 引用里的目标' })), '引用里的目标');
  assert.equal(taskTitle(pending({ instruction: '## 1. 带编号的标题' })), '带编号的标题');
  assert.equal(taskTitle(pending({ instruction: '---\n```\n# 真正的目标' })), '真正的目标');
  assert.equal(taskTitle(pending({ instruction: '**加粗开头** 保持原样' })), '**加粗开头** 保持原样');
});

test('long goal lines are cut at 60 characters with an ellipsis; exactly 60 stay whole', () => {
  const exact = '字'.repeat(60);
  assert.equal(taskTitle(pending({ instruction: exact })), exact);
  assert.equal(taskTitle(pending({ instruction: '字'.repeat(61) })), `${exact}…`);
  assert.equal(taskTitle(pending({ instruction: '# ' + 'a'.repeat(80) })), `${'a'.repeat(60)}…`);
});

test('an empty goal falls back to 任务 plus the first eight characters of the id; named tasks keep their title', () => {
  assert.equal(taskTitle(pending({ instruction: '' })), '任务 01234567');
  assert.equal(taskTitle(pending({ instruction: ' \n\t\n# \n' })), '任务 01234567');
  assert.equal(taskTitle(make('abc', { title: '正式标题', instruction: '别的内容' })), '正式标题');
});

test('the board card, detail heading, archive row and sub-task list all use the display title', () => {
  const draft = pending({ instruction: '# 先写目标首行\n更多细节' });
  assert.match(markup(React.createElement(TaskBoard, { tasks: [draft], loading: false, onSelect: () => {}, now: NOW })), /先写目标首行/);
  assert.doesNotMatch(markup(React.createElement(TaskBoard, { tasks: [draft], loading: false, onSelect: () => {}, now: NOW })), new RegExp(PENDING_TASK_TITLE));
  const detail = markup(React.createElement(TaskDetail, { task: draft, busy: false, onStart: () => {}, onCancel: () => {}, action: async () => true }));
  assert.match(detail, /先写目标首行/);
  assert.doesNotMatch(detail, new RegExp(PENDING_TASK_TITLE));
  const titleColumn = archiveColumns().find(column => column.key === 'title')!;
  const cell = markup((titleColumn.render as (value: unknown, task: Task, index: number) => React.ReactNode)(undefined, draft, 0));
  assert.match(cell, /title="先写目标首行"/);
  const root = make('root', { executionRole: 'owner', status: 'running', title: '根任务' });
  const named = make('c1', { parentTaskId: 'root', title: '正式子任务' });
  const unnamed = make('c2', { parentTaskId: 'root', title: PENDING_TASK_TITLE, instruction: '子任务目标' });
  const list = markup(React.createElement(TaskAgents, { task: root, tasks: [root, named, unnamed] }));
  assert.match(list, /正式子任务/);
  assert.match(list, /子任务目标/);
  assert.match(markup(React.createElement(TaskAgents, { task: unnamed, tasks: [make('root', { title: PENDING_TASK_TITLE, instruction: '父任务目标', executionRole: 'owner' }), unnamed] })), /父任务目标/);
});

test('only an unstarted root task is a draft', () => {
  assert.equal(isDraft(make('d')), true);
  assert.equal(isDraft(make('c', { parentTaskId: 'root' })), false);
  assert.equal(isDraft(make('s', { scheduled: true })), false);
  assert.equal(isDraft(make('p', { packageId: 'pkg' })), false);
  assert.equal(isDraft(make('x', { dispatch })), false);
  assert.equal(isDraft(make('h', { ownerHost: { kind: 'herdr', session: 's', workspaceId: 'w', paneId: 'p', agentName: 'a', launchedAt: '2026-10-19T11:00:00Z' } })), false);
  assert.equal(isDraft(make('o', { executionRole: 'owner' })), false);
  for (const status of ['running', 'cancelling', 'completed', 'failed', 'cancelled'] as const) assert.equal(isDraft(make(status, { status })), false);
});

test('a draft reads 草稿 in the neutral tone, and the status filter can select it', () => {
  assert.equal(displayStatus(make('d')), 'draft');
  assert.equal(displayStatus(make('s', { scheduled: true })), 'scheduled');
  assert.equal(displayStatus(make('q', { executionRole: 'owner' })), 'queued');
  assert.equal(DISPLAY_LABELS.draft, '草稿');
  assert.equal(DISPLAY_TONES.draft, DISPLAY_TONES.queued);
  assert.ok(DISPLAY_STATUSES.includes('draft'));
  // The status facet reads the board's rows (sub agent tasks and drafts); owner roots answer from the 父 Agent row instead.
  const tasks = [make('d'), make('c', { parentTaskId: 'root', status: 'queued' })];
  const options = filterOptions(tasks, 'status', { ...emptySelection(), time: 'all' }, NOW);
  assert.deepEqual(options.map(option => [option.value, option.label, option.count]), [['draft', '草稿', 1], ['queued', '待执行', 1]]);
  assert.deepEqual(applyTaskFilters(tasks, { ...emptySelection(), time: 'all', status: ['draft'] }, undefined, NOW).map(task => task.id), ['d']);
  const board = markup(React.createElement(TaskBoard, { tasks, loading: false, onSelect: () => {}, now: NOW }));
  assert.match(board, />草稿</);
});

const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
const composer = (props: Partial<React.ComponentProps<typeof TaskComposer>> & { draft: React.ComponentProps<typeof TaskComposer>['draft'] }) =>
  markup(React.createElement(TaskComposer, { disabled: false, onDraft: () => {}, onCreate: async () => true, ...props }));

test('存为草稿 needs only the goal and a parent Agent; 创建并开始 still needs the directory', () => {
  const goalOnly = buttons(composer({ draft: { goal: '写个草稿', workspace: '', profile: 'claude_owner' } }));
  assert.doesNotMatch(goalOnly.find(button => button.includes('存为草稿')) ?? '', /disabled/);
  assert.match(goalOnly.find(button => button.includes('创建并开始')) ?? '', /disabled/);
  const full = buttons(composer({ draft: { goal: '写个草稿', workspace: '/w', profile: 'claude_owner' } }));
  assert.doesNotMatch(full.find(button => button.includes('创建并开始')) ?? '', /disabled/);
  const relative = buttons(composer({ draft: { goal: 'g', workspace: 'docs', profile: 'p' } }));
  assert.match(relative.find(button => button.includes('存为草稿')) ?? '', /disabled/);
  const noProfile = buttons(composer({ draft: { goal: 'g', workspace: '', profile: '' } }));
  assert.match(noProfile.find(button => button.includes('存为草稿')) ?? '', /disabled/);
  const html = composer({ draft: { goal: '', workspace: '', profile: '' } });
  assert.match(html, /稍后可编辑|之后可在任务详情中编辑/);
  assert.doesNotMatch(html, /仅创建/);
});

test('the composer request leaves out a blank directory and blank criteria; a filled relative path is still an error', () => {
  assert.deepEqual(composerInput({ goal: ' 目标 ', workspace: '  ', profile: 'p', criteria: '' }), { goal: '目标', ownerProfileId: 'p' });
  assert.deepEqual(composerInput({ goal: 'g', workspace: ' /w ', profile: 'p', criteria: 'a\n\n b ' }), { goal: 'g', workspace: '/w', ownerProfileId: 'p', acceptanceCriteria: ['a', 'b'] });
  assert.equal('workspace' in composerInput({ goal: 'g', workspace: '', profile: 'p' }), false);
  assert.equal(workspacePathError('', false), '');
  assert.match(workspacePathError('docs', false), /绝对路径/);
  assert.match(workspacePathError('.', false), /绝对路径/);
  assert.equal(workspacePathError('/w', false), '');
  assert.equal(workspacePathError(''), '选择目标项目目录。');
});

const stored = make('d1', { instruction: '原来的目标', acceptanceCriteria: ['第一条', '第二条'], workspace: '/home/me/proj', revision: 7 });

test('edit mode prefills the stored values and offers 保存 / 保存并开始', () => {
  const fields = draftFields(stored, 'claude_owner');
  assert.deepEqual(fields, { goal: '原来的目标', criteria: '第一条\n第二条', workspace: '/home/me/proj', profile: 'claude_owner' });
  assert.deepEqual(draftFields(make('d2', { instruction: 'g' })), { goal: 'g', criteria: '', workspace: '', profile: '' });
  const html = composer({ mode: 'edit', draft: fields });
  assert.match(html, /原来的目标/);
  assert.match(html, /第一条\n第二条/);
  assert.match(html, /\/home\/me\/proj/);
  const labels = buttons(html);
  assert.ok(labels.some(button => button.includes('保存并开始') && button.includes('type="submit"')));
  assert.ok(labels.some(button => />保存</.test(button) && button.includes('type="button"')));
  assert.ok(labels.every(button => !button.includes('存为草稿') && !button.includes('创建并开始')));
  assert.doesNotMatch(html, /仅创建/);
  const noDirectory = buttons(composer({ mode: 'edit', draft: { ...fields, workspace: '' } }));
  assert.doesNotMatch(noDirectory.find(button => />保存</.test(button)) ?? '', /disabled/);
  assert.match(noDirectory.find(button => button.includes('保存并开始')) ?? '', /disabled/);
  const unknownProfile = buttons(composer({ mode: 'edit', draft: { ...fields, profile: '' } }));
  assert.match(unknownProfile.find(button => />保存</.test(button)) ?? '', /disabled/);
});

test('tasks.update arguments follow the contract: revision, null directory, empty criteria, profile only when changed', () => {
  const input = composerInput(draftFields(stored, 'claude_owner'));
  assert.deepEqual(taskUpdateArgs(stored, input, 'claude_owner'), { taskId: 'd1', expectedRevision: 7, goal: '原来的目标', workspace: '/home/me/proj', acceptanceCriteria: ['第一条', '第二条'] });
  const cleared = taskUpdateArgs(stored, composerInput({ goal: '新目标', workspace: '', profile: 'claude_owner', criteria: '' }), 'claude_owner');
  assert.equal(cleared.workspace, null);
  assert.deepEqual(cleared.acceptanceCriteria, []);
  assert.equal('ownerProfileId' in cleared, false);
  assert.equal(taskUpdateArgs(stored, composerInput({ goal: 'g', workspace: '/w', profile: 'codex_owner' }), 'claude_owner').ownerProfileId, 'codex_owner');
  assert.equal(taskUpdateArgs(stored, composerInput({ goal: 'g', workspace: '/w', profile: 'codex_owner' }), '').ownerProfileId, 'codex_owner');
});

test('the owner profile of a draft comes from the known owner instances, blank when unknown', () => {
  const owners = [{ id: 'inst-1', profileId: 'claude_owner' }, { id: 'inst-2', profileId: 'codex_owner' }];
  assert.equal(ownerProfileOf({ ownerId: 'inst-2' }, owners), 'codex_owner');
  assert.equal(ownerProfileOf({ ownerId: 'gone' }, owners), '');
  assert.equal(ownerProfileOf({}, owners), '');
});

test('saving a draft only updates it; 保存并开始 then starts it, and a failed start never loses the saved draft', async () => {
  const calls: string[] = [];
  const api = (failStart = false, failUpdate = false) => ({
    update: async (args: Record<string, unknown>) => { calls.push(`update:${args.taskId}`); if (failUpdate) throw new Error('CONFLICT: revision'); },
    start: async (id: string) => { calls.push(`start:${id}`); if (failStart) throw new Error('boom'); },
    startFailed: (id: string) => { calls.push(`failed:${id}`); },
  });
  await updateTask({ taskId: 'd1' }, false, api());
  assert.deepEqual(calls.splice(0), ['update:d1']);
  await updateTask({ taskId: 'd1' }, true, api());
  assert.deepEqual(calls.splice(0), ['update:d1', 'start:d1']);
  await updateTask({ taskId: 'd1' }, true, api(true));
  assert.deepEqual(calls.splice(0), ['update:d1', 'start:d1', 'failed:d1']);
  await assert.rejects(updateTask({ taskId: 'd1' }, true, api(false, true)), /CONFLICT/);
  assert.deepEqual(calls.splice(0), ['update:d1']);
});

const detail = (task: Task, onEdit: ((id: string) => void) | null = () => {}) => markup(React.createElement(TaskDetail, { task, busy: false, onStart: () => {}, onEdit: onEdit ?? undefined, onCancel: () => {}, action: async () => true }));
const buttonOf = (html: string, label: string) => buttons(html).find(button => button.includes(label)) ?? '';

test('a draft offers 编辑 beside 开始执行; other tasks have no edit entry', () => {
  const html = detail(stored);
  assert.ok(buttonOf(html, '编辑'));
  assert.doesNotMatch(buttonOf(html, '开始执行'), /disabled/);
  assert.doesNotMatch(html, /先编辑补充目标项目目录/);
  for (const other of [make('r', { status: 'running' }), make('s', { scheduled: true }), make('c', { parentTaskId: 'root' }), make('o', { executionRole: 'owner', status: 'completed' }), make('p', { packageId: 'pkg' }), make('x', { dispatch })]) {
    assert.equal(buttonOf(detail(other), '编辑'), '', other.id);
  }
  assert.equal(buttonOf(detail(stored, null), '编辑'), '');
});

test('a draft without a directory cannot start and says why', () => {
  const html = detail({ ...stored, workspace: undefined });
  assert.match(buttonOf(html, '开始执行'), /disabled/);
  assert.match(html, /先编辑补充目标项目目录/);
  assert.ok(buttonOf(html, '编辑'));
  assert.match(buttonOf(detail({ ...stored, workspace: '   ' }), '开始执行'), /disabled/);
});

const picker = (value: string, allowClear?: boolean, disabled = false) => markup(React.createElement(WorkspacePicker, { value, disabled, ...(allowClear === undefined ? {} : { allowClear }), onChange: () => {} }));
const clearButton = (html: string) => buttons(html).find(button => button.includes('清除目标项目目录'));

test('a filled directory with allowClear gains a 清除目标项目目录 entry; empty or opt-out has none and disabled follows', () => {
  assert.match(clearButton(picker('/home/me/proj', true)) ?? '', /清除目标项目目录/);
  assert.equal(clearButton(picker('', true)), undefined);
  assert.equal(clearButton(picker('/home/me/proj')), undefined);
  assert.equal(clearButton(picker('', false)), undefined);
  assert.match(clearButton(picker('/home/me/proj', true, true)) ?? '', /disabled/);
  assert.doesNotMatch(clearButton(picker('/home/me/proj', true)) ?? '', /disabled/);
});

test('clearing the directory empties the field, so the next save sends workspace null', () => {
  const seen: string[] = [];
  clearWorkspace(path => seen.push(path));
  assert.deepEqual(seen, ['']);
  assert.equal(taskUpdateArgs(stored, composerInput({ goal: 'g', workspace: '', profile: 'claude_owner' }), 'claude_owner').workspace, null);
});

test('clearing the directory moves focus back to the 选择目标项目目录 button, never to body', () => {
  // Mirrors the picker's clear handler: onChange('') first, then focus the directory button by ref.
  const seen: string[] = [];
  const focused: string[] = [];
  const directoryButtonRef = { current: { focus: () => focused.push('directory') } as unknown as HTMLButtonElement };
  const clearHandler = () => { clearWorkspace(path => seen.push(path)); focusDirectoryPicker(directoryButtonRef.current); };
  clearHandler();
  assert.deepEqual(seen, ['']);
  assert.deepEqual(focused, ['directory']);
  focusDirectoryPicker(null);
  assert.deepEqual(focused, ['directory']);
});

test('both composer modes offer clearing the directory', () => {
  const filled = { goal: 'g', workspace: '/home/me/proj', profile: 'claude_owner', criteria: '' };
  assert.ok(clearButton(composer({ draft: filled })));
  assert.ok(clearButton(composer({ mode: 'edit', draft: filled })));
  assert.equal(clearButton(composer({ draft: { ...filled, workspace: '' } })), undefined);
  assert.equal(clearButton(composer({ mode: 'edit', draft: { ...filled, workspace: '' } })), undefined);
});

test('the edit dialog saves with the revision read when it opened, not the live one', () => {
  const opened = draftEdit(stored, 'claude_owner');
  assert.equal(opened.expectedRevision, 7);
  assert.deepEqual(opened.fields, draftFields(stored, 'claude_owner'));
  assert.equal(draftEdit(make('d3', { revision: undefined })).expectedRevision, 0);
  // The task moved on elsewhere after the dialog opened: the request still carries the opened revision.
  const changed = { ...stored, revision: 9, instruction: '别处改过的目标' };
  const args = taskUpdateArgs({ id: changed.id, revision: opened.expectedRevision }, composerInput(opened.fields), 'claude_owner');
  assert.equal(args.expectedRevision, 7);
  // Saving against the live revision would silently overwrite that other edit instead.
  assert.equal(taskUpdateArgs(changed, composerInput(opened.fields), 'claude_owner').expectedRevision, 9);
});

test('the edit composer prefills from the fields captured when the dialog opened', () => {
  const html = composer({ mode: 'edit', draft: draftEdit(stored, 'claude_owner').fields });
  assert.match(html, /原来的目标/);
  assert.match(html, /第一条\n第二条/);
  assert.match(html, /\/home\/me\/proj/);
});

test('a failed draft save reports one 保存草稿失败 overlay with the mapped Chinese text; success stays silent', async t => {
  const calls: ToastOptions[] = [];
  t.mock.method(toast, 'error', (options: ToastOptions) => { calls.push(options); return { id: 'draft', update() {}, close() {} }; });
  const failing = (error: Error) => updateTask({ taskId: 'd1' }, false, { update: async () => { throw error; }, start: async () => {}, startFailed: () => {} }).catch(notifySaveDraftFailure);
  await failing(new Error('REVISION_CONFLICT: Current revision is 9'));
  await failing(new Error('INVALID_STATE: Only an unstarted root task draft can be edited'));
  await failing(new Error('VALIDATION: 目标太长'));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.title === '保存草稿失败' && call.placement === 'bottom-right'));
  assert.equal(calls[0].description, '草稿已在其他地方更新。关闭弹窗后重新打开编辑，以免覆盖别人的修改。');
  assert.equal(calls[1].description, '任务已开始或不再是草稿，不能再编辑。');
  assert.equal(calls[2].description, '目标太长');
  calls.splice(0);
  await updateTask({ taskId: 'd1' }, false, { update: async () => {}, start: async () => {}, startFailed: () => {} });
  assert.equal(calls.length, 0);
});
