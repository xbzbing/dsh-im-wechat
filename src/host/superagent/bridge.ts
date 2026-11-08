/**
 * 超级助理桥：把 `deliver` 落到微信，把健康状态如实报给核心。
 *
 * 桥的职责边界（AGENTS.md「安全红线」）：呈现与转发，不解析命令、不判断身份。
 * 交付的降级规则在 `render.ts`；发送与回执映射在 `ilink/send.ts`。
 *
 * 分条发送的幂等：核心对 `failed` 的回执会重试同一个 `delivery.id`。若第一条已
 * 发出、第二条失败，重试必须从断点续发，否则主人会收到重复内容。进度只留在内存
 * 里——进程重启后重发一遍，比「以为发过其实没发」安全。
 */

import { classifySendFailure, sendImage, sendText } from '../ilink/send.ts';
import { DEFAULT_CDN_BASE_URL } from '../ilink/api.ts';
import { CdnUploadError, uploadImage } from '../ilink/upload.ts';
import type { ILinkApi } from '../ilink/api.ts';
import type { SessionGuard } from '../ilink/session-guard.ts';
import type { ContextTokenStore } from '../state/context-tokens.ts';
import {
  FEATURE_OWNER_IMAGES,
  FEATURE_OWNER_LOOKUP,
  PROTOCOL_V1,
} from './protocol.ts';
import type {
  BridgeCapabilities,
  BridgeHandle,
  BridgeHealth,
  BridgeProvider,
  Delivery,
  Receipt,
} from './protocol.ts';
import { MAX_TEXT_CHARS, composeDeliveryText, splitText } from './render.ts';

export const WEIXIN_PLATFORM = 'weixin';

export interface BridgeLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
}

export interface WeixinBridgeOptions {
  /** 机器人账号（`ilink_bot_id`），与 `platform` 一起构成桥 id。 */
  account: string;
  /** 取当前可用的客户端；未登录时返回 null。 */
  api: () => ILinkApi | null;
  contextTokens: ContextTokenStore;
  guard: SessionGuard;
  logger?: BridgeLogger;
  maxText?: number;
  /** 连接健康状态来源（轮询循环维护）。 */
  health?: () => BridgeHealth;
  /** 运行开关：停用时不收不发，并让核心把流量路由到别的桥。 */
  isEnabled?: () => boolean;
  /** 交付进入投递流程时回调（收件人）：用于收起「正在输入」（ADR-0007）。 */
  onDelivered?: (recipient: string) => void;
  /** CDN 基址（服务端下发的配置）；上传图片时用。 */
  cdnBaseUrl?: string;
  /** 上传图片用的 fetch；测试注入，运行时用全局 fetch。 */
  uploadFetch?: typeof globalThis.fetch;
}

export class WeixinBridge implements BridgeProvider {
  readonly platform = WEIXIN_PLATFORM;
  readonly account: string;
  readonly protocol: readonly string[] = [PROTOCOL_V1];
  readonly capabilities: BridgeCapabilities;

  readonly #api: () => ILinkApi | null;
  readonly #contextTokens: ContextTokenStore;
  readonly #guard: SessionGuard;
  readonly #logger: BridgeLogger | undefined;
  readonly #maxText: number;
  readonly #health: (() => BridgeHealth) | undefined;
  readonly #isEnabled: (() => boolean) | undefined;
  readonly #onDelivered: ((recipient: string) => void) | undefined;
  /** 已发到第几条：`delivery.id` → 条数，用于断点续发。 */
  readonly #progress = new Map<string, number>();
  /** 在途投递：同一 `delivery.id` 的并发调用复用同一次，避免两路都从第 1 段发。 */
  readonly #inflight = new Map<string, Promise<Receipt>>();
  /** 已发到第几张图（ADR-0010）：断点续发，避免重试把已到的图再发一遍。 */
  readonly #imageProgress = new Map<string, number>();
  readonly #cdnBaseUrl: string;
  readonly #uploadFetch: typeof globalThis.fetch | undefined;
  #handle: BridgeHandle | null = null;
  #features: ReadonlySet<string> = new Set();

  constructor(options: WeixinBridgeOptions) {
    this.account = options.account;
    this.#api = options.api;
    this.#contextTokens = options.contextTokens;
    this.#guard = options.guard;
    this.#logger = options.logger;
    this.#maxText = options.maxText ?? MAX_TEXT_CHARS;
    this.#health = options.health;
    this.#isEnabled = options.isEnabled;
    this.#onDelivered = options.onDelivered;
    this.#cdnBaseUrl = options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL;
    this.#uploadFetch = options.uploadFetch;
    this.capabilities = {
      // 微信客户端原生渲染 Markdown（表格、代码块、标题都支持），见 ADR-0008。
      markdown: 'full',
      maxText: { max: this.#maxText, unit: 'char' },
      detail: false,
      nativeCommands: false,
      // 平台连发限制待真机实测（M5），先按保守值声明，核心据此节流。
      quotas: [{ scope: 'bot', max: 10, windowMs: 60_000 }],
      // 能随交付发图片（ADR-0010）：核心据此把 Delivery.images 一起发过来。
      outbound: { requiresPriorInbound: true, images: true },
    };
  }

  /** 注册成功后由装配层挂上句柄与核心能力声明。 */
  attachHandle(handle: BridgeHandle, features: readonly string[]): void {
    this.#handle = handle;
    this.#features = new Set(features);
  }

  detachHandle(): void {
    this.#handle = null;
    this.#features = new Set();
  }

  /** 核心声明 `owner-images` 时才下载入站图片（ADR-0004）。 */
  get imagesEnabled(): boolean {
    return this.#features.has(FEATURE_OWNER_IMAGES);
  }

  /** 核心声明 `owner-lookup` 时才可用；否则不判断身份，交由核心拒收。 */
  get ownerLookup(): ((sender: string) => boolean) | undefined {
    const handle = this.#handle;
    if (!handle || !this.#features.has(FEATURE_OWNER_LOOKUP)) return undefined;
    const isOwner = handle.isOwner;
    if (typeof isOwner !== 'function') return undefined;
    return (sender: string) => isOwner.call(handle, sender);
  }

  health(): BridgeHealth {
    if (this.#isEnabled && !this.#isEnabled()) {
      return { state: 'down', code: 'other', reason: '插件已停用' };
    }
    if (this.#guard.isPaused(this.account)) {
      return { state: 'down', code: 'auth-expired', reason: 'token 已失效，需要重新扫码登录' };
    }
    if (!this.#api()) {
      return { state: 'down', code: 'auth-expired', reason: '尚未登录微信' };
    }
    return this.#health?.() ?? { state: 'ok' };
  }

  async deliver(delivery: Delivery): Promise<Receipt> {
    // 交付一进投递流程，模型的产出就要到微信了，输入状态失去意义（ADR-0007）。
    this.#onDelivered?.(delivery.recipient);
    const existing = this.#inflight.get(delivery.id);
    if (existing) return existing;
    const task = this.#deliverOnce(delivery).finally(() => {
      this.#inflight.delete(delivery.id);
    });
    this.#inflight.set(delivery.id, task);
    return task;
  }

  // 逐张上传并发送；返回失败时只带失败字段。进度按张记，重试从下一张接着发。
  async #sendImages(
    api: ILinkApi,
    delivery: Delivery,
    recipient: string,
    contextToken: string | undefined,
  ): Promise<Pick<Receipt, 'status' | 'error' | 'errorCode'> | undefined> {
    const images = delivery.images ?? [];
    let sent = this.#imageProgress.get(delivery.id) ?? 0;
    for (; sent < images.length; sent += 1) {
      const image = images[sent]!;
      try {
        const upload = await uploadImage(
          api,
          { data: Buffer.from(image.data, 'base64'), toUserId: recipient },
          { cdnBaseUrl: this.#cdnBaseUrl, ...(this.#uploadFetch ? { fetch: this.#uploadFetch } : {}) },
        );
        await sendImage(api, { to: recipient, upload, contextToken });
        this.#imageProgress.set(delivery.id, sent + 1);
      } catch (error) {
        const failure = classifySendFailure(error);
        if (failure.certainty === 'uncertain') {
          this.#imageProgress.delete(delivery.id);
          this.#logger?.warn?.(`微信图片发送结果未知（${delivery.id}）`, failure.message);
          return { status: 'uncertain', error: failure.message };
        }
        const message = error instanceof CdnUploadError ? `图片上传失败：${error.message}` : failure.message;
        this.#logger?.warn?.(`微信图片发送失败（${delivery.id}）`, message);
        return { status: 'failed', errorCode: failure.code, error: message };
      }
    }
    return undefined;
  }

  async #deliverOnce(delivery: Delivery): Promise<Receipt> {
    const base = { deliveryId: delivery.id };
    if (this.#isEnabled && !this.#isEnabled()) {
      return { ...base, status: 'failed', errorCode: 'other', error: '插件已停用' };
    }
    if (this.#guard.isPaused(this.account)) {
      return {
        ...base,
        status: 'failed',
        errorCode: 'auth-expired',
        error: 'token 已失效，已暂停发送',
      };
    }
    const api = this.#api();
    if (!api) {
      return { ...base, status: 'failed', errorCode: 'auth-expired', error: '尚未登录微信' };
    }

    const text = composeDeliveryText(delivery);
    const parts = splitText(text, this.#maxText);
    const images = delivery.images ?? [];
    if (parts.length === 0 && images.length === 0) return { ...base, status: 'sent' };

    const recipient = delivery.recipient;
    const contextToken = this.#contextTokens.get(this.account, recipient);

    // 图片先发：文字里通常写着「图见上」，图没到就发文字会让人以为没发。
    if (images.length > 0) {
      const failure = await this.#sendImages(api, delivery, recipient, contextToken);
      if (failure) return { ...base, ...failure };
    }
    let sent = this.#progress.get(delivery.id) ?? 0;
    let lastClientId: string | undefined;

    for (; sent < parts.length; sent += 1) {
      try {
        const result = await sendText(api, { to: recipient, text: parts[sent], contextToken });
        lastClientId = result.clientId;
        this.#remember(delivery.id, sent + 1);
      } catch (error) {
        const failure = classifySendFailure(error);
        if (failure.certainty === 'uncertain') {
          // 结果未知：核心不重发，进度已无意义。
          this.#progress.delete(delivery.id);
          this.#logger?.warn?.(`微信发送结果未知（${delivery.id}）`, failure.message);
          return { ...base, status: 'uncertain', error: failure.message };
        }
        // 确定失败：保留进度，核心重试时从断点续发。
        this.#logger?.warn?.(`微信发送失败（${delivery.id}）`, failure.message);
        return { ...base, status: 'failed', errorCode: failure.code, error: failure.message };
      }
    }

    this.#progress.delete(delivery.id);
    this.#imageProgress.delete(delivery.id);
    return {
      ...base,
      status: 'sent',
      ...(lastClientId ? { bridgeMessageId: lastClientId } : {}),
    };
  }

  /** 进度表只放最近 100 条，避免长时间运行后无界增长。 */
  #remember(deliveryId: string, sentParts: number): void {
    this.#progress.set(deliveryId, sentParts);
    while (this.#progress.size > 100) {
      const oldest = this.#progress.keys().next();
      if (oldest.done) break;
      this.#progress.delete(oldest.value);
    }
  }
}
