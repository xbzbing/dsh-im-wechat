/**
 * 会话闸门：`-14`（token 失联）后暂停一段时间，别在闸门前排队打服务端。
 *
 * 官方实现在拿到 `-14` 时把该账号的所有请求暂停一小时：这个错误码意味着
 * token 已失效，短时间内的重试只会继续失败，还会把「登录态过期」伪装成
 * 网络抖动。轮询与发送共用同一份闸门状态。
 */

export const STALE_TOKEN_ERRCODE = -14;

export const DEFAULT_STALE_PAUSE_MS = 60 * 60_000;

export class SessionGuard {
  readonly #pausedUntil = new Map<string, number>();
  readonly #pauseMs: number;
  readonly #now: () => number;

  constructor(options: { pauseMs?: number; now?: () => number } = {}) {
    this.#pauseMs = options.pauseMs ?? DEFAULT_STALE_PAUSE_MS;
    this.#now = options.now ?? Date.now;
  }

  /** 进入暂停窗口（重复触发时顺延，不叠加）。 */
  pause(account: string): number {
    const until = this.#now() + this.#pauseMs;
    this.#pausedUntil.set(account, until);
    return until;
  }

  /** 剩余暂停毫秒数；不在暂停中返回 0。 */
  remaining(account: string): number {
    const until = this.#pausedUntil.get(account);
    if (until === undefined) return 0;
    const left = until - this.#now();
    if (left <= 0) {
      this.#pausedUntil.delete(account);
      return 0;
    }
    return left;
  }

  isPaused(account: string): boolean {
    return this.remaining(account) > 0;
  }

  /** 主人重新扫码登录后立刻解闸。 */
  resume(account: string): void {
    this.#pausedUntil.delete(account);
  }
}

/** `ret`/`errcode` 里是否带「token 失联」。 */
export function isStaleToken(retOrErrcode: number | undefined, ...rest: (number | undefined)[]): boolean {
  if (retOrErrcode === STALE_TOKEN_ERRCODE) return true;
  return rest.some((value) => value === STALE_TOKEN_ERRCODE);
}
