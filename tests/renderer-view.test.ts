import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import type { Task } from '../src/shared/types';
import { TASK_COLUMNS, filterTasks, isActive, nextTab, reviewLabel, reviewStatus, taskColumn } from '../src/renderer/task-view';
import { TaskBoard } from '../src/renderer/components/TaskBoard';
import { TaskDetail } from '../src/renderer/components/TaskDetail';
import { workspacePathError } from '../src/renderer/components/TaskComposer';
import { ArtifactsPanel } from '../src/renderer/components/ArtifactsPanel';
import { NamedInputNumber, NamedSelect, NamedSwitch } from '../src/renderer/components/NamedControls';
import { Form, useForm } from '@lobehub/ui/base-ui/form';
function markup(node: React.ReactNode) {
  const props = { motion, children: React.createElement(ThemeProvider, { themeMode: 'dark', enableCustomFonts: false, children: node }) } as React.ComponentProps<typeof ConfigProvider>;
  return renderToStaticMarkup(React.createElement(ConfigProvider, props));
}
const task:Task={id:'t',title:'中文任务',instruction:'Do work',owner:{name:'Owner',transport:'herdr-visible',session:'main',pane:'1'},status:'completed',progress:100,createdAt:'2026-10-18T00:00:00Z',updatedAt:'2026-10-18T00:00:00Z',events:[],artifacts:[]};
test('execution completion is distinct from acceptance',()=>{assert.equal(reviewStatus(task),'pending');assert.equal(reviewLabel(task),'待验收');assert.equal(reviewLabel({...task,reviewState:'accepted'}),'已通过');assert.equal(reviewLabel({...task,status:'running'}),'尚未进入验收');});
test('filters preserve pending review and support Chinese and owner search',()=>{const items=[task,{...task,id:'accepted',reviewState:'accepted' as const},{...task,id:'running',status:'running' as const}];assert.equal(filterTasks(items,'review','中文').length,1);assert.equal(filterTasks(items,'all','OWNER').length,3);assert.equal(filterTasks(items,'active','').length,1);assert.equal(filterTasks(items,'closed','').length,2);assert.equal(isActive({...task,status:'cancelling'}),true);});
test('every task lands in exactly one kanban column by where it is in its lifecycle',()=>{
  assert.deepEqual(TASK_COLUMNS.map(column=>column.key),['queued','running','review','closed']);
  assert.equal(taskColumn({...task,status:'queued'}),'queued');
  assert.equal(taskColumn({...task,status:'running'}),'running');
  assert.equal(taskColumn({...task,status:'cancelling'}),'running');
  assert.equal(taskColumn(task),'review');
  assert.equal(taskColumn({...task,reviewState:'accepted'}),'closed');
  assert.equal(taskColumn({...task,reviewState:'rejected'}),'closed');
  assert.equal(taskColumn({...task,status:'failed'}),'closed');
  assert.equal(taskColumn({...task,status:'cancelled'}),'closed');
});
test('board lays tasks out in columns with counts',()=>{const html=markup(React.createElement(TaskBoard,{tasks:[task,{...task,id:'q',title:'排队任务',status:'queued' as const}],loading:false,onSelect:()=>{}}));assert.match(html,/待执行/);assert.match(html,/待验收/);assert.match(html,/排队任务/);assert.match(html,/中文任务/);});
test('board has distinct loading and empty states',()=>{const props={tasks:[],onSelect:()=>{}};assert.match(markup(React.createElement(TaskBoard,{...props,loading:true})),/正在加载/);assert.match(markup(React.createElement(TaskBoard,{...props,loading:false})),/还没有任务/);});
test('task view separates execution and review, escapes instruction',()=>{const html=markup(React.createElement(TaskDetail,{task:{...task,instruction:'<script>bad()</script>'},busy:false,onStart:()=>{},onCancel:()=>{},action:async()=>true}));assert.match(html,/执行完成/);assert.match(html,/待验收/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.doesNotMatch(html,/开始 mock 执行/);assert.doesNotMatch(html,/真实 provider 未连接/);assert.doesNotMatch(html,/本地 mock/);assert.match(html,/Owner · 更新于/);assert.doesNotMatch(html,/执行进度/);assert.doesNotMatch(html,/role="progressbar"/);assert.match(html,/id="task-tab-events"/);assert.match(html,/aria-controls="task-panel-events"/);assert.match(html,/aria-labelledby="task-tab-events"/);assert.match(html,/tabindex="0"/);assert.match(html,/tabindex="-1"/);});
test('task workspace must be an absolute directory',()=>{assert.equal(workspacePathError(''), '填写目标项目的绝对路径。');assert.match(workspacePathError('.'),/绝对路径/);assert.match(workspacePathError('docs'),/绝对路径/);assert.equal(workspacePathError('/home/user/project'),'');});
test('task tabs move by arrow, home and end',()=>{const keys=['events','artifacts','review'];assert.equal(nextTab(keys,'events','ArrowRight'),'artifacts');assert.equal(nextTab(keys,'events','ArrowLeft'),'review');assert.equal(nextTab(keys,'artifacts','Home'),'events');assert.equal(nextTab(keys,'artifacts','End'),'review');assert.equal(nextTab(keys,'events','Enter'),undefined);});
test('artifact preview renders hostile markup as text only',()=>{const html=markup(React.createElement(ArtifactsPanel,{artifacts:[{id:'a',name:'test.html',mediaType:'text/plain',createdAt:task.createdAt,content:'<img src=x onerror=alert(1)>'}]}));assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);});
test('cancelling task disables repeat cancellation',()=>{const html=markup(React.createElement(TaskDetail,{task:{...task,status:'cancelling'},busy:false,onStart:()=>{},onCancel:()=>{},action:async()=>true}));assert.match(html,/<button[^>]*disabled=""[^>]*>[\s\S]*正在停止/);});
test('installed Lobe controls associate names with the actual input and buttons', () => {
  const html = markup(React.createElement(React.Fragment, null,
    React.createElement(NamedInputNumber, { 'aria-label': '优先权重', value: 100 }),
    React.createElement(NamedSelect, { 'aria-label': '负责人', options: [{ value: 'a', label: 'A' }], value: 'a' }),
    React.createElement(NamedSwitch, { 'aria-label': '自动审查', checked: true })));
  const labels = [...html.matchAll(/<label[^>]*for="([^"]+)"[^>]*>([^<]+)<\/label>/g)];
  assert.equal(labels.length, 3);
  const targets = labels.map(([, id]) => [...html.matchAll(/<(input|button|div)\b[^>]*>/g)].filter(([tag]) => tag.includes(`id="${id}"`)));
  assert.deepEqual(targets.map(matches => matches.map(([, tag]) => tag)), [['input'], ['button'], ['button']]);
  assert.deepEqual(labels.map(([, , name]) => name), ['优先权重', '负责人', '自动审查']);
});
function NamedFormFixture() {
  const form = useForm();
  return React.createElement(Form, { form },
    React.createElement(Form.Field, { label: '负责人' }, React.createElement(NamedSelect, { id: 'named-owner', 'aria-label': '负责人', options: [], value: undefined })),
    React.createElement(Form.Field, { label: '等待分钟' }, React.createElement(NamedInputNumber, { id: 'named-wait', 'aria-label': '等待分钟', value: 1 })));
}
test('visible Form labels link to the named select trigger and number input once', () => {
  const html = markup(React.createElement(NamedFormFixture));
  assert.equal([...html.matchAll(/<label[^>]*for="named-owner"/g)].length, 1);
  assert.equal([...html.matchAll(/<label[^>]*for="named-wait"/g)].length, 1);
  assert.match(html, /<button[^>]*id="named-owner"[^>]*role="combobox"/);
  assert.match(html, /<input[^>]*id="named-wait"/);
});
test('queued task shows the current queue reason without inventing capacity wait', () => {
  for (const [code, label] of Object.entries({ policy_blocked: '当前策略阻止派发', frozen_route_changed: '已冻结路由发生变化', workspace_changed: '工作目录发生变化', launch_blocked: '执行启动受阻' })) {
    const html = markup(React.createElement(TaskDetail, { task: { ...task, status: 'queued', scheduled: true, queueReason: { code: code as NonNullable<Task['queueReason']>['code'], message: 'specific reason' } }, busy: false, onStart: () => {}, onCancel: () => {}, action: async () => true }));
    assert.match(html, new RegExp(label));
    assert.match(html, /specific reason/);
    assert.doesNotMatch(html, /等待执行槽位/);
  }
});
