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
import { MAX_TEXT_BYTES, composeDeliveryText, splitText } from './render.ts';

export const WEIXIN_PLATFORM = 'weixin';

/**
 * context_token 的声明有效期：24 小时（ADR-0015）。
 *
 * 腾讯没有公开这个值，只能取公开口径与本机实测的交集：第三方渠道一致写 24 小时，
 * 本机 14.4 小时与 18.0 小时的 token 都发送成功（ADR-0015 的实测表）。
 * 声明过长会把注定被拒的交付排给本桥，过短则把还能发的窗口让给别的桥；
 * 核心据此在窗口外跳过本桥，真实边界仍由 `#logWindowClosed` 记录的 token 年龄收紧。
 */
export const TOKEN_WINDOW_MS = 24 * 60 * 60_000;

/**
 * 一个窗口内最多能主动发多少条：公开口径是「每 10 条需用户再开口」
 * （PushPlus / MagicPush / 曲辕三处一致，见 docs/protocol/ilink-消息与媒体.md）。
 *
 * 核心据此算窗口内的条数额度，并在用尽之前请主人回一句话续约（核心 ADR-0033）；
 * 桥这边只负责如实上报这条交付占了几条。
 *
 * 与 `capabilities.quotas` 的 10 条/分钟不是一回事：那是连发节奏，这是 24 小时窗口内的总额度。
 */
export const MESSAGES_PER_WINDOW = 10;

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
  /** 扫码登录的微信用户：deliver 的收件人必须与它一致，否则拒发（ADR-0012 的红线）。 */
  ownerId: () => string | undefined;
  /** 交付进入投递流程时回调（收件人）：用于收起「正在输入」（ADR-0007）。 */
  onDelivered?: (recipient: string) => void;
  /** CDN 基址（服务端下发的配置）；上传图片时用。 */
  cdnBaseUrl?: string;
  /** 上传图片用的 fetch；测试注入，运行时用全局 fetch。 */
  uploadFetch?: typeof globalThis.fetch;
  /** 分条节流的等待；测试注入以免真实等待声明窗口。 */
  sleep?: (ms: number) => Promise<void>;
  /** 当前时刻（毫秒）；测试注入，生产用 Date.now。 */
  now?: () => number;
}

/** 进度表只放最近 100 条，避免长时间运行后无界增长。 */
const PROGRESS_LIMIT = 100;

function rememberBounded<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  while (map.size > PROGRESS_LIMIT) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
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
  readonly #ownerId: () => string | undefined;
  readonly #onDelivered: ((recipient: string) => void) | undefined;
  /** 已发到第几条：`delivery.id` → 条数，用于断点续发。 */
  readonly #progress = new Map<string, number>();
  /** 在途投递：同一 `delivery.id` 的并发调用复用同一次，避免两路都从第 1 段发。 */
  readonly #inflight = new Map<string, Promise<Receipt>>();
  /** 已发到第几张图（ADR-0010）：断点续发，避免重试把已到的图再发一遍。 */
  readonly #imageProgress = new Map<string, number>();
  /** 最后一张图发出去得到的平台消息 id：图片-only 交付的回执要用，断点续发时复用。 */
  readonly #imageMessageIds = new Map<string, string>();
  /** 平台没回 message_id 的告警节流：协议漂移只需要看见一次。 */
  #noIdWarnedAt: number | undefined;
  readonly #cdnBaseUrl: string;
  readonly #uploadFetch: typeof globalThis.fetch | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #handle: BridgeHandle | null = null;
  #features: ReadonlySet<string> = new Set();

  constructor(options: WeixinBridgeOptions) {
    this.account = options.account;
    this.#api = options.api;
    this.#contextTokens = options.contextTokens;
    this.#guard = options.guard;
    this.#logger = options.logger;
    this.#maxText = options.maxText ?? MAX_TEXT_BYTES;
    this.#health = options.health;
    this.#isEnabled = options.isEnabled;
    this.#ownerId = options.ownerId;
    this.#onDelivered = options.onDelivered;
    this.#cdnBaseUrl = options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL;
    this.#uploadFetch = options.uploadFetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
    this.capabilities = {
      // 微信客户端原生渲染 Markdown（表格、代码块、标题都支持），见 ADR-0008。
      markdown: 'full',
      maxText: { max: this.#maxText, unit: 'utf8-byte' },
      detail: false,
      nativeCommands: false,
      // 收得到用户引用消息里的被引用 id，核心据此把引用回一句转给对应会话。
      quoteReply: true,
      // 每分钟最多 10 条的连发限制：待真机实测（M5），先按保守值声明，核心据此做发送节奏。
      // 与下面 outbound.maxMessagesPerWindow 的 10 是两回事：那个是 24 小时窗口内的总额度。
      quotas: [{ scope: 'bot', max: 10, windowMs: 60_000 }],
      // 窗口从收到 token 起算（ADR-0013）：核心据此在窗口外把交付让给下一座桥。
      // 条数额度是同一份账的第二维：窗口内条数用尽同样发不出去，核心会提前请主人续约。
      outbound: {
        requiresPriorInbound: true,
        windowMs: TOKEN_WINDOW_MS,
        maxMessagesPerWindow: MESSAGES_PER_WINDOW,
        images: true,
      },
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
        const result = await sendImage(api, { to: recipient, upload, contextToken });
        if (result.messageId !== undefined) rememberBounded(this.#imageMessageIds, delivery.id, result.messageId);
        rememberBounded(this.#imageProgress, delivery.id, sent + 1);
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

    // 收件人恒为扫码登录的主人（对齐 owner-channel.isOwner）：context_token 对
    // 任意来过消息的人都存在，挡不住发错人，这里补上最后一道闸（ADR-0012 红线）。
    const owner = this.#ownerId();
    const recipient = delivery.recipient;
    if (owner === undefined || owner.toLowerCase() !== recipient.toLowerCase()) {
      this.#logger?.warn?.(`微信投递被拒：收件人不是登录主人（${delivery.id}）`);
      return { ...base, status: 'failed', errorCode: 'other', error: '收件人不是登录主人' };
    }

    const text = composeDeliveryText(delivery);
    const parts = splitText(text, this.#maxText);
    const images = delivery.images ?? [];
    // 没有正文也没有图：一条都没发出去，如实报 0 条，别让核心把这条算进额度。
    if (parts.length === 0 && images.length === 0) return { ...base, status: 'sent', messagesSent: 0 };

    const contextToken = this.#contextTokens.get(this.account, recipient);

    // 整条交付最后发出去那一条的平台消息 id：用户引用哪条，就靠它认回这次交付。
    // 只记最后一条（取舍见 ADR-0022）：引用前面的分条认不回来，会退回前台。
    let lastMessageId: string | undefined;
    // 图片先发：文字里通常写着「图见上」，图没到就发文字会让人以为没发。
    if (images.length > 0) {
      const failure = await this.#sendImages(api, delivery, recipient, contextToken);
      if (failure) return { ...base, ...failure };
      // 图片-only 交付没有文字覆盖，回执就靠最后一张图的 id。
      lastMessageId = this.#imageMessageIds.get(delivery.id);
    }
    let sent = this.#progress.get(delivery.id) ?? 0;
    // 桥自己执行自己声明的配额：核心只见一次 deliver，按交付节流管不到分条扇出。
    const quota = this.capabilities.quotas?.[0];

    for (; sent < parts.length; sent += 1) {
      if (quota !== undefined && sent > 0 && sent % quota.max === 0) {
        await this.#sleep(quota.windowMs);
        // 等待期间可能被停用/暂停：复查，进度保留，核心重试时断点续发。
        if (this.#isEnabled && !this.#isEnabled()) {
          return { ...base, status: 'failed', errorCode: 'other', error: '插件已停用' };
        }
        if (this.#guard.isPaused(this.account)) {
          return { ...base, status: 'failed', errorCode: 'auth-expired', error: 'token 已失效，已暂停发送' };
        }
      }
      try {
        const result = await sendText(api, { to: recipient, text: parts[sent], contextToken });
        if (result.messageId !== undefined) lastMessageId = result.messageId;
        rememberBounded(this.#progress, delivery.id, sent + 1);
      } catch (error) {
        const failure = classifySendFailure(error);
        if (failure.certainty === 'uncertain') {
          // 结果未知：核心不重发，进度与图片断点都已无意义，清掉不留死条目。
          this.#progress.delete(delivery.id);
          this.#imageProgress.delete(delivery.id);
          this.#imageMessageIds.delete(delivery.id);
          this.#logger?.warn?.(`微信发送结果未知（${delivery.id}）`, failure.message);
          return { ...base, status: 'uncertain', error: failure.message };
        }
        // 确定失败：保留进度，核心重试时从断点续发。
        this.#logger?.warn?.(`微信发送失败（${delivery.id}）`, failure.message);
        // 被拒时记录 token 年龄：多次窗口拒绝的年龄会夹出真实有效期，用于收紧声明值（ADR-0013）。
        if (failure.code === 'window-closed') this.#logWindowClosed(delivery.recipient);
        return { ...base, status: 'failed', errorCode: failure.code, error: failure.message };
      }
    }

    this.#progress.delete(delivery.id);
    this.#imageProgress.delete(delivery.id);
    this.#imageMessageIds.delete(delivery.id);
    // 平台没回 message_id：不编造，但让它在面板上留下一次痕迹（协议漂移探针）。
    if (lastMessageId === undefined) this.#warnMissingMessageId(delivery.id);
    return {
      ...base,
      status: 'sent',
      // 整条交付一共占了几条额度：中途失败的那几次回执是 failed，核心不据此记账，
      // 所以成功这一次要给总数（图 + 文字分条），断点续发也只在这一次结算。
      messagesSent: images.length + parts.length,
      ...(lastMessageId ? { bridgeMessageId: lastMessageId } : {}),
    };
  }

  /** 平台没回 message_id 时按小时告警一次：让协议漂移在面板上可见，而不是静默少一个 id。 */
  #warnMissingMessageId(deliveryId: string): void {
    const now = this.#now();
    if (this.#noIdWarnedAt !== undefined && now - this.#noIdWarnedAt < 3_600_000) return;
    this.#noIdWarnedAt = now;
    this.#logger?.warn?.('微信发送成功但没有返回 message_id：引用回指会失效', deliveryId);
  }

  /** 被拒时记下 token 年龄：收紧声明有效期的依据；从磁盘灌进来的年龄未知。 */
  #logWindowClosed(recipient: string): void {
    const age = this.#contextTokens.age(this.account, recipient);
    this.#logger?.warn?.(age === undefined
      ? '微信发送被拒：窗口已关（token 年龄未知）'
      : `微信发送被拒：窗口已关（token 已存在 ${Math.round(age / 60_000)} 分钟）`);
  }
}
