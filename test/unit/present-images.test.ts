import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { UploadUrlRequest } from '../../src/host/ilink/api.ts';
import { presentedPaths, sendPresentedImages } from '../../src/host/present-images.ts';

const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function tempDir(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wx-present-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeApi() {
  const images: Record<string, any>[] = [];
  const uploads: UploadUrlRequest[] = [];
  return {
    images,
    uploads,
    api: {
      async getUploadUrl(request: UploadUrlRequest) {
        uploads.push(request);
        return { uploadParam: 'up', uploadFullUrl: `${CDN}/upload?x=1` };
      },
      async sendMessage(message: { item_list?: { image_item?: Record<string, any> }[] }) {
        const item = message.item_list?.[0]?.image_item;
        if (item !== undefined) images.push(item);
      },
    } as any,
  };
}

function uploadFetch(status = 200): typeof globalThis.fetch {
  return (async () => new Response('', { status, headers: { 'x-encrypted-param': 'dl-1' } })) as unknown as typeof globalThis.fetch;
}

test('present 的图片：上传并作为图片消息发到微信', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'shot.png');
  await writeFile(file, PNG);
  const fake = fakeApi();

  const result = await sendPresentedImages([file], {
    api: fake.api,
    to: 'owner-1',
    contextToken: 'ctx-1',
    cdnBaseUrl: CDN,
    fetch: uploadFetch(),
  });

  assert.equal(result.sent, 1);
  assert.deepEqual(result.failed, []);
  assert.equal(fake.uploads.length, 1);
  const image = fake.images[0]!;
  assert.equal(image.media.encrypt_type, 1);
  assert.equal(image.media.encrypt_query_param, 'dl-1');
  assert.equal(typeof image.media.aes_key, 'string');
  assert.equal(typeof image.mid_size, 'number');
  assert.equal('aeskey' in image, false, '顶层不能带 aeskey');
});

test('present 非图片文件跳过，不发任何请求', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'notes.txt');
  await writeFile(file, 'hello');
  const fake = fakeApi();

  const result = await sendPresentedImages([file], {
    api: fake.api,
    to: 'owner-1',
    contextToken: 'ctx-1',
    cdnBaseUrl: CDN,
    fetch: uploadFetch(),
  });

  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(fake.uploads.length, 0);
});

test('present 的不存在文件跳过；超过 10 张只发前 10 张', async (t) => {
  const dir = await tempDir(t);
  const files: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const file = join(dir, `shot-${index}.png`);
    await writeFile(file, PNG);
    files.push(file);
  }
  const fake = fakeApi();

  const result = await sendPresentedImages([join(dir, 'missing.png'), ...files], {
    api: fake.api,
    to: 'owner-1',
    contextToken: 'ctx-1',
    cdnBaseUrl: CDN,
    fetch: uploadFetch(),
  });

  assert.equal(result.skipped, 1);
  assert.equal(result.sent, 10);
  assert.equal(fake.uploads.length, 10);
});

test('上传失败逐个记账，不抛出', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'shot.png');
  await writeFile(file, PNG);
  const fake = fakeApi();

  const result = await sendPresentedImages([file], {
    api: fake.api,
    to: 'owner-1',
    contextToken: 'ctx-1',
    cdnBaseUrl: CDN,
    fetch: uploadFetch(500),
  });

  assert.equal(result.sent, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.path, file);
});

test('present 事件里只取有 path 的文件条目', () => {
  assert.deepEqual(presentedPaths({
    type: 'deliverables/presented',
    data: { turn: 1, files: [{ path: '/a.png' }, { path: '  ' }, { description: 'x' }, { path: '/b.png' }] },
  }), ['/a.png', '/b.png']);
  assert.deepEqual(presentedPaths({ type: 'turn/end' }), []);
  assert.deepEqual(presentedPaths(null), []);
});
