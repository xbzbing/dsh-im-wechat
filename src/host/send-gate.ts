/**
 * 提醒发送的节流窗口。
 *
 * 平台对 bot 有分钟级发送配额。交付走 `superagent/quota.ts` 的账本，提醒不走——
 * `questionDelayMinutes = 0` 时一批待授权会在一分钟内齐发，把配额吃光，真正要送的
 * 回答被限流。这里给提醒单独一个小预算：超了就不发（broker 会把请求交回 Web），
 * 不排队——排队到点才发出去的提醒已经过时，反而更容易让主人批错。
 */

export interface ReminderGateOptions {
  /** 每 60 秒最多发几条。 */
  perMinute?: number;
  /** 两条之间的最小间隔：连发多条提醒在微信里就是刷屏。 */
  minGapMs?: number;
  now?: () => number;
}

const WINDOW_MS = 60_000;
const DEFAULT_PER_MINUTE = 6;
const DEFAULT_MIN_GAP_MS = 2_000;

export class ReminderGate {
  readonly #perMinute: number;
  readonly #minGapMs: number;
  readonly #now: () => number;
  /** 窗口内已发出的时间戳（升序）。 */
  readonly #sent: number[] = [];

  constructor(options: ReminderGateOptions = {}) {
    this.#perMinute = options.perMinute ?? DEFAULT_PER_MINUTE;
    this.#minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.#now = options.now ?? Date.now;
  }

  /** 现在能不能发；能就记账。 */
  tryTake(): boolean {
    const now = this.#now();
    while (this.#sent.length > 0 && now - this.#sent[0]! >= WINDOW_MS) this.#sent.shift();
    const last = this.#sent[this.#sent.length - 1];
    if (last !== undefined && now - last < this.#minGapMs) return false;
    if (this.#sent.length >= this.#perMinute) return false;
    this.#sent.push(now);
    return true;
  }
}
