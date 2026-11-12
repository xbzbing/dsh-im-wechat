/** 入站图片测试的公共夹具：假 CDN、加密过的 PNG、带图消息。 */
import { createCipheriv, randomBytes } from 'node:crypto';

import type { ImageItem, WeixinMessage } from '../../../src/host/ilink/types.ts';

export const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8, 0x01),
]);

export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** 一个按调用顺序返回图片字节的假 CDN；`calls()` 是实际下载次数。 */
export function imageFetch(payloads: Buffer[]): { impl: typeof globalThis.fetch; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    const payload = payloads[Math.min(calls, payloads.length - 1)] ?? Buffer.alloc(0);
    calls += 1;
    return new Response(new Uint8Array(payload));
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls: () => calls };
}

/** 一条「一句文字 + count 张图」的消息，附上这些图密文的明文。 */
export function imageMessage(count: number): { message: WeixinMessage; payload: Buffer } {
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

/** 只有一张图、没有文字的消息。 */
export function imageOnlyMessage(): { message: WeixinMessage; payload: Buffer } {
  const key = randomBytes(16);
  return {
    message: {
      message_id: '2004',
      from_user_id: 'owner-1',
      create_time_ms: 1_760_000_000_000,
      item_list: [
        { type: 2, msg_id: 'only', image_item: { media: { encrypt_query_param: 'p', aes_key: key.toString('base64') } } },
      ],
    },
    payload: encrypt(PNG, key),
  };
}
