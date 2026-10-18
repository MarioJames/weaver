import assert from 'node:assert/strict';
import test from 'node:test';
import type { WeaverAPI } from '../src/shared/types';
import type { CommandRequest } from '../src/shared/commands';
import { command } from '../src/renderer/commands';
function bridge(fn: WeaverAPI['command']) { Object.defineProperty(globalThis,'window',{configurable:true,value:{weaver:{command:fn}}}); }
test('renderer sends versioned command and UUID only for mutations',async()=>{const seen:CommandRequest[]=[];bridge(async request=>{seen.push(request);return {apiVersion:'weaver.v1',ok:true,data:{saved:true}};});try {assert.deepEqual(await command('tasks.results',{taskId:'t'}),{saved:true});await command('reviews.submit',{taskId:'t'},true);assert.equal(seen[0].apiVersion,'weaver.v1');assert.equal(seen[0].commandId,undefined);assert.match(seen[1].commandId!,/^[0-9a-f-]{36}$/);}finally{Reflect.deleteProperty(globalThis,'window');}});
test('renderer surfaces explicit control plane errors',async()=>{bridge(async()=>({apiVersion:'weaver.v1',ok:false,error:{code:'REVISION_CONFLICT',message:'Refresh before reviewing',retryable:true}}));try{await assert.rejects(command('reviews.submit',{},true),/REVISION_CONFLICT: Refresh before reviewing/);}finally{Reflect.deleteProperty(globalThis,'window');}});
test('renderer reports unavailable command bridge without mutation',async()=>{Object.defineProperty(globalThis,'window',{configurable:true,value:{}});try{await assert.rejects(command('tasks.results',{}),/当前桌面桥不支持统一接口/);}finally{Reflect.deleteProperty(globalThis,'window');}});
