import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ILinkError } from '../../src/host/ilink/api.ts';
import type { ILinkApi } from '../../src/host/ilink/api.ts';
import { SessionGuard } from '../../src/host/ilink/session-guard.ts';
import { ContextTokenStore } from '../../src/host/state/context-tokens.ts';
import { WeixinBridge } from '../../src/host/superagent/bridge.ts';
import type { BridgeHealth, Delivery } from '../../src/host/superagent/protocol.ts';

export interface Sent {
  to: string;
  text: string;
}

export const ACCOUNT = 'bot@im.bot';
export const OWNER = 'owner-1';

export const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');

export function delivery(overrides: Partial<Delivery> = {}): Delivery {
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

export function withImage(overrides: Partial<Delivery> = {}): Delivery {
  return delivery({ title: '', body: 'A · Q 版抱鲸鱼', images: [{ mediaType: 'image/png', data: PNG_BASE64, name: 'a.png' }], ...overrides });
}

export interface Harness {
  dir: string;
  bridge: WeixinBridge;
  sent: Sent[];
  guard: SessionGuard;
  tokens: ContextTokenStore;
  images: Record<string, unknown>[];
  uploads: string[];
  warnings: string[];
}

export async function harness(
  options: {
    failAt?: number[];
    error?: Error;
    withToken?: boolean;
    noApi?: boolean;
    noOwner?: boolean;
    onDelivered?: (recipient: string) => void;
    uploadStatus?: number;
    uploadParam?: string;
    uploadFails?: boolean;
    maxText?: number;
    // 模拟平台不回 message_id：回执不能编造一个。
    noMessageId?: boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    deliverDeadlineMs?: number;
    health?: () => BridgeHealth;
    isEnabled?: () => boolean;
    onSend?: (message: { item_list?: Record<string, unknown>[] }) => void;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-bridge-'));
  const sent: Sent[] = [];
  const warnings: string[] = [];
  const tokens = new ContextTokenStore({ dir });
  if (options.withToken !== false) tokens.set(ACCOUNT, OWNER, 'ctx-1');
  const guard = new SessionGuard();
  let calls = 0;
  const images: Record<string, unknown>[] = [];
  const uploads: string[] = [];
  const api = {
    async sendMessage(message: { to_user_id: string; item_list?: Record<string, unknown>[] }) {
      calls += 1;
      options.onSend?.(message);
      if (options.failAt?.includes(calls)) throw options.error ?? new Error('boom');
      const item = message.item_list?.[0];
      if (item?.image_item !== undefined) {
        images.push(item.image_item as Record<string, unknown>);
        return options.noMessageId ? {} : { message_id: `wm-${calls}` };
      }
      sent.push({
        to: message.to_user_id,
        text: (item?.text_item as { text?: string } | undefined)?.text ?? '',
      });
      return options.noMessageId ? {} : { message_id: `wm-${calls}` };
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
    maxText: options.maxText ?? 20,
    ownerId: () => (options.noOwner ? undefined : OWNER),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.deliverDeadlineMs !== undefined ? { deliverDeadlineMs: options.deliverDeadlineMs } : {}),
    ...(options.health ? { health: options.health } : {}),
    ...(options.isEnabled ? { isEnabled: options.isEnabled } : {}),
    uploadFetch,
    logger: { warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); } },
    ...(options.onDelivered ? { onDelivered: options.onDelivered } : {}),
  });
  return { dir, bridge, sent, guard, tokens, images, uploads, warnings };
}

export async function withHarness(
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

/** 假时钟：等待多久就把时间拨多久，配额窗口才能在测试里滑出。 */
export function fakeClock(start = 1_000_000): { now: () => number; sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  let at = start;
  const sleeps: number[] = [];
  return {
    now: () => at,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      at += ms;
    },
  };
}
