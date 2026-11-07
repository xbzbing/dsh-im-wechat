/**
 * 长轮询收消息。
 *
 * 一个循环负责四件事：带上游标拉取、翻页后落盘游标、按稳定身份挡重复帧、
 * 失败时退避并对外报健康状态。协议细节见 `api.ts`；身份算法见 `identity.ts`。
 *
 * 失败处理对齐官方实现：`-14` 进闸门暂停一小时（`session-guard.ts`），其余
 * 失败连续 3 次后退避 30 秒，否则 2 秒后重试。轮询循环永不因单次失败退出。
 */

import type { ILinkApi } from './api.ts';
import { ILinkError } from './api.ts';
import { isStaleToken } from './session-guard.ts';
import type { SessionGuard } from './session-guard.ts';
import { messageIdentity } from './identity.ts';
import type { GetUpdatesResponse, WeixinMessage } from './types.ts';
import type { ContextTokenStore } from '../state/context-tokens.ts';
import type { SyncCursorStore } from '../state/sync-cursor.ts';

export type PollHealthCode = 'auth-expired' | 'network' | 'rate-limited' | 'other';

export interface PollHealth {
  state: 'ok' | 'degraded' | 'down';
  code?: PollHealthCode;
  reason?: string;
}

export interface PollLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
}

export interface PollTimings {
  longPollTimeoutMs: number;
  retryDelayMs: number;
  backoffDelayMs: number;
  maxConsecutiveFailures: number;
  /** 本地重复帧缓存容量：只挡「最近见过」的重放，核心侧仍按 messageId 去重。 */
  dedupeCapacity: number;
}

export const DEFAULT_POLL_TIMINGS: PollTimings = {
  longPollTimeoutMs: 35_000,
  retryDelayMs: 2_000,
  backoffDelayMs: 30_000,
  maxConsecutiveFailures: 3,
  dedupeCapacity: 2_000,
};

export interface PollLoopOptions {
  api: ILinkApi;
  account: string;
  cursor: SyncCursorStore;
  contextTokens: ContextTokenStore;
  guard: SessionGuard;
  /** 收到一条新消息（已去重）。异常会被吞掉并记日志，不能打断轮询。 */
  onMessage: (message: WeixinMessage) => void | Promise<void>;
  onHealth?: (health: PollHealth) => void;
  logger?: PollLogger;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  timings?: Partial<PollTimings>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort(): void {
      finish();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class PollLoop {
  readonly #options: PollLoopOptions;
  readonly #timings: PollTimings;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 见过的身份串；Map 的插入顺序就是 LRU 顺序。 */
  readonly #seen = new Map<string, true>();

  constructor(options: PollLoopOptions) {
    this.#options = options;
    this.#timings = { ...DEFAULT_POLL_TIMINGS, ...options.timings };
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** 跑到 `signal` 取消为止；正常退出时返回而不是抛错。 */
  async run(signal: AbortSignal): Promise<void> {
    const options = this.#options;
    let cursor = await options.cursor.load(options.account);
    let timeoutMs = this.#timings.longPollTimeoutMs;
    let failures = 0;
    options.onHealth?.({ state: 'ok' });

    while (!signal.aborted) {
      let response: GetUpdatesResponse;
      try {
        response = await options.api.getUpdates({ cursor, timeoutMs, signal });
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ILinkError && (error.ret === -14 || error.errcode === -14)) {
          if (await this.#pauseForStaleToken(signal)) continue;
          return;
        }
        failures += 1;
        options.onHealth?.({ state: 'degraded', code: this.#codeOf(error), reason: messageOf(error) });
        await this.#sleep(
          failures >= this.#timings.maxConsecutiveFailures ? this.#timings.backoffDelayMs : this.#timings.retryDelayMs,
          signal,
        );
        if (failures >= this.#timings.maxConsecutiveFailures) failures = 0;
        continue;
      }

      const ret = typeof response.ret === 'number' ? response.ret : undefined;
      const errcode = typeof response.errcode === 'number' ? response.errcode : undefined;
      if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
        if (isStaleToken(ret, errcode)) {
          if (await this.#pauseForStaleToken(signal)) continue;
          return;
        }
        failures += 1;
        options.onHealth?.({ state: 'degraded', code: 'other', reason: `ret=${ret} errcode=${errcode}` });
        await this.#sleep(
          failures >= this.#timings.maxConsecutiveFailures ? this.#timings.backoffDelayMs : this.#timings.retryDelayMs,
          signal,
        );
        if (failures >= this.#timings.maxConsecutiveFailures) failures = 0;
        continue;
      }

      failures = 0;
      options.onHealth?.({ state: 'ok' });

      const suggested = response.longpolling_timeout_ms;
      if (typeof suggested === 'number' && suggested > 0) timeoutMs = suggested;

      const next = typeof response.get_updates_buf === 'string' ? response.get_updates_buf : '';
      if (next !== '' && next !== cursor) {
        cursor = next;
        await this.#saveCursor(cursor);
      }

      for (const message of response.msgs ?? []) {
        if (signal.aborted) return;
        await this.#accept(message);
      }
    }
  }

  async #accept(message: WeixinMessage): Promise<void> {
    const token = typeof message.context_token === 'string' ? message.context_token : '';
    if (token !== '') {
      this.#options.contextTokens.set(this.#options.account, message.from_user_id ?? '', token);
    }
    const identity = messageIdentity(this.#options.account, message);
    if (identity === null) return;
    if (this.#seen.has(identity)) {
      this.#options.logger?.info?.('丢弃重复的入站帧');
      return;
    }
    this.#remember(identity);
    try {
      await this.#options.onMessage(message);
    } catch (error) {
      this.#options.logger?.warn?.('处理入站消息失败', messageOf(error));
    }
  }

  /** 记录身份并按容量淘汰最旧的一条。 */
  #remember(identity: string): void {
    this.#seen.set(identity, true);
    while (this.#seen.size > this.#timings.dedupeCapacity) {
      const oldest = this.#seen.keys().next();
      if (oldest.done) break;
      this.#seen.delete(oldest.value);
    }
  }

  async #saveCursor(cursor: string): Promise<void> {
    try {
      await this.#options.cursor.save(this.#options.account, cursor);
    } catch (error) {
      // 游标写不进去只会导致重启后重收一段历史，核心按 messageId 去重兜底。
      this.#options.logger?.warn?.('长轮询游标落盘失败', messageOf(error));
    }
  }

  /** 进闸门暂停；返回 false 表示已被取消。 */
  async #pauseForStaleToken(signal: AbortSignal): Promise<boolean> {
    const pauseMs = this.#options.guard.pause(this.#options.account);
    this.#options.onHealth?.({ state: 'down', code: 'auth-expired', reason: 'token 已失效，需要重新扫码登录' });
    this.#options.logger?.warn?.(`iLink token 失效，暂停 ${Math.ceil((pauseMs - Date.now()) / 60_000)} 分钟`);
    await this.#sleep(this.#options.guard.remaining(this.#options.account), signal);
    return !signal.aborted;
  }

  #codeOf(error: unknown): PollHealthCode {
    if (!(error instanceof ILinkError)) return 'other';
    if (error.kind === 'network' || error.kind === 'timeout') return 'network';
    if (error.kind === 'http' && error.status === 429) return 'rate-limited';
    return 'other';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
