/**
 * 「正在输入」状态（ADR-0007）：主人的消息被核心受理后、首段交付送达前，
 * 让微信那头显示输入中。
 *
 * 协议事实（官方 `openclaw-weixin` 3.0.0-beta-0 的参考实现）：
 * - `ilink/bot/getconfig` 按用户取 `typing_ticket`，请求要带该用户最近一条消息的
 *   `context_token`；ticket 缓存 24 小时，取失败按 2 秒起指数退避（上限 1 小时）；
 * - `ilink/bot/sendtyping` 带 ticket 发 status=1（开始）/ 2（取消），思考期间每
 *   5 秒重发一次保活；ticket 为空就不发。
 *
 * 这里是**尽力而为**的呈现层信号：取 ticket、发状态的任何失败只记日志，绝不影响
 * 收发主链路。时机是近似——受理即开、交付一进 `deliver` 就关，另有 10 分钟兜底
 * 超时，核心一直不回话也不会让输入状态永远挂着。
 */

import type { ILinkApi } from './ilink/api.ts';
import { TypingStatus } from './ilink/types.ts';

/** 保活间隔：与官方 `keepaliveIntervalMs` 一致。 */
export const KEEPALIVE_MS = 5_000;
/** 兜底超时：核心一直没有交付时，到点自动取消。 */
export const MAX_DURATION_MS = 10 * 60_000;
/** ticket 缓存时长（官方为 24 小时内随机刷新，这里取固定值，单用户场景无差别）。 */
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60 * 60 * 1000;

export interface TypingLogger {
  warn?(...args: unknown[]): unknown;
}

export interface TypingIndicatorOptions {
  /** 取当前可用客户端；未登录时返回 null。 */
  api: () => ILinkApi | null;
  /** 该用户最近一条消息带回来的 `context_token`（getconfig 要用）。 */
  contextToken: (userId: string) => string | undefined;
  /** 运行开关：关掉后不发任何输入状态。 */
  enabled?: () => boolean;
  logger?: TypingLogger;
  now?: () => number;
  /** 测试注入：保活间隔与兜底超时。 */
  keepaliveMs?: number;
  maxDurationMs?: number;
}

interface TicketEntry {
  ticket: string;
  /** 到点才重新请求 getconfig。 */
  nextFetchAt: number;
  /** 连续失败后的退避时长。 */
  delayMs: number;
}

interface Session {
  userId: string;
  ticket: string;
  /** status=1 已发出：stop 时要补一条 status=2。 */
  sentTyping: boolean;
  /** 已被 stop/替换：在途的异步步骤据此安静退出。 */
  cancelled: boolean;
  keepalive: ReturnType<typeof setInterval> | undefined;
  deadline: ReturnType<typeof setTimeout> | undefined;
}

function keyOf(userId: string): string {
  return userId.trim().toLowerCase();
}

export class TypingIndicator {
  readonly #api: () => ILinkApi | null;
  readonly #contextToken: (userId: string) => string | undefined;
  readonly #enabled: (() => boolean) | undefined;
  readonly #logger: TypingLogger | undefined;
  readonly #now: () => number;
  readonly #keepaliveMs: number;
  readonly #maxDurationMs: number;
  readonly #sessions = new Map<string, Session>();
  readonly #tickets = new Map<string, TicketEntry>();

  constructor(options: TypingIndicatorOptions) {
    this.#api = options.api;
    this.#contextToken = options.contextToken;
    this.#enabled = options.enabled;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
    this.#maxDurationMs = options.maxDurationMs ?? MAX_DURATION_MS;
  }

  /** 开始为某个用户显示输入状态；同一用户重复调用是 no-op。 */
  start(userId: string): void {
    if (this.#enabled && !this.#enabled()) return;
    const key = keyOf(userId);
    if (key === '' || this.#sessions.has(key)) return;
    const session: Session = {
      userId,
      ticket: '',
      sentTyping: false,
      cancelled: false,
      keepalive: undefined,
      deadline: undefined,
    };
    this.#sessions.set(key, session);
    void this.#begin(key, session);
  }

  /** 取消某个用户的输入状态；没有会话时是 no-op。 */
  stop(userId: string): void {
    const key = keyOf(userId);
    const session = this.#sessions.get(key);
    if (!session) return;
    this.#sessions.delete(key);
    this.#end(session);
  }

  /** 取消全部（停机、登出、停用、切出核心接入时调用）。 */
  stopAll(): void {
    for (const session of [...this.#sessions.values()]) {
      this.#sessions.delete(keyOf(session.userId));
      this.#end(session);
    }
  }

  async #begin(key: string, session: Session): Promise<void> {
    const ticket = await this.#ticketFor(session.userId);
    if (session.cancelled || this.#sessions.get(key) !== session) return;
    if (ticket === '') {
      // 取不到 ticket：安静退出，退避由 ticket 缓存负责。
      this.#sessions.delete(key);
      return;
    }
    const api = this.#api();
    if (!api) {
      this.#sessions.delete(key);
      return;
    }
    session.ticket = ticket;
    try {
      await api.sendTyping({ userId: session.userId, typingTicket: ticket, status: TypingStatus.TYPING });
      session.sentTyping = true;
    } catch (error) {
      this.#logger?.warn?.('输入状态发送失败', messageOf(error));
      // 开局就发不出去，保活没有意义；ticket 留在缓存里，下次 start 直接重试。
      if (this.#sessions.get(key) === session) this.#sessions.delete(key);
      return;
    }
    // 发送期间被 stop：立刻补取消，别把「正在输入」漏在微信上。
    if (session.cancelled || this.#sessions.get(key) !== session) {
      this.#sendCancel(session);
      return;
    }
    session.keepalive = setInterval(() => {
      void api
        .sendTyping({ userId: session.userId, typingTicket: session.ticket, status: TypingStatus.TYPING })
        .catch((error: unknown) => {
          this.#logger?.warn?.('输入状态保活失败', messageOf(error));
        });
    }, this.#keepaliveMs);
    session.keepalive.unref?.();
    session.deadline = setTimeout(() => this.stop(session.userId), this.#maxDurationMs);
    session.deadline.unref?.();
  }

  /** 结束会话：清定时器，已发出过 status=1 就补一条取消（尽力而为）。 */
  #end(session: Session): void {
    session.cancelled = true;
    if (session.keepalive !== undefined) clearInterval(session.keepalive);
    if (session.deadline !== undefined) clearTimeout(session.deadline);
    if (session.sentTyping) this.#sendCancel(session);
  }

  #sendCancel(session: Session): void {
    const api = this.#api();
    if (!api || session.ticket === '') return;
    void api
      .sendTyping({ userId: session.userId, typingTicket: session.ticket, status: TypingStatus.CANCEL })
      .catch((error: unknown) => {
        this.#logger?.warn?.('输入状态取消失败', messageOf(error));
      });
  }

  /**
   * 取 ticket：缓存内直接用；到点才重新请求，失败按指数退避。
   *
   * 没有客户端时不写缓存（登出后重新登录应立刻能取），其余失败都记退避，
   * 避免每条入站消息都去打 getconfig。
   */
  async #ticketFor(userId: string): Promise<string> {
    const key = keyOf(userId);
    const now = this.#now();
    const entry = this.#tickets.get(key);
    if (entry && now < entry.nextFetchAt) return entry.ticket;
    const api = this.#api();
    if (!api) return '';
    const contextToken = this.#contextToken(userId) ?? '';
    try {
      const response = await api.getConfig({ userId, contextToken });
      if (response.ret === 0) {
        const ticket = response.typing_ticket ?? '';
        this.#tickets.set(key, { ticket, nextFetchAt: now + TICKET_TTL_MS, delayMs: RETRY_MIN_MS });
        return ticket;
      }
      throw new Error(`getconfig ret=${response.ret ?? '空'}`);
    } catch (error) {
      const delay = Math.min(entry ? entry.delayMs * 2 : RETRY_MIN_MS, RETRY_MAX_MS);
      this.#tickets.set(key, {
        ticket: entry?.ticket ?? '',
        nextFetchAt: now + delay,
        delayMs: delay,
      });
      this.#logger?.warn?.('输入状态取 ticket 失败', messageOf(error));
      return '';
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
