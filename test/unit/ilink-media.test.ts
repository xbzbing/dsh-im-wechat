import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  MAX_IMAGE_BYTES,
  decryptAesEcb,
  downloadImage,
  isAllowedMediaUrl,
  parseBase64Key,
  parseHexKey,
  resolveMediaUrl,
  sniffImageType,
} from '../../src/host/ilink/media.ts';

const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 0x01),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 0x02)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16, 0x03)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4, 0), Buffer.from('WEBPVP8 ', 'ascii')]);
const BMP = Buffer.concat([Buffer.from('BM', 'ascii'), Buffer.alloc(16)]);

function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function fetchReturning(body: Buffer, init: ResponseInit = {}): { impl: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(new Uint8Array(body), { status: 200, ...init });
  }) as typeof globalThis.fetch;
  return { impl, urls };
}

test('文件头识别只接受四种图片', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(GIF), 'image/gif');
  assert.equal(sniffImageType(WEBP), 'image/webp');
  assert.equal(sniffImageType(BMP), null);
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50])), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  assert.equal(sniffImageType(Buffer.from('RIFF0000WAVE', 'ascii')), null);
});

test('两种密钥编码都能解出 16 字节', () => {
  const raw = randomBytes(16);
  assert.deepEqual(parseBase64Key(raw.toString('base64')), raw);
  const asHex = Buffer.from(raw.toString('hex'), 'ascii').toString('base64');
  assert.deepEqual(parseBase64Key(asHex), raw);
  assert.deepEqual(parseHexKey(raw.toString('hex')), raw);
  assert.equal(parseHexKey('zz'), null);
  assert.equal(parseBase64Key(''), null);
  assert.equal(parseBase64Key('short'), null);
});

test('解密是 AES-128-ECB + PKCS#7', () => {
  const key = randomBytes(16);
  const ciphertext = encrypt(PNG, key);
  assert.deepEqual(decryptAesEcb(ciphertext, key), PNG);
});

test('直链主机白名单只认 https 的 qq.com 域', () => {
  assert.equal(isAllowedMediaUrl('https://novac2c.cdn.weixin.qq.com/c2c/download?x=1'), true);
  assert.equal(isAllowedMediaUrl('https://weixin.qq.com/x'), true);
  assert.equal(isAllowedMediaUrl('http://novac2c.cdn.weixin.qq.com/x'), false);
  assert.equal(isAllowedMediaUrl('https://evil.example.com/x'), false);
  assert.equal(isAllowedMediaUrl('https://evilqq.com/x'), false);
  assert.equal(isAllowedMediaUrl('not a url'), false);
});

test('白名单外的直链被忽略，退回 CDN 拼接地址', () => {
  const url = resolveMediaUrl(
    { full_url: 'https://evil.example.com/x', encrypt_query_param: 'a b' },
    CDN,
  );
  assert.equal(url, `${CDN}/download?encrypted_query_param=a%20b`);
  assert.equal(resolveMediaUrl({ full_url: 'https://evil.example.com/x' }, CDN), null);
});

test('下载密文、解密、认出类型', async () => {
  const key = randomBytes(16);
  const { impl, urls } = fetchReturning(encrypt(PNG, key));
  const result = await downloadImage(
    {
      media: { encrypt_query_param: 'param-1', aes_key: key.toString('base64') },
      mid_size: 32,
    },
    { cdnBaseUrl: CDN, fetch: impl },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.mediaType, 'image/png');
  assert.deepEqual(result.data, PNG);
  assert.equal(urls[0], `${CDN}/download?encrypted_query_param=param-1`);
});

test('image_item.aeskey 优先于 media.aes_key', async () => {
  const right = randomBytes(16);
  const wrong = randomBytes(16);
  const { impl } = fetchReturning(encrypt(GIF, right));
  const result = await downloadImage(
    {
      media: { encrypt_query_param: 'p', aes_key: wrong.toString('base64') },
      aeskey: right.toString('hex'),
    },
    { cdnBaseUrl: CDN, fetch: impl },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.mediaType, 'image/gif');
});

test('没有密钥时按明文下载', async () => {
  const { impl } = fetchReturning(JPEG);
  const result = await downloadImage({ media: { encrypt_query_param: 'p' } }, { cdnBaseUrl: CDN, fetch: impl });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.mediaType, 'image/jpeg');
});

test('重定向直接失败，不跟随', async () => {
  const { impl } = fetchReturning(Buffer.alloc(0), {
    status: 302,
    headers: { location: 'https://evil.example.com/x' },
  });
  const result = await downloadImage({ media: { encrypt_query_param: 'p' } }, { cdnBaseUrl: CDN, fetch: impl });
  assert.deepEqual(result, { ok: false, reason: 'CDN 返回重定向 302' });
});

test('超过大小上限不下载完整内容', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(2048)]);
  const { impl } = fetchReturning(big);
  const result = await downloadImage(
    { media: { encrypt_query_param: 'p' } },
    { cdnBaseUrl: CDN, fetch: impl, maxBytes: 1024 },
  );
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /上限/);
  assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024);
});

test('解密后不是图片时拒绝', async () => {
  const key = randomBytes(16);
  const { impl } = fetchReturning(encrypt(BMP, key));
  const result = await downloadImage(
    { media: { encrypt_query_param: 'p', aes_key: key.toString('base64') } },
    { cdnBaseUrl: CDN, fetch: impl },
  );
  assert.deepEqual(result, { ok: false, reason: '解密后不是 png/jpeg/webp/gif' });
});

test('网络异常只回分类码，不把带签名参数的 URL 写进 reason', async () => {
  const leaky = 'fetch failed for https://c2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=SECRET-SIG';
  const impl = (async () => {
    throw Object.assign(new Error(leaky), { cause: { code: 'ECONNRESET' } });
  }) as typeof globalThis.fetch;
  const result = await downloadImage({ media: { encrypt_query_param: 'SECRET-SIG' } }, { cdnBaseUrl: CDN, fetch: impl });
  assert.equal(result.ok, false);
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /下载失败/);
  assert.equal(reason.includes('SECRET-SIG'), false);
  assert.equal(reason.includes('encrypted_query_param'), false);
});

test('外部取消立刻中断下载', async () => {
  const controller = new AbortController();
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as typeof globalThis.fetch;
  const pending = downloadImage(
    { media: { encrypt_query_param: 'p' } },
    { cdnBaseUrl: CDN, fetch: impl, signal: controller.signal },
  );
  controller.abort();
  const result = await pending;
  assert.deepEqual(result, { ok: false, reason: '下载被取消' });
});

test('非 2xx/3xx 与超限都显式丢弃响应体', async () => {
  const cancelled: boolean[] = [];
  function bodyResponse(status: number, declared?: number): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(declared === undefined ? {} : { 'content-length': String(declared) }),
      body: {
        cancel: async () => {
          cancelled.push(true);
        },
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          cancel: async () => {
            cancelled.push(true);
          },
        }),
      },
    } as unknown as Response;
  }
  const notFound = (async () => bodyResponse(404)) as typeof globalThis.fetch;
  assert.equal((await downloadImage({ media: { encrypt_query_param: 'p' } }, { cdnBaseUrl: CDN, fetch: notFound })).ok, false);
  const redirect = (async () => bodyResponse(302)) as typeof globalThis.fetch;
  assert.equal((await downloadImage({ media: { encrypt_query_param: 'p' } }, { cdnBaseUrl: CDN, fetch: redirect })).ok, false);
  const tooBig = (async () => bodyResponse(200, 9_999_999)) as typeof globalThis.fetch;
  assert.equal(
    (await downloadImage({ media: { encrypt_query_param: 'p' } }, { cdnBaseUrl: CDN, fetch: tooBig, maxBytes: 1024 })).ok,
    false,
  );
  assert.equal(cancelled.length, 3);
});
