/** `runtime.test.ts` 的公共夹具：假协议客户端、假超级助理服务与临时目录工具。 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ILinkApi } from '../../../src/host/ilink/api.ts';
import type { WeixinMessage } from '../../../src/host/ilink/types.ts';
import type {
  BridgeProvider,
  OwnerMessageDraft,
  RejectReason,
} from '../../../src/host/superagent/protocol.ts';

export const ACCOUNT = 'bot@im.bot';
export const OWNER = 'owner-1';
export const LOGIN = {
  botToken: 'tok',
  account: ACCOUNT,
  userId: OWNER,
  baseUrl: 'https://ilinkai.weixin.qq.com',
  loggedInAt: 1_760_000_000_000,
};

/** 假客户端：按脚本回放入站消息，其余调用只记账。 */
export function fakeApi(options: {
  batches?: WeixinMessage[][];
  qrStatus?: Record<string, unknown>[];
  typingTicket?: string;
} = {}) {
  const batches = [...(options.batches ?? [])];
  const qrStatus = [...(options.qrStatus ?? [{ status: 'confirmed', ...LOGIN, bot_token: LOGIN.botToken, ilink_bot_id: ACCOUNT }])];
  const record = {
    getUpdatesCalls: 0,
    tokens: [] as (string | undefined)[],
    sent: [] as string[],
    notifyStart: 0,
    notifyStop: 0,
    qrCodeCalls: 0,
    qrStatusCalls: 0,
    typing: [] as { userId: string; typingTicket: string; status: number }[],
  };
  let index = 0;
  const impl = (options2: { token?: string }): ILinkApi => {
    record.tokens.push(options2.token);
    return {
      async getUpdates(params: { signal?: AbortSignal }) {
        record.getUpdatesCalls += 1;
        const batch = batches.shift();
        if (batch) return { ret: 0, msgs: batch, get_updates_buf: `cursor-${index}` };
        return new Promise((_resolve, reject) => {
          params.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
      async sendMessage(message: { item_list?: { text_item?: { text?: string } }[] }) {
        record.sent.push(message.item_list?.[0]?.text_item?.text ?? '');
      },
      async notifyStart() {
        record.notifyStart += 1;
      },
      async notifyStop() {
        record.notifyStop += 1;
      },
      async getBotQrCode() {
        record.qrCodeCalls += 1;
        return { qrcode: 'qr-1', qrcode_img_content: 'https://weixin.qq.com/x/qr-1' };
      },
      async getQrStatus() {
        record.qrStatusCalls += 1;
        index += 1;
        return qrStatus.shift() ?? { status: 'wait' };
      },
      async getConfig() {
        return options.typingTicket === undefined ? {} : { ret: 0, typing_ticket: options.typingTicket };
      },
      async sendTyping(params: { userId: string; typingTicket: string; status: number }) {
        record.typing.push(params);
      },
    } as unknown as ILinkApi;
  };
  return { createApi: impl, record };
}

export function fakeSuperagent(options: { features?: string[]; rejectReason?: RejectReason; failRegister?: number } = {}) {
  const providers: BridgeProvider[] = [];
  const received: OwnerMessageDraft[] = [];
  const cleanups: (() => void)[] = [];
  let registerAttempts = 0;
  const service = {
    protocol: { versions: ['my-superagent/v1'], features: options.features ?? ['owner-images', 'owner-lookup'] },
    bridges: {
      register(provider: BridgeProvider) {
        registerAttempts += 1;
        if (options.failRegister !== undefined && registerAttempts <= options.failRegister) {
          throw new Error('account-already-bridged');
        }
        providers.push(provider);
        return {
          id: `weixin:${provider.account}`,
          protocol: 'my-superagent/v1',
          async receive(draft: OwnerMessageDraft) {
            received.push(draft);
            return options.rejectReason
              ? ({ accepted: false as const, reason: options.rejectReason } as const)
              : ({ accepted: true as const } as const);
          },
          async answer() {
            return { accepted: true as const };
          },
          update() {},
          commands: () => [],
          isOwner: (sender: string) => sender === OWNER,
          dispose() {},
        };
      },
    },
  };
  const scope = {
    mySuperagent: service,
    effect: (execute: () => () => void) => {
      cleanups.push(execute());
      return undefined;
    },
  };
  return { service, scope, providers, received, cleanups };
}

export async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`等待超时：${label}`);
}

export async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-runtime-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
