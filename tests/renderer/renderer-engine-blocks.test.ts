import test from 'node:test';
import assert from 'node:assert/strict';
import { engineBlockText } from '../../src/renderer/policy/worker-resume';
import type { Block } from '../../src/shared/contracts/policy';
const NOW=new Date(2030,0,1,14,0).getTime();
const block=(patch:Partial<Block>={}):Block=>({engine:'codex',reason:'A long manual reason '+ 'details '.repeat(100),since:new Date(NOW).toISOString(),...patch});
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
