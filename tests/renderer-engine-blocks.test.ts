import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { BlockList, engineBlockText } from '../src/renderer/pages/EnginesPage';
import type { Block } from '../src/shared/contracts/policy';
const NOW=new Date(2030,0,1,14,0).getTime();
const block=(patch:Partial<Block>={}):Block=>({engine:'codex',reason:'A long manual reason '+ 'details '.repeat(100),since:new Date(NOW).toISOString(),...patch});
function markup(node:React.ReactNode){return renderToStaticMarkup(React.createElement(ConfigProvider,{motion,children:React.createElement(ThemeProvider,{themeMode:'dark',enableCustomFonts:false,children:node})}));}
test('block categories separate vendor rate limits, quotas, stall levels and manual pauses',()=>{
 for(const [by,reason,category] of [['weaver-vendor-limit','限流：Rate limit exceeded','限流'],['weaver-vendor-limit','额度耗尽：FreeUsageLimitError','额度耗尽'],['weaver-quota:grok','empty','额度耗尽'],['manual','paused','手动暂停'],['weaver-stall','silent','卡住惩罚 第 2 级']])assert.equal(engineBlockText(block({by,reason}),NOW,{level:2} as any).category,category);
});
test('release uses local 24h time, includes a date tomorrow and waits for a stall recovery probe',()=>{
 assert.equal(engineBlockText(block({release_at:new Date(2030,0,1,14,32).toISOString()}),NOW).release,'14:32 自动解除');
 assert.match(engineBlockText(block({release_at:new Date(2030,0,2,14,32).toISOString()}),NOW).release,/^01-02 14:32 自动解除$/);
 assert.equal(engineBlockText(block(),NOW).release,'需手动恢复');
 assert.equal(engineBlockText(block({by:'weaver-stall'}),NOW,{level:1,blockedUntil:new Date(NOW-1).toISOString()} as any).release,'探测通过后解除');
 assert.equal(engineBlockText(block({by:'weaver-stall'}),NOW,{level:3,blockedUntil:null} as any).release,'需手动恢复');
});
test('each active block has one compact row and a resume action, including overdue stall probes',()=>{
 const blocks=[block({by:'manual'}),block({engine:'pi',by:'weaver-stall',release_at:new Date(NOW-1).toISOString()})];
 const html=markup(React.createElement(BlockList,{blocks,now:NOW,disabled:false,state:{level:2} as any,onRemove:()=>{}}));
 assert.equal((html.match(/aria-label="恢复派发"/g)??[]).length,2);
 assert.equal((html.match(/data-engine-block="/g)??[]).length,2);
 assert.match(html,/手动暂停/);assert.match(html,/卡住惩罚 第 2 级/);assert.match(html,/探测通过后解除/);
 assert.ok(engineBlockText(block(),NOW).reason.length<=120);
});
