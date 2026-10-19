import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { toast, type ToastOptions } from '@lobehub/ui/base-ui';
import { motion } from 'motion/react';
import { ConnectionNotice } from '../src/renderer/components/ConnectionNotice';
import { ContinuationDialog } from '../src/renderer/components/OwnerInspector';
import { PolicyHeader } from '../src/renderer/components/PolicyHeader';
import { SettingsPage } from '../src/renderer/pages/SettingsPage';
import type { PolicyDraft } from '../src/renderer/usePolicyDraft';
import { notifyError } from '../src/renderer/notify';

function markup(node: React.ReactNode) {
  return renderToStaticMarkup(React.createElement(ConfigProvider, { motion, children: React.createElement(ThemeProvider, { themeMode:'dark',enableCustomFonts:false,children:node }) }));
}

test('reconnect content shows one status line and keeps attempt count in a tooltip, then success', () => {
  const html=markup(React.createElement(ConnectionNotice,{state:{status:'reconnecting',attempt:3}}));
  assert.match(html,/正在重新连接…/);
  assert.match(html,/data-base-ui-tooltip-trigger/);
  assert.doesNotMatch(html.slice(html.indexOf('<div role="status"')),/重试次数|立即重试|<button/);
  assert.match(markup(React.createElement(ConnectionNotice,{state:{status:'connected',attempt:0}})),/已重新连接/);
});

test('failed policy loads and modal operations add no error content to page flow', () => {
  const policy={loading:false,busy:false,dirty:false,loadError:'HTTP_403: 禁止访问',saveError:'CONFLICT: 已变化',conflict:true,issues:[]} as unknown as PolicyDraft;
  const html=markup(React.createElement(React.Fragment,null,
    React.createElement(PolicyHeader,{title:'配置',description:'编辑配置',policy}),
    React.createElement(SettingsPage,{policy}),
    React.createElement(ContinuationDialog,{profiles:[],sending:false,failure:'NETWORK: 断线',onChange:()=>{},onRetry:()=>{}})));
  assert.doesNotMatch(html,/HTTP_403|CONFLICT|NETWORK|role="alert"|禁止访问|断线/);
});

test('notifier emits an overlay with Chinese title, details and secondary code, deduped across contexts', t => {
  const calls: ToastOptions[]=[];
  t.mock.method(toast,'error',(options: ToastOptions)=>{calls.push(options);return {id:'test',close:()=>{},update:()=>{}};});
  notifyError(new Error('VALIDATION: 配置无效'),'保存失败');
  notifyError('Error: VALIDATION: 配置无效','读取失败');
  notifyError(new Error('TIMEOUT: 慢响应'));
  assert.equal(calls.length,1);assert.equal(calls[0].placement,'bottom-right');assert.equal(calls[0].title,'保存失败');
  assert.match(renderToStaticMarkup(calls[0].description),/配置无效/);
  assert.doesNotMatch(renderToStaticMarkup(calls[0].description), /VALIDATION/);
});
