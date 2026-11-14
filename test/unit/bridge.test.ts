import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ILinkError } from '../../src/host/ilink/api.ts';
import type { ILinkApi } from '../../src/host/ilink/api.ts';
import { SessionGuard } from '../../src/host/ilink/session-guard.ts';
import { ContextTokenStore } from '../../src/host/state/context-tokens.ts';
import { MESSAGES_PER_WINDOW, TOKEN_WINDOW_MS, WeixinBridge } from '../../src/host/superagent/bridge.ts';
import type { BridgeHandle } from '../../src/host/superagent/protocol.ts';
import { ACCOUNT, OWNER, delivery, withHarness, withImage } from './bridge-harness.ts';

test('正常交付：发出文本，回 sent 与平台消息 id', async () => {
  await withHarness({}, async (h) => {
    const receipt = await h.bridge.deliver(delivery());
    assert.equal(receipt.status, 'sent');
    // 回执带平台侧 message_id：用户引用这条消息时，核心靠它认回是哪条交付。
    assert.equal(receipt.bridgeMessageId, 'wm-1');
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

test('收件人不是登录主人时拒发，凭据不发给第三方', async () => {
  await withHarness({}, async (h) => {
    const receipt = await h.bridge.deliver(delivery({ id: 'stranger', recipient: 'stranger-9' }));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.errorCode, 'other');
    assert.match(receipt.error ?? '', /收件人不是登录主人/);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.images, []);
    assert.ok(h.warnings.some((line) => line.includes('收件人不是登录主人')), `实际日志：${h.warnings.join(' | ')}`);
  });
});

test('登录主人未知时同样拒发，不凭空选收件人', async () => {
  await withHarness({ noOwner: true }, async (h) => {
    const receipt = await h.bridge.deliver(delivery({ id: 'no-owner' }));
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.error ?? '', /收件人不是登录主人/);
    assert.deepEqual(h.sent, []);
  });
});

test('被服务端拒（ret=-2）时记录 token 年龄，供实测有效期用', async () => {
  await withHarness({ failAt: [1], error: new ILinkError('api', 'sendmessage 失败 ret=-2', { ret: -2 }) }, async (h) => {
    const receipt = await h.bridge.deliver(delivery());
    assert.equal(receipt.errorCode, 'window-closed');
    assert.ok(h.warnings.some((line) => /窗口已关（token 已存在 0 分钟）/.test(line)), `实际日志：${h.warnings.join(' | ')}`);
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

test('单交付内分条按声明配额节流：每 10 条等一个窗口', async () => {
  // 核心只见一次 deliver，分条扇出发生在桥内部——配额必须由桥自己执行。
  const sleeps: number[] = [];
  let clock = 1_000_000;
  await withHarness({
    maxText: 10,
    now: () => clock,
    // 假时钟跟着等待前进，否则窗口永远不会滑出。
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  }, async (h) => {
    const receipt = await h.bridge.deliver(delivery({ id: 'paced', title: '', body: 'x'.repeat(120) }));
    assert.equal(receipt.status, 'sent');
    assert.equal(h.sent.length, 12, '120 字按 10 字分 12 条');
    assert.deepEqual(sleeps, [60_000], '第 10 条之后等一个声明窗口');
    assert.equal(receipt.messagesSent, 12, '分条扇出要如实报条数，核心据此算额度');
  });
});

test('超长正文分条发送', async () => {
  await withHarness({}, async (h) => {
    const body = '第一段内容\n第二段内容\n第三段内容\n第四段内容';
    const receipt = await h.bridge.deliver(delivery({ title: '', body }));
    assert.equal(receipt.status, 'sent');
    assert.ok(h.sent.length > 1);
    assert.equal(receipt.messagesSent, h.sent.length, '报了条数就要与实际发出的条数一致');
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
      // 按字节算（中文一字 3 字节）：63 字节的正文正好切成两片，续发语义和按字符时一致。
      maxText: 60,
      ownerId: () => OWNER,
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

test('空交付报 0 条：没有正文也没有图，就不占平台额度', async () => {
  await withHarness({}, async (h) => {
    const receipt = await h.bridge.deliver(delivery({ title: '', body: '' }));
    assert.equal(receipt.status, 'sent');
    assert.equal(h.sent.length, 0);
    assert.equal(receipt.messagesSent, 0);
  });
});

test('分条中途失败的回执不带条数：那一次核心不记账，成功时再按总数结算', async () => {
  await withHarness({ failAt: [2] }, async (h) => {
    const receipt = await h.bridge.deliver(delivery({ id: 'half', title: '', body: 'x'.repeat(60) }));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.messagesSent, undefined, '失败回执只说明这一次没成，条数额度不算');
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
    ownerId: () => OWNER,
  });
  assert.equal(bridge.platform, 'weixin');
  assert.deepEqual(bridge.protocol, ['my-superagent/v1']);
  assert.equal(bridge.capabilities.markdown, 'full');
  assert.deepEqual(bridge.capabilities.maxText, { max: 1_500, unit: 'utf8-byte' });
  assert.equal(bridge.capabilities.interaction, undefined);
  assert.equal(bridge.capabilities.detail, false);
  assert.equal(bridge.capabilities.nativeCommands, false);
  // 能收到用户引用消息里的被引用 id，并把它交给核心做回指。
  assert.equal(bridge.capabilities.quoteReply, true);
  assert.equal(bridge.capabilities.outbound.requiresPriorInbound, true);
  // 声明窗口让核心在窗口外跳过本桥、把流量让给下一座，而不是每分钟空转（ADR-0013、0015）。
  assert.equal(bridge.capabilities.outbound.windowMs, TOKEN_WINDOW_MS);
  assert.equal(bridge.capabilities.outbound.windowMs, 24 * 60 * 60_000);
  // 条数额度是窗口的第二维：核心据此在用尽之前请主人续约（核心 ADR-0031）。
  assert.equal(bridge.capabilities.outbound.maxMessagesPerWindow, MESSAGES_PER_WINDOW);
  assert.equal(bridge.capabilities.outbound.maxMessagesPerWindow, 10);
});

test('核心能力声明决定图片下载与身份查询', () => {
  const bridge = new WeixinBridge({
    account: ACCOUNT,
    api: () => null,
    contextTokens: new ContextTokenStore({ dir: '/tmp/unused' }),
    guard: new SessionGuard(),
    ownerId: () => OWNER,
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
  });
  // 发送失败也算「模型出结果了」：照样回调，让输入状态收尾而不是挂到兜底超时。
  delivered.length = 0;
  await withHarness(
    { failAt: [1], error: new Error('boom'), onDelivered: (recipient) => delivered.push(recipient) },
    async (h) => {
      const receipt = await h.bridge.deliver(delivery({ id: 'failing' }));
      assert.equal(receipt.status, 'failed');
      assert.deepEqual(delivered, [OWNER]);
    },
  );
});

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

test('分条交付的回执带全部平台 id：引用中间那条也能认回', async () => {
  await withHarness({ maxText: 20 }, async (h) => {
    const receipt = await h.bridge.deliver(delivery({ title: '', body: '第一段内容\n第二段内容\n第三段内容\n第四段内容' }));
    assert.equal(receipt.status, 'sent');
    assert.ok((receipt.bridgeMessageIds ?? []).length > 1);
    assert.equal(receipt.bridgeMessageIds!.length, h.sent.length);
    assert.equal(receipt.bridgeMessageId, receipt.bridgeMessageIds!.at(-1));
    assert.equal(new Set(receipt.bridgeMessageIds).size, receipt.bridgeMessageIds!.length, 'id 不重复');
  });
});

test('平台没回 message_id：回执不带 bridgeMessageId，不编造', async () => {
  await withHarness({ noMessageId: true }, async (h) => {
    const receipt = await h.bridge.deliver(delivery());
    assert.equal(receipt.status, 'sent');
    assert.equal(receipt.bridgeMessageId, undefined);
  });
});

test('图片-only 交付：回执带最后一张图的平台 id，引用那张图也能认回', async () => {
  await withHarness({}, async (h) => {
    const receipt = await h.bridge.deliver(withImage({ body: '' }));
    assert.equal(receipt.status, 'sent');
    assert.equal(h.sent.length, 0);
    assert.equal(h.images.length, 1);
    assert.match(receipt.bridgeMessageId ?? '', /^wm-/);
    assert.deepEqual(receipt.bridgeMessageIds, [receipt.bridgeMessageId]);
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
