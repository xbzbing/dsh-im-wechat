import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ILinkError } from '../../src/host/ilink/api.ts';
import type { UploadUrlRequest, UploadUrlResponse } from '../../src/host/ilink/api.ts';
import { aesEcbPaddedSize, decryptAesEcb, encryptAesEcb, md5Hex } from '../../src/host/ilink/media.ts';
import { CdnUploadError, isAllowedUploadUrl, uploadImage } from '../../src/host/ilink/upload.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function api(response: UploadUrlResponse | (() => Promise<UploadUrlResponse>) = { uploadParam: 'p', uploadFullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?x=1' }) {
  const calls: UploadUrlRequest[] = [];
  return {
    calls,
    getUploadUrl: async (request: UploadUrlRequest) => {
      calls.push(request);
      return typeof response === 'function' ? response() : response;
    },
  };
}

function fetchStub(status: number, headers: Record<string, string> = {}, body = '') {
  const posts: { url: string; body: Buffer; contentType: string | undefined }[] = [];
  const fn = (async (url: string, init: { headers?: Record<string, string>; body?: Uint8Array }) => {
    posts.push({ url, body: Buffer.from(init.body ?? new Uint8Array()), contentType: init.headers?.['Content-Type'] });
    return new Response(body, { status, headers });
  }) as unknown as typeof globalThis.fetch;
  return { fn, posts };
}

test('上传：getuploadurl 带齐字段，密文用随机密钥加密后 POST 到 CDN，取回 x-encrypted-param', async () => {
  const client = api();
  const { fn, posts } = fetchStub(200, { 'x-encrypted-param': 'dl-param' });
  const uploaded = await uploadImage(client, { data: PNG, toUserId: 'u1' }, { cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c', fetch: fn });

  assert.equal(client.calls.length, 1);
  const request = client.calls[0]!;
  assert.equal(request.media_type, 1);
  assert.equal(request.to_user_id, 'u1');
  assert.equal(request.rawsize, PNG.length);
  assert.equal(request.rawfilemd5, md5Hex(PNG));
  assert.equal(request.filesize, aesEcbPaddedSize(PNG.length));
  assert.equal(request.no_need_thumb, true);
  assert.match(request.aeskey, /^[0-9a-f]{32}$/);
  assert.match(request.filekey, /^[0-9a-f]{32}$/);

  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.contentType, 'application/octet-stream');
  assert.equal(posts[0]!.body.length, request.filesize);
  // 用请求里给的密钥能解回原图：说明加密与协议字段是同一套。
  assert.deepEqual(decryptAesEcb(posts[0]!.body, Buffer.from(request.aeskey, 'hex')), PNG);
  assert.equal(uploaded.encryptQueryParam, 'dl-param');
  assert.equal(uploaded.aesKeyHex, request.aeskey);
  assert.equal(uploaded.ciphertextSize, request.filesize);
});

test('上传：没有 upload_full_url 时按 CDN 基址与 filekey 拼地址', async () => {
  const client = api({ uploadParam: 'param with space' });
  const { fn, posts } = fetchStub(200, { 'x-encrypted-param': 'ok' });
  await uploadImage(client, { data: PNG, toUserId: 'u1' }, { cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/', fetch: fn });
  assert.equal(posts[0]!.url, `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=param%20with%20space&filekey=${client.calls[0]!.filekey}`);
});

test('上传：4xx 立即失败不重试，5xx 与缺头最多试三次', async () => {
  const client = api();
  const bad = fetchStub(400, { 'x-error-message': 'bad key' });
  await assert.rejects(
    uploadImage(client, { data: PNG, toUserId: 'u1' }, { cdnBaseUrl: 'https://c', fetch: bad.fn }),
    (error: unknown) => error instanceof CdnUploadError && /客户端错误 400/.test(error.message),
  );
  assert.equal(bad.posts.length, 1, '4xx 不重试');

  const flaky = fetchStub(500);
  await assert.rejects(uploadImage(client, { data: PNG, toUserId: 'u1' }, { cdnBaseUrl: 'https://c', fetch: flaky.fn }), /服务端错误/);
  assert.equal(flaky.posts.length, 3, '5xx 试满三次');

  const noHeader = fetchStub(200);
  await assert.rejects(uploadImage(client, { data: PNG, toUserId: 'u1' }, { cdnBaseUrl: 'https://c', fetch: noHeader.fn }), /缺少 x-encrypted-param/);
  assert.equal(noHeader.posts.length, 3);
});

test('上传：只允许微信域名，别的地址一律不发', async () => {
  assert.equal(isAllowedUploadUrl('https://novac2c.cdn.weixin.qq.com/c2c/upload'), true);
  assert.equal(isAllowedUploadUrl('https://evil.example.com/upload'), false);
  assert.equal(isAllowedUploadUrl('http://novac2c.cdn.weixin.qq.com/upload'), false);
  const client = api({ uploadFullUrl: 'https://evil.example.com/upload' });
  const { fn, posts } = fetchStub(200, { 'x-encrypted-param': 'x' });
  await assert.rejects(
    uploadImage(client, { data: PNG, toUserId: 'u1' }, { cdnBaseUrl: 'https://c', fetch: fn }),
    (error: unknown) => error instanceof CdnUploadError && /不在微信域名内/.test(error.message),
  );
  assert.equal(posts.length, 0);
});

test('上传：畸形 CDN 基址回 CdnUploadError，不再抛原始 TypeError', async () => {
  const client = api({ uploadParam: 'p' });
  const { fn, posts } = fetchStub(200, { 'x-encrypted-param': 'x' });
  await assert.rejects(
    uploadImage(client, { data: PNG, toUserId: 'u1' }, { cdnBaseUrl: 'not a url', fetch: fn }),
    (error: unknown) => error instanceof CdnUploadError && /不在微信域名内：非法地址/.test(error.message),
  );
  assert.equal(posts.length, 0);
});

test('上传：服务端没回上传参数时 getuploadurl 就报错，不会拿空参数去拼地址', async () => {
  // 真实 api.getUploadUrl 在两个字段都缺时抛 ILinkError；这里照它的行为打桩。
  const client = {
    getUploadUrl: async () => {
      throw new ILinkError('api', 'getuploadurl 没有回上传参数');
    },
  };
  const { fn, posts } = fetchStub(200, { 'x-encrypted-param': 'x' });
  await assert.rejects(uploadImage(client, { data: PNG, toUserId: 'u1' }, { cdnBaseUrl: 'https://c', fetch: fn }), ILinkError);
  assert.equal(posts.length, 0);
});

test('加密：AES-128-ECB 加 PKCS#7，密文长度总是 16 的倍数', () => {
  for (const size of [0, 1, 15, 16, 17, 1000]) {
    const plain = Buffer.alloc(size, 0x41);
    const cipher = encryptAesEcb(plain, Buffer.alloc(16, 1));
    assert.equal(cipher.length, aesEcbPaddedSize(size));
    assert.equal(cipher.length % 16, 0);
    assert.deepEqual(decryptAesEcb(cipher, Buffer.alloc(16, 1)), plain);
  }
});