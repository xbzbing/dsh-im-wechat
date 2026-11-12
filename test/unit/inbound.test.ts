import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { downloadOwnerImages, toOwnerMessageDraft } from '../../src/host/inbound.ts';
import type { WeixinMessage } from '../../src/host/ilink/types.ts';
import { CDN, PNG, encrypt, imageFetch, imageMessage } from './helpers/inbound-fixtures.ts';

test('纯文本消息原样转成草稿', async () => {
  const draft = await toOwnerMessageDraft(
    { message_id: '1', from_user_id: 'owner-1', create_time_ms: 5, item_list: [{ type: 1, text_item: { text: '/status' } }] },
    { account: 'bot' },
  );
  assert.deepEqual(draft, {
    messageId: 'weixin:v1:bot:owner-1:mid:1',
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
