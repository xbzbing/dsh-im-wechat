/**
 * 主人的收发通道：收件人解析、发送与失败记账。
 *
 * 收件人**只认扫码登录的那个微信用户**：不能退回到「最近一个发消息的人」——
 * 陌生人只要给机器人发一句话，就能把待答问题答掉、还能成为后续提醒的收件人
 * （ADR-0004 的同一类风险）。
 *
 * 自有功能（问题提醒、长任务提醒）才用这条通道：接入核心后提醒由核心发，这里
 * 不该再出声（ADR-0006）。
 */

import { DEFAULT_CDN_BASE_URL } from './ilink/api.ts';
import type { ILinkApi } from './ilink/api.ts';
import { messageOf } from './host-context.ts';
import { sendText } from './ilink/send.ts';
import { sendPresentedImages } from './present-images.ts';

export interface OwnerChannelOptions {
  /** 自有功能是否生效（启用 + 未接入核心 + 已登录 + 未停机）。 */
  active: () => boolean;
  api: () => ILinkApi | null;
  account: () => string | undefined;
  /** 扫码登录的微信用户；没有就是「不知道主人是谁」。 */
  ownerId: () => string | undefined;
  token: (account: string, to: string) => string | undefined;
  noteError: (message: string) => void;
  /** 出站图片走的 CDN 基址；缺省用默认。 */
  cdnBaseUrl?: () => string;
  /** 上传用 fetch（测试注入）。 */
  fetch?: () => typeof globalThis.fetch | undefined;
  logger?: { warn?(...args: unknown[]): unknown };
}

export class OwnerChannel {
  readonly #options: OwnerChannelOptions;

  constructor(options: OwnerChannelOptions) {
    this.#options = options;
  }

  /** 自有功能的收件人；未生效或主人未知时返回 null。 */
  recipient(): string | null {
    if (!this.#options.active()) return null;
    return this.#ownerId() ?? null;
  }

  /** 发送者是不是已确认的主人（扫码登录的那个用户）。 */
  isOwner(sender: string): boolean {
    const owner = this.#ownerId();
    return owner !== undefined && owner.toLowerCase() === sender.toLowerCase();
  }

  /** 把一段文本发到主人的微信；没有可用令牌时返回 false。 */
  async send(text: string): Promise<boolean> {
    const api = this.#options.api();
    const account = this.#options.account();
    const recipient = this.recipient();
    if (!api || !account || recipient === null) return false;
    try {
      await sendText(api, {
        to: recipient,
        text,
        contextToken: this.#options.token(account, recipient),
      });
      return true;
    } catch (error) {
      this.#options.noteError(`提醒发送失败：${messageOf(error)}`);
      return false;
    }
  }

  /** 把本地图片发到主人的微信（present 转发，ADR-0019）；没有任何一张成功时返回 false。 */
  async sendImages(paths: readonly string[]): Promise<boolean> {
    const api = this.#options.api();
    const account = this.#options.account();
    const recipient = this.recipient();
    if (!api || !account || recipient === null) return false;
    const token = this.#options.token(account, recipient);
    if (token === undefined || token.trim() === '') {
      this.#options.noteError('缺少 context_token，图片暂不能发到微信');
      return false;
    }
    const fetch = this.#options.fetch?.();
    const result = await sendPresentedImages(paths, {
      api,
      to: recipient,
      contextToken: token,
      cdnBaseUrl: this.#options.cdnBaseUrl?.() ?? DEFAULT_CDN_BASE_URL,
      ...(fetch ? { fetch } : {}),
      ...(this.#options.logger ? { logger: this.#options.logger } : {}),
    });
    if (result.failed.length > 0) {
      this.#options.noteError(`图片没能发到微信：${result.failed[0]!.reason}`);
    } else if (result.sent === 0 && result.skipped > 0) {
      // 模型以为交付了、微信那头什么都没有：至少在面板留一句（非图片文件是刻意跳过）。
      this.#options.noteError('present 的图片没有发出去：不是可发送的图片或超过 10 MiB');
    }
    return result.sent > 0;
  }

  #ownerId(): string | undefined {
    const owner = this.#options.ownerId();
    return typeof owner === 'string' && owner !== '' ? owner : undefined;
  }
}
