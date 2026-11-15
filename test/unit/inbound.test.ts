import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { downloadOwnerFiles, downloadOwnerImages, toOwnerMessageDraft } from '../../src/host/inbound.ts';
import type { WeixinMessage } from '../../src/host/ilink/types.ts';
import { CDN, PDF, PNG, encrypt, fileMessage, imageFetch, imageMessage } from './helpers/inbound-fixtures.ts';

test('纯文本消息原样转成草稿', async () => {
  const draft = await toOwnerMessageDraft(
    { message_id: '1', from_user_id: 'owner-1', create_time_ms: 5, item_list: [{ type: 1, text_item: { text: '/status' } }] },
    { account: 'bot' },
  );
  assert.deepEqual(draft, {
    messageId: 'weixin:v1:bot:owner-1:mid:1',
    // 平台 id 与渠道 id 不是一回事：核心按它认回「用户引用了哪一条」。
    platformMessageId: '1',
    sender: 'owner-1',
    text: '/status',
    at: 5,
  });
});

test('引用消息把被引用消息的平台 id 带进 replyTo', async () => {
  const draft = await toOwnerMessageDraft(
    {
      message_id: '1', from_user_id: 'owner-1', create_time_ms: 5,
      item_list: [{
        type: 1,
        msg_id: 'v1:1658853100243168092',
        text_item: { text: '测试引用回复' },
        ref_msg: { message_item: { type: 0, msg_id: '7526724741542363528' } },
      }],
    },
    { account: 'bot' },
  );
  assert.equal(draft?.replyTo, '7526724741542363528');
});

test('新版客户端只带 svr_id：照样带进 replyTo', async () => {
  const draft = await toOwnerMessageDraft(
    {
      message_id: '1', from_user_id: 'owner-1', create_time_ms: 5,
      item_list: [{ type: 1, text_item: { text: '好' }, ref_msg: { svr_id: '9007199254740993' } }],
    },
    { account: 'bot' },
  );
  assert.equal(draft?.replyTo, '9007199254740993');
});

test('svr_id 与 message_item.msg_id 同时在时取 svr_id', async () => {
  const draft = await toOwnerMessageDraft(
    {
      message_id: '1', from_user_id: 'owner-1', create_time_ms: 5,
      item_list: [{
        type: 1, text_item: { text: '好' },
        ref_msg: { svr_id: ' 900 ', message_item: { type: 0, msg_id: 'v1:legacy' } },
      }],
    },
    { account: 'bot' },
  );
  assert.equal(draft?.replyTo, '900');
});

test('多个内容项时取第一个带引用的', async () => {
  const draft = await toOwnerMessageDraft(
    {
      message_id: '1', from_user_id: 'owner-1', create_time_ms: 5,
      item_list: [
        { type: 1, text_item: { text: '前半句' } },
        { type: 1, text_item: { text: '后半句' }, ref_msg: { message_item: { type: 0, msg_id: ' 7526724741542363528 ' } } },
      ],
    },
    { account: 'bot' },
  );
  assert.equal(draft?.replyTo, '7526724741542363528');
});

test('引用只有标题、没有 id 时不带 replyTo', async () => {
  const draft = await toOwnerMessageDraft(
    {
      message_id: '1', from_user_id: 'owner-1', create_time_ms: 5,
      item_list: [{ type: 1, text_item: { text: '好' }, ref_msg: { title: '被引用的消息' } }],
    },
    { account: 'bot' },
  );
  assert.equal(draft?.replyTo, undefined);
});

test('没有引用、或引用里没有 msg_id 时不带 replyTo', async () => {
  const plain = await toOwnerMessageDraft(
    { message_id: '1', from_user_id: 'owner-1', create_time_ms: 5, item_list: [{ type: 1, text_item: { text: 'hi' } }] },
    { account: 'bot' },
  );
  assert.equal(plain?.replyTo, undefined);
  const empty = await toOwnerMessageDraft(
    {
      message_id: '2', from_user_id: 'owner-1', create_time_ms: 6,
      item_list: [{ type: 1, text_item: { text: 'hi' }, ref_msg: { message_item: { type: 0 } } }],
    },
    { account: 'bot' },
  );
  assert.equal(empty?.replyTo, undefined);
});

test('没有任何内容的消息不产出草稿', async () => {
  assert.equal(await toOwnerMessageDraft({ from_user_id: 'owner-1' }, { account: 'bot' }), null);
  assert.equal(
    await toOwnerMessageDraft({ message_id: '1', from_user_id: 'owner-1', item_list: [] }, { account: 'bot' }),
    null,
  );
});

test('核心没声明 owner-images 时不下载图片', async () => {
  const fetch = imageFetch([PNG]);
  const draft = await toOwnerMessageDraft(imageMessage(1).message, {
    account: 'bot',
    cdnBaseUrl: CDN,
    fetch: fetch.impl,
  });
  assert.equal(fetch.calls(), 0);
  assert.equal(draft?.images, undefined);
});

test('声明 owner-images 时下载、解密并按核心约束组装', async () => {
  const key = randomBytes(16);
  const ciphertext = encrypt(PNG, key);
  const message: WeixinMessage = {
    message_id: '2002',
    from_user_id: 'owner-1',
    create_time_ms: 7,
    item_list: [
      { type: 2, msg_id: 'img-0', image_item: { media: { encrypt_query_param: 'p', aes_key: key.toString('base64') } } },
    ],
  };
  const fetch = imageFetch([ciphertext]);
  const draft = await toOwnerMessageDraft(message, {
    account: 'bot',
    cdnBaseUrl: CDN,
    imagesEnabled: true,
    senderIsOwner: () => true,
    fetch: fetch.impl,
  });
  assert.equal(draft?.text, '');
  assert.equal(draft?.images?.length, 1);
  const image = draft?.images?.[0];
  assert.equal(image?.mediaType, 'image/png');
  assert.equal(image?.name, 'weixin-img-0.png');
  assert.equal(Buffer.from(image?.data ?? '', 'base64').equals(PNG), true);
  assert.equal((image?.data ?? '').length % 4, 0);
});

test('非主人不下载图片，但文本照常交给核心判定', async () => {
  const fetch = imageFetch([PNG]);
  const draft = await toOwnerMessageDraft(imageMessage(1).message, {
    account: 'bot',
    cdnBaseUrl: CDN,
    imagesEnabled: true,
    senderIsOwner: () => false,
    fetch: fetch.impl,
  });
  assert.equal(fetch.calls(), 0);
  assert.equal(draft?.text, '看这张');
  assert.equal(draft?.images, undefined);
});

test('最多 9 张，多出来的忽略', async () => {
  const built = imageMessage(12);
  const fetch = imageFetch([built.payload]);
  const draft = await toOwnerMessageDraft(built.message, {
    account: 'bot',
    cdnBaseUrl: CDN,
    imagesEnabled: true,
    senderIsOwner: () => true,
    fetch: fetch.impl,
  });
  assert.equal(draft?.images?.length, 9);
  assert.equal(fetch.calls(), 9);
});

test('声明了图片但没有身份判定时按纯文本处理，不下载', async () => {
  // 声明缺席（核心未声明 owner-lookup / isOwner 不可用）不能当成「允许」：
  // 否则任意微信用户发图即可驱动本机出站下载（ADR-0004）。
  const fetch = imageFetch([PNG]);
  const draft = await toOwnerMessageDraft(imageMessage(1).message, {
    account: 'bot',
    cdnBaseUrl: CDN,
    imagesEnabled: true,
    fetch: fetch.impl,
  });
  assert.equal(fetch.calls(), 0);
  assert.equal(draft?.text, '看这张');
  assert.equal(draft?.images, undefined);
});

test('坏图片被丢弃，其余照常', async () => {
  const built = imageMessage(2);
  const fetch = imageFetch([Buffer.from('not an image')]);
  const draft = await toOwnerMessageDraft(built.message, {
    account: 'bot',
    cdnBaseUrl: CDN,
    imagesEnabled: true,
    senderIsOwner: () => true,
    fetch: fetch.impl,
  });
  assert.equal(draft?.images, undefined);
  assert.equal(draft?.text, '看这张');
});

test('只有图没有文字时 text 为空串而不是缺字段', async () => {
  const key = randomBytes(16);
  const message: WeixinMessage = {
    message_id: '2003',
    from_user_id: 'owner-1',
    item_list: [
      { type: 2, msg_id: 'i', image_item: { media: { encrypt_query_param: 'p', aes_key: key.toString('base64') } } },
    ],
  };
  const fetch = imageFetch([encrypt(PNG, key)]);
  const draft = await toOwnerMessageDraft(message, {
    account: 'bot',
    cdnBaseUrl: CDN,
    imagesEnabled: true,
    senderIsOwner: () => true,
    fetch: fetch.impl,
  });
  assert.equal(draft?.text, '');
  assert.equal(draft?.images?.length, 1);
});

test('独立模式：不依赖核心声明，主人发的图直接下载', async () => {
  const built = imageMessage(1);
  const fetch = imageFetch([built.payload]);
  const images = await downloadOwnerImages(built.message, {
    cdnBaseUrl: CDN,
    senderIsOwner: () => true,
    fetch: fetch.impl,
  });
  assert.equal(images.length, 1);
  assert.equal(images[0]?.mediaType, 'image/png');
  assert.equal(images[0]?.name, 'weixin-img-0.png');
  assert.equal(Buffer.from(images[0]?.data ?? '', 'base64').equals(PNG), true);
});

test('独立模式：非主人发的图一律不下载', async () => {
  const built = imageMessage(1);
  const fetch = imageFetch([built.payload]);
  const images = await downloadOwnerImages(built.message, {
    cdnBaseUrl: CDN,
    senderIsOwner: () => false,
    fetch: fetch.impl,
  });
  assert.equal(fetch.calls(), 0);
  assert.deepEqual(images, []);
});

test('没有图片条目时不发任何请求', async () => {
  const fetch = imageFetch([PNG]);
  const images = await downloadOwnerImages(
    { message_id: '1', from_user_id: 'owner-1', item_list: [{ type: 1, text_item: { text: 'hi' } }] },
    { cdnBaseUrl: CDN, senderIsOwner: () => true, fetch: fetch.impl },
  );
  assert.equal(fetch.calls(), 0);
  assert.deepEqual(images, []);
});

test('文件只给主人下载：非主人整条不处理', async () => {
  const built = fileMessage(1);
  const fetch = imageFetch(built.payloads);
  const result = await downloadOwnerFiles(built.message, {
    cdnBaseUrl: CDN,
    fetch: fetch.impl,
    senderIsOwner: () => false,
  });
  assert.equal(fetch.calls(), 0);
  assert.deepEqual(result, { files: [], dropped: [] });
});

test('主人发的文件按原文件名下载解密', async () => {
  const built = fileMessage(1, { names: ['报告.pdf'] });
  const fetch = imageFetch(built.payloads);
  const result = await downloadOwnerFiles(built.message, {
    cdnBaseUrl: CDN,
    fetch: fetch.impl,
    senderIsOwner: (sender) => sender === 'owner-1',
  });
  assert.equal(fetch.calls(), 1);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.name, '报告.pdf');
  assert.deepEqual(Buffer.from(result.files[0]?.bytes ?? []), PDF);
  assert.deepEqual(result.dropped, []);
});

test('文件名清洗掉路径分隔符与控制字符，清洗后为空才用序号', async () => {
  const built = fileMessage(2, { names: ['../报告.pdf', 'a/b\\c\nd.pdf'] });
  const fetch = imageFetch(built.payloads);
  const result = await downloadOwnerFiles(built.message, {
    cdnBaseUrl: CDN,
    fetch: fetch.impl,
    senderIsOwner: () => true,
  });
  assert.deepEqual(result.files.map((file) => file.name), ['报告.pdf', 'a_b_c_d.pdf']);

  const unnamed = fileMessage(1, { names: ['  ..  '] });
  const other = await downloadOwnerFiles(unnamed.message, {
    cdnBaseUrl: CDN,
    fetch: imageFetch(unnamed.payloads).impl,
    senderIsOwner: () => true,
  });
  assert.equal(other.files[0]?.name, 'weixin-file-1');
});

test('超过总量上限的文件按 len 预检，不发起下载', async () => {
  const built = fileMessage(1, { names: ['大文件.pdf'] });
  const message = { ...built.message, item_list: [{ type: 4, file_item: { ...built.message.item_list?.[0]?.file_item, len: '999999999' } }] };
  const fetch = imageFetch(built.payloads);
  const result = await downloadOwnerFiles(message, {
    cdnBaseUrl: CDN,
    fetch: fetch.impl,
    senderIsOwner: () => true,
  });
  assert.equal(fetch.calls(), 0);
  assert.deepEqual(result.files, []);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0]?.name, '大文件.pdf');
  assert.match(result.dropped[0]?.reason ?? '', /上限/);
});

test('一条消息最多收 3 个文件，超出部分不下载', async () => {
  const built = fileMessage(5);
  const fetch = imageFetch(built.payloads);
  const result = await downloadOwnerFiles(built.message, {
    cdnBaseUrl: CDN,
    fetch: fetch.impl,
    senderIsOwner: () => true,
  });
  assert.equal(fetch.calls(), 3);
  assert.equal(result.files.length, 3);
});

test('文件共享同一份总量预算：前一个占满后，后一个不下载', async () => {
  const built = fileMessage(2);
  const fetch = imageFetch(built.payloads);
  const result = await downloadOwnerFiles(built.message, {
    cdnBaseUrl: CDN,
    fetch: fetch.impl,
    senderIsOwner: () => true,
    maxBytes: PDF.length,
  });
  assert.equal(fetch.calls(), 1);
  assert.equal(result.files.length, 1);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0]?.reason ?? '', /上限/);
});

test('解不出来的文件跳过、其余照常，原因不带 URL 与密钥', async () => {
  const built = fileMessage(2);
  const fetch = imageFetch([Buffer.from('not ciphertext'), built.payloads[1] ?? Buffer.alloc(0)]);
  const result = await downloadOwnerFiles(built.message, {
    cdnBaseUrl: CDN,
    fetch: fetch.impl,
    senderIsOwner: () => true,
  });
  assert.equal(fetch.calls(), 2);
  assert.equal(result.files.length, 1);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0]?.reason ?? '', /解密失败/);
  assert.equal(result.dropped[0]?.name, 'file-0.pdf');
});

test('没有文件项的消息返回空结果', async () => {
  const result = await downloadOwnerFiles(
    { message_id: '1', from_user_id: 'owner-1', item_list: [{ type: 1, text_item: { text: 'hi' } }] },
    { cdnBaseUrl: CDN, senderIsOwner: () => true },
  );
  assert.deepEqual(result, { files: [], dropped: [] });
});

test('文件项缺少 media 引用时记一条原因', async () => {
  const result = await downloadOwnerFiles(
    { message_id: '1', from_user_id: 'owner-1', item_list: [{ type: 4, file_item: { file_name: 'x.pdf' } }] },
    { cdnBaseUrl: CDN, senderIsOwner: () => true },
  );
  assert.deepEqual(result.files, []);
  assert.match(result.dropped[0]?.reason ?? '', /缺少 media/);
});

test('接入核心时文件不进草稿：只有文件的消息不产出草稿', async () => {
  const built = fileMessage(1);
  const fetch = imageFetch(built.payloads);
  const draft = await toOwnerMessageDraft(built.message, {
    account: 'bot',
    cdnBaseUrl: CDN,
    fetch: fetch.impl,
    imagesEnabled: true,
    senderIsOwner: () => true,
  });
  assert.equal(fetch.calls(), 0, '核心协议没有文件能力，不下载');
  assert.equal(draft, null);
});

test('接入核心时文字与文件一起发：草稿只带文字', async () => {
  const built = fileMessage(1, { text: '看下这个 pdf' });
  const draft = await toOwnerMessageDraft(built.message, { account: 'bot' });
  assert.equal(draft?.text, '看下这个 pdf');
  assert.equal(draft?.images, undefined);
});

test('超过 3 个文件的部分合成一条原因，不静默丢掉', async () => {
  const built = fileMessage(5);
  const fetch = imageFetch(built.payloads);
  const result = await downloadOwnerFiles(built.message, {
    cdnBaseUrl: CDN,
    fetch: fetch.impl,
    senderIsOwner: () => true,
  });
  assert.equal(result.files.length, 3);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0]?.name, '其余 2 个文件');
  assert.match(result.dropped[0]?.reason ?? '', /最多 3 个/);
});

test('过长的中文文件名按字节截断，扩展名保留', async () => {
  const long = `${'报告'.repeat(120)}.pdf`;
  const built = fileMessage(1, { names: [long] });
  const result = await downloadOwnerFiles(built.message, {
    cdnBaseUrl: CDN,
    fetch: imageFetch(built.payloads).impl,
    senderIsOwner: () => true,
  });
  const name = result.files[0]?.name ?? '';
  assert.ok(Buffer.byteLength(name, 'utf8') <= 200, '不超过宿主再清洗时的余量');
  assert.ok(name.endsWith('.pdf'), '扩展名不能被截掉');
});

test('草稿同时带自己的平台 id 与被引用 id：核心才认得出引用了哪一条', async () => {
  const draft = await toOwnerMessageDraft(
    {
      message_id: '1700000000000000001', from_user_id: 'owner-1', create_time_ms: 5,
      item_list: [{ type: 1, text_item: { text: '这个文件的作者是谁？' }, ref_msg: { svr_id: '1700000000000000002' } }],
    },
    { account: 'bot' },
  );
  assert.equal(draft?.messageId, 'weixin:v1:bot:owner-1:mid:1700000000000000001');
  assert.equal(draft?.platformMessageId, '1700000000000000001');
  assert.equal(draft?.replyTo, '1700000000000000002');
});

test('没有平台 message_id 时不编一个平台 id', async () => {
  const draft = await toOwnerMessageDraft(
    { message_id: undefined, client_id: 'c-1', from_user_id: 'owner-1', create_time_ms: 5, item_list: [{ type: 1, text_item: { text: '在吗' } }] },
    { account: 'bot' },
  );
  assert.equal(draft?.messageId, 'weixin:v1:bot:owner-1:cid:c-1');
  assert.equal(draft && 'platformMessageId' in draft, false);
});
