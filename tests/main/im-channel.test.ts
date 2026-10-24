import test from 'node:test';
import assert from 'node:assert/strict';
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { createImChannelTransport, type Delivery } from '../../src/main/im/channel';
import type { LarkChannel, LarkChannelOptions, MarkdownStreamProducer } from '@larksuite/channel';
const config={enabled:true,appId:'cli_test',appSecret:'SECRET_CANARY',allowedOpenIds:['ou_a'],channel:"default_codex",model:'gpt-test',effort:'medium',workspaces:['/tmp'],idleTimeoutMinutes: 30, ownerProfileId: ''};
const noop=()=>{};
const handlers={message:noop,card:()=>({}),menu:noop,error:noop,connecting:noop,connected:noop};
test('发布版 EventDispatcher 展平 header 并保留真实 open_id/message/context，callback toast 返回给协议层',async()=>{
 const dispatcher=new EventDispatcher({logger:{error:noop,warn:noop,info:noop,debug:noop,trace:noop}});
 let received:any;
 dispatcher.register({'im.message.receive_v1':event=>{received=event;},'card.action.trigger':()=>({toast:{type:'success',content:'已作为新消息发送'}})});
 const event={sender:{sender_id:{open_id:'ou_a'},sender_type:'user'},message:{message_id:'om_a',chat_id:'oc_a',chat_type:'p2p',message_type:'text',create_time:'1780000000000',content:'{"text":"你好"}'}};
 await dispatcher.invoke({schema:'2.0',header:{event_id:'evt_message',event_type:'im.message.receive_v1',app_id:'cli_test'},event},{needCheck:false});
 assert.equal(received.event_id,'evt_message');assert.deepEqual(received.sender,event.sender);assert.deepEqual(received.message,event.message);
 const response=await dispatcher.invoke({schema:'2.0',header:{event_id:'evt_click',event_type:'card.action.trigger'},event:{context:{open_message_id:'om_card',open_chat_id:'oc_a'},operator:{open_id:'ou_a'},action:{value:{nonce:'n',actionId:'a'}}}},{needCheck:false});
 assert.deepEqual(response,{toast:{type:'success',content:'已作为新消息发送'}});
});
test('SDK定时更新吞掉业务code错误时stream仍失败；logger不传原secret对象',async()=>{
 let opts!:LarkChannelOptions;let errors=0;
 const channel=createImChannelTransport(config,{...handlers,error:()=>{errors++;}},{createChannel:o=>{
   opts=o;
   return {on:noop,onRawEvent:noop,stream:async(_to:string,input:{markdown:MarkdownStreamProducer})=>{
    await input.markdown({messageId:'om_bot',append:async()=>{},setContent:async()=>{}});
    await new Promise<void>(resolve=>setTimeout(()=>{void opts.httpInstance!.request({url:'https://fixture.invalid/card',method:'PATCH'}).catch(()=>{}).finally(resolve);},1));
    return {messageId:'om_bot'};
   }} as unknown as LarkChannel;
 }});
 // Real axios interceptors and request lifecycle, fake only network adapter.
 const http=opts.httpInstance as any;http.defaults.adapter=async(request:any)=>({status:200,statusText:'OK',headers:{},config:request,data:{code:230099,msg:'SECRET_CANARY'}});
 const delivery:Delivery={valid:()=>true,failed:false,abort:new AbortController()};
 await assert.rejects(channel.stream('oc_a',async()=>{},delivery),/IM_DELIVERY_FAILED/);assert.equal(delivery.failed,true);assert.equal(errors,1);
 opts.logger!.error(new Error('SECRET_CANARY'));assert.equal(errors,2);
 assert.equal(opts.safety?.chatQueue?.enabled,false);assert.ok(opts.outbound!.streamMaxElementChars!>20_000);
});
test('连接进行中close等待late connect并再次force-close，不能残留晚WS',async()=>{
 let finish!:()=>void;let rawCloses=0;let disconnects=0;
 const pending=new Promise<void>(resolve=>{finish=resolve;});
 const raw={close:()=>{rawCloses++;},getConnectionStatus:()=>({state:'connected'})};
 const transport=createImChannelTransport(config,handlers,{createChannel:()=>({on:noop,onRawEvent:noop,connect:()=>pending,disconnect:async()=>{disconnects++;},rawWsClient:raw}) as unknown as LarkChannel});
 const start=transport.connect();const closing=transport.close();assert.ok(rawCloses>=1);finish();await start;await closing;assert.ok(rawCloses>=3);assert.equal(disconnects,1);
});

// Use the actual released Channel, Client, Markdown controller and CardKit sequence logic.
// Only axios' external HTTP adapter is replaced; no private SDK objects are read or patched.
async function sdkFixture() {
 const {createLarkChannel}=await import('@larksuite/channel');
 const requests:{path:string;method:string;body:any;signal?:AbortSignal}[]=[];let errors=0;let finalFailure=false;
 let intercept:((request:(typeof requests)[number])=>Promise<void>)|undefined;
 const transport=createImChannelTransport(config,{...handlers,error:()=>{errors++;}},{createChannel:opts=>{
  const http=opts.httpInstance as any;
  http.defaults.adapter=async(request:any)=>{
   const path=new URL(request.url,'https://fixture.invalid').pathname;
   const body=typeof request.data==='string'?JSON.parse(request.data):request.data;
   const item={path,method:request.method,body,signal:request.signal};requests.push(item);await intercept?.(item);
   let data:any={};
   if(path.includes('tenant_access_token'))data={tenant_access_token:'fixture-token',expire:3600};
   else if(path.endsWith('/cardkit/v1/cards')&&request.method==='post')data={card_id:'card_actual'};
   else if(path.endsWith('/im/v1/messages')&&request.method==='post')data={message_id:'om_actual'};
   return {status:200,statusText:'OK',headers:{},config:request,data:{code:finalFailure&&path.endsWith('/cards/card_actual')&&request.method==='put'?230099:0,...(path.includes('tenant_access_token')?data:{data})}};
  };
  return createLarkChannel(opts);
 }});
 return {transport,requests,failFinal:()=>{finalFailure=true;},setIntercept:(next:typeof intercept)=>{intercept=next;},get errors(){return errors;}};
}
test('实际SDK原生stream完成后同CardKit实体最终更新，真实message/card绑定和sequence严格递增',async()=>{
 const f=await sdkFixture();const delivery:Delivery={valid:()=>true,failed:false,abort:new AbortController()};
 let show!:()=>void;const visible=new Promise<void>(resolve=>{show=resolve;});let finish!:()=>void;const finishing=new Promise<void>(resolve=>{finish=resolve;});let settled=false;
 f.setIntercept(async request=>{if(request.path.endsWith('/content'))show();});
 const stream=f.transport.stream('oc_fixture',async controller=>{assert.equal(controller.messageId,'om_actual');await controller.append('公开增量'.repeat(30));await finishing;await controller.setContent('权威最终正文');},delivery).finally(()=>{settled=true;});
 await visible;assert.equal(settled,false,'producer尚未final时已实际发起SDK content HTTP');assert.ok(f.requests.some(r=>r.path.endsWith('/content')&&r.body.content.includes('公开增量')));finish();const id=await stream;
 const before=f.requests.filter(r=>r.body&&typeof r.body.sequence==='number');const highest=Math.max(...before.map(r=>r.body.sequence));
 await assert.rejects(f.transport.updateCard('om_forged',{schema:'2.0'},delivery),/BINDING/);
 await f.transport.updateCard(id,{schema:'2.0',config:{streaming_mode:false},body:{elements:[{tag:'markdown',content:'权威最终正文'}]}},delivery);
 const final=f.requests.at(-1)!;assert.equal(final.path,'/open-apis/cardkit/v1/cards/card_actual');assert.equal(final.method,'put');assert.equal(final.body.sequence,highest+1);assert.equal(JSON.parse(final.body.card.data).body.elements[0].content,'权威最终正文');
 assert.ok(before.some(r=>r.path.endsWith('/content')));assert.ok(before.some(r=>r.path.endsWith('/settings')));assert.equal(f.requests.some(r=>r.path.includes('/im/v1/messages/')&&r.method==='patch'),false);assert.equal(f.errors,0);await f.transport.close();
});
test('实际SDK主动stop时晚flush不毒化连接，取消后固定终态超过结果不确定的sequence',async()=>{
 const f=await sdkFixture();let live=true;let started!:()=>void;const began=new Promise<void>(r=>{started=r;});let observedAbort=false;
 f.setIntercept(async request=>{if(request.path.endsWith('/content')) {started();await new Promise<void>((resolve,reject)=>{if(request.signal?.aborted){observedAbort=true;reject(new Error('aborted'));return;}request.signal?.addEventListener('abort',()=>{observedAbort=true;reject(new Error('aborted'));},{once:true});});}});
 const delivery:Delivery={valid:()=>live,failed:false,abort:new AbortController()};
 const streaming=f.transport.stream('oc_fixture',async controller=>{await controller.append('可见增量'.repeat(40));},delivery);
 await began;live=false;delivery.abort.abort();await assert.rejects(streaming);assert.equal(observedAbort,true);assert.equal(f.errors,0);assert.equal(delivery.failed,false);
 const maximum=Math.max(...f.requests.map(r=>r.body?.sequence??0));f.setIntercept(undefined);await f.transport.retireCard(delivery,()=>true);
 const final=f.requests.at(-1)!;assert.equal(final.path,'/open-apis/cardkit/v1/cards/card_actual');assert.equal(final.body.sequence,maximum+1);assert.equal(JSON.parse(final.body.card.data).config.streaming_mode,false);assert.match(final.body.card.data,/已停止/);assert.equal(f.errors,0);await f.transport.close();
});
test('真实HTTP错误仍error，自己标记abort不把网络失败倒归为主动取消',async()=>{
 const f=await sdkFixture();f.setIntercept(async request=>{if(request.path.endsWith('/content'))throw new Error('PRIVATE_NETWORK_DETAIL');});
 const delivery:Delivery={valid:()=>true,failed:false,abort:new AbortController()};await assert.rejects(f.transport.stream('oc_fixture',async c=>{await c.append('x'.repeat(120));},delivery));assert.ok(f.errors>0);assert.equal(delivery.failed,true);assert.equal(delivery.abort.signal.aborted,true);await f.transport.close();
});
test('停止卡片终态清理5秒超时实际abort HTTP，不恢复旧Agent文字或误报连接错误',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await sdkFixture();const delivery:Delivery={valid:()=>true,failed:false,abort:new AbortController()};
 await f.transport.stream('oc_fixture',async c=>{await c.setContent('正常完成');},delivery);delivery.abort.abort();let began!:()=>void;const started=new Promise<void>(r=>{began=r;});let active=0;let aborted=0;
 f.setIntercept(async request=>{if(request.path.endsWith('/cards/card_actual')&&request.method==='put'){active++;began();await new Promise<never>((_resolve,reject)=>{request.signal?.addEventListener('abort',()=>{active--;aborted++;reject(new Error('cancelled'));},{once:true});});}});
 const cleaning=f.transport.retireCard(delivery,()=>true);await started;t.mock.timers.tick(5_000);await cleaning;await new Promise<void>(r=>setImmediate(r));assert.equal(active,0);assert.equal(aborted,1);assert.equal(f.errors,0);assert.match(f.requests.at(-1)!.body.card.data,/已停止/);await f.transport.close();
});
test('最终实体PUT业务失败不可报告已送达；撤权管理guard不发旧卡请求',async()=>{
 const f=await sdkFixture();const delivery:Delivery={valid:()=>true,failed:false,abort:new AbortController()};const messageId=await f.transport.stream('oc_fixture',async c=>{await c.setContent('完成正文');},delivery);
 const count=f.requests.length;await f.transport.retireCard(delivery,()=>false);assert.equal(f.requests.length,count);
 f.failFinal();await assert.rejects(f.transport.updateCard(messageId,{schema:'2.0'},delivery));assert.equal(delivery.failed,true);assert.ok(f.errors>0);await f.transport.close();
});
