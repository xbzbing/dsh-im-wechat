import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  QUOTE_MAX_ENTRIES,
  QUOTE_TTL_MS,
  QuoteMemory,
  quoteOf,
  quotedContent,
} from '../../src/host/quotes.ts';
import type { WeixinMessage } from '../../src/host/ilink/types.ts';

const NOW = 1_760_000_000_000;

/** 一条只有 item_list 的入站消息：本组测试只关心引用字段。 */
function message(itemList: unknown[]): WeixinMessage {
  return {
    message_id: '1000',
    from_user_id: 'owner-1',
    create_time_ms: NOW,
    item_list: itemList as WeixinMessage['item_list'],
  };
}

test('引用只带 svr_id 时拿出平台消息 id', () => {
  const quote = quoteOf(message([{ type: 1, text_item: { text: '这个呢' }, ref_msg: { svr_id: '3001' } }]));
  assert.deepEqual(quote, { messageId: '3001', inline: [] });
});

test('svr_id 优先于旧版 message_item.msg_id，两端空白去掉', () => {
  const quote = quoteOf(message([{
    type: 1,
    text_item: { text: '这个呢' },
    ref_msg: { svr_id: ' 3001 ', message_item: { type: 0, msg_id: 'v1:legacy' } },
  }]));
  assert.equal(quote?.messageId, '3001');
});

test('svr_id 缺失时退回 message_item.msg_id，数字形态也认', () => {
  const quote = quoteOf(message([{
    type: 1,
    text_item: { text: '这个呢' },
    ref_msg: { message_item: { type: 0, msg_id: 1234 } },
  }]));
  assert.equal(quote?.messageId, '1234');
});

test('超出安全整数的数字 id 不认：已经取整了，认了就是认到别的消息', () => {
  const quote = quoteOf(message([{
    type: 1,
    text_item: { text: '这个呢' },
    ref_msg: { title: '被引用的消息', message_item: { type: 0, msg_id: 9_007_199_254_740_993 } },
  }]));
  assert.deepEqual(quote, { title: '被引用的消息', inline: [] });
});

test('标题只是展示文案：没有 id 也带出来，供索引未命中时兜底', () => {
  const quote = quoteOf(message([{ type: 1, text_item: { text: '这个呢' }, ref_msg: { title: ' 被引用的消息 ' } }]));
  assert.deepEqual(quote, { title: '被引用的消息', inline: [] });
});

test('客户端一并带来的被引用内容也认：文字、图片、文件名', () => {
  assert.deepEqual(
    quoteOf(message([{ type: 1, ref_msg: { message_item: { type: 1, text_item: { text: '原文' } } } }]))?.inline,
    [{ kind: 'text', text: '原文' }],
  );
  assert.deepEqual(
    quoteOf(message([{ type: 1, ref_msg: { message_item: { type: 2, image_item: {} } } }]))?.inline,
    [{ kind: 'image' }],
  );
  assert.deepEqual(
    quoteOf(message([{ type: 1, ref_msg: { message_item: { type: 4, file_item: { file_name: 'a.pdf' } } } }]))?.inline,
    [{ kind: 'file', name: 'a.pdf' }],
  );
});

test('没有引用、或引用里什么都没有时不猜', () => {
  assert.equal(quoteOf(message([{ type: 1, text_item: { text: 'hi' } }])), undefined);
  assert.equal(quoteOf(message([{ type: 1, text_item: { text: 'hi' }, ref_msg: { title: '   ' } }])), undefined);
});

test('记一条消息带了什么：文件在前、其次图片、最后正文', () => {
  assert.deepEqual(quotedContent({ text: '看看', images: 2, files: ['a.pdf', 'b.pdf'] }), [
    { kind: 'file', name: 'a.pdf' },
    { kind: 'file', name: 'b.pdf' },
    { kind: 'image' },
    { kind: 'image' },
    { kind: 'text', text: '看看' },
  ]);
  assert.deepEqual(quotedContent({ text: '   ', images: 0, files: [] }), []);
});

test('引用命中索引时点名那个文件——这就是「这个文件」指的是哪一个', () => {
  const memory = new QuoteMemory();
  memory.remember('3001', quotedContent({ text: '请看这个文件', images: 0, files: ['报告.pdf'] }), NOW);
  assert.equal(
    memory.line({ messageId: '3001', inline: [] }, NOW),
    '[引用：文件 报告.pdf]',
  );
});

test('多个文件、多张图片分别拼成一句话', () => {
  const memory = new QuoteMemory();
  memory.remember('3001', quotedContent({ text: '', images: 0, files: ['a.pdf', 'b.pdf'] }), NOW);
  assert.equal(memory.line({ messageId: '3001', inline: [] }, NOW), '[引用：文件 a.pdf、b.pdf]');
  memory.remember('3002', quotedContent({ text: '', images: 3, files: [] }), NOW);
  assert.equal(memory.line({ messageId: '3002', inline: [] }, NOW), '[引用：图片 3 张]');
  memory.remember('3003', quotedContent({ text: '', images: 1, files: [] }), NOW);
  assert.equal(memory.line({ messageId: '3003', inline: [] }, NOW), '[引用：图片]');
});

test('索引没命中时依次退回客户端带来的内容与标题', () => {
  const memory = new QuoteMemory();
  assert.equal(
    memory.line({ messageId: '9999', inline: [{ kind: 'file', name: 'c.pdf' }] }, NOW),
    '[引用：文件 c.pdf]',
  );
  assert.equal(memory.line({ messageId: '9999', inline: [], title: '被引用的消息' }, NOW), '[引用：「被引用的消息」]');
  assert.equal(memory.line({ inline: [] }, NOW), undefined);
});

test('引用的正文压掉换行并截到 40 字', () => {
  const memory = new QuoteMemory();
  const long = `${'一二三四五六七八九十'.repeat(5)}\n第二行`;
  memory.remember('3001', quotedContent({ text: long, images: 0, files: [] }), NOW);
  const line = memory.line({ messageId: '3001', inline: [] }, NOW) ?? '';
  assert.equal(line, '[引用：「一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十…」]');
});

test('过了窗口就当没记过：只看得到标题', () => {
  const memory = new QuoteMemory();
  memory.remember('3001', quotedContent({ text: '', images: 0, files: ['a.pdf'] }), NOW);
  assert.equal(memory.line({ messageId: '3001', inline: [], title: '旧消息' }, NOW + QUOTE_TTL_MS + 1), '[引用：「旧消息」]');
});

test('正好到窗口边界仍算有效', () => {
  const memory = new QuoteMemory();
  memory.remember('3001', quotedContent({ text: '', images: 0, files: ['a.pdf'] }), NOW);
  assert.equal(memory.line({ messageId: '3001', inline: [] }, NOW + QUOTE_TTL_MS), '[引用：文件 a.pdf]');
});

test('引用自己（id 就是本条消息）按普通查找处理，不会递归', () => {
  const memory = new QuoteMemory();
  memory.remember('3001', quotedContent({ text: '', images: 0, files: ['a.pdf'] }), NOW);
  assert.equal(memory.line({ messageId: '3001', inline: [] }, NOW), '[引用：文件 a.pdf]');
});

test('文件名也压换行并截到 40 字：标头不该比它指的东西还长', () => {
  const memory = new QuoteMemory();
  const long = `${'名'.repeat(60)}\n第二行.pdf`;
  memory.remember('3001', quotedContent({ text: '', images: 0, files: [long] }), NOW);
  const line = memory.line({ messageId: '3001', inline: [] }, NOW) ?? '';
  assert.equal(line, `[引用：文件 ${'名'.repeat(40)}…]`);
});

test('条目数有上界：最早那条被挤出去', () => {
  const memory = new QuoteMemory();
  for (let index = 0; index <= QUOTE_MAX_ENTRIES; index += 1) {
    memory.remember(String(3000 + index), quotedContent({ text: '', images: 0, files: [`${index}.pdf`] }), NOW + index);
  }
  assert.equal(memory.line({ messageId: '3000', inline: [], title: '最早' }, NOW), '[引用：「最早」]');
  assert.equal(memory.line({ messageId: '3001', inline: [] }, NOW), '[引用：文件 1.pdf]');
});

test('没有平台 id 或没有内容的条目不入索引', () => {
  const memory = new QuoteMemory();
  memory.remember(undefined, quotedContent({ text: '', images: 0, files: ['a.pdf'] }), NOW);
  memory.remember('3001', [], NOW);
  assert.equal(memory.line({ messageId: '3001', inline: [] }, NOW), undefined);
});
