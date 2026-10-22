import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '@larksuite/channel';
import { extractInboundText } from '../../src/main/im/inbound';

async function textMsg(id: string, text: string, now = Date.now()) {
  const event = {
    sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' },
    message: {
      message_id: id,
      chat_id: 'oc_a',
      chat_type: 'p2p' as const,
      message_type: 'text',
      create_time: String(now),
      content: JSON.stringify({ text }),
    },
  };
  return normalize(event, { botIdentity: { openId: "ou_bot", name: "t" }, includeRaw: true });
}

test('普通text字面文本不误拒且以raw为准', async () => {
  for (const literal of ['<file>', '[rich text message]', '[unsupported message]']) {
    const m = await textMsg(`om_text_${literal.length}`, literal);
    const r = extractInboundText(m);
    assert.equal(r.kind, 'ok');
    assert.equal(r.text, literal);
  }
});

test('text伪造normalized不能覆盖raw', async () => {
  const m = await textMsg('om_text_forge', '真实正文');
  const forged = { ...m, content: '伪造内容' };
  const r = extractInboundText(forged as typeof m);
  assert.equal(r.kind, 'ok');
  assert.equal(r.text, '真实正文');
});

async function postMsg(id: string, contentObj: unknown, now = Date.now()) {
  const event = {
    sender: { sender_id: { open_id: 'ou_a' }, sender_type: 'user' },
    message: {
      message_id: id,
      chat_id: 'oc_a',
      chat_type: 'p2p' as const,
      message_type: 'post',
      create_time: String(now),
      content: typeof contentObj === 'string' ? contentObj : JSON.stringify(contentObj),
    },
  };
  return normalize(event, { botIdentity: { openId: "ou_bot", name: "t" }, includeRaw: true });
}

test('post普通/标题/多段/链接经SDK保留正文', async () => {
  const m = await postMsg('om_post_ok', {
    title: '我的标题',
    content: [
      [{ tag: 'text', text: '在 weaver 做几个优化：', style: [] }],
      [{ tag: 'text', text: '1. ' }, { tag: 'text', text: 'bot 页面优化' }],
      [{ tag: 'text', text: '看 ' }, { tag: 'a', text: '文档', href: 'https://example.com' }],
    ],
  });
  assert.equal(m.rawContentType, 'post');
  const r = extractInboundText(m);
  assert.equal(r.kind, 'ok');
  assert.match(r.text!, /我的标题/);
  assert.match(r.text!, /bot 页面优化/);
  assert.match(r.text!, /example\.com/);
});

test('post多语言content_v2优先且有意义', async () => {
  const m = await postMsg('om_post_v2', {
    title: '',
    content: [[{ tag: 'text', text: '旧段' }]],
    content_v2: [[{ tag: 'text', text: '新段一' }], [{ tag: 'text', text: '新段二' }]],
  });
  const r = extractInboundText(m);
  assert.equal(r.kind, 'ok');
  assert.match(r.text!, /新段一/);
});

test('post真实zh_cn locale wrapper正文完整', async () => {
  const m = await postMsg('om_post_locale', {
    zh_cn: { title: '中文标题', content: [[{ tag: 'text', text: '中文正文段' }]] },
  });
  const r = extractInboundText(m);
  assert.equal(r.kind, 'ok');
  assert.match(r.text!, /中文标题/);
  assert.match(r.text!, /中文正文段/);
});

test('空白/畸形/仅附件post给feedback不给占位符', async () => {
  const blank = await postMsg('om_post_blank', { title: '', content: [[{ tag: 'text', text: '   ' }]] });
  const rb = extractInboundText(blank);
  assert.equal(rb.kind, 'feedback');
  const malformed = await postMsg('om_post_bad', 'not-json{{{');
  const rm = extractInboundText(malformed);
  assert.equal(rm.kind, 'feedback');
  const attach = await postMsg('om_post_att', {
    title: '',
    content: [[{ tag: 'text', text: '' }]],
    files: [{ file_key: 'k1', file_name: 'a.txt' }],
  });
  const ra = extractInboundText(attach);
  assert.equal(ra.kind, 'feedback');
  for (const r of [rb, rm, ra]) {
    if (r.kind === 'feedback') {
      assert.ok(!r.notice.includes('[rich text message]'));
      assert.ok(!r.notice.includes('k1'));
    }
  }
});

test('超长post给feedback', async () => {
  const big = 'x'.repeat(16_001);
  const m = await postMsg('om_post_big', { title: '', content: [[{ tag: 'text', text: big }]] });
  const r = extractInboundText(m);
  assert.equal(r.kind, 'feedback');
});

test('类型不一致与不支持类型保持silent', async () => {
  const m = await postMsg('om_post_forge', { title: '', content: [[{ tag: 'text', text: 'hi' }]] });
  const forged = { ...m, rawContentType: 'text' };
  assert.equal(extractInboundText(forged as typeof m).kind, 'silent');
});
