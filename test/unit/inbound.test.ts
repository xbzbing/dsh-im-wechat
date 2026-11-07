import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { toOwnerMessageDraft } from '../../src/host/inbound.ts';
import type { ImageItem, WeixinMessage } from '../../src/host/ilink/types.ts';

const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 0x01)]);

function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** 一个按调用顺序返回图片字节的假 CDN。 */
function imageFetch(payloads: Buffer[]): { impl: typeof globalThis.fetch; calls: number } {
  let calls = 0;
  const impl = (async () => {
    const payload = payloads[Math.min(calls, payloads.length - 1)];
    calls += 1;
    return new Response(new Uint8Array(payload));
  }) as typeof globalThis.fetch;
  return {
    impl,
    get calls() {
      return calls;
    },
  } as unknown as { impl: typeof globalThis.fetch; calls: number };
}

function imageMessage(count: number): { message: WeixinMessage; payload: Buffer } {
  const key = randomBytes(16);
  const itemList: unknown[] = [{ type: 1, text_item: { text: '看这张' } }];
  for (let index = 0; index < count; index += 1) {
    const item: ImageItem = {
      media: { encrypt_query_param: `p-${index}`, aes_key: key.toString('base64') },
      mid_size: 32,
    };
    itemList.push({ type: 2, msg_id: `img-${index}`, image_item: item });
  }
  return {
    message: {
      message_id: '2001',
      from_user_id: 'owner-1',
      create_time_ms: 1_760_000_000_000,
      item_list: itemList as WeixinMessage['item_list'],
    },
    payload: encrypt(PNG, key),
  };
}

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
  assert.equal(fetch.calls, 0);
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
  assert.equal(fetch.calls, 0);
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
    fetch: fetch.impl,
  });
  assert.equal(draft?.images?.length, 9);
  assert.equal(fetch.calls, 9);
});

test('坏图片被丢弃，其余照常', async () => {
  const built = imageMessage(2);
  const fetch = imageFetch([Buffer.from('not an image')]);
  const draft = await toOwnerMessageDraft(built.message, {
    account: 'bot',
    cdnBaseUrl: CDN,
    imagesEnabled: true,
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
    fetch: fetch.impl,
  });
  assert.equal(draft?.text, '');
  assert.equal(draft?.images?.length, 1);
});
