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
}

async function harness(
  options: { failAt?: number[]; error?: Error; withToken?: boolean; noApi?: boolean } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-bridge-'));
  const sent: Sent[] = [];
  const tokens = new ContextTokenStore({ dir });
  if (options.withToken !== false) tokens.set(ACCOUNT, OWNER, 'ctx-1');
  const guard = new SessionGuard();
  let calls = 0;
  const api = {
    async sendMessage(message: { to_user_id: string; item_list?: { text_item?: { text?: string } }[] }) {
      calls += 1;
      if (options.failAt?.includes(calls)) throw options.error ?? new Error('boom');
      sent.push({
        to: message.to_user_id,
        text: message.item_list?.[0]?.text_item?.text ?? '',
      });
    },
  } as unknown as ILinkApi;
  const bridge = new WeixinBridge({
    account: ACCOUNT,
    api: () => (options.noApi ? null : api),
    contextTokens: tokens,
    guard,
    maxText: 20,
  });
  return { dir, bridge, sent, guard, tokens };
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
    assert.equal(h.sent.map((item) => item.text).join('\n'), body);
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
    assert.equal(h.sent.map((item) => item.text).join('\n'), body);
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
  assert.equal(bridge.capabilities.markdown, 'none');
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
