import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicDeltaFilter, parseReply, replyCard } from '../../src/main/im/cards';
test('控制标记每种拆分、未闭合/超长/非法 JSON 都不暴露协议',()=>{
 const marker='<weaver-actions>';
 for(let n=0;n<=marker.length;n++) {const f=new PublicDeltaFilter();const out=f.push('正文'+marker.slice(0,n))+f.push(marker.slice(n)+'SECRET')+f.finish();assert.equal(out,'正文');}
 for(const tail of ['not json','{"actions":[]}garbage','x'.repeat(10_000)]) assert.deepEqual(parseReply(`正文${marker}${tail}`),{text:'正文',actions:[]});
 for(let n=1;n<marker.length;n++) assert.deepEqual(parseReply('正文'+marker.slice(0,n)+'\n '),{text:'正文',actions:[]});
 for(const malformed of ['<weaver-actions ', '<weaver-actions\n', '<weaver-actions']) {const f=new PublicDeltaFilter();assert.equal(f.push('正文'+malformed)+f.push('PRIVATE_JSON')+f.finish(),'正文');assert.deepEqual(parseReply('正文'+malformed+'PRIVATE_JSON'),{text:'正文',actions:[]});}
 assert.equal(parseReply('正文<weaver-actions>{"actions":[{"label":"继续","message":"下一步"}]}</weaver-actions>\n ').actions.length,1);
  assert.equal(parseReply('正文<weaver-actions>{"actions":[{"label":"a","message":"b","command":"evil"}]}</weaver-actions>').actions.length,0);
});
test('正文卡片是 markdown 元素并原样保留加粗与段落',()=>{
  const text='第一段**关键结果**。\n\n第二段列表：\n- 第一项\n- 第二项';
  const card=replyCard(text) as {body:{elements:{tag:string;content?:string}[]}};
  assert.equal(card.body.elements[0]?.tag,'markdown');
  assert.equal(card.body.elements[0]?.content,text);
});
