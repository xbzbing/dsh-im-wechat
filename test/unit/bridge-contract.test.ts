import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ILinkError } from '../../src/host/ilink/api.ts';
import { PNG_BASE64, delivery, fakeClock, withHarness, withImage } from './bridge-harness.ts';

test('一致性：同一 delivery.id 串行投两次也只发一遍', async () => {
  await withHarness({}, async (h) => {
    const first = await h.bridge.deliver(delivery({ id: 'once' }));
    const second = await h.bridge.deliver(delivery({ id: 'once' }));
    assert.equal(h.sent.length, 1);
    assert.equal(second.status, 'sent');
    assert.equal(second.bridgeMessageId, first.bridgeMessageId);
  });
});

test('一致性：低于已见修订号的流交付不产生任何平台操作', async () => {
  await withHarness({}, async (h) => {
    const newer = await h.bridge.deliver(delivery({ id: 'rev-2', stream: { id: 'stream-1', revision: 2, final: true } }));
    assert.equal(newer.status, 'sent');
    const older = await h.bridge.deliver(delivery({ id: 'rev-1', stream: { id: 'stream-1', revision: 1, final: true } }));
    assert.equal(older.status, 'sent');
    assert.equal(older.messagesSent, 0);
    assert.equal(h.sent.length, 1, '低修订不再产生平台消息');
  });
});

test('一致性：超长正文仍要分条发完，不能被截断', async () => {
  const clock = fakeClock();
  await withHarness({ maxText: 10, now: clock.now, sleep: clock.sleep }, async (h) => {
    const receipt = await h.bridge.deliver(delivery({ id: 'long', title: '', body: 'x'.repeat(200) }));
    assert.equal(receipt.status, 'sent');
    assert.equal(h.sent.length, 20);
    assert.equal(receipt.messagesSent, 20);
  });
});

test('一致性：只有交互卡、没有正文的交付也要发出', async () => {
  await withHarness({ maxText: 1_500 }, async (h) => {
    const receipt = await h.bridge.deliver(delivery({
      id: 'interaction-only',
      title: '',
      body: '',
      interaction: { questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }, { label: '停下' }] }] },
    }));
    assert.equal(receipt.status, 'sent');
    assert.ok(h.sent.length >= 1);
    assert.match(h.sent.map((item) => item.text).join('\n'), /继续吗/);
    assert.equal(receipt.messagesSent, h.sent.length);
  });
});

test('配额：图片与文字共用一个窗口，第 11 条消息前等 60 秒', async () => {
  const clock = fakeClock();
  const images = [0, 1, 2, 3].map((index) => ({ mediaType: 'image/png' as const, data: PNG_BASE64, name: `${index}.png` }));
  await withHarness({ maxText: 10, now: clock.now, sleep: clock.sleep }, async (h) => {
    const receipt = await h.bridge.deliver(delivery({ id: 'img-text', title: '', body: 'x'.repeat(70), images }));
    assert.equal(receipt.status, 'sent');
    assert.equal(h.images.length, 4);
    assert.equal(h.sent.length, 7);
    assert.equal(receipt.messagesSent, 11, '图片本来就占平台消息额度');
    assert.deepEqual(clock.sleeps, [60_000]);
  });
});

test('配额：两条交付并发也共用一个窗口', async () => {
  const clock = fakeClock();
  await withHarness({ maxText: 10, now: clock.now, sleep: clock.sleep }, async (h) => {
    const [first, second] = await Promise.all([
      h.bridge.deliver(delivery({ id: 'concurrent-a', title: '', body: 'a'.repeat(60) })),
      h.bridge.deliver(delivery({ id: 'concurrent-b', title: '', body: 'b'.repeat(60) })),
    ]);
    assert.equal(first.status, 'sent');
    assert.equal(second.status, 'sent');
    assert.equal(h.sent.length, 12);
    assert.equal(clock.sleeps.length, 1, '12 条消息只需要等一个窗口');
  });
});

test('缺少 token 的图片交付：直接回 window-closed，一张图都不上传', async () => {
  await withHarness({ withToken: false }, async (h) => {
    const receipt = await h.bridge.deliver(withImage({ id: 'no-token-image' }));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.errorCode, 'window-closed');
    assert.deepEqual(h.uploads, []);
    assert.equal(h.images.length, 0);
  });
});

test('发送被 429 限流后 health 降级，下一次成功交付后恢复', async () => {
  await withHarness(
    { failAt: [1], error: new ILinkError('http', 'too many requests', { status: 429 }) },
    async (h) => {
      const failed = await h.bridge.deliver(delivery({ id: 'rate-limited' }));
      assert.equal(failed.errorCode, 'rate-limited');
      assert.equal(h.bridge.health().state, 'degraded');
      assert.equal(h.bridge.health().code, 'rate-limited');

      const ok = await h.bridge.deliver(delivery({ id: 'after-limit' }));
      assert.equal(ok.status, 'sent');
      assert.equal(h.bridge.health().state, 'ok');
    },
  );
});

test('发送被 401 拒绝后 health 直接下线', async () => {
  await withHarness(
    { failAt: [1], error: new ILinkError('http', 'unauthorized', { status: 401 }) },
    async (h) => {
      const receipt = await h.bridge.deliver(delivery());
      assert.equal(receipt.errorCode, 'auth-expired');
      assert.equal(h.bridge.health().state, 'down');
      assert.equal(h.bridge.health().code, 'auth-expired');
    },
  );
});

test('轮询已报下线时，发送侧限流不会把更重的状态覆盖掉', async () => {
  await withHarness(
    {
      failAt: [1],
      error: new ILinkError('http', 'too many requests', { status: 429 }),
      health: () => ({ state: 'down', code: 'kicked', reason: '被踢下线' }),
    },
    async (h) => {
      await h.bridge.deliver(delivery());
      assert.equal(h.bridge.health().state, 'down');
      assert.equal(h.bridge.health().code, 'kicked');
    },
  );
});

test('交付总截止：分条中途到点回 uncertain，不让核心整条重发', async () => {
  const clock = fakeClock();
  await withHarness(
    { maxText: 10, now: clock.now, sleep: clock.sleep, deliverDeadlineMs: 30_000 },
    async (h) => {
      const receipt = await h.bridge.deliver(delivery({ id: 'deadline', title: '', body: 'x'.repeat(120) }));
      assert.equal(receipt.status, 'uncertain');
      assert.equal(h.sent.length, 10);
      assert.equal(receipt.messagesSent, undefined);
    },
  );
});

test('交付总截止：一条都没发出时回 failed，让核心重试', async () => {
  await withHarness({ deliverDeadlineMs: 0 }, async (h) => {
    const receipt = await h.bridge.deliver(delivery());
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.errorCode, 'other');
    assert.match(receipt.error ?? '', /发送超时/);
    assert.equal(h.sent.length, 0);
  });
});

test('图片循环每张前复查开关：停用后不再发剩下的图', async () => {
  let enabled = true;
  const images = [0, 1].map((index) => ({ mediaType: 'image/png' as const, data: PNG_BASE64, name: `${index}.png` }));
  await withHarness({
    isEnabled: () => enabled,
    // 第一张图发出后立即停用，模拟面板在图片阶段关掉插件。
    onSend: (message) => {
      if (message.item_list?.[0]?.image_item !== undefined) enabled = false;
    },
  }, async (h) => {
    const receipt = await h.bridge.deliver(delivery({ id: 'disabled-mid-images', title: '', body: '看图', images }));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.errorCode, 'other');
    assert.equal(h.images.length, 1, '第二张图没有发出去');
    assert.equal(h.sent.length, 0, '图片没发完就不发文字');
  });
});
