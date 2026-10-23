import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { IM_ENGINE_KINDS } from '../../src/shared/im-engines';
import { ImService } from '../../src/main/im/service';
import type { ImChannelFactory, ImChannelHandlers } from '../../src/main/im/channel';
import { createParentAgent, parentError, type ParentAgentSession, type ParentAgentFactory, type ParentAgentInput } from '../../src/main/im/parent-agent';
import type { PolicySnapshot } from '../../src/shared/contracts/policy';
import type { NormalizedMessage, CardActionEvent } from '@larksuite/channel';
// One isolated root per run under the OS temp dir (respecting TMPDIR); removed again after the suite.
const ROOT = await mkdtemp(join(tmpdir(), 'weaver-im-service-'));
test.after(async () => { await rm(ROOT, { recursive: true, force: true }); });
const tick = async () => { for (let n=0;n<12;n++) await new Promise<void>(r=>setImmediate(r)); };
function deferred<T>() { let resolve!: (v:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; }
function policy(): PolicySnapshot { return { revision:0, config:{version:1,engines:{codex:{enabled:true,kind:'codex'}},owners:{main:{enabled:true,engine:'codex',model:'gpt-test',effort:'medium',workers:[],max_parallel:1}},workers:{},herdr:{max_wait_minutes:30}}, blocks:[],activeBlocks:[],owners:{},workers:{},execution:'disabled' }; }
function fixture(parent?: ParentAgentFactory, connect?:()=>Promise<void>) {
 let handlers!: ImChannelHandlers; const chunks:string[]=[]; const cards:{id:string;card:any}[]=[]; const notices:string[]=[]; let closed=0; let seq=0; let updateFailure=false;
 const factory: ImChannelFactory=(_c,h)=>{handlers=h;return { connect:connect??(async()=>{}),close:async()=>{closed++;},state:()=> 'connected',send:async(_to,text)=>{notices.push(text);},retireCard:async()=>{},stream:async(_to,producer,delivery)=>{const id=`om_bot${++seq}`;await producer({messageId:id,append:async text=>{assert.ok(delivery.valid());chunks.push(text);},setContent:async text=>{chunks.push(text);}});return id;},updateCard:async(id,card,delivery)=>{assert.ok(delivery.valid());if(updateFailure)throw new Error('CANARY_SECRET');cards.push({id,card});}};};
 return {factory,failUpdate:()=>{updateFailure=true;},get handlers(){return handlers;},chunks,cards,notices,get closed(){return closed;}};
}
function message(id:string,user='ou_a',chat='oc_a',text='你好',now=Date.now()): NormalizedMessage {
 return {messageId:`om_${id}`,chatId:chat,chatType:'p2p',senderId:user,senderType:'user',content:text,rawContentType:'text',resources:[],mentions:[],mentionAll:false,mentionedBot:false,createTime:now,raw:{sender:{sender_type:'user',sender_id:{open_id:user}},message:{message_id:`om_${id}`,chat_id:chat,chat_type:'p2p',message_type:'text',create_time:String(now),content:JSON.stringify({text})}}};
}
async function setup(t:any,parent:ParentAgentFactory,options:{now?:()=>number;connect?:()=>Promise<void>}={}) {
 const dir=await mkdtemp(join(ROOT, 'service-'));const f=fixture(parent,options.connect); const live=policy(); const service=new ImService({dataDir:dir,policy:()=>live,parentFactory:parent,channelFactory:f.factory,now:options.now});
 t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
 const config={enabled:true,appId:'cli_test',appSecret:'CANARY_SECRET',allowedOpenIds:['ou_a','ou_b'],engine:'codex',model:'gpt-test',effort:'medium',workspaces:[dir],idleTimeoutMinutes: 1, ownerProfileId: ''};
 await service.save({expectedRevision:0,config});await tick();return {dir,f,service,config,live};
}
test('授权、两条快速原始消息、串行复用、跨用户独立 epoch、持久去重',async t=>{
 const calls:{input:ParentAgentInput;texts:string[];close:number}[]=[];
 const parent:ParentAgentFactory=async input=>{const record={input,texts:[] as string[],close:0};calls.push(record);return {send:async text=>{record.texts.push(text);return `答：${text}`;},close:async()=>{record.close++;}};};
 const {f,service,dir,config}=await setup(t,parent);
 f.handlers.message(message('x','ou_unknown'));f.handlers.message({...message('group'),chatType:'group'});f.handlers.message({...message('bot'),senderType:'bot'});await tick();assert.equal(calls.length,1);assert.deepEqual(calls[0]!.texts,[]);
 f.handlers.message(message('one'));f.handlers.message(message('two'));f.handlers.message(message('three','ou_b','oc_b'));await tick();assert.equal(calls.length,2);assert.deepEqual(calls[0]!.texts,['你好','你好']);assert.notEqual(calls[0]!.input.instructions,calls[1]!.input.instructions);assert.match(calls[0]!.input.instructions,/sessionRef=im:/);assert.ok(!JSON.stringify(service.snapshot()).includes('CANARY_SECRET'));
 f.handlers.message(message('one'));await tick();assert.equal(calls[0]!.texts.length,2);
 await service.close();const f2=fixture(parent);const again=new ImService({dataDir:dir,policy,channelFactory:f2.factory,parentFactory:parent});await again.reconnect();await tick();f2.handlers.message(message('one'));await tick();assert.equal(calls.length,3);assert.deepEqual(calls[2]!.texts,[]);await again.close();
});
test('父 turn 完成前流式显示、控制块拆分不泄露、最终按钮点击成为同会话新 user 一次',async t=>{
 const finish=deferred<string>();const sent:string[]=[];let delta:((s:string)=>void)|undefined;let count=0;
 const {f}=await setup(t,async()=>({send:async(text,_signal,onDelta)=>{sent.push(text);if(++count>1)return '继续完成';delta=onDelta;return finish.promise;},close:async()=>{finish.resolve('已停止');}}));
 f.handlers.message(message('stream'));await tick();delta?.('公开一');await tick();delta?.('公开二<weaver-act');await tick();delta?.('ions>{"actions":[{"label":"继续","message":"执行下一步"}]}</weaver-actions>');await tick();assert.deepEqual(f.chunks,['公开一','公开二']);assert.equal(f.cards.length,0);
 finish.resolve('权威正文<weaver-actions>{"actions":[{"label":"继续","message":"执行下一步"}]}</weaver-actions>');await tick();assert.equal(f.cards.length,1);const card=f.cards[0]!;assert.match(JSON.stringify(card.card),/权威正文/);assert.ok(!JSON.stringify(card.card).includes('执行下一步'));const value=card.card.body.elements[1].columns[0].elements[0].behaviors[0].value;
 const event:CardActionEvent={messageId:card.id,chatId:'oc_a',operator:{openId:'ou_a'},action:{tag:'button',value},raw:{event_id:'click1',context:{open_message_id:card.id}}};
 assert.match(JSON.stringify(f.handlers.card({...event,operator:{openId:'ou_b'}})),/失效/);
 assert.deepEqual(Object.keys(f.handlers.card(event)),['toast']);assert.match(JSON.stringify(f.handlers.card({...event,raw:{event_id:'click2',context:{open_message_id:card.id}}})),/失效/);await tick();assert.deepEqual(sent,['你好','执行下一步']);
});
test('受控 idle 最后用户 deadline：忙时不杀，完成过期后重建；重复不刷新',async t=>{
 let now=Date.now();const finish=deferred<string>();let launches=0;let closes=0;
 const {f,service}=await setup(t,async()=>{launches++;return {send:async()=>launches===1?finish.promise:'新会话',close:async()=>{closes++;finish.resolve('完成');}};},{now:()=>now});
 f.handlers.message(message('idle','ou_a','oc_a','忙',now));await tick();now+=61_000;assert.equal(closes,0);finish.resolve('完成');await tick();assert.equal(closes,1);assert.equal(service.snapshot().status.activeSessions,1);
 f.handlers.message(message('new','ou_a','oc_a','新',now));await tick();assert.equal(launches,2);
});
test('stop取消A后已准入B自动同进程继续，重复旧stop不取消B，闲时stop不换上下文',async t=>{
 const a=deferred<string>();const b=deferred<string>();const sent:string[]=[];let closes=0;let launches=0;const aborted:string[]=[];
 const {f,config}=await setup(t,async()=>{launches++;return {send:async(text,signal)=>{sent.push(text);if(text==='C')return '完成C';signal?.addEventListener('abort',()=>{aborted.push(text);if(text==='A')a.resolve('已停止A');else b.resolve('不应停B');},{once:true});return text==='A'?a.promise:b.promise;},close:async()=>{closes++;a.resolve('退出');b.resolve('退出');}};});
 const menu=(id:string)=>({app_id:config.appId,event_id:id,event_key:'stop',create_time:String(Date.now()),operator:{operator_id:{open_id:'ou_a'}}});
 f.handlers.message(message('busy','ou_a','oc_a','A'));f.handlers.message(message('queued','ou_a','oc_a','B'));await tick();
 f.handlers.menu({...menu('unauth'),operator:{operator_id:{open_id:'ou_unknown'}}});await tick();assert.deepEqual(aborted,[]);
 f.handlers.menu(menu('stopA'));await tick();assert.deepEqual(sent,['A','B']);assert.deepEqual(aborted,['A']);assert.equal(closes,0);assert.equal(launches,1);
 f.handlers.menu(menu('stopA'));await tick();assert.deepEqual(aborted,['A']);b.resolve('完成B');await tick();
 f.handlers.menu(menu('idleStop'));await tick();assert.ok(f.notices.some(text=>text.includes('没有正在生成')));assert.equal(closes,0);
 f.handlers.message(message('C','ou_a','oc_a','C'));await tick();assert.deepEqual(sent,['A','B','C']);assert.equal(launches,1);
});
test('disable 回收晚到 factory、不发过期回复；policy 撤权使旧代立即失败关闭',async t=>{
 const late=deferred<any>();let closes=0;let sends=0;
 const {f,service,config}=await setup(t,async()=>late.promise);
 f.handlers.message(message('late'));await tick();const disable=service.save({expectedRevision:1,config:{...config,enabled:false}});await tick();late.resolve({send:async()=>{sends++;return '不应发出';},close:async()=>{closes++;}});await disable;await tick();assert.equal(sends,0);assert.ok(closes>=1);assert.equal(f.cards.length,0);assert.equal(service.snapshot().status.connection,'disabled');
});
test('出站失败不能重跑已执行输入，status 不含 secret',async t=>{
 let sends=0; const {f,service}=await setup(t,async()=>({send:async()=>{sends++;return '完成';},close:async()=>{}}));
 // Throw only at the external transport boundary.
 f.failUpdate();f.handlers.message(message('failure'));await tick();f.handlers.message(message('failure'));await tick();assert.equal(sends,1);assert.equal(service.snapshot().status.agentState,'error');assert.equal(service.snapshot().status.lastReplyAt,undefined);assert.ok(!JSON.stringify(service.snapshot()).includes('CANARY_SECRET'));
});
test('独立Bot参数不依赖owner/worker；无关profile变化保留session，Bot参数改变关闭旧代',async t=>{
 const inputs:ParentAgentInput[]=[];let closes=0;
 const {f,service,live,config}=await setup(t,async input=>{inputs.push(input);return {send:async()=> 'ok',close:async()=>{closes++;}};});
 live.config.owners={};live.config.workers={};await service.reconcile();f.handlers.message(message('direct1'));await tick();
 assert.equal(inputs.length,1);assert.equal(inputs[0]!.model,'gpt-test');assert.equal(inputs[0]!.effort,'medium');assert.equal(inputs[0]!.engineKind,'codex');
 live.config.owners=policy().config.owners;live.config.owners.main!.model='unrelated';live.config.workers.other={enabled:true,engine:'codex',model:'unrelated',effort:'high'};await service.reconcile();f.handlers.message(message('direct2'));await tick();assert.equal(inputs.length,1);assert.equal(closes,0);
 const old=f.handlers;await service.save({expectedRevision:1,config:{...config,model:'gpt-next',effort:'high'}});await tick();assert.equal(closes,1);old.message(message('fenced'));f.handlers.message(message('direct3'));await tick();assert.equal(inputs.length,2);assert.equal(inputs[1]!.model,'gpt-next');assert.equal(inputs[1]!.effort,'high');assert.notEqual(inputs[0]!.instructions,inputs[1]!.instructions);
});
test('独立chat尊重engine/model真实block，忽略单worker block；非法参数拒绝且不保存',async t=>{
 let launches=0;let closes=0;const {f,service,live,config}=await setup(t,async()=>{launches++;return {send:async()=> 'ok',close:async()=>{closes++;}};});
 live.blocks=[{engine:'codex',worker:'other',reason:'worker',since:new Date().toISOString()}];f.handlers.message(message('worker-block'));await tick();assert.equal(launches,1);
 for(const patch of [{engine:'missing'},{model:'bad; command'},{effort:'ultra'}])await assert.rejects(service.save({expectedRevision:1,config:{...config,...patch}}),{code:'IM_CONFIG_UNAVAILABLE'});
 assert.equal(service.snapshot().revision,1);
 for(const block of [{engine:'codex',reason:'manual'},{engine:'codex',model:'gpt-test',reason:'额度耗尽',by:'weaver-quota:codex'}]){
  live.blocks=[{...block,since:new Date().toISOString()}];await assert.rejects(service.save({expectedRevision:1,config}),{code:'IM_CONFIG_UNAVAILABLE'});
 }
 live.blocks=[];live.config.engines.codex!.enabled=false;
 const liveHandlers=f.handlers;const launchesBefore=launches;const cardsBefore=f.cards.length;
 await service.reconcile();await tick();
 // Healthy same-credential WS stays connected; only agent admission/output is revoked.
 assert.equal(service.snapshot().status.connection,'connected');
 assert.equal(service.snapshot().status.agentState,'error');
 assert.equal(service.snapshot().status.activeSessions,0);
 assert.equal(f.handlers,liveHandlers);
 assert.equal(launches,launchesBefore);
 assert.ok(closes>=1);
 f.handlers.message(message('revoked_route'));await tick();
 assert.equal(launches,launchesBefore);
 assert.equal(f.cards.length,cardsBefore);
 assert.equal(service.snapshot().status.connection,'connected');
 await assert.rejects(service.save({expectedRevision:1,config}),{code:'IM_CONFIG_UNAVAILABLE'});
  live.config.engines.codex={enabled:true,kind:'not-an-engine'};await assert.rejects(service.save({expectedRevision:1,config}),{code:'IM_CONFIG_UNAVAILABLE'});
});
test('单卡任意选项只消费一次，idle到期旧卡不能复活父Agent，new_session撤销旧nonce',async t=>{
 let now=Date.now();let launches=0;let sends=0;
 const {f,config}=await setup(t,async()=>{launches++;return {send:async()=>{sends++;return '正文<weaver-actions>{"actions":[{"label":"a","message":"选a"},{"label":"b","message":"选b"}]}</weaver-actions>';},close:async()=>{}};},{now:()=>now});
 const click=(card:any,index:number,id:string):CardActionEvent=>({messageId:card.id,chatId:'oc_a',operator:{openId:'ou_a'},action:{tag:'button',value:card.card.body.elements[1].columns[index].elements[0].behaviors[0].value},raw:{event_id:id,context:{open_message_id:card.id}}});
 f.handlers.message(message('actions','ou_a','oc_a','文本',now));await tick();const card=f.cards[0]!;assert.match(JSON.stringify(f.handlers.card(click(card,0,'choose_a'))),/已作为/);assert.match(JSON.stringify(f.handlers.card(click(card,1,'choose_b'))),/失效/);await tick();assert.equal(sends,2);
 const later=f.cards[1]!;now+=61_000;assert.match(JSON.stringify(f.handlers.card(click(later,0,'expired'))),/失效/);await tick();assert.equal(launches,2);
 f.handlers.message(message('renew','ou_a','oc_a','新消息',now));await tick();assert.equal(launches,2);f.handlers.menu({app_id:config.appId,event_id:'new_epoch',event_key:'new_session',create_time:String(now),operator:{operator_id:{open_id:'ou_a'}}});await tick();assert.match(JSON.stringify(f.handlers.card(click(f.cards[2]!,0,'old_epoch'))),/失效/);assert.equal(sends,3);
});
test('channel close失败重连不启动新代，失败引用保留供再次关闭',async t=>{
 let handlers!:ImChannelHandlers;let creations=0;let closes=0;let fail=true;
 const dir=await mkdtemp(`${ROOT}close-`);const service=new ImService({dataDir:dir,policy,parentFactory:async()=>({send:async()=>{throw new Error('unexpected model turn');},close:async()=>{}}),channelFactory:(_c,h)=>{handlers=h;creations++;return {connect:async()=>{},close:async()=>{closes++;if(fail)throw new Error('SECRET');},send:async()=>{},stream:async()=>'',updateCard:async()=>{},retireCard:async()=>{},state:()=> 'connected'};}});
 await service.save({expectedRevision:0,config:{enabled:true,appId:'cli_test',appSecret:'SECRET',allowedOpenIds:['ou_a'],engine:'codex',model:'gpt-test',effort:'medium',workspaces:[dir],idleTimeoutMinutes: 1, ownerProfileId: ''}});await tick();
 await assert.rejects(service.reconnect(),/IM 操作失败/);assert.equal(creations,1);assert.equal(service.snapshot().status.connection,'error');handlers.message(message('fenced'));await tick();assert.equal(service.snapshot().status.activeSessions,0);
 fail=false;await service.reconnect();await tick();assert.equal(creations,2);assert.ok(closes>=2);await service.close();await rm(dir,{recursive:true,force:true});
});

test('idle计时器未运行时满16会话中的单条新消息先claim，真实close后新epoch执行且保留准入时间',async t=>{
 let now=Date.now();const oldClosed=deferred<void>();const entries:{input:ParentAgentInput;texts:string[];closed:number}[]=[];
 const {dir,f,service}=await setup(t,async input=>{const record={input,texts:[] as string[],closed:0};entries.push(record);const index=entries.length;return {send:async text=>{record.texts.push(text);return '完成';},close:async()=>{record.closed++;if(index===1)await oldClosed.promise;}};},{now:()=>now});
 for(let n=0;n<16;n++)f.handlers.message(message(`initial${n}`,'ou_a',`oc_${n}`,'旧',now));await tick();assert.equal(entries.length,16);
 now+=61_000;const admittedAt=now;f.handlers.message(message('reborn','ou_a','oc_0','唯一新消息',now));await tick();assert.equal(entries.length,16);assert.equal(service.snapshot().status.activeSessions,16);assert.match(await readFile(join(dir,'im-inbox.json'),'utf8'),/message:om_reborn/);assert.equal(service.snapshot().status.lastMessageAt,new Date(admittedAt).toISOString());
 now+=61_000;oldClosed.resolve();await tick();assert.equal(entries.length,18);assert.deepEqual(entries[16]!.texts,['唯一新消息']);assert.notEqual(entries[0]!.input.instructions,entries[16]!.input.instructions);assert.equal(entries[16]!.closed,1,'deadline按准入时刻，执行完成已到期即回收');assert.equal(service.snapshot().status.lastMessageAt,new Date(admittedAt).toISOString());
 f.handlers.message(message('reborn','ou_a','oc_0','唯一新消息',now));await tick();assert.equal(entries.length,18,'重复消息不再启动');
});
test('idle timer已开始close时只发一条新消息，无重发自动等close；关闭失败有安全回执且零新父',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=Date.now();const close=deferred<void>();let launches=0;t.after(()=>close.resolve());
 const {f}=await setup(t,async()=>{launches++;return {send:async()=> '完成',close:async()=>close.promise};},{now:()=>now});
 f.handlers.message(message('first','ou_a','oc_a','旧',now));await tick();now+=60_000;t.mock.timers.tick(60_000);await tick();
 f.handlers.message(message('waiting','ou_a','oc_a','只发一次',now));await tick();assert.equal(launches,1);close.resolve();await tick();assert.equal(launches,2);
});
test('idle关闭失败和有界超时保留旧引用，等待消息不启动模型并有失败反馈',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=Date.now();const close=deferred<void>();let launches=0;t.after(()=>close.resolve());
 const {f,service}=await setup(t,async()=>{launches++;return {send:async()=> '完成',close:async()=>close.promise};},{now:()=>now});
 f.handlers.message(message('first','ou_a','oc_a','旧',now));await tick();now+=61_000;f.handlers.message(message('waiting','ou_a','oc_a','新',now));await tick();t.mock.timers.tick(60_000);await tick();assert.equal(launches,1);assert.ok(f.notices.some(text=>text.includes('关闭未完成')));assert.equal(service.snapshot().status.activeSessions,1);
 close.resolve();await tick();assert.equal(launches,1,'超时后late close不得晚启动');
});
test('inbox损坏/写入IO失败：合法手机消息收到固定回执，只有预启Agent、0send且不暴露错误',async t=>{
 let launches=0;let sends=0;const first=await setup(t,async()=>{launches++;return {send:async()=>{sends++;return '';},close:async()=>{}};});
 await writeFile(join(first.dir,'im-inbox.json'),'invalid PRIVATE_PATH', {mode:0o600});first.f.handlers.message(message('broken'));await tick();assert.equal(launches,1);assert.equal(sends,0);assert.ok(first.f.notices.some(text=>text.includes('记录写入失败')));assert.ok(!first.f.notices.join().includes('PRIVATE_PATH'));
 const second=await setup(t,async()=>{launches++;return {send:async()=>{sends++;return '';},close:async()=>{}};});
 // Real file boundary: a directory occupies the inbox target, causing fail-closed IO.
 await mkdir(join(second.dir,'im-inbox.json'));second.f.handlers.message(message('io'));await tick();assert.equal(launches,2);assert.equal(sends,0);assert.ok(second.f.notices.some(text=>text.includes('记录写入失败')));
});
test('idle等待分支持久化失败也有手机回执；pending被disable作废不晚启动',async t=>{
 let now=Date.now();const close=deferred<void>();let launches=0;t.after(()=>close.resolve());
 const {dir,f,service,config}=await setup(t,async()=>{launches++;return {send:async()=> 'ok',close:async()=>close.promise};},{now:()=>now});
 f.handlers.message(message('old','ou_a','oc_a','旧',now));await tick();now+=61_000;await rm(join(dir,'im-inbox.json'));await mkdir(join(dir,'im-inbox.json'));f.handlers.message(message('io_wait','ou_a','oc_a','失败输入',now));await tick();assert.ok(f.notices.some(text=>text.includes('记录写入失败')));assert.equal(launches,1);
 await rm(join(dir,'im-inbox.json'),{recursive:true});f.handlers.message(message('good_wait','ou_a','oc_a','成功准入',now));await tick();assert.match(await readFile(join(dir,'im-inbox.json'),'utf8'),/message:om_good_wait/);
 const disabling=service.save({expectedRevision:1,config:{...config,enabled:false}});await tick();close.resolve();await disabling;await tick();assert.equal(launches,1);assert.equal(service.snapshot().status.connection,'disabled');
});
test('菜单ms/sec/us时间严格归一，stale与无效create_time不从其他字段回退，重复new_session不影响新上下文',async t=>{
 let now=Date.now();let launches=0;let closes=0;const {f,config}=await setup(t,async()=>{launches++;return {send:async()=> 'ok',close:async()=>{closes++;}};},{now:()=>now});
 f.handlers.message(message('menu_time','ou_a','oc_a','文本',now));await tick();
 const menu=(id:string,time:unknown,key='status')=>({app_id:config.appId,event_id:id,event_key:key,create_time:time,operator:{operator_id:{open_id:'ou_a'}}});
 for(const time of [String(now),String(Math.floor(now/1000)),String(now*1000)])f.handlers.menu(menu(`time_${time}`,time));await tick();assert.equal(f.notices.filter(text=>text.includes('排队')).length,3);
 const before=f.notices.length;f.handlers.menu(menu('stale',String(now-301_000)));f.handlers.menu({...menu('invalid','bad'),timestamp:now});await tick();assert.equal(f.notices.length,before);
 f.handlers.menu(menu('reset_once',String(now),'new_session'));await tick();f.handlers.message(message('new_context','ou_a','oc_a','文本',now));await tick();assert.equal(launches,2);assert.equal(closes,1);f.handlers.menu(menu('reset_once',String(now),'new_session'));await tick();assert.equal(closes,1);
});
test('pending在撤权/关机后不会随late close启动；同ID等待重发保持安静',async t=>{
 for(const mode of ['revoke','shutdown'] as const){
  let now=Date.now();const close=deferred<void>();t.after(()=>close.resolve());let launches=0;
  const {f,service,live}=await setup(t,async()=>{launches++;return {send:async()=> '完成',close:async()=>close.promise};},{now:()=>now});
  f.handlers.message(message(`old_${mode}`,'ou_a','oc_a','旧',now));await tick();now+=61_000;const input=message(`wait_${mode}`,'ou_a','oc_a','已准入',now);f.handlers.message(input);await tick();const notices=f.notices.length;f.handlers.message(input);await tick();assert.equal(f.notices.length,notices);
  let shutting:Promise<void>|undefined;if(mode==='revoke'){live.config.engines.codex!.enabled=false;void service.reconcile();}else shutting=service.close();await tick();close.resolve();await shutting;await tick();assert.equal(launches,1);
 }
});
test('父close明确失败不启动下一代，持久等待消息收到失败回执且旧引用仍可见',async t=>{
 let now=Date.now();let launches=0;const dir=await mkdtemp(join(ROOT,'close-fail-'));const f=fixture();const service=new ImService({dataDir:dir,policy,now:()=>now,channelFactory:f.factory,parentFactory:async()=>{launches++;return {send:async()=> '完成',close:async()=>{throw new Error('PRIVATE_CLOSE_DETAIL');}};}});
 t.after(async()=>{await service.close().catch(()=>{});await rm(dir,{recursive:true,force:true});});
 await service.save({expectedRevision:0,config:{enabled:true,appId:'cli_test',appSecret:'SECRET',allowedOpenIds:['ou_a'],engine:'codex',model:'gpt-test',effort:'medium',workspaces:[dir],idleTimeoutMinutes: 1, ownerProfileId: ''}});await tick();f.handlers.message(message('old_close','ou_a','oc_a','旧',now));await tick();now+=61_000;f.handlers.message(message('wait_close','ou_a','oc_a','新',now));await tick();assert.equal(launches,1);assert.ok(f.notices.some(s=>s.includes('关闭未完成')));assert.ok(!f.notices.join().includes('PRIVATE_CLOSE_DETAIL'));assert.equal(service.snapshot().status.activeSessions,1);
});

async function waitFor(predicate:()=>boolean,label:string):Promise<void>{
 const deadline=Date.now()+5_000;
 while(!predicate()){if(Date.now()>deadline)throw new Error(`fixture condition timed out: ${label}`);await new Promise<void>(r=>setTimeout(r,10));}
}
for(const engine of ['claude','codex'] as const)for(const queued of [false,true,'confirmed'] as const){
 test(`${engine}真实协议${queued==='confirmed'?'双确认stop保留FIFO/context':queued?'interrupt ACK失败且B已准入':'terminal缺失无B'}`,async()=>{
  const dir=await mkdtemp(join(ROOT,`fatal-${engine}-`));const bin=join(dir,'bin');await mkdir(bin);const previousPath=process.env.PATH;const scenarioKey=`${engine.toUpperCase()}_FIXTURE_SCENARIO`;const markerKey=`${engine.toUpperCase()}_FIXTURE_MARKER`;const previousScenario=process.env[scenarioKey];const previousMarker=process.env[markerKey];const marker=join(dir,'marker.ndjson');
  await copyFile(new URL(`../fixtures/parent/${engine}-fixture.mjs`,import.meta.url),join(bin,engine));await chmod(join(bin,engine),0o700);
  await writeFile(join(bin,'systemd-run'),'#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',{mode:0o700});await writeFile(join(bin,'systemctl'),'#!/bin/sh\necho ActiveState=inactive\n',{mode:0o700});process.env.PATH=`${bin}:${previousPath}`;process.env[markerKey]=marker;
  const parents:ParentAgentSession[]=[];const calls:{input:ParentAgentInput;texts:string[]}[]=[];const f=fixture();const live=policy();live.config.engines.codex!.kind=engine;
  const service=new ImService({dataDir:dir,policy:()=>live,channelFactory:f.factory,parentFactory:async input=>{
   process.env[scenarioKey]=calls.length===0?(queued==='confirmed'?'abort':queued?'interrupt-failed':'missing-terminal'):'default';const record={input,texts:[] as string[]};calls.push(record);const parent=await createParentAgent(input,{startupMs:3_000,turnMs:3_000,closeMs:300});parents.push(parent);return {send:(text,signal,onDelta)=>{record.texts.push(text);return parent.send(text,signal,onDelta);},close:()=>parent.close()};
  }});
  try{
   await service.save({expectedRevision:0,config:{enabled:true,appId:'cli_test',appSecret:'SECRET',allowedOpenIds:['ou_a'],engine:'codex',model:'gpt-test',effort:'medium',workspaces:[dir],idleTimeoutMinutes: 30, ownerProfileId: ''}});await tick();
   f.handlers.message(message('fatal_A','ou_a','oc_a','A'));await waitFor(()=>f.chunks.length>0,'first delta');if(queued)f.handlers.message(message('fatal_B','ou_a','oc_a','B'));
   f.handlers.menu({app_id:'cli_test',event_id:'fatal_stop',event_key:'stop',create_time:String(Date.now()),operator:{operator_id:{open_id:'ou_a'}}});await waitFor(()=>service.snapshot().status.busySessions===0,'fatal A settled');await tick();
   if(queued==='confirmed'){
    assert.deepEqual(calls[0]!.texts,['A','B']);assert.equal(service.snapshot().status.activeSessions,1);assert.ok(!f.notices.some(text=>text.includes('本轮回复失败')));
    f.handlers.message(message('confirmed_C','ou_a','oc_a','C'));await waitFor(()=>f.cards.length===2,'same-context C completed');assert.equal(calls.length,1);assert.deepEqual(calls[0]!.texts,['A','B','C']);
   }else{
   assert.deepEqual(calls[0]!.texts,['A'],'fatal parent must never receive claimed B or the next message');assert.equal(service.snapshot().status.activeSessions,0,'fatal A releases before any future input');assert.ok(f.notices.some(text=>text.includes('本轮回复失败')));assert.ok(!f.notices.join().includes('interrupt'));
   f.handlers.message(message('fatal_C','ou_a','oc_a','C'));await waitFor(()=>f.cards.length===1,'first new message C completed');assert.equal(calls.length,2);assert.deepEqual(calls[1]!.texts,['C']);assert.notEqual(calls[0]!.input.instructions,calls[1]!.input.instructions);
   }
  }finally{
   await service.close().catch(()=>{});for(const parent of parents)await parent.close().catch(()=>{});
   process.env.PATH=previousPath;for(const [key,old] of [[scenarioKey,previousScenario],[markerKey,previousMarker]]){if(old===undefined)delete process.env[key!];else process.env[key!]=old;}
   const entries=(await readFile(marker,'utf8').catch(()=> '')).split('\n').filter(Boolean).map(line=>JSON.parse(line));for(const entry of entries)if(typeof entry.spawnPid==='number')assert.throws(()=>process.kill(entry.spawnPid,0),{code:'ESRCH'},'fixture PID survived close');await rm(dir,{recursive:true,force:true});
  }
 });
}
test('父正常完成后仅出站update期间stop，仍允许原父FIFO继续',async t=>{
 const updating=deferred<void>();const finishUpdate=deferred<void>();t.after(()=>finishUpdate.resolve());let calls=0;let launches=0;const dir=await mkdtemp(join(ROOT,'outbound-stop-'));const f=fixture();let handlers!:ImChannelHandlers;
 const factory:ImChannelFactory=(config,h)=>{handlers=h;const channel=f.factory(config,h);return {...channel,updateCard:async(id,card,delivery)=>{if(calls===1){updating.resolve();await finishUpdate.promise;}if(!delivery.valid())throw new Error('stopped outbound');await channel.updateCard(id,card,delivery);}};};
 const service=new ImService({dataDir:dir,policy,channelFactory:factory,parentFactory:async()=>{launches++;return {send:async()=>{calls++;return '完成';},close:async()=>{}};}});t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
 await service.save({expectedRevision:0,config:{enabled:true,appId:'cli_test',appSecret:'SECRET',allowedOpenIds:['ou_a'],engine:'codex',model:'gpt-test',effort:'medium',workspaces:[dir],idleTimeoutMinutes: 30, ownerProfileId: ''}});await tick();handlers.message(message('out_A'));await updating.promise;handlers.message(message('out_B'));handlers.menu({app_id:'cli_test',event_id:'out_stop',event_key:'stop',create_time:String(Date.now()),operator:{operator_id:{open_id:'ou_a'}}});finishUpdate.resolve();await tick();assert.equal(calls,2);assert.equal(launches,1);assert.equal(f.cards.length,1);
});

test('同配置保存保留同parent/epoch/按钮/FIFO，secret省略同样不重建', async t => {
  const inputs: ParentAgentInput[] = []; const texts: string[] = []; let closes = 0; let launches = 0;
  const { f, service, config } = await setup(t, async input => {
    launches++; inputs.push(input);
    return { send: async text => { texts.push(text); return texts.length === 1 ? '正文<weaver-actions>{"actions":[{"label":"a","message":"选a"}]}</weaver-actions>' : `答:${text}`; }, close: async () => { closes++; } };
  });
  f.handlers.message(message('keep1')); f.handlers.message(message('keep2')); await tick();
  assert.equal(launches, 1); assert.deepEqual(texts, ['你好', '你好']); assert.equal(f.cards.length, 2);
  const epoch = inputs[0]!.instructions;
  const rev1 = service.snapshot().revision;
  await service.save({ expectedRevision: rev1, config: { ...config } }); await tick();
  assert.equal(closes, 0); assert.equal(launches, 1);
  f.handlers.message(message('keep3')); await tick();
  assert.equal(launches, 1); assert.deepEqual(texts, ['你好', '你好', '你好']); assert.equal(inputs.length, 1); assert.equal(inputs[0]!.instructions, epoch);
  const card = f.cards[0]!;
  const value = card.card.body.elements[1].columns[0].elements[0].behaviors[0].value;
  const click = { messageId: card.id, chatId: 'oc_a', operator: { openId: 'ou_a' }, action: { tag: 'button', value }, raw: { event_id: 'keep_click', context: { open_message_id: card.id } } } as unknown as CardActionEvent;
  assert.match(JSON.stringify(f.handlers.card(click)), /已作为/); await tick();
  assert.equal(launches, 1); assert.deepEqual(texts, ['你好', '你好', '你好', '选a']);
  const { appSecret, ...keep } = { ...config, idleTimeoutMinutes: config.idleTimeoutMinutes };
  void appSecret;
  const rev2 = service.snapshot().revision;
  await service.save({ expectedRevision: rev2, config: keep as typeof config }); await tick();
  assert.equal(closes, 0); assert.equal(launches, 1);
  assert.ok(!JSON.stringify(service.snapshot()).includes('CANARY_SECRET'));
  f.handlers.message(message('keep4')); await tick();
  assert.equal(launches, 1); assert.equal(inputs.length, 1); assert.equal(texts.length, 5);
  // Retention proof: the omitted save kept CANARY_SECRET, so an explicit same-secret
  // save is still a no-op while a rotated secret rebuilds exactly once.
  const rev3 = service.snapshot().revision;
  await service.save({ expectedRevision: rev3, config: { ...config } }); await tick();
  assert.equal(closes, 0); assert.equal(launches, 1);
  const rev4 = service.snapshot().revision;
  await service.save({ expectedRevision: rev4, config: { ...config, appSecret: 'ROTATED_SECRET' } }); await tick();
  assert.equal(closes, 1); assert.equal(launches, 2);
  f.handlers.message(message('keep5')); await tick();
  assert.equal(launches, 2); assert.equal(texts.length, 6);
});

test('忙时同配置保存不中断FIFO，不重复不丢失', async t => {
  const first = deferred<string>(); const sent: string[] = []; let launches = 0; let closes = 0; const aborted: string[] = [];
  const { f, service, config } = await setup(t, async () => {
    launches++;
    return {
      send: async (text, signal) => { sent.push(text); signal?.addEventListener('abort', () => aborted.push(text), { once: true }); if (text === '你好' && sent.filter(s => s === '你好').length === 1) return first.promise; return `答:${text}`; },
      close: async () => { closes++; },
    };
  });
  f.handlers.message(message('busy1')); await tick();
  f.handlers.message(message('busy2')); await tick();
  const rev = service.snapshot().revision;
  await service.save({ expectedRevision: rev, config: { ...config } }); await tick();
  assert.equal(launches, 1); assert.equal(closes, 0); assert.deepEqual(aborted, []);
  first.resolve('完成A'); await tick();
  assert.deepEqual(sent, ['你好', '你好']); assert.equal(launches, 1); assert.equal(closes, 0); assert.equal(f.cards.length, 2);
});

test('模型/effort/凭据/白名单/工作空间变化仍fence旧代且先关后建', async t => {
  const dir = await mkdtemp(join(ROOT, 'effective-')); const f = fixture();
  const inputs: ParentAgentInput[] = []; const texts: string[] = []; let closes = 0; let creations = 0;
  const service = new ImService({ dataDir: dir, policy, parentFactory: async input => { inputs.push(input); creations++; return { send: async text => { texts.push(text); return 'ok'; }, close: async () => { closes++; } }; }, channelFactory: f.factory });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET_ONE', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config: base }); await tick();
  f.handlers.message(message('eff1')); await tick();
  assert.equal(creations, 1); assert.deepEqual(texts, ['你好']);
  const epoch0 = inputs[0]!.instructions;
  // Secret-only change must still rebuild (route fingerprint alone would miss it).
  const stale = f.handlers;
  await service.save({ expectedRevision: 1, config: { ...base, appSecret: 'SECRET_TWO' } }); await tick();
  assert.equal(closes, 1); assert.equal(creations, 2); assert.notEqual(inputs[1]!.instructions, epoch0);
  stale.message(message('fenced')); await tick();
  assert.deepEqual(texts, ['你好'], '旧代已fence，不再执行');
  f.handlers.message(message('eff2')); await tick();
  assert.deepEqual(texts, ['你好', '你好']); assert.equal(creations, 2);
  // Whitelist change rebuilds as well.
  await service.save({ expectedRevision: 2, config: { ...base, appSecret: 'SECRET_TWO', allowedOpenIds: ['ou_a', 'ou_b'] } }); await tick();
  assert.equal(closes, 2); assert.equal(creations, 3);
});

test('idle变更保留健康parent并按准入重算，不延长保活，忙时不杀，starting不误杀', async t => {
  let now = Date.now(); let launches = 0; let closes = 0;
  const { f, service, config } = await setup(t, async () => { launches++; return { send: async () => 'ok', close: async () => { closes++; } }; }, { now: () => now });
  // Blank standby survives an idle-only save (starting deadline 0 is not expired).
  assert.equal(launches, 1);
  const rev0 = service.snapshot().revision;
  await service.save({ expectedRevision: rev0, config: { ...config, idleTimeoutMinutes: 30} }); await tick();
  assert.equal(launches, 1); assert.equal(closes, 0);
  // Admit at T, save at T+50s with idle 2min: deadline must stay T+120s, not T+170s.
  f.handlers.message(message('idle_keep', 'ou_a', 'oc_a', '旧', now)); await tick();
  assert.equal(launches, 1);
  now += 50_000;
  const rev1 = service.snapshot().revision;
  await service.save({ expectedRevision: rev1, config: { ...config, idleTimeoutMinutes: 2} }); await tick();
  assert.equal(launches, 1); assert.equal(closes, 0);
  now += 80_000; // T+130s: past T+120s, so the idle session must have rotated.
  f.handlers.message(message('idle_expired', 'ou_a', 'oc_a', '新', now)); await tick();
  assert.equal(launches, 2); assert.equal(closes, 1);
  // Busy session is not killed by an idle-only save.
  let resolveBusy!: (v: string) => void; const busyGate = new Promise<string>(r => (resolveBusy = r));
  const dir2 = await mkdtemp(join(ROOT, 'idle-busy-')); const f2 = fixture();
  const svc2 = new ImService({ dataDir: dir2, policy, parentFactory: async () => ({ send: async () => busyGate, close: async () => {} }), channelFactory: f2.factory, now: () => now });
  t.after(async () => { resolveBusy('done'); await svc2.close().catch(() => {}); await rm(dir2, { recursive: true, force: true }); });
  const cfg2 = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir2], idleTimeoutMinutes: 1, ownerProfileId: ''};
  await svc2.save({ expectedRevision: 0, config: cfg2 }); await tick();
  f2.handlers.message(message('b1', 'ou_a', 'oc_a', '忙', now)); await tick();
  now += 61_000;
  await svc2.save({ expectedRevision: 1, config: { ...cfg2, idleTimeoutMinutes: 30} }); await tick();
  assert.equal(svc2.snapshot().status.busySessions, 1);
  resolveBusy('完成'); await tick();
  assert.equal(svc2.snapshot().status.busySessions, 0);
});

test('同fingerprint故障态显式save仍重建恢复，不会永远跳过', async t => {
  let creations = 0;
  const { f, service, config } = await setup(t, async () => {
    creations++;
    const gen = creations;
    return { send: async () => { if (gen === 1) throw new Error('MODEL_BOOM'); return 'recovered'; }, close: async () => {} };
  });
  f.handlers.message(message('fault1')); await tick();
  assert.equal(service.snapshot().status.agentState, 'error');
  const rev = service.snapshot().revision;
  await service.save({ expectedRevision: rev, config: { ...config } }); await tick();
  assert.equal(creations, 2);
  f.handlers.message(message('fault2')); await tick();
  assert.equal(service.snapshot().status.activeSessions, 1);
  assert.equal(f.cards.length, 1);
});

test('16会话idle-only保存全部保留，空白standby不误杀', async t => {
  let now = Date.now(); let launches = 0; let closes = 0;
  const { f, service, config } = await setup(t, async () => { launches++; return { send: async () => 'ok', close: async () => { closes++; } }; }, { now: () => now });
  assert.equal(launches, 1);
  for (let n = 0; n < 16; n++) f.handlers.message(message(`bulk${n}`, 'ou_a', `oc_${n}`, '旧', now));
  await tick();
  assert.equal(launches, 16);
  const rev = service.snapshot().revision;
  // setup idle=1, save idle=30: a real idle-only change; all 16 live sessions must survive it.
  assert.notEqual(config.idleTimeoutMinutes, 30);
  await service.save({ expectedRevision: rev, config: { ...config, idleTimeoutMinutes: 30} }); await tick();
  assert.equal(launches, 16); assert.equal(closes, 0); assert.equal(service.snapshot().status.activeSessions, 16);
});

test('live policy漂移未reconcile时同配置保存必须重建，不静默改fingerprint', async t => {
  const inputs: ParentAgentInput[] = []; let launches = 0; let closes = 0;
  const { f, service, live, config } = await setup(t, async input => {
    launches++; inputs.push(input);
    return { send: async () => 'ok', close: async () => { closes++; } };
  });
  f.handlers.message(message('drift1')); await tick();
  assert.equal(launches, 1); assert.equal(inputs[0]!.engineKind, 'codex');
  // Live policy flips the engine kind without reconcile: the running parent is
  // still codex, so an identical save must rebuild instead of adopting the new route.
  live.config.engines.codex!.kind = 'claude';
  const rev = service.snapshot().revision;
  await service.save({ expectedRevision: rev, config: { ...config } }); await tick();
  assert.equal(closes, 1); assert.equal(launches, 2);
  assert.equal(inputs[1]!.engineKind, 'claude');
  f.handlers.message(message('drift2')); await tick();
  assert.equal(launches, 2);
});

test('disable关闭失败后同disabled保存重试清理，不吞失败', async t => {
  let closes = 0; let fail = true;
  const dir = await mkdtemp(join(ROOT, 'disable-retry-')); const f = fixture();
  const service = new ImService({
    dataDir: dir, policy, channelFactory: f.factory,
    parentFactory: async () => ({ send: async () => 'ok', close: async () => { closes++; if (fail) throw new Error('STUCK_CLOSE'); } }),
  });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config: base }); await tick();
  await assert.rejects(service.save({ expectedRevision: 1, config: { ...base, enabled: false } }), /IM 操作失败/);
  assert.equal(closes, 1);
  assert.equal(service.snapshot().status.connection, 'error');
  assert.equal(service.snapshot().config.enabled, false);
  // Same-disabled save must retry the failed cleanup instead of returning early.
  fail = false;
  await service.save({ expectedRevision: 2, config: { ...base, enabled: false } }); await tick();
  assert.ok(closes >= 2);
  assert.equal(service.snapshot().status.connection, 'disabled');
  assert.equal(service.snapshot().status.agentState, 'disabled');
});

for(const startup of ['start-rejected','late-success','real-failure'] as const){
 test(`健康父context的A建卡${startup}窗口stop：未提交输入边界`,async t=>{
  const started=deferred<void>();const finishStart=deferred<void>();t.after(()=>finishStart.resolve());const dir=await mkdtemp(join(ROOT,'not-started-'));const f=fixture();let handlers!:ImChannelHandlers;let streams=0;let launches=0;let closes=0;const inputs:ParentAgentInput[]=[];const sent:string[]=[];
  const factory:ImChannelFactory=(config,h)=>{handlers=h;const channel=f.factory(config,h);return {...channel,stream:async(to,producer,delivery)=>{
   if(++streams===2){started.resolve();
    if(startup==='start-rejected')await new Promise<never>((_resolve,reject)=>delivery.abort.signal.addEventListener('abort',()=>reject(new Error('local start cancelled')),{once:true}));
    else {await finishStart.promise;if(startup==='real-failure'){delivery.failed=true;throw new Error('PRIVATE_PLATFORM_FAILURE');}}
   }
   return channel.stream(to,producer,delivery);
  }};};
  const service=new ImService({dataDir:dir,policy,channelFactory:factory,parentFactory:async input=>{launches++;inputs.push(input);return {send:async(text,signal)=>{sent.push(text);if(signal?.aborted)throw new Error('pre-aborted parent input');return `context:${sent.join('/')}`;},close:async()=>{closes++;}};}});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  await service.save({expectedRevision:0,config:{enabled:true,appId:'cli_test',appSecret:'SECRET',allowedOpenIds:['ou_a'],engine:'codex',model:'gpt-test',effort:'medium',workspaces:[dir],idleTimeoutMinutes: 30, ownerProfileId: ''}});await tick();
  handlers.message(message('healthy','ou_a','oc_a','健康上下文'));await tick();assert.deepEqual(sent,['健康上下文']);assert.equal(f.cards.length,1);
  handlers.message(message('not_started_A','ou_a','oc_a','A'));await started.promise;handlers.message(message('not_started_B','ou_a','oc_a','B'));assert.match(await readFile(join(dir,'im-inbox.json'),'utf8'),/message:om_not_started_B/);
  handlers.menu({app_id:'cli_test',event_id:'not_started_stop',event_key:'stop',create_time:String(Date.now()),operator:{operator_id:{open_id:'ou_a'}}});finishStart.resolve();await tick();
  if(startup==='real-failure'){
   assert.deepEqual(sent,['健康上下文']);assert.equal(closes,1);assert.equal(service.snapshot().status.activeSessions,0);assert.ok(f.notices.some(text=>text.includes('本轮回复失败')));
  }else{
   assert.deepEqual(sent,['健康上下文','B'],'A从未提交，B应无需新消息自动继续');assert.equal(closes,0);assert.equal(launches,1);assert.equal(inputs.length,1,'保持唯一sessionEpoch');
    handlers.message(message('not_started_C','ou_a','oc_a','C'));await tick();assert.deepEqual(sent,['健康上下文','B','C']);assert.equal(launches,1);assert.match(JSON.stringify(f.cards.at(-1)!.card),/健康上下文\/B\/C/);assert.ok(!f.notices.some(text=>text.includes('本轮回复失败')));
   }
  });
}

const EFFORT_FOR: Record<string, string> = { claude: 'medium', codex: 'medium', opencode: 'my-variant.1', pi: 'minimal', grok: 'none', qodercli: 'auto', dsh: 'high' };

test('7个成熟引擎经别名engine id分别save/准入：factory启动cwd为home不随首项目变化，项目白名单完整在引导数据', async t => {
  assert.deepEqual([...IM_ENGINE_KINDS].sort(), ['claude', 'codex', 'dsh', 'grok', 'opencode', 'pi', 'qodercli']);
  const expectedHome = realpathSync(homedir());
  for (const kind of IM_ENGINE_KINDS) {
    const dir = await mkdtemp(join(ROOT, `six-${kind}-`));
    const extra = await mkdtemp(join(ROOT, `six-${kind}-extra-`));
    const live = policy();
    live.config.engines = { alias: { enabled: true, kind } };
    const inputs: ParentAgentInput[] = [];
    const f = fixture();
    const service = new ImService({ dataDir: dir, policy: () => live, parentFactory: async input => { inputs.push(input); return { send: async text => `ok:${text}`, close: async () => {} }; }, channelFactory: f.factory });
    try {
      await service.save({ expectedRevision: 0, config: { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'alias', model: 'test-model', effort: EFFORT_FOR[kind]!, workspaces: [dir, extra], idleTimeoutMinutes: 30, ownerProfileId: ''} });
      await tick();
      f.handlers.message(message(`m1-${kind}`)); await tick();
      f.handlers.message(message(`m2-${kind}`)); await tick();
      assert.equal(inputs.length, 1, `${kind} 同会话两轮复用同一parent`);
      assert.equal(inputs[0]!.engineKind, kind);
      assert.equal(inputs[0]!.model, 'test-model');
      assert.equal(inputs[0]!.effort, EFFORT_FOR[kind]);
      // Bot启动cwd为home，不随第一项目变化；不把项目作为可写附加根。
      assert.equal(inputs[0]!.workspace, expectedHome, `${kind} 启动cwd为home`);
      assert.deepEqual(inputs[0]!.additionalWorkspaces ?? [], [], `${kind} 不透传项目可写根`);
      const canonical = [await realpath(dir), await realpath(extra)];
      assert.notEqual(inputs[0]!.workspace, canonical[0]);
      assert.notEqual(inputs[0]!.workspace, canonical[1]);
      // 项目A/B完整在引导数据；引导明确真实任务workspace从实际目标选择。
      assert.ok(inputs[0]!.instructions.includes(JSON.stringify(canonical)), `${kind} 引导保留完整项目列表`);
      assert.match(inputs[0]!.instructions, /tasks\.create.*workspace/);
      assert.match(inputs[0]!.instructions, /Bot启动cwd为home/);
      assert.match(inputs[0]!.instructions, /不限制\/代替实际项目路径/);
      assert.equal(f.cards.length, 2);
    } finally {
      await service.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
      await rm(extra, { recursive: true, force: true });
    }
  }
  // 首项目顺序交换仍是同一home：另起一例证明启动cwd不随第一项目变化。
  {
    const dirA = await mkdtemp(join(ROOT, 'order-a-'));
    const dirB = await mkdtemp(join(ROOT, 'order-b-'));
    const live = policy();
    const seen: string[] = [];
    for (const order of [[dirA, dirB], [dirB, dirA]] as const) {
      const dataDir = await mkdtemp(join(ROOT, 'order-data-'));
      const f = fixture();
      const service = new ImService({ dataDir, policy: () => live, parentFactory: async input => { seen.push(input.workspace); return { send: async () => 'ok', close: async () => {} }; }, channelFactory: f.factory });
      try {
        await service.save({ expectedRevision: 0, config: { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [...order], idleTimeoutMinutes: 30, ownerProfileId: ''} });
        await tick();
      } finally {
        await service.close().catch(() => {});
        await rm(dataDir, { recursive: true, force: true });
      }
    }
    assert.deepEqual(seen, [expectedHome, expectedHome]);
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test('未知未实现kind仍拒绝；OpenCode合法variant通过、非法effort拒绝', async t => {
  const dir = await mkdtemp(join(ROOT, 'unknown-kind-'));
  const live = policy();
  live.config.engines = { alias: { enabled: true, kind: 'not-an-engine' } };
  const f = fixture();
  const service = new ImService({ dataDir: dir, policy: () => live, parentFactory: async () => ({ send: async () => 'ok', close: async () => {} }), channelFactory: f.factory });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'alias', model: 'test-model', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await assert.rejects(service.save({ expectedRevision: 0, config: base }), { code: 'IM_CONFIG_UNAVAILABLE' });
  live.config.engines = { alias: { enabled: true, kind: 'opencode' } };
  await service.save({ expectedRevision: 0, config: { ...base, effort: 'valid-variant_2.0' } });
  await tick();
  f.handlers.message(message('variant-ok')); await tick();
  assert.equal(f.cards.length, 1);
  await assert.rejects(service.save({ expectedRevision: 1, config: { ...base, effort: 'bad effort!' } }), { code: 'IM_CONFIG_UNAVAILABLE' });
});

test('切engine旧代close完成后才新建，旧代fence不再执行', async t => {
  const dir = await mkdtemp(join(ROOT, 'engine-switch-'));
  const live = policy();
  live.config.engines = { aaa: { enabled: true, kind: 'claude' }, bbb: { enabled: true, kind: 'codex' } };
  const inputs: ParentAgentInput[] = [];
  const texts: string[] = [];
  let closes = 0;
  let channels = 0;
  const f = fixture();
  const counting: ImChannelFactory = (c, h) => { channels++; return f.factory(c, h); };
  const service = new ImService({ dataDir: dir, policy: () => live, parentFactory: async input => { inputs.push(input); return { send: async text => { texts.push(text); return 'ok'; }, close: async () => { closes++; } }; }, channelFactory: counting });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'aaa', model: 'm', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config: base }); await tick();
  f.handlers.message(message('before')); await tick();
  assert.equal(inputs.length, 1); assert.equal(inputs[0]!.engineKind, 'claude');
  assert.equal(channels, 1);
  const liveHandlers = f.handlers;
  await service.save({ expectedRevision: 1, config: { ...base, engine: 'bbb' } }); await tick();
  assert.equal(closes, 1); assert.equal(inputs.length, 2); assert.equal(inputs[1]!.engineKind, 'codex');
  assert.notEqual(inputs[0]!.instructions, inputs[1]!.instructions);
  // Transport reuse: same healthy credentials keep the same WS object.
  assert.equal(channels, 1, 'engine切换复用同一channel');
  assert.equal(liveHandlers, f.handlers);
  liveHandlers.message(message('after')); await tick();
  assert.deepEqual(texts, ['你好', '你好']); assert.equal(inputs.length, 2);
});

test('启动缺binary/auth/protocol/未知错误各固定安全agentMessage且不回显', async t => {
  const cases = [
    { reason: 'engine_missing' as const, expected: 'Bot 引擎缺失，请安装对应 CLI 后重新连接。' },
    { reason: 'auth' as const, expected: 'Bot 引擎认证失败，请检查登录或密钥后重新连接。' },
    { reason: 'protocol' as const, expected: 'Bot 与引擎协议不兼容，请升级引擎后重新连接。' },
    { reason: 'engine' as const, expected: 'IM 操作失败，请检查配置或重新连接。' },
  ];
  for (const { reason, expected } of cases) {
    const dir = await mkdtemp(join(ROOT, `startup-${reason}-`));
    const canary = `LEAK_CANARY_${reason}_SECRET_TOKEN`;
    const f = fixture();
    const service = new ImService({ dataDir: dir, policy, parentFactory: async () => { throw parentError(reason, `${canary} at /tmp/private/${reason} vendor detail`); }, channelFactory: f.factory });
    try {
      await service.save({ expectedRevision: 0, config: { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''} });
      await tick();
      const snapshot = service.snapshot();
      assert.equal(snapshot.status.agentState, 'error');
      assert.equal(snapshot.status.agentMessage, expected);
      assert.ok(!JSON.stringify(snapshot).includes(canary) && !JSON.stringify(snapshot).includes('/tmp/private'), `${reason} 不回显原始错误与路径`);
    } finally {
      await service.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }
  const unknownDir = await mkdtemp(join(ROOT, 'startup-unknown-'));
  const unknownCanary = 'LEAK_VENDOR_DETAIL_TOKEN';
  const unknownFixture = fixture();
  const unknownService = new ImService({ dataDir: unknownDir, policy, parentFactory: async () => { throw new Error(`${unknownCanary} /etc/shadow`); }, channelFactory: unknownFixture.factory });
  try {
    await unknownService.save({ expectedRevision: 0, config: { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [unknownDir], idleTimeoutMinutes: 30, ownerProfileId: ''} });
    await tick();
    const snapshot = unknownService.snapshot();
    assert.equal(snapshot.status.agentState, 'error');
    assert.equal(snapshot.status.agentMessage, 'IM 操作失败，请检查配置或重新连接。');
    assert.ok(!JSON.stringify(snapshot).includes(unknownCanary));
  } finally {
    await unknownService.close().catch(() => {});
    await rm(unknownDir, { recursive: true, force: true });
  }
});

test('回合auth失败固定安全status且手机回执不回显；旧代late失败不覆盖新代', async t => {
  const canary = 'LEAK_TURN_AUTH_SECRET';
  const { service, f } = await setup(t, async () => ({ send: async () => { throw parentError('auth', `${canary} token=abc /tmp/secret`); }, close: async () => {} }));
  f.handlers.message(message('turn-auth')); await tick();
  const snapshot = service.snapshot();
  assert.equal(snapshot.status.agentState, 'error');
  assert.equal(snapshot.status.agentMessage, 'Bot 引擎认证失败，请检查登录或密钥后重新连接。');
  assert.ok(!JSON.stringify(snapshot).includes(canary) && !JSON.stringify(snapshot).includes('/tmp/secret'));
  assert.ok(f.notices.some(text => text.includes('本轮回复失败')) && !f.notices.join().includes(canary));

  // Stale generation: first launch hangs, second generation rebuilds healthy, then the old
  // launch rejects with auth — the live status must not regress and no replay happens.
  const lateDir = await mkdtemp(join(ROOT, 'late-auth-'));
  const lateCanary = 'LEAK_LATE_AUTH_SECRET';
  let failFirst!: (error: unknown) => void;
  const firstLaunch = new Promise<ParentAgentSession>((_resolve, reject) => { failFirst = reject; });
  // Prevent an unhandled rejection between factory call and release attaching its catcher.
  firstLaunch.catch(() => {});
  let calls = 0;
  const lateFixture = fixture();
  const late = new ImService({
    dataDir: lateDir, policy, channelFactory: lateFixture.factory,
    parentFactory: () => { calls++; return calls === 1 ? firstLaunch : Promise.resolve({ send: async () => 'ok', close: async () => {} }); },
  });
  t.after(async () => { await late.close().catch(() => {}); await rm(lateDir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [lateDir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await late.save({ expectedRevision: 0, config: base }); await tick();
  const rebuilding = late.save({ expectedRevision: 1, config: { ...base, model: 'gpt-next' } });
  await tick();
  failFirst(parentError('auth', lateCanary));
  await rebuilding; await tick();
  assert.equal(calls, 2, '只建新代，不提前重放');
  assert.equal(late.snapshot().status.agentState, 'ready');
  assert.equal(late.snapshot().status.agentMessage, undefined);
  assert.ok(!JSON.stringify(late.snapshot()).includes(lateCanary));
  lateFixture.handlers.message(message('late-healthy')); await tick();
  assert.equal(lateFixture.cards.length, 1);
  assert.equal(calls, 2);
});

test('控制unavailable先到时同代分类失败仍覆盖通用engine且旧代不污染新代', async t => {
  const canary = 'LEAK_RACE_AUTH_SECRET';
  let releaseUnavailable!: () => void;
  const gate = new Promise<void>(resolve => { releaseUnavailable = resolve; });
  const { service, f } = await setup(t, async () => ({
    unavailable: gate,
    send: async () => {
      releaseUnavailable();
      await new Promise(resolve => setTimeout(resolve, 20));
      throw parentError('auth', `${canary} token=abc /tmp/secret`);
    },
    close: async () => {},
  }));
  f.handlers.message(message('race-auth')); await tick();
  await new Promise(resolve => setTimeout(resolve, 200));
  const snapshot = service.snapshot();
  assert.equal(snapshot.status.agentState, 'error');
  assert.equal(snapshot.status.agentMessage, 'Bot 引擎认证失败，请检查登录或密钥后重新连接。');
  assert.ok(!JSON.stringify(snapshot).includes(canary) && !JSON.stringify(snapshot).includes('/tmp/secret'));
  assert.ok(f.notices.some(text => text.includes('本轮回复失败')) && !f.notices.join().includes(canary));
});

test('真实SDK post与text共享同会话FIFO与持久去重', async t => {
  const { normalize } = await import('@larksuite/channel');
  const texts: string[] = []; let launches = 0;
  const { f } = await setup(t, async () => { launches++; return { send: async text => { texts.push(text); return `答:${text}`; }, close: async () => {} }; });
  const now = Date.now();
  const postContent = JSON.stringify({ title: '优化标题', content: [[{ tag: 'text', text: '在 weaver 做几个优化：', style: [] }], [{ tag: 'text', text: '1. bot 样式优化' }]] });
  const post = await normalize({ sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' }, message: { message_id: 'om_postshare', chat_id: 'oc_a', chat_type: 'p2p', message_type: 'post', create_time: String(now), content: postContent } }, { botIdentity: { openId: "ou_bot", name: "t" }, includeRaw: true });
  f.handlers.message(message('t1', 'ou_a', 'oc_a', '前置文本', now));
  f.handlers.message(post); await tick();
  assert.equal(launches, 1);
  assert.equal(texts.length, 2);
  assert.match(texts[1]!, /优化标题/);
  assert.match(texts[1]!, /bot 样式优化/);
  assert.ok(!texts[1]!.includes('[rich text message]'));
  f.handlers.message(post); await tick();
  assert.equal(texts.length, 2, '同一post重放不重复执行');
  assert.equal(f.cards.length, 2);
});

test('空白/超长/仅附件post安全反馈不触发任务且重复不重复通知', async t => {
  const { normalize } = await import('@larksuite/channel');
  let sends = 0;
  const { f } = await setup(t, async () => ({ send: async () => { sends++; return 'ok'; }, close: async () => {} }));
  const now = Date.now();
  const blank = await normalize({ sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' }, message: { message_id: 'om_postblank', chat_id: 'oc_a', chat_type: 'p2p', message_type: 'post', create_time: String(now), content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: '   ' }]] }) } }, { botIdentity: { openId: "ou_bot", name: "t" }, includeRaw: true });
  f.handlers.message(blank); await tick();
  assert.equal(sends, 0);
  assert.ok(f.notices.some(s => s.includes('仅支持')));
  assert.ok(!f.notices.join().includes('[rich text message]'));
  const before = f.notices.length;
  f.handlers.message(blank); await tick();
  assert.equal(f.notices.length, before, '重复unsupported不重复通知');
  assert.equal(sends, 0);
  const big = await normalize({ sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' }, message: { message_id: 'om_postbig', chat_id: 'oc_a', chat_type: 'p2p', message_type: 'post', create_time: String(now), content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: 'y'.repeat(16_001) }]] }) } }, { botIdentity: { openId: "ou_bot", name: "t" }, includeRaw: true });
  f.handlers.message(big); await tick();
  assert.equal(sends, 0);
  assert.ok(f.notices.some(s => s.includes('仅支持')));
  const attach = await normalize({ sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' }, message: { message_id: 'om_postatt', chat_id: 'oc_a', chat_type: 'p2p', message_type: 'post', create_time: String(now), content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: '' }]], files: [{ file_key: 'k_secret', file_name: 'a.txt' }] }) } }, { botIdentity: { openId: "ou_bot", name: "t" }, includeRaw: true });
  f.handlers.message(attach); await tick();
  assert.equal(sends, 0);
  assert.ok(!f.notices.join().includes('k_secret'));
});

test('post类型伪造/未授权/群聊不进入Agent且无反馈', async t => {
  const { normalize } = await import('@larksuite/channel');
  let sends = 0;
  const { f } = await setup(t, async () => ({ send: async () => { sends++; return 'ok'; }, close: async () => {} }));
  const now = Date.now();
  const real = await normalize({ sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' }, message: { message_id: 'om_forge1', chat_id: 'oc_a', chat_type: 'p2p', message_type: 'post', create_time: String(now), content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: 'hi' }]] }) } }, { botIdentity: { openId: "ou_bot", name: "t" }, includeRaw: true });
  const forged = { ...real, rawContentType: 'text' };
  f.handlers.message(forged as typeof real); await tick();
  const unauth = await normalize({ sender: { sender_id: { open_id: 'ou_unknown' }, sender_type: 'user' }, message: { message_id: 'om_unauth_post', chat_id: 'oc_a', chat_type: 'p2p', message_type: 'post', create_time: String(now), content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: 'hi' }]] }) } }, { botIdentity: { openId: "ou_bot", name: "t" }, includeRaw: true });
  f.handlers.message(unauth); await tick();
  const group = await normalize({ sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' }, message: { message_id: 'om_group_post', chat_id: 'oc_a', chat_type: 'group', message_type: 'post', create_time: String(now), content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: 'hi' }]] }) } }, { botIdentity: { openId: "ou_bot", name: "t" }, includeRaw: true });
  f.handlers.message({ ...group, chatType: 'group' }); await tick();
  assert.equal(sends, 0);
  assert.equal(f.notices.length, 0);
  assert.equal(f.cards.length, 0);
});

test('transport复用红线：model变更保留同channel且换parent，新消息进新代旧事件被拒', async t => {
  let channels = 0; let channelCloses = 0; const texts: string[] = []; let parentCloses = 0; let parents = 0;
  const dir = await mkdtemp(join(ROOT, 'transport-reuse-'));
  const f = fixture();
  const counting: ImChannelFactory = (c, h) => { channels++; const ch = f.factory(c, h); return { ...ch, close: async () => { channelCloses++; await ch.close(); } }; };
  // Track handler identity: fixture exposes latest handlers via f.handlers getter.
  const service = new ImService({ dataDir: dir, policy, parentFactory: async () => { parents++; return { send: async text => { texts.push(text); return 'ok'; }, close: async () => { parentCloses++; } }; }, channelFactory: counting });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config: base }); await tick();
  assert.equal(channels, 1); assert.equal(parents, 1);
  f.handlers.message(message('reuse1')); await tick();
  assert.deepEqual(texts, ['你好']);
  const liveHandlers = f.handlers;
  await service.save({ expectedRevision: 1, config: { ...base, model: 'gpt-next' } }); await tick();
  assert.equal(channels, 1, '同凭据model变更必须复用同一channel');
  assert.equal(parents, 2, 'model变更必须重建parent');
  assert.equal(parentCloses, 1);
  assert.equal(channelCloses, 0);
  liveHandlers.message(message('reuse2')); await tick();
  assert.deepEqual(texts, ['你好', '你好'], '同一活channel新消息必须进入新parent');
});

test('transport语义：effort/白名单/工作空间变更复用channel，凭据/显式reconnect/transport故障全量重建', async t => {
  let channels = 0; let channelCloses = 0; let parents = 0; let parentCloses = 0;
  const dir = await mkdtemp(join(ROOT, 'transport-semantics-'));
  const extra = await mkdtemp(join(ROOT, 'transport-semantics-extra-'));
  const f = fixture();
  const counting: ImChannelFactory = (c, h) => { channels++; const ch = f.factory(c, h); return { ...ch, close: async () => { channelCloses++; await ch.close(); } }; };
  const service = new ImService({ dataDir: dir, policy, parentFactory: async () => { parents++; return { send: async () => 'ok', close: async () => { parentCloses++; } }; }, channelFactory: counting });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); await rm(extra, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config: base }); await tick();
  assert.equal(channels, 1); assert.equal(parents, 1);
  // effort-only change reuses the channel.
  await service.save({ expectedRevision: 1, config: { ...base, effort: 'high' } }); await tick();
  assert.equal(channels, 1); assert.equal(parents, 2); assert.equal(parentCloses, 1); assert.equal(channelCloses, 0);
  // Whitelist expansion reuses the channel.
  await service.save({ expectedRevision: 2, config: { ...base, effort: 'high', allowedOpenIds: ['ou_a', 'ou_b'] } }); await tick();
  assert.equal(channels, 1); assert.equal(parents, 3); assert.equal(parentCloses, 2);
  // Workspace change reuses the channel.
  await service.save({ expectedRevision: 3, config: { ...base, effort: 'high', allowedOpenIds: ['ou_a', 'ou_b'], workspaces: [extra] } }); await tick();
  assert.equal(channels, 1); assert.equal(parents, 4); assert.equal(parentCloses, 3);
  const liveHandlers = f.handlers;
  // Credential rotation must fully rebuild and fence the old channel.
  await service.save({ expectedRevision: 4, config: { ...base, effort: 'high', allowedOpenIds: ['ou_a', 'ou_b'], workspaces: [extra], appSecret: 'ROTATED' } }); await tick();
  assert.equal(channels, 2); assert.equal(parents, 5); assert.equal(parentCloses, 4); assert.equal(channelCloses, 1);
  liveHandlers.message(message('old_channel')); await tick();
  assert.equal(parents, 5, '旧channel事件必须被fence');
  f.handlers.message(message('new_channel')); await tick();
  assert.equal(parents, 5, '新channel新消息复用同一parent上下文');
  // Explicit reconnect always rebuilds both.
  await service.reconnect(); await tick();
  assert.equal(channels, 3); assert.equal(parents, 6); assert.equal(parentCloses, 5); assert.equal(channelCloses, 2);
  // Transport error followed by same-config save must fully rebuild.
  f.handlers.error(); await tick();
  assert.equal(service.snapshot().status.connection, 'error');
  const rev = service.snapshot().revision;
  await service.save({ expectedRevision: rev, config: { ...base, effort: 'high', allowedOpenIds: ['ou_a', 'ou_b'], workspaces: [extra], appSecret: 'ROTATED' } }); await tick();
  assert.equal(channels, 4); assert.equal(parents, 7);
  assert.equal(service.snapshot().status.connection, 'connected');
});

test('transport语义：Agent失败同配置save仅恢复Agent，connection保持connected', async t => {
  let channels = 0; let parents = 0; let closes = 0;
  const f = fixture();
  const counting: ImChannelFactory = (c, h) => { channels++; return f.factory(c, h); };
  const dir = await mkdtemp(join(ROOT, 'transport-agent-recovery-'));
  const service = new ImService({ dataDir: dir, policy, parentFactory: async () => { parents++; const gen = parents; return { send: async () => { if (gen === 1) throw new Error('MODEL_BOOM'); return 'recovered'; }, close: async () => { closes++; } }; }, channelFactory: counting });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config: base }); await tick();
  f.handlers.message(message('fault1')); await tick();
  assert.equal(service.snapshot().status.agentState, 'error');
  assert.equal(service.snapshot().status.connection, 'connected', '仅Agent失败不能把connection改error');
  const rev = service.snapshot().revision;
  await service.save({ expectedRevision: rev, config: { ...base } }); await tick();
  assert.equal(channels, 1, 'Agent恢复必须复用同一channel');
  assert.equal(parents, 2);
  assert.equal(service.snapshot().status.connection, 'connected');
  f.handlers.message(message('fault2')); await tick();
  assert.equal(f.cards.length, 1);
});

test('transport语义：旧parent关闭失败无新parent、WS健康、新准入受阻，重试恢复', async t => {
  let now = Date.now();
  let channels = 0; let parents = 0; let failClose = true;
  const dir = await mkdtemp(join(ROOT, 'transport-closefail-'));
  const f = fixture();
  const counting: ImChannelFactory = (c, h) => { channels++; return f.factory(c, h); };
  const service = new ImService({ dataDir: dir, policy, now: () => now, parentFactory: async () => { parents++; return { send: async () => 'ok', close: async () => { if (failClose) throw new Error('STUCK_CLOSE'); } }; }, channelFactory: counting });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config: base }); await tick();
  assert.equal(channels, 1); assert.equal(parents, 1);
  f.handlers.message(message('old1')); await tick();
  await assert.rejects(service.save({ expectedRevision: 1, config: { ...base, model: 'gpt-next' } }), /IM 操作失败/);
  assert.equal(channels, 1, 'agent重建失败不重建channel');
  assert.equal(parents, 1, '未完成close禁止替换parent');
  assert.equal(service.snapshot().status.connection, 'connected', 'WS保持健康');
  assert.equal(service.snapshot().status.agentState, 'error');
  f.handlers.message(message('blocked')); await tick();
  assert.equal(parents, 1, '新准入受阻');
  failClose = false;
  const rev = service.snapshot().revision;
  await service.save({ expectedRevision: rev, config: { ...base, model: 'gpt-next' } }); await tick();
  assert.equal(parents, 2, 'retryClose重试同精确对象后恢复');
  assert.equal(channels, 1);
  f.handlers.message(message('after_retry')); await tick();
  assert.equal(service.snapshot().status.agentState !== 'error', true);
});

test('transport语义：撤白名单后即使close失败旧Agent也不能准入或外发，凭据变更close失败仍撤销旧channel', async t => {
  let channels = 0; let channelCloses = 0; let parents = 0; const sent: string[] = []; let failClose = true;
  const dir = await mkdtemp(join(ROOT, 'transport-revoke-'));
  const f = fixture();
  let liveSend: ((to: string, text: string) => Promise<void>) | undefined;
  const counting: ImChannelFactory = (c, h) => {
    channels++;
    const ch = f.factory(c, h);
    return { ...ch, send: async (to, text) => { liveSend = async () => {}; sent.push(text); await ch.send(to, text); }, close: async () => { channelCloses++; await ch.close(); } };
  };
  const service = new ImService({ dataDir: dir, policy, parentFactory: async () => { parents++; return { send: async text => { sent.push(`parent:${text}`); return 'ok'; }, close: async () => { if (failClose) throw new Error('STUCK'); } }; }, channelFactory: counting });
  t.after(async () => { failClose = false; await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a', 'ou_b'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config: base }); await tick();
  f.handlers.message(message('before_revoke', 'ou_b')); await tick();
  const parentsBeforeRevoke = parents;
  const sentBeforeRevoke = sent.length;
  // Revoke ou_b while its parent close hangs: config is persisted first, old agent fenced.
  await assert.rejects(service.save({ expectedRevision: 1, config: { ...base, allowedOpenIds: ['ou_a'] } }), /IM 操作失败/);
  f.handlers.message(message('revoked_user', 'ou_b')); await tick();
  assert.equal(parents, parentsBeforeRevoke, '撤权后旧用户不能再准入新parent');
  assert.equal(sent.length, sentBeforeRevoke, '撤权后旧Agent不能继续外发');
  assert.equal(service.snapshot().status.connection, 'connected');
  // Credential rotation with stuck agent close must still revoke the old channel.
  failClose = true;
  const rev = service.snapshot().revision;
  await assert.rejects(service.save({ expectedRevision: rev, config: { ...base, allowedOpenIds: ['ou_a'], appSecret: 'ROTATED2' } }), /IM 操作失败/);
  assert.equal(channelCloses, 1, '凭据变化即使Agent关闭失败也要撤销旧channel');
  void liveSend;
});

test('reconcile中Agent关闭失败不关闭健康WS，无替代parent且重试恢复', async t => {
  let channels = 0; let channelCloses = 0; let parents = 0; let failClose = true;
  const dir = await mkdtemp(join(ROOT, 'reconcile-closefail-'));
  const f = fixture();
  const counting: ImChannelFactory = (c, h) => { channels++; const ch = f.factory(c, h); return { ...ch, close: async () => { channelCloses++; await ch.close(); } }; };
  const live = policy();
  const service = new ImService({ dataDir: dir, policy: () => live, parentFactory: async () => { parents++; return { send: async () => 'ok', close: async () => { if (failClose) throw new Error('STUCK_CLOSE'); } }; }, channelFactory: counting });
  t.after(async () => { failClose = false; await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config: base }); await tick();
  assert.equal(channels, 1); assert.equal(parents, 1);
  assert.equal(service.snapshot().status.connection, 'connected');
  const cardsBefore = f.cards.length;
  // Live policy flips the engine kind without save: same credentials, fingerprint drift.
  live.config.engines.codex!.kind = 'claude';
  await service.reconcile(); await tick();
  assert.equal(channelCloses, 0, 'Agent关闭失败不得关闭健康channel');
  assert.equal(channels, 1, '不得重建transport');
  assert.equal(parents, 1, '未完成close禁止替换parent');
  assert.equal(service.snapshot().status.connection, 'connected', 'WS保持健康');
  assert.equal(service.snapshot().status.agentState, 'error');
  f.handlers.message(message('reconcile_blocked')); await tick();
  assert.equal(parents, 1, '新准入受阻');
  assert.equal(f.cards.length, cardsBefore, '无准入输出泄漏');
  failClose = false;
  const rev = service.snapshot().revision;
  await service.save({ expectedRevision: rev, config: { ...base } }); await tick();
  assert.equal(parents, 2, 'retryClose重试同精确对象后恢复');
  assert.equal(channels, 1, '恢复仍复用同一channel');
  f.handlers.message(message('reconcile_after')); await tick();
  assert.equal(f.cards.length, cardsBefore + 1);
});

test('connecting中同凭据模型保存复用channel，晚connected仍生效且旧channel被fence', async t => {
  let channels = 0; let channelCloses = 0; let parents = 0;
  const dir = await mkdtemp(join(ROOT, 'deferred-connect-'));
  const f = fixture();
  const handlersByGen: ImChannelHandlers[] = [];
  let resolveFirstConnect!: () => void;
  const firstGate = new Promise<void>(r => { resolveFirstConnect = r; });
  const counting: ImChannelFactory = (c, h) => {
    channels++;
    const gen = channels;
    handlersByGen.push(h);
    const ch = f.factory(c, h);
    return {
      ...ch,
      connect: async () => { if (gen === 1) await firstGate; else await ch.connect(); },
      close: async () => { channelCloses++; await ch.close(); },
    };
  };
  const service = new ImService({ dataDir: dir, policy, parentFactory: async () => { parents++; return { send: async () => 'ok', close: async () => {} }; }, channelFactory: counting });
  t.after(async () => { resolveFirstConnect(); await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: ''};
  await service.save({ expectedRevision: 0, config: base }); await tick();
  assert.equal(channels, 1); assert.equal(parents, 1);
  assert.equal(service.snapshot().status.connection, 'connecting');
  // Same-credential model change while connecting must not build a new channel.
  await service.save({ expectedRevision: 1, config: { ...base, model: 'gpt-next' } }); await tick();
  assert.equal(channels, 1, 'connecting中同凭据保存不多建channel');
  assert.equal(parents, 2);
  assert.equal(channelCloses, 0);
  resolveFirstConnect(); await tick();
  // Deferred connect of the retained channel still marks connected.
  await tick();
  assert.equal(service.snapshot().status.connection, 'connected');
  const liveHandlers = handlersByGen[0]!;
  liveHandlers.message(message('deferred_ok')); await tick();
  assert.equal(parents, 2, '同一活channel新消息复用新parent');
  // Credential rotation builds a new channel; the old late callbacks stay fenced.
  await service.save({ expectedRevision: 2, config: { ...base, model: 'gpt-next', appSecret: 'ROTATED' } }); await tick();
  assert.equal(channels, 2); assert.equal(channelCloses, 1);
  liveHandlers.message(message('old_deferred')); await tick();
  assert.equal(parents, 3, '旧channel事件被fence');
  liveHandlers.error(); await tick();
  assert.equal(service.snapshot().status.connection, 'connected', '旧channel error不得污染新连接');
});

test('快照 ownerProfiles 按 id 排序、selectable 与 reason 正确、无 secret', async t => {
  const dir = await mkdtemp(join(ROOT, 'owner-snap-'));
  const live = policy();
  live.config.engines = {
    codex: { enabled: true, kind: 'codex' },
    claude: { enabled: true, kind: 'claude' },
    off: { enabled: false, kind: 'codex' },
    pi: { enabled: true, kind: 'pi' },
  };
  live.config.owners = {
    zeta: { enabled: true, engine: 'codex', model: 'm1', effort: 'medium', workers: [], max_parallel: 1 },
    alpha: { enabled: false, engine: 'codex', model: 'm2', effort: 'medium', workers: [], max_parallel: 1 },
    beta: { enabled: true, engine: 'missing', model: 'm3', effort: 'medium', workers: [], max_parallel: 1 },
    gamma: { enabled: true, engine: 'off', model: 'm4', effort: 'medium', workers: [], max_parallel: 1 },
    delta: { enabled: true, engine: 'pi', model: 'm5', effort: 'minimal', workers: [], max_parallel: 1 },
  };
  const f = fixture();
  const service = new ImService({ dataDir: dir, policy: () => live, parentFactory: async () => ({ send: async () => 'ok', close: async () => {} }), channelFactory: f.factory });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'CANARY_SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: '' };
  await service.save({ expectedRevision: 0, config: base });
  await tick();
  const snap = service.snapshot();
  assert.deepEqual(snap.ownerProfiles.map(o => o.id), ['alpha', 'beta', 'delta', 'gamma', 'zeta']);
  const byId = Object.fromEntries(snap.ownerProfiles.map(o => [o.id, o]));
  assert.equal(byId.zeta.selectable, true);
  assert.equal(byId.zeta.reason, undefined);
  assert.equal(byId.alpha.selectable, false); assert.equal(byId.alpha.reason, 'disabled');
  assert.equal(byId.beta.selectable, false); assert.equal(byId.beta.reason, 'engine_disabled');
  assert.equal(byId.gamma.selectable, false); assert.equal(byId.gamma.reason, 'engine_disabled');
  assert.equal(byId.delta.selectable, false); assert.equal(byId.delta.reason, 'not_launchable');
  assert.equal(byId.zeta.engine, 'codex'); assert.equal(byId.zeta.engineKind, 'codex');
  assert.ok(!JSON.stringify(snap).includes('CANARY_SECRET'));
});

test('已存 owner 被删除时快照含 missing 项且聊天仍可用', async t => {
  const dir = await mkdtemp(join(ROOT, 'owner-missing-'));
  const live = policy();
  const f = fixture();
  let launches = 0;
  const service = new ImService({ dataDir: dir, policy: () => live, parentFactory: async () => { launches++; return { send: async () => 'ok', close: async () => {} }; }, channelFactory: f.factory });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: 'main' };
  await service.save({ expectedRevision: 0, config: base });
  await tick();
  assert.equal(service.snapshot().ownerProfiles.find(o => o.id === 'main')?.selectable, true);
  delete live.config.owners.main;
  const snap = service.snapshot();
  const missing = snap.ownerProfiles.find(o => o.id === 'main');
  assert.ok(missing);
  assert.equal(missing.selectable, false); assert.equal(missing.reason, 'missing');
  assert.equal(missing.engine, ''); assert.equal(missing.engineKind, '');
  f.handlers.message(message('still_chat')); await tick();
  assert.equal(launches, 1);
  assert.equal(f.cards.length, 1);
});

test('保存非法/停用/非 claude-codex 的非空 owner 被拒且不写盘', async t => {
  const dir = await mkdtemp(join(ROOT, 'owner-reject-'));
  const live = policy();
  live.config.engines.pi = { enabled: true, kind: 'pi' };
  live.config.owners = {
    good: { enabled: true, engine: 'codex', model: 'm', effort: 'medium', workers: [], max_parallel: 1 },
    off: { enabled: true, engine: 'codex', model: 'm', effort: 'medium', workers: [], max_parallel: 1 },
    badkind: { enabled: true, engine: 'pi', model: 'm', effort: 'minimal', workers: [], max_parallel: 1 },
  };
  live.config.owners.off.enabled = false;
  const f = fixture();
  const service = new ImService({ dataDir: dir, policy: () => live, parentFactory: async () => ({ send: async () => 'ok', close: async () => {} }), channelFactory: f.factory });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: '' };
  await service.save({ expectedRevision: 0, config: base });
  await tick();
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(join(dir, 'im-settings.json'), 'utf8');
  for (const pin of ['nope', 'off', 'badkind']) {
    await assert.rejects(service.save({ expectedRevision: 1, config: { ...base, ownerProfileId: pin } }), { code: 'IM_OWNER_PROFILE_UNAVAILABLE' });
    assert.equal(service.snapshot().revision, 1);
    assert.equal(service.snapshot().config.ownerProfileId, '');
    assert.equal(await readFile(join(dir, 'im-settings.json'), 'utf8'), bytes);
  }
  await assert.rejects(service.save({ expectedRevision: 1, config: { ...base, ownerProfileId: 'has space' } }), (e) => (e as { code?: string }).code === 'IM_SETTINGS_INVALID' || (e as { code?: string }).code === 'IM_OWNER_PROFILE_UNAVAILABLE');
});

test('关闭 Bot 且 pin 未变时可保存；修改 pin 触发 Master 重建但不重建 channel', async t => {
  const dir = await mkdtemp(join(ROOT, 'owner-pin-'));
  const live = policy();
  live.config.owners.second = { enabled: true, engine: 'codex', model: 'm2', effort: 'medium', workers: [], max_parallel: 1 };
  const inputs: ParentAgentInput[] = [];
  let closes = 0; let channels = 0;
  const f = fixture();
  const counting: ImChannelFactory = (c, h) => { channels++; return f.factory(c, h); };
  const service = new ImService({ dataDir: dir, policy: () => live, parentFactory: async (input) => { inputs.push(input); return { send: async () => 'ok', close: async () => { closes++; } }; }, channelFactory: counting });
  t.after(async () => { await service.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  const base = { enabled: true, appId: 'cli_test', appSecret: 'SECRET', allowedOpenIds: ['ou_a'], engine: 'codex', model: 'gpt-test', effort: 'medium', workspaces: [dir], idleTimeoutMinutes: 30, ownerProfileId: 'main' };
  await service.save({ expectedRevision: 0, config: base });
  await tick();
  assert.equal(channels, 1);
  const firstInstructions = inputs[0].instructions;
  assert.match(firstInstructions, /ownerProfileId=main/);
  const liveHandlers = f.handlers;
  await service.save({ expectedRevision: 1, config: { ...base, ownerProfileId: 'second' } });
  await tick();
  assert.equal(closes, 1);
  assert.equal(inputs.length, 2);
  assert.match(inputs[1].instructions, /ownerProfileId=second/);
  assert.notEqual(inputs[0].instructions, inputs[1].instructions);
  assert.equal(channels, 1, 'pin 变化只重建 Master，不重建 channel');
  assert.equal(f.handlers, liveHandlers);
  // Disable with unchanged pin succeeds even after the profile vanished.
  delete live.config.owners.second;
  await service.save({ expectedRevision: 2, config: { ...base, ownerProfileId: 'second', enabled: false } });
  await tick();
  assert.equal(service.snapshot().status.connection, 'disabled');
});
