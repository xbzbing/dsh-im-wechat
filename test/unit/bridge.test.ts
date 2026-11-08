import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ILinkError } from '../../src/host/ilink/api.ts';
import type { ILinkApi } from '../../src/host/ilink/api.ts';
import { SessionGuard } from '../../src/host/ilink/session-guard.ts';
import { ContextTokenStore } from '../../src/host/state/context-tokens.ts';
import { WeixinBridge } from '../../src/host/superagent/bridge.ts';
import type { BridgeHandle, Delivery } from '../../src/host/superagent/protocol.ts';

interface Sent {
  to: string;
  text: string;
}

const ACCOUNT = 'bot@im.bot';
const OWNER = 'owner-1';

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    protocol: 'my-superagent/v1',
    id: 'delivery-1',
    recipient: OWNER,
    intent: 'result',
    title: '完成',
    body: '正文',
    ...overrides,
  };
}

interface Harness {
  dir: string;
  bridge: WeixinBridge;
  sent: Sent[];
  guard: SessionGuard;
  tokens: ContextTokenStore;
  images: Record<string, unknown>[];
  uploads: string[];
}

async function harness(
  options: {
    failAt?: number[];
    error?: Error;
    withToken?: boolean;
    noApi?: boolean;
    onDelivered?: (recipient: string) => void;
    uploadStatus?: number;
    uploadParam?: string;
    uploadFails?: boolean;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-bridge-'));
  const sent: Sent[] = [];
  const tokens = new ContextTokenStore({ dir });
  if (options.withToken !== false) tokens.set(ACCOUNT, OWNER, 'ctx-1');
  const guard = new SessionGuard();
  let calls = 0;
  const images: Record<string, unknown>[] = [];
  const uploads: string[] = [];
  const api = {
    async sendMessage(message: { to_user_id: string; item_list?: Record<string, unknown>[] }) {
      calls += 1;
      if (options.failAt?.includes(calls)) throw options.error ?? new Error('boom');
      const item = message.item_list?.[0];
      if (item?.image_item !== undefined) {
        images.push(item.image_item as Record<string, unknown>);
        return;
      }
      sent.push({
        to: message.to_user_id,
        text: (item?.text_item as { text?: string } | undefined)?.text ?? '',
      });
    },
    async getUploadUrl() {
      if (options.uploadFails) throw new ILinkError('api', 'getuploadurl 失败 ret=-1', { ret: -1 });
      uploads.push('getuploadurl');
      return { uploadParam: 'up', uploadFullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?x=1' };
    },
  } as unknown as ILinkApi;
  const uploadFetch = (async () => new Response('', { status: options.uploadStatus ?? 200, headers: { 'x-encrypted-param': options.uploadParam ?? 'dl-1' } })) as unknown as typeof globalThis.fetch;
  const bridge = new WeixinBridge({
    account: ACCOUNT,
    api: () => (options.noApi ? null : api),
    contextTokens: tokens,
    guard,
    maxText: 20,
    uploadFetch,
    ...(options.onDelivered ? { onDelivered: options.onDelivered } : {}),
  });
  return { dir, bridge, sent, guard, tokens, images, uploads };
}

async function withHarness(
  options: Parameters<typeof harness>[0],
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await harness(options);
  try {
    await run(h);
  } finally {
    // 等 context_token 的写盘队排空，否则删目录会与落盘撞上（ENOTEMPTY）。
    await h.tokens.flush();
    await rm(h.dir, { recursive: true, force: true });
  }
}

test('正常交付：发出文本，回 sent 与 bridgeMessageId', async () => {
  await withHarness({}, async (h) => {
    const receipt = await h.bridge.deliver(delivery());
    assert.equal(receipt.status, 'sent');
    assert.match(receipt.bridgeMessageId ?? '', /^dsh-im-wechat:/);
    assert.deepEqual(h.sent, [{ to: OWNER, text: '完成\n\n正文' }]);
  });
});

test('缺少 context_token 按 window-closed 回 failed', async () => {
  await withHarness({ withToken: false }, async (h) => {
    const receipt = await h.bridge.deliver(delivery());
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.errorCode, 'window-closed');
    assert.equal(h.sent.length, 0);
  });
});

test('闸门内不发送，回 auth-expired', async () => {
  await withHarness({}, async (h) => {
    h.guard.pause(ACCOUNT);
    const receipt = await h.bridge.deliver(delivery());
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.errorCode, 'auth-expired');
    assert.equal(h.sent.length, 0);
    assert.equal(h.bridge.health().code, 'auth-expired');
  });
});

test('超长正文分条发送', async () => {
  await withHarness({}, async (h) => {
    const body = '第一段内容\n第二段内容\n第三段内容\n第四段内容';
    const receipt = await h.bridge.deliver(delivery({ title: '', body }));
    assert.equal(receipt.status, 'sent');
    assert.ok(h.sent.length > 1);
    // 纯文本行之间会被补成空行（PC 端 Markdown 才能分段），比对时把空行折回换行。
    assert.equal(h.sent.map((item) => item.text).join('\n').replace(/\n{2,}/g, '\n'), body);
  });
});

test('分条中途失败后重试从断点续发，不重复已发内容', async () => {
  await withHarness({}, async (h) => {
    const failing = new WeixinBridge({
      account: ACCOUNT,
      api: () => {
        let calls = 0;
        return {
          async sendMessage(message: { item_list?: { text_item?: { text?: string } }[] }) {
            calls += 1;
            if (calls === 2) throw new ILinkError('http', 'boom', { status: 500 });
            h.sent.push({ to: OWNER, text: message.item_list?.[0]?.text_item?.text ?? '' });
          },
        } as unknown as ILinkApi;
      },
      contextTokens: h.tokens,
      guard: h.guard,
      maxText: 20,
    });
    const body = '第一段内容\n第二段内容\n第三段内容\n第四段内容';
    const first = await failing.deliver(delivery({ id: 'multi', title: '', body }));
    assert.equal(first.status, 'failed');
    assert.equal(h.sent.length, 1);
    const second = await failing.deliver(delivery({ id: 'multi', title: '', body }));
    assert.equal(second.status, 'sent');
    // 断点续发：第二批只补后面的段落。
    assert.equal(h.sent.map((item) => item.text).join('\n').replace(/\n{2,}/g, '\n'), body);
  });
});

test('同一 delivery.id 的并发投递只发一遍（不重复打扰主人）', async () => {
  await withHarness({}, async (h) => {
    const [first, second] = await Promise.all([
      h.bridge.deliver(delivery({ id: 'same' })),
      h.bridge.deliver(delivery({ id: 'same' })),
    ]);
    assert.equal(first.status, 'sent');
    assert.equal(second.status, 'sent');
    assert.equal(h.sent.length, 1);
    assert.equal(first.bridgeMessageId, second.bridgeMessageId);
  });
});

test('结果未知回 uncertain，核心不重发', async () => {
  await withHarness({ failAt: [1], error: new ILinkError('timeout', '超时') }, async (h) => {
    const receipt = await h.bridge.deliver(delivery());
    assert.equal(receipt.status, 'uncertain');
    assert.equal(receipt.errorCode, undefined);
  });
});

test('未登录时 health 与 deliver 都指向 auth-expired', async () => {
  await withHarness({ noApi: true }, async (h) => {
    assert.equal(h.bridge.health().state, 'down');
    assert.equal(h.bridge.health().code, 'auth-expired');
    const receipt = await h.bridge.deliver(delivery());
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.errorCode, 'auth-expired');
  });
});

test('能力声明：纯文本、分条上限、无交互卡、需要先有入站', () => {
  const bridge = new WeixinBridge({
    account: ACCOUNT,
    api: () => null,
    contextTokens: new ContextTokenStore({ dir: '/tmp/unused' }),
    guard: new SessionGuard(),
    maxText: 1_500,
  });
  assert.equal(bridge.platform, 'weixin');
  assert.deepEqual(bridge.protocol, ['my-superagent/v1']);
  assert.equal(bridge.capabilities.markdown, 'full');
  assert.deepEqual(bridge.capabilities.maxText, { max: 1_500, unit: 'char' });
  assert.equal(bridge.capabilities.interaction, undefined);
  assert.equal(bridge.capabilities.detail, false);
  assert.equal(bridge.capabilities.nativeCommands, false);
  assert.equal(bridge.capabilities.outbound.requiresPriorInbound, true);
});

test('核心能力声明决定图片下载与身份查询', () => {
  const bridge = new WeixinBridge({
    account: ACCOUNT,
    api: () => null,
    contextTokens: new ContextTokenStore({ dir: '/tmp/unused' }),
    guard: new SessionGuard(),
  });
  assert.equal(bridge.imagesEnabled, false);
  assert.equal(typeof bridge.ownerLookup, 'undefined');

  const handle = {
    id: `weixin:${ACCOUNT}`,
    protocol: 'my-superagent/v1',
    isOwner: (sender: string) => sender === OWNER,
  } as unknown as BridgeHandle;
  bridge.attachHandle(handle, ['owner-images', 'owner-lookup']);
  assert.equal(bridge.imagesEnabled, true);
  const lookup = bridge.ownerLookup;
  assert.equal(typeof lookup, 'function');
  assert.equal(lookup?.(OWNER), true);
  assert.equal(lookup?.('stranger'), false);

  bridge.detachHandle();
  assert.equal(bridge.imagesEnabled, false);
});

test('交付进入投递流程就回调 onDelivered（收起正在输入）', async () => {
  const delivered: string[] = [];
  await withHarness({ onDelivered: (recipient) => delivered.push(recipient) }, async (h) => {
    await h.bridge.deliver(delivery());
    assert.deepEqual(delivered, [OWNER]);
    // 发送失败也算「模型出结果了」：照样回调，让输入状态收尾。
    delivered.length = 0;
  });
  await withHarness({ failAt: [1], error: new Error('boom') }, async (h) => {
    // 该 harness 没挂回调，确认不挂也能跑。
    const receipt = await h.bridge.deliver(delivery({ id: 'failing' }));
    assert.equal(receipt.status, 'failed');
  });
});

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');

function withImage(overrides: Partial<Delivery> = {}): Delivery {
  return delivery({ title: '', body: 'A · Q 版抱鲸鱼', images: [{ mediaType: 'image/png', data: PNG_BASE64, name: 'a.png' }], ...overrides });
}

test('交付带图：先上传再发 image_item，然后才发文字', async () => {
  await withHarness({}, async (h) => {
    const receipt = await h.bridge.deliver(withImage());
    assert.equal(receipt.status, 'sent');
    assert.deepEqual(h.uploads, ['getuploadurl']);
    assert.equal(h.images.length, 1);
    const image = h.images[0]!;
    const media = image.media as { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number };
    assert.equal(media.encrypt_query_param, 'dl-1');
    // media.aes_key 是 base64 的 32 个十六进制字符。
    assert.match(Buffer.from(media.aes_key ?? '', 'base64').toString('ascii'), /^[0-9a-f]{32}$/);
    // encrypt_type=1：媒体引用带缩略图/尺寸元数据，客户端按它解密；缺了会渲染成空白。
    assert.equal(media.encrypt_type, 1);
    // 顶层 aeskey 不能带：客户端认这个字段就拿到十六进制、解不出来，图变灰。
    assert.equal(image.aeskey, undefined);
    assert.equal(typeof image.mid_size, 'number');
    assert.deepEqual(h.sent, [{ to: OWNER, text: 'A · Q 版抱鲸鱼' }]);
  });
});

test('交付带图：上传失败按失败的 errorCode 回，文字一条都不发', async () => {
  await withHarness({ uploadFails: true }, async (h) => {
    const receipt = await h.bridge.deliver(withImage());
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.errorCode, 'other');
    // 上传在 getuploadurl 就失败：错误来自 api 层，不让核心里出现「发送成功」的假象。
    assert.match(receipt.error ?? '', /getuploadurl|图片上传失败/);
    assert.deepEqual(h.sent, []);
  });
});

test('交付带图：4xx 上传错误也不重排出半张图', async () => {
  await withHarness({ uploadStatus: 403, uploadParam: '' }, async (h) => {
    const receipt = await h.bridge.deliver(withImage());
    assert.equal(receipt.status, 'failed');
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.images, []);
  });
});

test('能力声明：outbound.images 为 true，核心才会把图发过来', async () => {
  await withHarness({}, async (h) => {
    assert.equal(h.bridge.capabilities.outbound.images, true);
  });
});
